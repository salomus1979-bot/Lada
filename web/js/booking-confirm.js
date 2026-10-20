'use strict';

/**
 * Шаг 4 воронки: подтверждение. Структура, тексты и порядок блоков — из
 * «4. Запись - Шаг 4. Подтверждение.dc.html».
 *
 * Запросов здесь нет — только вызовы функций из api.js (правило 3). По строке
 * карты экранов: `GET /auth/me` (кто записывается), `GET /settings` (правила
 * записи), `GET /holds/current` (остаток удержания), «Подтвердить запись» →
 * `POST /appointments` с `master_id`, `service_ids`, `starts_at`,
 * `client_comment`, `hold_token` и `consent`.
 *
 * Сверх строки карты — `GET /services` и `GET /masters?service_ids=…`: сводка
 * в прототипе зашита в разметку, а здесь собирается из выбора (store.js) и
 * ответов API.
 *
 * Две развилки после «Подтвердить»:
 *   201 → экран 5 «Запись создана» (booking-done.html?id=…), выбор стирается;
 *   409 с `details.reason = 'overlap'` → экран 6 «Время занято»
 *     (booking-taken.html) вместе с `details.nearest_slots`.
 *
 * 401 — не ошибка на экране, а «надо войти»: гостю показывается панель из
 * прототипа, а если сессия кончилась уже при отправке — уход на вход с
 * возвратом сюда. Выбор лежит в sessionStorage и вход его не трогает.
 */

import {
  getSettings, getServices, getMasters, getMe, getCurrentHold, createAppointment,
} from './api.js';
import { getSelection, setConflict, clearSelection } from './store.js';
import {
  $, refreshIcons, rubles, minutesLong, dayDisplay, showError,
} from './ui.js';
import {
  zoned, endTime, salonToday, initials, shortDateDisplay,
  startHoldTimer, pageFailureLink, setupExit, authHref, PAGES,
} from './booking-shell.js';

/** Что подтверждаем: слот, мастер, услуги и правила студии. */
let visit = null;
/** Действующее удержание (`GET /holds/current`) или null. */
let hold = null;
/** Вошедший человек или null у гостя. */
let user = null;

/* ----------------------------------------------------------- отрисовка */

/** Строка услуги: «Маникюр с покрытием (1 800 ₽, 90 мин)» — как в прототипе. */
function serviceLine(service) {
  const row = document.createElement('p');
  row.className = 'sum__service';
  row.append(document.createTextNode(`${service.name} `));
  const meta = document.createElement('span');
  meta.className = 'sum__service-meta';
  meta.textContent = `(${service.price_display}, ${minutesLong(service.duration_min)})`;
  row.append(meta);
  return row;
}

/**
 * Конец визита для строки «12:00–14:10».
 *
 * Если слот удержан, берём `ends_at` из самого удержания: сервер считает его
 * по длительности услуг вместе с буфером уборки — так же, как потом покажет
 * запись в кабинете. Без удержания (гость) буфер взять неоткуда:
 * `GET /availability` отдаёт только `service_duration_min`, и конец считается
 * по нему — он может оказаться на несколько минут раньше.
 */
function endDisplay() {
  const { slot, settings, durationMin } = visit;
  if (hold && hold.starts_at.at_utc === slot.startsAt) return hold.ends_at.local_time;
  return endTime(slot.startsAt, durationMin, settings.timezone);
}

function renderSummary() {
  const { services, master, slot, settings, durationMin, priceKopecks } = visit;
  const when = zoned(slot.startsAt, settings.timezone);

  $('[data-sum="services"]').replaceChildren(...services.map(serviceLine));
  $('[data-sum="initials"]').textContent = initials(master.display_name);
  $('[data-sum="master"]').textContent = master.display_name;
  $('[data-sum="when"]').textContent =
    `${dayDisplay(when.date)} ${when.date.slice(0, 4)}, ${when.time}–${endDisplay()}`;
  $('[data-sum="total"]').textContent =
    `${rubles(priceKopecks)} · ${minutesLong(durationMin)}`;
  $('[data-sum]').removeAttribute('aria-busy');

  // Правила записи — из настроек, а не из текста прототипа (решение 13).
  $('[data-rules]').textContent = 'Оплата на месте. Отменить или перенести запись можно '
    + `в личном кабинете не позднее чем за ${settings.cancel_window_hours} ч до визита.`;
}

/** Кто записывается: имя и телефон из `GET /auth/me`. */
function renderWho() {
  const box = $('[data-who]');
  if (!user) {
    box.hidden = true;
    box.removeAttribute('aria-busy');
    return;
  }
  const title = document.createElement('p');
  title.className = 'who__title';
  title.textContent = 'Записывается';
  const name = document.createElement('p');
  name.className = 'who__name';
  name.textContent = user.name;
  const phone = document.createElement('p');
  phone.className = 'who__phone';
  phone.textContent = user.phone;
  box.replaceChildren(title, name, phone);
  box.removeAttribute('aria-busy');
}

/**
 * Панель гостя из прототипа: что он записывает и две кнопки. Подтверждать
 * нечем — `POST /appointments` требует сессию, — поэтому кнопка выключена.
 */
function renderGuest() {
  const { master, slot, settings, durationMin, priceKopecks } = visit;
  const when = zoned(slot.startsAt, settings.timezone);

  $('[data-guest="when"]').textContent =
    `${master.display_name} · ${shortDateDisplay(when.date)}, ${when.time}`;
  $('[data-guest="total"]').textContent =
    `${rubles(priceKopecks)} · ${minutesLong(durationMin)}`;
  $('[data-guest="login"]').href = authHref(PAGES.login, PAGES.confirm);
  $('[data-guest="register"]').href = authHref(PAGES.register, PAGES.confirm);
  $('[data-guest]').hidden = false;

  const button = $('[data-action="confirm"]');
  button.disabled = true;
  button.title = 'Сначала войдите или зарегистрируйтесь';
}

/** Остаток удержания или честное «время за вами не держится». */
function renderHold() {
  const node = $('[data-hold]');
  if (!user) {
    // Гостю удержание недоступно: `POST /holds` требует сессию.
    node.classList.add('hold--warn');
    node.textContent = 'Время сейчас не держится за вами: пока вы не вошли, слот может занять другой клиент.';
    node.hidden = false;
    return;
  }
  if (hold && hold.starts_at.at_utc === visit.slot.startsAt) {
    startHoldTimer(node, new Date(hold.expires_at_utc).getTime(), {
      onExpire: () => {
        hold = null;
        node.classList.add('hold--warn');
      },
      overText: 'Время больше не держится за вами. Записаться ещё можно, но слот мог занять '
        + 'другой клиент — тогда мы предложим ближайшее свободное.',
    });
    return;
  }
  // Удержания нет: оно истекло, или его и не было — слот выбирали до входа.
  node.classList.add('hold--warn');
  node.textContent = 'Это время сейчас не держится за вами. Записаться ещё можно, но слот мог '
    + 'занять другой клиент — тогда мы предложим ближайшее свободное.';
  node.hidden = false;
}

/** Экран, которому нечего подтверждать: вместо сводки — текст и шаг назад. */
function requireStep(message, { href, label }) {
  $('[data-who]').hidden = true;
  pageFailureLink($('[data-error="page"]'), $('[data-body]'), message, { href, label });
}

/* ------------------------------------------------------- подтверждение */

function setBusy(busy) {
  const button = $('[data-action="confirm"]');
  button.disabled = busy;
  button.classList.toggle('confirm__submit--busy', busy);
  if (busy) {
    const icon = document.createElement('i');
    icon.className = 'icon confirm__spinner';
    icon.dataset.lucide = 'loader-2';
    icon.setAttribute('aria-hidden', 'true');
    button.replaceChildren(icon, document.createTextNode('Подтверждаем запись…'));
    refreshIcons();
  } else {
    button.replaceChildren(document.createTextNode('Подтвердить запись'));
  }
}

async function confirm() {
  const box = $('[data-error="confirm"]');
  const consentBox = $('[data-error="consent"]');
  box.hidden = true;
  consentBox.hidden = true;

  // Согласие требует сам API (и отказывает 400): проверяем до запроса, чтобы
  // человек увидел подсказку у самой галочки, а не общий текст ошибки.
  const consent = $('#consent').checked;
  if (!consent) {
    consentBox.textContent = 'Нужно согласие на обработку персональных данных';
    consentBox.hidden = false;
    $('[data-consent-row]').classList.add('consent--invalid');
    $('#consent').focus();
    return;
  }
  $('[data-consent-row]').classList.remove('consent--invalid');

  setBusy(true);
  try {
    const appointment = await createAppointment({
      masterId: visit.slot.masterId,
      serviceIds: visit.serviceIds,
      startsAt: visit.slot.startsAt,
      clientComment: $('#comment').value.trim(),
      // Токен удержания забирает слот той же транзакцией, что создаёт запись.
      holdToken: hold && hold.starts_at.at_utc === visit.slot.startsAt ? hold.token : undefined,
      consent: true,
    });
    // Выбор больше не нужен: визит создан, и воронка начинается заново.
    clearSelection();
    window.location.assign(`${PAGES.done}?id=${appointment.id}`);
  } catch (err) {
    if (err.status === 401) {
      // Сессия кончилась между открытием экрана и подтверждением: выбор
      // сохранён, человек вернётся сюда же.
      window.location.assign(authHref(PAGES.login, PAGES.confirm));
      return;
    }
    if (err.status === 409 && err.details && err.details.reason === 'overlap') {
      // Слот перехватили во время оформления — экран 6 со свободным временем
      // этого же мастера. Комментарий и согласие переносим: человек дал их
      // минуту назад, а экран 6 по прототипу завершает запись сам.
      const when = zoned(visit.slot.startsAt, visit.settings.timezone);
      setConflict({
        masterId: visit.slot.masterId,
        startsAt: visit.slot.startsAt,
        lostDate: when.date,
        lostTime: when.time,
        nearestSlots: Array.isArray(err.details.nearest_slots) ? err.details.nearest_slots : [],
        comment: $('#comment').value.trim(),
        consent: true,
      });
      window.location.assign(PAGES.taken);
      return;
    }
    setBusy(false);
    // `details` у 400 про согласие и у 409 про лимит — это текст сервера,
    // его и показываем.
    box.replaceChildren(document.createTextNode(
      `Запись не создана. ${err.toText ? err.toText() : err.message}`,
    ));
    box.hidden = false;
  }
}

/* -------------------------------------------------------------- старт */

async function load() {
  const { serviceIds, masterId, slot } = getSelection();

  if (serviceIds.length === 0) {
    requireStep('Сначала выберите услуги.', { href: PAGES.services, label: 'Выбрать услуги' });
    return;
  }
  if (masterId === null) {
    requireStep('Сначала выберите мастера.', { href: PAGES.master, label: 'Выбрать мастера' });
    return;
  }
  if (slot === null) {
    requireStep('Время ещё не выбрано — подтверждать нечего.',
      { href: PAGES.time, label: 'Выбрать время' });
    return;
  }

  try {
    const [settings, services, eligible] = await Promise.all([
      getSettings(), getServices(), getMasters({ serviceIds }),
    ]);

    // Гость — обычное состояние этого экрана, а не ошибка: 401 от
    // `GET /auth/me` значит «не вошёл».
    try {
      user = await getMe();
    } catch (err) {
      if (err.status !== 401) throw err;
      user = null;
    }

    const chosen = serviceIds
      .map((id) => services.find((service) => service.id === id))
      .filter(Boolean);
    const master = eligible.find((item) => item.id === slot.masterId);

    if (chosen.length !== serviceIds.length || !master) {
      // Услуга скрыта или мастер больше не выполняет весь состав — время
      // выбиралось под другие условия, и шаг 3 надо пройти заново.
      requireStep('Состав визита изменился: выберите время заново.',
        { href: PAGES.time, label: 'Выбрать время' });
      return;
    }

    const when = zoned(slot.startsAt, settings.timezone);
    if (when.date < salonToday(settings.timezone)) {
      requireStep('Выбранное время уже прошло. Выберите новое.',
        { href: PAGES.time, label: 'Выбрать время' });
      return;
    }

    visit = {
      serviceIds,
      services: chosen,
      master,
      slot,
      settings,
      // Длительность и сумма — по выбранным услугам, как на шагах 1 и 2.
      // Окончательную цену фиксирует сервер при создании записи.
      durationMin: chosen.reduce((sum, service) => sum + service.duration_min, 0),
      priceKopecks: chosen.reduce((sum, service) => sum + service.price_kopecks, 0),
    };

    if (user) {
      try {
        hold = await getCurrentHold();
      } catch {
        hold = null; // удержание не прочиталось — экран от этого не ломается
      }
    }

    renderSummary();
    renderWho();
    renderHold();
    if (!user) renderGuest();
    refreshIcons();
  } catch (err) {
    showError($('[data-error="page"]'), null, err, load);
  }
}

$('[data-action="confirm"]').addEventListener('click', confirm);
$('#consent').addEventListener('change', () => {
  $('[data-error="consent"]').hidden = true;
  $('[data-consent-row]').classList.remove('consent--invalid');
});

// Удержание с шага 3 снимается только в «Выйти»: «Назад» и «Изменить»
// возвращают на шаг выбора времени, где слот нужен человеку выбранным.
setupExit(() => (hold ? hold.token : null));

refreshIcons();
load();
