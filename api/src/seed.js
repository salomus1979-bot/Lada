'use strict';

// Наполнение базы демо-данными из прототипа (каталог услуг, мастера, графики).
// Запуск: npm run seed [-- --reset]
// Тестовые пароли живут только здесь и годятся лишь для локальной разработки.

const db = require('./lib/db');
const { hashPassword, grantRole } = require('./lib/auth');
const {
  nowUtc, toUtcIso, zonedToUtc, utcToZoned, weekdayOfDate, addDays, addMonths,
} = require('./lib/time');

// Пароль демо-аккаунтов не зашит в код: он приходит из окружения,
// см. .env.example. Вне продакшена есть умолчание для разработки.
const TEST_PASSWORD = require('./lib/config').seedPassword();

// Часы работы студии: вт–сб, 10:00–20:00.
const SALON_START_MIN = 600;
const SALON_END_MIN = 1200;
const SALON_CLOSED_WEEKDAYS = [1, 7];

// Постоянные блокировки времени — фикстуры для проверки расчёта слотов.
// Повторяются каждую неделю, а time_blocks хранит конкретные моменты,
// поэтому строки генерируются на весь горизонт записи (см. seedTimeBlocks).
const TIME_BLOCKS = [
  { master: 'Анна', weekday: 4, start_min: 780, end_min: 840, type: 'break', comment: 'Обед' },
  { master: 'Марина', weekday: 5, start_min: 900, end_min: 1020, type: 'time_off', comment: 'Личное время' },
  { master: 'Елена', weekday: 6, all_day: true, type: 'time_off', comment: 'Выходной' },
];

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
    // Доступ в кабинет мастера выдан: masters.user_id ссылается на этот аккаунт.
    account: { email: 'anna@lada.local', phone: '+79991234510' },
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
    // Две роли сразу — случай, ради которого роли и хранятся списком:
    // мастер, который заодно администрирует студию.
    account: { email: 'marina.master@lada.local', phone: '+79991234511', roles: ['master', 'admin'] },
    specialization: 'Брови', experience_years: 5,
    bio: 'Коррекция и окрашивание бровей, долговременная укладка.',
    sort_order: 2,
    services: ['Коррекция и окрашивание бровей', 'Ламинирование бровей'],
    // Среда–суббота, 11:00–20:00.
    schedule: { weekdays: [3, 4, 5, 6], start_min: 660, end_min: 1200 },
  },
  {
    first_name: 'Елена', last_name: 'Смирнова',
    // Доступ намеренно не выдан — состояние «Доступ не выдан» со страницы 28.
    account: null,
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
    'masters', 'services', 'service_categories', 'sessions', 'user_roles', 'users',
    'salon_day_overrides', 'salon_hours', 'salon_settings',
  ];
  for (const table of tables) db.run(`DELETE FROM ${table}`);
}

/**
 * Раскладывает недельные блокировки TIME_BLOCKS в конкретные строки time_blocks
 * на весь горизонт записи. Границы переводятся в UTC отдельно для каждой даты,
 * поэтому переход на летнее время не сдвигает блокировку.
 */
function seedTimeBlocks(masterIds, adminUserId, timestamp) {
  const settings = db.settings();
  const today = utcToZoned(new Date(), settings.timezone).date;
  const until = addMonths(today, settings.booking_horizon_months);

  let count = 0;
  for (const block of TIME_BLOCKS) {
    const masterId = masterIds.get(block.master);
    if (!masterId) throw new Error(`Блокировка ссылается на неизвестного мастера: ${block.master}`);

    const startMin = block.all_day ? SALON_START_MIN : block.start_min;
    const endMin = block.all_day ? SALON_END_MIN : block.end_min;

    for (let date = today; date <= until; date = addDays(date, 1)) {
      if (weekdayOfDate(date) !== block.weekday) continue;
      db.run(
        `INSERT INTO time_blocks
           (master_id, type, starts_at_utc, ends_at_utc, comment, created_by_user_id, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [masterId, block.type,
          toUtcIso(zonedToUtc(date, startMin, settings.timezone)),
          toUtcIso(zonedToUtc(date, endMin, settings.timezone)),
          block.comment, adminUserId, timestamp],
      );
      count += 1;
    }
  }
  return count;
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
    const isClosed = SALON_CLOSED_WEEKDAYS.includes(weekday);
    db.run(
      `INSERT INTO salon_hours (weekday, is_closed, start_min, end_min)
       VALUES (?, ?, ?, ?)`,
      [weekday, isClosed ? 1 : 0,
        isClosed ? null : SALON_START_MIN, isClosed ? null : SALON_END_MIN],
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
    { roles: ['owner'], name: 'Лада Крылова', email: 'owner@lada.local', phone: '+79991234500' },
    { roles: ['admin'], name: 'Елена Крылова', email: 'admin@lada.local', phone: '+79991234501' },
    { roles: ['client'], name: 'Анна Соколова', email: 'client@lada.local', phone: '+79991112233' },
  ];
  let adminUserId = null;
  for (const user of users) {
    const info = db.run(
      `INSERT INTO users (name, email, phone, password_hash, created_at_utc)
       VALUES (?, ?, ?, ?, ?)`,
      [user.name, user.email, user.phone, hashPassword(TEST_PASSWORD), timestamp],
    );
    const newUserId = Number(info.lastInsertRowid);
    // Роли списком: у Елены их две — она и администратор, и клиент студии.
    for (const role of user.roles) grantRole(newUserId, role);
    if (user.roles.includes('admin')) adminUserId = newUserId;
  }

  const masterIds = new Map();
  for (const master of MASTERS) {
    // Аккаунт мастера. В прототипе доступ выдаёт администратор ссылкой-
    // приглашением на 7 дней (страница 35), но почты в проекте нет, поэтому
    // здесь аккаунт заводится сразу с тем же тестовым паролем, что у остальных
    // ролей. У Елены доступа нет вовсе — это состояние «Доступ не выдан»
    // со страницы 28, в админском представлении access.granted = false.
    let masterUserId = null;
    if (master.account) {
      const accountInfo = db.run(
        `INSERT INTO users (name, email, phone, password_hash, created_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
        [`${master.first_name} ${master.last_name}`, master.account.email,
          master.account.phone, hashPassword(TEST_PASSWORD), timestamp],
      );
      masterUserId = Number(accountInfo.lastInsertRowid);
      for (const role of master.account.roles || ['master']) grantRole(masterUserId, role);
    }

    const info = db.run(
      `INSERT INTO masters
         (user_id, first_name, last_name, specialization, experience_years, bio,
          is_visible, is_active, sort_order, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [masterUserId, master.first_name, master.last_name, master.specialization,
        master.experience_years, master.bio, master.sort_order, timestamp],
    );
    const masterId = Number(info.lastInsertRowid);
    masterIds.set(master.first_name, masterId);

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

  const blockCount = seedTimeBlocks(masterIds, adminUserId, timestamp);

  console.log('[seed] готово:');
  console.log(`  категорий: ${CATEGORIES.length}, услуг: ${SERVICES.length}, мастеров: ${MASTERS.length}`);
  console.log(`  блокировок времени: ${blockCount} (${TIME_BLOCKS.length} недельных правила на горизонт записи)`);
  console.log(`  владелец: owner@lada.local, админ: admin@lada.local, клиент: client@lada.local`);
  const withAccess = MASTERS.filter((m) => m.account).map((m) => m.account.email);
  console.log(`  мастера с доступом: ${withAccess.join(', ')}`);
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
