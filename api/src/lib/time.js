'use strict';

// Всё время в системе хранится и принимается в UTC.
// В пояс салона переводим только при отображении.

const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Текущий момент в каноническом виде `YYYY-MM-DDTHH:MM:SSZ`. */
function nowUtc() {
  return toUtcIso(new Date());
}

/** Date -> `YYYY-MM-DDTHH:MM:SSZ` (без миллисекунд, чтобы строки сравнивались лексикографически). */
function toUtcIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Разбор UTC-метки. Возвращает Date либо null, если формат не тот. */
function parseUtcIso(value) {
  if (typeof value !== 'string' || !UTC_ISO_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Проверка календарной даты `YYYY-MM-DD` (включая существование дня в месяце). */
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function zonedParts(date, timeZone) {
  const out = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(date)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

/** Смещение пояса в миллисекундах для конкретного момента (учитывает переход на летнее время). */
function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - date.getTime();
}

/**
 * Локальное время салона -> UTC.
 * @param {string} dateStr `YYYY-MM-DD` в поясе салона
 * @param {number} minutes минуты от полуночи (допускается 1440 как «конец суток»)
 */
function zonedToUtc(dateStr, minutes, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d) + minutes * 60000;
  // Два прохода: первое смещение берём по приблизительному моменту, затем уточняем.
  let utcMs = naive - zoneOffsetMs(new Date(naive), timeZone);
  utcMs = naive - zoneOffsetMs(new Date(utcMs), timeZone);
  return new Date(utcMs);
}

/** UTC -> { date: 'YYYY-MM-DD', minutes, weekday (ISO 1..7) } в поясе салона. */
function utcToZoned(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  // День недели считаем по «локальным» Y-M-D, подставленным как UTC.
  const jsDay = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return {
    date: dateStr,
    minutes: p.hour * 60 + p.minute,
    weekday: jsDay === 0 ? 7 : jsDay,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** ISO-день недели (1 = Пн) для календарной даты. */
function weekdayOfDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Прибавить дни к календарной дате. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Прибавить месяцы к календарной дате (для горизонта записи). */
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1 + months, d));
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

const DISPLAY_CACHE = new Map();

/** Человекочитаемое время в поясе салона — только для вывода. */
function formatForDisplay(utcIso, timeZone) {
  let fmt = DISPLAY_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    DISPLAY_CACHE.set(timeZone, fmt);
  }
  return fmt.format(new Date(utcIso));
}

/**
 * Представление момента для клиента: сам UTC + разложенное локальное время салона.
 * Клиент никогда не получает «голую» локальную строку без указания пояса.
 */
function presentInstant(utcIso, timeZone) {
  const zoned = utcToZoned(new Date(utcIso), timeZone);
  return {
    at_utc: utcIso,
    local_date: zoned.date,
    local_time: zoned.time,
    timezone: timeZone,
  };
}

function addMinutesIso(utcIso, minutes) {
  return toUtcIso(new Date(new Date(utcIso).getTime() + minutes * 60000));
}

function diffMinutes(laterIso, earlierIso) {
  return (new Date(laterIso).getTime() - new Date(earlierIso).getTime()) / 60000;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  nowUtc,
  toUtcIso,
  parseUtcIso,
  isValidDate,
  isValidTimeZone,
  zonedToUtc,
  utcToZoned,
  weekdayOfDate,
  addDays,
  addMonths,
  addMinutesIso,
  diffMinutes,
  formatForDisplay,
  presentInstant,
};
