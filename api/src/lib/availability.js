'use strict';

// Расчёт свободного времени мастера.
// Таблицы заранее нарезанных слотов нет: всё считается на лету из
// графика работы, исключений, записей, блокировок и действующих удержаний.

const db = require('./db');
const { badRequest, conflict, notFound } = require('./errors');
const {
  nowUtc, toUtcIso, zonedToUtc, utcToZoned, weekdayOfDate, addMonths,
} = require('./time');

const ACTIVE_STATUSES = ['pending', 'confirmed'];

/**
 * Физически удаляет истёкшие удержания слотов.
 * Вызывается перед каждым расчётом доступности и перед созданием/переносом записи,
 * поэтому отдельный планировщик не нужен — слот освобождается сам.
 */
function purgeExpiredHolds() {
  return db.run('DELETE FROM slot_holds WHERE expires_at_utc <= ?', [nowUtc()]).changes;
}

/**
 * Загружает услуги по id и считает длительности.
 * Бросает 400, если какой-то услуги нет, она скрыта или удалена.
 */
function loadServices(serviceIds) {
  const placeholders = serviceIds.map(() => '?').join(',');
  const rows = db.all(
    `SELECT id, name, duration_min, buffer_after_min, price_kopecks
       FROM services
      WHERE id IN (${placeholders}) AND is_active = 1`,
    serviceIds,
  );
  if (rows.length !== serviceIds.length) {
    const found = new Set(rows.map((r) => r.id));
    throw badRequest('Некоторые услуги не найдены', {
      service_ids: serviceIds.filter((id) => !found.has(id)),
    });
  }
  const serviceDurationMin = rows.reduce((sum, r) => sum + r.duration_min, 0);
  const occupiedMin = rows.reduce((sum, r) => sum + r.duration_min + r.buffer_after_min, 0);
  const totalPriceKopecks = rows.reduce((sum, r) => sum + r.price_kopecks, 0);
  return { rows, serviceDurationMin, occupiedMin, totalPriceKopecks };
}

/** Проверяет, что мастер существует, активен и выполняет все выбранные услуги. */
function assertMasterPerformsServices(masterId, serviceIds) {
  const master = db.one('SELECT id FROM masters WHERE id = ? AND is_active = 1', [masterId]);
  if (!master) throw notFound('Мастер не найден');

  const placeholders = serviceIds.map(() => '?').join(',');
  const linked = db.all(
    `SELECT service_id FROM master_services
      WHERE master_id = ? AND service_id IN (${placeholders})`,
    [masterId, ...serviceIds],
  );
  if (linked.length !== serviceIds.length) {
    const can = new Set(linked.map((r) => r.service_id));
    // Клиент увидит мастера только если тот выполняет ВСЕ выбранные услуги визита.
    throw conflict('Мастер не выполняет все выбранные услуги', {
      service_ids: serviceIds.filter((id) => !can.has(id)),
    });
  }
}

function subtractBreak(windows, breakStart, breakEnd) {
  if (breakStart === null || breakEnd === null) return windows;
  const out = [];
  for (const w of windows) {
    if (breakEnd <= w.startMin || breakStart >= w.endMin) {
      out.push(w);
      continue;
    }
    if (breakStart > w.startMin) out.push({ startMin: w.startMin, endMin: breakStart });
    if (breakEnd < w.endMin) out.push({ startMin: breakEnd, endMin: w.endMin });
  }
  return out;
}

function intersect(windows, limitStart, limitEnd) {
  const out = [];
  for (const w of windows) {
    const startMin = Math.max(w.startMin, limitStart);
    const endMin = Math.min(w.endMin, limitEnd);
    if (endMin > startMin) out.push({ startMin, endMin });
  }
  return out;
}

/**
 * Рабочие окна мастера на дату (локальные минуты в поясе салона).
 * Порядок: исключения мастера -> регулярный график -> перерыв -> часы работы студии.
 */
function workWindowsForDate(masterId, date) {
  const exceptions = db.all(
    `SELECT type, start_min, end_min FROM master_schedule_exceptions
      WHERE master_id = ? AND start_date <= ? AND end_date >= ?`,
    [masterId, date, date],
  );

  // Отпуск, больничный и разовый выходной закрывают день целиком.
  if (exceptions.some((e) => e.type === 'vacation' || e.type === 'sick_leave' || e.type === 'day_off')) {
    return [];
  }

  const override = exceptions.find((e) => e.type === 'hours_override');
  let windows;
  let breakStart = null;
  let breakEnd = null;

  if (override) {
    windows = [{ startMin: override.start_min, endMin: override.end_min }];
  } else {
    const regular = db.one(
      `SELECT is_day_off, start_min, end_min, break_start_min, break_end_min
         FROM master_work_schedule WHERE master_id = ? AND weekday = ?`,
      [masterId, weekdayOfDate(date)],
    );
    if (!regular || regular.is_day_off === 1) return [];
    windows = [{ startMin: regular.start_min, endMin: regular.end_min }];
    breakStart = regular.break_start_min;
    breakEnd = regular.break_end_min;
  }

  windows = subtractBreak(windows, breakStart, breakEnd);
  if (windows.length === 0) return [];

  // Границы студии: особый день перекрывает обычное расписание.
  const dayOverride = db.one(
    'SELECT is_closed, start_min, end_min FROM salon_day_overrides WHERE date = ?',
    [date],
  );
  const salon = dayOverride
    || db.one('SELECT is_closed, start_min, end_min FROM salon_hours WHERE weekday = ?',
      [weekdayOfDate(date)]);

  if (!salon || salon.is_closed === 1) return [];
  return intersect(windows, salon.start_min, salon.end_min);
}

/**
 * Занятые интервалы мастера в диапазоне [fromUtc, toUtc).
 * @param {object} opts
 *   excludeAppointmentId — переносимая запись не блокирует сама себя
 *   holdOwnerUserId      — своё удержание не мешает его владельцу завершить оформление
 *   excludeHoldToken     — предъявленное удержание не считается препятствием
 */
function busyIntervals(masterId, fromUtc, toUtc, opts = {}) {
  const { excludeAppointmentId = null, holdOwnerUserId = null, excludeHoldToken = null } = opts;
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(',');

  const appointments = db.all(
    `SELECT starts_at_utc AS s, ends_at_utc AS e FROM appointments
      WHERE master_id = ? AND status IN (${statusPlaceholders})
        AND starts_at_utc < ? AND ends_at_utc > ?
        AND (? IS NULL OR id <> ?)`,
    [masterId, ...ACTIVE_STATUSES, toUtc, fromUtc, excludeAppointmentId, excludeAppointmentId],
  );

  const blocks = db.all(
    `SELECT starts_at_utc AS s, ends_at_utc AS e FROM time_blocks
      WHERE master_id = ? AND starts_at_utc < ? AND ends_at_utc > ?`,
    [masterId, toUtc, fromUtc],
  );

  const holds = db.all(
    `SELECT starts_at_utc AS s, ends_at_utc AS e FROM slot_holds
      WHERE master_id = ? AND expires_at_utc > ?
        AND starts_at_utc < ? AND ends_at_utc > ?
        AND (? IS NULL OR user_id <> ?)
        AND (? IS NULL OR token <> ?)`,
    [masterId, nowUtc(), toUtc, fromUtc,
      holdOwnerUserId, holdOwnerUserId, excludeHoldToken, excludeHoldToken],
  );

  return [...appointments, ...blocks, ...holds].map((r) => ({
    start: new Date(r.s).getTime(),
    end: new Date(r.e).getTime(),
  }));
}

const overlapsBusy = (startMs, endMs, busy) =>
  busy.some((b) => b.start < endMs && b.end > startMs);

/** Горизонт записи: последняя дата, на которую вообще можно записаться. */
function bookingHorizonDate(settings) {
  const today = utcToZoned(new Date(), settings.timezone).date;
  return addMonths(today, settings.booking_horizon_months);
}

/**
 * Свободное начало визита на дату.
 * @returns {{ slots: string[], occupied_min: number, service_duration_min: number }}
 *          slots — UTC-метки возможного начала
 */
function availableSlots({ masterId, date, serviceIds, settings, holdOwnerUserId = null, excludeAppointmentId = null }) {
  purgeExpiredHolds();

  const { serviceDurationMin, occupiedMin, totalPriceKopecks } = loadServices(serviceIds);
  const windows = workWindowsForDate(masterId, date);
  const result = {
    slots: [],
    service_duration_min: serviceDurationMin,
    occupied_min: occupiedMin,
    total_price_kopecks: totalPriceKopecks,
  };
  if (windows.length === 0) return result;

  const { timezone, slot_step_min: step } = settings;
  const dayStartUtc = zonedToUtc(date, windows[0].startMin, timezone);
  const dayEndUtc = zonedToUtc(date, windows[windows.length - 1].endMin, timezone);
  const busy = busyIntervals(masterId, toUtcIso(dayStartUtc), toUtcIso(dayEndUtc), {
    excludeAppointmentId,
    holdOwnerUserId,
  });

  const nowMs = Date.now();
  for (const w of windows) {
    // Сетка привязана к началу рабочего окна, а не к началу свободного промежутка.
    for (let startMin = w.startMin; startMin + occupiedMin <= w.endMin; startMin += step) {
      const startUtc = zonedToUtc(date, startMin, timezone);
      const startMs = startUtc.getTime();
      const endMs = startMs + occupiedMin * 60000;
      if (startMs <= nowMs) continue;
      if (overlapsBusy(startMs, endMs, busy)) continue;
      result.slots.push(toUtcIso(startUtc));
    }
  }
  return result;
}

/**
 * Проверка конкретного начала визита. Используется при удержании слота,
 * создании записи и переносе — всегда внутри транзакции.
 * Бросает 409, если время не подходит.
 */
function assertSlotBookable({ masterId, startAtUtc, occupiedMin, settings, holdOwnerUserId = null, excludeAppointmentId = null, excludeHoldToken = null }) {
  const startDate = new Date(startAtUtc);
  const startMs = startDate.getTime();
  const endMs = startMs + occupiedMin * 60000;

  if (startMs <= Date.now()) {
    throw conflict('Это время уже прошло');
  }

  const zoned = utcToZoned(startDate, settings.timezone);
  if (zoned.date > bookingHorizonDate(settings)) {
    throw conflict(`Записаться можно не дальше чем на ${settings.booking_horizon_months} мес. вперёд`);
  }

  // Визит не должен выходить за рабочее окно — проверяем окна той локальной даты,
  // в которую попадает начало.
  const windows = workWindowsForDate(masterId, zoned.date);
  const fits = windows.some((w) => {
    const wStart = zonedToUtc(zoned.date, w.startMin, settings.timezone).getTime();
    const wEnd = zonedToUtc(zoned.date, w.endMin, settings.timezone).getTime();
    return startMs >= wStart && endMs <= wEnd;
  });
  if (!fits) {
    throw conflict('Мастер не работает в это время');
  }

  // Начало должно попадать в сетку слотов — иначе клиент может «втиснуться» мимо шага.
  const onGrid = windows.some((w) => {
    const wStart = zonedToUtc(zoned.date, w.startMin, settings.timezone).getTime();
    if (startMs < wStart) return false;
    const offsetMin = (startMs - wStart) / 60000;
    return Number.isInteger(offsetMin) && offsetMin % settings.slot_step_min === 0;
  });
  if (!onGrid) {
    throw conflict(`Начало визита должно попадать в сетку ${settings.slot_step_min} мин`);
  }

  const busy = busyIntervals(masterId, toUtcIso(startDate), toUtcIso(new Date(endMs)), {
    excludeAppointmentId,
    holdOwnerUserId,
    excludeHoldToken,
  });
  if (overlapsBusy(startMs, endMs, busy)) {
    throw conflict('Это время уже занято');
  }

  return { endAtUtc: toUtcIso(new Date(endMs)) };
}

module.exports = {
  ACTIVE_STATUSES,
  purgeExpiredHolds,
  loadServices,
  assertMasterPerformsServices,
  workWindowsForDate,
  busyIntervals,
  availableSlots,
  assertSlotBookable,
  bookingHorizonDate,
};
