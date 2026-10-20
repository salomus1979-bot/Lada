'use strict';

/**
 * Общий слой экранов кабинета (7-10 по карте экранов): юзер-блок в шапке,
 * «Выйти» в сайдбаре, переход на вход и чтение номера записи из адреса.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 *
 * Общие помощники (`$`, `fill`, `showError`, `pageFailure`, форматы цены,
 * длительности и даты) живут в web/js/ui.js — одни на все страницы. Здесь
 * только то, что своё у кабинета: профиль в шапке, «Выйти», уход на вход при
 * 401, номер записи из адреса и строки «14:00–16:00» и «через 9 дней».
 */

import { getMe, logout } from './api.js';
import { $, showError, dayDisplay } from './ui.js';
import { isAdmin } from './roles.js';

/* ------------------------------------------------------------- сессия */

/** Куда уходим, когда сессии нет. */
const LOGIN_PAGE = 'login.html';
/** Куда уходим после выхода — лендинг, как в прототипе. */
const LANDING_PAGE = '/';

/**
 * Роль администратора проверяется одним общим правилом — js/roles.js.
 * В кабинете из неё следует только одно: показывать ли пункт «Админ-панель»
 * в сайдбаре. Защитой это не является — скрытый пункт меню ничего не
 * закрывает, доступ к `/admin` и к `/api/admin/*` закрыт на сервере.
 */

/**
 * 401 на странице кабинета — это не ошибка на экране, а «не вошёл».
 * Текст «Не удалось загрузить» тут был бы неправдой: загружать нечего, пока
 * человек не вошёл. Поэтому молча уводим на вход, `replace` — чтобы «назад»
 * не возвращало на пустой кабинет.
 *
 * @returns {boolean} true, если ошибка обработана уходом на вход
 */
export function handledAsUnauthorized(err) {
  if (err.status !== 401) return false;
  window.location.replace(LOGIN_PAGE);
  return true;
}

/**
 * Номер записи из адреса: `appointment.html?id=7`. Экраны 9 и 10 открываются
 * только так, поэтому чужого формата не допускаем: `null` значит «страницу
 * открыли без записи», и экран скажет об этом текстом.
 */
export function appointmentIdFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('id');
  return /^\d+$/.test(String(raw)) ? Number(raw) : null;
}

/** Инициалы для кружка-аватара: так же, как их считает API для своих списков. */
export function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toLocaleUpperCase('ru-RU'))
    .join('');
}

/**
 * Пункт «Админ-панель» в сайдбаре кабинета: в разметке он скрыт и
 * показывается только аккаунту с ролью администратора.
 *
 * Он же — запасной путь в раздел: администратор, который почему-либо оказался
 * в кабинете (вошёл со старой вкладки, пришёл по закладке, вернулся из
 * воронки), видит ссылку и доходит до `/admin` без повторного входа.
 *
 * Это удобство, а не ограничение: пункта нет — раздел всё равно существует, и
 * закрывает его сервер.
 */
function showAdminLink(user) {
  const link = $('[data-role="admin"]');
  if (!link) return;
  link.hidden = !isAdmin(user);
}

/**
 * Юзер-блок в шапке: имя и инициалы из `GET /auth/me`.
 * Профиль нужен обоим экранам кабинета и ничего больше о себе не решает,
 * поэтому возвращаем его наружу — страница ждёт его вместе со своими данными.
 *
 * @param {Function} [onUser] что ещё показать по этому же ответу. Нужен
 *   экрану 16: там из `GET /auth/me` берутся не только имя в шапке, но и поля
 *   «Личные данные», и по «Повторить» наполниться должны оба — поэтому колбэк
 *   уходит и в повторный вызов. Вызывается с `null`, когда профиль не пришёл.
 */
export async function loadMe(onUser) {
  const box = $('[data-error="me"]');
  try {
    const user = await getMe();
    $('[data-user="name"]').textContent = user.name;
    const avatar = $('[data-user="initials"]');
    avatar.textContent = initials(user.name);
    avatar.removeAttribute('aria-busy');
    $('[data-user="block"]').removeAttribute('aria-busy');
    box.hidden = true;
    showAdminLink(user);
    if (onUser) onUser(user);
    return user;
  } catch (err) {
    if (handledAsUnauthorized(err)) return null;
    // Имя не пришло — пульсирующая заглушка на его месте обещала бы данные,
    // которых уже не будет.
    $('[data-user="name"]').textContent = '—';
    $('[data-user="initials"]').textContent = '';
    $('[data-user="block"]').removeAttribute('aria-busy');
    if (onUser) onUser(null);
    showError(box, null, err, () => loadMe(onUser));
    return null;
  }
}

/**
 * «Выйти» в сайдбаре: `POST /auth/logout`, затем лендинг.
 * Куку снимает сервер. Уходим и в случае ошибки — кроме той, которая значит,
 * что сессии уже нет: там уход и так случится сам.
 */
export function setupLogout() {
  const button = $('[data-action="logout"]');
  const box = $('[data-error="me"]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await logout();
      window.location.assign(LANDING_PAGE);
    } catch (err) {
      button.disabled = false;
      if (handledAsUnauthorized(err)) return;
      showError(box, null, err);
    }
  });
}

/* ---------------------------------------------------------- форматы */

/** «Пятница, 23 октября · 14:00–16:00» — строка-заголовок карточки визита. */
export function whenDisplay(appointment) {
  const day = dayDisplay(appointment.starts_at.local_date);
  return `${day} · ${appointment.starts_at.local_time}–${appointment.ends_at.local_time}`;
}

/** Склонение: 1 день, 2 дня, 5 дней. */
function plural(count, one, few, many) {
  const tail = count % 100;
  const last = count % 10;
  if (last === 1 && tail !== 11) return one;
  if (last >= 2 && last <= 4 && (tail < 11 || tail > 14)) return few;
  return many;
}

/**
 * «через 9 дней» — сколько осталось до визита.
 *
 * В прототипе это зашитый текст; здесь считается от `starts_at.at_utc`.
 * Ближе суток — часы, ближе часа — так и сказано: ждать осталось минуты.
 */
export function untilDisplay(atUtc) {
  const minutes = Math.round((new Date(atUtc) - Date.now()) / 60000);
  if (minutes <= 0) return 'уже началась';
  if (minutes < 60) return 'меньше часа';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `через ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}
