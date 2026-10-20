'use strict';

/**
 * Экран 12 «Вход». Отправляет форму на `POST /api/auth/login` и ведёт дальше
 * по роли: клиента — в личный кабинет (экран 7 по карте экранов),
 * администратора — в раздел `/admin`.
 *
 * Форма одна на всех: второго входа для администратора нет и не нужно —
 * `POST /auth/login` один, и роли по нему возвращает сервер.
 *
 * Сессию страница не трогает: куку ставит сервер, `session_token` из ответа
 * не читается и никуда не сохраняется.
 */

import { login } from './api.js';
import {
  initIcons, setupPasswordToggle, clearErrors, clearErrorOnInput, setFieldError,
  showFormError, focusFirstInvalid, applyApiError, submitting, field,
  checkEmail, checkRequired, nextPage,
} from './auth-form.js';

/**
 * Куда ведёт успешный вход у клиента — `7. Кабинет - Предстоящие записи`, а
 * если сюда пришли с шага воронки (`?next=…`), то обратно на этот шаг: запись
 * человек начал раньше, чем вошёл.
 *
 * Прерванная запись важнее роли: администратор, который шёл по воронке,
 * вернётся в воронку, а не в свой раздел. Поэтому `?next=` (он принимает
 * только страницы воронки, см. auth-form.js) проверяется первым.
 */
const AFTER_LOGIN = nextPage('account.html');
const CAME_FROM_BOOKING = AFTER_LOGIN !== 'account.html';

/** Первая страница раздела администратора. */
const ADMIN_PAGE = '/admin/appointments';

/**
 * Роли, которым открыт раздел администратора. Те же, что проверяет сервер:
 * `requireRole('admin', 'owner')` в api/src/routes/admin.js и guard в
 * web/server.js. Здесь это только выбор страницы после входа — доступ
 * решается на сервере.
 */
const ADMIN_ROLES = ['admin', 'owner'];

/**
 * Куда вести вошедшего. Роли приходят СПИСКОМ (`user.roles` из ответа
 * `POST /auth/login`, собранный сервером по таблице `user_roles`), поэтому
 * вопрос — «есть ли роль в списке», а не «равна ли роль администратору»:
 * у одного человека их может быть несколько.
 */
function pageForUser(user) {
  if (CAME_FROM_BOOKING) return AFTER_LOGIN;
  const roles = Array.isArray(user && user.roles) ? user.roles : [];
  return ADMIN_ROLES.some((role) => roles.includes(role)) ? ADMIN_PAGE : AFTER_LOGIN;
}

const form = document.getElementById('login-form');
const button = form.querySelector('button[type="submit"]');

initIcons();
setupPasswordToggle();
clearErrorOnInput(form);

/**
 * Проверка до отправки — ради удобства: не гонять запрос ради пустого поля.
 * Решает всё равно сервер, его ответ показывается ниже в `catch`.
 */
function validate() {
  const problems = {
    email: checkEmail(field(form, 'email').value),
    password: checkRequired(field(form, 'password').value, 'введите пароль'),
  };
  let ok = true;
  for (const [name, message] of Object.entries(problems)) {
    if (!message) continue;
    setFieldError(form, name, message);
    ok = false;
  }
  return ok;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form);
  if (!validate()) {
    focusFirstInvalid(form);
    return;
  }

  submitting(button, true, 'Входим…');
  try {
    const user = await login({
      email: field(form, 'email').value.trim(),
      password: field(form, 'password').value,
    });
    // Успех — сессия уже в куке, дальше решают роли из ответа сервера.
    window.location.assign(pageForUser(user));
  } catch (err) {
    if (err.status === 401) {
      // Сервер намеренно не говорит, что именно не подошло: иначе по ответу
      // можно было бы перебирать зарегистрированные адреса. Поэтому
      // подсвечиваются оба поля, а текст — общий, как в прототипе.
      setFieldError(form, 'email', '');
      setFieldError(form, 'password', '');
      showFormError(form, err.message);
      focusFirstInvalid(form);
    } else {
      applyApiError(form, err);
    }
    submitting(button, false);
  }
});
