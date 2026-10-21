'use strict';

/**
 * Экран 8 «Кабинет — Пустое состояние». Структура, тексты и порядок блоков —
 * из «8. Кабинет - Пустое состояние.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /appointments?scope=upcoming` (пустой ответ),
 * `GET /services` для «Популярных услуг», `GET /auth/me` для юзер-блока.
 *
 * Пустое состояние — отдельная страница, а не ветка `account.html`
 * (правило 2: один экран прототипа — одна страница). Сюда ведёт успешная
 * регистрация и сам кабинет, когда предстоящих записей нет.
 *
 * Страница только для вошедшего: 401 — переход на вход, а не ошибка на экране.
 */

import { getAppointments, getServices } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, showError,
} from './ui.js';
import { loadMe, setupLogout, setupSideNav, handledAsUnauthorized } from './account-shell.js';

/** Экран 7: тот же кабинет, когда предстоящие записи есть. */
const LIST_PAGE = 'account.html';

/** Сколько карточек в блоке «Популярные услуги» — как в прототипе. */
const POPULAR_COUNT = 3;

/* --------------------------------------------------- пустое состояние */

/**
 * Пустое состояние показывается только после ответа API: иначе страница
 * говорила бы «записей нет», ещё не зная этого. Если записи есть, человеку
 * здесь делать нечего — его место на экране 7.
 */
async function loadUpcoming() {
  const list = listNode('empty');
  const box = $('[data-error="upcoming"]');
  try {
    const appointments = await getAppointments({ scope: 'upcoming' });
    if (appointments.length > 0) {
      window.location.replace(LIST_PAGE);
      return;
    }
    fill(list, [tpl('tpl-empty').cloneNode(true)]);
    box.hidden = true;
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      loadUpcoming();
    });
  }
}

/* --------------------------------------------------- популярные услуги */

function popularCard(service) {
  const node = tpl('tpl-popular').cloneNode(true);
  $('.pop__name', node).textContent = service.name;
  $('.pop__meta', node).textContent = `${service.price_display} · ${service.duration_min} мин`;
  return node;
}

/**
 * «Популярные услуги». Признака популярности в API нет, счётчика записей по
 * услуге — тоже: берём первые три из витрины `GET /services` (сервер отдаёт
 * их в порядке категорий и названий). Иконка у всех одна: в прототипе их три
 * разных, но связи «услуга — иконка» в данных нет.
 */
async function loadPopular() {
  const list = listNode('popular');
  const box = $('[data-error="popular"]');
  try {
    const services = await getServices();
    if (services.length === 0) {
      // Блок без услуг — пустая рамка ни о чём: убираем его целиком.
      $('.popular').remove();
      return;
    }
    fill(list, services.slice(0, POPULAR_COUNT).map(popularCard));
    box.hidden = true;
  } catch (err) {
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      loadPopular();
    });
  }
}

/* --------------------------------------------------------------- старт */

function start() {
  refreshIcons();
  setupLogout();
  setupSideNav();
  // Профиль, записи и витрина друг от друга не зависят — грузятся разом.
  loadMe();
  loadUpcoming();
  loadPopular();
}

window.addEventListener('load', refreshIcons);
start();
