'use strict';

/**
 * Экран 15 «Новый пароль».
 *
 * Сохранять пароль нечем: эндпоинта установки пароля по токену в API нет
 * (docs/ui-map.md, п. 4), поэтому кнопка выключена. Работает только то, что
 * живёт на стороне экрана: глазок, полоски силы пароля и проверка совпадения
 * — правило постоянное (от 8 символов, буквы и цифры).
 */

import {
  initIcons, setupPasswordToggle, renderStrength, setFieldError, clearErrors,
  field, checkPassword,
} from './auth-form.js';

const form = document.getElementById('password-new-form');
const strength = document.getElementById('password-strength');
const password = field(form, 'password');
const confirm = field(form, 'password_confirm');

initIcons();
setupPasswordToggle();

password.addEventListener('input', () => {
  renderStrength(strength, password.value);
});

/** Подсказки по полям — те же правила, что проверил бы сервер. */
function check() {
  clearErrors(form);
  const problem = checkPassword(password.value);
  if (password.value && problem) setFieldError(form, 'password', problem);
  if (confirm.value && confirm.value !== password.value) {
    setFieldError(form, 'password_confirm', 'пароли не совпадают');
  }
}

password.addEventListener('blur', check);
confirm.addEventListener('input', check);

// Enter в поле не должен перезагружать страницу с паролем в адресной строке:
// отправлять форму всё равно некуда.
form.addEventListener('submit', (event) => event.preventDefault());
