'use strict';

const express = require('express');
const db = require('../lib/db');
const { Validator, requireIdParam } = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const {
  availableSlots, assertMasterPerformsServices, bookingHorizonDate,
} = require('../lib/availability');
const { presentInstant } = require('../lib/time');
const { rubles } = require('../lib/presenters');

const router = express.Router();

/**
 * GET /api/masters/:id/availability?date=YYYY-MM-DD&service_ids=1,2
 *
 * Свободное начало визита у мастера на дату. Считается на лету:
 * график работы -> исключения -> часы студии -> минус записи, блокировки
 * и действующие удержания других клиентов. Учитывается суммарная
 * длительность выбранных услуг вместе с буферами уборки.
 *
 * `date` — календарная дата в поясе салона; все метки в ответе — UTC
 * плюс разложенное локальное время для показа.
 */
router.get('/masters/:id/availability', (req, res) => {
  const masterId = requireIdParam(req.params.id, 'master_id');
  const input = new Validator(req.query)
    .date('date')
    .idArray('service_ids')
    .done();

  const settings = db.settings();
  const horizon = bookingHorizonDate(settings);
  if (input.date > horizon) {
    throw badRequest('Дата за горизонтом записи', {
      date: `не позднее ${horizon}`,
    });
  }

  // Проверяем связку мастер-услуги до расчёта: иначе отдали бы слоты,
  // на которые всё равно нельзя записаться.
  assertMasterPerformsServices(masterId, input.service_ids);

  const computed = availableSlots({
    masterId,
    date: input.date,
    serviceIds: input.service_ids,
    settings,
    holdOwnerUserId: req.user ? req.user.id : null,
  });

  res.json({
    master_id: masterId,
    date: input.date,
    timezone: settings.timezone,
    slot_step_min: settings.slot_step_min,
    service_duration_min: computed.service_duration_min,
    total_price_kopecks: computed.total_price_kopecks,
    total_price_display: rubles(computed.total_price_kopecks),
    slots: computed.slots.map((iso) => presentInstant(iso, settings.timezone)),
  });
});

module.exports = router;
