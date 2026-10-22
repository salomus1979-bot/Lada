'use strict';

/**
 * Админ-панель, раздел «Мастера» — экраны `28. Админ - Мастера` и
 * `29. Админ - Карточка мастера (форма)` прототипа.
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /admin/masters?include_inactive=1` (все мастера,
 * включая отключённых) и `GET /admin/services` — отметки, какие услуги мастер
 * выполняет. Действия: `POST /admin/masters`, `PATCH /admin/masters/:id`
 * (правка, список услуг, включение и отключение), `DELETE /admin/masters/:id`.
 *
 * Модуль подключает общий слой раздела (admin-shell.js): он наполняет
 * юзер-блок сайдбара, вешает «Выйти» и уводит со страницы, если роли нет.
 *
 * ПРО СВЯЗЬ С УСЛУГАМИ. Галочки в форме — это `master_services`, та самая
 * связь, по которой клиенту подбирается мастер: на шаге 2 воронки
 * `GET /masters?service_ids=…` оставляет только тех, кто выполняет ВСЕ услуги
 * визита. Поэтому мастер без услуг клиенту не достанется никогда — карточка
 * говорит об этом прямо.
 *
 * ПРО УДАЛЕНИЕ. Решает сервер: нет ни одной записи к мастеру — строка
 * удаляется из базы; есть — мастер отключается, а ответ объясняет, почему.
 */

import {
  getAdminMasters, getAdminServices, createMaster, updateMaster, deleteMaster,
} from './api.js';
import {
  $, listNode, errorBox, tpl, fill, fillEmpty, showError, refreshIcons,
} from './ui.js';
import {
  clearErrors, clearErrorOnInput, applyApiError, setFieldError, submitting, field,
} from './auth-form.js';
import { initials } from './admin-shell.js';

let tab = 'all';
let masters = [];
let services = [];
/** Какого мастера правим; null — заводим нового. */
let editing = null;

const form = $('#master-form');
const modal = $('[data-modal]');
const note = $('[data-note]');

/** Ответ сервера на действие — на экране, а не в консоли (правило 7). */
function showNote(text, done = false) {
  note.textContent = text;
  note.classList.toggle('adm-note--done', done);
  note.hidden = false;
}

/* -------------------------------------------------------------- список */

function stateOf(master) {
  if (!master.is_active) return { label: 'Отключён — есть записи', mod: 'archived' };
  if (!master.is_visible) return { label: 'Скрыт от клиентов', mod: 'off' };
  return { label: 'Работает', mod: 'on' };
}

const isOff = (master) => !master.is_active || !master.is_visible;

/** Названия услуг мастера. Отключённые услуги помечаются — их клиент не видит. */
function serviceChips(master) {
  const chips = [];
  for (const id of master.service_ids) {
    const service = services.find((row) => row.id === id);
    if (!service) continue;
    const chip = document.createElement('span');
    chip.className = 'adm-chip';
    chip.textContent = service.is_active && service.is_visible
      ? service.name : `${service.name} (отключена)`;
    chips.push(chip);
  }
  if (chips.length === 0) {
    const chip = document.createElement('span');
    chip.className = 'adm-chip adm-chip--empty';
    chip.textContent = 'Услуги не отмечены — клиенту не предложится';
    chips.push(chip);
  }
  return chips;
}

function masterCard(master) {
  const node = tpl('tpl-master').cloneNode(true);
  const state = stateOf(master);
  const name = `${master.first_name} ${master.last_name}`;

  $('[data-cell="initials"]', node).textContent = initials(name);
  $('[data-cell="name"]', node).textContent = name;
  const badge = $('[data-cell="state"]', node);
  badge.textContent = state.label;
  badge.classList.add(`adm-badge--${state.mod}`);

  const spec = [master.specialization, master.experience_years !== null
    ? `опыт ${master.experience_years} лет` : null].filter(Boolean).join(' · ');
  $('[data-cell="spec"]', node).textContent = spec || 'Специализация не указана';
  $('[data-cell="bio"]', node).textContent = master.bio || '';
  $('[data-cell="services"]', node).replaceChildren(...serviceChips(master));

  if (isOff(master)) node.classList.add('adm-card--off');

  const toggle = $('[data-action="toggle"]', node);
  toggle.setAttribute('aria-checked', String(!isOff(master)));
  toggle.setAttribute('aria-label', isOff(master)
    ? `Включить мастера ${name}` : `Отключить мастера ${name}`);
  toggle.addEventListener('click', () => toggleMaster(master, toggle));

  $('[data-action="edit"]', node).addEventListener('click', () => openForm(master));
  $('[data-action="delete"]', node)
    .addEventListener('click', (event) => removeMaster(master, event.currentTarget));

  return node;
}

function render() {
  const box = listNode('masters');
  const visible = masters.filter((master) => {
    if (tab === 'on') return !isOff(master);
    if (tab === 'off') return isOff(master);
    return true;
  });

  if (visible.length === 0) {
    fillEmpty(box, tab === 'all'
      ? 'Мастеров пока нет. Добавьте первого — он появится на сайте и в записи.'
      : 'В этом списке пусто.');
    return;
  }
  fill(box, visible.map(masterCard));
}

/* ------------------------------------------------- включение/отключение */

async function toggleMaster(master, button) {
  const turningOn = isOff(master);
  button.disabled = true;
  try {
    const updated = await updateMaster(master.id, turningOn
      ? { isActive: true, isVisible: true }
      : { isVisible: false });
    Object.assign(master, updated);
    showNote(turningOn
      ? `${master.first_name} ${master.last_name} снова доступен клиентам.`
      : `${master.first_name} ${master.last_name} скрыт от клиентов. Уже созданные записи это не затронет.`,
    true);
    render();
  } catch (err) {
    button.disabled = false;
    showError(errorBox('masters'), null, err, null, 'Не удалось изменить мастера.');
  }
}

/* ------------------------------------------------------------ удаление */

async function removeMaster(master, button) {
  const name = `${master.first_name} ${master.last_name}`;
  // Подтверждение прямо в карточке, а не окном браузера: так же сделана
  // отмена записи в кабинете клиента. Первый клик спрашивает, второй — удаляет.
  if (button.dataset.confirm !== 'yes') {
    button.dataset.confirm = 'yes';
    button.textContent = 'Точно удалить?';
    return;
  }
  button.disabled = true;
  try {
    const result = await deleteMaster(master.id);
    if (result.deleted) {
      masters = masters.filter((row) => row.id !== master.id);
      showNote(`Мастер ${name} удалён: к нему не было ни одной записи.`, true);
    } else {
      Object.assign(master, { is_active: false, is_visible: false });
      showNote(result.message);
    }
    render();
  } catch (err) {
    button.disabled = false;
    button.dataset.confirm = '';
    button.textContent = 'Удалить';
    showError(errorBox('masters'), null, err, null, 'Не удалось удалить мастера.');
  }
}

/* --------------------------------------------------------------- форма */

/**
 * Галочки услуг по категориям. Отключённые услуги в списке не показываются:
 * отметить мастера на услугу, которой нет в каталоге, значит обещать
 * клиенту то, чего он всё равно не увидит.
 */
function fillServiceChecks(checkedIds) {
  const box = $('[data-services]');
  const groups = new Map();

  for (const service of services) {
    if (!service.is_active) continue;
    if (!groups.has(service.category.title)) groups.set(service.category.title, []);
    groups.get(service.category.title).push(service);
  }

  const nodes = [];
  for (const [title, rows] of groups) {
    const group = tpl('tpl-check-group').cloneNode(true);
    $('.adm-checks__title', group).textContent = title;
    for (const service of rows) {
      const label = tpl('tpl-check').cloneNode(true);
      const input = $('input', label);
      input.value = String(service.id);
      input.checked = checkedIds.includes(service.id);
      $('span', label).textContent = service.is_visible
        ? service.name : `${service.name} (скрыта)`;
      group.append(label);
    }
    nodes.push(group);
  }
  box.replaceChildren(...nodes);
}

function openForm(master = null) {
  editing = master;
  clearErrors(form);
  $('[data-form-title]').textContent = master ? 'Карточка мастера' : 'Новый мастер';

  field(form, 'first_name').value = master ? master.first_name : '';
  field(form, 'last_name').value = master ? master.last_name : '';
  field(form, 'specialization').value = master ? (master.specialization || '') : '';
  field(form, 'experience_years').value = master && master.experience_years !== null
    ? master.experience_years : '';
  field(form, 'bio').value = master ? (master.bio || '') : '';
  field(form, 'sort_order').value = master ? master.sort_order : 0;
  field(form, 'is_visible').checked = master ? (master.is_visible && master.is_active) : true;
  fillServiceChecks(master ? master.service_ids : []);

  modal.hidden = false;
  field(form, 'first_name').focus();
}

function closeForm() {
  modal.hidden = true;
  editing = null;
}

/** Проверка до отправки — для удобства. Те же правила проверяет сервер. */
function validate(values) {
  const problems = {};
  if (values.firstName.length < 2) problems.first_name = 'введите имя';
  if (values.lastName.length < 2) problems.last_name = 'введите фамилию';
  if (values.experienceYears !== undefined && values.experienceYears < 0) {
    problems.experience_years = 'стаж не может быть отрицательным';
  }
  for (const [name, message] of Object.entries(problems)) setFieldError(form, name, message);
  return Object.keys(problems).length === 0;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form);

  const years = field(form, 'experience_years').value.trim();
  const serviceIds = [...document.querySelectorAll('[data-services] input:checked')]
    .map((input) => Number(input.value));

  const values = {
    firstName: field(form, 'first_name').value.trim(),
    lastName: field(form, 'last_name').value.trim(),
    specialization: field(form, 'specialization').value.trim(),
    bio: field(form, 'bio').value.trim(),
    sortOrder: Number(field(form, 'sort_order').value || 0),
    isVisible: field(form, 'is_visible').checked,
    serviceIds,
    ...(years !== '' ? { experienceYears: Number(years) } : {}),
  };
  if (!validate(values)) return;

  const button = form.querySelector('button[type="submit"]');
  submitting(button, true, 'Сохраняем…');
  try {
    if (editing) {
      const saved = await updateMaster(editing.id, {
        ...values, isActive: values.isVisible || undefined,
      });
      Object.assign(editing, saved);
      showNote(`Карточка мастера ${saved.first_name} ${saved.last_name} сохранена.`, true);
    } else {
      masters.push(await createMaster(values));
      showNote('Мастер добавлен.', true);
    }
    closeForm();
    render();
  } catch (err) {
    applyApiError(form, err);
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

/* ------------------------------------------------------------- загрузка */

async function load() {
  const box = errorBox('masters');
  try {
    const [loadedMasters, loadedServices] = await Promise.all([
      getAdminMasters(), getAdminServices(),
    ]);
    masters = loadedMasters;
    services = loadedServices;
    box.hidden = true;
    render();
  } catch (err) {
    // 401 и 403 уводят со страницы сами — это делает admin-shell.js.
    if (err.status === 401 || err.status === 403) return;
    showError(box, listNode('masters'), err, load, 'Не удалось загрузить мастеров.');
  }
}

load();
window.addEventListener('load', refreshIcons);
