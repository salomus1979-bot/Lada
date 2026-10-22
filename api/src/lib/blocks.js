'use strict';

/**
 * Единственный путь изменения таблицы `time_blocks`.
 *
 * Блокировку ставит администратор из графика мастера (страница 30) и сам
 * мастер из своего кабинета (страница 39). Это одна операция, а не две:
 * проверка «на это время уже есть запись» должна быть одинаковой, иначе
 * второй путь рано или поздно начнёт пускать то, что не пускает первый.
 * Роль отличается только тем, ЧЬЁ время блокируется и действует ли горизонт.
 *
 * Отдельного модуля для appointments тут нет намеренно: блокировки и записи —
 * разные таблицы с разными правилами, а booking.js отвечает только за визиты.
 */

const db = require('./db');
const { Validator } = require('./validate');
const { badRequest, conflict, notFound } = require('./errors');
const { ACTIVE_STATUSES, bookingHorizonDate } = require('./availability');
const { nowUtc, utcToZoned } = require('./time');

/** Типы блокировок со страницы 39: перерыв, отгул, отпуск, больничный. */
const BLOCK_TYPES = ['break', 'time_off', 'vacation', 'sick_leave'];

/** Подписи типов — одни на кабинет мастера и на админский раздел. */
const BLOCK_LABELS = {
  break: 'Перерыв',
  time_off: 'Выходной',
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
};

/**
 * Поставить блокировку времени.
 *
 * `enforceHorizon` — правило страницы 39: «Блокировать можно не дальше чем на
 * 3 месяца вперёд». Его ставит кабинет мастера; администратору горизонт не
 * мешает, потому что отпуск он заводит заранее и видит сетку целиком.
 *
 * @returns {object} поля созданной блокировки
 */
function createTimeBlock(user, masterId, body, { enforceHorizon = false } = {}) {
  const input = new Validator(body)
    .enum('type', BLOCK_TYPES)
    .utcInstant('starts_at')
    .utcInstant('ends_at')
    .string('comment', { required: false, max: 500 })
    .done();

  if (input.ends_at <= input.starts_at) {
    throw badRequest('Неверные входные данные', { ends_at: 'должен быть позже starts_at' });
  }

  const settings = db.settings();
  if (enforceHorizon) {
    const horizon = bookingHorizonDate(settings);
    const startDate = utcToZoned(new Date(input.starts_at), settings.timezone).date;
    if (startDate > horizon) {
      throw conflict(
        `Блокировать можно не дальше чем на ${settings.booking_horizon_months} мес. вперёд`,
      );
    }
  }

  const newId = db.transaction(() => {
    const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [masterId]);
    if (!master) throw notFound('Мастер не найден');

    // Запись сильнее блокировки: сначала визит переносят или отменяют, и
    // только потом закрывают время. Страница 39 говорит это прямым текстом.
    const clash = db.one(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE master_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          AND starts_at_utc < ? AND ends_at_utc > ?`,
      [masterId, ...ACTIVE_STATUSES, input.ends_at, input.starts_at],
    );
    if (clash.n > 0) {
      throw conflict('На это время уже есть запись — заблокировать нельзя',
        { appointments: clash.n });
    }

    const info = db.run(
      `INSERT INTO time_blocks
         (master_id, type, starts_at_utc, ends_at_utc, comment, created_by_user_id, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [masterId, input.type, input.starts_at, input.ends_at,
        input.comment || null, user.id, nowUtc()],
    );
    return Number(info.lastInsertRowid);
  });

  return {
    id: newId,
    master_id: masterId,
    type: input.type,
    starts_at_utc: input.starts_at,
    ends_at_utc: input.ends_at,
    comment: input.comment || null,
  };
}

/**
 * Снять блокировку. `masterId` в условии обязателен: иначе кабинет мастера мог
 * бы снять чужую блокировку, подставив её id. Отсутствующая и чужая дают
 * одинаковый 404.
 */
function deleteTimeBlock(masterId, blockId) {
  const info = db.run('DELETE FROM time_blocks WHERE id = ? AND master_id = ?',
    [blockId, masterId]);
  if (info.changes === 0) throw notFound('Блокировка не найдена');
}

/** Блокировки мастера в диапазоне [fromUtc, toUtc), по возрастанию начала. */
function listTimeBlocks(masterId, fromUtc, toUtc) {
  return db.all(
    `SELECT id, type, starts_at_utc, ends_at_utc, comment
       FROM time_blocks
      WHERE master_id = ? AND starts_at_utc < ? AND ends_at_utc > ?
      ORDER BY starts_at_utc`,
    [masterId, toUtc, fromUtc],
  );
}

/**
 * Блокировки всех мастеров (или одного) в диапазоне — сетка дня у
 * администратора.
 *
 * До этой функции прочитать блокировки мог только сам мастер
 * (`GET /api/master/time-blocks`), и администратор ставил их вслепую: в его
 * разделе чтения не было вовсе (пробел 4 списка в docs/ui-map.md).
 */
function listTimeBlocksInRange(fromUtc, toUtc, masterId = null) {
  const where = ['b.starts_at_utc < ?', 'b.ends_at_utc > ?'];
  const params = [toUtc, fromUtc];
  if (masterId) {
    where.push('b.master_id = ?');
    params.push(masterId);
  }
  return db.all(
    `SELECT b.id, b.master_id, b.type, b.starts_at_utc, b.ends_at_utc, b.comment,
            m.first_name AS master_first_name, m.last_name AS master_last_name
       FROM time_blocks b
       JOIN masters m ON m.id = b.master_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.starts_at_utc, b.id`,
    params,
  );
}

module.exports = {
  BLOCK_TYPES, BLOCK_LABELS, createTimeBlock, deleteTimeBlock, listTimeBlocks, listTimeBlocksInRange,
};
