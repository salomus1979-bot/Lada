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
const patch = (path, body) => request('PATCH', path, { body });
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

/* ------------------------------------------- админ: услуги и мастера */

/**
 * Поля формы называются по-русски дважды: в разметке и в API. Перевод
 * камелКейса в змеиный регистр лежит здесь, как и у клиентских функций выше
 * (`serviceIds` → `service_ids`), — страницы о написании в запросе не думают.
 *
 * В тело уходят только заполненные поля: PATCH меняет ровно то, что прислали,
 * а `undefined` означает «не трогать», и отличать его от «очистить» важно.
 */
const apiFields = (map, fields) => Object.fromEntries(
  Object.entries(fields)
    .filter(([key, value]) => value !== undefined && map[key])
    .map(([key, value]) => [map[key], value]),
);

const SERVICE_FIELDS = {
  categoryId: 'category_id',
  name: 'name',
  description: 'description',
  durationMin: 'duration_min',
  bufferAfterMin: 'buffer_after_min',
  priceKopecks: 'price_kopecks',
  isVisible: 'is_visible',
  isActive: 'is_active',
};

const MASTER_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  specialization: 'specialization',
  experienceYears: 'experience_years',
  bio: 'bio',
  photoUrl: 'photo_url',
  sortOrder: 'sort_order',
  serviceIds: 'service_ids',
  isVisible: 'is_visible',
  isActive: 'is_active',
};

/**
 * GET /api/admin/services — весь прайс, включая отключённые услуги.
 *
 * `include_inactive=1` стоит по умолчанию намеренно: администратор должен
 * видеть всё, в том числе отключённое, иначе строка просто исчезнет и вернуть
 * её будет неоткуда. Клиентский `GET /services` отключённые не отдаёт вовсе.
 */
export async function getAdminServices({ includeInactive = true } = {}) {
  const { services } = await get('/admin/services', { include_inactive: includeInactive });
  return services;
}

/** POST /api/admin/services — завести услугу. Цену примет только владелец. */
export async function createService(fields) {
  const { service } = await post('/admin/services', apiFields(SERVICE_FIELDS, fields));
  return service;
}

/** PATCH /api/admin/services/:id — изменить услугу, включить или отключить. */
export async function updateService(id, fields) {
  const { service } = await patch(`/admin/services/${id}`, apiFields(SERVICE_FIELDS, fields));
  return service;
}

/**
 * DELETE /api/admin/services/:id — попросить удалить услугу.
 *
 * Решение принимает сервер, поэтому ответ возвращается целиком: `deleted`
 * говорит, удалил он строку или отключил, а `message` — почему. Экран это
 * сообщение показывает, а не придумывает своё.
 */
export function deleteService(id) {
  return del(`/admin/services/${id}`);
}

/** GET /api/admin/masters — все мастера, включая отключённых. */
export async function getAdminMasters({ includeInactive = true } = {}) {
  const { masters } = await get('/admin/masters', { include_inactive: includeInactive });
  return masters;
}

/** POST /api/admin/masters — завести мастера вместе со списком его услуг. */
export async function createMaster(fields) {
  const { master } = await post('/admin/masters', apiFields(MASTER_FIELDS, fields));
  return master;
}

/**
 * PATCH /api/admin/masters/:id — изменить мастера.
 * `serviceIds` заменяет список его услуг целиком — это та самая связь, по
 * которой клиенту подбираются мастера на шаге 2 воронки.
 */
export async function updateMaster(id, fields) {
  const { master } = await patch(`/admin/masters/${id}`, apiFields(MASTER_FIELDS, fields));
  return master;
}

/** DELETE /api/admin/masters/:id — то же правило, что у услуги: решает сервер. */
export function deleteMaster(id) {
  return del(`/admin/masters/${id}`);
}

/* -------------------------------------------- админ: записи и блокировки */

/**
 * GET /api/admin/appointments — записи студии за день.
 *
 * Время в ответе уже в поясе студии: у каждой метки есть `at_utc` и
 * разложенные `local_date` / `local_time`. Экран показывает местное и ничего
 * не пересчитывает — пояс знает сервер (`salon_settings.timezone`).
 *
 * Вместе с записями приходит их история (`history`): кто создал, кто перенёс
 * откуда и куда, кто отменил и почему.
 */
export async function getAdminAppointments({ date, masterId, status, limit } = {}) {
  return get('/admin/appointments', {
    date_from: date, date_to: date, master_id: masterId, status, limit,
  });
}

/**
 * POST /api/appointments — запись за клиента.
 *
 * `isOverride` — осознанное наложение: его присылают ТОЛЬКО после того, как
 * сервер уже ответил 409 и администратор подтвердил. Проверка занятости при
 * этом не отключается: без признака она срабатывает как обычно, а с ним
 * сервер разрешает наложение и помечает им запись.
 */
export async function createAppointmentForClient({
  clientUserId, masterId, serviceIds, startsAt, clientComment, source, isOverride,
}) {
  const { appointment } = await post('/appointments', {
    client_user_id: clientUserId,
    master_id: masterId,
    service_ids: serviceIds,
    starts_at: startsAt,
    ...(clientComment ? { client_comment: clientComment } : {}),
    ...(source ? { source } : {}),
    ...(isOverride ? { is_override: true } : {}),
  });
  return appointment;
}

/** GET /api/admin/clients — поиск клиента по имени, телефону или e-mail. */
export async function searchClients(query) {
  const { clients } = await get('/admin/clients', { q: query, limit: 10 });
  return clients;
}

/**
 * GET /api/admin/time-blocks — заблокированное время за день: перерывы,
 * выходные, отпуска и больничные. Для клиента этого времени не существует —
 * расчёт доступности вычитает блокировки.
 */
export async function getAdminTimeBlocks({ date, masterId } = {}) {
  const { time_blocks: blocks } = await get('/admin/time-blocks', {
    date, master_id: masterId,
  });
  return blocks;
}

/** POST /api/admin/masters/:id/time-blocks — закрыть мастеру часы или день. */
export async function blockTime(masterId, { type, startsAt, endsAt, comment }) {
  const { time_block: block } = await post(`/admin/masters/${masterId}/time-blocks`, {
    type, starts_at: startsAt, ends_at: endsAt, ...(comment ? { comment } : {}),
  });
  return block;
}

/** DELETE /api/admin/masters/:id/time-blocks/:blockId — снять блокировку. */
export function unblockTime(masterId, blockId) {
  return del(`/admin/masters/${masterId}/time-blocks/${blockId}`);
}
