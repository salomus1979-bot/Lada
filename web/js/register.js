'use strict';

/**
 * Экран 13 «Регистрация». Отправляет форму на `POST /api/auth/register`
 * и ведёт в пустой кабинет (экран 8 по карте экранов): записей у нового
 * клиента ещё нет.
 *
 * Ответ 201 уже открывает сессию — куку ставит сервер; `session_token`
 * страница не читает и не сохраняет.
 */

import { register } from './api.js';
import {
  initIcons, setupPasswordToggle, renderStrength, clearErrors, clearErrorOnInput,
  setFieldError, focusFirstInvalid, applyApiError, submitting, field,
  checkEmail, checkPhone, checkPassword, nextPage,
} from './auth-form.js';

/**
 * Куда ведёт успешная регистрация — `8. Кабинет - Пустое состояние`: записей
 * у нового клиента ещё нет. С шага воронки (`?next=…`) — обратно на шаг:
 * человек регистрировался, чтобы завершить запись.
 */
const AFTER_REGISTER = nextPage('account-empty.html');

const form = document.getElementById('register-form');
const button = form.querySelector('button[type="submit"]');
const strength = document.getElementById('password-strength');

initIcons();
setupPasswordToggle();
clearErrorOnInput(form);

// Полоски силы пароля — подсказка на клиенте: правило постоянное
// (от 8 символов, буквы и цифры), отдельного эндпоинта с ним нет.
field(form, 'password').addEventListener('input', (event) => {
  renderStrength(strength, event.target.value);
});

/** Проверка до отправки. Окончательное слово — за сервером. */
function validate() {
  const password = field(form, 'password').value;
  const problems = {
    name: field(form, 'name').value.trim().length >= 2 ? null : 'минимум 2 символа',
    email: checkEmail(field(form, 'email').value),
    phone: checkPhone(field(form, 'phone').value),
    password: checkPassword(password),
    password_confirm: field(form, 'password_confirm').value === password
      ? null
      : 'пароли не совпадают',
  };

  let ok = true;
  for (const [name, message] of Object.entries(problems)) {
    if (!message) continue;
    setFieldError(form, name, message);
    ok = false;
  }

  if (!field(form, 'consent').checked) {
    setFieldError(form, 'consent', 'нужно согласие на обработку персональных данных');
    document.getElementById('consent-row').classList.add('check--invalid');
    ok = false;
  }
  return ok;
}

/** Ссылка «Войти» рядом с сообщением о занятом e-mail — как в прототипе. */
function loginLink() {
  const link = document.createElement('a');
  // Пришли с шага воронки — ведём на вход с тем же возвратом.
  link.href = AFTER_REGISTER === 'account-empty.html'
    ? 'login.html'
    : `login.html?next=${encodeURIComponent(AFTER_REGISTER)}`;
  link.textContent = 'Войти';
  return link;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form);
  document.getElementById('consent-row').classList.remove('check--invalid');
  if (!validate()) {
    focusFirstInvalid(form);
    return;
  }

  submitting(button, true, 'Регистрируем…');
  try {
    await register({
      name: field(form, 'name').value.trim(),
      email: field(form, 'email').value.trim(),
      phone: field(form, 'phone').value.trim(),
      password: field(form, 'password').value,
      passwordConfirm: field(form, 'password_confirm').value,
      consent: field(form, 'consent').checked,
    });
    window.location.assign(AFTER_REGISTER);
  } catch (err) {
    // 409 с `details.email` — «такой e-mail уже зарегистрирован»:
    // поле подсвечивается, а рядом с текстом встаёт ссылка на вход.
    applyApiError(form, err, { email: loginLink() });
    submitting(button, false);
  }
});
