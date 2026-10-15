'use strict';

// Наполнение базы демо-данными из прототипа (каталог услуг, мастера, графики).
// Запуск: npm run seed [-- --reset]
// Тестовые пароли живут только здесь и годятся лишь для локальной разработки.

const db = require('./lib/db');
const { hashPassword } = require('./lib/auth');
const { nowUtc } = require('./lib/time');

const TEST_PASSWORD = 'Lada12345';

const CATEGORIES = [
  { slug: 'nails', title: 'Ногти', description: 'Маникюр, педикюр, наращивание и дизайн.', sort_order: 1 },
  { slug: 'brows', title: 'Брови', description: 'Коррекция, окрашивание и долговременная укладка.', sort_order: 2 },
];

// Цены — целые копейки: 1 800 ₽ = 180000.
// buffer_after_min — время на уборку рабочего места, клиенту не показывается,
// но занимает время мастера.
const SERVICES = [
  { category: 'nails', name: 'Маникюр с покрытием гель-лаком', description: 'Обработка, укрепление, покрытие гель-лаком', duration_min: 90, buffer_after_min: 10, price_kopecks: 180000 },
  { category: 'nails', name: 'Маникюр и педикюр', description: 'Комплекс: руки и стопы с покрытием', duration_min: 150, buffer_after_min: 10, price_kopecks: 320000 },
  { category: 'nails', name: 'Наращивание ногтей', description: 'Наращивание с последующим покрытием', duration_min: 150, buffer_after_min: 10, price_kopecks: 280000 },
  // Заявлено «+15–30 минут». В duration_min берём верхнюю границу: если
  // резервировать 15, визит рискует наехать на следующего клиента.
  { category: 'nails', name: 'Дизайн ногтей', description: 'Художественная роспись, цена за два ногтя', duration_min: 30, buffer_after_min: 0, price_kopecks: 30000 },
  { category: 'brows', name: 'Коррекция и окрашивание бровей', description: 'Подбор формы, коррекция и стойкое окрашивание', duration_min: 40, buffer_after_min: 5, price_kopecks: 120000 },
  { category: 'brows', name: 'Ламинирование бровей', description: 'Укладка волосков, эффект объёма', duration_min: 60, buffer_after_min: 5, price_kopecks: 180000 },
];

// Каждый мастер работает в свои дни; остальные дни недели — выходные.
// Время — минуты от полуночи в поясе салона. Все графики лежат внутри
// режима студии (вт–сб, 10:00–20:00).
const MASTERS = [
  {
    first_name: 'Анна', last_name: 'Ковалева',
    specialization: 'Маникюр и педикюр', experience_years: 6,
    bio: 'Маникюр, педикюр, наращивание и дизайн ногтей.',
    sort_order: 1,
    services: [
      'Маникюр с покрытием гель-лаком', 'Маникюр и педикюр',
      'Наращивание ногтей', 'Дизайн ногтей',
    ],
    // Вторник–пятница, 10:00–18:00.
    schedule: { weekdays: [2, 3, 4, 5], start_min: 600, end_min: 1080 },
  },
  {
    first_name: 'Марина', last_name: 'Орлова',
    specialization: 'Брови', experience_years: 5,
    bio: 'Коррекция и окрашивание бровей, долговременная укладка.',
    sort_order: 2,
    services: ['Коррекция и окрашивание бровей', 'Ламинирование бровей'],
    // Среда–суббота, 11:00–20:00.
    schedule: { weekdays: [3, 4, 5, 6], start_min: 660, end_min: 1200 },
  },
  {
    first_name: 'Елена', last_name: 'Смирнова',
    specialization: 'Универсальный мастер', experience_years: 8,
    bio: 'Маникюр и наращивание ногтей, коррекция, окрашивание и ламинирование бровей.',
    sort_order: 3,
    services: [
      'Маникюр с покрытием гель-лаком', 'Наращивание ногтей',
      'Коррекция и окрашивание бровей', 'Ламинирование бровей',
    ],
    // Вторник, четверг, суббота, 10:00–19:00.
    schedule: { weekdays: [2, 4, 6], start_min: 600, end_min: 1140 },
  },
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

  // Студия работает со вторника по субботу, 10:00–20:00.
  // Воскресенье и понедельник закрыты.
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const isClosed = weekday === 1 || weekday === 7;
    db.run(
      `INSERT INTO salon_hours (weekday, is_closed, start_min, end_min)
       VALUES (?, ?, ?, ?)`,
      [weekday, isClosed ? 1 : 0, isClosed ? null : 600, isClosed ? null : 1200],
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

    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const works = master.schedule.weekdays.includes(weekday);
      db.run(
        `INSERT INTO master_work_schedule
           (master_id, weekday, is_day_off, start_min, end_min, break_start_min, break_end_min)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        [masterId, weekday, works ? 0 : 1,
          works ? master.schedule.start_min : null,
          works ? master.schedule.end_min : null],
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
