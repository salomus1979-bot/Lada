'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const { nowUtc, toUtcIso } = require('./time');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'lada_session';
const SESSION_TTL_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Хеш пароля: `scrypt$N$r$p$salt$hash`. Наружу не отдаётся никогда. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), hash.toString('base64'),
  ].join('$');
}

/** Сравнение в постоянном времени; при любом повреждении хеша — отказ, а не исключение. */
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = toUtcIso(new Date(Date.now() + SESSION_TTL_DAYS * 86400_000));
  db.run(
    `INSERT INTO sessions (token, user_id, created_at_utc, expires_at_utc) VALUES (?, ?, ?, ?)`,
    [token, userId, nowUtc(), expiresAt],
  );
  return { token, expiresAt };
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
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  dropExpiredSessions,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireRole,
  isStaff,
};
