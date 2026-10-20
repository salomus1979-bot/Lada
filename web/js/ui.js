'use strict';

/**
 * Общие помощники страниц: выборка узлов, заглушки, ошибки на экране и форматы
 * цены, длительности и даты.
 *
 * Запросов здесь нет — с сервером разговаривает только api.js (правило 3).
 *
 * До этого модуля одни и те же функции были написаны по разу в landing.js,
 * catalog.js, account-shell.js и booking-shell.js; в двух последних об этом так
 * и сказано: четыре копии подряд — знак, что им пора в общий web/js/ui.js.
 * Здесь они один раз, а в страницах осталось только своё.
 */

/* --------------------------------------------------------------- утилиты */

export const $ = (selector, root = document) => root.querySelector(selector);
export const listNode = (name) => $(`[data-list="${name}"]`);
export const errorBox = (name) => $(`[data-error="${name}"]`);
export const tpl = (id) => $(`#${id}`).content.firstElementChild;

/** Перерисовка иконок lucide: скрипт внешний, его может и не быть. */
export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/* -------------------------------------------------- заглушки и наполнение */

/** Заглушки гаснут: данных на этом месте уже не будет. */
function quiet(node) {
  node.replaceChildren();
  node.removeAttribute('aria-busy');
}

/**
 * Блок заглушек заменяется содержимым: разом, чтобы не мигало.
 *
 * Сообщение об ошибке этого же блока убирается — данные всё-таки пришли.
 */
export function fill(node, children) {
  node.replaceChildren(...children);
  node.removeAttribute('aria-busy');
  const box = node.dataset.list ? errorBox(node.dataset.list) : null;
  if (box) box.hidden = true;
  refreshIcons();
}

/** Короткая строка вместо данных, когда ответ пришёл пустым. */
export function fillEmpty(node, text) {
  const note = document.createElement('p');
  note.className = 'empty-note';
  note.textContent = text;
  fill(node, [note]);
}

/* ---------------------------------------------------------------- ошибки */

/** Кнопка «Повторить» рядом с текстом ошибки. */
function retryButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'load-error__retry';
  button.textContent = 'Повторить';
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Ошибка API на экране: текст и «Повторить» (правило 7). Заглушки гасим —
 * иначе человек ждал бы данных, которые уже не придут.
 *
 * @param {HTMLElement} box куда писать сообщение
 * @param {HTMLElement|HTMLElement[]|null} list блок с заглушками (или несколько)
 * @param {{toText?: Function, message: string}} err ошибка из api.js
 * @param {Function} [retry] что вызвать по «Повторить»
 * @param {string} [lead] первая фраза: на шагах воронки она называет данные
 *   («Не удалось загрузить мастеров.»), а не говорит про «данные» вообще
 */
export function showError(box, list, err, retry, lead = 'Не удалось загрузить данные.') {
  for (const node of [list].flat()) {
    if (node) quiet(node);
  }
  if (!box) return;

  box.replaceChildren();
  const text = document.createElement('span');
  text.textContent = `${lead} ${err.toText ? err.toText() : err.message}`;
  box.append(text);

  if (retry) {
    box.append(retryButton(() => {
      box.hidden = true;
      retry();
    }));
  }
  box.hidden = false;
}

/**
 * Экран, которому нечего показать: тело страницы убирается, на его месте —
 * текст и, если есть что повторить, кнопка (правило 7).
 *
 * Нужен экранам 9 и 10 кабинета, которые открываются по номеру записи: номера
 * нет, запись не найдена — показывать пустую страницу нельзя. И шагам 3-4
 * воронки, где без выбранных услуг, мастера или времени шаг бессмысленен: это
 * честнее, чем рисовать пустой календарь.
 *
 * @param {HTMLElement} box куда писать сообщение
 * @param {HTMLElement} body блок, который нечем наполнить
 * @param {string} message что сказать человеку
 * @param {Function} [retry] что вызвать по «Повторить» (для 404 не нужно)
 */
export function pageFailure(box, body, message, retry) {
  body.hidden = true;
  box.replaceChildren(document.createTextNode(message));
  if (retry) {
    box.append(retryButton(() => {
      box.hidden = true;
      body.hidden = false;
      retry();
    }));
  }
  box.hidden = false;
}

/* --------------------------------------------------------------- форматы */

/** «2 600 ₽» — так же, как это делает API в своих `*_display`. */
export const rubles = (kopecks) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

/** «90 мин», «2 ч 00 мин» — запись длительности из прототипа. */
export function minutesLong(min) {
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  return `${hours} ч ${String(min % 60).padStart(2, '0')} мин`;
}

/**
 * Даты приходят от API уже в поясе студии (`local_date`), поэтому собираются
 * как UTC-полночь и форматируются в UTC: иначе браузер в другом поясе сдвинул
 * бы день.
 */
const asUtcDay = (localDate) => new Date(`${localDate}T00:00:00Z`);

/**
 * «23 октября» — дата в крошках, подсказках и подписях клеток календаря. Года
 * нет намеренно: `Intl` с годом даёт «23 октября 2026 г.», а «г.» в прототипе
 * нигде не встречается. Там, где год нужен (сводка шага 4), он дописывается
 * отдельно — см. booking-confirm.js.
 */
const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', day: 'numeric', month: 'long',
});

/**
 * «пятница, 23 октября» — заголовок дня над слотами и строка-заголовок
 * карточки визита. Заглавная буква, где нужна, — в CSS (`::first-letter`), как
 * режим работы в подвале лендинга.
 */
const DAY_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
});

export const dateDisplay = (localDate) => DATE_FMT.format(asUtcDay(localDate));
export const dayDisplay = (localDate) => DAY_FMT.format(asUtcDay(localDate));
