'use strict';

/**
 * Экран 17 «Кабинет — Уведомления». Структура, тексты и порядок блоков — из
 * «17. Кабинет - Уведомления.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3).
 *
 * У экрана нет своих данных вовсе: ни таблицы уведомлений, ни роутов в API
 * (п. 1 карты экранов). По решению 1 лента собирается из
 * `GET /appointments?scope=all` — в этом ответе есть всё, о чём уведомляет
 * прототип: подтверждение визита, перенос (`reschedule_count`), отмена студией
 * (`status` + `cancel_reason`) и ближайший визит для напоминания.
 *
 * Чего на экране нет и почему:
 *
 * - **бейджа непрочитанных, фильтра «Непрочитанные» и «Отметить все как
 *   прочитанные»** — признак «прочитано» хранить негде: он живёт в базе, а её
 *   нет (пп. 1-2 карты). Кнопка, которая ничего не меняет, хуже её отсутствия;
 * - **«Пароль изменён»** — смены пароля в API нет, журнала событий аккаунта
 *   тоже, так что это уведомление взять неоткуда;
 * - **отмены клиентом** — человек отменил её сам минуту назад; новостью для
 *   него это не является, в прототипе такого уведомления и нет.
 *
 * Время события. Точное есть только у создания записи (`created_at_utc`):
 * времени отмены и переноса клиентское представление записи не отдаёт
 * (`cancelled_at_utc` и `updated_at_utc` в ответ не попадают). Поэтому отмена
 * и перенос датируются днём визита, а если визит ещё впереди — сегодняшним
 * днём: позже сегодня событие случиться не могло. На экране об этом сказано
 * текстом.
 *
 * Страница только для вошедшего: 401 — это не ошибка на экране, а переход на
 * вход (см. handledAsUnauthorized в account-shell.js).
 */

import { getAppointments } from './api.js';
import {
  $, listNode, tpl, refreshIcons, fill, showError, dateDisplay, dayDisplay,
} from './ui.js';
import { loadMe, setupLogout, setupSideNav, handledAsUnauthorized, untilDisplay } from './account-shell.js';

/** Предел ответа API. Ленту строим из того же набора, что и история. */
const LIMIT = 100;

/** Отменённые — два статуса API: клиентом и студией. */
const CANCELLED = ['cancelled_by_client', 'cancelled_by_studio'];

/** Статусы, в которых запись уже подтверждена студией. */
const CONFIRMED = ['confirmed', 'completed', 'no_show'];

/** Первый шаг воронки — туда ведёт «Записаться заново» у отменённой записи. */
const BOOKING_PAGE = 'booking-services.html';

/* --------------------------------------------------------------- время */

/**
 * Календарная дата и время метки UTC в поясе студии. Пояс берётся из самой
 * записи (`starts_at.timezone`): его присылает API вместе с датами, поэтому
 * спрашивать настройки отдельно не нужно. `en-CA` даёт `YYYY-MM-DD`, в котором
 * даты сравниваются как строки.
 */
function zoned(atUtc, timezone) {
  const at = new Date(atUtc);
  return {
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at),
    time: new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(at),
  };
}

/** «Сегодня / Вчера / Ранее» — по дате события в поясе студии. */
function groupTitle(date, today, yesterday) {
  if (date >= today) return 'Сегодня';
  if (date === yesterday) return 'Вчера';
  return 'Ранее';
}

/** Дата на день раньше заданной (`YYYY-MM-DD`). */
function dayBefore(date) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/* ----------------------------------------------------------- уведомления */

/** Когда визит: «23 октября в 14:00». */
const visitWhen = (appointment) =>
  `${dateDisplay(appointment.starts_at.local_date)} в ${appointment.starts_at.local_time}`;

/** Ссылка на детали записи. */
const detailsLink = (appointment) => ({
  text: 'Открыть запись', href: `appointment.html?id=${appointment.id}` });

/**
 * Уведомления одной записи, свежие сверху внутри самой записи.
 *
 * @param {object} appointment запись из `GET /appointments?scope=all`
 * @param {string} today сегодняшняя дата в поясе студии
 */
function appointmentEvents(appointment, today) {
  const events = [];
  const tz = appointment.starts_at.timezone;
  const visitDate = appointment.starts_at.local_date;
  // Отмена и перенос случились не позже сегодня, даже если визит был впереди.
  const eventDate = visitDate > today ? today : visitDate;

  if (appointment.status === 'cancelled_by_studio') {
    events.push({
      date: eventDate,
      icon: 'calendar-x',
      tone: 'off',
      text: `Студия отменила запись на ${visitWhen(appointment)}`,
      reason: appointment.cancel_reason ? `Причина: ${appointment.cancel_reason}` : null,
      time: dateDisplay(eventDate),
      link: { text: 'Записаться заново', href: BOOKING_PAGE },
    });
  }

  if (appointment.reschedule_count > 0 && !CANCELLED.includes(appointment.status)) {
    events.push({
      date: eventDate,
      icon: 'repeat',
      tone: 'info',
      // Прежнего времени в ответе нет — в записи осталось только новое,
      // поэтому в прототипе «с 23 на 27 октября», а здесь только «на 27-е».
      text: `Запись перенесена: теперь ${visitWhen(appointment)}`,
      reason: null,
      time: dateDisplay(eventDate),
      link: detailsLink(appointment),
    });
  }

  if (!CANCELLED.includes(appointment.status)) {
    const created = zoned(appointment.created_at_utc, tz);
    events.push({
      date: created.date,
      at: new Date(appointment.created_at_utc).getTime(),
      icon: CONFIRMED.includes(appointment.status) ? 'check-circle-2' : 'hourglass',
      tone: CONFIRMED.includes(appointment.status) ? 'ok' : 'wait',
      // Создание записи и её подтверждение — разные события, но времени
      // подтверждения в ответе нет: у новой записи статус `pending`, и
      // уведомление говорит о том, что известно наверняка.
      text: CONFIRMED.includes(appointment.status)
        ? `Запись на ${visitWhen(appointment)} подтверждена`
        : `Запись на ${visitWhen(appointment)} создана — студия подтвердит её`,
      reason: null,
      time: `${dateDisplay(created.date)}, ${created.time}`,
      link: detailsLink(appointment),
    });
  }

  return events;
}

/**
 * Напоминание о ближайшем визите. Одно: напоминать о каждой будущей записи
 * разом — не напоминание, а второй список предстоящих.
 */
function reminderEvent(appointments, today) {
  const now = Date.now();
  const upcoming = appointments
    .filter((a) => !CANCELLED.includes(a.status) && new Date(a.starts_at.at_utc) > now)
    .sort((a, b) => new Date(a.starts_at.at_utc) - new Date(b.starts_at.at_utc))[0];
  if (!upcoming) return null;

  return {
    date: today,
    icon: 'clock',
    tone: 'accent',
    at: Date.now(),
    // В прототипе «визит к Ольге Беловой» — дательный падеж. Имя приходит от
    // API в именительном, а склонять его в браузере нечем, поэтому мастер
    // назван отдельной фразой.
    text: `Напоминание о визите: ${dayDisplay(upcoming.starts_at.local_date)} в `
      + `${upcoming.starts_at.local_time}. Мастер — ${upcoming.master.display_name}`,
    reason: null,
    time: untilDisplay(upcoming.starts_at.at_utc),
    link: detailsLink(upcoming),
  };
}

/** Вся лента: напоминание плюс события всех записей, свежие сверху. */
function buildFeed(appointments) {
  // Пояс один на все записи — он приходит от API; без записей и ленты нет.
  const tz = appointments[0].starts_at.timezone;
  const today = zoned(new Date().toISOString(), tz).date;

  const events = appointments.flatMap((a) => appointmentEvents(a, today));
  const reminder = reminderEvent(appointments, today);
  if (reminder) events.unshift(reminder);

  // Свежие сверху, как в прототипе. Внутри одного дня вперёд выходят те, у
  // кого известно точное время (`at`): у отмены и переноса его нет, и ставить
  // их между событиями с часами значило бы выдумать им место.
  events.sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
  return { events, today, yesterday: dayBefore(today) };
}

/* --------------------------------------------------------------- экран */

function feedItem(event) {
  const node = tpl('tpl-feed-item').cloneNode(true);
  const tile = $('.feed__tile', node);
  tile.classList.add(`feed__tile--${event.tone}`);
  $('.icon', tile).dataset.lucide = event.icon;

  $('.feed__text', node).textContent = event.text;
  if (event.reason) {
    const reason = $('.feed__reason', node);
    reason.textContent = event.reason;
    reason.hidden = false;
  }
  $('.feed__time', node).textContent = event.time;
  if (event.link) {
    const link = $('.feed__link', node);
    link.textContent = event.link.text;
    link.href = event.link.href;
    link.hidden = false;
  }
  return node;
}

/** Группы «Сегодня / Вчера / Ранее» — в порядке следования событий. */
function renderFeed({ events, today, yesterday }) {
  const list = listNode('feed');
  if (events.length === 0) {
    fill(list, [tpl('tpl-feed-empty').cloneNode(true)]);
    return;
  }

  const groups = [];
  for (const event of events) {
    const title = groupTitle(event.date, today, yesterday);
    if (groups.length === 0 || groups[groups.length - 1].title !== title) {
      groups.push({ title, items: [] });
    }
    groups[groups.length - 1].items.push(event);
  }

  fill(list, groups.map((group) => {
    const node = tpl('tpl-feed-group').cloneNode(true);
    $('.feed-group__title', node).textContent = group.title;
    $('.feed', node).replaceChildren(...group.items.map(feedItem));
    return node;
  }));
  refreshIcons();
}

async function loadFeed() {
  const list = listNode('feed');
  const box = $('[data-error="feed"]');
  try {
    const appointments = await getAppointments({ scope: 'all', limit: LIMIT });
    if (appointments.length === 0) {
      fill(list, [tpl('tpl-feed-empty').cloneNode(true)]);
      refreshIcons();
      return;
    }
    renderFeed(buildFeed(appointments));
    box.hidden = true;
  } catch (err) {
    if (handledAsUnauthorized(err)) return;
    showError(box, list, err, () => {
      list.setAttribute('aria-busy', 'true');
      loadFeed();
    }, 'Не удалось загрузить уведомления.');
  }
}

/* --------------------------------------------------------------- старт */

function start() {
  refreshIcons();
  setupLogout();
  setupSideNav();
  // Профиль и лента друг от друга не зависят — грузятся разом.
  loadMe();
  loadFeed();
}

window.addEventListener('load', refreshIcons);
start();
