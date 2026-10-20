'use strict';

/**
 * Файл календаря (`.ics`) из ответа API — решение 11 карты экранов: эндпоинта
 * выдачи `.ics` в API нет, а начало, конец, мастер и состав услуг в ответе
 * `GET /appointments/:id` есть, поэтому файл собирается в браузере.
 *
 * Модуль общий для экрана 9 «Детали записи» и экрана 5 «Запись создана»:
 * кнопка «Добавить в календарь» есть на обоих, и собирать один и тот же файл
 * дважды незачем. Запросов здесь нет (правило 3) — на вход приходит уже
 * полученная запись.
 */

/** Экранирование по RFC 5545: запятая, точка с запятой, обратный слеш, перевод строки. */
const icsText = (value) => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/([,;])/g, '\\$1')
  .replace(/\r?\n/g, '\\n');

/** `2026-10-23T11:00:00Z` → `20261023T110000Z`. */
const icsStamp = (utcIso) => utcIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Перенос длинных строк по правилу формата: не длиннее 75 октетов, продолжение
 * начинается с пробела. Считаем в октетах, а не в символах: кириллица в UTF-8
 * занимает по два байта, и строка «SUMMARY:Маникюр…» выходит за предел
 * заметно раньше, чем кажется по длине текста.
 */
function icsFold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const decoder = new TextDecoder();
  const parts = [];
  let from = 0;
  while (from < bytes.length) {
    // Первая строка — 75 октетов, продолжения на один короче: пробел в начале
    // тоже считается.
    let take = Math.min(from === 0 ? 75 : 74, bytes.length - from);
    // Не разрезаем символ посередине: продолжающие байты UTF-8 — 10xxxxxx.
    while (take > 1 && (bytes[from + take] & 0xC0) === 0x80) take -= 1;
    parts.push((from === 0 ? '' : ' ') + decoder.decode(bytes.subarray(from, from + take)));
    from += take;
  }
  return parts.join('\r\n');
}

/**
 * Запись одним событием календаря.
 *
 * @param {object} appt ответ `GET /appointments/:id` (или `POST /appointments`)
 * @param {{address?: string|null, durationText: string}} opts адрес студии из
 *        `GET /settings` (не пришёл — строки LOCATION просто не будет) и
 *        длительность визита словами
 * @returns {Blob} файл `text/calendar`
 */
export function icsFile(appt, { address = null, durationText } = {}) {
  const services = appt.services.map((service) => service.name).join(', ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lada//appointment//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:appointment-${appt.id}@lada`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(appt.starts_at.at_utc)}`,
    `DTEND:${icsStamp(appt.ends_at.at_utc)}`,
    `SUMMARY:${icsText(`Лада: ${services}`)}`,
    `DESCRIPTION:${icsText(`Мастер ${appt.master.display_name}. `
      + `${appt.total_price_display}, ${durationText}.`)}`,
    ...(address ? [`LOCATION:${icsText(address)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // CRLF — разделитель строк в формате; текстовый тип, чтобы файл открывался
  // календарём, а не скачивался «чем-то непонятным».
  const body = lines.map(icsFold).join('\r\n');
  return new Blob([`${body}\r\n`], { type: 'text/calendar;charset=utf-8' });
}

/**
 * «Добавить в календарь» — обычная ссылка на файл, собранный в браузере.
 * Вызывается повторно, когда к записи добавился адрес студии: прежний объект
 * в памяти браузера при этом освобождается.
 */
export function setupIcsLink(link, appt, opts) {
  if (!link) return;
  if (link.href) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(icsFile(appt, opts));
  link.download = `lada-${appt.starts_at.local_date}.ics`;
  link.classList.remove('is-disabled');
  link.removeAttribute('aria-disabled');
}
