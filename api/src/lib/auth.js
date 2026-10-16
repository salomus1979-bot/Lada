'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const { nowUtc, toUtcIso } = require('./time');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'lada_session';
const SESSION_TTL_DAYS = require('./config').sessionTtlDays;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Схема хеширования пароля. Вынесена в константу, потому что по этому
 * префиксу отличают аккаунт с паролем от аккаунта без входа — в том числе
 * запросом в SQL, чтобы сам хеш не вытаскивать из базы.
 */
const PASSWORD_SCHEME = 'scrypt';

/**
 * Хеш токена сессии — то, что лежит в `sessions.token_hash`. Сам токен в базу
 * не попадает никогда: он живёт только в cookie у владельца, поэтому по копии
 * таблицы войти нельзя.
 *
 * Здесь SHA-256, а не scrypt, и это не оплошность. scrypt нарочно медленный,
 * чтобы перебирать пароли было дорого; у пароля мало энтропии, и защищаться
 * надо именно от перебора. Токен — 32 случайных байта от crypto, перебирать
 * его бессмысленно при любой скорости хеша, а проверять его приходится на
 * КАЖДОМ запросе: scrypt превратил бы каждый запрос в сотни миллисекунд
 * работы процессора. Для значения с такой энтропией быстрый хеш — верный
 * выбор, и соль ему не нужна: солью служит сама случайность токена.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const ROLES = ['client', 'master', 'admin', 'owner'];

/** Роли пользователя из базы, списком. Запрос на них не влияет никак. */
function rolesOf(userId) {
  return db.all('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', [userId])
    .map((r) => r.role);
}

/** Выдать роль. Повторная выдача ничего не ломает. */
function grantRole(userId, role) {
  if (!ROLES.includes(role)) throw new Error(`неизвестная роль: ${role}`);
  db.run('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)', [userId, role]);
}

/** Есть ли у пользователя хотя бы одна из перечисленных ролей. */
function hasRole(user, ...roles) {
  return !!user && Array.isArray(user.roles) && roles.some((r) => user.roles.includes(r));
}

/** Хеш пароля: `scrypt$N$r$p$salt$hash`. Наружу не отдаётся никогда. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return [
    PASSWORD_SCHEME, SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), hash.toString('base64'),
  ].join('$');
}

/**
 * Заглушка вместо хеша для аккаунта без входа: клиента, которого создал
 * администратор, пароль ему не задавали, и войти по нему нельзя.
 *
 * `users.password_hash` — NOT NULL, а пустая строка или фиксированный текст
 * означали бы «у всех таких аккаунтов пароль одинаковый». Поэтому схема здесь
 * не `scrypt`, и verifyPassword отказывает на первой же проверке, какой бы
 * пароль ни пришёл. Случайные байты добавлены, чтобы значение не повторялось
 * от аккаунта к аккаунту и его нельзя было подставить снаружи.
 */
function noLoginHash() {
  return `nologin$${crypto.randomBytes(32).toString('hex')}`;
}

/** Сравнение в постоянном времени; при любом повреждении хеша — отказ, а не исключение. */
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    // Чужая схема — отказ: так же отсеивается заглушка noLoginHash().
    if (scheme !== PASSWORD_SCHEME) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createSession(userId, userAgent = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = toUtcIso(new Date(Date.now() + SESSION_TTL_DAYS * 86400_000));
  db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at_utc, expires_at_utc, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    // В базу идёт хеш; сам токен возвращается вызывающему и уходит в cookie.
    // User-Agent обрезаем: это чужая строка произвольной длины, а нужна она
    // только чтобы назвать устройство в списке сессий.
    [hashToken(token), userId, nowUtc(), expiresAt,
      userAgent ? String(userAgent).slice(0, 400) : null],
  );
  return { token, expiresAt };
}

/**
 * Идентификатор сессии для списка «Активные сессии» — это и есть хранимый
 * `token_hash`. Отдавать его наружу безопасно: восстановить из него токен
 * нельзя, а для кнопки «Завершить» достаточно.
 */
const sessionId = hashToken;

const BROWSERS = [
  [/Edg\//i, 'Edge'],
  [/YaBrowser/i, 'Яндекс.Браузер'],
  [/OPR\/|Opera/i, 'Opera'],
  [/Firefox/i, 'Firefox'],
  [/Chrome|CriOS/i, 'Chrome'],
  [/Safari/i, 'Safari'],
];
const PLATFORMS = [
  [/iPhone/i, 'iPhone', 'mobile'],
  [/iPad/i, 'iPad', 'mobile'],
  [/Android/i, 'Android', 'mobile'],
  [/Windows/i, 'Windows', 'desktop'],
  [/Mac OS X|Macintosh/i, 'macOS', 'desktop'],
  [/Linux/i, 'Linux', 'desktop'],
];

/**
 * Подпись устройства для списка сессий: «Chrome · Windows».
 *
 * Разбор нарочно грубый — User-Agent врёт по устройству и по браузеру, и
 * строить на нём что-то кроме подписи в интерфейсе нельзя. Неизвестный или
 * отсутствующий агент так и называется неизвестным, а не угадывается.
 */
function describeDevice(userAgent) {
  if (!userAgent) return { device: 'Неизвестное устройство', kind: 'unknown' };
  const browser = BROWSERS.find(([re]) => re.test(userAgent));
  const platform = PLATFORMS.find(([re]) => re.test(userAgent));
  const parts = [browser && browser[1], platform && platform[1]].filter(Boolean);
  return {
    device: parts.length > 0 ? parts.join(' · ') : 'Неизвестное устройство',
    kind: platform ? platform[2] : 'unknown',
  };
}

/** Действующие сессии пользователя, свежие сверху. Токены не возвращаются. */
function listSessions(userId, currentToken) {
  dropExpiredSessions();
  const currentHash = currentToken ? hashToken(currentToken) : null;
  return db.all(
    `SELECT token_hash, created_at_utc, expires_at_utc, user_agent
       FROM sessions WHERE user_id = ? ORDER BY created_at_utc DESC`,
    [userId],
  ).map((row) => ({
    id: row.token_hash,
    ...describeDevice(row.user_agent),
    created_at_utc: row.created_at_utc,
    expires_at_utc: row.expires_at_utc,
    is_current: row.token_hash === currentHash,
  }));
}

/**
 * Завершает одну свою сессию по непрозрачному id. Чужая сессия и
 * несуществующая неотличимы: обе возвращают false.
 */
function destroySessionById(userId, id) {
  // id — это сам token_hash, поэтому удаляем условием, а не перебором.
  // user_id в условии обязателен: иначе чужую сессию можно было бы закрыть,
  // подставив её id.
  const info = db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash = ?', [userId, id]);
  return info.changes > 0;
}

function destroySession(token) {
  if (!token) return 0;
  return db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]).changes;
}

function dropExpiredSessions() {
  db.run('DELETE FROM sessions WHERE expires_at_utc <= ?', [nowUtc()]);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/** Токен берём из cookie либо из `Authorization: Bearer` — удобно для curl и тестов. */
function tokenFromRequest(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

function setSessionCookie(res, token, expiresAtUtc) {
  const secure = require('./config').isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
    + `; Expires=${new Date(expiresAtUtc).toUTCString()}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Подкладывает req.user, если сессия валидна. Ничего не запрещает —
 * решение принимают requireAuth / requireRole.
 */
function attachUser(req, _res, next) {
  req.sessionToken = tokenFromRequest(req);
  req.user = null;
  if (req.sessionToken) {
    const row = db.one(
      `SELECT u.id, u.name, u.email, u.phone, u.is_blocked, s.expires_at_utc
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [hashToken(req.sessionToken)],
    );
    if (row) {
      if (row.expires_at_utc <= nowUtc()) {
        destroySession(req.sessionToken);
      } else {
        req.user = {
          id: row.id,
          // Роли берутся из базы по user_id — ни одно поле запроса на них не
          // влияет. Присланная клиентом роль просто некуда подставить.
          roles: rolesOf(row.id),
          name: row.name,
          email: row.email,
          phone: row.phone,
          isBlocked: row.is_blocked === 1,
        };
      }
    }
  }
  next();
}

/** 401, если нет действующей сессии. */
function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * 401 без сессии, 403 при недостаточной роли.
 * Проверка — вхождение в список ролей, а не равенство: у человека их может
 * быть несколько, и достаточно любой подходящей.
 */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!hasRole(req.user, ...roles)) return next(forbidden());
    next();
  };
}

const isStaff = (user) => hasRole(user, 'admin', 'owner');
const isOwner = (user) => hasRole(user, 'owner');

module.exports = {
  SESSION_COOKIE,
  PASSWORD_SCHEME,
  ROLES,
  rolesOf,
  grantRole,
  hasRole,
  isOwner,
  hashPassword,
  noLoginHash,
  verifyPassword,
  createSession,
  hashToken,
  sessionId,
  describeDevice,
  listSessions,
  destroySession,
  destroySessionById,
  dropExpiredSessions,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireRole,
  isStaff,
};
