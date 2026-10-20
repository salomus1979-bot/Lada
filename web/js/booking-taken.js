'use strict';

/**
 * Экран 6 «Ошибка — время занято». Структура, тексты и порядок блоков — из
 * «6. Ошибка - время занято.dc.html».
 *
 * Экран открывается только из шага 4: слот перехватили, пока человек
 * оформлял запись, и `POST /appointments` ответил 409 с
 * `details.reason = 'overlap'`. Что именно перехватили и что сервер предложил
 * взамен (`details.nearest_slots`), шаг 4 передал через store.js.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /masters/:id/availability?date=&service_ids=` (пересчёт
 * свободного времени на лету), «Подтвердить новое время» → `POST /holds` на
 * выбранный слот и `POST /appointments` заново. Календарь, слоты и удержание —
 * общие с шагом 3 (booking-slots.js).
 *
 * Комментарий и согласие берутся из того же переноса: человек дал их минуту
 * назад на шаге 4, и спрашивать второй раз в одном оформлении не за что.
 */

import {
  getSettings, getServices, getMasters, createAppointment,
} from './api.js';
import { getSelection, takeConflict, setConflict, clearSelection } from './store.js';
import { createPicker } from './booking-slots.js';
import {
  $, listNode, refreshIcons, rubles, minutesLong, dateDisplay, showError,
} from './ui.js';
import { pageFailureLink, setupExit, authHref, PAGES } from './booking-shell.js';

/** Что перехватили и с чем человек пришёл с шага 4. */
let conflict = null;
let visit = null;
let picker = null;

/* ----------------------------------------------------------- отрисовка */

/** Строка «мастер · услуги · длительность · сумма» — как в прототипе. */
function renderSummary() {
  const { master, services } = visit;
  const names = services.map((service) => service.name).join(', ');
  const duration = services.reduce((sum, service) => sum + service.duration_min, 0);
  const price = services.reduce((sum, service) => sum + service.price_kopecks, 0);

  const summary = $('[data-summary]');
  const icon = document.createElement('i');
  icon.className = 'icon';
  icon.dataset.lucide = 'user';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = `${master.display_name} · ${names} · ${minutesLong(duration)} · `;
  const total = document.createElement('span');
  total.className = 'bk-summary__total';
  total.textContent = rubles(price);

  summary.replaceChildren(icon, text, total);
  summary.removeAttribute('aria-busy');
  refreshIcons();
}

/** Ближайшее свободное время из ответа 409 — кнопками, как подсказка. */
function renderNearest() {
  const box = listNode('nearest');
  const slots = conflict.nearestSlots.filter((slot) => slot && slot.at_utc);
  if (slots.length === 0) {
    box.hidden = true;
    return;
  }

  const label = document.createElement('span');
  label.className = 'nearest__label';
  label.textContent = 'Ближайшее свободное время:';

  const buttons = slots.map((slot) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'slot nearest__slot';
    node.textContent = `${dateDisplay(slot.local_date)}, ${slot.local_time}`;
    node.addEventListener('click', async () => {
      await picker.selectDate(slot.local_date);
      // Кнопка того же времени уже на экране — нажимаем её, чтобы слот
      // удержался обычным путём.
      const same = [...listNode('slots').querySelectorAll('.slots__slot')]
        .find((button) => !button.disabled && button.textContent === slot.local_time);
      if (same) same.click();
    });
    return node;
  });

  box.replaceChildren(label, ...buttons);
  box.hidden = false;
}

/** Выбран слот — можно подтверждать; снят — нельзя. */
function renderConfirm(slot) {
  $('[data-action="confirm"]').disabled = slot === null;
}

function setBusy(busy) {
  const button = $('[data-action="confirm"]');
  button.disabled = busy;
  if (busy) {
    const icon = document.createElement('i');
    icon.className = 'icon confirm__spinner';
    icon.dataset.lucide = 'loader-2';
    icon.setAttribute('aria-hidden', 'true');
    button.replaceChildren(icon, document.createTextNode('Подтверждаем запись…'));
    refreshIcons();
  } else {
    button.replaceChildren(document.createTextNode('Подтвердить новое время'));
  }
}

/* ------------------------------------------------------- подтверждение */

async function confirm() {
  const slot = picker.getPick();
  if (!slot) return;
  const box = $('[data-error="confirm"]');
  box.hidden = true;
  setBusy(true);

  try {
    const appointment = await createAppointment({
      masterId: slot.masterId,
      serviceIds: visit.serviceIds,
      startsAt: slot.at_utc,
      clientComment: conflict.comment,
      holdToken: picker.getHoldToken() || undefined,
      consent: conflict.consent === true,
    });
    clearSelection();
    window.location.assign(`${PAGES.done}?id=${appointment.id}`);
  } catch (err) {
    if (err.status === 401) {
      window.location.assign(authHref(PAGES.login, PAGES.confirm));
      return;
    }
    if (err.status === 409 && err.details && err.details.reason === 'overlap') {
      // Перехватили и это время: экран остаётся тем же, меняются подсказки и
      // пометка «только что занято».
      conflict = {
        ...conflict,
        startsAt: slot.at_utc,
        lostDate: slot.local_date,
        lostTime: slot.local_time,
        nearestSlots: Array.isArray(err.details.nearest_slots) ? err.details.nearest_slots : [],
      };
      // В хранилище тоже: перезагрузка страницы покажет уже этот конфликт.
      setConflict(conflict);
      renderAlert();
      renderNearest();
      setBusy(false);
      renderConfirm(null);
      picker.setTaken({ date: conflict.lostDate, time: conflict.lostTime });
      await picker.selectDate(conflict.lostDate);
      return;
    }
    setBusy(false);
    renderConfirm(picker.getPick());
    box.replaceChildren(document.createTextNode(
      `Запись не создана. ${err.toText ? err.toText() : err.message}`,
    ));
    box.hidden = false;
  }
}

/** Текст сверху: какое время ушло. */
function renderAlert() {
  $('[data-taken="text"]').textContent =
    `Пока вы подтверждали запись, время ${conflict.lostTime} `
    + `(${dateDisplay(conflict.lostDate)}) занял другой клиент. `
    + 'Выберите другое время — остальной выбор мы сохранили.';
}

/* -------------------------------------------------------------- старт */

async function load() {
  const { serviceIds } = getSelection();

  if (!conflict || serviceIds.length === 0) {
    // Страницу открыли напрямую или выбор уже стёрт: показывать конфликт,
    // которого не было, нельзя — плашку «это время заняли» тоже.
    $('[data-alert]').hidden = true;
    pageFailureLink($('[data-error="page"]'), $('[data-body]'),
      'Этот экран показывается, только если выбранное время заняли во время '
      + 'оформления. Выберите время заново.',
      { href: PAGES.time, label: 'Выбрать время' });
    return;
  }

  renderAlert();

  try {
    const [settings, services, eligible] = await Promise.all([
      getSettings(), getServices(), getMasters({ serviceIds }),
    ]);

    const chosen = serviceIds
      .map((id) => services.find((service) => service.id === id))
      .filter(Boolean);
    const master = eligible.find((item) => item.id === conflict.masterId);
    if (!master) {
      pageFailureLink($('[data-error="page"]'), $('[data-body]'),
        'Мастер больше не выполняет все выбранные услуги. Выберите мастера заново.',
        { href: PAGES.master, label: 'Выбрать мастера' });
      return;
    }

    visit = { serviceIds, services: chosen, master, settings };
    renderSummary();
    renderNearest();

    // Новое время ищем у того же мастера, у которого ушёл слот: «любой
    // свободный мастер» на этом экране уже сведён к конкретному человеку.
    picker = createPicker({
      settings,
      serviceIds,
      masterId: master.id,
      masters: [master],
      onChange: renderConfirm,
    });
    await picker.start({
      date: conflict.lostDate,
      taken: { date: conflict.lostDate, time: conflict.lostTime },
    });
  } catch (err) {
    showError($('[data-error="page"]'), null, err, load);
  }
}

conflict = takeConflict();

$('[data-action="confirm"]').addEventListener('click', confirm);
setupExit(() => (picker ? picker.getHoldToken() : null));

refreshIcons();
load();
