'use strict';

/**
 * Экран 10 «Кабинет — Перенос записи». Структура, тексты и порядок блоков —
 * из «10. Кабинет - Перенос записи.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /appointments/:id` (что переносим и можно ли вообще) и
 * `GET /masters/:id/availability?date=&service_ids=` (свободное начало у того
 * же мастера на выбранный день). Выбор слота удерживает его —
 * `POST /holds`, — а «Перенести запись» →
 * `POST /appointments/:id/reschedule` со `starts_at` и `hold_token`.
 *
 * Сверх строки карты — `GET /settings`: выходные студии и горизонт записи,
 * по ним в календаре гаснут дни, на которые всё равно нет слотов.
 *
 * Лимит переносов и окно берутся из ответа API (`can_reschedule`,
 * `reschedules_left`, `cancel_window_hours`), а не зашиты в текст.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import {
  getAppointment, getAvailability, holdSlot, rescheduleAppointment, getSettings,
} from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, fillEmpty, showError, pageFailure,
  dayDisplay, dateDisplay, minutesLong,
} from './ui.js';
import { handledAsUnauthorized, appointmentIdFromUrl } from './account-shell.js';

/** Куда уходим после успешного переноса — в кабинет, как в прототипе. */
const AFTER_RESCHEDULE_PAGE = 'account.html';

/** Экран 9: та же запись, откуда сюда пришли. */
const DETAILS_PAGE = 'appointment.html';

/** Статусы живой записи — те же, что считает активными API. */
const ACTIVE_STATUSES = ['pending', 'confirmed'];

/** Части дня: до 12 — утро, до 17 — день, дальше вечер. */
const DAY_PARTS = [
  { title: 'Утро', until: 12 },
  { title: 'День', until: 17 },
  { title: 'Вечер', until: 24 },
];

/** Что переносим и чем ограничены. */
let appointment = null;
let settings = null;

/** Открытый месяц календаря (`YYYY-MM`) и выбранный день (`YYYY-MM-DD`). */
let viewMonth = null;
let selectedDate = null;

/** Выбранный слот и удержание под него. */
let selected = null;
let hold = null;
let holdTimer = null;

/* ------------------------------------------------------------- даты */

/** Сегодня в поясе студии: пояс приходит в ответе о записи. */
function salonToday(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * «Октябрь 2026» — заголовок календаря. Месяц и год складываются вручную:
 * `Intl` с обоими полями сразу даёт «октябрь 2026 г.», и «г.» в заголовке
 * прототипа нет.
 */
const MONTH_FMT = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long' });

const monthTitle = (date) => `${MONTH_FMT.format(date)} ${date.getUTCFullYear()}`;

/** День недели по ISO: 1 — понедельник, 7 — воскресенье (так же нумерует API). */
const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** `YYYY-MM` плюс/минус месяц. */
function shiftMonth(month, step) {
  const [year, index] = month.split('-').map(Number);
  const moved = new Date(Date.UTC(year, index - 1 + step, 1));
  return moved.toISOString().slice(0, 7);
}

/**
 * Последний день, на который вообще можно записаться: горизонт из настроек.
 * Настройки не пришли — ограничения в календаре нет, и дальний день упрётся
 * в ответ API (400 «Дата за горизонтом записи») с текстом на экране.
 */
function horizonDate() {
  if (!settings) return null;
  const today = new Date(`${salonToday(appointment.starts_at.timezone)}T00:00:00Z`);
  today.setUTCMonth(today.getUTCMonth() + settings.booking_horizon_months);
  return today.toISOString().slice(0, 10);
}

/** Выходной студии: по `hours` из настроек (вт-сб, п. 14 карты экранов). */
function isClosed(date) {
  if (!settings) return false;
  const row = settings.hours.find((item) => item.weekday === isoWeekday(date));
  return Boolean(row && row.is_closed);
}

/* --------------------------------------------------------- календарь */

function renderCalendar() {
  const grid = $('[data-cal="grid"]');
  const [year, month] = viewMonth.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = salonToday(appointment.starts_at.timezone);
  const horizon = horizonDate();

  $('[data-cal="month"]').textContent = monthTitle(first);

  const cells = [];
  // Пустые клетки до первого числа: неделя начинается с понедельника.
  for (let i = 0; i < (first.getUTCDay() + 6) % 7; i += 1) {
    const blank = document.createElement('span');
    blank.className = 'cal__cell cal__cell--blank';
    cells.push(blank);
  }

  for (let day = 1; day <= days; day += 1) {
    const date = `${viewMonth}-${String(day).padStart(2, '0')}`;
    const node = tpl('tpl-cal-cell').cloneNode(true);
    $('.cal__num', node).textContent = day;

    const past = date < today;
    const beyond = horizon !== null && date > horizon;
    const closed = isClosed(date);

    if (past) node.classList.add('cal__cell--past');
    if (closed) node.classList.add('cal__cell--closed');
    if (beyond) node.classList.add('cal__cell--beyond');
    if (date === today) node.classList.add('cal__cell--today');
    // День, на который запись стоит сейчас: его видно, но выбрать его нельзя —
    // перенос на то же время API отклоняет.
    if (date === appointment.starts_at.local_date) node.classList.add('cal__cell--current');
    if (date === selectedDate) node.classList.add('cal__cell--selected');

    if (past || beyond || closed) {
      node.disabled = true;
      node.setAttribute('aria-label', `${dateDisplay(date)} — ${closed ? 'студия закрыта' : 'недоступно'}`);
    } else {
      node.setAttribute('aria-label', dateDisplay(date));
      node.setAttribute('aria-pressed', String(date === selectedDate));
      node.addEventListener('click', () => selectDate(date));
    }
    cells.push(node);
  }

  grid.replaceChildren(...cells);

  const prev = $('[data-cal="prev"]');
  const next = $('[data-cal="next"]');
  prev.disabled = viewMonth <= today.slice(0, 7);
  next.disabled = horizon !== null && viewMonth >= horizon.slice(0, 7);
  refreshIcons();
}

function setupCalendarNav() {
  $('[data-cal="prev"]').addEventListener('click', () => {
    viewMonth = shiftMonth(viewMonth, -1);
    renderCalendar();
  });
  $('[data-cal="next"]').addEventListener('click', () => {
    viewMonth = shiftMonth(viewMonth, 1);
    renderCalendar();
  });
}

/* ------------------------------------------------------------- слоты */

/** К какой части дня относится слот. */
const partOf = (localTime) => DAY_PARTS.find((part) => Number(localTime.slice(0, 2)) < part.until);

function slotButton(slot) {
  const node = tpl('tpl-slot').cloneNode(true);
  node.textContent = slot.local_time;
  node.setAttribute('aria-label', `${slot.local_time}, свободно`);
  node.addEventListener('click', () => chooseSlot(slot, node));
  return node;
}

/**
 * Слот, на котором запись стоит сейчас. В списке свободных его нет — он занят
 * этой же записью, — поэтому метка «Текущая запись» из прототипа рисуется
 * отдельной нажатой-накрест кнопкой: выбрать то же время API не даёт.
 */
function currentSlotButton() {
  const node = tpl('tpl-slot').cloneNode(true);
  node.classList.add('slots__slot--current');
  node.disabled = true;
  node.textContent = appointment.starts_at.local_time;
  node.setAttribute('aria-label', `${appointment.starts_at.local_time}, текущая запись`);
  const tag = document.createElement('span');
  tag.className = 'slots__tag';
  tag.textContent = 'Текущая запись';
  node.append(tag);
  return node;
}

function renderSlots(answer) {
  const list = listNode('slots');
  const isApptDay = selectedDate === appointment.starts_at.local_date;

  const rows = answer.slots.map((slot) => ({ slot, time: slot.local_time, current: false }));
  if (isApptDay) {
    rows.push({ slot: appointment.starts_at, time: appointment.starts_at.local_time, current: true });
    rows.sort((a, b) => a.time.localeCompare(b.time));
  }

  if (rows.length === 0) {
    fillEmpty(list, 'В этот день у мастера нет окна нужной длины. Выберите другой день.');
    return;
  }

  const parts = [];
  for (const part of DAY_PARTS) {
    const own = rows.filter((row) => partOf(row.time) === part);
    if (own.length === 0) continue;
    const node = tpl('tpl-slot-part').cloneNode(true);
    $('.slots__part-title', node).textContent = part.title;
    $('.slots__grid', node).replaceChildren(
      ...own.map((row) => (row.current ? currentSlotButton() : slotButton(row.slot))),
    );
    parts.push(node);
  }
  fill(list, parts);
}

/** Выбор дня: грузим его слоты и снимаем выбор, который к нему не относится. */
async function selectDate(date) {
  selectedDate = date;
  clearSelection();
  renderCalendar();
  await loadSlots();
}

async function loadSlots() {
  const list = listNode('slots');
  const box = $('[data-error="slots"]');
  const need = $('[data-slots="need"]');

  $('[data-slots="day"]').textContent = dayDisplay(selectedDate);
  list.replaceChildren();
  list.setAttribute('aria-busy', 'true');
  box.hidden = true;

  const asked = selectedDate;
  try {
    const answer = await getAvailability(appointment.master.id, {
      date: selectedDate,
      serviceIds: appointment.services.map((service) => service.service_id),
    });
    if (asked !== selectedDate) return; // человек успел переключить день
    $('[data-slots="need-text"]').textContent =
      `Нужно ${minutesLong(answer.service_duration_min)} подряд — показываем только подходящее начало`;
    need.hidden = false;
    renderSlots(answer);
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    need.hidden = true;
    showError(box, list, err, loadSlots);
  }
}

/* --------------------------------------------------- удержание слота */

/** Остаток удержания: «6:59». */
const leftDisplay = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function stopHoldTimer() {
  if (holdTimer !== null) window.clearInterval(holdTimer);
  holdTimer = null;
}

/** Выбор снят: ни слота, ни удержания, кнопка переноса недоступна. */
function clearSelection() {
  selected = null;
  hold = null;
  stopHoldTimer();
  $('[data-resched="new"]').textContent = 'Станет: выберите новое время';
  $('[data-resched="hold"]').hidden = true;
  $('[data-action="reschedule"]').disabled = true;
  for (const node of document.querySelectorAll('.slots__slot--picked')) {
    node.classList.remove('slots__slot--picked');
    node.setAttribute('aria-pressed', 'false');
  }
}

/**
 * Отсчёт удержания. Истекло — слот снова свободен для всех, поэтому выбор
 * снимаем и перечитываем день: иначе человек нажал бы «Перенести» на время,
 * которое за ним уже не держится.
 */
function startHoldTimer(expiresAt) {
  const node = $('[data-resched="hold"]');
  node.hidden = false;
  node.classList.remove('rfoot__hold--over');

  const tick = () => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      stopHoldTimer();
      clearSelection();
      node.textContent = 'Время больше не держится за вами — выберите слот заново.';
      node.classList.add('rfoot__hold--over');
      node.hidden = false;
      loadSlots();
      return;
    }
    node.textContent = `Время держится за вами ещё ${leftDisplay(left)}`;
  };

  tick();
  stopHoldTimer();
  holdTimer = window.setInterval(tick, 1000);
}

/**
 * Выбор слота сразу удерживает его (`POST /holds`): пока человек смотрит на
 * экран, время не должно уйти другому. В прототипе удержания нет вовсе.
 */
async function chooseSlot(slot, node) {
  const box = $('[data-error="slots"]');
  clearSelection();
  box.hidden = true;
  node.classList.add('slots__slot--picked');
  node.setAttribute('aria-pressed', 'true');

  try {
    const answer = await holdSlot({
      masterId: appointment.master.id,
      serviceIds: appointment.services.map((service) => service.service_id),
      startsAt: slot.at_utc,
    });
    selected = slot;
    hold = answer.hold;
    $('[data-resched="new"]').textContent =
      `Станет: ${dateDisplay(slot.local_date)}, ${slot.local_time}`;
    $('[data-action="reschedule"]').disabled = false;
    startHoldTimer(Date.now() + answer.expires_in_sec * 1000);
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    clearSelection();
    // Время успели занять, пока человек выбирал: сначала перечитываем день
    // (список свободного уже другой), и только потом пишем сообщение — иначе
    // загрузка сама спрятала бы его.
    await loadSlots();
    box.replaceChildren(document.createTextNode(
      `Это время не удалось занять. ${err.message}`,
    ));
    box.hidden = false;
  }
}

/* ------------------------------------------------------------ перенос */

/**
 * Ближайшие свободные начала из `details.nearest_slots` ответа 409.
 *
 * Сервер считает их так, будто переносимой записи уже нет, — поэтому среди
 * них бывают времена, наезжающие на её собственное время. Пока перенос не
 * прошёл, старое время за записью остаётся, и такой слот не удержать:
 * показываем только те, что действительно можно занять.
 */
function usableNearest(slots) {
  const from = new Date(appointment.starts_at.at_utc).getTime();
  const to = new Date(appointment.ends_at.at_utc).getTime();
  const occupied = to - from;
  return slots.filter((slot) => {
    const start = new Date(slot.at_utc).getTime();
    return start + occupied <= from || start >= to;
  });
}

function renderNearest(all) {
  const box = listNode('nearest');
  const slots = Array.isArray(all) ? usableNearest(all) : [];
  if (slots.length === 0) {
    box.hidden = true;
    return;
  }
  const label = document.createElement('span');
  label.className = 'rfoot__nearest-label';
  label.textContent = 'Ближайшее свободное время:';

  const buttons = slots.map((slot) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'slot rfoot__nearest-slot';
    node.textContent = `${dateDisplay(slot.local_date)}, ${slot.local_time}`;
    node.addEventListener('click', async () => {
      box.hidden = true;
      $('[data-error="reschedule"]').hidden = true;
      await selectDate(slot.local_date);
      // Слот из подсказки выбираем сразу: кнопка того же времени уже на экране.
      const same = [...listNode('slots').querySelectorAll('.slots__slot')]
        .find((button) => !button.disabled && button.textContent === slot.local_time);
      if (same) same.click();
    });
    return node;
  });

  box.replaceChildren(label, ...buttons);
  box.hidden = false;
}

function setupReschedule() {
  const button = $('[data-action="reschedule"]');
  const box = $('[data-error="reschedule"]');

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Переносим…';
    box.hidden = true;
    listNode('nearest').hidden = true;
    try {
      await rescheduleAppointment(appointment.id, {
        startsAt: selected.at_utc,
        holdToken: hold ? hold.token : undefined,
      });
      stopHoldTimer();
      window.location.assign(AFTER_RESCHEDULE_PAGE);
    } catch (err) {
      if (handledAsUnauthorized(err)) return;
      button.disabled = false;
      button.textContent = 'Перенести запись';
      // `details` у 409 про занятое время — это список слотов; гнать его
      // через toText() значило бы показать человеку JSON.
      box.replaceChildren(document.createTextNode(`Запись не перенесена. ${err.message}`));
      box.hidden = false;
      renderNearest(err.details && err.details.nearest_slots);
      // Старое время за записью осталось: перенос не прошёл целиком.
      clearSelection();
      loadSlots();
    }
  });
}

/* ----------------------------------------------------------- отрисовка */

/** Шапка: что переносим (состав услуг и мастер не меняются) и прежнее время. */
function renderHead(appt) {
  const services = appt.services.map((service) => service.name).join(', ');
  $('[data-appt="summary"]').textContent =
    `${appt.master.display_name} · ${services} · ${minutesLong(appt.service_duration_min)} `
    + `· ${appt.total_price_display}`;
  $('[data-appt="summary"]').removeAttribute('aria-busy');
  $('[data-appt="current"]').textContent =
    `Текущее время: ${dayDisplay(appt.starts_at.local_date)}, ${appt.starts_at.local_time}`;
  $('[data-appt="old"]').textContent =
    `Было: ${dateDisplay(appt.starts_at.local_date)}, ${appt.starts_at.local_time}`;

  // «Закрыть» и «Отмена» возвращают в ту же запись, откуда сюда пришли.
  for (const node of document.querySelectorAll('[data-link="close"], [data-link="cancel"]')) {
    node.href = `${DETAILS_PAGE}?id=${appt.id}`;
  }
}

/** Экран без данных: календарь и подтверждение убираем, на их месте — текст. */
function failPage(message, retry) {
  // Заглушка в шапке обещала бы данные, которых уже не будет.
  const summary = $('[data-appt="summary"]');
  if (summary.hasAttribute('aria-busy')) {
    summary.textContent = '—';
    summary.removeAttribute('aria-busy');
  }
  pageFailure($('[data-error="appointment"]'), $('[data-resched="body"]'), message, retry);
}

/** Почему перенести нельзя — словами из ответа API, а не из вида экрана. */
function refusalText(appt) {
  // Отменённую и завершённую запись не переносят вовсе — и дело не в окне и
  // не в лимите, а в самом статусе.
  if (!ACTIVE_STATUSES.includes(appt.status)) {
    return `Эту запись перенести нельзя: она ${String(appt.status_label).toLowerCase()}. `
      + 'Запишитесь заново или позвоните студии.';
  }
  if (appt.reschedules_left === 0) {
    return `Эту запись переносить больше нельзя: переносы исчерпаны. `
      + 'Отмените её и запишитесь заново или позвоните студии.';
  }
  if (appt.can_cancel === false && appt.can_reschedule === false) {
    return `Перенос возможен не позднее чем за ${appt.cancel_window_hours} ч до визита — `
      + 'это время уже прошло. Позвоните студии.';
  }
  return `Эту запись перенести нельзя: запись ${String(appt.status_label).toLowerCase()}.`;
}

/* --------------------------------------------------------------- старт */

async function loadAppointment() {
  const id = appointmentIdFromUrl();
  if (id === null) {
    failPage('Непонятно, какую запись переносить: в адресе нет номера записи. '
      + 'Откройте запись из списка в кабинете.');
    return;
  }
  try {
    appointment = await getAppointment(id);
    renderHead(appointment);

    // Переносить нечего — дальше экран не нужен: ни календаря, ни кнопки.
    if (!appointment.can_reschedule) {
      failPage(refusalText(appointment));
      return;
    }

    // Начинаем с того дня, на который запись стоит сейчас: человек видит, от
    // чего переносит, и соседние свободные дни того же месяца.
    selectedDate = appointment.starts_at.local_date;
    viewMonth = selectedDate.slice(0, 7);
    setupCalendarNav();
    setupReschedule();
    renderCalendar();
    await loadSlots();
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    if (err.status === 404) {
      failPage(`Запись №${id} не найдена. Возможно, она удалена или принадлежит другому аккаунту.`);
      return;
    }
    failPage(`Не удалось загрузить запись. ${err.toText ? err.toText() : err.message}`, loadAppointment);
  }
}

/**
 * Настройки студии нужны календарю (выходные и горизонт записи), но экран
 * живёт и без них: без настроек дни не гаснут заранее, а недоступный день
 * скажет об этом ответом API.
 */
async function loadSettings() {
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }
}

async function start() {
  refreshIcons();
  // Настройки — первыми: от них зависят погашенные дни календаря, и второй
  // отрисовки сетки лучше избежать.
  await loadSettings();
  await loadAppointment();
}

window.addEventListener('load', refreshIcons);
start();
