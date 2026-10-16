'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.LADA_DB_PATH
  || path.join(__dirname, '..', '..', 'db', 'lada.sqlite');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'schema.sql');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/**
 * Колонки, добавленные к уже существующим таблицам.
 * schema.sql описывает актуальное состояние и годится для новой базы,
 * но CREATE TABLE IF NOT EXISTS не достроит колонку в уже созданной.
 *
 * Выполняется ДО schema.sql: триггеры из него ссылаются на NEW.is_override,
 * и без колонки их создание упало бы.
 */
const ADDED_COLUMNS = [
  {
    table: 'appointments',
    column: 'is_override',
    ddl: 'INTEGER NOT NULL DEFAULT 0 CHECK (is_override IN (0, 1))',
  },
];

function migrate() {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) continue; // новая база — колонка придёт из schema.sql

    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (columns.includes(column)) continue;

    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function get() {
  return db || open();
}

/** Одна строка или undefined. */
function one(sql, params = []) {
  return get().prepare(sql).get(...params);
}

/** Массив строк. */
function all(sql, params = []) {
  return get().prepare(sql).all(...params);
}

/** INSERT/UPDATE/DELETE; возвращает { changes, lastInsertRowid }. */
function run(sql, params = []) {
  return get().prepare(sql).run(...params);
}

/**
 * Транзакция в режиме IMMEDIATE.
 *
 * Именно IMMEDIATE, а не BEGIN (DEFERRED) по умолчанию: в DEFERRED SQLite
 * берёт блокировку на запись только при ПЕРВОМ изменяющем операторе. Между
 * нашей проверкой «слот свободен» (SELECT) и вставкой записи туда успевает
 * вклиниться другое соединение — и либо оба клиента занимают один слот, либо
 * повышение блокировки падает с SQLITE_BUSY_SNAPSHOT, и транзакцию всё равно
 * приходится откатывать и повторять целиком.
 *
 * BEGIN IMMEDIATE берёт блокировку на запись сразу, на первом же операторе
 * транзакции. Поэтому последовательность «проверить занятость → вставить»
 * целиком выполняется только одним писателем за раз, и проверка не успевает
 * устареть к моменту вставки.
 */
function transaction(fn) {
  const handle = get();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // Откат уже произошёл — исходную ошибку не прячем.
    }
    throw err;
  }
}

/**
 * Сообщение, которым триггеры appointments_no_overlap_* помечают пересечение
 * визитов. Текст из RAISE(ABORT, ...) приходит в err.message как есть.
 */
const OVERLAP_ERROR = 'appointment_overlap';

/**
 * Сработал ли триггер запрета пересечения. Нужен, чтобы отличить его
 * от любой другой ошибки БД: наружу уходит 409 с понятным текстом,
 * а сообщение SQLite пользователю не показывается.
 */
function isOverlapError(err) {
  return !!err && err.code === 'ERR_SQLITE_ERROR' && err.message === OVERLAP_ERROR;
}

/** Настройки студии (одна строка, id = 1). */
function settings() {
  const row = one('SELECT * FROM salon_settings WHERE id = 1');
  if (!row) throw new Error('salon_settings не заполнены: запустите npm run seed');
  return row;
}

module.exports = {
  open, get, one, all, run, transaction, settings, DB_PATH,
  OVERLAP_ERROR, isOverlapError,
};
