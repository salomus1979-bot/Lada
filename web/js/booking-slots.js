'use strict';

/**
 * Календарь, слоты и удержание слота — общая механика шага 3 и экрана 6
 * «Время занято». Оба экрана выбирают время одинаково, и оба держат его за
 * человеком, поэтому логика здесь одна, а разметка и раскладка — своя у
 * каждой страницы.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По карте
 * экранов: `GET /masters/:id/availability?date=&service_ids=` (свободное
 * начало визита на дату), `GET /settings` (`slot_step_min` и
 * `booking_horizon_months` приходят от вызывающего), `POST /holds` и
 * `DELETE /holds/:token`.
 *
 * Разметка обеих страниц договаривается об одних и тех же атрибутах:
 *   [data-cal="grid"|"month"|"prev"|"next"] — календарь месяца;
 *   [data-list="slots"], [data-slots="day"|"need"|"need-text"] — слоты дня;
 *   [data-error="slots"] — ошибка загрузки слотов (правило 7);
 *   [data-hold] — остаток удержания (решение 8 карты экранов);
 *   [data-action="nearest"] — «Ближайшая свободная дата» (их может быть
 *     несколько: в карточке календаря и в блоке «нет окна»);
 *   шаблоны tpl-cal-cell, tpl-slot, tpl-slot-part.
 *
 * Режим «любой свободный мастер» (п. 16 карты): в API его нет, поэтому
 * доступность спрашивается у каждого подходящего мастера, а слоты
 * объединяются по времени. У выбранного слота запоминается конкретный
 * мастер — его и получает `POST /holds`, и потом `POST /appointments`.
 */

import { getAvailability, holdSlot, releaseHold } from './api.js';
import { setSlot, clearSlot } from './store.js';
import {
  $, listNode, tpl, refreshIcons, fill, fillEmpty, showError,
  dateDisplay, dayDisplay, minutesLong,
} from './ui.js';
import { salonToday, startHoldTimer, authHref, PAGES } from './booking-shell.js';

/** Части дня: до 12 — утро, до 17 — день, дальше вечер (как в прототипе). */
const DAY_PARTS = [
  { title: 'Утро', until: 12 },
  { title: 'День', until: 17 },
  { title: 'Вечер', until: 24 },
];

/**
 * Насколько далеко вперёд смотрит «Ближайшая свободная дата».
 *
 * Эндпоинта «ближайший свободный слот» в API нет: сервер считает такие
 * подсказки только в ответе 409. Поэтому дни перебираются запросами, и предел
 * нужен — иначе одна кнопка послала бы столько запросов, сколько месяцев в
 * горизонте записи. Четырнадцать дней — то же окно, которым пользуется сам
 * сервер в `nearestSlots` (api/src/lib/availability.js).
 */
const NEAREST_DAYS = 14;

/**
 * «Октябрь 2026» — заголовок календаря. Месяц и год складываются вручную:
 * `Intl` с обоими полями сразу даёт «октябрь 2026 г.», а «г.» в прототипе нет.
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

/** `YYYY-MM-DD` плюс день. */
function addDay(date, step) {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + step);
  return moved.toISOString().slice(0, 10);
}

/**
 * Выбор времени на странице. Состояние держится в замыкании: на экране есть
 * ровно один календарь и один набор слотов.
 *
 * @param {object} options
 * @param {object} options.settings ответ `GET /settings`
 * @param {number[]} options.serviceIds выбранные услуги
 * @param {number|'any'} options.masterId выбор со шага 2
 * @param {Array<{id: number, display_name: string}>} options.masters подходящие мастера
 * @param {Function} options.onChange вызывается с выбранным слотом или null
 */
export function createPicker({ settings, serviceIds, masterId, masters, onChange }) {
  const timezone = settings.timezone;
  const anyMaster = masterId === 'any';
  /** У кого спрашивать доступность: один мастер или все подходящие. */
  const asked = anyMaster ? masters : masters.filter((master) => master.id === masterId);

  let viewMonth = null;
  let selectedDate = null;
  /** Выбранный слот: `{ at_utc, local_date, local_time, masterId }`. */
  let picked = null;
  /** Удержание под выбранный слот и остановка его таймера. */
  let hold = null;
  let stopTimer = null;
  /** Время, которое перехватили: экран 6 показывает его отдельной пометкой. */
  let takenAt = null;
  /**
   * Что нужно выбрать заново при открытии страницы: слот из store.js и
   * действующее удержание под него. Человек, вернувшийся с шага 4 по
   * «Изменить», должен увидеть своё время уже выбранным, а не искать его.
   */
  let restore = null;
  /** Длительность визита — её считает сервер по составу услуг. */
  let durationMin = null;

  /* ------------------------------------------------------------ границы */

  /**
   * Последний день, на который вообще можно записаться. Настройки приходят
   * снаружи; без горизонта дальний день упёрся бы в ответ API (400 «Дата за
   * горизонтом записи») с текстом на экране.
   */
  function horizonDate() {
    const today = new Date(`${salonToday(timezone)}T00:00:00Z`);
    today.setUTCMonth(today.getUTCMonth() + settings.booking_horizon_months);
    return today.toISOString().slice(0, 10);
  }

  /** Выходной студии: по `hours` из настроек (вт-сб, п. 14 карты экранов). */
  function isClosed(date) {
    if (!Array.isArray(settings.hours)) return false;
    const row = settings.hours.find((item) => item.weekday === isoWeekday(date));
    return Boolean(row && row.is_closed);
  }

  const isPickable = (date) => {
    const today = salonToday(timezone);
    return date >= today && date <= horizonDate() && !isClosed(date);
  };

  /* --------------------------------------------------------- календарь */

  function renderCalendar() {
    const grid = $('[data-cal="grid"]');
    if (!grid) return;
    const [year, month] = viewMonth.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const today = salonToday(timezone);
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
      const beyond = date > horizon;
      const closed = isClosed(date);

      if (past) node.classList.add('cal__cell--past');
      if (closed) node.classList.add('cal__cell--closed');
      if (beyond) node.classList.add('cal__cell--beyond');
      if (date === today) node.classList.add('cal__cell--today');
      if (date === selectedDate) node.classList.add('cal__cell--selected');

      if (past || beyond || closed) {
        node.disabled = true;
        node.setAttribute('aria-label',
          `${dateDisplay(date)} — ${closed ? 'студия закрыта' : 'недоступно'}`);
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
    next.disabled = viewMonth >= horizon.slice(0, 7);
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

  /* ---------------------------------------------------- доступность */

  /**
   * Свободное начало визита на дату. В режиме «любой свободный мастер»
   * спрашиваем каждого подходящего и объединяем ответы по времени: у слота
   * остаётся тот мастер, который в списке API идёт раньше (список
   * отсортирован самим API).
   *
   * @returns {{ slots: Array, durationMin: number, partial: boolean }}
   *          partial — часть мастеров не ответила, слоты показаны не все
   */
  async function loadAvailability(date) {
    const answers = await Promise.allSettled(asked.map(
      (master) => getAvailability(master.id, { date, serviceIds }),
    ));

    const ok = [];
    let firstError = null;
    answers.forEach((answer, index) => {
      if (answer.status === 'fulfilled') ok.push({ master: asked[index], answer: answer.value });
      else if (!firstError) firstError = answer.reason;
    });
    // Не ответил никто — показывать нечего, это ошибка экрана.
    if (ok.length === 0) throw firstError;

    const byTime = new Map();
    for (const { master, answer } of ok) {
      for (const slot of answer.slots) {
        if (byTime.has(slot.at_utc)) continue;
        byTime.set(slot.at_utc, { ...slot, masterId: master.id, masterName: master.display_name });
      }
    }

    return {
      slots: [...byTime.values()].sort((a, b) => a.at_utc.localeCompare(b.at_utc)),
      durationMin: ok[0].answer.service_duration_min,
      partial: ok.length < asked.length,
    };
  }

  /* ------------------------------------------------------------- слоты */

  const partOf = (localTime) => DAY_PARTS.find((part) => Number(localTime.slice(0, 2)) < part.until);

  function slotButton(slot) {
    const node = tpl('tpl-slot').cloneNode(true);
    node.textContent = slot.local_time;
    const who = anyMaster ? `, мастер ${slot.masterName}` : '';
    node.setAttribute('aria-label', `${slot.local_time}, свободно${who}`);
    if (anyMaster) node.title = slot.masterName;
    if (picked && picked.at_utc === slot.at_utc) {
      node.classList.add('slots__slot--picked');
      node.setAttribute('aria-pressed', 'true');
    } else {
      node.setAttribute('aria-pressed', 'false');
    }
    node.addEventListener('click', () => {
      // Повторное нажатие на выбранный слот снимает выбор — но только если
      // время за человеком действительно держится. Если удержания нет
      // (вернулись на шаг, и оно уже снято), нажатие берёт слот заново.
      if (picked && picked.at_utc === slot.at_utc && hold) unpick();
      else choose(slot, node);
    });
    return node;
  }

  /**
   * Слот, который перехватили во время оформления (экран 6). В списке
   * свободных его уже нет — он занят чужой записью, — поэтому пометка
   * «только что занято» из прототипа рисуется отдельной нажатой кнопкой.
   */
  function takenButton(time) {
    const node = tpl('tpl-slot').cloneNode(true);
    node.classList.add('slots__slot--taken');
    node.disabled = true;
    node.textContent = time;
    node.setAttribute('aria-label', `${time}, только что занято другим клиентом`);
    const tag = document.createElement('span');
    tag.className = 'slots__tag';
    tag.textContent = 'Только что занято';
    node.append(tag);
    return node;
  }

  /**
   * Вернуть выбор, с которым человек пришёл на страницу: слот из store.js и
   * удержание из `GET /holds/current`. Если это время уже занято, в ответе
   * доступности его нет — тогда выбор снимается и об этом говорится текстом
   * (своё удержание чужим слот не делает: сервер его из занятости исключает).
   */
  function applyRestore(slots) {
    if (!restore) return;
    const want = restore;
    restore = null;

    const same = slots.find((slot) => slot.at_utc === want.startsAt);
    if (!same) {
      clearSlot();
      if (onChange) onChange(null);
      const box = $('[data-error="slots"]');
      box.replaceChildren(document.createTextNode(
        'Выбранное раньше время уже занято — выберите другое.',
      ));
      box.hidden = false;
      return;
    }

    picked = same;
    if (onChange) onChange(same);

    if (!want.hold || want.hold.starts_at.at_utc !== same.at_utc) {
      // Выбор помним, а удержание уже снято (ушли с шага) или его не было
      // вовсе (гость). Говорим об этом прямо: слот показан выбранным, но за
      // человеком не закреплён.
      const node = holdNode();
      if (node) {
        node.classList.add('hold--warn');
        node.textContent = 'Это время пока не держится за вами — нажмите на него, '
          + 'чтобы занять на время оформления.';
        node.hidden = false;
      }
      return;
    }

    hold = want.hold;
    const node = holdNode();
    if (!node) return;
    stopTimer = startHoldTimer(node, new Date(want.hold.expires_at_utc).getTime(), {
      onExpire: () => {
        picked = null;
        hold = null;
        clearSlot();
        if (onChange) onChange(null);
        loadSlots();
      },
    });
  }

  function renderSlots(answer) {
    const list = listNode('slots');
    applyRestore(answer.slots);
    const rows = answer.slots.map((slot) => ({ time: slot.local_time, slot }));

    // Перехваченное время показываем на его месте в сетке — но только в тот
    // день, к которому оно относится.
    if (takenAt && takenAt.date === selectedDate
      && !rows.some((row) => row.time === takenAt.time)) {
      rows.push({ time: takenAt.time, slot: null });
      rows.sort((a, b) => a.time.localeCompare(b.time));
    }

    if (rows.length === 0) {
      fillEmpty(list, 'В этот день у мастера нет свободного окна нужной длины. '
        + 'Выберите другой день или нажмите «Ближайшая свободная дата».');
      return;
    }

    const parts = [];
    for (const part of DAY_PARTS) {
      const own = rows.filter((row) => partOf(row.time) === part);
      if (own.length === 0) continue;
      const node = tpl('tpl-slot-part').cloneNode(true);
      $('.slots__part-title', node).textContent = part.title;
      $('.slots__grid', node).replaceChildren(
        ...own.map((row) => (row.slot ? slotButton(row.slot) : takenButton(row.time))),
      );
      parts.push(node);
    }
    fill(list, parts);
  }

  async function loadSlots() {
    const list = listNode('slots');
    const box = $('[data-error="slots"]');
    const need = $('[data-slots="need"]');

    $('[data-slots="day"]').textContent = dayDisplay(selectedDate);
    list.replaceChildren();
    list.setAttribute('aria-busy', 'true');
    box.hidden = true;

    const askedDate = selectedDate;
    try {
      const answer = await loadAvailability(selectedDate);
      if (askedDate !== selectedDate) return; // человек успел переключить день
      durationMin = answer.durationMin;
      $('[data-slots="need-text"]').textContent =
        `Нужно ${minutesLong(answer.durationMin)} подряд — показываем только подходящее начало`;
      need.hidden = false;
      renderSlots(answer);
      if (answer.partial) {
        box.replaceChildren(document.createTextNode(
          'Часть мастеров не ответила — свободного времени на экране может быть меньше, чем есть.',
        ));
        box.hidden = false;
      }
    } catch (err) {
      if (askedDate !== selectedDate) return;
      need.hidden = true;
      showError(box, list, err, loadSlots);
    }
  }

  /* --------------------------------------------------------- удержание */

  function stopHoldTimer() {
    if (stopTimer) stopTimer();
    stopTimer = null;
  }

  function holdNode() {
    return $('[data-hold]');
  }

  /** Выбор снят: ни слота, ни удержания, дальше идти не с чем. */
  function resetPick() {
    picked = null;
    hold = null;
    stopHoldTimer();
    clearSlot();
    const node = holdNode();
    if (node) {
      node.hidden = true;
      node.classList.remove('hold--over', 'hold--guest');
      node.replaceChildren();
    }
    for (const node2 of document.querySelectorAll('.slots__slot--picked')) {
      node2.classList.remove('slots__slot--picked');
      node2.setAttribute('aria-pressed', 'false');
    }
    if (onChange) onChange(null);
  }

  /** Человек нажал на уже выбранный слот — отпускаем время. */
  async function unpick() {
    const token = hold ? hold.token : null;
    resetPick();
    if (token) await releaseHold(token);
  }

  /** Гостю удержать слот нечем: `POST /holds` требует сессию. */
  function guestNotice() {
    const node = holdNode();
    if (!node) return;
    node.classList.add('hold--guest');
    node.replaceChildren(document.createTextNode(
      'Без входа время не держится за вами: его может занять другой клиент. ',
    ));
    const link = document.createElement('a');
    link.href = authHref(PAGES.login, PAGES.confirm);
    link.textContent = 'Войти';
    node.append(link);
    node.hidden = false;
  }

  /**
   * Выбор слота сразу удерживает его (`POST /holds`): пока человек смотрит на
   * экран и заполняет шаг 4, время не должно уйти другому. В прототипе
   * удержания нет вовсе — решение 8 карты экранов.
   */
  async function choose(slot, node) {
    const box = $('[data-error="slots"]');
    const previous = hold ? hold.token : null;
    resetPick();
    box.hidden = true;
    node.classList.add('slots__slot--picked');
    node.setAttribute('aria-pressed', 'true');

    picked = slot;
    // Слот запоминается сразу: шаг 4 читает его из store.js, и для гостя,
    // который пойдёт входить, выбор должен уцелеть.
    setSlot({ startsAt: slot.at_utc, masterId: slot.masterId });
    if (onChange) onChange(slot);

    try {
      const answer = await holdSlot({
        masterId: slot.masterId, serviceIds, startsAt: slot.at_utc,
      });
      hold = answer.hold;
      // Сервер держит одно удержание на человека: прежнее он снял сам,
      // вставляя новое. Отдельный DELETE тут был бы вторым запросом ни за чем.
      const node2 = holdNode();
      if (node2) {
        stopTimer = startHoldTimer(node2, Date.now() + answer.expires_in_sec * 1000, {
          onExpire: () => {
            picked = null;
            hold = null;
            clearSlot();
            if (onChange) onChange(null);
            loadSlots();
          },
        });
      }
    } catch (err) {
      if (err.status === 401) {
        // Гость: слот выбран, но не удержан. Это не ошибка экрана — шаг 4
        // предложит войти, и выбор к тому моменту сохранён.
        guestNotice();
        return;
      }
      // Прежнее удержание сервер снимает только при успешной вставке нового:
      // неудача его не трогает, и снимаем мы его сами.
      if (previous) await releaseHold(previous);
      resetPick();
      // Время успели занять, пока человек выбирал: сначала перечитываем день
      // (список свободного уже другой), и только потом пишем сообщение —
      // иначе загрузка сама спрятала бы его.
      await loadSlots();
      box.replaceChildren(document.createTextNode(
        `Это время не удалось занять. ${err.message}`,
      ));
      box.hidden = false;
    }
  }

  /* ------------------------------------------- ближайшая свободная дата */

  /**
   * «Ближайшая свободная дата»: перебираем дни вперёд, пока не найдётся день
   * со свободным окном. Выходные студии пропускаются без запроса — в них
   * слотов не будет.
   */
  async function nearestDate() {
    const buttons = [...document.querySelectorAll('[data-action="nearest"]')];
    const labels = buttons.map((button) => button.textContent);
    for (const button of buttons) {
      button.disabled = true;
      button.textContent = 'Ищем…';
    }
    const box = $('[data-error="slots"]');
    box.hidden = true;

    const today = salonToday(timezone);
    let date = selectedDate > today ? addDay(selectedDate, 1) : today;
    let found = null;
    let failure = null;

    for (let i = 0; i < NEAREST_DAYS && !found; i += 1, date = addDay(date, 1)) {
      if (!isPickable(date)) continue;
      try {
        const answer = await loadAvailability(date);
        if (answer.slots.length > 0) found = date;
      } catch (err) {
        failure = err;
        break;
      }
    }

    buttons.forEach((button, index) => {
      button.disabled = false;
      button.textContent = labels[index];
    });

    if (found) {
      await selectDate(found);
      return;
    }
    box.replaceChildren(document.createTextNode(failure
      ? `Не удалось найти ближайшую дату. ${failure.toText ? failure.toText() : failure.message}`
      : `В ближайшие ${NEAREST_DAYS} дней свободного окна нет. `
        + 'Посмотрите дальше по календарю или позвоните студии.'));
    box.hidden = false;
  }

  /* -------------------------------------------------------------- старт */

  /** Выбор дня: грузим его слоты и снимаем выбор, который к нему не относится. */
  async function selectDate(date) {
    const token = hold ? hold.token : null;
    selectedDate = date;
    // День может быть и из другого месяца (подсказка «ближайшее время»).
    viewMonth = date.slice(0, 7);
    resetPick();
    if (token) await releaseHold(token);
    renderCalendar();
    await loadSlots();
  }

  /** Первый день на экране: сегодня, а если студия закрыта — ближайший рабочий. */
  function firstDate() {
    let date = salonToday(timezone);
    for (let i = 0; i < 7 && isClosed(date); i += 1) date = addDay(date, 1);
    return date;
  }

  return {
    /**
     * Запуск: календарь, слоты и обработчики.
     * @param {object} opts
     * @param {string} [opts.date] с какого дня открыть
     * @param {{date: string, time: string}} [opts.taken] перехваченное время (экран 6)
     * @param {{startsAt: string, hold: object|null}} [opts.restore] выбор, с
     *        которым человек вернулся на страницу
     */
    async start({ date, taken, restore: toRestore } = {}) {
      takenAt = taken || null;
      restore = toRestore || null;
      selectedDate = date || firstDate();
      viewMonth = selectedDate.slice(0, 7);
      setupCalendarNav();
      for (const button of document.querySelectorAll('[data-action="nearest"]')) {
        button.addEventListener('click', nearestDate);
      }
      renderCalendar();
      await loadSlots();
    },
    selectDate,
    nearestDate,
    /**
     * Сменить перехваченное время (экран 6, когда и новый слот успели занять).
     * Отдельно от `start`, чтобы не навешивать обработчики календаря дважды.
     */
    setTaken(taken) { takenAt = taken || null; },
    /** Выбранный слот или null — нужен нижней панели страницы. */
    getPick: () => picked,
    /** Токен удержания: его спрашивают «Выйти» и «Назад», чтобы снять слот. */
    getHoldToken: () => (hold ? hold.token : null),
    /** Длительность визита по ответу API — для строки «14:00–16:00». */
    getDurationMin: () => durationMin,
  };
}
