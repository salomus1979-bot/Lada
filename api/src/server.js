'use strict';

const { createApp } = require('./app');
const db = require('./lib/db');
const { purgeExpiredHolds } = require('./lib/availability');
const { dropExpiredSessions } = require('./lib/auth');

const PORT = require('./lib/config').port;

const app = createApp();

// Истёкшие удержания удаляются и при каждом расчёте доступности;
// этот таймер нужен лишь чтобы таблица не росла в простое.
const sweeper = setInterval(() => {
  try {
    purgeExpiredHolds();
    dropExpiredSessions();
  } catch (err) {
    console.error('[api] ошибка очистки:', err);
  }
}, 60_000);
sweeper.unref();

const server = app.listen(PORT, () => {
  console.log(`[api] Лада слушает http://localhost:${PORT}`);
  console.log(`[api] база: ${db.DB_PATH}`);
  console.log(`[api] пояс салона: ${db.settings().timezone}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
