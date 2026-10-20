'use strict';

/**
 * Экран 16 «Кабинет — Профиль». Структура, тексты и порядок блоков — из
 * «16. Кабинет - Профиль.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). Данные:
 * `GET /auth/me` (личные данные, только на чтение) и `GET /auth/sessions` +
 * `DELETE /auth/sessions/:id` («Активные сессии»).
 *
 * По решению 3 карты экранов в вёрстку идёт только «Активные сессии»: из
 * четырёх блоков прототипа API закрывает один. Чего на экране нет и почему:
 *
 * - **«Сохранить», «Отмена», «Загрузить фото»** — обновления профиля в API
 *   нет вовсе, поля стоят на чтение (в прототипе «Имя», «E-mail» и «Телефон»
 *   и так `readonly`);
 * - **«Дата рождения»** — такого поля нет и в таблице `users`;
 * - **«Смена пароля»** — эндпоинта нет;
 * - **переключателей уведомлений** — хранить их негде: ни таблицы настроек
 *   уведомлений, ни самих уведомлений в базе нет (пп. 1-3 карты);
 * - **«Удалить аккаунт»** — эндпоинта нет, а кнопка необратимого действия,
 *   которая ничего не делает, — худшее, что можно оставить на экране;
 * - **тоста «Изменения сохранены»** — сохранять нечего.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import { getSessions, endSession } from './api.js';
import { $, listNode, tpl, refreshIcons, fill, showError } from './ui.js';
import { loadMe, setupLogout, handledAsUnauthorized, initials } from './account-shell.js';

/** Куда уходим, когда завершили ту сессию, из которой смотрим. */
const LOGIN_PAGE = 'login.html';

/** Иконка по виду устройства: `kind` из ответа API. */
const DEVICE_ICON = { mobile: 'smartphone', desktop: 'monitor', unknown: 'help-circle' };

/**
 * «19 октября, 21:40» — время входа.
 *
 * Пояс — браузерный, а не студии: `GET /auth/sessions` отдаёт метки UTC без
 * пояса, и спрашивать `GET /settings` ради подписи здесь незачем. Для списка
 * своих устройств часы самого устройства и есть верная система отсчёта.
 */
const LOGIN_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
});

/* -------------------------------------------------------- личные данные */

/** Поля из `GET /auth/me`. Пустой ответ — прочерк, а не пульсирующая заглушка. */
function fillPersonal(user) {
  for (const input of document.querySelectorAll('[data-me]')) {
    input.value = user ? (user[input.dataset.me] || '—') : '—';
  }
  $('[data-user="big-initials"]').textContent = user ? initials(user.name) : '';
}

/* -------------------------------------------------------------- сессии */

function sessionRow(session) {
  const node = tpl('tpl-session').cloneNode(true);
  $('.sess__icon', node).dataset.lucide = DEVICE_ICON[session.kind] || DEVICE_ICON.unknown;
  $('.sess__device', node).textContent = session.device;

  // Текущую сессию называет сервер (`is_current`): по подписи устройства её
  // не узнать — браузер и система могут совпадать у двух входов.
  if (session.is_current) {
    const mark = document.createElement('span');
    mark.className = 'chip chip--current sess__mark';
    mark.textContent = 'Это устройство';
    $('.sess__device', node).append(' ', mark);
  }

  $('.sess__time', node).textContent = session.is_current
    ? `Текущая сессия · вход ${LOGIN_FMT.format(new Date(session.created_at_utc))}`
    : `Вход ${LOGIN_FMT.format(new Date(session.created_at_utc))}`;

  const button = $('.sess__end', node);
  // «Выйти» у своего устройства, «Завершить» у остальных — как в прототипе.
  button.textContent = session.is_current ? 'Выйти' : 'Завершить';
  button.addEventListener('click', () => end(session, button, $('.sess__hint', node)));
  return node;
}

/**
 * «Завершить» / «Выйти»: `DELETE /auth/sessions/:id`.
 *
 * Свою текущую сессию завершить тоже можно — сервер отвечает `was_current` и
 * снимает куку, поэтому экран уходит на вход, а не остаётся в кабинете, из
 * которого уже вышел. 404 значит, что сессии и так больше нет: это не ошибка,
 * список просто перечитывается.
 */
async function end(session, button, hint) {
  button.disabled = true;
  button.textContent = 'Завершаем…';
  hint.hidden = true;
  try {
    const wasCurrent = await endSession(session.id);
    if (wasCurrent) {
      window.location.replace(LOGIN_PAGE);
      return;
    }
    await loadSessions();
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    if (err.status === 404) {
      await loadSessions();
      return;
    }
    button.disabled = false;
    button.textContent = session.is_current ? 'Выйти' : 'Завершить';
    hint.textContent = `Сессия не завершена. ${err.toText ? err.toText() : err.message}`;
    hint.hidden = false;
  }
}

async function loadSessions() {
  const list = listNode('sessions');
  const box = $('[data-error="sessions"]');
  try {
    const sessions = await getSessions();
    fill(list, sessions.map(sessionRow));
    refreshIcons();
    box.hidden = true;
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      loadSessions();
    }, 'Не удалось загрузить список устройств.');
  }
}

/* --------------------------------------------------------------- старт */

function start() {
  refreshIcons();
  setupLogout();
  // Личные данные приходят тем же ответом, что имя в шапке: один запрос на
  // оба места (см. loadMe в account-shell.js).
  loadMe(fillPersonal);
  loadSessions();
}

window.addEventListener('load', refreshIcons);
start();
