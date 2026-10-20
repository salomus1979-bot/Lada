'use strict';

/**
 * Экран 5 «Запись создана». Структура, тексты и порядок блоков — из
 * «5. Запись создана.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов данные берутся из ответа `POST /appointments` или
 * `GET /appointments/:id`; шаг 4 уходит сюда с номером созданной записи
 * (`booking-done.html?id=7`), и экран перечитывает её по этому номеру —
 * статус, время и сумму показывает сервер, а не предыдущая страница.
 *
 * Сверх строки карты — `GET /settings`: адрес студии в карточке (в прототипе
 * он зашит) и окно отмены в правилах (решение 13 карты).
 *
 * Выбор в store.js к этому моменту уже стёрт шагом 4: визит создан, и
 * следующая запись начинается с чистого шага 1.
 */

import { getAppointment, getSettings } from './api.js';
import { setupIcsLink } from './ics.js';
import {
  $, refreshIcons, minutesLong, dayDisplay, showError,
} from './ui.js';
import { initials, pageFailureLink, PAGES } from './booking-shell.js';

/** Статусы, у которых чип цветной: остальные остаются нейтральными. */
const STATUS_TONE = {
  confirmed: 'done__status--ok',
  pending: 'done__status--wait',
  cancelled_by_client: 'done__status--off',
  cancelled_by_studio: 'done__status--off',
};

/** Номер записи из адреса: `booking-done.html?id=7`. */
function idFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('id');
  return /^\d+$/.test(String(raw)) ? Number(raw) : null;
}

function renderAppointment(appt, settings) {
  const status = $('[data-done="status"]');
  status.textContent = appt.status_label;
  if (STATUS_TONE[appt.status]) status.classList.add(STATUS_TONE[appt.status]);

  // «Пятница, 23 октября 2026 · 14:00–16:00» — дата и диапазон из ответа API.
  $('[data-done="when"]').textContent =
    `${dayDisplay(appt.starts_at.local_date)} ${appt.starts_at.local_date.slice(0, 4)} · `
    + `${appt.starts_at.local_time}–${appt.ends_at.local_time}`;

  $('[data-done="initials"]').textContent = initials(appt.master.display_name);
  $('[data-done="master"]').textContent = appt.master.display_name;

  $('[data-done="services"]').replaceChildren(...appt.services.map((service) => {
    const row = document.createElement('p');
    row.className = 'done__service';
    row.textContent = service.name;
    return row;
  }));

  $('[data-done="total"]').textContent =
    `${appt.total_price_display} · ${minutesLong(appt.service_duration_min)}`;

  $('[data-done="rules"]').textContent = 'Оплата на месте. Отменить или перенести можно '
    + `в кабинете не позднее чем за ${appt.cancel_window_hours} ч до визита.`;

  if (settings && settings.address) {
    $('[data-done="address"]').textContent = settings.address;
    $('[data-done="place"]').hidden = false;
  }

  setupIcsLink($('[data-action="ics"]'), appt, {
    address: settings ? settings.address : null,
    durationText: minutesLong(appt.service_duration_min),
  });

  $('[data-card]').removeAttribute('aria-busy');
  refreshIcons();
}

async function load() {
  const id = idFromUrl();
  if (id === null) {
    pageFailureLink($('[data-error="page"]'), $('[data-body]'),
      'Непонятно, какую запись показывать: в адресе нет её номера. '
      + 'Свои записи видно в личном кабинете.',
      { href: PAGES.account, label: 'В личный кабинет' });
    return;
  }

  try {
    // Настройки не обязательны: без них не будет только адреса в карточке.
    const [appt, settings] = await Promise.all([
      getAppointment(id),
      getSettings().catch(() => null),
    ]);
    renderAppointment(appt, settings);
  } catch (err) {
    if (err.status === 401) {
      // Сессия кончилась: своя запись видна только вошедшему. Вход без
      // `next` — дальше кабинет, где запись и так в списке.
      window.location.replace(PAGES.login);
      return;
    }
    if (err.status === 404) {
      pageFailureLink($('[data-error="page"]'), $('[data-body]'),
        `Запись №${id} не найдена — возможно, она принадлежит другому аккаунту.`,
        { href: PAGES.account, label: 'В личный кабинет' });
      return;
    }
    showError($('[data-error="page"]'), null, err, load);
  }
}

refreshIcons();
load();
