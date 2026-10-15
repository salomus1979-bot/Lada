'use strict';

// Наполнение базы демо-данными из прототипа (каталог услуг, мастера, графики).
// Запуск: npm run seed [-- --reset]
// Тестовые пароли живут только здесь и годятся лишь для локальной разработки.

const db = require('./lib/db');
const { hashPassword } = require('./lib/auth');
const { nowUtc } = require('./lib/time');

const TEST_PASSWORD = 'Lada12345';

const CATEGORIES = [
  { slug: 'manicure', title: 'Маникюр', description: 'Обработка, укрепление и покрытие — классика и дизайн.', sort_order: 1 },
  { slug: 'pedicure', title: 'Педикюр', description: 'Аппаратный и комбинированный уход за стопами.', sort_order: 2 },
  { slug: 'brows', title: 'Брови', description: 'Коррекция формы, окрашивание, долговременная укладка.', sort_order: 3 },
  { slug: 'lashes', title: 'Ресницы', description: 'Наращивание и ламинирование для выразительного взгляда.', sort_order: 4 },
];

// Цены — целые копейки: 1 800 ₽ = 180000.
const SERVICES = [
  { category: 'manicure', name: 'Маникюр с покрытием', description: 'Обработка, укрепление, гель-лак', duration_min: 90, buffer_after_min: 10, price_kopecks: 180000 },
  { category: 'manicure', name: 'Дизайн ногтей', description: 'Художественная роспись, 1–2 ногтя', duration_min: 30, buffer_after_min: 5, price_kopecks: 80000 },
  { category: 'manicure', name: 'Снятие покрытия', description: 'Аккуратное снятие предыдущего покрытия', duration_min: 20, buffer_after_min: 5, price_kopecks: 40000 },
  { category: 'pedicure', name: 'Аппаратный педикюр', description: 'Обработка стоп, удаление загрубевшей кожи', duration_min: 90, buffer_after_min: 15, price_kopecks: 240000 },
  { category: 'pedicure', name: 'Комбинированный педикюр', description: 'Классика и аппарат, с покрытием', duration_min: 100, buffer_after_min: 15, price_kopecks: 270000 },
  { category: 'pedicure', name: 'Экспресс-педикюр', description: 'Без покрытия, базовый уход', duration_min: 45, buffer_after_min: 10, price_kopecks: 150000 },
  { category: 'brows', name: 'Коррекция формы', description: 'Пинцет и нить, подбор формы', duration_min: 30, buffer_after_min: 5, price_kopecks: 80000 },
  { category: 'brows', name: 'Окрашивание бровей', description: 'Хна или краска, стойкий цвет', duration_min: 40, buffer_after_min: 5, price_kopecks: 90000 },
  { category: 'brows', name: 'Ламинирование бровей', description: 'Укладка волосков, эффект объёма', duration_min: 60, buffer_after_min: 5, price_kopecks: 120000 },
  { category: 'lashes', name: 'Классическое наращивание', description: 'Один объём, натуральный эффект', duration_min: 120, buffer_after_min: 15, price_kopecks: 220000 },
  { category: 'lashes', name: 'Объёмное наращивание 2D–3D', description: 'Плотный эффект, длительная носка', duration_min: 150, buffer_after_min: 15, price_kopecks: 280000 },
  { category: 'lashes', name: 'Ламинирование ресниц', description: 'Изгиб и укладка без наращивания', duration_min: 60, buffer_after_min: 10, price_kopecks: 160000 },
];

const MASTERS = [
  {
    first_name: 'Ольга', last_name: 'Белова', specialization: 'Маникюр, дизайн', experience_years: 6,
    bio: 'Работаю с 2020 года, специализируюсь на долговременных покрытиях и аккуратном дизайне.',
    sort_order: 1,
    services: ['Маникюр с покрытием', 'Дизайн ногтей', 'Снятие покрытия', 'Ламинирование бровей'],
  },
  {
    first_name: 'Дарья', last_name: 'Левина', specialization: 'Маникюр', experience_years: 3,
    bio: 'Аккуратный маникюр и стойкое покрытие.', sort_order: 2,
    services: ['Маникюр с покрытием', 'Снятие покрытия'],
  },
  {
    first_name: 'Ирина', last_name: 'Волкова', specialization: 'Педикюр', experience_years: 8,
    bio: 'Аппаратный педикюр, работа с проблемной кожей стоп.', sort_order: 3,
    services: ['Аппаратный педикюр', 'Комбинированный педикюр', 'Экспресс-педикюр'],
  },
  {
    first_name: 'Елена', last_name: 'Нечаева', specialization: 'Педикюр', experience_years: 4,
    bio: 'Базовый и экспресс-уход за стопами.', sort_order: 4,
    services: ['Аппаратный педикюр', 'Экспресс-педикюр'],
  },
  {
    first_name: 'Светлана', last_name: 'Руднева', specialization: 'Брови', experience_years: 5,
    bio: 'Подбор формы под черты лица, окрашивание и укладка.', sort_order: 5,
    services: ['Коррекция формы', 'Окрашивание бровей', 'Ламинирование бровей', 'Ламинирование ресниц'],
  },
  {
    first_name: 'Мария', last_name: 'Зайцева', specialization: 'Ресницы', experience_years: 7,
    bio: 'Наращивание от классики до объёма 3D.', sort_order: 6,
    services: ['Классическое наращивание', 'Объёмное наращивание 2D–3D', 'Ламинирование ресниц'],
  },
];

// График из прототипа: Пн/Вт 10–19, Ср/Чт 12–21, Пт 10–19, Сб 11–18, Вс — выходной.
// Перерыв 14:00–15:00 ежедневно, кроме выходных.
const WEEK = [
  { weekday: 1, start_min: 600, end_min: 1140 },
  { weekday: 2, start_min: 600, end_min: 1140 },
  { weekday: 3, start_min: 720, end_min: 1260 },
  { weekday: 4, start_min: 720, end_min: 1260 },
  { weekday: 5, start_min: 600, end_min: 1140 },
  { weekday: 6, start_min: 660, end_min: 1080 },
  { weekday: 7, is_day_off: true },
];

function reset() {
  const tables = [
    'appointment_services', 'appointments', 'slot_holds', 'time_blocks',
    'master_schedule_exceptions', 'master_work_schedule', 'master_services',
    'masters', 'services', 'service_categories', 'sessions', 'users',
    'salon_day_overrides', 'salon_hours', 'salon_settings',
  ];
  for (const table of tables) db.run(`DELETE FROM ${table}`);
}

function seed() {
  const timestamp = nowUtc();

  db.run(
    `INSERT INTO salon_settings
       (id, name, phone, address, timezone, slot_step_min, cancel_window_hours,
        booking_horizon_months, max_active_appointments, max_reschedules,
        no_show_block_threshold, hold_ttl_min)
     VALUES (1, 'Лада', '+79991234567', 'м. Фрунзенская, ул. Студийная, 12',
             'Europe/Moscow', 30, 4, 3, 3, 2, 3, 7)`,
  );

  // Студия работает ежедневно 10:00–21:00.
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    db.run(
      'INSERT INTO salon_hours (weekday, is_closed, start_min, end_min) VALUES (?, 0, 600, 1260)',
      [weekday],
    );
  }
  db.run(
    `INSERT INTO salon_day_overrides (date, is_closed, start_min, end_min, note)
     VALUES ('2027-01-01', 1, NULL, NULL, 'Новый год — студия закрыта')`,
  );

  const categoryIds = new Map();
  for (const category of CATEGORIES) {
    const info = db.run(
      `INSERT INTO service_categories (slug, title, description, sort_order)
       VALUES (?, ?, ?, ?)`,
      [category.slug, category.title, category.description, category.sort_order],
    );
    categoryIds.set(category.slug, Number(info.lastInsertRowid));
  }

  const serviceIds = new Map();
  for (const service of SERVICES) {
    const info = db.run(
      `INSERT INTO services
         (category_id, name, description, duration_min, buffer_after_min,
          price_kopecks, is_visible, is_active, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      [categoryIds.get(service.category), service.name, service.description,
        service.duration_min, service.buffer_after_min, service.price_kopecks, timestamp],
    );
    serviceIds.set(service.name, Number(info.lastInsertRowid));
  }

  const users = [
    { role: 'owner', name: 'Лада Крылова', email: 'owner@lada.local', phone: '+79991234500' },
    { role: 'admin', name: 'Елена Крылова', email: 'admin@lada.local', phone: '+79991234501' },
    { role: 'client', name: 'Анна Соколова', email: 'client@lada.local', phone: '+79991112233' },
  ];
  for (const user of users) {
    db.run(
      `INSERT INTO users (role, name, email, phone, password_hash, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.role, user.name, user.email, user.phone, hashPassword(TEST_PASSWORD), timestamp],
    );
  }

  for (const master of MASTERS) {
    const info = db.run(
      `INSERT INTO masters
         (first_name, last_name, specialization, experience_years, bio,
          is_visible, is_active, sort_order, created_at_utc)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [master.first_name, master.last_name, master.specialization,
        master.experience_years, master.bio, master.sort_order, timestamp],
    );
    const masterId = Number(info.lastInsertRowid);

    for (const serviceName of master.services) {
      db.run('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)',
        [masterId, serviceIds.get(serviceName)]);
    }

    for (const day of WEEK) {
      db.run(
        `INSERT INTO master_work_schedule
           (master_id, weekday, is_day_off, start_min, end_min, break_start_min, break_end_min)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [masterId, day.weekday, day.is_day_off ? 1 : 0,
          day.is_day_off ? null : day.start_min,
          day.is_day_off ? null : day.end_min,
          day.is_day_off ? null : 840,
          day.is_day_off ? null : 900],
      );
    }
  }

  console.log('[seed] готово:');
  console.log(`  категорий: ${CATEGORIES.length}, услуг: ${SERVICES.length}, мастеров: ${MASTERS.length}`);
  console.log(`  владелец: owner@lada.local, админ: admin@lada.local, клиент: client@lada.local`);
  console.log(`  тестовый пароль для всех: ${TEST_PASSWORD}`);
}

function main() {
  db.open();
  const already = db.one('SELECT id FROM salon_settings WHERE id = 1');
  const wantsReset = process.argv.includes('--reset');

  if (already && !wantsReset) {
    console.log('[seed] база уже заполнена. Перезалить: npm run seed -- --reset');
    return;
  }

  db.transaction(() => {
    if (wantsReset) reset();
    seed();
  });
}

main();
