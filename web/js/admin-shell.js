'use strict';

/**
 * Общий слой раздела администратора (`/admin`): юзер-блок в сайдбаре,
 * «Выйти» и проверка роли на стороне страницы.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 *
 * ПРО ПРОВЕРКУ ДОСТУПА. Эта проверка — не защита, а поведение интерфейса.
 * Настоящих рубежа два, и оба на сервере:
 *   1. API: `router.use(requireRole('admin', 'owner'))` в начале
 *      api/src/routes/admin.js — весь раздел `/api/admin/*` отвечает 403
 *      аккаунту без роли;
 *   2. страницы: guard в web/server.js — `/admin` и всё под ним отдаётся
 *      только аккаунту с ролью, остальным уходит 403 и страница
 *      «Этот раздел только для администраторов».
 * Поэтому до этого файла клиент попросту не доходит. Проверка здесь нужна на
 * случай, когда роль отозвали при открытой странице: тогда она сама уводит
 * человека, не дожидаясь первого 403 от API.
 *
 * Роли приходят списком (`user.roles`), и проверка — вхождение в список, а не
 * равенство: у одного человека их может быть несколько (например мастер,
 * который заодно администрирует).
 */

import { getMe, logout } from './api.js';
import { $, showError, refreshIcons } from './ui.js';

/** Куда уходим, когда сессии нет. */
const LOGIN_PAGE = '/login.html';
/** Куда уходим после выхода — лендинг, как в прототипе. */
const LANDING_PAGE = '/';
/** Что показываем аккаунту без роли администратора. */
const FORBIDDEN_PAGE = '/admin-forbidden.html';

/** Роли, которым открыт раздел. Те же, что у requireRole в API. */
const ADMIN_ROLES = ['admin', 'owner'];

/**
 * Есть ли у пользователя роль администратора.
 * Роли — список, поэтому вопрос именно «входит ли», а не «равна ли».
 */
export function isAdmin(user) {
  return !!user && Array.isArray(user.roles)
    && ADMIN_ROLES.some((role) => user.roles.includes(role));
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
 * Юзер-блок сайдбара: имя и инициалы из `GET /auth/me`.
 *
 * 401 — это не ошибка на экране, а «не вошёл»: уводим на вход. `replace`,
 * чтобы «назад» не возвращало на страницу, которую всё равно не показать.
 */
async function loadMe() {
  const box = $('[data-error="me"]');
  const block = $('[data-user="block"]');
  try {
    const user = await getMe();

    // Роль отозвали при открытой странице — показываем ту же страницу, что
    // отдал бы сервер. Наполнять сайдбар уже незачем.
    if (!isAdmin(user)) {
      window.location.replace(FORBIDDEN_PAGE);
      return null;
    }

    $('[data-user="name"]').textContent = user.name;
    $('[data-user="initials"]').textContent = initials(user.name);
    block.removeAttribute('aria-busy');
    box.hidden = true;
    return user;
  } catch (err) {
    if (err.status === 401) {
      window.location.replace(LOGIN_PAGE);
      return null;
    }
    // Имя не пришло — пустой кружок обещал бы инициалы, которых уже не будет.
    $('[data-user="name"]').textContent = '—';
    block.removeAttribute('aria-busy');
    showError(box, null, err, loadMe, 'Не удалось загрузить профиль.');
    return null;
  }
}

/**
 * «Выйти» в сайдбаре: `POST /auth/logout`, затем лендинг.
 * Куку снимает сервер. Уходим и при ошибке — кроме 401, который означает,
 * что сессии уже нет: там уход случится сам.
 */
function setupLogout() {
  const button = $('[data-action="logout"]');
  const box = $('[data-error="me"]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await logout();
      window.location.assign(LANDING_PAGE);
    } catch (err) {
      button.disabled = false;
      if (err.status === 401) {
        window.location.replace(LOGIN_PAGE);
        return;
      }
      showError(box, null, err, null, 'Не удалось выйти.');
    }
  });
}

/**
 * Каркас страницы раздела. Своей логики у страниц «Записи», «Услуги» и
 * «Мастера» пока нет — данными они не наполняются, — поэтому модуль
 * запускается сам, а страница только подключает его.
 *
 * Когда разделы начнут показывать данные, рядом появятся свои модули
 * (admin-appointments.js и остальные), а этот останется общим слоем:
 * `isAdmin` и `initials` для этого и экспортируются.
 */
export function initAdminShell() {
  setupLogout();
  return loadMe();
}

initAdminShell();

// Иконки lucide: скрипт подключён с `defer`, поэтому к моменту запуска модуля
// его может ещё не быть — рисуем по `load`, как остальные страницы.
window.addEventListener('load', refreshIcons);
