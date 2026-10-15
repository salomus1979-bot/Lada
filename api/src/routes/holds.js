'use strict';

const crypto = require('node:crypto');
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { Validator } = require('../lib/validate');
const { notFound, forbidden } = require('../lib/errors');
const {
  purgeExpiredHolds, loadServices, assertMasterPerformsServices, assertSlotBookable,
} = require('../lib/availability');
const { nowUtc, addMinutesIso, presentInstant } = require('../lib/time');

const router = express.Router();

function holdView(row, timezone) {
  return {
    token: row.token,
    master_id: row.master_id,
    starts_at: presentInstant(row.starts_at_utc, timezone),
    ends_at: presentInstant(row.ends_at_utc, timezone),
    expires_at_utc: row.expires_at_utc,
  };
}

/**
 * POST /api/holds — удержать выбранный слот на время оформления.
 *
 * Слот держится `salon_settings.hold_ttl_min` минут. Истёкшие удержания
 * удаляются физически при каждом расчёте доступности и при создании записи,
 * поэтому слот освобождается сам, без планировщика.
 *
 * У одного пользователя не больше одного удержания: новое заменяет прежнее —
 * иначе клиент, гуляя по календарю, заблокировал бы полдня.
 */
router.post('/', requireAuth, (req, res) => {
  const input = new Validator(req.body)
    .int('master_id', { min: 1 })
    .idArray('service_ids')
    .utcInstant('starts_at')
    .done();

  if (req.user.isBlocked) {
    throw forbidden('Онлайн-запись для аккаунта ограничена, позвоните администратору');
  }

  const settings = db.settings();

  const result = db.transaction(() => {
    purgeExpiredHolds();
    assertMasterPerformsServices(input.master_id, input.service_ids);
    const { occupiedMin } = loadServices(input.service_ids);

    const { endAtUtc } = assertSlotBookable({
      masterId: input.master_id,
      startAtUtc: input.starts_at,
      occupiedMin,
      settings,
      holdOwnerUserId: req.user.id,
    });

    db.run('DELETE FROM slot_holds WHERE user_id = ?', [req.user.id]);

    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = nowUtc();
    const expiresAt = addMinutesIso(createdAt, settings.hold_ttl_min);
    db.run(
      `INSERT INTO slot_holds
         (token, user_id, master_id, starts_at_utc, ends_at_utc, expires_at_utc, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token, req.user.id, input.master_id, input.starts_at, endAtUtc, expiresAt, createdAt],
    );

    return {
      token,
      master_id: input.master_id,
      starts_at_utc: input.starts_at,
      ends_at_utc: endAtUtc,
      expires_at_utc: expiresAt,
    };
  });

  res.status(201).json({
    hold: holdView(result, settings.timezone),
    expires_in_sec: settings.hold_ttl_min * 60,
  });
});

/** GET /api/holds/current — своё действующее удержание (404, если его нет или истекло). */
router.get('/current', requireAuth, (req, res) => {
  purgeExpiredHolds();
  const row = db.one(
    `SELECT token, master_id, starts_at_utc, ends_at_utc, expires_at_utc
       FROM slot_holds WHERE user_id = ? AND expires_at_utc > ?`,
    [req.user.id, nowUtc()],
  );
  if (!row) throw notFound('Действующего удержания нет');
  res.json({ hold: holdView(row, db.settings().timezone) });
});

/** DELETE /api/holds/:token — снять своё удержание (клиент ушёл с шага оформления). */
router.delete('/:token', requireAuth, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw notFound('Удержание не найдено');
  }
  purgeExpiredHolds();
  // Условие по user_id: чужое удержание снять нельзя, и его существование не раскрывается.
  const info = db.run('DELETE FROM slot_holds WHERE token = ? AND user_id = ?',
    [token, req.user.id]);
  if (info.changes === 0) throw notFound('Удержание не найдено');
  res.json({ ok: true });
});

module.exports = router;
