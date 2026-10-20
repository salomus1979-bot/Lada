'use strict';

/**
 * Лендинг: наполнение блоков данными из API.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 * Витрина услуг и карточки мастеров приходят с сервера; шаги, преимущества,
 * отзывы и FAQ — обычный контент страницы и лежат в разметке
 * (решения 9 и 12 в docs/ui-map.md).
 *
 * Пока ответ не пришёл, на месте данных стоят заглушки из разметки; если
 * запрос не прошёл — на их месте появляется текст ошибки с кнопкой
 * «Повторить» (правило 7).
 */

import { getSettings, getServices, getMasters, getAvailability } from './api.js';
import {
  $, listNode, errorBox, tpl, refreshIcons, fill, fillEmpty, showError,
} from './ui.js';

/** Сколько слотов показывает виджет и как далеко ищет ближайший день. */
const WIDGET_SLOT_LIMIT = 6;
const WIDGET_SEARCH_DAYS = 7;

/**
 * Иконка услуги — оформление, а не данные: в API у услуги иконки нет.
 * Ключ — slug категории из `GET /services`.
 */
const CATEGORY_ICONS = { nails: 'droplet', brows: 'eye' };
const SERVICE_ICON_FALLBACK = 'sparkles';

/* --------------------------------------------------------------- утилиты */

/** Инициалы для кружка-аватара: так же, как их считает API для своих списков. */
function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toLocaleUpperCase('ru-RU'))
    .join('');
}

/** «6 лет», «4 года», «1 год». */
function years(count) {
  const n = Math.abs(Number(count) || 0);
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return `${n} лет`;
  const last = n % 10;
  if (last === 1) return `${n} год`;
  if (last >= 2 && last <= 4) return `${n} года`;
  return `${n} лет`;
}

/** Сегодняшняя дата в поясе салона, а не в поясе браузера. */
function salonToday(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** `YYYY-MM-DD` плюс несколько дней. */
function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Сообщение об ошибке этого блока убирается: данные всё-таки пришли. */
function clearError(name) {
  const box = name && errorBox(name);
  if (box) box.hidden = true;
}

/**
 * Ошибка блока на экране: и сообщение, и заглушки находятся по имени блока —
 * на лендинге их шесть, и каждый отвечает за свой запрос.
 */
const showBlockError = (name, err, retry) => showError(errorBox(name), listNode(name), err, retry);

/* ------------------------------------------------- настройки студии */

async function loadSettings() {
  try {
    const settings = await getSettings();
    for (const node of document.querySelectorAll('[data-settings]')) {
      const value = settings[node.dataset.settings];
      if (!value) continue;
      node.textContent = value;
      node.removeAttribute('aria-busy');
    }
    clearError('settings');
    return settings;
  } catch (err) {
    showBlockError('settings', err, loadSettings);
    // Адрес и телефон не пришли — оставлять на их месте пульсирующие
    // заглушки нельзя, они обещают данные.
    for (const node of document.querySelectorAll('[data-settings][aria-busy]')) {
      node.textContent = '—';
      node.removeAttribute('aria-busy');
    }
    return null;
  }
}

/* ------------------------------------------------------- витрина услуг */

function serviceCard(service, index) {
  const node = tpl('tpl-service').cloneNode(true);
  $('.card__num', node).textContent = `${index + 1}/`;
  $('.tile i', node).setAttribute('data-lucide',
    CATEGORY_ICONS[service.category.slug] || SERVICE_ICON_FALLBACK);
  $('.service__title', node).textContent = service.name;
  $('.service__desc', node).textContent = service.description || '';
  $('.service__meta', node).textContent = `${service.price_display} · ${service.duration_min} мин`;
  return node;
}

function renderServices(services) {
  const node = listNode('services');
  if (services.length === 0) {
    fillEmpty(node, 'Каталог услуг пока пуст.');
    return;
  }
  fill(node, services.map(serviceCard));
}

/* ----------------------------------------------------- карточки мастеров */

function masterCard(master, categoryTitles) {
  const node = tpl('tpl-master').cloneNode(true);
  const photo = $('.master__photo', node);
  if (master.photo_url) {
    const img = document.createElement('img');
    img.src = master.photo_url;
    img.alt = master.display_name;
    photo.replaceChildren(img);
  }
  $('.master__name', node).textContent = master.display_name;
  $('.master__spec', node).textContent =
    `${master.specialization} · опыт ${years(master.experience_years)}`;

  // Чипы — категории услуг мастера. Названия самих услуг длинные
  // («Маникюр с покрытием гель-лаком»), в карточку они не помещаются.
  const chips = $('.master__chips', node);
  for (const title of categoryTitles) {
    const chip = tpl('tpl-chip-static').cloneNode(true);
    chip.textContent = title;
    chips.append(chip);
  }
  return node;
}

/** Категории услуг мастера, в порядке каталога и без повторов. */
function categoriesOf(master, services) {
  const titles = [];
  for (const service of services) {
    if (!master.service_ids.includes(service.id)) continue;
    if (!titles.includes(service.category.title)) titles.push(service.category.title);
  }
  return titles;
}

function renderMasters(masters, services) {
  const node = listNode('masters');
  if (masters.length === 0) {
    fillEmpty(node, 'Мастера пока не добавлены.');
    return;
  }
  fill(node, masters.map((master) => masterCard(master, categoriesOf(master, services))));
}

/* --------------------------------------------------- виджет быстрой записи */

/**
 * Первая пара «услуга + мастер», которая существует: слоты считаются по
 * длительности услуги, поэтому без такой пары запрашивать нечего
 * (решение 10 в docs/ui-map.md).
 */
function defaultPair(services, masters) {
  for (const service of services) {
    const master = masters.find((m) => m.service_ids.includes(service.id));
    if (master) return { service, master };
  }
  return null;
}

function renderWidgetMasters(masters, current) {
  fill(listNode('widget-masters'), masters.map((master) => {
    const node = tpl('tpl-widget-master').cloneNode(true);
    if (current && master.id === current.id) node.classList.add('wm--current');
    $('.avatar', node).textContent = initials(master.display_name);
    $('.wm__name', node).textContent = master.first_name;
    return node;
  }));
}

function renderWidgetServices(services, current) {
  fill(listNode('widget-services'), services.map((service) => {
    const node = tpl('tpl-widget-service').cloneNode(true);
    if (current && service.id === current.id) node.classList.add('chip--current');
    node.textContent = service.name;
    return node;
  }));
}

/** «Сегодня 14:00» у первого слота дня, дальше в тот же день — только время. */
function slotLabel(slot, today, isFirstOfDay) {
  if (!isFirstOfDay) return slot.local_time;
  const [, month, day] = slot.local_date.split('-');
  const prefix = slot.local_date === today ? 'Сегодня'
    : slot.local_date === addDays(today, 1) ? 'Завтра'
      : `${day}.${month}`;
  return `${prefix} ${slot.local_time}`;
}

/**
 * Ближайшие свободные начала визита. API считает слоты на конкретную дату,
 * поэтому «ближайшее время» — это перебор дней вперёд до первых находок.
 */
async function nearestSlots(master, service, today) {
  const found = [];
  for (let shift = 0; shift < WIDGET_SEARCH_DAYS && found.length < WIDGET_SLOT_LIMIT; shift += 1) {
    const date = addDays(today, shift);
    // Дни перебираются по очереди намеренно: как только набрались слоты,
    // остальные запросы не нужны.
    // eslint-disable-next-line no-await-in-loop
    const answer = await getAvailability(master.id, { date, serviceIds: [service.id] });
    found.push(...answer.slots.slice(0, WIDGET_SLOT_LIMIT - found.length));
  }
  return found;
}

async function loadWidgetSlots(master, service, today) {
  const node = listNode('widget-slots');
  try {
    const slots = await nearestSlots(master, service, today);
    if (slots.length === 0) {
      fillEmpty(node, `Свободных окон на ближайшие ${WIDGET_SEARCH_DAYS} дней нет — посмотрите календарь на шаге записи.`);
      return;
    }
    let previousDate = null;
    fill(node, slots.map((slot) => {
      const chip = tpl('tpl-widget-slot').cloneNode(true);
      chip.textContent = slotLabel(slot, today, slot.local_date !== previousDate);
      previousDate = slot.local_date;
      return chip;
    }));
  } catch (err) {
    showBlockError('widget-slots', err, () => {
      node.setAttribute('aria-busy', 'true');
      loadWidgetSlots(master, service, today);
    });
  }
}

/**
 * Виджет — витрина (так он и сделан в прототипе): выбор в нём не меняется,
 * любой элемент ведёт на первый шаг записи. Подсвечены та услуга и тот
 * мастер, чьё свободное время показано ниже, — иначе слоты были бы ничьи.
 */
function renderWidget(services, masters, settings) {
  const pair = defaultPair(services, masters);
  renderWidgetMasters(masters, pair && pair.master);
  renderWidgetServices(services, pair && pair.service);

  if (!pair) {
    fillEmpty(listNode('widget-slots'), 'Онлайн-запись откроется, когда у мастеров появятся услуги.');
    return;
  }
  const today = salonToday(settings ? settings.timezone : undefined);
  loadWidgetSlots(pair.master, pair.service, today);
}

/* ------------------------------------------------------------ каталог */

/** Услуги и мастера нужны и секциям, и виджету — грузятся один раз. */
async function loadCatalog(settings) {
  const [servicesResult, mastersResult] = await Promise.allSettled([
    getServices(), getMasters(),
  ]);

  const services = servicesResult.status === 'fulfilled' ? servicesResult.value : null;
  const masters = mastersResult.status === 'fulfilled' ? mastersResult.value : null;

  if (services) renderServices(services);
  else showBlockError('services', servicesResult.reason, () => loadCatalog(settings));

  if (masters) renderMasters(masters, services || []);
  else showBlockError('masters', mastersResult.reason, () => loadCatalog(settings));

  if (services && masters) {
    renderWidget(services, masters, settings);
  } else {
    // Виджет собирается из тех же двух ответов: если их нет, сообщение об
    // ошибке уже показано у секции, а в виджете остаётся пустая строка.
    const reason = servicesResult.reason || mastersResult.reason;
    showBlockError('widget-masters', reason, () => loadCatalog(settings));
    for (const name of ['widget-services', 'widget-slots']) {
      const node = listNode(name);
      node.replaceChildren();
      node.removeAttribute('aria-busy');
    }
  }
}

/* ---------------------------------------------------------------- FAQ */

/** Аккордеон — локальное состояние страницы, без запросов. */
function setupFaq() {
  const questions = document.querySelectorAll('.faq__q');
  for (const question of questions) {
    question.addEventListener('click', () => {
      const open = question.getAttribute('aria-expanded') === 'true';
      for (const other of questions) {
        other.setAttribute('aria-expanded', 'false');
        document.getElementById(other.getAttribute('aria-controls')).hidden = true;
      }
      if (!open) {
        question.setAttribute('aria-expanded', 'true');
        document.getElementById(question.getAttribute('aria-controls')).hidden = false;
      }
    });
  }
}

/* --------------------------------------------------------------- старт */

async function start() {
  setupFaq();
  refreshIcons();
  const settings = await loadSettings();
  await loadCatalog(settings);
}

window.addEventListener('load', refreshIcons);
start();
