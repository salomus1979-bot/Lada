'use strict';

/**
 * Экран 7 «Кабинет — Предстоящие записи». Структура, тексты и порядок блоков —
 * из «7. Кабинет - Предстоящие записи.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /appointments?scope=upcoming` (вместе с правами
 * `can_cancel`, `can_reschedule`, `reschedules_left`, `cancel_window_hours`),
 * `GET /auth/me` для юзер-блока, табы «Прошедшие»/«Отменённые» —
 * `GET /appointments?scope=past`, поделённый на клиенте по `status`
 * (решение 6 карты: отдельного `scope=cancelled` у API нет).
 *
 * «Отменить» → `POST /appointments/:id/cancel`. Гаснет там, где сервер прислал
 * `can_cancel: false`: окно отмены считает он, а не экран.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import { getAppointments, cancelAppointment } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, fillEmpty, showError, minutesLong,
} from './ui.js';
import {
  loadMe, setupLogout, setupSideNav, handledAsUnauthorized,
  initials, whenDisplay, untilDisplay,
} from './account-shell.js';

/** Экран 8: тот же кабинет, когда предстоящих записей нет. */
const EMPTY_PAGE = 'account-empty.html';

/** Отменённые — два статуса API: клиентом и студией. */
const CANCELLED = ['cancelled_by_client', 'cancelled_by_studio'];

/** Какой таб открыт и что уже загружено. */
let current = 'upcoming';
const loaded = { upcoming: null, past: null, cancelled: null };

/* ----------------------------------------------------- карточка визита */

/**
 * Карточка визита. Что показывать и что можно нажать, решает ответ API:
 * `can_cancel` и `can_reschedule` приходят по каждой записи.
 */
function apptCard(appointment, { first }) {
  const node = tpl('tpl-appt').cloneNode(true);
  const upcoming = current === 'upcoming';

  // «Ближайшая» — только у первой карточки предстоящих, как в прототипе.
  const badge = $('.appt__badge', node);
  if (first && upcoming) node.classList.add('appt--next');
  else badge.remove();

  // «через 9 дней» имеет смысл только у предстоящих; у прошедших и
  // отменённых на этом месте статус из ответа API.
  const until = $('.appt__until', node);
  const status = $('.appt__status', node);
  if (upcoming) {
    until.textContent = untilDisplay(appointment.starts_at.at_utc);
    status.remove();
  } else {
    status.textContent = appointment.status_label;
    until.remove();
  }

  $('.appt__when', node).textContent = whenDisplay(appointment);
  $('.appt__initials', node).textContent = initials(appointment.master.display_name);
  $('.appt__master-name', node).textContent = appointment.master.display_name;
  $('.appt__services', node).textContent = appointment.services.map((s) => s.name).join(', ');
  $('.appt__total', node).textContent =
    `${appointment.total_price_display} · ${minutesLong(appointment.service_duration_min)}`;

  $('.appt__more', node).href = `appointment.html?id=${appointment.id}`;
  setupActions(node, appointment);
  return node;
}

/**
 * Кнопки карточки. Переносить и отменять можно только то, что разрешил
 * сервер; причина отказа пишется подсказкой под кнопками — как тултип в
 * прототипе, но текст собран из `cancel_window_hours` и `reschedules_left`,
 * а не зашит.
 */
function setupActions(node, appointment) {
  const cancel = $('.appt__cancel', node);
  const reschedule = $('.appt__reschedule', node);
  const hint = $('.appt__hint', node);

  // Прошедшие и отменённые записи менять нечем: API их и не разрешает.
  if (current !== 'upcoming') {
    $('.appt__actions', node).replaceChildren($('.appt__more', node));
    $('.appt__confirm', node).remove();
    return;
  }

  reschedule.href = `appointment-reschedule.html?id=${appointment.id}`;
  if (!appointment.can_reschedule) {
    disableAction(reschedule);
    hint.textContent = appointment.reschedules_left === 0
      ? 'Переносы по этой записи исчерпаны — позвоните студии.'
      : `Перенос возможен не позднее чем за ${appointment.cancel_window_hours} ч до визита.`;
    hint.hidden = false;
  }

  if (!appointment.can_cancel) {
    disableAction(cancel);
    // Подсказку про перенос не затираем, если она уже есть: причина одна и та
    // же — окно в `cancel_window_hours` часов.
    if (hint.hidden) {
      hint.textContent =
        `Отмена возможна не позднее чем за ${appointment.cancel_window_hours} ч до визита — позвоните студии.`;
      hint.hidden = false;
    }
    $('.appt__confirm', node).remove();
    return;
  }

  setupCancel(node, appointment, cancel, hint);
}

/** Выключенная кнопка: у ссылки нет `disabled`, поэтому ссылка и не ссылка. */
function disableAction(node) {
  node.classList.add('is-disabled');
  if (node.tagName === 'A') {
    node.removeAttribute('href');
    node.setAttribute('aria-disabled', 'true');
  } else {
    node.disabled = true;
  }
}

/**
 * Отмена в два шага: «Отменить» показывает подтверждение прямо в карточке.
 * В прототипе кнопка уводила на экран 9, где спрашивают причину; здесь по
 * заданию отмена делается с этого экрана, а подтверждение всё равно нужно —
 * действие необратимое. Причину не спрашиваем: `cancel_reason` необязателен.
 */
function setupCancel(node, appointment, cancel, hint) {
  const actions = $('.appt__actions', node);
  const confirm = $('.appt__confirm', node);
  const yes = $('.appt__confirm-yes', node);

  const ask = (on) => {
    actions.hidden = on;
    confirm.hidden = !on;
  };

  cancel.addEventListener('click', () => ask(true));
  $('.appt__confirm-no', node).addEventListener('click', () => {
    ask(false);
    cancel.focus();
  });

  yes.addEventListener('click', async () => {
    yes.disabled = true;
    yes.textContent = 'Отменяем…';
    hint.hidden = true;
    hint.classList.remove('appt__hint--error');
    try {
      await cancelAppointment(appointment.id);
      // Список предстоящих изменился, а прошедшие и отменённые — тем же
      // ответом: сброшены оба кеша, таб перечитает данные.
      loaded.upcoming = null;
      loaded.past = null;
      loaded.cancelled = null;
      await openTab('upcoming', { force: true });
    } catch (err) {
      if (handledAsUnauthorized(err)) return;
      yes.disabled = false;
      yes.textContent = 'Да, отменить';
      hint.textContent = `Запись не отменена. ${err.toText ? err.toText() : err.message}`;
      hint.classList.add('appt__hint--error');
      hint.hidden = false;
    }
  });
}

/* --------------------------------------------------------------- табы */

/** Счётчик в «Предстоящие (2)» — из ответа, а не из макета. */
function setTabCount(count) {
  const tab = $('[data-tab="upcoming"]');
  tab.textContent = count === null ? 'Предстоящие' : `Предстоящие (${count})`;
}

function renderList(appointments) {
  const list = listNode('appointments');
  list.setAttribute('aria-labelledby', `tab-${current}`);

  if (appointments.length === 0) {
    fillEmpty(list, current === 'cancelled'
      ? 'Отменённых записей нет.'
      : 'Прошедших записей нет.');
    return;
  }
  fill(list, appointments.map((appointment, index) => apptCard(appointment, { first: index === 0 })));
}

/**
 * Загрузка таба. `scope=past` приходит одним списком — он тут же делится на
 * «Прошедшие» и «Отменённые» по `status` (решение 6 карты экранов), поэтому
 * второй из этих табов данные уже не запрашивает.
 */
async function loadTab(tab) {
  const list = listNode('appointments');
  const box = $('[data-error="appointments"]');
  try {
    if (tab === 'upcoming') {
      const appointments = await getAppointments({ scope: 'upcoming' });
      loaded.upcoming = appointments;
      setTabCount(appointments.length);
      // Предстоящих нет — это экран 8, отдельная страница кабинета
      // (правило 2: один экран прототипа — одна страница).
      if (appointments.length === 0) {
        window.location.replace(EMPTY_PAGE);
        return;
      }
    } else {
      const past = await getAppointments({ scope: 'past', limit: 100 });
      loaded.cancelled = past.filter((a) => CANCELLED.includes(a.status));
      loaded.past = past.filter((a) => !CANCELLED.includes(a.status));
    }
    if (tab !== current) return; // человек успел переключить таб
    renderList(loaded[tab]);
    box.hidden = true;
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      loadTab(tab);
    });
  }
}

/** Переключение таба: данные каждого списка берутся один раз. */
async function openTab(tab, { force = false } = {}) {
  current = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  const list = listNode('appointments');
  $('[data-error="appointments"]').hidden = true;

  if (!force && loaded[tab]) {
    renderList(loaded[tab]);
    return;
  }
  list.replaceChildren();
  list.setAttribute('aria-busy', 'true');
  await loadTab(tab);
}

/* --------------------------------------------------------------- старт */

/**
 * С какого таба открыться. `?tab=past` и `?tab=cancelled` приходят с экрана 8:
 * там предстоящих нет, а прошедшие и отменённые показывает этот экран —
 * по параметру он сразу открывает нужный список и не отправляет человека
 * обратно на пустое состояние.
 */
function initialTab() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'past' || tab === 'cancelled' ? tab : 'upcoming';
}

function start() {
  refreshIcons();
  setupLogout();
  setupSideNav();
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => openTab(button.dataset.tab));
  }
  // Профиль и записи друг от друга не зависят — грузятся разом.
  loadMe();
  openTab(initialTab());
}

window.addEventListener('load', refreshIcons);
start();
