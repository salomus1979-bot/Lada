'use strict';

const express = require('express');
const db = require('../lib/db');
const { requireRole } = require('../lib/auth');
const { Validator, requireIdParam } = require('../lib/validate');
const { badRequest, conflict, forbidden, notFound } = require('../lib/errors');
const { ACTIVE_STATUSES } = require('../lib/availability');
const { nowUtc, zonedToUtc, toUtcIso, addDays } = require('../lib/time');
const {
  serviceAdminView, masterAdminView, appointmentAdminView, STATUS_LABELS,
} = require('../lib/presenters');

const router = express.Router();

// Весь раздел доступен только персоналу студии.
router.use(requireRole('admin', 'owner'));

const STATUSES = Object.keys(STATUS_LABELS);

/* ------------------------------------------------------------------ записи */

/**
 * GET /api/admin/appointments — все записи студии.
 * Фильтры: ?date_from, ?date_to (даты в поясе салона), ?master_id, ?status,
 * ?scope=active, ?limit, ?offset.
 */
router.get('/appointments', (req, res) => {
  const input = new Validator(req.query)
    .date('date_from', { required: false })
    .date('date_to', { required: false })
    .int('master_id', { required: false, min: 1 })
    .enum('status', STATUSES, { required: false })
    .enum('scope', ['active', 'all'], { required: false })
    .int('limit', { required: false, min: 1, max: 200 })
    .int('offset', { required: false, min: 0 })
    .done();

  if (input.date_from && input.date_to && input.date_to < input.date_from) {
    throw badRequest('Неверные входные данные', { date_to: 'раньше date_from' });
  }

  const settings = db.settings();
  const where = [];
  const params = [];

  // Границы периода задаются локальными датами салона, а в запрос идут UTC-метки.
  if (input.date_from) {
    where.push('a.starts_at_utc >= ?');
    params.push(toUtcIso(zonedToUtc(input.date_from, 0, settings.timezone)));
  }
  if (input.date_to) {
    where.push('a.starts_at_utc < ?');
    params.push(toUtcIso(zonedToUtc(addDays(input.date_to, 1), 0, settings.timezone)));
  }
  if (input.master_id) {
    where.push('a.master_id = ?');
    params.push(input.master_id);
  }
  if (input.status) {
    where.push('a.status = ?');
    params.push(input.status);
  }
  if (input.scope === 'active') {
    where.push(`a.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
    params.push(...ACTIVE_STATUSES);
  }

  const limit = input.limit || 50;
  const offset = input.offset || 0;
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.one(`SELECT COUNT(*) AS n FROM appointments a ${whereSql}`, params).n;
  const rows = db.all(
    `SELECT a.id, a.client_user_id, a.master_id, a.starts_at_utc, a.ends_at_utc,
            a.service_duration_min, a.total_price_kopecks, a.status, a.client_comment,
            a.cancel_reason, a.reschedule_count, a.created_at_utc,
            m.first_name AS master_first_name, m.last_name AS master_last_name,
            u.name AS client_name, u.phone AS client_phone, u.email AS client_email
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
       JOIN users u ON u.id = a.client_user_id
       ${whereSql}
      ORDER BY a.starts_at_utc DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const services = new Map();
  if (rows.length > 0) {
    const list = db.all(
      `SELECT appointment_id, service_id, name_snapshot, price_kopecks_snapshot,
              duration_min_snapshot, buffer_after_min_snapshot
         FROM appointment_services
        WHERE appointment_id IN (${rows.map(() => '?').join(',')})
        ORDER BY id`,
      rows.map((r) => r.id),
    );
    for (const s of list) {
      if (!services.has(s.appointment_id)) services.set(s.appointment_id, []);
      services.get(s.appointment_id).push(s);
    }
  }

  res.json({
    total,
    limit,
    offset,
    appointments: rows.map((row) => appointmentAdminView(
      row, services.get(row.id) || [], { timezone: settings.timezone },
    )),
  });
});

/**
 * POST /api/admin/appointments/:id/status — смена статуса визита.
 * `no_show` увеличивает счётчик неявок и при достижении порога
 * блокирует онлайн-запись клиенту.
 */
router.post('/appointments/:id/status', (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .enum('status', ['confirmed', 'completed', 'no_show', 'cancelled_by_studio'])
    .string('cancel_reason', { required: false, max: 500 })
    .done();

  const settings = db.settings();

  const applyStatus = () => db.transaction(() => {
    const row = db.one(
      'SELECT id, client_user_id, status FROM appointments WHERE id = ?', [id],
    );
    if (!row) throw notFound('Запись не найдена');
    if (row.status === input.status) {
      throw conflict('Запись уже в этом статусе');
    }
    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Статус завершённой или отменённой записи менять нельзя');
    }

    const timestamp = nowUtc();
    db.run(
      `UPDATE appointments
          SET status = ?, cancel_reason = ?, cancelled_at_utc = ?, updated_at_utc = ?
        WHERE id = ?`,
      [input.status,
        input.status === 'cancelled_by_studio' ? (input.cancel_reason || null) : null,
        input.status === 'cancelled_by_studio' ? timestamp : null,
        timestamp, id],
    );

    if (input.status === 'no_show') {
      db.run('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ?',
        [row.client_user_id]);
      db.run(
        `UPDATE users SET is_blocked = 1
          WHERE id = ? AND no_show_count >= ? AND role = 'client'`,
        [row.client_user_id, settings.no_show_block_threshold],
      );
    }
  });

  try {
    applyStatus();
  } catch (err) {
    // Подтверждение визита тоже проходит через триггер пересечения.
    // Альтернативы здесь не предлагаем: решение за администратором.
    if (db.isOverlapError(err)) {
      throw conflict('Время визита пересекается с другой записью этого мастера',
        { reason: 'overlap' });
    }
    throw err;
  }

  res.json({ ok: true, id, status: input.status });
});

/* ----------------------------------------------------------------- услуги */

const SERVICE_SELECT = `
  s.id, s.category_id, s.name, s.description, s.duration_min, s.buffer_after_min,
  s.price_kopecks, s.is_visible, s.is_active,
  c.slug AS category_slug, c.title AS category_title`;

/** GET /api/admin/services — все услуги, включая скрытые и удалённые. */
router.get('/services', (req, res) => {
  const input = new Validator(req.query)
    .bool('include_inactive', { required: false, def: false })
    .done();

  const rows = db.all(
    `SELECT ${SERVICE_SELECT}
       FROM services s JOIN service_categories c ON c.id = s.category_id
      ${input.include_inactive ? '' : 'WHERE s.is_active = 1'}
      ORDER BY c.sort_order, s.name`,
  );
  res.json({ services: rows.map(serviceAdminView) });
});

/** POST /api/admin/services — создать услугу. Цену задаёт только владелец. */
router.post('/services', (req, res) => {
  const input = new Validator(req.body)
    .int('category_id', { min: 1 })
    .string('name', { min: 2, max: 200 })
    .string('description', { required: false, max: 160 })
    .int('duration_min', { min: 5, max: 600 })
    .int('buffer_after_min', { required: false, min: 0, max: 120 })
    .kopecks('price_kopecks')
    .bool('is_visible', { required: false, def: true })
    .done();

  if (input.duration_min % 5 !== 0) {
    throw badRequest('Неверные входные данные', { duration_min: 'кратно 5 минутам' });
  }
  if (req.user.role !== 'owner' && input.price_kopecks > 0) {
    throw forbidden('Цену услуги задаёт владелец: создайте услугу с price_kopecks = 0');
  }

  const category = db.one('SELECT id FROM service_categories WHERE id = ?', [input.category_id]);
  if (!category) throw badRequest('Неверные входные данные', { category_id: 'категория не найдена' });

  const info = db.run(
    `INSERT INTO services
       (category_id, name, description, duration_min, buffer_after_min,
        price_kopecks, is_visible, is_active, created_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [input.category_id, input.name, input.description || null, input.duration_min,
      input.buffer_after_min || 0, input.price_kopecks, input.is_visible ? 1 : 0, nowUtc()],
  );

  const row = db.one(
    `SELECT ${SERVICE_SELECT} FROM services s
       JOIN service_categories c ON c.id = s.category_id WHERE s.id = ?`,
    [Number(info.lastInsertRowid)],
  );
  res.status(201).json({ service: serviceAdminView(row) });
});

/**
 * PATCH /api/admin/services/:id — изменить услугу.
 * Длительность и цена не затрагивают уже созданные записи: там лежат снимки.
 */
router.patch('/services/:id', (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .int('category_id', { required: false, min: 1 })
    .string('name', { required: false, min: 2, max: 200 })
    .string('description', { required: false, max: 160 })
    .int('duration_min', { required: false, min: 5, max: 600 })
    .int('buffer_after_min', { required: false, min: 0, max: 120 })
    .kopecks('price_kopecks', { required: false })
    .bool('is_visible', { required: false })
    .done();

  if (Object.keys(input).length === 0) {
    throw badRequest('Нечего менять: не передано ни одного поля');
  }
  if (input.duration_min !== undefined && input.duration_min % 5 !== 0) {
    throw badRequest('Неверные входные данные', { duration_min: 'кратно 5 минутам' });
  }
  if (input.price_kopecks !== undefined && req.user.role !== 'owner') {
    throw forbidden('Цену услуги может менять только владелец');
  }

  const existing = db.one('SELECT id FROM services WHERE id = ? AND is_active = 1', [id]);
  if (!existing) throw notFound('Услуга не найдена');

  if (input.category_id !== undefined) {
    const category = db.one('SELECT id FROM service_categories WHERE id = ?', [input.category_id]);
    if (!category) throw badRequest('Неверные входные данные', { category_id: 'категория не найдена' });
  }

  const fields = [];
  const params = [];
  const assign = (column, value) => {
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      params.push(value);
    }
  };
  assign('category_id', input.category_id);
  assign('name', input.name);
  assign('description', input.description);
  assign('duration_min', input.duration_min);
  assign('buffer_after_min', input.buffer_after_min);
  assign('price_kopecks', input.price_kopecks);
  assign('is_visible', input.is_visible === undefined ? undefined : (input.is_visible ? 1 : 0));

  db.run(`UPDATE services SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);

  const row = db.one(
    `SELECT ${SERVICE_SELECT} FROM services s
       JOIN service_categories c ON c.id = s.category_id WHERE s.id = ?`,
    [id],
  );
  res.json({ service: serviceAdminView(row) });
});

/**
 * DELETE /api/admin/services/:id — мягкое удаление.
 * Физически не удаляем: на услугу ссылается история записей.
 * Пока есть активные записи с этой услугой — 409.
 */
router.delete('/services/:id', (req, res) => {
  const id = requireIdParam(req.params.id);
  const existing = db.one('SELECT id FROM services WHERE id = ? AND is_active = 1', [id]);
  if (!existing) throw notFound('Услуга не найдена');

  const used = db.one(
    `SELECT COUNT(*) AS n FROM appointment_services aps
       JOIN appointments a ON a.id = aps.appointment_id
      WHERE aps.service_id = ? AND a.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
        AND a.starts_at_utc > ?`,
    [id, ...ACTIVE_STATUSES, nowUtc()],
  );
  if (used.n > 0) {
    throw conflict('С услугой есть активные записи — сначала перенесите или отмените их',
      { active_appointments: used.n });
  }

  db.run('UPDATE services SET is_active = 0, is_visible = 0 WHERE id = ?', [id]);
  db.run('DELETE FROM master_services WHERE service_id = ?', [id]);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- мастера */

const MASTER_SELECT = `
  m.id, m.user_id, m.first_name, m.last_name, m.specialization, m.experience_years,
  m.bio, m.photo_url, m.is_visible, m.is_active, m.sort_order,
  u.email AS account_email, u.last_login_at_utc`;

function masterWithServices(id) {
  const row = db.one(
    `SELECT ${MASTER_SELECT} FROM masters m
       LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    [id],
  );
  if (!row) return null;
  const links = db.all('SELECT service_id FROM master_services WHERE master_id = ?', [id]);
  return masterAdminView(row, links.map((l) => l.service_id));
}

/** GET /api/admin/masters — все мастера, включая скрытых. */
router.get('/masters', (req, res) => {
  const input = new Validator(req.query)
    .bool('include_inactive', { required: false, def: false })
    .done();

  const rows = db.all(
    `SELECT ${MASTER_SELECT} FROM masters m
       LEFT JOIN users u ON u.id = m.user_id
      ${input.include_inactive ? '' : 'WHERE m.is_active = 1'}
      ORDER BY m.sort_order, m.id`,
  );
  const links = rows.length === 0 ? [] : db.all(
    `SELECT master_id, service_id FROM master_services
      WHERE master_id IN (${rows.map(() => '?').join(',')})`,
    rows.map((r) => r.id),
  );
  const byMaster = new Map();
  for (const link of links) {
    if (!byMaster.has(link.master_id)) byMaster.set(link.master_id, []);
    byMaster.get(link.master_id).push(link.service_id);
  }
  res.json({ masters: rows.map((r) => masterAdminView(r, byMaster.get(r.id) || [])) });
});

/** POST /api/admin/masters — создать мастера. */
router.post('/masters', (req, res) => {
  const input = new Validator(req.body)
    .string('first_name', { min: 2, max: 100 })
    .string('last_name', { min: 2, max: 100 })
    .string('specialization', { required: false, max: 200 })
    .int('experience_years', { required: false, min: 0, max: 80 })
    .string('bio', { required: false, max: 300 })
    .string('photo_url', { required: false, max: 500 })
    .bool('is_visible', { required: false, def: true })
    .int('sort_order', { required: false, min: 0, max: 9999 })
    .idArray('service_ids', { required: false, max: 100 })
    .done();

  const newId = db.transaction(() => {
    if (input.service_ids && input.service_ids.length > 0) {
      const found = db.all(
        `SELECT id FROM services
          WHERE is_active = 1 AND id IN (${input.service_ids.map(() => '?').join(',')})`,
        input.service_ids,
      );
      if (found.length !== input.service_ids.length) {
        throw badRequest('Неверные входные данные', { service_ids: 'есть несуществующие услуги' });
      }
    }

    const info = db.run(
      `INSERT INTO masters
         (first_name, last_name, specialization, experience_years, bio, photo_url,
          is_visible, is_active, sort_order, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [input.first_name, input.last_name, input.specialization || null,
        input.experience_years ?? null, input.bio || null, input.photo_url || null,
        input.is_visible ? 1 : 0, input.sort_order || 0, nowUtc()],
    );
    const id = Number(info.lastInsertRowid);

    for (const serviceId of input.service_ids || []) {
      db.run('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)', [id, serviceId]);
    }
    return id;
  });

  res.status(201).json({ master: masterWithServices(newId) });
});

/** PATCH /api/admin/masters/:id — изменить мастера и, при необходимости, список его услуг. */
router.patch('/masters/:id', (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .string('first_name', { required: false, min: 2, max: 100 })
    .string('last_name', { required: false, min: 2, max: 100 })
    .string('specialization', { required: false, max: 200 })
    .int('experience_years', { required: false, min: 0, max: 80 })
    .string('bio', { required: false, max: 300 })
    .string('photo_url', { required: false, max: 500 })
    .bool('is_visible', { required: false })
    .int('sort_order', { required: false, min: 0, max: 9999 })
    .idArray('service_ids', { required: false, min: 0, max: 100 })
    .done();

  if (Object.keys(input).length === 0) {
    throw badRequest('Нечего менять: не передано ни одного поля');
  }

  db.transaction(() => {
    const existing = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
    if (!existing) throw notFound('Мастер не найден');

    const fields = [];
    const params = [];
    const assign = (column, value) => {
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        params.push(value);
      }
    };
    assign('first_name', input.first_name);
    assign('last_name', input.last_name);
    assign('specialization', input.specialization);
    assign('experience_years', input.experience_years);
    assign('bio', input.bio);
    assign('photo_url', input.photo_url);
    assign('is_visible', input.is_visible === undefined ? undefined : (input.is_visible ? 1 : 0));
    assign('sort_order', input.sort_order);

    if (fields.length > 0) {
      db.run(`UPDATE masters SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
    }

    if (input.service_ids !== undefined) {
      if (input.service_ids.length > 0) {
        const found = db.all(
          `SELECT id FROM services
            WHERE is_active = 1 AND id IN (${input.service_ids.map(() => '?').join(',')})`,
          input.service_ids,
        );
        if (found.length !== input.service_ids.length) {
          throw badRequest('Неверные входные данные', { service_ids: 'есть несуществующие услуги' });
        }
      }
      db.run('DELETE FROM master_services WHERE master_id = ?', [id]);
      for (const serviceId of input.service_ids) {
        db.run('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)', [id, serviceId]);
      }
    }
  });

  res.json({ master: masterWithServices(id) });
});

/** DELETE /api/admin/masters/:id — мягкое удаление; активные записи блокируют операцию. */
router.delete('/masters/:id', (req, res) => {
  const id = requireIdParam(req.params.id);
  const existing = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
  if (!existing) throw notFound('Мастер не найден');

  const active = db.one(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE master_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
        AND starts_at_utc > ?`,
    [id, ...ACTIVE_STATUSES, nowUtc()],
  );
  if (active.n > 0) {
    throw conflict('У мастера есть активные записи — сначала перенесите или отмените их',
      { active_appointments: active.n });
  }

  db.run('UPDATE masters SET is_active = 0, is_visible = 0 WHERE id = ?', [id]);
  res.json({ ok: true });
});

/* ------------------------------------------------- график работы мастера */

/** GET /api/admin/masters/:id/schedule — регулярный график и исключения. */
router.get('/masters/:id/schedule', (req, res) => {
  const id = requireIdParam(req.params.id);
  const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
  if (!master) throw notFound('Мастер не найден');

  res.json({
    master_id: id,
    timezone: db.settings().timezone,
    week: db.all(
      `SELECT weekday, is_day_off, start_min, end_min, break_start_min, break_end_min
         FROM master_work_schedule WHERE master_id = ? ORDER BY weekday`,
      [id],
    ).map((r) => ({ ...r, is_day_off: r.is_day_off === 1 })),
    exceptions: db.all(
      `SELECT id, type, start_date, end_date, start_min, end_min, reason
         FROM master_schedule_exceptions WHERE master_id = ? ORDER BY start_date`,
      [id],
    ),
  });
});

/**
 * PUT /api/admin/masters/:id/schedule — заменить недельный график целиком.
 * Время — минуты от полуночи в поясе салона (`salon_settings.timezone`).
 */
router.put('/masters/:id/schedule', (req, res) => {
  const id = requireIdParam(req.params.id);
  const week = req.body && req.body.week;
  if (!Array.isArray(week) || week.length === 0 || week.length > 7) {
    throw badRequest('Неверные входные данные', { week: 'ожидается массив из 1–7 дней' });
  }

  // Полностью валидируем все дни до первого обращения к базе.
  const days = [];
  const seen = new Set();
  week.forEach((raw, index) => {
    const day = new Validator(raw)
      .int('weekday', { min: 1, max: 7 })
      .bool('is_day_off', { required: false, def: false })
      .minuteOfDay('start_min', { required: false })
      .minuteOfDay('end_min', { required: false })
      .minuteOfDay('break_start_min', { required: false })
      .minuteOfDay('break_end_min', { required: false })
      .done();

    const fail = (message) => {
      throw badRequest('Неверные входные данные', { [`week[${index}]`]: message });
    };
    if (seen.has(day.weekday)) fail('день недели повторяется');
    seen.add(day.weekday);

    if (!day.is_day_off) {
      if (day.start_min === undefined || day.end_min === undefined) fail('нужны start_min и end_min');
      if (day.end_min <= day.start_min) fail('end_min должен быть больше start_min');
      const hasBreakStart = day.break_start_min !== undefined;
      const hasBreakEnd = day.break_end_min !== undefined;
      if (hasBreakStart !== hasBreakEnd) fail('перерыв задаётся обеими границами');
      if (hasBreakStart) {
        if (day.break_end_min <= day.break_start_min) fail('break_end_min должен быть больше break_start_min');
        if (day.break_start_min < day.start_min || day.break_end_min > day.end_min) {
          fail('перерыв выходит за рабочие часы');
        }
      }
    }
    days.push(day);
  });

  db.transaction(() => {
    const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
    if (!master) throw notFound('Мастер не найден');

    db.run('DELETE FROM master_work_schedule WHERE master_id = ?', [id]);
    for (const day of days) {
      db.run(
        `INSERT INTO master_work_schedule
           (master_id, weekday, is_day_off, start_min, end_min, break_start_min, break_end_min)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, day.weekday, day.is_day_off ? 1 : 0,
          day.is_day_off ? null : day.start_min,
          day.is_day_off ? null : day.end_min,
          day.is_day_off ? null : (day.break_start_min ?? null),
          day.is_day_off ? null : (day.break_end_min ?? null)],
      );
    }
  });

  res.json({ ok: true, master_id: id, days: days.length });
});

/**
 * POST /api/admin/masters/:id/exceptions — отпуск, больничный, разовый выходной
 * или разовое изменение часов. Перекрывает регулярный график.
 */
router.post('/masters/:id/exceptions', (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .enum('type', ['vacation', 'sick_leave', 'hours_override', 'day_off'])
    .date('start_date')
    .date('end_date')
    .minuteOfDay('start_min', { required: false })
    .minuteOfDay('end_min', { required: false })
    .string('reason', { required: false, max: 500 })
    .done();

  if (input.end_date < input.start_date) {
    throw badRequest('Неверные входные данные', { end_date: 'раньше start_date' });
  }
  if (input.type === 'hours_override') {
    if (input.start_min === undefined || input.end_min === undefined) {
      throw badRequest('Неверные входные данные', {
        start_min: 'для разового изменения часов нужны start_min и end_min',
      });
    }
    if (input.end_min <= input.start_min) {
      throw badRequest('Неверные входные данные', { end_min: 'должен быть больше start_min' });
    }
  }

  const settings = db.settings();

  const newId = db.transaction(() => {
    const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
    if (!master) throw notFound('Мастер не найден');

    // Закрывать день, в котором уже есть визиты, нельзя: их надо сначала перенести.
    const rangeStart = toUtcIso(zonedToUtc(input.start_date, 0, settings.timezone));
    const rangeEnd = toUtcIso(zonedToUtc(addDays(input.end_date, 1), 0, settings.timezone));
    const clash = db.one(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE master_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          AND starts_at_utc < ? AND ends_at_utc > ?`,
      [id, ...ACTIVE_STATUSES, rangeEnd, rangeStart],
    );
    if (clash.n > 0) {
      throw conflict('На этот период есть записи — их нужно перенести',
        { appointments: clash.n });
    }

    const info = db.run(
      `INSERT INTO master_schedule_exceptions
         (master_id, type, start_date, end_date, start_min, end_min, reason, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.type, input.start_date, input.end_date,
        input.start_min ?? null, input.end_min ?? null, input.reason || null, nowUtc()],
    );
    return Number(info.lastInsertRowid);
  });

  res.status(201).json({
    exception: {
      id: newId,
      master_id: id,
      type: input.type,
      start_date: input.start_date,
      end_date: input.end_date,
      start_min: input.start_min ?? null,
      end_min: input.end_min ?? null,
      reason: input.reason || null,
    },
  });
});

/** DELETE /api/admin/masters/:id/exceptions/:exceptionId — снять исключение. */
router.delete('/masters/:id/exceptions/:exceptionId', (req, res) => {
  const id = requireIdParam(req.params.id, 'master_id');
  const exceptionId = requireIdParam(req.params.exceptionId, 'exception_id');
  const info = db.run(
    'DELETE FROM master_schedule_exceptions WHERE id = ? AND master_id = ?',
    [exceptionId, id],
  );
  if (info.changes === 0) throw notFound('Исключение не найдено');
  res.json({ ok: true });
});

/**
 * POST /api/admin/masters/:id/time-blocks — точечная блокировка времени.
 * Время принимается в UTC. Если на интервал есть запись — 409.
 */
router.post('/masters/:id/time-blocks', (req, res) => {
  const id = requireIdParam(req.params.id);
  const input = new Validator(req.body)
    .enum('type', ['break', 'time_off', 'vacation', 'sick_leave'])
    .utcInstant('starts_at')
    .utcInstant('ends_at')
    .string('comment', { required: false, max: 500 })
    .done();

  if (input.ends_at <= input.starts_at) {
    throw badRequest('Неверные входные данные', { ends_at: 'должен быть позже starts_at' });
  }

  const newId = db.transaction(() => {
    const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [id]);
    if (!master) throw notFound('Мастер не найден');

    const clash = db.one(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE master_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          AND starts_at_utc < ? AND ends_at_utc > ?`,
      [id, ...ACTIVE_STATUSES, input.ends_at, input.starts_at],
    );
    if (clash.n > 0) {
      throw conflict('На это время уже есть запись — заблокировать нельзя',
        { appointments: clash.n });
    }

    const info = db.run(
      `INSERT INTO time_blocks
         (master_id, type, starts_at_utc, ends_at_utc, comment, created_by_user_id, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.type, input.starts_at, input.ends_at,
        input.comment || null, req.user.id, nowUtc()],
    );
    return Number(info.lastInsertRowid);
  });

  res.status(201).json({
    time_block: {
      id: newId,
      master_id: id,
      type: input.type,
      starts_at_utc: input.starts_at,
      ends_at_utc: input.ends_at,
      comment: input.comment || null,
    },
  });
});

/** DELETE /api/admin/masters/:id/time-blocks/:blockId — снять блокировку. */
router.delete('/masters/:id/time-blocks/:blockId', (req, res) => {
  const id = requireIdParam(req.params.id, 'master_id');
  const blockId = requireIdParam(req.params.blockId, 'block_id');
  const info = db.run('DELETE FROM time_blocks WHERE id = ? AND master_id = ?', [blockId, id]);
  if (info.changes === 0) throw notFound('Блокировка не найдена');
  res.json({ ok: true });
});

module.exports = router;
