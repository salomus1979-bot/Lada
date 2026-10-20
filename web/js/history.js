'use strict';

/**
 * Экран 11 «Кабинет — История записей». Структура, тексты и порядок блоков —
 * из «11. Кабинет - История записей.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов данные у экрана одни: `GET /appointments?scope=past&limit=100`
 * (прошедшие и отменённые приходят вместе, свежие сверху) плюс `GET /auth/me`
 * для юзер-блока.
 *
 * Фильтры «Период / Мастер / Услуга» и страницы считаются здесь, на клиенте:
 * `GET /appointments` принимает только `scope` и `limit` — ни периода, ни
 * мастера, ни услуги, ни `offset`, ни общего количества (решение 5 карты
 * экранов). Поэтому экран берёт сто последних записей одним ответом и дальше
 * делит их сам; когда их ровно сто, он так и говорит под списком.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import { getAppointments } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, fillEmpty, showError, rubles, dateDisplay,
} from './ui.js';
import { loadMe, setupLogout, handledAsUnauthorized, initials } from './account-shell.js';

/** Сколько записей просит экран: это и есть предел `limit` у API. */
const LIMIT = 100;

/** Сколько строк на странице. Пагинация своя — `offset` у API нет. */
const PAGE_SIZE = 10;

/** Отменённые — два статуса API: клиентом и студией. */
const CANCELLED = ['cancelled_by_client', 'cancelled_by_studio'];

/** Цвет бейджа по статусу из ответа. Подпись берётся из `status_label`. */
const BADGE_CLASS = {
  completed: 'hist__badge--ok',
  confirmed: 'hist__badge--ok',
  pending: 'hist__badge--wait',
  no_show: 'hist__badge--wait',
  cancelled_by_client: 'chip--quiet',
  cancelled_by_studio: 'hist__badge--off',
};

/** Что загрузилось и что выбрано в фильтрах. */
const state = {
  all: [],
  tab: 'past',
  period: 'all',
  master: '',
  service: '',
  page: 1,
};

/* ------------------------------------------------------------- фильтры */

/**
 * Граница периода как дата `YYYY-MM-DD`: даты записей приходят в поясе студии
 * (`starts_at.local_date`) и сравниваются строками.
 *
 * Отсчёт идёт по календарю браузера, а не студии: пояс пришлось бы спрашивать
 * отдельным `GET /settings`, а для «за месяц / 3 месяца / год» разница в один
 * день ничего не решает.
 */
function periodStart(days) {
  const from = new Date();
  from.setDate(from.getDate() - Number(days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
}

/** Проходит ли запись выбранный период. */
function inPeriod(appointment) {
  if (state.period === 'all') return true;
  return appointment.starts_at.local_date >= periodStart(state.period);
}

/** Проходит ли запись фильтры «Мастер» и «Услуга». */
function inPicks(appointment) {
  if (state.master && String(appointment.master.id) !== state.master) return false;
  if (state.service && !appointment.services.some((s) => String(s.service_id) === state.service)) {
    return false;
  }
  return true;
}

/** Строки текущего таба после всех трёх фильтров. */
function filtered() {
  const cancelled = state.tab === 'cancelled';
  return state.all.filter((a) => CANCELLED.includes(a.status) === cancelled
    && inPeriod(a) && inPicks(a));
}

/**
 * Варианты «Мастер» и «Услуга» — из самого ответа: справочник мастеров и
 * услуг здесь ни к чему, в истории важны те, у кого человек уже был. Собраны
 * по всему ответу, а не по текущему табу: иначе выбранный мастер исчезал бы
 * из списка при переключении на «Отменённые».
 */
function fillFilterOptions() {
  const masters = new Map();
  const services = new Map();
  for (const appointment of state.all) {
    masters.set(String(appointment.master.id), appointment.master.display_name);
    for (const service of appointment.services) {
      services.set(String(service.service_id), service.name);
    }
  }
  addOptions($('[data-filter="master"]'), masters, 'Мастер');
  addOptions($('[data-filter="service"]'), services, 'Услуга');
}

/** Варианты селекта: первый («все») уже в разметке, остальные дописываются. */
function addOptions(select, items, prefix) {
  const options = [...items]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru-RU'))
    .map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${prefix}: ${label}`;
      return option;
    });
  select.append(...options);
}

/* --------------------------------------------------------------- сводка */

/**
 * «3 визита · 6 200 ₽» и подпись периода — из того же ответа, что и список:
 * сводки у API нет.
 *
 * Считаются только состоявшиеся визиты: отменённые деньгами не были.
 * На «Мастер» и «Услугу» сводка не смотрит намеренно — подпись под ней
 * называет период, и «за год» рядом с суммой по одному мастеру читалось бы
 * как итог за год вообще.
 */
function renderSummary() {
  const visits = state.all.filter((a) => !CANCELLED.includes(a.status) && inPeriod(a));
  const total = visits.reduce((sum, a) => sum + a.total_price_kopecks, 0);
  const box = $('[data-sum="box"]');

  $('[data-sum="value"]').textContent = visits.length === 0
    ? 'Визитов пока нет'
    : `${visits.length} ${plural(visits.length, 'визит', 'визита', 'визитов')} · ${rubles(total)}`;
  $('[data-sum="label"]').textContent =
    $('[data-filter="period"]').selectedOptions[0].textContent.replace('Период: ', '');
  box.removeAttribute('aria-busy');
}

/** Склонение: 1 визит, 2 визита, 5 визитов. */
function plural(count, one, few, many) {
  const tail = count % 100;
  const last = count % 10;
  if (last === 1 && tail !== 11) return one;
  if (last >= 2 && last <= 4 && (tail < 11 || tail > 14)) return few;
  return many;
}

/* --------------------------------------------------------- строка списка */

function historyRow(appointment) {
  const node = tpl('tpl-hist-row').cloneNode(true);

  $('.hist__link', node).href = `appointment.html?id=${appointment.id}`;
  $('.hist__date', node).textContent = dateDisplay(appointment.starts_at.local_date);
  $('.hist__time', node).textContent = appointment.starts_at.local_time;
  $('.hist__initials', node).textContent = initials(appointment.master.display_name);
  $('.hist__master', node).textContent = appointment.master.display_name;
  $('.hist__services', node).textContent = appointment.services.map((s) => s.name).join(', ');
  $('.hist__price', node).textContent = appointment.total_price_display;

  const badge = $('.hist__badge', node);
  badge.textContent = appointment.status_label;
  badge.classList.add(BADGE_CLASS[appointment.status] || 'chip--quiet');

  // Причина есть только у отмены — её называет сервер (`cancel_reason`).
  if (appointment.cancel_reason) {
    const reason = $('.hist__reason', node);
    reason.textContent = `Причина: ${appointment.cancel_reason}`;
    reason.hidden = false;
  }

  // «Повторить запись» — переход на шаг 1, как в прототипе. Состав визита в
  // воронку не переносится: в записи лежат снимки названий и цен, а услуги
  // с тех пор могли подорожать или исчезнуть вовсе.
  return node;
}

/* -------------------------------------------------------------- страницы */

/** Кнопки страниц. Одна страница — блока нет вовсе, как и в прототипе. */
function renderPager(count) {
  const pager = listNode('pages');
  const pages = Math.ceil(count / PAGE_SIZE);
  if (pages <= 1) {
    pager.replaceChildren();
    pager.hidden = true;
    return;
  }

  const buttons = [];
  for (let n = 1; n <= pages; n += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pager__page';
    button.textContent = String(n);
    button.setAttribute('aria-current', n === state.page ? 'page' : 'false');
    button.addEventListener('click', () => {
      state.page = n;
      render();
    });
    buttons.push(button);
  }
  pager.replaceChildren(...buttons);
  pager.hidden = false;
}

/* --------------------------------------------------------------- экран */

/**
 * Почему список пуст: «ничего не подошло» про нетронутые фильтры было бы
 * неправдой — записей такого рода у человека просто нет.
 */
function emptyText() {
  const filtering = state.period !== 'all' || state.master !== '' || state.service !== '';
  if (filtering) return 'Под фильтры ничего не подошло.';
  return state.tab === 'cancelled' ? 'Отменённых записей нет.' : 'Прошедших записей нет.';
}

/** Перерисовка списка, сводки и страниц по текущему выбору. */
function render() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;

  const list = listNode('history');
  if (rows.length === 0) {
    fillEmpty(list, emptyText());
  } else {
    const from = (state.page - 1) * PAGE_SIZE;
    fill(list, rows.slice(from, from + PAGE_SIZE).map(historyRow));
  }

  renderSummary();
  renderPager(rows.length);
  refreshIcons();
}

async function loadHistory() {
  const list = listNode('history');
  const box = $('[data-error="history"]');
  try {
    state.all = await getAppointments({ scope: 'past', limit: LIMIT });
    fillFilterOptions();
    // Ровно сто — значит, предел ответа достигнут и за ним может быть ещё.
    $('[data-note="limit"]').hidden = state.all.length < LIMIT;
    box.hidden = true;
    render();
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    $('[data-sum="box"]').hidden = true;
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      $('[data-sum="box"]').hidden = false;
      loadHistory();
    }, 'Не удалось загрузить историю записей.');
  }
}

/* --------------------------------------------------------------- старт */

function setupTabs() {
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      state.page = 1;
      for (const other of document.querySelectorAll('[data-tab]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      render();
    });
  }
}

function setupFilters() {
  for (const select of document.querySelectorAll('[data-filter]')) {
    select.addEventListener('change', () => {
      state[select.dataset.filter] = select.value;
      state.page = 1;
      render();
    });
  }
  $('[data-action="reset-filters"]').addEventListener('click', () => {
    for (const select of document.querySelectorAll('[data-filter]')) {
      select.selectedIndex = 0;
      state[select.dataset.filter] = select.value;
    }
    state.page = 1;
    render();
  });
}

function start() {
  refreshIcons();
  setupLogout();
  setupTabs();
  setupFilters();
  // Профиль и история друг от друга не зависят — грузятся разом.
  loadMe();
  loadHistory();
}

window.addEventListener('load', refreshIcons);
start();
