'use strict';

/**
 * Шаг 3 воронки: дата и время. Структура, тексты и порядок блоков — из
 * «3. Запись - Шаг 3. Дата и время.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /masters/:id/availability?date=&service_ids=` (слоты,
 * длительность и сумма), `GET /settings` (`slot_step_min` и
 * `booking_horizon_months` — горизонт записи), `POST /holds` на выбранный
 * слот. Сам календарь, слоты и удержание живут в booking-slots.js — та же
 * механика нужна экрану 6.
 *
 * Сверх строки карты — `GET /services` и `GET /masters?service_ids=…`: из них
 * собирается сводка «мастер · услуги · длительность · сумма», которая в
 * прототипе зашита в разметку. Для «любого свободного мастера» список
 * подходящих нужен ещё и чтобы спросить доступность у каждого (п. 16 карты).
 *
 * Выбор клиента — в store.js, общий на все шаги: здесь к услугам и мастеру
 * дописывается выбранный слот.
 */

import { getSettings, getServices, getMasters, getCurrentHold } from './api.js';
import { getSelection, setMasterId, getSlot } from './store.js';
import { createPicker } from './booking-slots.js';
import {
  $, refreshIcons, rubles, minutesLong, showError,
} from './ui.js';
import {
  zoned, salonToday, pageFailureLink, setupExit, setupHoldAwareLinks, PAGES,
} from './booking-shell.js';

/** Что уже известно о визите и чем выбирается время. */
let picker = null;

/* ----------------------------------------------------------- отрисовка */

/** Сводка шагов 1 и 2 со ссылками «Изменить» — как в прототипе. */
function renderSummary({ masterName, services }) {
  const names = services.map((service) => service.name).join(', ');
  const duration = services.reduce((sum, service) => sum + service.duration_min, 0);
  const price = services.reduce((sum, service) => sum + service.price_kopecks, 0);

  const summary = $('[data-summary]');
  const text = document.createElement('span');
  text.textContent = `${masterName} · ${names} · ${minutesLong(duration)} · `;
  const total = document.createElement('span');
  total.className = 'bk-summary__total';
  total.textContent = rubles(price);

  const toMaster = document.createElement('a');
  toMaster.href = PAGES.master;
  toMaster.dataset.backLink = '';
  toMaster.textContent = 'Изменить мастера';
  const toServices = document.createElement('a');
  toServices.href = PAGES.services;
  toServices.dataset.backLink = '';
  toServices.textContent = 'Изменить услуги';

  summary.replaceChildren(text, total, toMaster, toServices);
  summary.removeAttribute('aria-busy');
}

/** Нижняя панель: пока слот не выбран, дальше идти не с чем. */
function renderNext(slot) {
  const next = $('[data-next]');
  const hint = $('[data-hint]');
  next.classList.toggle('btn--off', slot === null);
  next.setAttribute('aria-disabled', String(slot === null));
  if (slot === null) next.removeAttribute('href');
  else next.setAttribute('href', PAGES.confirm);
  hint.hidden = slot !== null;
}

/** Экран, которому нечего показать: вместо календаря — текст и шаг назад. */
function requireStep(message, { href, label }) {
  const summary = $('[data-summary]');
  summary.replaceChildren();
  summary.removeAttribute('aria-busy');
  pageFailureLink($('[data-error="page"]'), $('[data-body]'), message, { href, label });
}

/* -------------------------------------------------------------- старт */

async function load() {
  const { serviceIds, masterId } = getSelection();

  if (serviceIds.length === 0) {
    requireStep('Сначала выберите услуги: от их состава зависит длительность визита, '
      + 'а значит и свободное время.', { href: PAGES.services, label: 'Выбрать услуги' });
    return;
  }
  if (masterId === null) {
    requireStep('Сначала выберите мастера: свободное время у каждого своё.',
      { href: PAGES.master, label: 'Выбрать мастера' });
    return;
  }

  try {
    // Подходящие мастера — те, кто выполняет ВСЕ выбранные услуги: решает
    // сервер, а не страница.
    const [settings, services, eligible] = await Promise.all([
      getSettings(), getServices(), getMasters({ serviceIds }),
    ]);

    const chosen = serviceIds
      .map((id) => services.find((service) => service.id === id))
      .filter(Boolean);

    if (eligible.length === 0) {
      requireStep('Ни один мастер не выполняет все выбранные услуги — визит делает '
        + 'один мастер целиком. Измените состав услуг.',
      { href: PAGES.services, label: 'Изменить состав услуг' });
      return;
    }

    // Выбранный раньше мастер мог перестать подходить (или быть скрыт) —
    // тогда возвращаем человека на шаг 2, а не показываем чужие слоты.
    const master = masterId === 'any'
      ? null
      : eligible.find((item) => item.id === masterId);
    if (masterId !== 'any' && !master) {
      setMasterId(null);
      requireStep('Выбранный мастер больше не выполняет все эти услуги. Выберите мастера заново.',
        { href: PAGES.master, label: 'Выбрать мастера' });
      return;
    }

    renderSummary({
      masterName: master ? master.display_name : 'Любой свободный мастер',
      services: chosen,
    });

    picker = createPicker({
      settings,
      serviceIds,
      masterId,
      masters: eligible,
      onChange: renderNext,
    });

    // Человек мог прийти сюда с шага 4 по «Изменить»: открываем тот день, на
    // котором он остановился, и возвращаем выбор вместе с удержанием.
    const slot = getSlot();
    const sameDay = slot ? zoned(slot.startsAt, settings.timezone).date : null;
    const future = sameDay !== null && sameDay >= salonToday(settings.timezone);
    // Удержание спрашиваем только для вошедшего: гостю `POST /holds`
    // недоступен, и `GET /holds/current` ответил бы 401.
    let hold = null;
    if (future) {
      try {
        hold = await getCurrentHold();
      } catch {
        hold = null; // 401 у гостя — не ошибка экрана: время просто не держится
      }
    }

    await picker.start({
      date: future ? sameDay : undefined,
      restore: future ? { startsAt: slot.startsAt, hold } : undefined,
    });
  } catch (err) {
    showError($('[data-error="page"]'), null, err, load);
  }
}

/* Уход с шага освобождает слот: «Выйти», «Назад» и «Изменить …». */
setupExit(() => (picker ? picker.getHoldToken() : null));
setupHoldAwareLinks('[data-back-link]', () => (picker ? picker.getHoldToken() : null));

refreshIcons();
renderNext(null);
load();
