'use strict';

/**
 * Общий слой шагов воронки записи (1-4) и экранов результата (5-6): выход из
 * воронки, таймер удержания слота, переходы между шагами и форматы времени в
 * поясе студии.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 *
 * Общие помощники (`$`, `fill`, `showError`, `pageFailure`, форматы цены,
 * длительности и даты) живут в web/js/ui.js — одни на все страницы. Здесь
 * только то, что своё у воронки.
 */

import { releaseHold } from './api.js';
import { clearSelection } from './store.js';
import { $, refreshIcons } from './ui.js';

/* --------------------------------------------------------------- ошибки */

/** Текст со ссылкой «вернуться на нужный шаг» вместо кнопки «Повторить». */
export function pageFailureLink(box, body, message, { href, label }) {
  body.hidden = true;
  const link = document.createElement('a');
  link.className = 'btn btn--outline';
  link.href = href;
  link.textContent = label;
  box.replaceChildren(document.createTextNode(message), link);
  box.hidden = false;
}

/* ------------------------------------------------------------- форматы */

/**
 * «23 окт» — короткая дата для тесных мест (панель гостя). Дата приходит от
 * API в поясе студии, поэтому собирается как UTC-полночь и форматируется в
 * UTC: иначе браузер в другом поясе сдвинул бы день.
 */
const SHORT_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', day: 'numeric', month: 'short',
});

export const shortDateDisplay = (localDate) => SHORT_FMT.format(new Date(`${localDate}T00:00:00Z`));

/**
 * UTC-метка в календарную дату и время студии.
 *
 * Пояс приходит с сервера (`settings.timezone`): страница не считает, что
 * браузер и студия в одном поясе — у API все метки UTC, а показывать надо
 * время студии. Формат `en-CA` даёт `YYYY-MM-DD`, в котором даты сравниваются
 * как строки.
 */
export function zoned(atUtc, timezone) {
  const at = new Date(atUtc);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
  return { date, time };
}

/** Сегодняшняя дата в поясе студии. */
export const salonToday = (timezone) => zoned(new Date().toISOString(), timezone).date;

/** Конец визита: начало плюс длительность услуг — для строки «14:00–16:00». */
export function endTime(atUtc, durationMin, timezone) {
  const end = new Date(new Date(atUtc).getTime() + durationMin * 60000);
  return zoned(end.toISOString(), timezone).time;
}

/** Инициалы в кружке мастера — так же, как их считает API для своих списков. */
export function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/* ------------------------------------------------- удержание и таймер */

/** Остаток удержания: «6:59». */
export const leftDisplay = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Отсчёт удержания слота (решение 8 карты экранов): в прототипе его нет, но
 * удержание настоящее — `POST /holds` держит слот `hold_ttl_min` минут.
 *
 * Возвращает функцию остановки. Истекло — вызывается `onExpire`: слот снова
 * свободен для всех, и экран не должен делать вид, что время за человеком.
 *
 * @param {HTMLElement} node куда писать остаток
 * @param {number} expiresAtMs момент истечения (мс)
 * @param {{ onExpire?: Function, overText?: string }} opts
 */
export function startHoldTimer(node, expiresAtMs, { onExpire, overText } = {}) {
  let timer = null;
  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  node.hidden = false;
  node.classList.remove('hold--over');

  const tick = () => {
    const left = expiresAtMs - Date.now();
    if (left <= 0) {
      stop();
      node.textContent = overText || 'Время больше не держится за вами — выберите слот заново.';
      node.classList.add('hold--over');
      node.hidden = false;
      if (onExpire) onExpire();
      return;
    }
    node.textContent = `Время держится за вами ещё ${leftDisplay(left)}`;
  };

  tick();
  timer = window.setInterval(tick, 1000);
  return stop;
}

/* ------------------------------------------------------- переходы */

/** Страницы воронки — в одном месте, чтобы шаги ссылались друг на друга одинаково. */
export const PAGES = {
  landing: '/',
  services: 'booking-services.html',
  master: 'booking-master.html',
  time: 'booking-time.html',
  confirm: 'booking-confirm.html',
  done: 'booking-done.html',
  taken: 'booking-taken.html',
  login: 'login.html',
  register: 'register.html',
  account: 'account.html',
};

/**
 * Ссылка на вход (или регистрацию) с возвратом на шаг воронки.
 *
 * Сам выбор никуда не теряется — он в sessionStorage, — но без `next`
 * человек после входа оказался бы в кабинете и возвращался на шаг 4 руками.
 */
export function authHref(page, back) {
  return `${page}?next=${encodeURIComponent(back)}`;
}

/**
 * Окно подтверждения выхода — одно на все четыре шага, поэтому собирается
 * кодом, а не лежит в разметке каждого шага. Классы `.modal` — общие, те же,
 * что у модалки отмены на экране 9 (css/landing.css).
 *
 * @param {{ text: Function, onConfirm: Function }} opts `text` — функция: на
 *   шагах 3-4 к нему добавляется фраза про удержание, и известно это только в
 *   момент нажатия
 */
function exitDialog({ text, onConfirm }) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal__backdrop" data-exit-close></div>
    <div class="modal__card" role="dialog" aria-modal="true" aria-labelledby="exit-title">
      <span class="modal__tile">
        <i class="icon" data-lucide="log-out" aria-hidden="true"></i>
      </span>
      <h2 class="modal__title" id="exit-title">Выйти из записи?</h2>
      <p class="modal__text"></p>
      <p class="load-error" data-error="exit" role="status" hidden></p>
      <div class="modal__actions">
        <button class="btn btn--ghost" type="button" data-exit-close>Остаться</button>
        <button class="btn btn--primary" type="button" data-exit-confirm>Да, выйти</button>
      </div>
    </div>`;
  document.body.append(modal);

  const message = $('.modal__text', modal);
  const confirm = $('[data-exit-confirm]', modal);
  const box = $('[data-error="exit"]', modal);

  const close = () => {
    modal.hidden = true;
    box.hidden = true;
    const button = $('[data-exit]');
    if (button) button.focus();
  };

  for (const node of modal.querySelectorAll('[data-exit-close]')) {
    node.addEventListener('click', close);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    box.hidden = true;
    try {
      await onConfirm();
    } catch (err) {
      // Удержание не снялось: уходить молча нельзя — слот простоял бы занятым
      // до конца `hold_ttl_min`, а человек думал бы, что отпустил его
      // (правило 7).
      confirm.disabled = false;
      box.replaceChildren(document.createTextNode(
        `Выйти не удалось. ${err.toText ? err.toText() : err.message}`,
      ));
      box.hidden = false;
    }
  });

  return () => {
    message.textContent = text();
    modal.hidden = false;
    refreshIcons();
    confirm.focus();
  };
}

/**
 * «Выйти» из воронки: выбор стирается, удержание снимается (иначе слот
 * простоял бы занятым до конца `hold_ttl_min`), дальше — лендинг.
 *
 * Сначала спрашиваем подтверждение (решение по `DELETE /holds/:token` в
 * docs/ui-map.md): в прототипе этого окна нет, но за кнопкой стоит потеря
 * выбранных услуг и мастера, а на шагах 3-4 ещё и снятие удержания. Окно одно
 * на все четыре шага, текст про удержание — только там, где оно есть.
 *
 * `holdToken` берётся функцией, а не значением: на шаге 3 удержание меняется
 * с каждым выбором слота.
 */
export function setupExit(getHoldToken = () => null) {
  const button = $('[data-exit]');
  if (!button) return;

  const open = exitDialog({
    text: () => 'Выбранные услуги и мастер не сохранятся — запись придётся начать заново.'
      + (getHoldToken() ? ' Время, которое держится за вами, снова станет'
        + ' доступно другим клиентам.' : ''),
    onConfirm: async () => {
      const token = getHoldToken();
      if (token) await releaseHold(token);
      clearSelection();
      window.location.assign(PAGES.landing);
    },
  });

  button.addEventListener('click', open);
}

/**
 * Уход с шага по своей ссылке («Назад», «Изменить мастера»): сначала снимаем
 * удержание, потом переходим. Браузерную кнопку «Назад» так не перехватить —
 * там слот освободит сам сервер по истечении `hold_ttl_min`.
 */
export function setupHoldAwareLinks(selector, getHoldToken) {
  // Обработчик на документе, а не на самих ссылках: часть их («Изменить
  // мастера», «Изменить услуги») появляется после ответа API.
  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target && target.closest(selector);
    if (!link) return;
    const token = getHoldToken();
    if (!token) return;
    event.preventDefault();
    await releaseHold(token);
    window.location.assign(link.getAttribute('href'));
  });
}
