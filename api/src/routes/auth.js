'use strict';

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const { Validator } = require('../lib/validate');
const { badRequest, conflict, notFound, unauthorized, forbidden } = require('../lib/errors');
const { selfUser } = require('../lib/presenters');
const { nowUtc } = require('../lib/time');

const router = express.Router();

/**
 * POST /api/auth/register — регистрация клиента.
 * Роль всегда `client`: персонал создаётся админом, а не через публичный роут.
 */
router.post('/register', (req, res) => {
  const input = new Validator(req.body)
    .string('name', { min: 2, max: 100 })
    .email('email')
    .phone('phone')
    .password('password')
    .string('password_confirm', { min: 8, max: 200, trim: false })
    .bool('consent')
    .done();

  if (input.password !== input.password_confirm) {
    throw badRequest('Неверные входные данные', {
      password_confirm: 'пароли не совпадают',
    });
  }
  if (input.consent !== true) {
    throw badRequest('Неверные входные данные', {
      consent: 'нужно согласие на обработку персональных данных',
    });
  }

  const existing = db.one('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [input.email]);
  if (existing) {
    throw conflict('Такой e-mail уже зарегистрирован', { email: 'занят' });
  }

  const info = db.run(
    `INSERT INTO users (role, name, email, phone, password_hash, created_at_utc)
     VALUES ('client', ?, ?, ?, ?, ?)`,
    [input.name, input.email, input.phone, auth.hashPassword(input.password), nowUtc()],
  );

  const userId = Number(info.lastInsertRowid);
  const session = auth.createSession(userId, req.headers['user-agent']);
  auth.setSessionCookie(res, session.token, session.expiresAt);

  res.status(201).json({
    user: selfUser({
      id: userId, role: 'client', name: input.name, email: input.email, phone: input.phone,
    }),
    session_token: session.token,
  });
});

/** POST /api/auth/login — вход по e-mail и паролю. */
router.post('/login', (req, res) => {
  const input = new Validator(req.body)
    .email('email')
    .string('password', { min: 1, max: 200, trim: false })
    .done();

  const user = db.one(
    `SELECT id, role, name, email, phone, password_hash, is_blocked
       FROM users WHERE email = ? COLLATE NOCASE`,
    [input.email],
  );

  // Один и тот же ответ для «нет пользователя» и «неверный пароль» —
  // чтобы по коду ответа нельзя было перебирать зарегистрированные адреса.
  if (!user || !auth.verifyPassword(input.password, user.password_hash)) {
    throw unauthorized('Неверный e-mail или пароль');
  }
  if (user.is_blocked === 1) {
    throw forbidden('Онлайн-запись для аккаунта ограничена, позвоните администратору');
  }

  auth.dropExpiredSessions();
  const session = auth.createSession(user.id, req.headers['user-agent']);
  db.run('UPDATE users SET last_login_at_utc = ? WHERE id = ?', [nowUtc(), user.id]);
  auth.setSessionCookie(res, session.token, session.expiresAt);

  res.json({ user: selfUser(user), session_token: session.token });
});

/** POST /api/auth/logout — выход: сессия удаляется, cookie сбрасывается. */
router.post('/logout', auth.requireAuth, (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * GET /api/auth/sessions — «Активные сессии» со страницы 16.
 *
 * Токены не возвращаются: список показывает все устройства разом, и утечка
 * такого ответа отдала бы все входы человека сразу. Наружу уходит
 * непрозрачный id, по нему сессию и завершают.
 */
router.get('/sessions', auth.requireAuth, (req, res) => {
  res.json({ sessions: auth.listSessions(req.user.id, req.sessionToken) });
});

/**
 * DELETE /api/auth/sessions/:id — «Завершить» на чужом устройстве.
 *
 * Завершить можно только свою сессию: чужой и несуществующий id дают
 * одинаковый 404. Свою текущую завершить тоже можно — это обычный выход,
 * поэтому вместе с ней сбрасывается cookie.
 */
router.delete('/sessions/:id', auth.requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw badRequest('Неверный идентификатор', { id: 'ожидается 64 шестнадцатеричных символа' });
  }

  const removed = auth.destroySessionById(req.user.id, id);
  if (!removed) throw notFound('Сессия не найдена');

  const wasCurrent = removed === req.sessionToken;
  if (wasCurrent) auth.clearSessionCookie(res);
  res.json({ ok: true, was_current: wasCurrent });
});

/** GET /api/auth/me — профиль текущего пользователя. */
router.get('/me', auth.requireAuth, (req, res) => {
  res.json({ user: selfUser(req.user) });
});

module.exports = router;
