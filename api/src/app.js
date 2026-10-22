'use strict';

const express = require('express');
const db = require('./lib/db');
const { attachUser, requireStaff } = require('./lib/auth');
const { ApiError, badRequest, notFound } = require('./lib/errors');

const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const availabilityRoutes = require('./routes/availability');
const holdRoutes = require('./routes/holds');
const appointmentRoutes = require('./routes/appointments');
const masterRoutes = require('./routes/master');
const adminRoutes = require('./routes/admin');

function createApp() {
  db.open();

  const app = express();
  app.disable('x-powered-by');

  // Весь API отвечает только JSON.
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.type('application/json');
    next();
  });

  // Сломанный JSON — это 400, а не 500.
  app.use((err, _req, _res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return next(badRequest('Тело запроса не является корректным JSON'));
    }
    next(err);
  });

  app.use(attachUser);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, now_utc: require('./lib/time').nowUtc() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api', availabilityRoutes);
  app.use('/api/holds', holdRoutes);
  app.use('/api/appointments', appointmentRoutes);
  app.use('/api/master', masterRoutes);
  // Проверка роли стоит на самом префиксе, а не внутри каждого эндпоинта:
  // всё, что смонтировано под `/api/admin`, проходит через requireStaff —
  // и то, что здесь сейчас, и то, что сюда добавят потом. Та же функция
  // стоит первой строкой в самом роутере (lib/auth.js, requireStaff).
  app.use('/api/admin', requireStaff, adminRoutes);

  app.use((_req, _res, next) => next(notFound('Эндпоинт не найден')));

  // Единый обработчик: наружу всегда JSON, внутренние детали не раскрываются.
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json(err.toJSON());
      return;
    }
    console.error('[api] необработанная ошибка:', err);
    res.status(500).json({
      error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' },
    });
  });

  return app;
}

module.exports = { createApp };
