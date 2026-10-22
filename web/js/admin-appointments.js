'use strict';

/**
 * Админ-панель, раздел «Записи» — экран `23. Админ - Записи` прототипа,
 * собранный как список за день (как сетка на экране 22, только строками).
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /admin/appointments?date_from=&date_to=&master_id=`
 * (записи за день вместе с историей), `GET /admin/time-blocks?date=`
 * (заблокированное время), `GET /admin/masters` и `GET /admin/services` —
 * фильтр и форма, `GET /settings` — пояс студии.
 *
 * ВРЕМЯ. Всё, что показано на экране, — время студии: API отдаёт каждую метку
 * разложенной (`local_time`) вместе с моментом в UTC. Экран ничего не
 * пересчитывает и не берёт пояс браузера: администратор может сидеть в другом
 * городе, а студия работает по своему времени. Обратный перевод нужен только
 * там, где время НАЗНАЧАЮТ руками (перенос, новая запись, блокировка), — им
 * занимается `zonedToUtcIso` из ui.js.
 *
 * ЧТО ДЕЛАЕТ АДМИНИСТРАТОР С ЧУЖОЙ ЗАПИСЬЮ:
 *   - «Перенести» → `POST /appointments/:id/reschedule`. Это ТА ЖЕ запись с
 *     другим временем: новая не создаётся, старая не отменяется, у клиента в
 *     кабинете она остаётся одной строкой;
 *   - «Отменить» → `POST /appointments/:id/cancel` с причиной. Строка
 *     остаётся в списке с пометкой, время освобождается, в кабинете клиента
 *     запись видна как отменённая;
 *   - «Заблокировать время» → `POST /admin/masters/:id/time-blocks`. Мастер
 *     остаётся на сайте, закрыты только эти часы;
 *   - «Новая запись» → `POST /appointments` за клиента, при занятом времени —
 *     только после подтверждения (`is_override`).
 */

import {
  getAdminAppointments, getAdminTimeBlocks, getAdminMasters, getAdminServices,
  getSettings, searchClients, createAppointmentForClient, cancelAppointment,
  rescheduleAppointment, blockTime, unblockTime,
} from './api.js';
import {
  $, listNode, errorBox, tpl, fill, showError, refreshIcons,
  dayDisplay, minutesLong, zonedToUtcIso,
} from './ui.js';
import {
  clearErrors, clearErrorOnInput, applyApiError, setFieldError, submitting, field,
} from './auth-form.js';
import './admin-shell.js';

/** Пояс студии: приходит из `GET /settings`, браузерный не используется. */
let timezone = 'Europe/Moscow';
/** Какой день открыт — календарная дата в поясе студии. */
let day = '';
/** Фильтр по мастеру; пустая строка — все. */
let masterFilter = '';

let appointments = [];
let blocks = [];
let masters = [];
let services = [];

/** Кого записываем в форме «Новая запись». */
let chosenClient = null;
/** Что ушло в последний отклонённый запрос: его же повторяем с подтверждением. */
let pendingBooking = null;

const note = $('[data-note]');
const dateInput = $('[data-date]');
const blockForm = $('#block-form');
const newForm = $('#new-form');

/* --------------------------------------------------------------- даты */

/** Сегодня в поясе студии, а не в поясе браузера. */
const todayInSalon = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

/** Соседний день: календарная арифметика, без часовых поясов. */
function shiftDay(date, days) {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

/** Ответ сервера на действие — на экране, а не в консоли (правило 7). */
function showNote(text, done = false) {
  note.textContent = text;
  note.classList.toggle('adm-note--done', done);
  note.hidden = false;
}

/* -------------------------------------------------------------- список */

/** Активна ли запись: отменённые и завершённые время больше не занимают. */
const ACTIVE = ['pending', 'confirmed'];
const isActive = (appointment) => ACTIVE.includes(appointment.status);
const isCancelled = (appointment) => appointment.status.startsWith('cancelled');

/** Цвет бейджа состояния. Подпись берётся у сервера (`status_label`). */
function stateMod(status) {
  if (status === 'confirmed') return 'on';
  if (status === 'pending') return 'off';
  if (status === 'no_show' || status.startsWith('cancelled')) return 'archived';
  return 'quiet';
}

/**
 * На это время назначено два визита.
 *
 * Считается по самим записям, а не по признаку `is_override`: признак стоит
 * только на той, которую поставили поверх, а знать о наложении нужно обеим.
 */
function overlapsWith(appointment) {
  return appointments.filter((other) => other.id !== appointment.id
    && other.master.id === appointment.master.id
    && isActive(other) && isActive(appointment)
    && other.starts_at.at_utc < appointment.ends_at.at_utc
    && other.ends_at.at_utc > appointment.starts_at.at_utc);
}

/** Последнее событие нужного вида — из истории, которую отдаёт API. */
const lastEvent = (appointment, type) => (appointment.history || [])
  .filter((event) => event.type === type).slice(-1)[0] || null;

/** Пометки под бейджем: что с записью уже происходило. */
function marksFor(appointment) {
  const marks = [];
  const moved = lastEvent(appointment, 'rescheduled');
  if (moved) {
    // В строке нужен сам факт и откуда: полную фразу сервера («перенесена с
    // вторник, 27 октября 2026 г. в 11:00 …») колонка не вмещает, а целиком
    // история видна в деталях записи. Если перенос был на другой день, дата
    // остаётся — без неё «с 11:00» ввело бы в заблуждение.
    const sameDay = moved.from && moved.to && moved.from.local_date === moved.to.local_date;
    marks.push(sameDay
      ? `Перенесена с ${moved.from.local_time}${moved.actor_name ? ` (${moved.actor_name})` : ''}`
      : moved.text);
  }

  if (isCancelled(appointment)) {
    const cancelled = lastEvent(appointment, 'cancelled');
    marks.push(cancelled ? cancelled.text : 'Отменена');
  }

  const clash = overlapsWith(appointment);
  if (clash.length > 0) {
    marks.push(`На это время назначено ${clash.length + 1} визита`
      + (appointment.is_override ? ' — поставлена поверх занятого' : ''));
  }
  return marks;
}

function appointmentRow(appointment) {
  const node = tpl('tpl-appt').cloneNode(true);
  const clash = overlapsWith(appointment);

  $('[data-cell="time"]', node).textContent =
    `${appointment.starts_at.local_time}–${appointment.ends_at.local_time}`;
  $('[data-cell="client"]', node).textContent = appointment.client.name;
  $('[data-cell="phone"]', node).textContent = appointment.client.phone;
  $('[data-cell="master"]', node).textContent = appointment.master.display_name;
  $('[data-cell="services"]', node).textContent =
    `${appointment.services.map((service) => service.name).join(', ')} · `
    + `${minutesLong(appointment.service_duration_min)} · ${appointment.total_price_display}`;

  const badge = $('[data-cell="state"]', node);
  badge.textContent = appointment.status_label;
  badge.classList.add(`adm-badge--${stateMod(appointment.status)}`);
  $('[data-cell="marks"]', node).textContent = marksFor(appointment).join(' · ');

  if (isCancelled(appointment) || appointment.status === 'no_show') {
    node.classList.add('adm-row--cancelled');
  }
  if (clash.length > 0) node.classList.add('adm-row--overlap');

  const moveButton = $('[data-action="move"]', node);
  const cancelButton = $('[data-action="cancel"]', node);
  const moveForm = $('[data-form="move"]', node);
  const cancelForm = $('[data-form="cancel"]', node);

  // Отменённую и завершённую запись трогать нечем: сервер ответил бы 409,
  // поэтому кнопок у неё просто нет.
  if (!isActive(appointment)) {
    moveButton.remove();
    cancelButton.remove();
  } else {
    moveButton.addEventListener('click', () => {
      cancelForm.hidden = true;
      moveForm.hidden = !moveForm.hidden;
      $('[data-move-time]', moveForm).value = appointment.starts_at.local_time;
      $('[data-move-date]', moveForm).value = appointment.starts_at.local_date;
    });
    cancelButton.addEventListener('click', () => {
      moveForm.hidden = true;
      cancelForm.hidden = !cancelForm.hidden;
    });
    $('[data-action="move-cancel"]', moveForm)
      .addEventListener('click', () => { moveForm.hidden = true; });
    $('[data-action="cancel-cancel"]', cancelForm)
      .addEventListener('click', () => { cancelForm.hidden = true; });

    moveForm.addEventListener('submit', (event) => {
      event.preventDefault();
      move(appointment, $('[data-move-date]', moveForm).value,
        $('[data-move-time]', moveForm).value, moveForm);
    });
    cancelForm.addEventListener('submit', (event) => {
      event.preventDefault();
      cancel(appointment, $('[data-cancel-reason]', cancelForm).value.trim(), cancelForm);
    });
  }

  return node;
}

function blockRow(block) {
  const node = tpl('tpl-block').cloneNode(true);
  $('[data-cell="time"]', node).textContent =
    `${block.starts_at.local_time}–${block.ends_at.local_time}`;
  $('[data-cell="type"]', node).textContent = block.type_label;
  $('[data-cell="master"]', node).textContent = block.master_name;
  $('[data-cell="comment"]', node).textContent = block.comment || '';
  $('[data-action="unblock"]', node)
    .addEventListener('click', (event) => unblock(block, event.currentTarget));
  return node;
}

/** Шапка таблицы — она же в разметке, поэтому переносится в новый список. */
function headRow() {
  const head = document.createElement('div');
  head.className = 'adm-row adm-row--appt adm-row--head';
  for (const title of ['Время', 'Клиент', 'Мастер', 'Услуги', 'Состояние', 'Действия']) {
    const cell = document.createElement('span');
    cell.textContent = title;
    head.append(cell);
  }
  return head;
}

function render() {
  const box = listNode('day');
  $('[data-weekday]').textContent = dayDisplay(day);

  // Записи и блокировки — один список, упорядоченный по времени: так видно,
  // почему у мастера дыра в расписании.
  const rows = [
    ...appointments.map((a) => ({ at: a.starts_at.at_utc, node: () => appointmentRow(a) })),
    ...blocks.map((b) => ({ at: b.starts_at.at_utc, node: () => blockRow(b) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = masterFilter
      ? 'На этот день у выбранного мастера записей нет.'
      : 'На этот день записей нет.';
    fill(box, [headRow(), empty]);
    return;
  }
  fill(box, [headRow(), ...rows.map((row) => row.node())]);
}

/* ------------------------------------------------------------ действия */

/** Перенос: время меняется у ТОЙ ЖЕ записи, новая не создаётся. */
async function move(appointment, date, time, form) {
  if (!date || !time) {
    showNote('Укажите дату и время переноса.');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  submitting(button, true, 'Переносим…');
  try {
    const moved = await rescheduleAppointment(appointment.id,
      { startsAt: zonedToUtcIso(date, time, timezone) });
    showNote(`Запись перенесена на ${moved.starts_at.local_date} ${moved.starts_at.local_time}.`
      + ' Это та же запись: клиент увидит в кабинете новое время, а не вторую запись.', true);
    await load();
  } catch (err) {
    submitting(button, false);
    showNote(`Перенести не удалось. ${err.toText()}`);
  }
}

/** Отмена: строка остаётся с пометкой, время освобождается. */
async function cancel(appointment, reason, form) {
  const button = form.querySelector('button[type="submit"]');
  submitting(button, true, 'Отменяем…');
  try {
    await cancelAppointment(appointment.id, reason);
    showNote(`Запись отменена${reason ? `, причина: «${reason}»` : ''}.`
      + ' Строка осталась в списке с пометкой, время освободилось,'
      + ' в кабинете клиента запись видна как отменённая студией.', true);
    await load();
  } catch (err) {
    submitting(button, false);
    showNote(`Отменить не удалось. ${err.toText()}`);
  }
}

async function unblock(block, button) {
  button.disabled = true;
  try {
    await unblockTime(block.master_id, block.id);
    showNote(`Блокировка снята: ${block.master_name}, ${block.starts_at.local_time}–`
      + `${block.ends_at.local_time}. Время снова предлагается клиентам.`, true);
    await load();
  } catch (err) {
    button.disabled = false;
    showNote(`Снять блокировку не удалось. ${err.toText()}`);
  }
}

/* ------------------------------------------------- форма блокировки */

function openBlockForm() {
  clearErrors(blockForm);
  $('[data-block-day]').textContent = `День: ${dayDisplay(day)}`;
  $('[data-modal="block"]').hidden = false;
}

blockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(blockForm);

  const masterId = Number(field(blockForm, 'master_id').value);
  const wholeDay = field(blockForm, 'whole_day').checked;
  const from = wholeDay ? '00:00' : field(blockForm, 'from').value;
  const to = wholeDay ? '00:00' : field(blockForm, 'to').value;

  if (!wholeDay && (!from || !to || to <= from)) {
    setFieldError(blockForm, 'ends_at', 'конец должен быть позже начала');
    return;
  }

  const button = blockForm.querySelector('button[type="submit"]');
  submitting(button, true, 'Блокируем…');
  try {
    await blockTime(masterId, {
      type: field(blockForm, 'type').value,
      startsAt: zonedToUtcIso(day, from, timezone),
      // Весь день — до полуночи следующего: граница суток в поясе студии.
      endsAt: zonedToUtcIso(wholeDay ? shiftDay(day, 1) : day, to, timezone),
      comment: field(blockForm, 'comment').value.trim(),
    });
    $('[data-modal="block"]').hidden = true;
    showNote('Время заблокировано. Мастер остался в списке — закрыты только эти часы,'
      + ' клиенту они как свободные больше не показываются.', true);
    await load();
  } catch (err) {
    // 409 «на это время уже есть запись» — не ошибка поля, а правило студии:
    // сначала визит переносят, потом закрывают время.
    applyApiError(blockForm, err);
  } finally {
    submitting(button, false);
  }
});

/* ------------------------------------------------- форма новой записи */

function chosenServiceIds() {
  return [...newForm.querySelectorAll('[data-services] input:checked')]
    .map((input) => Number(input.value));
}

/** Мастера, которые выполняют ВСЕ выбранные услуги: так же считает API. */
function fillMasterOptions() {
  const chosen = chosenServiceIds();
  const select = field(newForm, 'master_id');
  const able = masters.filter((master) => master.is_active && master.is_visible
    && chosen.every((id) => master.service_ids.includes(id)));

  select.replaceChildren(...able.map((master) => {
    const option = document.createElement('option');
    option.value = String(master.id);
    option.textContent = master.display_name;
    return option;
  }));
  $('[data-master-note]').textContent = chosen.length === 0
    ? 'Сначала выберите услуги'
    : `Выполняют все выбранные услуги: ${able.length}`;
}

function fillServiceChecks() {
  const box = $('[data-services]', newForm);
  box.replaceChildren(...services
    .filter((service) => service.is_active && service.is_visible)
    .map((service) => {
      const label = document.createElement('label');
      label.className = 'adm-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(service.id);
      input.addEventListener('change', fillMasterOptions);
      const text = document.createElement('span');
      text.textContent = `${service.name} · ${minutesLong(service.duration_min)} · ${service.price_display}`;
      label.append(input, text);
      return label;
    }));
}

function openNewForm() {
  clearErrors(newForm);
  chosenClient = null;
  pendingBooking = null;
  newForm.reset();
  $('[data-client-results]').replaceChildren();
  $('[data-client-chosen]').textContent = 'Клиент не выбран';
  $('[data-overlap]').hidden = true;
  $('[data-new-day]').textContent = `День: ${dayDisplay(day)}`;
  fillServiceChecks();
  fillMasterOptions();
  $('[data-modal="new"]').hidden = false;
}

/** Поиск клиента: `GET /admin/clients?q=` — имя, телефон или e-mail. */
let searchTimer = null;
field(newForm, 'client_query').addEventListener('input', (event) => {
  const query = event.target.value.trim();
  window.clearTimeout(searchTimer);
  if (query.length < 2) {
    $('[data-client-results]').replaceChildren();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    try {
      const found = await searchClients(query);
      $('[data-client-results]').replaceChildren(...found.map((client) => {
        const item = tpl('tpl-client-result').cloneNode(true);
        $('.adm-results__name', item).textContent = client.name;
        $('.adm-results__note', item).textContent = `${client.phone}${client.is_blocked ? ' · заблокирован' : ''}`;
        item.addEventListener('click', () => {
          chosenClient = client;
          $('[data-client-chosen]').textContent = `Записываем: ${client.name}, ${client.phone}`;
          $('[data-client-results]').replaceChildren();
        });
        return item;
      }));
    } catch (err) {
      showNote(`Поиск клиента не удался. ${err.toText()}`);
    }
  }, 300);
});

/**
 * Создание записи. Первый заход всегда идёт БЕЗ признака наложения: проверку
 * занятости обходить нельзя, сначала её должен выполнить сервер.
 */
async function book({ force = false } = {}) {
  clearErrors(newForm);
  $('[data-overlap]').hidden = true;

  const serviceIds = chosenServiceIds();
  if (!chosenClient) {
    setFieldError(newForm, 'client_user_id', 'найдите и выберите клиента');
    return;
  }
  if (serviceIds.length === 0) {
    setFieldError(newForm, 'service_ids', 'выберите хотя бы одну услугу');
    return;
  }
  const masterId = Number(field(newForm, 'master_id').value);
  const time = field(newForm, 'time').value;
  if (!masterId || !time) {
    setFieldError(newForm, 'starts_at', 'укажите мастера и время');
    return;
  }

  const request = {
    clientUserId: chosenClient.id,
    masterId,
    serviceIds,
    startsAt: zonedToUtcIso(day, time, timezone),
    source: field(newForm, 'source').value,
    clientComment: field(newForm, 'client_comment').value.trim(),
    isOverride: force,
  };

  const button = newForm.querySelector('button[type="submit"]');
  submitting(button, true, 'Создаём…');
  try {
    const created = await createAppointmentForClient(request);
    $('[data-modal="new"]').hidden = true;
    showNote(`Запись создана: ${created.starts_at.local_time}, ${created.client.name}.`
      + (force ? ' На это время назначено два визита — в списке они помечены.' : ''), true);
    await load();
  } catch (err) {
    // Занятое время: сервер проверил и отказал. Показываем его предупреждение
    // и ближайшие свободные начала — и ждём подтверждения администратора.
    if (err.status === 409 && err.details && err.details.reason === 'overlap') {
      pendingBooking = request;
      $('[data-overlap-text]').textContent = `${err.message}. Это время уже занято у выбранного мастера.`;
      const slots = (err.details.nearest_slots || []).map((slot) => slot.local_time);
      $('[data-overlap-slots]').textContent = slots.length > 0
        ? `Ближайшее свободное: ${slots.join(', ')}` : '';
      $('[data-overlap]').hidden = false;
    } else {
      applyApiError(newForm, err);
    }
  } finally {
    submitting(button, false);
  }
}

newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  book();
});

$('[data-action="force"]').addEventListener('click', () => {
  if (pendingBooking) book({ force: true });
});

/* ------------------------------------------------------------- загрузка */

async function load() {
  const box = errorBox('day');
  dateInput.value = day;
  try {
    const [dayData, blockData] = await Promise.all([
      getAdminAppointments({ date: day, masterId: masterFilter || undefined, limit: 200 }),
      getAdminTimeBlocks({ date: day, masterId: masterFilter || undefined }),
    ]);
    appointments = dayData.appointments;
    blocks = blockData;
    box.hidden = true;
    render();
  } catch (err) {
    if (err.status === 401 || err.status === 403) return;
    showError(box, listNode('day'), err, load, 'Не удалось загрузить записи за день.');
  }
}

async function start() {
  try {
    const [settings, loadedMasters, loadedServices] = await Promise.all([
      getSettings(), getAdminMasters(), getAdminServices(),
    ]);
    timezone = settings.timezone;
    masters = loadedMasters;
    services = loadedServices;

    // Фильтр и формы: только работающие мастера.
    const working = masters.filter((master) => master.is_active);
    for (const select of [$('[data-master-filter]'), field(blockForm, 'master_id')]) {
      for (const master of working) {
        const option = document.createElement('option');
        option.value = String(master.id);
        option.textContent = master.display_name;
        select.append(option);
      }
    }

    day = todayInSalon();
    await load();
  } catch (err) {
    if (err.status === 401 || err.status === 403) return;
    showError(errorBox('day'), listNode('day'), err, start, 'Не удалось загрузить раздел.');
  }
}

/* ------------------------------------------------------------ элементы */

dateInput.addEventListener('change', () => {
  day = dateInput.value || todayInSalon();
  load();
});
$('[data-action="prev-day"]').addEventListener('click', () => { day = shiftDay(day, -1); load(); });
$('[data-action="next-day"]').addEventListener('click', () => { day = shiftDay(day, 1); load(); });
$('[data-action="today"]').addEventListener('click', () => { day = todayInSalon(); load(); });

$('[data-master-filter]').addEventListener('change', (event) => {
  masterFilter = event.target.value;
  load();
});

$('[data-action="block"]').addEventListener('click', openBlockForm);
$('[data-action="new"]').addEventListener('click', openNewForm);
for (const button of document.querySelectorAll('[data-action="close"]')) {
  button.addEventListener('click', (event) => {
    event.target.closest('.adm-modal').hidden = true;
  });
}
clearErrorOnInput(blockForm);
clearErrorOnInput(newForm);

start();
window.addEventListener('load', refreshIcons);
