'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const { nowUtc, toUtcIso } = require('./time');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'lada_session';
const SESSION_TTL_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Схема хеширования пароля. Вынесена в константу, потому что по этому
 * префиксу отличают аккаунт с паролем от аккаунта без входа — в том числе
 * запросом в SQL, чтобы сам хеш не вытаскивать из базы.
 */
const PASSWORD_SCHEME = 'scrypt';

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
    `INSERT INTO sessions (token, user_id, created_at_utc, expires_at_utc, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    // User-Agent обрезаем: это чужая строка произвольной длины, а нужна она
    // только чтобы назвать устройство в списке сессий.
    [token, userId, nowUtc(), expiresAt, userAgent ? String(userAgent).slice(0, 400) : null],
  );
  return { token, expiresAt };
}

/**
 * Непрозрачный идентификатор сессии для списка «Активные сессии».
 *
 * Сам токен наружу не отдаётся НИКОГДА, кроме как своему владельцу при входе:
 * список сессий показывает все устройства сразу, и вернись там токены —
 * одна утечка ответа отдала бы все входы человека разом. Поэтому наружу
 * уходит SHA-256 от токена: он стабилен, по нему сессию можно завершить,
 * а восстановить из него токен нельзя.
 */
function sessionId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

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
  return db.all(
    `SELECT token, created_at_utc, expires_at_utc, user_agent
       FROM sessions WHERE user_id = ? ORDER BY created_at_utc DESC`,
    [userId],
  ).map((row) => ({
    id: sessionId(row.token),
    ...describeDevice(row.user_agent),
    created_at_utc: row.created_at_utc,
    expires_at_utc: row.expires_at_utc,
    is_current: row.token === currentToken,
  }));
}

/**
 * Завершает одну свою сессию по непрозрачному id. Чужая сессия и
 * несуществующая неотличимы: обе возвращают false.
 */
function destroySessionById(userId, id) {
  const row = db.all('SELECT token FROM sessions WHERE user_id = ?', [userId])
    .find((r) => sessionId(r.token) === id);
  if (!row) return null;
  db.run('DELETE FROM sessions WHERE token = ?', [row.token]);
  return row.token;
}

function destroySession(token) {
  if (!token) return 0;
  return db.run('DELETE FROM sessions WHERE token = ?', [token]).changes;
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
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
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
      `SELECT u.id, u.role, u.name, u.email, u.phone, u.is_blocked, s.expires_at_utc
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
      [req.sessionToken],
    );
    if (row) {
      if (row.expires_at_utc <= nowUtc()) {
        destroySession(req.sessionToken);
      } else {
        req.user = {
          id: row.id,
          role: row.role,
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

/** 401 без сессии, 403 при недостаточной роли. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

const isStaff = (user) => !!user && (user.role === 'admin' || user.role === 'owner');

module.exports = {
  SESSION_COOKIE,
  PASSWORD_SCHEME,
  hashPassword,
  noLoginHash,
  verifyPassword,
  createSession,
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
