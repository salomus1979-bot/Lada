'use strict';

/**
 * Шаг 1 воронки: выбор услуг.
 *
 * Данные — `GET /service-categories` и `GET /services` через api.js
 * (правило 3). Выбор клиента живёт в store.js, одном на все шаги.
 *
 * Про «Итого» и «Длительность». Эндпоинта, который посчитал бы сумму по
 * набору услуг, в API нет: единственный, кто возвращает `total_price_display`
 * и `service_duration_min`, — `GET /masters/:id/availability`, а ему нужны
 * мастер и дата, которых на этом шаге ещё нет. Поэтому цена и длительность
 * каждой услуги берутся из ответа сервера как есть, а складывает их страница.
 * Складывает ровно так же, как сервер: он тоже суммирует `price_kopecks` и
 * `duration_min` выбранных услуг (api/src/lib/availability.js), без буферов
 * уборки — они внутренние и наружу не отдаются.
 */

import { getServices, getServiceCategories } from './api.js';
import { getServiceIds, toggleService, removeService } from './store.js';
import {
  $, listNode, errorBox, tpl, refreshIcons, showError, rubles, minutesLong,
} from './ui.js';
import { setupExit } from './booking-shell.js';

/** Все услуги каталога: id → услуга. Заполняется один раз при загрузке. */
let catalog = new Map();
/** Текущий фильтр категорий: slug или null («Все»). */
let activeCategory = null;

/* ----------------------------------------------------------- формат */

/** «90 мин» для строки услуги. */
const minutesShort = (min) => `${min} мин`;

/* ------------------------------------------------------------ ошибка */

/**
 * Услуги не пришли — гаснут и они, и табы категорий: табы без услуг
 * переключали бы пустоту.
 */
function showServicesError(err, retry) {
  showError(
    errorBox('services'), [listNode('services'), listNode('categories')], err, retry,
    'Не удалось загрузить услуги.',
  );
}

/* ------------------------------------------------------------ корзина */

/**
 * Карточка визита: выбранные услуги, сумма, длительность и кнопка дальше.
 * Пока ничего не выбрано — кнопка неактивна, и рядом сказано, чего не хватает.
 */
function renderCart() {
  const ids = getServiceIds().filter((id) => catalog.has(id));
  const chosen = ids.map((id) => catalog.get(id));

  const list = listNode('cart');
  list.replaceChildren(...chosen.map((service) => {
    const node = tpl('tpl-cart-row').cloneNode(true);
    $('.cart__row-name', node).textContent = service.name;
    $('.cart__row-time', node).textContent = minutesShort(service.duration_min);
    $('.cart__row-price', node).textContent = service.price_display;
    $('.cart__drop', node).addEventListener('click', () => {
      removeService(service.id);
      renderAll();
    });
    return node;
  }));

  const empty = chosen.length === 0;
  const totals = $('[data-cart-totals]');
  totals.hidden = empty;
  $('[data-cart-empty]').hidden = !empty;
  $('[data-cart]').classList.toggle('cart--empty', empty);

  if (!empty) {
    const price = chosen.reduce((sum, service) => sum + service.price_kopecks, 0);
    const duration = chosen.reduce((sum, service) => sum + service.duration_min, 0);
    $('[data-cart="price"]').textContent = rubles(price);
    $('[data-cart="duration"]').textContent = minutesLong(duration);
  }

  // «Выбрать мастера» — ссылка на следующий шаг; пока услуг нет, она
  // выключена: переходить с пустым выбором некуда.
  const next = $('[data-next]');
  next.classList.toggle('btn--off', empty);
  next.setAttribute('aria-disabled', String(empty));
  if (empty) next.removeAttribute('href');
  else next.setAttribute('href', 'booking-master.html');

  refreshIcons();
}

/* ------------------------------------------------------------ каталог */

function serviceRow(service, selectedIds) {
  const node = tpl('tpl-service-row').cloneNode(true);
  const on = selectedIds.includes(service.id);
  node.classList.toggle('srv-row--on', on);
  node.setAttribute('aria-pressed', String(on));
  $('.srv-row__name', node).textContent = service.name;
  $('.srv-row__desc', node).textContent = service.description || '';
  $('.srv-row__time', node).textContent = minutesShort(service.duration_min);
  $('.srv-row__price', node).textContent = service.price_display;
  node.addEventListener('click', () => {
    toggleService(service.id);
    renderAll();
  });
  return node;
}

/** Группы услуг по категориям — в порядке каталога, с учётом фильтра. */
function renderServices(categories) {
  const selected = getServiceIds();
  const list = listNode('services');
  const groups = [];

  for (const category of categories) {
    if (activeCategory && category.slug !== activeCategory) continue;
    const items = [...catalog.values()].filter((s) => s.category.slug === category.slug);
    if (items.length === 0) continue;

    const group = tpl('tpl-service-group').cloneNode(true);
    $('.srv-group__title', group).textContent = category.title;
    $('.srv-list', group).replaceChildren(...items.map((s) => serviceRow(s, selected)));
    groups.push(group);
  }

  if (groups.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'В этой категории пока нет услуг.';
    groups.push(note);
  }

  list.replaceChildren(...groups);
  list.removeAttribute('aria-busy');
}

/** Табы категорий. «Все» в прототипе нет — см. отчёт и README. */
function renderTabs(categories) {
  const node = listNode('categories');
  const tabs = [{ slug: null, title: 'Все' }, ...categories];

  node.replaceChildren(...tabs.map((category) => {
    const tab = tpl('tpl-cat-tab').cloneNode(true);
    tab.textContent = category.title;
    tab.classList.toggle('chip--current', activeCategory === category.slug);
    tab.setAttribute('aria-pressed', String(activeCategory === category.slug));
    tab.addEventListener('click', () => {
      activeCategory = category.slug;
      renderTabs(categories);
      renderServices(categories);
    });
    return tab;
  }));
  node.removeAttribute('aria-busy');
}

let loadedCategories = [];

function renderAll() {
  renderServices(loadedCategories);
  renderCart();
}

/* -------------------------------------------------------------- старт */

async function load() {
  try {
    const [categories, services] = await Promise.all([getServiceCategories(), getServices()]);
    loadedCategories = categories;
    catalog = new Map(services.map((service) => [service.id, service]));
    renderTabs(categories);
    renderAll();
  } catch (err) {
    showServicesError(err, load);
  }
}

// «Выйти» из воронки — с подтверждением и стиранием выбора: общий код шагов,
// см. booking-shell.js.
setupExit();

refreshIcons();
renderCart();
load();
