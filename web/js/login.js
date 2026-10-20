'use strict';

/**
 * Экран 12 «Вход». Отправляет форму на `POST /api/auth/login` и ведёт в
 * личный кабинет (экран 7 по карте экранов).
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
 * Куда ведёт успешный вход — `7. Кабинет - Предстоящие записи`, а если сюда
 * пришли с шага воронки (`?next=…`), то обратно на этот шаг: запись человек
 * начал раньше, чем вошёл.
 */
const AFTER_LOGIN = nextPage('account.html');

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
    await login({
      email: field(form, 'email').value.trim(),
      password: field(form, 'password').value,
    });
    // Успех — сессия уже в куке, дальше кабинет.
    window.location.assign(AFTER_LOGIN);
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
