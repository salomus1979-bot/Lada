'use strict';

/**
 * Настройки окружения. Единственное место, которое читает `process.env`.
 *
 * Что здесь, а что в базе: здесь — то, что относится к ЗАПУСКУ и к секретам
 * (порт, путь к базе, пароль демо-данных). Настройки самой студии — часы
 * работы, шаг сетки, окно отмены, горизонт записи, лимиты — лежат в таблице
 * `salon_settings`, потому что их меняет администратор через интерфейс, а не
 * системный администратор правкой файла и перезапуском.
 *
 * Значения берутся из `.env` в корне проекта (если он есть) и из переменных
 * окружения. Сам `.env` в репозиторий не попадает — он в `.gitignore`;
 * в репозитории лежит `.env.example` с теми же ключами и без значений.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

// Переменные, заданные в окружении, сильнее файла: так настраивают контейнеры
// и CI, где никакого .env нет.
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    // Испорченный .env — это ошибка запуска, а не повод молча стартовать
    // с умолчаниями: иначе продакшен поднимется с чужими настройками.
    throw new Error(`не удалось прочитать .env: ${err.message}`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `не задана переменная окружения ${name}. Скопируйте .env.example в .env и заполните`,
    );
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} должна быть целым положительным числом, получено: ${raw}`);
  }
  return parsed;
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Пароль демо-аккаунтов. В коде его нет: сид берёт значение отсюда.
 * Вне продакшена есть умолчание, иначе `npm run seed` потребовал бы .env
 * ради трёх тестовых аккаунтов. В продакшене умолчания нет — там сид либо
 * не запускают вовсе, либо пароль задают явно.
 */
function seedPassword() {
  if (isProduction) return required('SEED_PASSWORD');
  return process.env.SEED_PASSWORD || 'Lada12345';
}

module.exports = {
  isProduction,
  port: int('PORT', 3001),
  dbPath: process.env.LADA_DB_PATH || path.join(ROOT, 'api', 'db', 'lada.sqlite'),
  sessionTtlDays: int('SESSION_TTL_DAYS', 30),
  // Ограничение частоты входа и регистрации — см. lib/rate-limit.js.
  authRateLimit: {
    windowMin: int('AUTH_RATE_WINDOW_MIN', 15),
    maxAttempts: int('AUTH_RATE_MAX_ATTEMPTS', 10),
  },
  seedPassword,
  required,
};
