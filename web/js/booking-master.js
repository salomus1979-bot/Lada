'use strict';

/**
 * Шаг 2 воронки: выбор мастера.
 *
 * Список приходит уже с учётом выбранных услуг:
 * `GET /masters?service_ids=…` оставляет тех, кто выполняет ВСЕ выбранные
 * услуги — визит делает один мастер целиком. Чтобы показать остальных
 * неактивными (а не прятать), рядом запрашивается полный список
 * `GET /masters`: разница между ними и есть «не выполняет все услуги».
 * Кто подходит, решает сервер, а не страница.
 *
 * Выбор клиента — в store.js, общем на все шаги.
 */

import { getMasters, getServices } from './api.js';
import { getServiceIds, getMasterId, setMasterId } from './store.js';
import {
  $, listNode, errorBox, tpl, refreshIcons, showError, rubles, minutesLong,
} from './ui.js';
import { setupExit } from './booking-shell.js';

/** Куда ведёт «Выбрать время» — шаг 3. */
const NEXT_STEP = 'booking-time.html';
const PREV_STEP = 'booking-services.html';

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

/* ------------------------------------------------------------ ошибки */

/**
 * Мастера не пришли — гаснет и состав визита: пульсирующая полоска на его
 * месте обещала бы данные, которых уже не будет. Текст свой: на этом шаге
 * понятно, чего именно не хватает.
 */
function showMastersError(err, retry) {
  showError(
    errorBox('masters'), [listNode('masters'), $('[data-summary]')], err, retry,
    'Не удалось загрузить мастеров.',
  );
}

/** Услуги не выбраны — на этом шаге делать нечего. */
function requireServices() {
  const summary = $('[data-summary]');
  summary.replaceChildren();
  summary.removeAttribute('aria-busy');

  const list = listNode('masters');
  const card = document.createElement('div');
  card.className = 'card no-master masters-grid__wide';
  const title = document.createElement('p');
  title.className = 'no-master__title';
  title.textContent = 'Сначала выберите услуги';
  const text = document.createElement('p');
  text.className = 'no-master__text';
  text.textContent = 'Мастера показываем под выбранный состав услуг — без него список был бы ни о чём.';
  const link = document.createElement('a');
  link.className = 'btn btn--outline';
  link.href = PREV_STEP;
  link.textContent = 'Выбрать услуги';
  card.append(title, text, link);

  list.replaceChildren(card);
  list.removeAttribute('aria-busy');
}

/* ------------------------------------------------------------ отрисовка */

/** Состав визита с шага 1: услуги, длительность, сумма и «Изменить». */
function renderSummary(chosen) {
  const names = chosen.map((service) => service.name).join(', ');
  const duration = chosen.reduce((sum, service) => sum + service.duration_min, 0);
  const price = chosen.reduce((sum, service) => sum + service.price_kopecks, 0);

  const summary = $('[data-summary]');
  const text = document.createElement('span');
  text.textContent = `${names} · ${minutesLong(duration)} · `;
  const total = document.createElement('span');
  total.className = 'bk-summary__total';
  total.textContent = rubles(price);
  const change = document.createElement('a');
  change.href = PREV_STEP;
  change.textContent = 'Изменить';

  summary.replaceChildren(text, total, change);
  summary.removeAttribute('aria-busy');
}

/** Чипы мастера — категории его услуг, как на лендинге. */
function chipsFor(master, services) {
  const titles = [];
  for (const service of services) {
    if (!master.service_ids.includes(service.id)) continue;
    if (!titles.includes(service.category.title)) titles.push(service.category.title);
  }
  return titles;
}

function fillCommon(node, master, services) {
  $('.master-pick__name', node).textContent = master.display_name;
  $('.master-pick__spec', node).textContent =
    `${master.specialization} · опыт ${years(master.experience_years)}`;
  const chips = $('.master-pick__chips', node);
  for (const title of chipsFor(master, services)) {
    const chip = tpl('tpl-chip-quiet').cloneNode(true);
    chip.textContent = title;
    chips.append(chip);
  }
  if (master.photo_url) {
    const photo = $('.master-pick__photo', node);
    const img = document.createElement('img');
    img.src = master.photo_url;
    img.alt = master.display_name;
    photo.replaceChildren(img);
  }
}

function renderMasters({ all, eligible, services, chosen }) {
  const list = listNode('masters');
  const eligibleIds = new Set(eligible.map((master) => master.id));
  const current = getMasterId();
  const nodes = [];

  if (eligible.length > 0) {
    const any = tpl('tpl-any-master').cloneNode(true);
    any.classList.toggle('any-master--on', current === 'any');
    any.setAttribute('aria-pressed', String(current === 'any'));
    any.addEventListener('click', () => pick('any'));
    nodes.push(any);
  }

  for (const master of all) {
    if (eligibleIds.has(master.id)) {
      const node = tpl('tpl-master-pick').cloneNode(true);
      fillCommon(node, master, services);
      const on = current === master.id;
      node.classList.toggle('master-pick--on', on);
      node.setAttribute('aria-pressed', String(on));
      node.addEventListener('click', () => pick(master.id));
      nodes.push(node);
    } else {
      const node = tpl('tpl-master-off').cloneNode(true);
      fillCommon(node, master, services);
      node.setAttribute('aria-disabled', 'true');
      // Какие именно услуги он не делает — считаем по его `service_ids`.
      const missing = chosen
        .filter((service) => !master.service_ids.includes(service.id))
        .map((service) => service.name);
      $('.master-pick__missing', node).textContent = missing.length
        ? `Не делает: ${missing.join(', ')}`
        : '';
      nodes.push(node);
    }
  }

  if (eligible.length === 0) nodes.unshift(tpl('tpl-no-master').cloneNode(true));

  list.replaceChildren(...nodes);
  list.removeAttribute('aria-busy');
  renderNext();
  refreshIcons();
}

/** Кнопка «Выбрать время» и подсказка рядом с ней. */
function renderNext() {
  const chosen = getMasterId();
  const next = $('[data-next]');
  const hint = $('[data-hint]');

  next.classList.toggle('btn--off', chosen === null);
  next.setAttribute('aria-disabled', String(chosen === null));
  if (chosen === null) next.removeAttribute('href');
  else next.setAttribute('href', NEXT_STEP);
  hint.hidden = chosen !== null;
}

let rerender = () => {};

function pick(masterId) {
  setMasterId(masterId);
  rerender();
}

/* -------------------------------------------------------------- старт */

async function load() {
  const serviceIds = getServiceIds();
  if (serviceIds.length === 0) {
    requireServices();
    renderNext();
    return;
  }

  try {
    // Полный список и отфильтрованный — рядом: первый нужен, чтобы
    // показать неподходящих мастеров неактивными, второй решает, кто подходит.
    const [services, all, eligible] = await Promise.all([
      getServices(), getMasters(), getMasters({ serviceIds }),
    ]);

    const chosen = serviceIds
      .map((id) => services.find((service) => service.id === id))
      .filter(Boolean);
    renderSummary(chosen);

    // Выбранный раньше мастер мог перестать подходить — выбор сбрасываем.
    const current = getMasterId();
    if (current !== null && current !== 'any'
      && !eligible.some((master) => master.id === current)) {
      setMasterId(null);
    }

    rerender = () => renderMasters({ all, eligible, services, chosen });
    rerender();
  } catch (err) {
    showMastersError(err, load);
  }
}

// «Выйти» из воронки — с подтверждением и стиранием выбора: общий код шагов,
// см. booking-shell.js.
setupExit();

refreshIcons();
renderNext();
load();
