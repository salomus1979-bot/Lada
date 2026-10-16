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

const rubles = (kopecks) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

/** Собственный профиль. Без password_hash — он не покидает БД. */
function selfUser(user) {
  return {
    id: user.id,
    role: user.role,
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

/** Запись для админа: добавляются данные клиента — у персонала есть на них право. */
function appointmentAdminView(row, services, { timezone } = {}) {
  const base = appointmentView(row, services, { timezone });
  return {
    ...base,
    // Признак осознанного наложения виден только персоналу: клиенту
    // не нужно знать, что его визит поставили поверх другого.
    is_override: row.is_override === 1,
    client: {
      id: row.client_user_id,
      name: row.client_name,
      phone: row.client_phone,
      email: row.client_email,
    },
  };
}

function settingsPublicView(row) {
  return {
    name: row.name,
    phone: row.phone,
    address: row.address,
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
  rubles,
  selfUser,
  serviceView,
  serviceAdminView,
  masterView,
  masterAdminView,
  appointmentView,
  appointmentAdminView,
  settingsPublicView,
};
