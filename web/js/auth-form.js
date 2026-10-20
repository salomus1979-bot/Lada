'use strict';

/**
 * Общее поведение форм авторизации: подсветка полей, показ ошибки сервера,
 * состояние «отправляем», глазок у пароля и индикатор силы пароля.
 *
 * Запросов здесь нет — они в api.js (правило 3). Этот файл только о том,
 * что форма показывает человеку.
 *
 * Про проверку на стороне формы. Она нужна для удобства: не гонять запрос
 * ради пустого поля и сказать про опечатку сразу. Настоящая проверка — на
 * сервере, и её ответ всё равно показывается: `applyApiError` разбирает
 * `details` и подсвечивает названные сервером поля, даже если форма
 * считала их заполненными верно.
 */

/** Иконки lucide: скрипт внешний, его может и не быть. */
export function initIcons() {
  const draw = () => { if (window.lucide) window.lucide.createIcons(); };
  draw();
  window.addEventListener('load', draw);
}

/** Поле формы по имени. */
export const field = (form, name) => form.elements[name];

/**
 * Куда вернуть человека после входа или регистрации.
 *
 * Шаг 4 воронки уводит сюда с `?next=booking-confirm.html`: выбор лежит в
 * sessionStorage и вход его не трогает, но без этого человек оказался бы в
 * кабинете и возвращался к записи руками.
 *
 * Значение не подставляется в адрес как есть: принимаются только страницы
 * воронки из списка ниже. Иначе ссылка на вход с чужим `next` увела бы
 * человека после входа куда угодно.
 */
const NEXT_ALLOWED = [
  'booking-services.html', 'booking-master.html', 'booking-time.html', 'booking-confirm.html',
];

export function nextPage(fallback) {
  const asked = new URLSearchParams(window.location.search).get('next');
  return NEXT_ALLOWED.includes(asked) ? asked : fallback;
}

/** Блок общей ошибки формы — над кнопкой отправки. */
const errorBox = (form) => form.querySelector('[data-form-error]');

/** Подпись ошибки под конкретным полем. */
const hintFor = (form, name) => form.querySelector(`[data-error-for="${name}"]`);

/** Снять всю подсветку и сообщения с прошлой попытки. */
export function clearErrors(form) {
  const box = errorBox(form);
  if (box) {
    box.hidden = true;
    box.querySelector('[data-form-error-text]').textContent = '';
  }
  for (const node of form.querySelectorAll('.field--invalid')) {
    node.classList.remove('field--invalid');
  }
  for (const hint of form.querySelectorAll('[data-error-for]')) {
    hint.hidden = true;
    hint.textContent = '';
  }
  for (const input of form.querySelectorAll('[aria-invalid="true"]')) {
    input.removeAttribute('aria-invalid');
  }
}

/** Подсветить поле и написать под ним, что не так. */
export function setFieldError(form, name, message) {
  const input = field(form, name);
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    (input.closest('.field') || input).classList.add('field--invalid');
  }
  // Пустое сообщение — поле подсвечено, но подписи под ним нет: так
  // показывается 401 «Неверный e-mail или пароль», где сервер намеренно
  // не называет виноватое поле.
  const hint = hintFor(form, name);
  if (hint && message) {
    hint.textContent = message;
    hint.hidden = false;
  }
}

/**
 * Общее сообщение формы. `extra` — узел, который ставится рядом с текстом
 * (например ссылка «Войти» при занятом e-mail, как на экране 13).
 */
export function showFormError(form, text, extra = null) {
  const box = errorBox(form);
  if (!box) return;
  const slot = box.querySelector('[data-form-error-text]');
  // Сообщения сервера приходят без точки в конце; перед ссылкой она нужна,
  // иначе получается «…уже зарегистрирован Войти».
  slot.textContent = extra && !/[.!?]$/.test(text) ? `${text}.` : text;
  if (extra) slot.append(' ', extra);
  box.hidden = false;
}

/**
 * Снимать подсветку с поля, как только человек начал его править: держать
 * красную рамку под строкой, которую уже исправили, незачем.
 */
export function clearErrorOnInput(form) {
  form.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.name) return;
    input.removeAttribute('aria-invalid');
    const wrap = input.closest('.field') || input.closest('.check');
    if (wrap) wrap.classList.remove('field--invalid', 'check--invalid');
    const hint = form.querySelector(`[data-error-for="${input.name}"]`);
    if (hint) { hint.hidden = true; hint.textContent = ''; }
  });
}

/** Первое подсвеченное поле — чтобы человек сразу попал курсором куда надо. */
export function focusFirstInvalid(form) {
  const input = form.querySelector('[aria-invalid="true"]');
  if (input) input.focus();
}

/**
 * Показать ответ сервера на форме.
 *
 * `details` — это карта «поле → что не так» (см. Validator в api/src/lib):
 * каждое названное поле подсвечивается. Поля, которого на форме нет, и
 * ответы без `details` (401 «Неверный e-mail или пароль», 429, 502)
 * показываются общим сообщением — молча проглотить ответ нельзя.
 */
export function applyApiError(form, err, extraByField = {}) {
  clearErrors(form);

  const details = err.details && typeof err.details === 'object' ? err.details : {};
  const known = Object.keys(details).filter((name) => field(form, name));
  for (const name of known) setFieldError(form, name, String(details[name]));

  const unknown = Object.keys(details).filter((name) => !field(form, name));
  const tail = unknown.map((name) => `${name}: ${details[name]}`).join('. ');

  const extra = known.length === 1 ? extraByField[known[0]] || null : null;
  showFormError(form, tail ? `${err.message}. ${tail}` : err.message, extra);
  focusFirstInvalid(form);
}

/** Кнопка на время запроса: «Входим…» и защита от второго нажатия. */
export function submitting(button, isOn, labelWhileLoading) {
  if (isOn) {
    button.dataset.label = button.textContent;
    button.textContent = labelWhileLoading;
    button.disabled = true;
    button.classList.add('btn--loading');
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
    button.classList.remove('btn--loading');
  }
}

/** Глазок: показать и спрятать пароль. */
export function setupPasswordToggle(root = document) {
  for (const button of root.querySelectorAll('[data-toggle-password]')) {
    const input = document.getElementById(button.dataset.togglePassword);
    button.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      button.setAttribute('aria-label', shown ? 'Показать пароль' : 'Скрыть пароль');
      button.setAttribute('aria-pressed', String(!shown));
      input.focus();
    });
  }
}

/* ------------------------------------------------- проверки полей */

// Те же правила, что у сервера (api/src/lib/validate.js). Здесь они
// повторены осознанно: форма отвечает сразу, сервер — решает.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function checkEmail(value) {
  if (!value.trim()) return 'обязательное поле';
  return EMAIL_RE.test(value.trim()) ? null : 'неверный e-mail';
}

export function checkRequired(value, message = 'обязательное поле') {
  return value.trim() ? null : message;
}

/** Российский номер: 11 цифр, начинается на 7 или 8. */
export function checkPhone(value) {
  if (!value.trim()) return 'обязательное поле';
  const digits = value.replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
  return normalized.length === 11 && normalized.startsWith('7')
    ? null
    : 'ожидается российский номер, например +7 999 123-45-67';
}

/** Пароль: минимум 8 символов, буквы и цифры — требование сервера. */
export function checkPassword(value) {
  if (!value) return 'обязательное поле';
  if (value.length < 8) return 'минимум 8 символов';
  if (!/[a-zA-Zа-яА-Я]/.test(value) || !/\d/.test(value)) {
    return 'пароль должен содержать буквы и цифры';
  }
  return null;
}

/* ------------------------------------------------- сила пароля */

/**
 * Четыре полоски под полем пароля (экраны 13 и 15).
 *
 * Это не данные и не проверка доступа: правило постоянное — от 8 символов,
 * буквы и цифры (решение 12 в docs/ui-map.md). Полоски только показывают,
 * насколько пароль перекрывает это правило.
 */
export function passwordStrength(value) {
  if (!value) return { level: 0, label: '' };
  let level = 0;
  if (value.length >= 8) level += 1;
  if (/[a-zA-Zа-яА-Я]/.test(value) && /\d/.test(value)) level += 1;
  if (value.length >= 12) level += 1;
  if (/[^\w\sа-яА-Я]/.test(value)) level += 1;

  if (level <= 1) return { level: Math.max(level, 1), label: 'Слабый пароль — нужны буквы и цифры, от 8 символов' };
  if (level === 2) return { level, label: 'Пароль подходит' };
  return { level, label: 'Надёжный пароль' };
}

/** Перерисовать полоски и подпись под полем пароля. */
export function renderStrength(container, value) {
  const { level, label } = passwordStrength(value);
  const bars = container.querySelectorAll('.strength__bar');
  bars.forEach((bar, index) => {
    bar.classList.toggle('strength__bar--weak', level <= 1 && index < level);
    bar.classList.toggle('strength__bar--on', level >= 2 && index < level);
  });
  const note = container.querySelector('.strength__note');
  if (note) note.textContent = label || 'Минимум 8 символов, буквы и цифры';
}
