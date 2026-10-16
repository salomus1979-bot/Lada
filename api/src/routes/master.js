'use strict';

/**
 * Кабинет мастера — страницы 36–42 прототипа.
 *
 * Чего здесь нет и не должно быть: создания, отмены и переноса записи.
 * Страница 38 говорит прямым текстом: «Отменить запись может только
 * администратор. Мы отправим ему ваш запрос». Поэтому единственная операция
 * мастера над визитом — смена статуса, и она уходит в ту же
 * changeAppointmentStatus, которой пользуется администратор (lib/booking.js).
 * Блокировки времени тоже общие с админским разделом (lib/blocks.js).
 *
 * Все эндпоинты работают только со СВОИМИ данными: master_id берётся из
 * аккаунта, а не из запроса, поэтому подставить чужой нельзя.
 */

const express = require('express');
const db = require('../lib/db');
const { requireRole } = require('../lib/auth');
const { Validator, requireIdParam } = require('../lib/validate');
const { forbidden, notFound } = require('../lib/errors');
const {
  ACTIVE_STATUSES, workWindowsForDate, bookingHorizonDate,
} = require('../lib/availability');
const {
  nowUtc, toUtcIso, zonedToUtc, utcToZoned, addDays, weekdayOfDate, presentInstant,
} = require('../lib/time');
const {
  masterView, appointmentMasterView, masterClientView, STATUS_LABELS,
} = require('../lib/presenters');
const { changeAppointmentStatus, fetchServices } = require('../lib/booking');
const { createTimeBlock, deleteTimeBlock, listTimeBlocks } = require('../lib/blocks');

const router = express.Router();

// Весь раздел — только роль master.
router.use(requireRole('master'));

const BLOCK_LABELS = {
  break: 'Перерыв',
  time_off: 'Отгул',
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
};

const WEEKDAY_TITLES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

/**
 * Карточка мастера по аккаунту. Связь — `masters.user_id`.
 *
 * Аккаунт с ролью master, за которым карточки нет (мастера удалили или
 * доступ отозвали, а сессия осталась), получает 403: роль есть, рабочего
 * места нет. Это не 404 — скрывать тут нечего, человек спрашивает про себя.
 */
function requireMaster(req, _res, next) {
  const row = db.one(
    `SELECT id, user_id, first_name, last_name, specialization, experience_years,
            bio, photo_url, is_visible, is_active, sort_order
       FROM masters WHERE user_id = ? AND is_active = 1`,
    [req.user.id],
  );
  if (!row) return next(forbidden('Рабочий кабинет недоступен: карточка мастера не найдена'));
  req.master = row;
  next();
}
router.use(requireMaster);

/** Границы локальной даты в UTC: [начало суток, начало следующих). */
function dayBoundsUtc(date, timezone) {
  return {
    fromUtc: toUtcIso(zonedToUtc(date, 0, timezone)),
    toUtc: toUtcIso(zonedToUtc(addDays(date, 1), 0, timezone)),
  };
}

/** Визиты мастера за период, с данными клиента и составом услуг. */
function appointmentsInRange(masterId, fromUtc, toUtc, { activeOnly = false } = {}) {
  const statusFilter = activeOnly
    ? `AND a.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    : '';
  return db.all(
    `SELECT a.id, a.client_user_id, a.master_id, a.starts_at_utc, a.ends_at_utc,
            a.service_duration_min, a.total_price_kopecks, a.status, a.client_comment,
            a.cancel_reason, a.reschedule_count, a.created_at_utc,
            m.first_name AS master_first_name, m.last_name AS master_last_name,
            u.name AS client_name, u.phone AS client_phone, u.email AS client_email
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
       JOIN users u ON u.id = a.client_user_id
      WHERE a.master_id = ? AND a.starts_at_utc < ? AND a.ends_at_utc > ? ${statusFilter}
      ORDER BY a.starts_at_utc`,
    activeOnly
      ? [masterId, toUtc, fromUtc, ...ACTIVE_STATUSES]
      : [masterId, toUtc, fromUtc],
  );
}

const ms = (iso) => new Date(iso).getTime();
const minutesBetween = (fromMs, toMs) => Math.round((toMs - fromMs) / 60000);

/**
 * Лента дня: визиты, блокировки и свободные окна между ними — страница 36.
 *
 * Свободное считается вычитанием занятого из рабочих окон мастера, а не из
 * суток: вне графика «свободно» не бывает, там просто нерабочее время.
 */
function dayTimeline(masterId, date, settings) {
  const { timezone } = settings;
  const { fromUtc, toUtc } = dayBoundsUtc(date, timezone);

  const visits = appointmentsInRange(masterId, fromUtc, toUtc, { activeOnly: false });
  const blocks = listTimeBlocks(masterId, fromUtc, toUtc);

  const items = [
    ...visits.map((row) => ({
      kind: 'appointment',
      startMs: ms(row.starts_at_utc),
      endMs: ms(row.ends_at_utc),
      row,
    })),
    ...blocks.map((b) => ({
      kind: 'block',
      startMs: ms(b.starts_at_utc),
      endMs: ms(b.ends_at_utc),
      block: b,
    })),
  ];

  // Время мастера занимают только активные визиты: отменённый и завершённый
  // остаются в ленте, но свободное окно собой не закрывают.
  const busy = items
    .filter((it) => it.kind === 'block' || ACTIVE_STATUSES.includes(it.row.status))
    .map((it) => ({ startMs: it.startMs, endMs: it.endMs }))
    .sort((a, b) => a.startMs - b.startMs);

  const windows = workWindowsForDate(masterId, date);
  const free = [];
  let busyMin = 0;
  let workMin = 0;

  for (const w of windows) {
    const wStart = zonedToUtc(date, w.startMin, timezone).getTime();
    const wEnd = zonedToUtc(date, w.endMin, timezone).getTime();
    workMin += minutesBetween(wStart, wEnd);

    let cursor = wStart;
    for (const b of busy) {
      const start = Math.max(b.startMs, wStart);
      const end = Math.min(b.endMs, wEnd);
      if (end <= start) continue;
      busyMin += minutesBetween(start, end);
      if (start > cursor) free.push({ startMs: cursor, endMs: start });
      cursor = Math.max(cursor, end);
    }
    if (cursor < wEnd) free.push({ startMs: cursor, endMs: wEnd });
  }

  const timeline = [
    ...items,
    ...free.map((f) => ({ kind: 'free', startMs: f.startMs, endMs: f.endMs })),
  ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return {
    visits,
    workMin,
    busyMin,
    freeMin: Math.max(0, workMin - busyMin),
    freeWindows: free.length,
    worksToday: windows.length > 0,
    timeline: timeline.map((it) => {
      const base = {
        kind: it.kind,
        starts_at: presentInstant(toUtcIso(new Date(it.startMs)), timezone),
        ends_at: presentInstant(toUtcIso(new Date(it.endMs)), timezone),
        duration_min: minutesBetween(it.startMs, it.endMs),
      };
      if (it.kind === 'appointment') {
        return {
          ...base,
          appointment_id: it.row.id,
          status: it.row.status,
          status_label: STATUS_LABELS[it.row.status],
          client_name: it.row.client_name,
          services: fetchServices(it.row.id).map((s) => s.name_snapshot).join(' + '),
          client_comment: it.row.client_comment,
        };
      }
      if (it.kind === 'block') {
        return {
          ...base,
          block_id: it.block.id,
          type: it.block.type,
          type_label: BLOCK_LABELS[it.block.type],
          comment: it.block.comment,
        };
      }
      return base;
    }),
  };
}

/** GET /api/master/me — своя карточка и доступ (страница 42, часть «только чтение»). */
router.get('/me', (req, res) => {
  const serviceIds = db.all(
    'SELECT service_id FROM master_services WHERE master_id = ? ORDER BY service_id',
    [req.master.id],
  ).map((r) => r.service_id);

  res.json({
    master: masterView(req.master, serviceIds),
    account: { id: req.user.id, email: req.user.email, name: req.user.name },
  });
});

/**
 * GET /api/master/day?date=YYYY-MM-DD — «Мой день» (страница 36).
 * Без `date` — сегодня в поясе студии.
 */
router.get('/day', (req, res) => {
  const input = new Validator(req.query).date('date', { required: false }).done();
  const settings = db.settings();
  const date = input.date || utcToZoned(new Date(), settings.timezone).date;

  const day = dayTimeline(req.master.id, date, settings);
  const activeCount = day.visits.filter((v) => ACTIVE_STATUSES.includes(v.status)).length;

  res.json({
    date,
    weekday: WEEKDAY_TITLES[weekdayOfDate(date) - 1],
    timezone: settings.timezone,
    works_today: day.worksToday,
    summary: {
      appointments_count: activeCount,
      busy_min: day.busyMin,
      free_min: day.freeMin,
      free_windows: day.freeWindows,
    },
    timeline: day.timeline,
  });
});

/**
 * GET /api/master/week?date=YYYY-MM-DD — «Неделя» (страница 37).
 * Неделя — понедельник–воскресенье, в которую попадает `date`.
 */
router.get('/week', (req, res) => {
  const input = new Validator(req.query).date('date', { required: false }).done();
  const settings = db.settings();
  const anchor = input.date || utcToZoned(new Date(), settings.timezone).date;
  const monday = addDays(anchor, -(weekdayOfDate(anchor) - 1));

  const days = [];
  let appointmentsTotal = 0;
  let busyTotal = 0;
  let workTotal = 0;
  let freeWindowsTotal = 0;

  for (let i = 0; i < 7; i += 1) {
    const date = addDays(monday, i);
    const day = dayTimeline(req.master.id, date, settings);
    const visits = day.visits.filter((v) => ACTIVE_STATUSES.includes(v.status));

    appointmentsTotal += visits.length;
    busyTotal += day.busyMin;
    workTotal += day.workMin;
    freeWindowsTotal += day.worksToday ? day.freeWindows : 0;

    days.push({
      date,
      weekday: WEEKDAY_TITLES[i],
      works: day.worksToday,
      appointments_count: visits.length,
      busy_min: day.busyMin,
      free_min: day.freeMin,
      visits: visits.map((row) => ({
        appointment_id: row.id,
        starts_at: presentInstant(row.starts_at_utc, settings.timezone),
        client_name: row.client_name,
        status: row.status,
        status_label: STATUS_LABELS[row.status],
      })),
    });
  }

  res.json({
    week_start: monday,
    week_end: addDays(monday, 6),
    timezone: settings.timezone,
    summary: {
      appointments_count: appointmentsTotal,
      busy_min: busyTotal,
      work_min: workTotal,
      // «загрузка 72%» со страницы 37: занятое время от рабочего.
      load_percent: workTotal > 0 ? Math.round((busyTotal / workTotal) * 100) : 0,
      free_windows: freeWindowsTotal,
    },
    days,
  });
});

/** GET /api/master/appointments/:id — детали своего визита (страница 38). */
router.get('/appointments/:id', (req, res) => {
  const id = requireIdParam(req.params.id);
  const settings = db.settings();

  const row = db.one(
    `SELECT a.id, a.client_user_id, a.master_id, a.starts_at_utc, a.ends_at_utc,
            a.service_duration_min, a.total_price_kopecks, a.status, a.client_comment,
            a.cancel_reason, a.reschedule_count, a.created_at_utc,
            m.first_name AS master_first_name, m.last_name AS master_last_name,
            u.name AS client_name, u.phone AS client_phone
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
       JOIN users u ON u.id = a.client_user_id
      WHERE a.id = ? AND a.master_id = ?`,
    [id, req.master.id],
  );
  // Чужой визит и несуществующий отвечают одинаково.
  if (!row) throw notFound('Запись не найдена');

  const stats = db.one(
    `SELECT COUNT(*) FILTER (WHERE status = 'completed') AS visits,
            COUNT(*) FILTER (WHERE status = 'no_show')   AS no_shows
       FROM appointments WHERE master_id = ? AND client_user_id = ?`,
    [req.master.id, row.client_user_id],
  );

  res.json({
    appointment: appointmentMasterView(row, fetchServices(id), {
      timezone: settings.timezone,
      clientStats: { visits: stats.visits, no_shows: stats.no_shows },
    }),
  });
});

/**
 * POST /api/master/appointments/:id/status — «Клиент пришёл», «Не пришёл»,
 * «Завершён» (страница 38).
 *
 * Своего SQL здесь нет: статус меняет та же changeAppointmentStatus, что и в
 * админском разделе. Роль лишь сужает список статусов и запирает мастера на
 * своих визитах — отмены среди доступных значений нет.
 */
router.post('/appointments/:id/status', (req, res) => {
  const id = requireIdParam(req.params.id);
  const { status } = changeAppointmentStatus(req.user, id, req.body,
    { masterId: req.master.id });

  res.json({ ok: true, id, status });
});

/**
 * GET /api/master/clients — «Мои клиенты» (страница 40).
 * Только те, кто записывался к этому мастеру. `?q=` — поиск по имени,
 * `?filter=regular|upcoming`.
 */
router.get('/clients', (req, res) => {
  const input = new Validator(req.query)
    .string('q', { required: false, min: 2, max: 100 })
    .enum('filter', ['all', 'regular', 'upcoming'], { required: false })
    .int('limit', { required: false, min: 1, max: 100 })
    .int('offset', { required: false, min: 0 })
    .done();

  const settings = db.settings();
  const limit = input.limit || 50;
  const offset = input.offset || 0;
  const filter = input.filter || 'all';
  const now = nowUtc();

  const where = ['a.master_id = ?'];
  const params = [req.master.id];
  if (input.q) {
    // Кириллицу LIKE без ICU сравнивает с учётом регистра, поэтому
    // подставляем три варианта написания — как в админском поиске.
    const lower = input.q.toLocaleLowerCase('ru-RU');
    const title = lower.replace(/(^|[\s-])(\p{L})/gu,
      (_, sep, ch) => sep + ch.toLocaleUpperCase('ru-RU'));
    const variants = [...new Set([input.q, lower, title])];
    where.push(`(${variants.map(() => 'u.name LIKE ?').join(' OR ')})`);
    params.push(...variants.map((v) => `%${v.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` ));
  }

  const having = [];
  if (filter === 'regular') having.push('visits_count >= 3');
  if (filter === 'upcoming') having.push('next_visit_at_utc IS NOT NULL');

  const sql = `
    SELECT u.id, u.name, u.phone,
           COUNT(*) FILTER (WHERE a.status = 'completed') AS visits_count,
           COUNT(*) FILTER (WHERE a.status = 'no_show')   AS no_show_count_with_me,
           MAX(CASE WHEN a.status = 'completed' THEN a.starts_at_utc END) AS last_visit_at_utc,
           MIN(CASE WHEN a.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
                     AND a.starts_at_utc > ? THEN a.starts_at_utc END) AS next_visit_at_utc
      FROM appointments a
      JOIN users u ON u.id = a.client_user_id
     WHERE ${where.join(' AND ')}
     GROUP BY u.id, u.name, u.phone
     ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}`;

  const selectParams = [...ACTIVE_STATUSES, now, ...params];
  const total = db.all(sql, selectParams).length;
  const rows = db.all(
    `${sql} ORDER BY (next_visit_at_utc IS NULL), next_visit_at_utc,
                     last_visit_at_utc DESC, u.name
      LIMIT ? OFFSET ?`,
    [...selectParams, limit, offset],
  );

  res.json({
    total,
    limit,
    offset,
    filter,
    clients: rows.map((row) => masterClientView(row, { timezone: settings.timezone })),
  });
});

/**
 * POST /api/master/time-blocks — «Заблокировать время» (страница 39).
 *
 * Блокируется только своё время: master_id берётся из аккаунта. Горизонт
 * действует — страница говорит «не дальше чем на 3 месяца вперёд». Если на
 * интервале есть активный визит, блокировка отклоняется: «сначала запросите
 * отмену визита».
 */
router.post('/time-blocks', (req, res) => {
  res.status(201).json({
    time_block: createTimeBlock(req.user, req.master.id, req.body, { enforceHorizon: true }),
  });
});

/** DELETE /api/master/time-blocks/:blockId — снять свою блокировку (страница 36). */
router.delete('/time-blocks/:blockId', (req, res) => {
  const blockId = requireIdParam(req.params.blockId, 'block_id');
  deleteTimeBlock(req.master.id, blockId);
  res.json({ ok: true });
});

/** GET /api/master/time-blocks?date_from=&date_to= — свои блокировки. */
router.get('/time-blocks', (req, res) => {
  const input = new Validator(req.query)
    .date('date_from', { required: false })
    .date('date_to', { required: false })
    .done();

  const settings = db.settings();
  const from = input.date_from || utcToZoned(new Date(), settings.timezone).date;
  const to = input.date_to || bookingHorizonDate(settings);

  const blocks = listTimeBlocks(
    req.master.id,
    toUtcIso(zonedToUtc(from, 0, settings.timezone)),
    toUtcIso(zonedToUtc(addDays(to, 1), 0, settings.timezone)),
  );

  res.json({
    date_from: from,
    date_to: to,
    time_blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      type_label: BLOCK_LABELS[b.type],
      starts_at: presentInstant(b.starts_at_utc, settings.timezone),
      ends_at: presentInstant(b.ends_at_utc, settings.timezone),
      comment: b.comment,
    })),
  });
});

module.exports = router;
