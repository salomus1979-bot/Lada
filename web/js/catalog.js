'use strict';

/**
 * Каталог услуг и прайс: структура, тексты и порядок блоков — из
 * «18. Каталог услуг и прайс.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 * Категории и услуги приходят с сервера по строке карты экранов:
 * `GET /service-categories`, затем `GET /services?category=<slug>` на каждую
 * категорию. Сколько категорий и услуг получится — решает ответ, а не макет:
 * в прототипе нарисованы четыре категории по три услуги, в данных их две и
 * шесть.
 *
 * Пока ответ не пришёл, на месте данных стоят заглушки той же формы; если
 * запрос не прошёл — на их месте текст ошибки с кнопкой «Повторить»
 * (правило 7).
 *
 * Корзина локальная: выбор услуг никуда не отправляется (так же в прототипе,
 * и в карте экранов у «Добавить к записи» эндпоинта нет).
 */

import { getSettings, getServiceCategories, getServices, getMasters } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, fillEmpty, showError, rubles, minutesLong,
} from './ui.js';

/* --------------------------------------------------------------- форматы */

/** «Выбрана 1 услуга», «Выбрано 2 услуги», «Выбрано 5 услуг». */
function chosenWords(count) {
  const tail = count % 100;
  const last = count % 10;
  const one = last === 1 && tail !== 11;
  const few = last >= 2 && last <= 4 && (tail < 11 || tail > 14);
  return `${one ? 'Выбрана' : 'Выбрано'} ${count} ${one ? 'услуга' : few ? 'услуги' : 'услуг'}`;
}

/* ------------------------------------------------- настройки студии */

/** Телефон в блоке «Не нашли нужную услугу», адрес и режим работы в подвале. */
async function loadSettings() {
  const box = $('[data-error="settings"]');
  try {
    const settings = await getSettings();
    for (const node of document.querySelectorAll('[data-settings]')) {
      const value = settings[node.dataset.settings];
      if (!value) continue;
      node.textContent = value;
      node.removeAttribute('aria-busy');
    }
    box.hidden = true;
  } catch (err) {
    showError(box, null, err, loadSettings);
    // Телефон и адрес не пришли — пульсирующая заглушка на их месте
    // обещала бы данные, которых уже не будет.
    for (const node of document.querySelectorAll('[data-settings][aria-busy]')) {
      node.textContent = '—';
      node.removeAttribute('aria-busy');
    }
  }
}

/* ----------------------------------------------------------- корзина */

/** Выбранные услуги: id → услуга. Живёт только в этой странице. */
const cart = new Map();

function renderCart() {
  const panel = $('[data-cart="panel"]');
  if (cart.size === 0) {
    panel.hidden = true;
    return;
  }
  let kopecks = 0;
  let minutes = 0;
  for (const service of cart.values()) {
    kopecks += service.price_kopecks;
    minutes += service.duration_min;
  }
  $('[data-cart="summary"]').textContent =
    `${chosenWords(cart.size)} · ${rubles(kopecks)} · ${minutesLong(minutes)}`;
  panel.hidden = false;
}

/**
 * «Добавить к записи» — переключатель: повторное нажатие убирает услугу.
 * В прототипе кнопка сразу уводила на первый шаг записи, но тогда набирать
 * состав было бы негде, а панель корзины внизу показывала бы чужой выбор.
 */
function setupAddButton(button, card, service) {
  button.addEventListener('click', () => {
    const picked = cart.has(service.id);
    if (picked) cart.delete(service.id);
    else cart.set(service.id, service);

    button.setAttribute('aria-pressed', String(!picked));
    button.textContent = picked ? 'Добавить к записи' : 'Добавлено';
    card.classList.toggle('srv--picked', !picked);
    renderCart();
  });
}

/* ------------------------------------------------------------ каталог */

/** Имена мастеров по услуге: «Выполняют: Анна, Елена». */
function mastersByService(masters) {
  const byService = new Map();
  for (const master of masters) {
    for (const id of master.service_ids) {
      if (!byService.has(id)) byService.set(id, []);
      byService.get(id).push(master.first_name);
    }
  }
  return byService;
}

function serviceCard(service, performers) {
  const node = tpl('tpl-service').cloneNode(true);
  $('.srv__name', node).textContent = service.name;
  $('.srv__desc', node).textContent = service.description || '';
  $('.srv__time-value', node).textContent = `${service.duration_min} мин`;
  $('.srv__price', node).textContent = service.price_display;

  // «Выполняют» в API нет отдельным полем — список собирается из
  // `GET /masters`, где у мастера перечислены его `service_ids`.
  const chip = $('.srv__masters', node);
  const names = performers.get(service.id);
  if (names && names.length > 0) chip.textContent = `Выполняют: ${names.join(', ')}`;
  else chip.remove();

  setupAddButton($('.srv__add', node), node, service);
  return node;
}

/** Услуги одной категории: отдельный запрос, отдельная ошибка. */
async function loadCategory(category, section, performers) {
  const grid = $('.cat__grid', section);
  const box = $('.load-error', section);
  try {
    const services = await getServices({ category: category.slug });
    if (services.length === 0) {
      fillEmpty(grid, 'В этой категории пока нет услуг.');
      return;
    }
    fill(grid, services.map((service) => serviceCard(service, performers)));
    box.hidden = true;
  } catch (err) {
    showError(box, grid, err, () => {
      grid.setAttribute('aria-busy', 'true');
      loadCategory(category, section, performers);
    });
  }
}

function categorySection(category, performers) {
  const node = tpl('tpl-category').cloneNode(true);
  node.id = category.slug;
  $('.cat__title', node).textContent = category.title;
  const desc = $('.cat__desc', node);
  if (category.description) desc.textContent = category.description;
  else desc.remove();
  loadCategory(category, node, performers);
  return node;
}

function categoryLink(category) {
  const node = tpl('tpl-cat-link').cloneNode(true);
  node.href = `#${category.slug}`;
  node.textContent = category.title;
  return node;
}

/**
 * Категории и мастера — одним заходом: без категорий нечего верстать, а без
 * мастеров не собрать строку «Выполняют». Если не пришло ни то, ни другое,
 * ошибка одна на весь прайс: показывать половину экрана незачем.
 */
async function loadCatalog() {
  const catalog = listNode('catalog');
  const nav = listNode('cat-nav');
  const box = $('[data-error="catalog"]');
  try {
    const [categories, masters] = await Promise.all([getServiceCategories(), getMasters()]);
    if (categories.length === 0) {
      nav.replaceChildren();
      nav.removeAttribute('aria-busy');
      fillEmpty(catalog, 'Каталог услуг пока пуст.');
      return;
    }
    const performers = mastersByService(masters);
    fill(nav, categories.map(categoryLink));
    fill(catalog, categories.map((category) => categorySection(category, performers)));
    box.hidden = true;
  } catch (err) {
    nav.replaceChildren();
    nav.removeAttribute('aria-busy');
    showError(box, catalog, err, () => {
      catalog.setAttribute('aria-busy', 'true');
      loadCatalog();
    });
  }
}

/* --------------------------------------------------------------- старт */

/** Прайс и настройки студии друг от друга не зависят — грузятся разом. */
function start() {
  refreshIcons();
  loadSettings();
  loadCatalog();
}

window.addEventListener('load', refreshIcons);
start();
