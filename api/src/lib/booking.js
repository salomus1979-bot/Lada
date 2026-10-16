'use strict';

/**
 * Единственный путь изменения таблицы `appointments`.
 *
 * Запись создаётся, переносится, отменяется и меняет статус только здесь.
 * Роуты (`routes/appointments.js`, `routes/admin.js`) валидацию и проверки не
 * дублируют: они вызывают функцию этого модуля и оформляют ответ. Так правило
 * «слот не занимают дважды» нельзя обойти, добавив ещё один эндпоинт, —
 * второго места вставки просто нет.
 *
 * ── Роли ──────────────────────────────────────────────────────────────────
 * Создание — одна функция `createAppointment` для всех, кто вошёл. Роль не
 * выбирает путь, она открывает дополнительные ПОЛЯ, и каждое поле действует
 * только у персонала (admin, owner):
 *
 *   поле              | клиент / мастер          | admin, owner
 *   ------------------+--------------------------+---------------------------
 *   client_user_id    | игнорируется (на себя)   | клиент визита
 *   source            | игнорируется ('online')  | телефон, лично, WhatsApp
 *   is_override       | игнорируется (false)     | осознанное наложение
 *   hold_token        | снимает своё удержание   | только при записи на себя
 *   consent           | обязателен               | не требуется за клиента
 *
 * Проверки занятости, лимитов, транзакция и ответ 409 с подсказками — общие
 * для всех ролей. Поля персонала у клиента и мастера игнорируются молча, а не
 * отклоняются: иначе подменённый запрос из браузера получал бы 400 вместо
 * обычной записи на себя.
 *
 * Роль `master` своего пути записи не имеет и иметь не должна. Это сверено с
 * прототипом, а не упущено:
 *   - создания записи у мастера нет ни на одной из страниц 35–42; «Новая
 *     запись за клиента» — только админская страница 24;
 *   - отмена запрещена прямым текстом страницы 38: «Отменить запись может
 *     только администратор. Мы отправим ему ваш запрос»;
 *   - перенос там же остаётся за администратором: «получит запрос и решит,
 *     отменить или перенести визит».
 * Поэтому createAppointment, cancelAppointment и rescheduleAppointment вида
 * актора `master` получать не должны. На общем пути создания аккаунт с ролью
 * `master` — такой же клиент, записывающий себя (`isStaff` его не включает).
 *
 * Единственная операция мастера над визитом — смена статуса: кнопки «Клиент
 * пришёл», «Не пришёл», «Завершён» на странице 38. Она живёт в
 * changeAppointmentStatus, там же, где админская, и роль только сужает её:
 * MASTER_STATUSES без отмены плюс запрет на чужие визиты. Кабинет —
 * routes/master.js.
 */

const db = require('./db');
const { isStaff } = require('./auth');
const { Validator } = require('./validate');
const { ApiError, badRequest, conflict, forbidden, notFound } = require('./errors');
const {
  ACTIVE_STATUSES, purgeExpiredHolds, loadServices,
  assertMasterPerformsServices, assertSlotBookable, nearestSlots,
} = require('./availability');
const { nowUtc, diffMinutes, utcToZoned, presentInstant } = require('./time');
const { STAFF_SOURCES } = require('./presenters');

/** Статусы, которые ставит администратор помимо отмены. */
const STAFF_STATUSES = ['confirmed', 'completed', 'no_show', 'cancelled_by_studio'];

/**
 * Статусы, доступные мастеру: кнопки «Клиент пришёл», «Не пришёл» и
 * «Завершён» со страницы 38. Отмены среди них нет намеренно — по прототипу
 * мастер её только запрашивает у администратора.
 */
const MASTER_STATUSES = ['confirmed', 'completed', 'no_show'];

const APPOINTMENT_COLUMNS = `
  a.id, a.client_user_id, a.master_id, a.starts_at_utc, a.ends_at_utc,
  a.service_duration_min, a.total_price_kopecks, a.status, a.client_comment,
  a.cancel_reason, a.reschedule_count, a.is_override, a.source, a.created_at_utc,
  m.first_name AS master_first_name, m.last_name AS master_last_name`;

function fetchAppointment(id) {
  return db.one(
    `SELECT ${APPOINTMENT_COLUMNS},
            u.name AS client_name, u.phone AS client_phone, u.email AS client_email
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
       JOIN users u ON u.id = a.client_user_id
      WHERE a.id = ?`,
    [id],
  );
}

function fetchServices(appointmentId) {
  return db.all(
    `SELECT service_id, name_snapshot, price_kopecks_snapshot,
            duration_min_snapshot, buffer_after_min_snapshot
       FROM appointment_services WHERE appointment_id = ? ORDER BY id`,
    [appointmentId],
  );
}

/**
 * Превращает срабатывание триггера appointments_no_overlap_* в 409.
 *
 * Триггер — последний рубеж: в норме конфликт ловит assertSlotBookable внутри
 * той же транзакции. Сюда управление попадает, если слот заняли между нашей
 * проверкой и вставкой, либо если запись пришла в обход обычного пути.
 *
 * Наружу уходит понятный текст и список ближайших свободных начал этого же
 * мастера; сообщение SQLite клиенту не показывается.
 */
function overlapConflict({ masterId, startAtUtc, occupiedMin, settings, excludeAppointmentId = null }) {
  // Длительность могла не успеть посчитаться — тогда просто не предлагаем варианты.
  const suggestions = occupiedMin > 0
    ? nearestSlots({
      masterId,
      fromDate: utcToZoned(new Date(startAtUtc), settings.timezone).date,
      occupiedMin,
      settings,
      excludeAppointmentId,
    })
    : [];
  return conflict('Это время уже занято, выберите другое', {
    reason: 'overlap',
    nearest_slots: suggestions.map((iso) => presentInstant(iso, settings.timezone)),
  });
}

/**
 * Приводит оба источника конфликта к одному ответу.
 *   - прикладная проверка assertSlotBookable (обычный путь);
 *   - триггер БД appointments_no_overlap_* (гонка или запись в обход API).
 * В обоих случаях клиент получает 409 с подсказками, а текст SQLite наружу
 * не уходит. Прочие ошибки пробрасываются как есть.
 */
function rethrowAsConflict(err, context) {
  const fromTrigger = db.isOverlapError(err);
  const fromCheck = err instanceof ApiError && err.status === 409
    && err.details && err.details.reason === 'overlap';
  if (fromTrigger || fromCheck) throw overlapConflict(context);
  throw err;
}

/**
 * Право на изменение записи: владелец записи либо персонал студии.
 * Возвращает вид актора — им дальше различаются правила, а не путь записи.
 */
function assertMayModify(row, user) {
  if (row.client_user_id === user.id) return 'client';
  if (isStaff(user)) return 'staff';
  // Чужую запись не раскрываем даже фактом её существования.
  throw notFound('Запись не найдена');
}

/* ------------------------------------------------------------- создание */

/**
 * Создание записи — единственная вставка в `appointments` во всём API.
 *
 * Если передан `hold_token`, удержание снимается этой же транзакцией:
 * слот переходит из «удержан» в «занят» без промежутка, в который
 * его мог бы занять другой клиент.
 *
 * @returns {{ id: number, forClient: boolean, settings: object }}
 *          forClient — визит оформлен персоналом за другого человека;
 *          роут по этому признаку выбирает вид ответа.
 */
function createAppointment(user, body) {
  const input = new Validator(body)
    .int('master_id', { min: 1 })
    .idArray('service_ids')
    .utcInstant('starts_at')
    .string('client_comment', { required: false, max: 1000 })
    .string('hold_token', { required: false, min: 64, max: 64 })
    .bool('is_override', { required: false, def: false })
    .int('client_user_id', { required: false, min: 1 })
    .enum('source', STAFF_SOURCES, { required: false })
    .bool('consent', { required: false })
    .done();

  // ── ПРОВЕРКА РОЛИ для осознанного наложения ──────────────────────────────
  // Признак действует, только если его прислал администратор или владелец.
  // Клиенту и мастеру поле молча игнорируется (а не отклоняется с ошибкой):
  // для них applyOverride остаётся false, проверка занятости выполняется
  // полностью, и попытка сесть на занятое время упирается в обычный 409.
  const applyOverride = input.is_override === true && isStaff(user);

  // ── ПРОВЕРКА РОЛИ для записи за клиента ──────────────────────────────────
  // Та же схема, что у is_override: у персонала поле выбирает клиента визита,
  // у клиента и мастера молча игнорируется — визит оформляется на них самих.
  // Администратор, приславший свой же id, записывается на себя: это обычный
  // путь, а не админский.
  const clientUserId = isStaff(user) && input.client_user_id
    ? input.client_user_id
    : user.id;
  const forClient = clientUserId !== user.id;

  // ── ПРОВЕРКА РОЛИ для источника записи ───────────────────────────────────
  // Та же схема: у персонала поле называет источник (телефон, лично,
  // WhatsApp), у клиента молча игнорируется — его запись помечается 'online'
  // самим API. Поэтому `source = 'online'` всегда означает «клиент оформил
  // сам», а не «так сказал вызывающий»: значение 'online' извне не
  // принимается вовсе (STAFF_SOURCES), и попытка прислать его даёт 400.
  // Персонал без поля оставляет NULL — источник не указан, а не придуман.
  const source = isStaff(user) ? (input.source || null) : 'online';

  // Согласие на обработку данных — свойство клиента, а не оформителя:
  // администратор не может дать его за другого человека, и галочка, стоящая
  // чужой рукой, ничего не подтверждает. Записать можно только существующий
  // аккаунт, а регистрация (POST /api/auth/register) согласия уже требует —
  // значит у клиента оно есть и без этого поля. Поэтому обязательным оно
  // остаётся там, где человек записывается сам.
  if (!forClient && input.consent !== true) {
    throw badRequest('Неверные входные данные', {
      consent: 'нужно согласие на обработку персональных данных',
    });
  }

  if (input.hold_token && !/^[0-9a-f]{64}$/.test(input.hold_token)) {
    throw badRequest('Неверные входные данные', { hold_token: 'неверный формат' });
  }
  // Удержание — часть клиентского оформления: оно привязано к user_id того,
  // кто его взял, и снимается при создании записи. В админском пути удержаний
  // нет — администратор видит сетку и ставит визит сразу. Поэтому токен тут
  // не игнорируется молча, а считается ошибкой входных данных: иначе
  // непонятно, чьё удержание имел в виду вызывающий.
  if (forClient && input.hold_token) {
    throw badRequest('Неверные входные данные', {
      hold_token: 'не применим при записи за клиента',
    });
  }

  // Клиент визита. Записать можно только аккаунт с ролью `client`: персонал и
  // мастера записываются сами, без этого поля. Неизвестный id и аккаунт с
  // другой ролью дают одинаковый 404 — существование чужого аккаунта API не
  // подтверждает.
  const client = forClient
    ? db.one("SELECT id, is_blocked FROM users WHERE id = ? AND role = 'client'", [clientUserId])
    : { id: user.id, is_blocked: user.isBlocked ? 1 : 0 };
  if (!client) throw notFound('Клиент не найден');

  // Блокировка закрывает САМОСТОЯТЕЛЬНУЮ онлайн-запись, и её текст прямо
  // отправляет клиента звонить администратору. Поэтому проверка живёт на
  // своём пути: действуй она и на админском, звонок перестал бы помогать, а
  // снять блокировку в API пока нечем — она выставляется автоматически после
  // неявок (POST /api/admin/appointments/:id/status), и аккаунт остался бы
  // без записи вообще. Администратор, оформляя визит такому клиенту,
  // принимает решение осознанно — как и с наложением.
  if (!forClient && client.is_blocked === 1) {
    throw forbidden('Онлайн-запись для аккаунта ограничена, позвоните администратору');
  }

  const settings = db.settings();

  // Длительность нужна и снаружи транзакции — чтобы предложить альтернативы,
  // если триггер отклонит вставку.
  let occupiedForSuggest = 0;

  const insert = () => db.transaction(() => {
    purgeExpiredHolds();

    // Лимит активных записей — ограничение клиента визита, а не оформителя:
    // иначе администратор упёрся бы в него за всю студию сразу.
    const active = db.one(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE client_user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          AND starts_at_utc > ?`,
      [clientUserId, ...ACTIVE_STATUSES, nowUtc()],
    );
    if (active.n >= settings.max_active_appointments) {
      throw conflict(`Превышен лимит активных записей: ${settings.max_active_appointments}`);
    }

    assertMasterPerformsServices(input.master_id, input.service_ids);
    const { rows: serviceRows, serviceDurationMin, occupiedMin, totalPriceKopecks } =
      loadServices(input.service_ids);
    occupiedForSuggest = occupiedMin;

    const { endAtUtc } = assertSlotBookable({
      masterId: input.master_id,
      startAtUtc: input.starts_at,
      occupiedMin,
      settings,
      // Удержание клиента визита не мешает поставить ему же эту запись: на
      // своём пути это своё удержание, на админском — удержание того, кого
      // записывают. Удержания других клиентов слот держат как обычно.
      holdOwnerUserId: clientUserId,
      excludeHoldToken: input.hold_token || null,
      allowOverlap: applyOverride,
    });

    const timestamp = nowUtc();
    const info = db.run(
      `INSERT INTO appointments
         (client_user_id, master_id, starts_at_utc, ends_at_utc, service_duration_min,
          total_price_kopecks, status, client_comment, is_override, source,
          created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [clientUserId, input.master_id, input.starts_at, endAtUtc, serviceDurationMin,
        totalPriceKopecks, input.client_comment || null, applyOverride ? 1 : 0, source,
        timestamp, timestamp],
    );
    const newId = Number(info.lastInsertRowid);

    // Цена и длительность фиксируются: правка услуги не меняет созданные записи.
    for (const s of serviceRows) {
      db.run(
        `INSERT INTO appointment_services
           (appointment_id, service_id, name_snapshot, price_kopecks_snapshot,
            duration_min_snapshot, buffer_after_min_snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, s.id, s.name, s.price_kopecks, s.duration_min, s.buffer_after_min],
      );
    }

    // Свои удержания снимаем — оформление закончено. Удержания клиента на
    // админском пути не трогаем: он мог держать слот для другого визита,
    // и администратор об этом ничего не знает.
    if (!forClient) db.run('DELETE FROM slot_holds WHERE user_id = ?', [user.id]);
    return newId;
  });

  let id;
  try {
    id = insert();
  } catch (err) {
    // Триггер БД — последний рубеж: слот заняли между проверкой и вставкой.
    rethrowAsConflict(err, {
      masterId: input.master_id,
      startAtUtc: input.starts_at,
      occupiedMin: occupiedForSuggest,
      settings,
    });
  }

  return { id, forClient, settings };
}

/* --------------------------------------------------------------- перенос */

/**
 * Перенос записи на другое время того же мастера — единственное место, где
 * меняются `starts_at_utc` / `ends_at_utc`.
 *
 * Клиента ограничивают окно `cancel_window_hours` и лимит `max_reschedules`;
 * персонал переносит за клиента без этих ограничений. Состав визита и мастер
 * не меняются.
 *
 * @returns {{ actor: 'client'|'staff', settings: object }}
 */
function rescheduleAppointment(user, id, body) {
  const input = new Validator(body)
    .utcInstant('starts_at')
    .string('hold_token', { required: false, min: 64, max: 64 })
    .bool('is_override', { required: false, def: false })
    .done();

  // ── ПРОВЕРКА РОЛИ при переносе ───────────────────────────────────────────
  // Признак описывает текущее размещение визита, поэтому при переносе он
  // вычисляется заново. Для клиента он всегда false, и ниже в UPDATE
  // записывается 0 — иначе визит, однажды поставленный администратором
  // внахлёст, навсегда остался бы невидимым для UPDATE-триггера, и клиент
  // мог бы переносить его на занятое время мимо последнего рубежа.
  const applyOverride = input.is_override === true && isStaff(user);

  const settings = db.settings();
  let occupiedForSuggest = 0;

  const apply = () => db.transaction(() => {
    purgeExpiredHolds();

    const row = fetchAppointment(id);
    if (!row) throw notFound('Запись не найдена');
    const actor = assertMayModify(row, user);

    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Запись уже завершена или отменена');
    }
    if (row.starts_at_utc === input.starts_at) {
      throw badRequest('Неверные входные данные', { starts_at: 'то же самое время' });
    }
    // Клиенту правила обязательны; у персонала перенос за клиента ими не ограничен.
    if (actor === 'client') {
      const minutesLeft = diffMinutes(row.starts_at_utc, nowUtc());
      if (minutesLeft < settings.cancel_window_hours * 60) {
        throw conflict(`Перенос возможен не позднее чем за ${settings.cancel_window_hours} ч до визита`);
      }
      if (row.reschedule_count >= settings.max_reschedules) {
        throw conflict(`Запись можно переносить не более ${settings.max_reschedules} раз`);
      }
    }

    // Состав визита не меняется — длительность берём из зафиксированных услуг.
    const services = fetchServices(id);
    const occupiedMin = services.reduce(
      (sum, s) => sum + s.duration_min_snapshot + s.buffer_after_min_snapshot, 0,
    );
    occupiedForSuggest = occupiedMin;

    const { endAtUtc } = assertSlotBookable({
      masterId: row.master_id,
      startAtUtc: input.starts_at,
      occupiedMin,
      settings,
      holdOwnerUserId: user.id,
      excludeHoldToken: input.hold_token || null,
      excludeAppointmentId: id,
      allowOverlap: applyOverride,
    });

    // `source` здесь намеренно не меняется, в отличие от is_override:
    // признак наложения описывает текущее размещение и пересчитывается,
    // а источник — происхождение записи, и перенос его не отменяет.
    db.run(
      `UPDATE appointments
          SET starts_at_utc = ?, ends_at_utc = ?, is_override = ?,
              reschedule_count = reschedule_count + 1, updated_at_utc = ?
        WHERE id = ?`,
      [input.starts_at, endAtUtc, applyOverride ? 1 : 0, nowUtc(), id],
    );
    db.run('DELETE FROM slot_holds WHERE user_id = ?', [user.id]);
    return actor;
  });

  try {
    return { actor: apply(), settings };
  } catch (err) {
    // Мастера берём из базы: внутри транзакции запись могла быть не прочитана.
    // Если её нет вовсе, ошибка не про пересечение и подсказывать нечего —
    // notFound уходит наружу как есть. Иначе обращение к master_id
    // несуществующей строки само упало бы, и вместо 404 вернулся бы 500.
    const existing = db.one('SELECT master_id FROM appointments WHERE id = ?', [id]);
    if (!existing) throw err;
    // Переносимая запись себя не блокирует, поэтому исключаем её из подсказок.
    rethrowAsConflict(err, {
      masterId: existing.master_id,
      startAtUtc: input.starts_at,
      occupiedMin: occupiedForSuggest,
      settings,
      excludeAppointmentId: id,
    });
    throw err; // недостижимо: rethrowAsConflict всегда бросает
  }
}

/* ----------------------------------------------------------------- отмена */

/**
 * Отмена записи — единственное место, где заполняются `cancel_reason` и
 * `cancelled_at_utc`.
 *
 * Клиент отменяет не позднее чем за `cancel_window_hours` и получает статус
 * `cancelled_by_client`; персонал отменяет в любой момент, статус —
 * `cancelled_by_studio`. Сюда же сведена отмена из админского
 * POST /api/admin/appointments/:id/status: своего UPDATE у неё нет.
 *
 * `asStudio` — отмена от имени студии: её просит админский эндпоинт, который
 * сам стоит за requireRole('admin','owner'). Нужен для случая, когда визит
 * оформлен на самого администратора: в своём кабинете он владелец записи и
 * отменяет её как клиент, а в разделе студии нажимает «Отменить» как студия,
 * и статус не должен зависеть от того, чьё имя стоит в записи.
 *
 * @returns {{ actor: 'client'|'staff', status: string, settings: object }}
 */
function cancelAppointment(user, id, body, { asStudio = false } = {}) {
  const input = new Validator(body)
    .string('cancel_reason', { required: false, max: 500 })
    .done();

  const settings = db.settings();

  const result = db.transaction(() => {
    const row = fetchAppointment(id);
    if (!row) throw notFound('Запись не найдена');
    // Право на изменение проверяется всегда — и чужая запись по-прежнему
    // отвечает 404, а не 403. asStudio выбирает лишь, от чьего имени
    // действует персонал, и ролью его не наделяет.
    const owner = assertMayModify(row, user);
    const actor = asStudio && isStaff(user) ? 'staff' : owner;

    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Запись уже завершена или отменена');
    }
    if (actor === 'client') {
      const minutesLeft = diffMinutes(row.starts_at_utc, nowUtc());
      if (minutesLeft < settings.cancel_window_hours * 60) {
        throw conflict(
          `Отмена возможна не позднее чем за ${settings.cancel_window_hours} ч до визита,`
          + ' свяжитесь со студией по телефону',
        );
      }
    }

    const status = actor === 'client' ? 'cancelled_by_client' : 'cancelled_by_studio';
    const timestamp = nowUtc();
    db.run(
      `UPDATE appointments
          SET status = ?, cancel_reason = ?, cancelled_at_utc = ?, updated_at_utc = ?
        WHERE id = ?`,
      [status, input.cancel_reason || null, timestamp, timestamp, id],
    );
    return { actor, status };
  });

  return { ...result, settings };
}

/* ----------------------------------------------------------- смена статуса */

/**
 * Смена статуса визита — одна функция для администратора и для мастера.
 *
 * `cancelled_by_studio` своего UPDATE не имеет — он уходит в
 * cancelAppointment, тот же путь, которым отменяет клиент. Здесь остаются
 * только статусы, отмену не оформляющие: подтверждение, завершение и неявка.
 * `no_show` увеличивает счётчик неявок и при достижении порога блокирует
 * клиенту онлайн-запись.
 *
 * `masterId` — вызов из кабинета мастера (страница 38). Роль не открывает
 * второго пути, она сужает первый: список статусов укорачивается до
 * MASTER_STATUSES, и чужой визит отвечает 404, как и несуществующий.
 *
 * @returns {{ status: string }}
 */
function changeAppointmentStatus(user, id, body, { masterId = null } = {}) {
  const input = new Validator(body)
    .enum('status', masterId === null ? STAFF_STATUSES : MASTER_STATUSES)
    .string('cancel_reason', { required: false, max: 500 })
    .done();

  if (input.status === 'cancelled_by_studio') {
    // Отмена — одна на весь API, своего UPDATE здесь нет. asStudio даёт
    // статус cancelled_by_studio и снимает окно отмены даже тогда, когда
    // администратор отменяет визит, оформленный на него самого.
    const { status } = cancelAppointment(
      user, id, { cancel_reason: input.cancel_reason }, { asStudio: true },
    );
    return { status };
  }

  const settings = db.settings();

  const apply = () => db.transaction(() => {
    const row = db.one(
      'SELECT id, client_user_id, master_id, status FROM appointments WHERE id = ?', [id],
    );
    if (!row) throw notFound('Запись не найдена');
    // Чужой визит мастеру не раскрываем даже фактом существования — тот же
    // 404, что и у несуществующего, как в assertMayModify.
    if (masterId !== null && row.master_id !== masterId) {
      throw notFound('Запись не найдена');
    }
    if (row.status === input.status) {
      throw conflict('Запись уже в этом статусе');
    }
    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw conflict('Статус завершённой или отменённой записи менять нельзя');
    }

    // Колонки отмены здесь не трогаем: менять статус можно только у активной
    // записи, а у активной они всегда пусты — заполняет их одна
    // cancelAppointment, и вместе с ними она ставит неактивный статус.
    db.run(
      'UPDATE appointments SET status = ?, updated_at_utc = ? WHERE id = ?',
      [input.status, nowUtc(), id],
    );

    if (input.status === 'no_show') {
      db.run('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ?',
        [row.client_user_id]);
      db.run(
        `UPDATE users SET is_blocked = 1
          WHERE id = ? AND no_show_count >= ? AND role = 'client'`,
        [row.client_user_id, settings.no_show_block_threshold],
      );
    }
  });

  try {
    apply();
  } catch (err) {
    // Подтверждение визита тоже проходит через триггер пересечения.
    // Альтернативы здесь не предлагаем: решение за администратором.
    if (db.isOverlapError(err)) {
      throw conflict('Время визита пересекается с другой записью этого мастера',
        { reason: 'overlap' });
    }
    throw err;
  }

  return { status: input.status };
}

module.exports = {
  APPOINTMENT_COLUMNS,
  STAFF_STATUSES,
  MASTER_STATUSES,
  fetchAppointment,
  fetchServices,
  assertMayModify,
  createAppointment,
  rescheduleAppointment,
  cancelAppointment,
  changeAppointmentStatus,
};
