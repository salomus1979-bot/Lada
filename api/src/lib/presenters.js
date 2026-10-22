'use strict';

// Формирование ответов. Ни один роут не отдаёт строку из базы целиком:
// каждое представление перечисляет поля явно.
// Суммы — целые копейки; `*_display` добавляется только для показа.

const { presentInstant, formatForDisplay } = require('./time');

const STATUS_LABELS = {
  pending: 'Ожидает',
  confirmed: 'Подтверждена',
  completed: 'Завершена',
  no_show: 'Клиент не пришёл',
  cancelled_by_client: 'Отменена клиентом',
  cancelled_by_studio: 'Отменена студией',
};

/**
 * Источник записи (страница 24). `online` ставит сам API, когда клиент
 * записался через кабинет; остальные значения называет администратор.
 */
const SOURCE_LABELS = {
  online: 'Онлайн',
  phone: 'Телефон',
  in_person: 'Лично',
  whatsapp: 'WhatsApp',
};

/**
 * Что администратор может прислать в `source`. `online` в список не входит:
 * это отметка самого API о самостоятельной записи, и если бы её принимали
 * извне, по колонке больше нельзя было бы отличить «клиент оформил сам»
 * от «оформила студия».
 */
const STAFF_SOURCES = Object.keys(SOURCE_LABELS).filter((key) => key !== 'online');

const rubles = (kopecks) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

/** Собственный профиль. Без password_hash — он не покидает БД. */
function selfUser(user) {
  return {
    id: user.id,
    roles: user.roles || [],
    name: user.name,
    email: user.email,
    phone: user.phone,
  };
}

/** Услуга для публичного каталога: без буфера уборки — это внутренние данные. */
function serviceView(row) {
  return {
    id: row.id,
    category: { id: row.category_id, slug: row.category_slug, title: row.category_title },
    name: row.name,
    description: row.description,
    duration_min: row.duration_min,
    price_kopecks: row.price_kopecks,
    price_display: rubles(row.price_kopecks),
  };
}

/** Услуга для админа: плюс буфер и флаги видимости. */
function serviceAdminView(row) {
  return {
    ...serviceView(row),
    buffer_after_min: row.buffer_after_min,
    is_visible: row.is_visible === 1,
    is_active: row.is_active === 1,
  };
}

/** Мастер для публичного списка: имя и витрина, без e-mail и телефона. */
function masterView(row, serviceIds = []) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    display_name: `${row.first_name} ${row.last_name}`,
    specialization: row.specialization,
    experience_years: row.experience_years,
    bio: row.bio,
    photo_url: row.photo_url,
    service_ids: serviceIds,
  };
}

/** Мастер для админа: плюс флаги и сведения о доступе в систему. */
function masterAdminView(row, serviceIds = []) {
  return {
    ...masterView(row, serviceIds),
    is_visible: row.is_visible === 1,
    is_active: row.is_active === 1,
    sort_order: row.sort_order,
    access: row.user_id
      ? { granted: true, email: row.account_email, last_login_at_utc: row.last_login_at_utc }
      : { granted: false },
  };
}

function appointmentServiceView(row) {
  return {
    service_id: row.service_id,
    name: row.name_snapshot,
    duration_min: row.duration_min_snapshot,
    price_kopecks: row.price_kopecks_snapshot,
    price_display: rubles(row.price_kopecks_snapshot),
  };
}

/**
 * Запись для её владельца-клиента.
 * @param {object} row строка appointments + поля мастера
 * @param {object[]} services строки appointment_services
 * @param {object} opts { timezone, rules }
 */
function appointmentView(row, services, { timezone, rules = {} } = {}) {
  return {
    id: row.id,
    status: row.status,
    status_label: STATUS_LABELS[row.status],
    master: {
      id: row.master_id,
      display_name: `${row.master_first_name} ${row.master_last_name}`,
    },
    starts_at: presentInstant(row.starts_at_utc, timezone),
    ends_at: presentInstant(row.ends_at_utc, timezone),
    when_display: formatForDisplay(row.starts_at_utc, timezone),
    service_duration_min: row.service_duration_min,
    total_price_kopecks: row.total_price_kopecks,
    total_price_display: rubles(row.total_price_kopecks),
    services: services.map(appointmentServiceView),
    client_comment: row.client_comment,
    cancel_reason: row.cancel_reason,
    reschedule_count: row.reschedule_count,
    created_at_utc: row.created_at_utc,
    ...rules,
  };
}

/** Кто сделал действие — подпись для журнала изменений. */
const ACTOR_TITLES = {
  client: 'клиент',
  master: 'мастер',
  admin: 'администратор',
  owner: 'владелец',
};

/**
 * Строка истории визита: что произошло, когда и кто это сделал.
 *
 * Текст собирает сервер, а не экран: по сырым полям («type: rescheduled»)
 * каждая страница писала бы свою формулировку, и они разошлись бы.
 */
function appointmentEventView(row, { timezone } = {}) {
  const who = `${ACTOR_TITLES[row.actor_role] || row.actor_role}${row.actor_name ? ` ${row.actor_name}` : ''}`;
  const at = (iso) => (iso ? formatForDisplay(iso, timezone) : null);

  let text;
  if (row.type === 'created') {
    text = `Создана (${who})`;
    if (row.reason) text += `, ${row.reason}`;
  } else if (row.type === 'rescheduled') {
    text = `Перенесена с ${at(row.from_starts_at_utc)} на ${at(row.to_starts_at_utc)} (${who})`;
  } else if (row.type === 'cancelled') {
    text = `Отменена (${who})`;
    if (row.reason) text += `, причина: «${row.reason}»`;
  } else {
    text = `Статус: ${STATUS_LABELS[row.status] || row.status} (${who})`;
  }

  return {
    type: row.type,
    actor_role: row.actor_role,
    actor_name: row.actor_name,
    from: row.from_starts_at_utc ? presentInstant(row.from_starts_at_utc, timezone) : null,
    to: row.to_starts_at_utc ? presentInstant(row.to_starts_at_utc, timezone) : null,
    status: row.status,
    reason: row.reason,
    at: presentInstant(row.created_at_utc, timezone),
    text,
  };
}

/**
 * Запись для админа: добавляются данные клиента — у персонала есть на них
 * право, — и история визита, если её передали.
 */
function appointmentAdminView(row, services, { timezone, events = null } = {}) {
  const base = appointmentView(row, services, { timezone });
  return {
    ...base,
    // История: кто создал, кто переносил откуда и куда, кто отменил и почему.
    // Пустой массив и отсутствие истории — разные вещи, поэтому `null`
    // означает «не запрашивали».
    history: events ? events.map((event) => appointmentEventView(event, { timezone })) : null,
    // Признак осознанного наложения виден только персоналу: клиенту
    // не нужно знать, что его визит поставили поверх другого.
    is_override: row.is_override === 1,
    // Источник — внутренний учёт студии, клиенту он не нужен: он и так знает,
    // как записался. Поэтому поле только в админском представлении.
    source: row.source || null,
    source_label: row.source ? SOURCE_LABELS[row.source] : null,
    client: {
      id: row.client_user_id,
      name: row.client_name,
      phone: row.client_phone,
      email: row.client_email,
    },
  };
}

/** Инициалы для кружка-аватара в списках (страницы 36, 40). */
function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toLocaleUpperCase('ru-RU'))
    .join('');
}

/**
 * Визит для кабинета мастера (страница 38).
 *
 * Контакты клиента здесь есть — страница говорит об этом прямо: «Вы видите
 * контакты только своих клиентов». А вот `is_override` и `source` не
 * отдаются: наложение и источник — внутренний учёт студии, и к работе
 * мастера они отношения не имеют.
 */
function appointmentMasterView(row, services, { timezone, clientStats = null } = {}) {
  const base = appointmentView(row, services, { timezone });
  return {
    ...base,
    client: {
      id: row.client_user_id,
      name: row.client_name,
      initials: initials(row.client_name),
      phone: row.client_phone,
      // «12 визитов ко мне · 1 неявка» — счёт по визитам к этому мастеру,
      // а не по студии целиком.
      ...(clientStats ? { visits_with_me: clientStats.visits, no_shows_with_me: clientStats.no_shows } : {}),
    },
  };
}

/** Клиент в списке «Мои клиенты» мастера (страницы 40 и 41). */
function masterClientView(row, { timezone } = {}) {
  return {
    id: row.id,
    name: row.name,
    initials: initials(row.name),
    phone: row.phone,
    visits_count: row.visits_count,
    no_show_count: row.no_show_count_with_me,
    last_visit_at: row.last_visit_at_utc
      ? presentInstant(row.last_visit_at_utc, timezone) : null,
    next_visit_at: row.next_visit_at_utc
      ? presentInstant(row.next_visit_at_utc, timezone) : null,
    is_regular: row.visits_count >= 3,
  };
}

/**
 * Клиент студии для списка персонала (страница «Админ — Клиенты»).
 * Без password_hash и без служебных полей: перечислено только то,
 * что видно в интерфейсе.
 */
function clientAdminView(row, { timezone } = {}) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    is_blocked: row.is_blocked === 1,
    // Есть ли у аккаунта пароль. Клиента, созданного администратором,
    // паролем не наделяют — на странице 26 это статус «Без аккаунта».
    // Флаг считается в SQL, поэтому сам хеш из базы не поднимается.
    has_login: row.has_login === 1,
    visits_count: row.visits_count,
    no_show_count: row.no_show_count,
    // Последний завершённый визит и ближайший активный — то, что
    // администратор смотрит перед тем, как записать клиента.
    last_visit_at: row.last_visit_at_utc
      ? presentInstant(row.last_visit_at_utc, timezone) : null,
    next_visit_at: row.next_visit_at_utc
      ? presentInstant(row.next_visit_at_utc, timezone) : null,
    created_at_utc: row.created_at_utc,
    last_login_at_utc: row.last_login_at_utc,
  };
}

/** Дни недели в нумерации схемы: 1 — понедельник, 7 — воскресенье. */
const WEEKDAY_SHORT = {
  1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб', 7: 'вс',
};

/** Минуты от полуночи в «ЧЧ:ММ». */
const hoursMinutes = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}`
  + `:${String(minutes % 60).padStart(2, '0')}`;

/** Часы работы студии по дням недели: строки salon_hours как есть. */
function salonHoursView(rows) {
  return rows.map((row) => ({
    weekday: row.weekday,
    weekday_short: WEEKDAY_SHORT[row.weekday],
    is_closed: row.is_closed === 1,
    start_min: row.is_closed === 1 ? null : row.start_min,
    end_min: row.is_closed === 1 ? null : row.end_min,
    display: row.is_closed === 1
      ? 'выходной'
      : `${hoursMinutes(row.start_min)}–${hoursMinutes(row.end_min)}`,
  }));
}

/**
 * Одна строка режима работы для витрины: «вт–сб 10:00–20:00».
 * Подряд идущие дни с одинаковыми часами сливаются в диапазон, выходные
 * пропускаются. Строку собирает сервер, чтобы каждый экран не пересчитывал
 * одно и то же, — так же, как `price_display` и `when_display`.
 */
function salonHoursDisplay(hours) {
  const open = hours.filter((day) => !day.is_closed);
  if (open.length === 0) return 'закрыто';
  if (open.length === 7 && open.every((day) => day.display === open[0].display)) {
    return `ежедневно ${open[0].display}`;
  }

  const groups = [];
  for (const day of open) {
    const last = groups[groups.length - 1];
    if (last && last.to.weekday === day.weekday - 1 && last.to.display === day.display) {
      last.to = day;
    } else {
      groups.push({ from: day, to: day });
    }
  }

  return groups
    .map((group) => (group.from === group.to
      ? `${group.from.weekday_short} ${group.from.display}`
      : `${group.from.weekday_short}–${group.to.weekday_short} ${group.from.display}`))
    .join(', ');
}

/**
 * Публичные настройки студии.
 * @param {object} row строка salon_settings
 * @param {object[]} hourRows строки salon_hours (семь, по дню недели)
 */
function settingsPublicView(row, hourRows = []) {
  const hours = salonHoursView(hourRows);
  return {
    name: row.name,
    phone: row.phone,
    address: row.address,
    // Часы работы студии: разбор по дням и готовая строка для витрины.
    // Разовые отмены и переносы (salon_day_overrides) сюда не входят —
    // это режим обычной недели.
    hours,
    hours_display: salonHoursDisplay(hours),
    timezone: row.timezone,
    slot_step_min: row.slot_step_min,
    cancel_window_hours: row.cancel_window_hours,
    booking_horizon_months: row.booking_horizon_months,
    max_reschedules: row.max_reschedules,
    hold_ttl_min: row.hold_ttl_min,
  };
}

module.exports = {
  STATUS_LABELS,
  SOURCE_LABELS,
  STAFF_SOURCES,
  rubles,
  selfUser,
  serviceView,
  serviceAdminView,
  masterView,
  masterAdminView,
  appointmentView,
  appointmentAdminView,
  appointmentEventView,
  appointmentMasterView,
  masterClientView,
  clientAdminView,
  settingsPublicView,
  initials,
};
