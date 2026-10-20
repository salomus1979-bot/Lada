'use strict';

const express = require('express');
const db = require('../lib/db');
const { Validator } = require('../lib/validate');
const { serviceView, masterView, settingsPublicView } = require('../lib/presenters');

const router = express.Router();

/**
 * GET /api/services — каталог услуг.
 * Фильтры: ?category=<slug>, ?master_id=<id>.
 * Отдаются только активные и видимые в каталоге услуги.
 */
router.get('/services', (req, res) => {
  const input = new Validator(req.query)
    .string('category', { required: false, max: 50 })
    .int('master_id', { required: false, min: 1 })
    .done();

  const where = ['s.is_active = 1', 's.is_visible = 1'];
  const params = [];
  if (input.category) {
    where.push('c.slug = ?');
    params.push(input.category);
  }
  if (input.master_id) {
    where.push('EXISTS (SELECT 1 FROM master_services ms WHERE ms.service_id = s.id AND ms.master_id = ?)');
    params.push(input.master_id);
  }

  const rows = db.all(
    `SELECT s.id, s.category_id, s.name, s.description, s.duration_min, s.price_kopecks,
            c.slug AS category_slug, c.title AS category_title, c.sort_order AS category_sort
       FROM services s
       JOIN service_categories c ON c.id = s.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.sort_order, c.id, s.name`,
    params,
  );

  res.json({ services: rows.map(serviceView) });
});

/** GET /api/service-categories — категории каталога. */
router.get('/service-categories', (_req, res) => {
  const rows = db.all(
    `SELECT id, slug, title, description FROM service_categories ORDER BY sort_order, id`,
  );
  res.json({ categories: rows });
});

/**
 * GET /api/masters — список мастеров.
 * ?service_ids=1,2 оставляет только тех, кто выполняет ВСЕ указанные услуги:
 * визит делает один мастер целиком.
 */
router.get('/masters', (req, res) => {
  const input = new Validator(req.query)
    .idArray('service_ids', { required: false })
    .done();

  const where = ['m.is_active = 1', 'm.is_visible = 1'];
  const params = [];

  if (input.service_ids) {
    const placeholders = input.service_ids.map(() => '?').join(',');
    where.push(`(SELECT COUNT(*) FROM master_services ms
                  WHERE ms.master_id = m.id AND ms.service_id IN (${placeholders})) = ?`);
    params.push(...input.service_ids, input.service_ids.length);
  }

  const rows = db.all(
    `SELECT m.id, m.first_name, m.last_name, m.specialization, m.experience_years,
            m.bio, m.photo_url
       FROM masters m
      WHERE ${where.join(' AND ')}
      ORDER BY m.sort_order, m.id`,
    params,
  );

  const links = rows.length === 0 ? [] : db.all(
    `SELECT ms.master_id, ms.service_id
       FROM master_services ms
       JOIN services s ON s.id = ms.service_id
      WHERE s.is_active = 1 AND ms.master_id IN (${rows.map(() => '?').join(',')})`,
    rows.map((r) => r.id),
  );

  const byMaster = new Map();
  for (const link of links) {
    if (!byMaster.has(link.master_id)) byMaster.set(link.master_id, []);
    byMaster.get(link.master_id).push(link.service_id);
  }

  res.json({ masters: rows.map((r) => masterView(r, byMaster.get(r.id) || [])) });
});

/** GET /api/settings — публичные настройки студии, часы работы и правила записи. */
router.get('/settings', (_req, res) => {
  res.json({ settings: settingsPublicView(db.settings(), db.salonHours()) });
});

module.exports = router;
