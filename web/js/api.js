'use strict';

/**
 * Единственная точка обращения к API — правило 3 из docs/frontend-rules.md.
 * Страницы не делают `fetch` сами: они вызывают функции отсюда, поэтому
 * заголовки, разбор ответа и текст ошибки лежат в одном месте.
 *
 * Запросы идут на тот же origin: статику и `/api` отдаёт один dev-сервер
 * (web/server.js), сессия живёт в HttpOnly-cookie с SameSite=Lax.
 */

/** Ошибка API: статус, код, человеческий текст и `details` по полям. */
export class ApiError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `Запрос не прошёл (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = err.code || 'http_error';
    this.details = err.details;
  }

  /**
   * Текст для показа человеку (правило 7: ошибку видно на экране, а не
   * только в консоли). Сообщение API плюс разбор `details` по полям.
   */
  toText() {
    const lines = [this.message];
    if (this.details && typeof this.details === 'object') {
      for (const [field, value] of Object.entries(this.details)) {
        lines.push(`${field}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }
    return lines.join('. ');
  }
}

/** Строка запроса: пустые значения не отправляются вовсе. */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/**
 * Запрос к API. Возвращает разобранный JSON, при ошибке бросает ApiError.
 *
 * `credentials: 'same-origin'` — единственное, что нужно для сессии: куку
 * ставит и снимает сам сервер (HttpOnly), браузер шлёт её обратно. Токен из
 * ответа (`session_token`) страницы не читают и никуда не сохраняют: в
 * localStorage он был бы доступен любому скрипту на странице.
 */
async function request(method, path, { params, body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}${qs(params)}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Сеть не ответила вовсе — отдельный случай: ответа и статуса нет.
    throw new ApiError(0, {
      error: { code: 'network_error', message: `Сервер недоступен: ${err.message}` },
    });
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, {
        error: { code: 'bad_response', message: 'Сервер ответил не в том формате' },
      });
    }
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

const get = (path, params) => request('GET', path, { params });
const post = (path, body) => request('POST', path, { body });
const del = (path) => request('DELETE', path);

/* ------------------------------------------------------------- каталог */

/** GET /api/settings — название студии, телефон, адрес, правила записи. */
export async function getSettings() {
  const { settings } = await get('/settings');
  return settings;
}

/** GET /api/service-categories — категории каталога, в порядке сортировки. */
export async function getServiceCategories() {
  const { categories } = await get('/service-categories');
  return categories;
}

/** GET /api/services — витрина услуг. Фильтры: `category`, `master_id`. */
export async function getServices(params) {
  const { services } = await get('/services', params);
  return services;
}

/**
 * GET /api/masters — мастера.
 * `{ serviceIds }` оставляет только тех, кто выполняет ВСЕ эти услуги:
 * визит делает один мастер целиком. Имя параметра переводится в
 * `service_ids` здесь же — страницы о написании в запросе не думают,
 * так же как в `getAvailability`.
 */
export async function getMasters({ serviceIds, ...rest } = {}) {
  const { masters } = await get('/masters', { ...rest, service_ids: serviceIds });
  return masters;
}

/**
 * GET /api/masters/:id/availability — свободное начало визита на дату.
 * `service_ids` обязателен: длительность визита считается по услугам.
 */
export function getAvailability(masterId, { date, serviceIds }) {
  return get(`/masters/${masterId}/availability`, { date, service_ids: serviceIds });
}

/* ------------------------------------------------------- авторизация */

/**
 * POST /api/auth/login — вход по e-mail и паролю.
 * Ответ 200 уже означает открытую сессию: куку поставил сервер.
 * Возвращается только профиль; `session_token` из ответа не используется.
 */
export async function login({ email, password }) {
  const { user } = await post('/auth/login', { email, password });
  return user;
}

/**
 * POST /api/auth/register — регистрация клиента.
 * Поля ровно те, что ждёт сервер; 201 сразу открывает сессию.
 */
export async function register({ name, email, phone, password, passwordConfirm, consent }) {
  const { user } = await post('/auth/register', {
    name,
    email,
    phone,
    password,
    password_confirm: passwordConfirm,
    consent,
  });
  return user;
}

/**
 * GET /api/auth/me — профиль текущего пользователя: имя, e-mail, телефон, роли.
 * Без сессии отвечает 401 — для страниц кабинета это не ошибка на экране,
 * а признак того, что человек не вошёл.
 */
export async function getMe() {
  const { user } = await get('/auth/me');
  return user;
}

/**
 * POST /api/auth/logout — выход. Куку снимает сервер, страница ничего не
 * чистит: ей нечего чистить (в localStorage сессии нет).
 */
export async function logout() {
  await post('/auth/logout');
}

/**
 * GET /api/auth/sessions — «Активные сессии» экрана 16: устройство, время
 * входа и срок, пометка текущей (`is_current`).
 *
 * Токенов в ответе нет вовсе — только непрозрачный `id`, по которому сессию и
 * завершают. Это решение сервера, и страница на него опирается: показывать
 * нечего, кроме подписи устройства.
 */
export async function getSessions() {
  const { sessions } = await get('/auth/sessions');
  return sessions;
}

/**
 * DELETE /api/auth/sessions/:id — завершить одну свою сессию.
 *
 * Возвращается `was_current`: завершить можно и ту, из которой смотришь, —
 * тогда это обычный выход, и сервер снимает куку. Экран по этому признаку
 * уходит на вход, а не делает вид, что ничего не случилось.
 */
export async function endSession(id) {
  const { was_current: wasCurrent } = await del(`/auth/sessions/${id}`);
  return wasCurrent;
}

/* ------------------------------------------------------------- записи */

/**
 * GET /api/appointments — свои записи.
 * `scope`: `upcoming` (по умолчанию) | `past` | `all`, `limit` — до 100.
 *
 * У каждой записи приходят и права владельца: `can_cancel`, `can_reschedule`,
 * `reschedules_left`, `cancel_window_hours`. Экран их не вычисляет — окно
 * отмены и лимит переносов знает только сервер.
 */
export async function getAppointments(params) {
  const { appointments } = await get('/appointments', params);
  return appointments;
}

/**
 * GET /api/appointments/:id — одна своя запись целиком: услуги, мастер,
 * комментарий, права владельца. Чужая и несуществующая отвечают одинаково —
 * 404: факт существования чужой записи наружу не выходит.
 */
export async function getAppointment(id) {
  const { appointment } = await get(`/appointments/${id}`);
  return appointment;
}

/**
 * POST /api/appointments/:id/cancel — отмена своей записи.
 * `reason` необязательна: на экране 7 причину не спрашивают (это делает
 * экран 9 «Детали записи»). Возвращается запись уже в новом статусе.
 */
export async function cancelAppointment(id, reason) {
  const { appointment } = await post(`/appointments/${id}/cancel`, reason ? { cancel_reason: reason } : {});
  return appointment;
}

/**
 * POST /api/appointments/:id/reschedule — перенос на другое время того же
 * мастера. Состав услуг не меняется, поэтому в запросе только новое начало и
 * токен удержания — им перенос забирает слот, который сам же и держит.
 *
 * Окно переноса и лимит проверяет сервер: 409 с человеческим текстом (а при
 * занятом времени — ещё и `details.nearest_slots`) приходит оттуда.
 */
export async function rescheduleAppointment(id, { startsAt, holdToken }) {
  const { appointment } = await post(`/appointments/${id}/reschedule`, {
    starts_at: startsAt,
    ...(holdToken ? { hold_token: holdToken } : {}),
  });
  return appointment;
}

/* ---------------------------------------------------- удержание слота */

/**
 * POST /api/holds — удержать выбранный слот, пока человек не подтвердил.
 *
 * Возвращается ответ целиком: `{ hold, expires_in_sec }`. Остаток времени
 * нужен экрану (по нему идёт отсчёт), а `hold.token` — переносу и созданию
 * записи: они забирают удержание и этим же снимают его.
 */
export function holdSlot({ masterId, serviceIds, startsAt }) {
  return post('/holds', { master_id: masterId, service_ids: serviceIds, starts_at: startsAt });
}

/**
 * GET /api/holds/current — своё действующее удержание.
 *
 * Нужен шагу 4: после перезагрузки страницы токен и остаток времени брать
 * больше негде — страница их не хранит (решение 8 карты экранов). Нет
 * удержания — ответ 404; для экрана это не ошибка, а «время за вами уже не
 * держится», поэтому возвращается `null`, а не бросается ApiError.
 */
export async function getCurrentHold() {
  try {
    const { hold } = await get('/holds/current');
    return hold;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * DELETE /api/holds/:token — снять своё удержание.
 *
 * Вызывается, когда человек уходит с шага выбора времени: слот освобождается
 * сразу, не дожидаясь `hold_ttl_min`. Чужого удержания и уже истёкшего нет —
 * оба отвечают 404, и для вызывающего это не ошибка: держать больше нечего.
 */
export async function releaseHold(token) {
  try {
    await request('DELETE', `/holds/${token}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

/**
 * POST /api/appointments — создание записи клиентом.
 *
 * `consent` обязателен: согласие на обработку данных даёт сам человек
 * (см. api/src/lib/booking.js). `holdToken` необязателен, но с ним слот
 * переходит из «удержан» в «занят» одной транзакцией, без промежутка, в
 * который его мог бы занять другой клиент.
 *
 * Конфликт времени приходит как 409 с `details.reason = 'overlap'` и
 * `details.nearest_slots` — экран 6 показывает их как варианты.
 */
export async function createAppointment({
  masterId, serviceIds, startsAt, clientComment, holdToken, consent,
}) {
  const { appointment } = await post('/appointments', {
    master_id: masterId,
    service_ids: serviceIds,
    starts_at: startsAt,
    ...(clientComment ? { client_comment: clientComment } : {}),
    ...(holdToken ? { hold_token: holdToken } : {}),
    consent,
  });
  return appointment;
}
