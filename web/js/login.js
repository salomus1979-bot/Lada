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

import { login, getMe } from './api.js';
import {
  initIcons, setupPasswordToggle, clearErrors, clearErrorOnInput, setFieldError,
  showFormError, focusFirstInvalid, applyApiError, submitting, field,
  checkEmail, checkRequired, nextPage,
} from './auth-form.js';
import { CABINET_PAGE, homePageFor } from './roles.js';

/**
 * Куда ведёт успешный вход у клиента — `7. Кабинет - Предстоящие записи`, а
 * если сюда пришли с шага воронки (`?next=…`), то обратно на этот шаг: запись
 * человек начал раньше, чем вошёл.
 *
 * Прерванная запись важнее роли: администратор, который шёл по воронке,
 * вернётся в воронку, а не в свой раздел. Поэтому `?next=` (он принимает
 * только страницы воронки, см. auth-form.js) проверяется первым.
 */
const AFTER_LOGIN = nextPage(CABINET_PAGE);
const CAME_FROM_BOOKING = AFTER_LOGIN !== CABINET_PAGE;

/**
 * Роли вошедшего. Обычно они уже в ответе `POST /auth/login` — сервер
 * собирает их по таблице `user_roles` и кладёт в `user.roles`.
 *
 * Если роли в ответе не пришли, их спрашивают отдельно — `GET /auth/me`.
 * Это не перестраховка на пустом месте: без такого запроса страница молча
 * считала бы, что ролей нет, и администратор уезжал бы в клиентский кабинет —
 * ровно так выглядит «сервис не перенаправляет в /admin», и по одному
 * поведению не отличить, что именно сломалось. Теперь источник ролей один —
 * сервер, а не форма входа, и спросить его можно дважды.
 */
async function rolesOfLoggedIn(user) {
  if (user && Array.isArray(user.roles)) return user;
  try {
    return await getMe();
  } catch {
    // Профиль не отдался — ведём в кабинет, как всех. Пункт «Админ-панель»
    // там появится сам, когда `GET /auth/me` ответит (account-shell.js).
    return user;
  }
}

/** Куда вести вошедшего: шаг воронки, если вход прерывал запись, иначе — по роли. */
async function pageForUser(user) {
  if (CAME_FROM_BOOKING) return AFTER_LOGIN;
  return homePageFor(await rolesOfLoggedIn(user), AFTER_LOGIN);
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
    window.location.assign(await pageForUser(user));
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
