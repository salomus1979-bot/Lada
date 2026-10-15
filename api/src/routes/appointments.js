'use strict';

const express = require('express');
const db = require('../lib/db');
const { requireAuth, isStaff } = require('../lib/auth');
const { Validator, requireIdParam } = require('../lib/validate');
const { ApiError, badRequest, conflict, forbidden, notFound } = require('../lib/errors');
const {
  ACTIVE_STATUSES, purgeExpiredHolds, loadServices,
  assertMasterPerformsServices, assertSlotBookable, nearestSlots,
} = require('../lib/availability');
const { nowUtc, diffMinutes, utcToZoned, presentInstant } = require('../lib/time');
const { appointmentView, appointmentAdminView } = require('../lib/presenters');

const router = express.Router();

/**
 * Превращает срабатывание триггера appointments_no_overlap_* в 409.
 *
 * Триггер — последний рубеж: в норме конфликт ловит assertSlotBookable внутри
 * той же транзакции. Сюда управление попадает, если слот заняли между нашей
 * проверкой и вставкой, либо если запись пришла в обход обычного пути.
 *
 * Наружу уходит понятный текст и список ближайших свободных начал этого же
 * мастера; сообщение SQLite клиенту не показывается.
 */
function overlapConflict({ masterId, startAtUtc, occupiedMin, settings, excludeAppointmentId = null }) {
  // Длительность могла не успеть посчитаться — тогда просто не предлагаем варианты.
  const suggestions = occupiedMin > 0
    ? nearestSlots({
      masterId,
      fromDate: utcToZoned(new Date(startAtUtc), settings.timezone).date,
      occupiedMin,
      settings,
      excludeAppointmentId,
    })
    : [];
  return conflict('Это время уже занято, выберите другое', {
    reason: 'overlap',
    nearest_slots: suggestions.map((iso) => presentInstant(iso, settings.timezone)),
  });
}

/**
 * Приводит оба источника конфликта к одному ответу.
 *   - прикладная проверка assertSlotBookable (обычный путь);
 *   - триггер БД appointments_no_overlap_* (гонка или запись в обход API).
 * В обоих случаях клиент получает 409 с подсказками, а текст SQLite наружу
 * не уходит. Прочие ошибки пробрасываются как есть.
 */
function rethrowAsConflict(err, context) {
  const fromTrigger = db.isOverlapError(err);
  const fromCheck = err instanceof ApiError && err.status === 409
    && err.details && err.details.reason === 'overlap';
  if (fromTrigger || fromCheck) throw overlapConflict(context);
  throw err;
}

const APPOINTMENT_COLUMNS = `
  a.id, a.client_user_id, a.master_id, a.starts_at_utc, a.ends_at_utc,
  a.service_duration_min, a.total_price_kopecks, a.status, a.client_comment,
  a.cancel_reason, a.reschedule_count, a.created_at_utc,
  m.first_name AS master_first_name, m.last_name AS master_last_name`;

function fetchAppointment(id) {
  return db.one(
    `SELECT ${APPOINTMENT_COLUMNS},
            u.name AS client_name, u.phone AS client_phone, u.email AS client_email
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
       JOIN users u ON u.id = a.client_user_id
      WHERE a.id = ?`,
    [id],
  );
}

function fetchServices(appointmentId) {
  return db.all(
    `SELECT service_id, name_snapshot, price_kopecks_snapshot,
            duration_min_snapshot, buffer_after_min_snapshot
       FROM appointment_services WHERE appointment_id = ? ORDER BY id`,
    [appointmentId],
  );
}

/**
 * Что клиент может сделать с записью прямо сейчас.
 * Правила из настроек студии: окно отмены/переноса в часах и лимит переносов.
 */
function clientRules(row, settings) {
  const isActive = ACTIVE_STATUSES.includes(row.status);
  const minutesLeft = diffMinutes(row.starts_at_utc, nowUtc());
  const insideWindow = minutesLeft >= settings.cancel_window_hours * 60;
  const rescheduleLeft = Math.max(0, settings.max_reschedules - row.reschedule_count);

  return {
    can_cancel: isActive && insideWindow,
    can_reschedule: isActive && insideWindow && rescheduleLeft > 0,
    reschedules_left: rescheduleLeft,
    cancel_window_hours: settings.cancel_window_hours,
  };
}

/** Проверка права на изменение: владелец записи либо персонал студии. */
function assertMayModify(row, user) {
  if (row.client_user_id === user.id) return 'client';
  if (isStaff(user)) return 'staff';
  // Чужую запись не раскрываем даже фактом её существования.
  throw notFound('Запись не найдена');
}

/**
 * POST /api/appointments — создание записи.
 *
 * Если передан `hold_token`, удержание снимается этой же транзакцией:
 * слот переходит из «удержан» в «занят» без промежутка, в который
 * его мог бы занять другой клиент.
 */
router.post('/', requireAuth, (req, res) => {
  const input = new Validator(req.body)
    .int('master_id', { min: 1 })
    .idArray('service_ids')
    .utcInstant('starts_at')
    .string('client_comment', { required: false, max: 1000 })
    .string('hold_token', { required: false, min: 64, max: 64 })
    .bool('consent')
    .done();

  if (input.consent !== true) {
    throw badRequest('Неверные входные данные', {
      consent: 'нужно согласие на обработку персональных данных',
    });
  }
  if (req.user.isBlocked) {
    throw forbidden('Онлайн-запись для аккаунта ограничена, позвоните администратору');
  }
  if (input.hold_token && !/^[0-9a-f]{64}$/.test(input.hold_token)) {
    throw badRequest('Неверные входные данные', { hold_token: 'неверный формат' });
  }

  const settings = db.settings();

  // Длительность нужна и снаружи транзакции — чтобы предложить альтернативы,
  // если триггер отклонит вставку.
  let occupiedForSuggest = 0;

  const createAppointment = () => db.transaction(() => {
    purgeExpiredHolds();

    const active = db.one(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE client_user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          AND starts_at_utc > ?`,
      [req.user.id, ...ACTIVE_STATUSES, nowUtc()],
    );
    if (active.n >= settings.max_active_appointments) {
      throw conflict(`Превышен лимит активных записей: ${settings.max_active_appointments}`);
    }

    assertMasterPerformsServices(input.master_id, input.service_ids);
    const { rows: serviceRows, serviceDurationMin, occupiedMin, totalPriceKopecks } =
      loadServices(input.service_ids);
    occupiedForSuggest = occupiedMin;

    const { endAtUtc } = assertSlotBookable({
      masterId: input.master_id,
      startAtUtc: input.starts_at,
      occupiedMin,
      settings,
      holdOwnerUserId: req.user.id,
      excludeHoldToken: input.hold_token || null,
    });

    const timestamp = nowUtc();
    const info = db.run(
      `INSERT INTO appointments
         (client_user_id, master_id, starts_at_utc, ends_at_utc, service_duration_min,
          total_price_kopecks, status, client_comment, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [req.user.id, input.master_id, input.starts_at, endAtUtc, serviceDurationMin,
        totalPriceKopecks, input.client_comment || null, timestamp, timestamp],
    );
    const newId = Number(info.lastInsertRowid);

    // Цена и длительность фиксируются: правка услуги не меняет созданные записи.
    for (const s of serviceRows) {
      db.run(
        `INSERT INTO appointment_services
           (appointment_id, service_id, name_snapshot, price_kopecks_snapshot,
            duration_min_snapshot, buffer_after_min_snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, s.id, s.name, s.price_kopecks, s.duration_min, s.buffer_after_min],
      );
    }

    db.run('DELETE FROM slot_holds WHERE user_id = ?', [req.user.id]);
    return newId;
  });

  let appointmentId;
  try {
    appointmentId = createAppointment();
  } catch (err) {
    // Триггер БД — последний рубеж: слот заняли между проверкой и вставкой.
    rethrowAsConflict(err, {
      masterId: input.master_id,
      startAtUtc: input.starts_at,
      occupiedMin: occupiedForSuggest,
      settings,
    });
  }

  const row = fetchAppointment(appointmentId);
  res.status(201).json({
    appointment: appointmentView(row, fetchServices(appointmentId), {
      timezone: settings.timezone,
      rules: clientRules(row, settings),
    }),
  });
});

/**
 * GET /api/appointments — свои записи.
 * ?scope=upcoming (по умолчанию) | past | all
 */
router.get('/', requireAuth, (req, res) => {
  const input = new Validator(req.query)
    .enum('scope', ['upcoming', 'past', 'all'], { required: false })
    .int('limit', { required: false, min: 1, max: 100 })
    .done();

  const scope = input.scope || 'upcoming';
  const limit = input.limit || 50;
  const settings = db.settings();

  const where = ['a.client_user_id = ?'];
  const params = [req.user.id];
  if (scope === 'upcoming') {
    where.push(`a.starts_at_utc > ? AND a.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
    params.push(nowUtc(), ...ACTIVE_STATUSES);
  } else if (scope === 'past') {
    where.push(`(a.starts_at_utc <= ? OR a.status NOT IN (${ACTIVE_STATUSES.map(() => '?').join(',')}))`);
    params.push(nowUtc(), ...ACTIVE_STATUSES);
  }

  const order = scope === 'upcoming' ? 'ASC' : 'DESC';
  const rows = db.all(
    `SELECT ${APPOINTMENT_COLUMNS}
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.starts_at_utc ${order}
      LIMIT ?`,
    [...params, limit],
  );

  res.json({
    scope,
    appointments: rows.map((row) => appointmentView(row, fetchServices(row.id), {
      timezone: settings.timezone,
      rules: clientRules(row, settings),
    })),
  });
});

/** GET /api/appointments/:id — детали своей записи (персонал видит любую, с данными клиента). */
router.get('/:id', requireAuth, (req, res) => {
  const id = requireIdParam(req.params.id);
  const row = fetchAppointment(id);
  if (!row) throw notFound('Запись не найдена');

  const actor = assertMayModify(row, req.user);
  const settings = db.settings();
  const services = fetchServices(id);

  if (actor === 'staff') {
    res.json({ appointment: appointmentAdminView(row, services, { timezone: settings.timezone }) });
    return;
  }
  res.json({
    appointment: appointmentView(row, services, {
      timezone: settings.timezone,
      rules: clientRules(row, settings),
    }),
  });
});

/**
 * POST /api/appointments/:id/reschedule — перенос на другое время того же мастера.
 * Ограничения: окно `cancel_window_hours`, лимит `max_reschedules`.
 */
router.post('/:id/reschedule', requireAuth, (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .utcInstant('starts_at')
    .string('hold_token', { required: false, min: 64, max: 64 })
    .done();

  const settings = db.settings();
  let occupiedForSuggest = 0;

  const applyReschedule = () => db.transaction(() => {
    purgeExpiredHolds();

    const row = fetchAppointment(id);
    if (!row) throw notFound('Запись не найдена');
    const actor = assertMayModify(row, req.user);

    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Запись уже завершена или отменена');
    }
    if (row.starts_at_utc === input.starts_at) {
      throw badRequest('Неверные входные данные', { starts_at: 'то же самое время' });
    }
    // Клиенту правила обязательны; у персонала перенос за клиента ими не ограничен.
    if (actor === 'client') {
      const minutesLeft = diffMinutes(row.starts_at_utc, nowUtc());
      if (minutesLeft < settings.cancel_window_hours * 60) {
        throw conflict(`Перенос возможен не позднее чем за ${settings.cancel_window_hours} ч до визита`);
      }
      if (row.reschedule_count >= settings.max_reschedules) {
        throw conflict(`Запись можно переносить не более ${settings.max_reschedules} раз`);
      }
    }

    // Состав визита не меняется — длительность берём из зафиксированных услуг.
    const services = fetchServices(id);
    const occupiedMin = services.reduce(
      (sum, s) => sum + s.duration_min_snapshot + s.buffer_after_min_snapshot, 0,
    );
    occupiedForSuggest = occupiedMin;

    const { endAtUtc } = assertSlotBookable({
      masterId: row.master_id,
      startAtUtc: input.starts_at,
      occupiedMin,
      settings,
      holdOwnerUserId: req.user.id,
      excludeHoldToken: input.hold_token || null,
      excludeAppointmentId: id,
    });

    db.run(
      `UPDATE appointments
          SET starts_at_utc = ?, ends_at_utc = ?,
              reschedule_count = reschedule_count + 1, updated_at_utc = ?
        WHERE id = ?`,
      [input.starts_at, endAtUtc, nowUtc(), id],
    );
    db.run('DELETE FROM slot_holds WHERE user_id = ?', [req.user.id]);
  });

  try {
    applyReschedule();
  } catch (err) {
    // Переносимая запись себя не блокирует, поэтому исключаем её из подсказок.
    rethrowAsConflict(err, {
      masterId: db.one('SELECT master_id FROM appointments WHERE id = ?', [id]).master_id,
      startAtUtc: input.starts_at,
      occupiedMin: occupiedForSuggest,
      settings,
      excludeAppointmentId: id,
    });
  }

  const updated = fetchAppointment(id);
  res.json({
    appointment: appointmentView(updated, fetchServices(id), {
      timezone: settings.timezone,
      rules: clientRules(updated, settings),
    }),
  });
});

/**
 * POST /api/appointments/:id/cancel — отмена записи.
 * Клиент отменяет не позднее чем за `cancel_window_hours`; персонал — в любой момент.
 */
router.post('/:id/cancel', requireAuth, (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .string('cancel_reason', { required: false, max: 500 })
    .done();

  const settings = db.settings();

  const actorKind = db.transaction(() => {
    const row = fetchAppointment(id);
    if (!row) throw notFound('Запись не найдена');
    const actor = assertMayModify(row, req.user);

    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Запись уже завершена или отменена');
    }
    if (actor === 'client') {
      const minutesLeft = diffMinutes(row.starts_at_utc, nowUtc());
      if (minutesLeft < settings.cancel_window_hours * 60) {
        throw conflict(
          `Отмена возможна не позднее чем за ${settings.cancel_window_hours} ч до визита,`
          + ' свяжитесь со студией по телефону',
        );
      }
    }

    const timestamp = nowUtc();
    db.run(
      `UPDATE appointments
          SET status = ?, cancel_reason = ?, cancelled_at_utc = ?, updated_at_utc = ?
        WHERE id = ?`,
      [actor === 'client' ? 'cancelled_by_client' : 'cancelled_by_studio',
        input.cancel_reason || null, timestamp, timestamp, id],
    );
    return actor;
  });

  const updated = fetchAppointment(id);
  const services = fetchServices(id);
  res.json({
    appointment: actorKind === 'staff'
      ? appointmentAdminView(updated, services, { timezone: settings.timezone })
      : appointmentView(updated, services, {
        timezone: settings.timezone,
        rules: clientRules(updated, settings),
      }),
  });
});

module.exports = router;
