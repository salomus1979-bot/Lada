'use strict';

/**
 * Экран 9 «Кабинет — Детали записи и отмена». Структура, тексты и порядок
 * блоков — из «9. Кабинет - Детали записи и отмена.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /appointments/:id` — вся запись целиком, плюс права
 * владельца (`can_cancel`, `can_reschedule`, `reschedules_left`,
 * `cancel_window_hours`). «Да, отменить» в модалке →
 * `POST /appointments/:id/cancel` с `cancel_reason`.
 *
 * Сверх строки карты — `GET /settings`: адрес, телефон и часы работы в блоке
 * «Адрес и время работы» (п. 14 карты, в прототипе они были зашиты).
 *
 * Запись открывается по id из адреса: `appointment.html?id=7`. Нет id или
 * запись не найдена — это текст на экране, а не пустая страница.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import { getAppointment, cancelAppointment, getSettings } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, showError, pageFailure,
  dayDisplay, dateDisplay, minutesLong,
} from './ui.js';
import {
  loadMe, setupLogout, handledAsUnauthorized, appointmentIdFromUrl,
  initials, whenDisplay,
} from './account-shell.js';
import { setupIcsLink } from './ics.js';

/** Куда уходим после отмены: отменённая запись видна в кабинете, таб «Отменённые». */
const AFTER_CANCEL_PAGE = 'account.html?tab=cancelled';

/** Экран 10: перенос этой же записи. */
const RESCHEDULE_PAGE = 'appointment-reschedule.html';

/** Статусы живой записи — те же, что считает активными API. */
const ACTIVE_STATUSES = ['pending', 'confirmed'];

/** Статусы, у которых чип цветной: остальные остаются нейтральными. */
const STATUS_TONE = {
  confirmed: 'detail__status--ok',
  pending: 'detail__status--wait',
  cancelled_by_client: 'detail__status--off',
  cancelled_by_studio: 'detail__status--off',
};

/** Запись, с которой работает экран: нужна модалке и сборке .ics. */
let appointment = null;
/** Настройки студии: адрес для .ics. Могут не прийти — это не ломает экран. */
let settings = null;

/* ------------------------------------------------------------- форматы */

/**
 * «Создана 14 октября». `created_at_utc` — момент, а не локальная дата,
 * поэтому раскладываем его в поясе студии; пояс приходит в том же ответе
 * (`starts_at.timezone`), своего значения здесь не появляется.
 */
function createdDisplay(createdAtUtc, timezone) {
  const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long' });
  return `Создана ${fmt.format(new Date(createdAtUtc))}`;
}

/* --------------------------------------------------- правила отмены */

/**
 * Строка правил справа. Окно и остаток переносов — из ответа API
 * (`cancel_window_hours`, `reschedules_left`), в прототипе они были зашиты
 * («не позднее чем за 4 часа»).
 */
function rulesText(appt) {
  const hours = appt.cancel_window_hours;
  // Завершённую, отменённую и прочие неактивные записи менять нечем — и дело
  // не в окне отмены, а в самом статусе.
  if (!ACTIVE_STATUSES.includes(appt.status)) {
    return `Запись ${String(appt.status_label).toLowerCase()} — перенести или отменить её уже нельзя.`;
  }
  if (!appt.can_cancel && !appt.can_reschedule && appt.reschedules_left === 0) {
    return `Переносы по этой записи исчерпаны, а отмена возможна не позднее чем за ${hours} ч `
      + 'до визита — позвоните студии.';
  }
  if (!appt.can_cancel && !appt.can_reschedule) {
    return `Перенос и отмена были доступны не позднее чем за ${hours} ч до визита — `
      + 'теперь это делает только студия по телефону.';
  }
  if (!appt.can_reschedule) {
    return `Отмена доступна не позднее чем за ${hours} ч до визита. Переносов по этой записи `
      + 'больше нет — позвоните студии.';
  }
  return `Перенос и отмена доступны не позднее чем за ${hours} ч до визита. `
    + `Переносов осталось: ${appt.reschedules_left}.`;
}

/* ----------------------------------------------------- .ics в браузере */

/**
 * «Добавить в календарь»: сборка файла — в общем ics.js (её же использует
 * экран 5 «Запись создана»). Адрес берётся из `GET /settings`; не пришёл —
 * строки LOCATION в файле просто не будет.
 */
function setupIcs(appt) {
  setupIcsLink($('[data-action="ics"]'), appt, {
    address: settings ? settings.address : null,
    durationText: minutesLong(appt.service_duration_min),
  });
}

/* ------------------------------------------------------------- отмена */

/**
 * Модалка отмены. Открывается кнопкой, закрывается кнопкой, фоном и Esc;
 * причина необязательна — пустой вариант в списке стоит первым.
 */
function setupCancelModal(appt) {
  const modal = $('[data-modal]');
  const open = $('[data-action="cancel"]');
  const confirm = $('[data-action="cancel-confirm"]');
  const reason = $('#cancel-reason');
  const box = $('[data-error="cancel"]');

  $('[data-modal="text"]').textContent =
    `Запись на ${dayDisplay(appt.starts_at.local_date)}, ${appt.starts_at.local_time} будет отменена. `
    + 'Время станет доступно другим клиентам — вернуть его может быть невозможно.';

  const close = () => {
    modal.hidden = true;
    box.hidden = true;
    open.focus();
  };

  open.addEventListener('click', () => {
    modal.hidden = false;
    refreshIcons();
    confirm.focus();
  });
  for (const node of modal.querySelectorAll('[data-modal-close]')) {
    node.addEventListener('click', close);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = 'Отменяем…';
    box.hidden = true;
    try {
      await cancelAppointment(appt.id, reason.value || undefined);
      window.location.assign(AFTER_CANCEL_PAGE);
    } catch (err) {
      if (handledAsUnauthorized(err)) return;
      confirm.disabled = false;
      confirm.textContent = 'Да, отменить';
      box.replaceChildren(document.createTextNode(
        `Запись не отменена. ${err.toText ? err.toText() : err.message}`,
      ));
      box.hidden = false;
    }
  });
}

/* ----------------------------------------------------------- отрисовка */

function serviceRow(service) {
  const node = tpl('tpl-service-row').cloneNode(true);
  $('.detail__service-name', node).textContent = service.name;
  $('.detail__service-duration', node).textContent = `${service.duration_min} мин`;
  $('.detail__service-price', node).textContent = service.price_display;
  return node;
}

function render(appt) {
  $('[data-appt="crumb"]').textContent = `Запись от ${dateDisplay(appt.starts_at.local_date)}`;
  document.title = `Лада — запись от ${dateDisplay(appt.starts_at.local_date)}`;

  const status = $('[data-appt="status"]');
  status.textContent = appt.status_label;
  if (STATUS_TONE[appt.status]) status.classList.add(STATUS_TONE[appt.status]);

  $('[data-appt="when"]').textContent = whenDisplay(appt);
  $('[data-appt="created"]').textContent = createdDisplay(appt.created_at_utc, appt.starts_at.timezone);
  $('.detail__head').removeAttribute('aria-busy');

  $('[data-appt="master-initials"]').textContent = initials(appt.master.display_name);
  $('[data-appt="master"]').textContent = appt.master.display_name;

  fill(listNode('services'), appt.services.map(serviceRow));
  $('[data-appt="total"]').textContent =
    `${appt.total_price_display} · ${minutesLong(appt.service_duration_min)}`;

  // Комментария может не быть — тогда прочерк, как в прототипе.
  $('[data-appt="comment"]').textContent = appt.client_comment || '—';

  // Отменённую запись показываем с причиной: иначе человек не поймёт, почему
  // она в этом статусе. В прототипе такого состояния нет вовсе.
  if (appt.cancel_reason) {
    const reason = document.createElement('p');
    reason.className = 'detail__cancel-reason';
    reason.textContent = `Причина отмены: ${appt.cancel_reason}`;
    $('.detail__head').append(reason);
  }

  $('[data-appt="rules-text"]').textContent = rulesText(appt);

  const reschedule = $('[data-action="reschedule"]');
  if (appt.can_reschedule) {
    reschedule.href = `${RESCHEDULE_PAGE}?id=${appt.id}`;
    reschedule.classList.remove('is-disabled');
    reschedule.removeAttribute('aria-disabled');
  }
  if (appt.can_cancel) {
    $('[data-action="cancel"]').disabled = false;
    setupCancelModal(appt);
  } else {
    // Модалки не будет: отменять нечего. Кнопка остаётся видимой и погашенной,
    // а причина уже сказана в правилах справа.
    $('[data-modal]').remove();
  }

  setupIcs(appt);
  refreshIcons();
}

/* --------------------------------------------------------------- старт */

/** Экран без данных: карточки убираем, на их месте — текст (правило 7). */
const failPage = (message, retry) => pageFailure(
  $('[data-error="appointment"]'), $('[data-detail="body"]'), message, retry,
);

/** Адрес, часы и телефон: своя ошибка, свой «Повторить» — экран без них жив. */
async function loadSettings() {
  const box = $('[data-error="settings"]');
  try {
    settings = await getSettings();
    for (const node of document.querySelectorAll('[data-settings]')) {
      const value = settings[node.dataset.settings];
      if (!value) continue;
      node.textContent = value;
      node.removeAttribute('aria-busy');
    }
    // Адрес мог понадобиться уже собранному .ics — пересобираем с ним.
    if (appointment) setupIcs(appointment);
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    // Пульсирующая заглушка на месте адреса обещала бы данные, которых уже
    // не будет.
    for (const node of document.querySelectorAll('[data-settings][aria-busy]')) {
      node.textContent = '—';
      node.removeAttribute('aria-busy');
    }
    showError(box, null, err, loadSettings);
  }
}

async function loadAppointment() {
  const id = appointmentIdFromUrl();
  if (id === null) {
    failPage('Непонятно, какую запись показать: в адресе нет номера записи. '
      + 'Откройте запись из списка в кабинете.');
    return;
  }
  try {
    appointment = await getAppointment(id);
    render(appointment);
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    // 404 здесь значит и «нет такой записи», и «запись не ваша»: API намеренно
    // не различает их. Повторять такой запрос бессмысленно.
    if (err.status === 404) {
      failPage(`Запись №${id} не найдена. Возможно, она удалена или принадлежит другому аккаунту.`);
      return;
    }
    failPage(`Не удалось загрузить запись. ${err.toText ? err.toText() : err.message}`, loadAppointment);
  }
}

function start() {
  refreshIcons();
  setupLogout();
  // Профиль, запись и настройки студии друг от друга не зависят — грузятся разом.
  loadMe();
  loadAppointment();
  loadSettings();
}

window.addEventListener('load', refreshIcons);
start();
