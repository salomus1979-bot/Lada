'use strict';

// Записи клиента. Проверок и SQL здесь нет: создание, перенос и отмена живут
// в lib/booking.js — единственном месте, которое меняет таблицу appointments.
// Роут валидирует путь, вызывает операцию и выбирает вид ответа.

const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { Validator, requireIdParam } = require('../lib/validate');
const { notFound } = require('../lib/errors');
const { ACTIVE_STATUSES } = require('../lib/availability');
const { nowUtc, diffMinutes } = require('../lib/time');
const { appointmentView, appointmentAdminView } = require('../lib/presenters');
const {
  APPOINTMENT_COLUMNS, fetchAppointment, fetchServices, fetchEvents, assertMayModify,
  createAppointment, rescheduleAppointment, cancelAppointment,
} = require('../lib/booking');

const router = express.Router();

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

/** Запись в том виде, в котором её видит владелец. */
const ownerResponse = (row, services, settings) => ({
  appointment: appointmentView(row, services, {
    timezone: settings.timezone,
    rules: clientRules(row, settings),
  }),
});

/**
 * Запись в том виде, в котором её видит персонал: с данными клиента и
 * историей — кто создал, кто переносил откуда и куда, кто отменил и почему.
 */
const staffResponse = (row, services, settings) => ({
  appointment: appointmentAdminView(row, services, {
    timezone: settings.timezone,
    events: fetchEvents(row.id),
  }),
});

/**
 * POST /api/appointments — создание записи.
 *
 * Один эндпоинт для всех ролей: клиент записывает себя, администратор —
 * клиента студии. Чем именно различаются роли, описано в lib/booking.js.
 */
router.post('/', requireAuth, (req, res) => {
  const { id, forClient, settings } = createAppointment(req.user, req.body);

  const row = fetchAppointment(id);
  const services = fetchServices(id);
  // Запись за клиента возвращается в админском виде: оформителю нужны данные
  // клиента и признак наложения, а clientRules описывают права владельца
  // записи — к администратору они не относятся.
  res.status(201).json(forClient
    ? staffResponse(row, services, settings)
    : ownerResponse(row, services, settings));
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

  res.json(actor === 'staff'
    ? staffResponse(row, services, settings)
    : ownerResponse(row, services, settings));
});

/**
 * POST /api/appointments/:id/reschedule — перенос на другое время того же мастера.
 * Ограничения клиента: окно `cancel_window_hours`, лимит `max_reschedules`.
 */
router.post('/:id/reschedule', requireAuth, (req, res) => {
  const id = requireIdParam(req.params.id);
  const { settings } = rescheduleAppointment(req.user, id, req.body);

  res.json(ownerResponse(fetchAppointment(id), fetchServices(id), settings));
});

/**
 * POST /api/appointments/:id/cancel — отмена записи.
 * Клиент отменяет не позднее чем за `cancel_window_hours`; персонал — в любой момент.
 */
router.post('/:id/cancel', requireAuth, (req, res) => {
  const id = requireIdParam(req.params.id);
  const { actor, settings } = cancelAppointment(req.user, id, req.body);

  const row = fetchAppointment(id);
  const services = fetchServices(id);
  res.json(actor === 'staff'
    ? staffResponse(row, services, settings)
    : ownerResponse(row, services, settings));
});

module.exports = router;
