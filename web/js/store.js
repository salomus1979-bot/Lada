'use strict';

/**
 * Выбор клиента в воронке записи: услуги и мастер.
 *
 * Одно место на все четыре шага — страница не лезет в хранилище сама.
 * Держим в `sessionStorage`: выбор нужен, пока человек идёт по шагам, и
 * переживает перезагрузку и «назад», но не должен ждать его в следующий
 * визит. Если хранилище недоступно (приватное окно, запрет на данные
 * сайта), выбор живёт в памяти вкладки — страница от этого не ломается.
 *
 * Здесь только то, что выбрал человек. Ни цен, ни длительностей, ни имён
 * мастеров: они приходят с сервера и в хранилище устаревали бы.
 */

const KEY = 'lada.booking';

/**
 * Передача конфликта с шага 4 на экран 6 «Время занято». Отдельный ключ, а не
 * поле выбора: это не выбор человека, а разовый ответ сервера (409), который
 * читается один раз и сразу стирается.
 */
const CONFLICT_KEY = 'lada.booking.conflict';

/** Запасное хранилище, когда sessionStorage недоступен. */
let memory = null;
let conflictMemory = null;

const EMPTY = { serviceIds: [], masterId: null, slot: null };

/** Слот из хранилища: только начало визита и мастер, которому оно принадлежит. */
function readSlot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startsAt = typeof raw.startsAt === 'string' ? raw.startsAt : null;
  // Мастер здесь всегда конкретный: в режиме «любой свободный» шаг 3
  // запоминает того, чей слот выбран (п. 16 карты экранов).
  const masterId = Number.isInteger(raw.masterId) ? raw.masterId : null;
  return startsAt && masterId !== null ? { startsAt, masterId } : null;
}

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    return {
      serviceIds: Array.isArray(parsed.serviceIds) ? parsed.serviceIds.filter(Number.isInteger) : [],
      // `'any'` — «любой свободный мастер», null — мастер ещё не выбран.
      masterId: parsed.masterId === 'any' || Number.isInteger(parsed.masterId)
        ? parsed.masterId : null,
      slot: readSlot(parsed.slot),
    };
  } catch {
    return memory ? { ...memory } : { ...EMPTY };
  }
}

function write(state) {
  memory = { ...state };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Хранилище закрыто — остаётся память вкладки. Молча: для человека
    // ничего не меняется, пока он не перезагрузит страницу.
  }
}

/** Весь выбор: `{ serviceIds, masterId }`. */
export function getSelection() {
  return read();
}

/** Выбранные услуги, в порядке добавления. */
export function getServiceIds() {
  return read().serviceIds;
}

/** Добавить или убрать услугу. Возвращает новый список. */
export function toggleService(id) {
  const state = read();
  const next = state.serviceIds.includes(id)
    ? state.serviceIds.filter((item) => item !== id)
    : [...state.serviceIds, id];
  // Мастер привязан к составу услуг: поменялся состав — выбор мастера
  // больше не обязан быть верным, и шаг 2 выбирается заново. Слот тем более:
  // от состава услуг зависит длительность визита, а значит и свободные начала.
  write({ serviceIds: next, masterId: null, slot: null });
  return next;
}

/** Убрать услугу (крестик в карточке визита). */
export function removeService(id) {
  const state = read();
  write({ serviceIds: state.serviceIds.filter((item) => item !== id), masterId: null, slot: null });
  return read().serviceIds;
}

/** Выбранный мастер: id, `'any'` или null. */
export function getMasterId() {
  return read().masterId;
}

/** Запомнить мастера: id, `'any'` для «любого свободного» или null. */
export function setMasterId(masterId) {
  // Слот принадлежит конкретному мастеру: сменили мастера — выбранное время
  // к нему уже не относится.
  write({ ...read(), masterId, slot: null });
}

/**
 * Выбранное время: `{ startsAt, masterId }` или null.
 *
 * `startsAt` — UTC-метка начала визита ровно в том виде, в котором её отдал
 * API: её же шаг 4 отправляет в `POST /appointments`. Локальное время для
 * показа страницы считают сами, по `timezone` из настроек: храни мы здесь
 * «14:00», оно разъехалось бы с поясом студии.
 */
export function getSlot() {
  return read().slot;
}

/** Запомнить выбранный слот (шаг 3). `masterId` — всегда конкретный мастер. */
export function setSlot({ startsAt, masterId }) {
  write({ ...read(), slot: { startsAt, masterId } });
}

/** Снять выбор времени — слот больше не за человеком. */
export function clearSlot() {
  write({ ...read(), slot: null });
}

/** Сбросить весь выбор — «Выйти» из воронки. */
export function clearSelection() {
  memory = { ...EMPTY };
  conflictMemory = null;
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(CONFLICT_KEY);
  } catch {
    // см. write()
  }
}

/* ------------------------------------------------- конфликт слота (409) */

/**
 * Запомнить конфликт для экрана 6: какое время перехватили, у какого мастера,
 * что сервер предложил взамен (`details.nearest_slots`) и с чем человек уже
 * согласился на шаге 4 — комментарий и согласие на обработку данных.
 *
 * Комментарий и согласие переносятся, потому что по прототипу экран 6
 * завершает запись сам («Подтвердить новое время»), а спрашивать согласие
 * второй раз за одно оформление не за что: человек дал его минуту назад на
 * шаге 4.
 */
export function setConflict(conflict) {
  conflictMemory = { ...conflict };
  try {
    sessionStorage.setItem(CONFLICT_KEY, JSON.stringify(conflict));
  } catch {
    // см. write()
  }
}

/**
 * Прочитать конфликт и сразу стереть его: экран 6 показывает ответ сервера
 * один раз. Иначе перезагрузка страницы снова рисовала бы «только что
 * заняли» про время, которое человек уже сменил.
 */
export function takeConflict() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(CONFLICT_KEY);
    sessionStorage.removeItem(CONFLICT_KEY);
  } catch {
    // см. write()
  }
  const kept = conflictMemory;
  conflictMemory = null;
  if (!raw) return kept;
  try {
    return JSON.parse(raw);
  } catch {
    return kept;
  }
}
