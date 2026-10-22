'use strict';

/**
 * Админ-панель, раздел «Услуги» — экраны `31. Админ - Услуги` и
 * `32. Админ - Услуга (форма)` прототипа.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /admin/services?include_inactive=1` (прайс целиком,
 * включая отключённые) и `GET /admin/masters` — инициалы в колонке
 * «Выполняют». Категории для формы — `GET /service-categories`.
 *
 * Действия: `POST /admin/services`, `PATCH /admin/services/:id` (правка,
 * включение и отключение), `DELETE /admin/services/:id`.
 *
 * ПРО УДАЛЕНИЕ. Кнопка «Удалить» ничего не решает — решает сервер. Если на
 * услугу не ссылается ни одна запись, он удаляет строку из базы; если
 * ссылается, он её отключает и объясняет, почему. Экран показывает его ответ,
 * а не придумывает свой: это единственное место, где известна правда про
 * ссылки.
 *
 * ПРО ОТКЛЮЧЁННЫЕ СТРОКИ. Администратор видит их все, с пометкой; клиенту они
 * не показываются вовсе — `GET /services` отдаёт только активные и видимые,
 * и это решает API, а не фильтр на экране.
 */

import {
  getAdminServices, getAdminMasters, getServiceCategories,
  createService, updateService, deleteService, getMe,
} from './api.js';
import {
  $, listNode, errorBox, tpl, fill, fillEmpty, showError, refreshIcons,
  rubles, minutesLong,
} from './ui.js';
import {
  clearErrors, clearErrorOnInput, applyApiError, setFieldError, showFormError,
  submitting, field,
} from './auth-form.js';
import { initials } from './admin-shell.js';

/** Что показывают табы: все строки, только видимые клиенту, только отключённые. */
let tab = 'all';
/** Последние загруженные данные — чтобы таб переключался без запроса. */
let services = [];
let masters = [];
let categories = [];
/** Цену назначает только владелец: от этого зависит, доступно ли поле. */
let isOwner = false;
/** Какую услугу правим; null — заводим новую. */
let editing = null;

const form = $('#service-form');
const modal = $('[data-modal]');
const note = $('[data-note]');

/* ----------------------------------------------------------- сообщения */

/** Ответ сервера на действие — на экране, а не в консоли (правило 7). */
function showNote(text, done = false) {
  note.textContent = text;
  note.classList.toggle('adm-note--done', done);
  note.hidden = false;
}

/* -------------------------------------------------------------- список */

/** Состояние строки одной фразой: что видит клиент и почему. */
function stateOf(service) {
  if (!service.is_active) return { label: 'Отключена — есть записи', mod: 'archived' };
  if (!service.is_visible) return { label: 'Скрыта от клиентов', mod: 'off' };
  return { label: 'В каталоге', mod: 'on' };
}

const isOff = (service) => !service.is_active || !service.is_visible;

/** Инициалы мастеров, которые выполняют услугу, — колонка «Выполняют». */
function mastersOf(serviceId) {
  return masters
    .filter((master) => master.service_ids.includes(serviceId))
    .map((master) => initials(`${master.first_name} ${master.last_name}`));
}

function serviceRow(service) {
  const node = tpl('tpl-service').cloneNode(true);
  const state = stateOf(service);

  $('[data-cell="name"]', node).textContent = service.name;
  const badge = $('[data-cell="state"]', node);
  badge.textContent = state.label;
  badge.classList.add(`adm-badge--${state.mod}`);
  $('[data-cell="description"]', node).textContent = service.description || '';
  $('[data-cell="duration"]', node).textContent = minutesLong(service.duration_min);
  // Услуга без цены — это услуга, которой владелец цену ещё не назначил.
  $('[data-cell="price"]', node).textContent = service.price_kopecks > 0
    ? rubles(service.price_kopecks) : 'цена не назначена';

  const performers = mastersOf(service.id);
  $('[data-cell="masters"]', node).textContent = performers.length > 0
    ? performers.join(', ') : 'никто';

  if (isOff(service)) node.classList.add('adm-row--off');

  const toggle = $('[data-action="toggle"]', node);
  toggle.setAttribute('aria-checked', String(!isOff(service)));
  toggle.setAttribute('aria-label', isOff(service)
    ? `Включить услугу «${service.name}»` : `Отключить услугу «${service.name}»`);
  toggle.addEventListener('click', () => toggleService(service, toggle));

  $('[data-action="edit"]', node).addEventListener('click', () => openForm(service));
  $('[data-action="delete"]', node)
    .addEventListener('click', (event) => removeService(service, event.currentTarget));

  return node;
}

/** Строки по категориям — так же, как прайс показан на экране 31. */
function render() {
  const box = listNode('services');
  const visible = services.filter((service) => {
    if (tab === 'on') return !isOff(service);
    if (tab === 'off') return isOff(service);
    return true;
  });

  if (visible.length === 0) {
    fillEmpty(box, tab === 'all'
      ? 'Услуг пока нет. Добавьте первую — она появится в каталоге у клиентов.'
      : 'В этом списке пусто.');
    return;
  }

  const groups = [];
  for (const category of categories) {
    const rows = visible.filter((service) => service.category.id === category.id);
    if (rows.length === 0) continue;

    const group = tpl('tpl-group').cloneNode(true);
    $('.adm-group__title', group).textContent = `${category.title} · ${rows.length}`;
    $('.adm-table', group).append(...rows.map(serviceRow));
    groups.push(group);
  }
  fill(box, groups);
}

/* ------------------------------------------------- включение/отключение */

/**
 * Переключатель «показывать клиентам».
 *
 * Отключённую услугу (её отключил сервер, когда на неё сослались записи)
 * включение возвращает целиком: и `is_active`, и `is_visible`. Иначе строка
 * осталась бы невидимой при включённом переключателе.
 */
async function toggleService(service, button) {
  const turningOn = isOff(service);
  button.disabled = true;
  try {
    const updated = await updateService(service.id, turningOn
      ? { isActive: true, isVisible: true }
      : { isVisible: false });
    Object.assign(service, updated);
    showNote(turningOn
      ? `Услуга «${service.name}» снова доступна клиентам.`
      : `Услуга «${service.name}» скрыта от клиентов. Уже созданные записи это не затронет.`, true);
    render();
  } catch (err) {
    button.disabled = false;
    showError(errorBox('services'), null, err, null, 'Не удалось изменить услугу.');
  }
}

/* ------------------------------------------------------------ удаление */

/**
 * «Удалить» — это запрос, а не решение экрана. Ответ сервера показывается
 * как есть: он единственный знает, ссылается ли на услугу хоть одна запись.
 */
async function removeService(service, button) {
  // Подтверждение прямо в строке, а не окном браузера: так же сделана отмена
  // записи в кабинете клиента (экран 7). Первый клик спрашивает, второй — удаляет.
  if (button.dataset.confirm !== 'yes') {
    button.dataset.confirm = 'yes';
    button.textContent = 'Точно удалить?';
    return;
  }
  button.disabled = true;
  try {
    const result = await deleteService(service.id);
    if (result.deleted) {
      services = services.filter((row) => row.id !== service.id);
      showNote(`Услуга «${service.name}» удалена: на неё не ссылалась ни одна запись.`, true);
    } else {
      // Сервер отключил услугу вместо удаления — и сказал, почему.
      Object.assign(service, { is_active: false, is_visible: false });
      showNote(result.message);
    }
    render();
  } catch (err) {
    button.disabled = false;
    button.dataset.confirm = '';
    button.textContent = 'Удалить';
    showError(errorBox('services'), null, err, null, 'Не удалось удалить услугу.');
  }
}

/* --------------------------------------------------------------- форма */

function fillCategories() {
  const select = field(form, 'category_id');
  select.replaceChildren(...categories.map((category) => {
    const option = document.createElement('option');
    option.value = String(category.id);
    option.textContent = category.title;
    return option;
  }));
}

function openForm(service = null) {
  editing = service;
  clearErrors(form);
  $('[data-form-title]').textContent = service ? 'Изменение услуги' : 'Новая услуга';

  field(form, 'name').value = service ? service.name : '';
  field(form, 'category_id').value = String(service ? service.category.id : (categories[0] || {}).id || '');
  field(form, 'duration_min').value = service ? service.duration_min : '';
  field(form, 'buffer_after_min').value = service ? service.buffer_after_min : 0;
  field(form, 'description').value = service ? (service.description || '') : '';
  field(form, 'is_visible').checked = service ? (service.is_visible && service.is_active) : true;

  const price = field(form, 'price');
  price.value = service && service.price_kopecks > 0 ? service.price_kopecks / 100 : '';
  price.disabled = !isOwner;
  $('[data-price-note]').textContent = isOwner
    ? 'Цену видит клиент в каталоге'
    : 'Цену назначает владелец — поле недоступно';

  modal.hidden = false;
  field(form, 'name').focus();
}

function closeForm() {
  modal.hidden = true;
  editing = null;
}

/**
 * Проверка до отправки — ради удобства: не гонять запрос ради пустого поля.
 * Решает всё равно сервер, и те же правила проверены там: название не пустое,
 * цена и длительность положительные (api/src/routes/admin.js).
 */
function validate(values) {
  const problems = {};
  if (!values.name) problems.name = 'введите название';
  if (!(values.durationMin > 0)) problems.duration_min = 'длительность должна быть больше нуля';
  else if (values.durationMin % 5 !== 0) problems.duration_min = 'кратно 5 минутам';
  if (values.priceKopecks !== undefined && !(values.priceKopecks > 0)) {
    problems.price_kopecks = 'цена должна быть больше нуля';
  }
  for (const [name, message] of Object.entries(problems)) setFieldError(form, name, message);
  return Object.keys(problems).length === 0;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form);

  const priceRubles = field(form, 'price').value.trim();
  const values = {
    name: field(form, 'name').value.trim(),
    categoryId: Number(field(form, 'category_id').value),
    durationMin: Number(field(form, 'duration_min').value),
    bufferAfterMin: Number(field(form, 'buffer_after_min').value || 0),
    description: field(form, 'description').value.trim(),
    isVisible: field(form, 'is_visible').checked,
    // Цену отправляем, только если её ввели: пустое поле означает «цену не
    // назначали», а не «ноль рублей», и сервер нулевую цену не принимает.
    ...(isOwner && priceRubles !== '' ? { priceKopecks: Math.round(Number(priceRubles) * 100) } : {}),
  };
  if (!validate(values)) return;

  const button = form.querySelector('button[type="submit"]');
  submitting(button, true, 'Сохраняем…');
  try {
    if (editing) {
      // Включённая галочка возвращает и отключённую услугу: одно поле на
      // экране — одно понятное состояние «доступна клиентам».
      const saved = await updateService(editing.id, { ...values, isActive: values.isVisible || undefined });
      Object.assign(editing, saved);
      showNote(`Услуга «${saved.name}» сохранена.`, true);
    } else {
      services.push(await createService(values));
      showNote('Услуга добавлена.', true);
    }
    closeForm();
    render();
  } catch (err) {
    // 403 про цену — не ошибка поля, а правило: показываем текстом формы.
    if (err.status === 403) showFormError(form, err.message);
    else applyApiError(form, err);
  } finally {
    submitting(button, false);
  }
});

for (const button of document.querySelectorAll('[data-action="close"]')) {
  button.addEventListener('click', closeForm);
}
$('[data-action="new"]').addEventListener('click', () => openForm(null));
clearErrorOnInput(form);

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    tab = button.dataset.tab;
    for (const other of document.querySelectorAll('[data-tab]')) {
      other.setAttribute('aria-selected', String(other === button));
    }
    render();
  });
}

/* -------------------------------------------------------------- загрузка */

async function load() {
  const box = errorBox('services');
  try {
    const [loadedServices, loadedMasters, loadedCategories, me] = await Promise.all([
      getAdminServices(), getAdminMasters(), getServiceCategories(), getMe(),
    ]);
    services = loadedServices;
    masters = loadedMasters;
    categories = loadedCategories;
    isOwner = Array.isArray(me.roles) && me.roles.includes('owner');
    fillCategories();
    box.hidden = true;
    render();
  } catch (err) {
    // 401 и 403 уводят со страницы сами — это делает admin-shell.js.
    if (err.status === 401 || err.status === 403) return;
    showError(box, listNode('services'), err, load, 'Не удалось загрузить услуги.');
  }
}

load();
window.addEventListener('load', refreshIcons);
