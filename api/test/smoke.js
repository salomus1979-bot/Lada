'use strict';

// Сквозная проверка API на отдельной временной базе.
// Запуск: npm run smoke

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lada-smoke-')), 'test.sqlite');
process.env.LADA_DB_PATH = DB_PATH;

// Заполняем временную базу тем же сидом, что и рабочую.
execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'seed.js')], {
  env: { ...process.env, LADA_DB_PATH: DB_PATH },
  stdio: 'pipe',
});

const { createApp } = require('../src/app');
const db = require('../src/lib/db');

let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

async function main() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — поймает проверка */ }
    return { status: res.status, json, isJson: json !== null, contentType: res.headers.get('content-type') };
  };

  console.log('\n— Служебное —');
  const health = await call('GET', '/api/health');
  check('GET /api/health -> 200 JSON', health.status === 200 && health.json.ok === true);
  const missing = await call('GET', '/api/nope');
  check('неизвестный путь -> 404 JSON', missing.status === 404 && missing.isJson, missing.json);

  console.log('\n— Каталог —');
  const services = await call('GET', '/api/services');
  check('GET /api/services -> 200, 6 услуг',
    services.status === 200 && services.json.services.length === 6);
  check('цена целым числом копеек',
    services.json.services.every((s) => Number.isInteger(s.price_kopecks)));
  check('в каталоге нет служебного буфера',
    services.json.services.every((s) => s.buffer_after_min === undefined));

  const manicure = services.json.services.find((s) => s.name === 'Маникюр с покрытием гель-лаком');
  const brows = services.json.services.find((s) => s.name === 'Ламинирование бровей');
  // Услуга, которую выбранный ниже мастер не выполняет — для проверки 409.
  const foreignService = services.json.services.find((s) => s.name === 'Дизайн ногтей');

  const mastersAll = await call('GET', '/api/masters');
  check('GET /api/masters -> 200, 3 мастера',
    mastersAll.status === 200 && mastersAll.json.masters.length === 3);
  check('в списке мастеров нет контактов',
    mastersAll.json.masters.every((m) => m.email === undefined && m.phone === undefined));

  const bothServices = `${manicure.id},${brows.id}`;
  const mastersBoth = await call('GET', `/api/masters?service_ids=${bothServices}`);
  check('фильтр по двум услугам оставляет только тех, кто делает обе',
    mastersBoth.status === 200 && mastersBoth.json.masters.length === 1
      && mastersBoth.json.masters[0].display_name === 'Елена Смирнова',
    mastersBoth.json.masters.map((m) => m.display_name));

  const badFilter = await call('GET', '/api/masters?service_ids=abc');
  check('неверный service_ids -> 400', badFilter.status === 400, badFilter.json);

  const master = mastersBoth.json.masters[0];

  console.log('\n— Регистрация и вход —');
  const weakPassword = await call('POST', '/api/auth/register', {
    body: { name: 'Тест', email: 'weak@example.com', phone: '+79990000001', password: 'abcdefgh', password_confirm: 'abcdefgh', consent: true },
  });
  check('пароль без цифр -> 400', weakPassword.status === 400
    && weakPassword.json.error.details.password, weakPassword.json);

  const mismatch = await call('POST', '/api/auth/register', {
    body: { name: 'Тест', email: 'mm@example.com', phone: '+79990000001', password: 'Lada12345', password_confirm: 'Lada99999', consent: true },
  });
  check('пароли не совпадают -> 400', mismatch.status === 400, mismatch.json);

  const noConsent = await call('POST', '/api/auth/register', {
    body: { name: 'Тест', email: 'nc@example.com', phone: '+79990000001', password: 'Lada12345', password_confirm: 'Lada12345', consent: false },
  });
  check('без согласия на обработку -> 400', noConsent.status === 400, noConsent.json);

  const badPhone = await call('POST', '/api/auth/register', {
    body: { name: 'Тест', email: 'bp@example.com', phone: '12345', password: 'Lada12345', password_confirm: 'Lada12345', consent: true },
  });
  check('неверный телефон -> 400', badPhone.status === 400, badPhone.json);

  const register = await call('POST', '/api/auth/register', {
    body: { name: 'Марина Тестова', email: 'Marina@Example.com', phone: '8 (999) 000-11-22', password: 'Lada12345', password_confirm: 'Lada12345', consent: true },
  });
  check('регистрация -> 201', register.status === 201, register.json);
  check('e-mail приведён к нижнему регистру', register.json.user.email === 'marina@example.com');
  check('телефон нормализован', register.json.user.phone === '+79990001122');
  check('хеш пароля не возвращается',
    !JSON.stringify(register.json).toLowerCase().includes('scrypt'));
  const marinaToken = register.json.session_token;

  const duplicate = await call('POST', '/api/auth/register', {
    body: { name: 'Другая', email: 'marina@example.com', phone: '+79990001133', password: 'Lada12345', password_confirm: 'Lada12345', consent: true },
  });
  check('повторный e-mail -> 409', duplicate.status === 409, duplicate.json);

  const wrongPassword = await call('POST', '/api/auth/login',
    { body: { email: 'marina@example.com', password: 'WrongPass1' } });
  check('неверный пароль -> 401', wrongPassword.status === 401, wrongPassword.json);

  const unknownEmail = await call('POST', '/api/auth/login',
    { body: { email: 'nobody@example.com', password: 'Lada12345' } });
  check('неизвестный e-mail -> 401 с тем же текстом',
    unknownEmail.status === 401
    && unknownEmail.json.error.message === wrongPassword.json.error.message);

  const login = await call('POST', '/api/auth/login',
    { body: { email: 'client@lada.local', password: 'Lada12345' } });
  check('вход клиента -> 200', login.status === 200, login.json);
  const clientToken = login.json.session_token;

  const adminLogin = await call('POST', '/api/auth/login',
    { body: { email: 'admin@lada.local', password: 'Lada12345' } });
  const adminToken = adminLogin.json.session_token;
  const ownerLogin = await call('POST', '/api/auth/login',
    { body: { email: 'owner@lada.local', password: 'Lada12345' } });
  const ownerToken = ownerLogin.json.session_token;
  check('вход админа и владельца -> 200',
    adminLogin.status === 200 && ownerLogin.status === 200);

  const anon = await call('GET', '/api/appointments');
  check('свои записи без авторизации -> 401', anon.status === 401, anon.json);

  console.log('\n— Свободное время —');
  const settings = (await call('GET', '/api/settings')).json.settings;
  check('настройки студии отдаются', settings.timezone === 'Europe/Moscow'
    && settings.slot_step_min === 30 && settings.cancel_window_hours === 4);

  const badDate = await call('GET', `/api/masters/${master.id}/availability?date=2026-13-45&service_ids=${bothServices}`);
  check('неверная дата -> 400', badDate.status === 400, badDate.json);

  const noServices = await call('GET', `/api/masters/${master.id}/availability?date=2026-10-23`);
  check('без service_ids -> 400', noServices.status === 400, noServices.json);

  const wrongMaster = await call('GET', `/api/masters/${master.id}/availability?date=2026-10-23&service_ids=${foreignService.id}`);
  check('мастер не делает услугу -> 409', wrongMaster.status === 409, wrongMaster.json);

  // Ищем ближайшую дату, где есть окно нужной длины.
  let day = null;
  for (let offset = 1; offset <= 14 && !day; offset += 1) {
    const date = new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
    const res = await call('GET',
      `/api/masters/${master.id}/availability?date=${date}&service_ids=${bothServices}`);
    if (res.status === 200 && res.json.slots.length > 0) day = { date, ...res.json };
  }
  check('нашлось свободное время на ближайшие две недели', day !== null);
  check('суммарная длительность = 90 + 60',
    day.service_duration_min === 150, day && day.service_duration_min);
  check('сумма = 180000 + 180000 копеек', day.total_price_kopecks === 360000);
  check('слоты отданы в UTC с локальным временем салона',
    day.slots.every((s) => s.at_utc.endsWith('Z') && s.local_time && s.timezone === 'Europe/Moscow'));
  check('шаг сетки 30 минут соблюдён',
    day.slots.every((s) => [0, 30].includes(Number(s.local_time.slice(3)))), day.slots[0]);

  const slot = day.slots[0];
  const slotCount = day.slots.length;

  console.log('');
  console.log('— Постоянные блокировки из сида —');
  // Ближайшая дата нужного дня недели (ISO: 1 = Пн).
  const nextWeekday = (iso) => {
    for (let i = 1; i <= 14; i += 1) {
      const d = new Date(Date.now() + i * 86400000);
      const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      if (weekday === iso) return d.toISOString().slice(0, 10);
    }
    return null;
  };
  const localTimes = (res) => res.json.slots.map((x) => x.local_time);

  const anna = mastersAll.json.masters.find((m) => m.display_name === 'Анна Ковалева');
  const marina = mastersAll.json.masters.find((m) => m.display_name === 'Марина Орлова');
  const elena = mastersAll.json.masters.find((m) => m.display_name === 'Елена Смирнова');
  const lamination = services.json.services.find((s) => s.name === 'Ламинирование бровей');
  check('все три мастера на месте', !!anna && !!marina && !!elena);

  // Анна: четверг 13:00–14:00 — обед. Маникюр занимает 100 мин с буфером,
  // поэтому исчезают все начала с 11:30 по 13:30.
  const annaThu = await call('GET',
    `/api/masters/${anna.id}/availability?date=${nextWeekday(4)}&service_ids=${manicure.id}`);
  const annaSlots = localTimes(annaThu);
  check('Анна, чт: обед 13:00–14:00 вырезан из сетки',
    annaThu.status === 200
    && !annaSlots.some((t) => t >= '11:30' && t < '14:00')
    && annaSlots.includes('11:00') && annaSlots.includes('14:00'), annaSlots);

  // Марина: пятница 15:00–17:00 — личное время. Ламинирование занимает 65 мин.
  const marinaFri = await call('GET',
    `/api/masters/${marina.id}/availability?date=${nextWeekday(5)}&service_ids=${lamination.id}`);
  const marinaSlots = localTimes(marinaFri);
  check('Марина, пт: личное время 15:00–17:00 вырезано из сетки',
    marinaFri.status === 200
    && !marinaSlots.some((t) => t >= '14:00' && t < '17:00')
    && marinaSlots.includes('13:30') && marinaSlots.includes('17:00'), marinaSlots);

  // Елена: суббота заблокирована целиком, хотя по графику она работает.
  const elenaSat = await call('GET',
    `/api/masters/${elena.id}/availability?date=${nextWeekday(6)}&service_ids=${manicure.id}`);
  check('Елена, сб: день закрыт блокировкой, хотя по графику рабочий',
    elenaSat.status === 200 && elenaSat.json.slots.length === 0, elenaSat.json.slots);

  // Блокировка действует только на свой день недели и своего мастера.
  const annaFri = await call('GET',
    `/api/masters/${anna.id}/availability?date=${nextWeekday(5)}&service_ids=${manicure.id}`);
  check('у Анны в пятницу обеда нет — блокировка только на четверг',
    annaFri.json.slots.length > 0
    && localTimes(annaFri).some((t) => t >= '11:30' && t < '14:00'), localTimes(annaFri));

  console.log('\n— Удержание слота —');
  const anonHold = await call('POST', '/api/holds',
    { body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc } });
  check('удержание без авторизации -> 401', anonHold.status === 401);

  const localTimeHold = await call('POST', '/api/holds', {
    token: clientToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: '2026-10-23T14:00:00' },
  });
  check('время без Z -> 400', localTimeHold.status === 400, localTimeHold.json);

  const hold = await call('POST', '/api/holds', {
    token: clientToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc },
  });
  check('удержание -> 201 с токеном и сроком', hold.status === 201
    && hold.json.hold.token.length === 64 && hold.json.expires_in_sec === 420, hold.json);

  const otherHold = await call('POST', '/api/holds', {
    token: marinaToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc },
  });
  check('чужое удержание того же слота -> 409', otherHold.status === 409, otherHold.json);

  const heldView = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`,
    { token: marinaToken });
  check('удержанный слот исчез из списка для другого клиента',
    !heldView.json.slots.some((s) => s.at_utc === slot.at_utc));

  const ownView = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`,
    { token: clientToken });
  check('своё удержание не мешает его владельцу',
    ownView.json.slots.some((s) => s.at_utc === slot.at_utc));

  // Истечение: двигаем срок в прошлое и проверяем, что слот освободился сам.
  db.run('UPDATE slot_holds SET expires_at_utc = ? WHERE token = ?',
    ['2000-01-01T00:00:00Z', hold.json.hold.token]);
  const afterExpiry = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`,
    { token: marinaToken });
  check('истёкшее удержание освобождает слот',
    afterExpiry.json.slots.some((s) => s.at_utc === slot.at_utc));
  check('истёкшее удержание удалено из базы',
    db.one('SELECT COUNT(*) AS n FROM slot_holds WHERE token = ?',
      [hold.json.hold.token]).n === 0);

  const hold2 = await call('POST', '/api/holds', {
    token: clientToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc },
  });
  check('повторное удержание после истечения -> 201', hold2.status === 201, hold2.json);

  console.log('\n— Создание записи —');
  const noConsentBooking = await call('POST', '/api/appointments', {
    token: clientToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc, consent: false },
  });
  check('запись без согласия -> 400', noConsentBooking.status === 400);

  const offGrid = await call('POST', '/api/appointments', {
    token: clientToken,
    body: {
      master_id: master.id,
      service_ids: [manicure.id, brows.id],
      starts_at: new Date(new Date(slot.at_utc).getTime() + 7 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      consent: true,
    },
  });
  check('начало мимо сетки слотов -> 409', offGrid.status === 409, offGrid.json);

  const past = await call('POST', '/api/appointments', {
    token: clientToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: '2020-01-06T09:00:00Z', consent: true },
  });
  check('время в прошлом -> 409', past.status === 409, past.json);

  const created = await call('POST', '/api/appointments', {
    token: clientToken,
    body: {
      master_id: master.id,
      service_ids: [manicure.id, brows.id],
      starts_at: slot.at_utc,
      client_comment: 'Буду на 5 минут раньше',
      hold_token: hold2.json.hold.token,
      consent: true,
    },
  });
  check('создание записи -> 201', created.status === 201, created.json);
  const appointmentId = created.json.appointment.id;
  check('статус новой записи — pending', created.json.appointment.status === 'pending');
  check('сумма записи в копейках', created.json.appointment.total_price_kopecks === 360000);
  check('в записи зафиксированы 2 услуги', created.json.appointment.services.length === 2);
  check('запись не содержит данных других клиентов',
    created.json.appointment.client === undefined);
  check('удержание снято после создания записи',
    db.one('SELECT COUNT(*) AS n FROM slot_holds').n === 0);

  const taken = await call('POST', '/api/appointments', {
    token: marinaToken,
    body: { master_id: master.id, service_ids: [manicure.id, brows.id], starts_at: slot.at_utc, consent: true },
  });
  check('занятое время -> 409', taken.status === 409, taken.json);

  const afterBooking = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`);
  check('занятый слот и пересекающиеся с ним ушли из списка',
    !afterBooking.json.slots.some((s) => s.at_utc === slot.at_utc)
    && afterBooking.json.slots.length < slotCount);

  console.log('\n— Свои записи —');
  const mine = await call('GET', '/api/appointments', { token: clientToken });
  check('GET /api/appointments -> 200, запись на месте',
    mine.status === 200 && mine.json.appointments.some((a) => a.id === appointmentId));
  check('подсказки по правилам отданы',
    mine.json.appointments[0].can_cancel !== undefined
    && mine.json.appointments[0].reschedules_left === 2);

  const minePast = await call('GET', '/api/appointments?scope=past', { token: clientToken });
  check('scope=past не содержит будущую запись',
    minePast.status === 200 && !minePast.json.appointments.some((a) => a.id === appointmentId));

  const badScope = await call('GET', '/api/appointments?scope=wrong', { token: clientToken });
  check('неверный scope -> 400', badScope.status === 400);

  const details = await call('GET', `/api/appointments/${appointmentId}`, { token: clientToken });
  check('детали своей записи -> 200', details.status === 200);
  check('время отдано в UTC и в поясе салона',
    details.json.appointment.starts_at.at_utc === slot.at_utc
    && details.json.appointment.starts_at.timezone === 'Europe/Moscow');

  const foreign = await call('GET', `/api/appointments/${appointmentId}`, { token: marinaToken });
  check('чужая запись -> 404 (не 403, чтобы не раскрывать её существование)',
    foreign.status === 404, foreign.json);

  const badId = await call('GET', '/api/appointments/abc', { token: clientToken });
  check('нечисловой id -> 400', badId.status === 400);

  console.log('\n— Перенос —');
  const nextSlot = afterBooking.json.slots[afterBooking.json.slots.length - 1];
  const reschedule = await call('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: clientToken,
    body: { starts_at: nextSlot.at_utc },
  });
  check('перенос -> 200', reschedule.status === 200, reschedule.json);
  check('счётчик переносов увеличился', reschedule.json.appointment.reschedule_count === 1);
  check('осталось переносов: 1', reschedule.json.appointment.reschedules_left === 1);

  const sameTime = await call('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: clientToken, body: { starts_at: nextSlot.at_utc },
  });
  check('перенос на то же время -> 400', sameTime.status === 400, sameTime.json);

  const foreignReschedule = await call('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: marinaToken, body: { starts_at: slot.at_utc },
  });
  check('перенос чужой записи -> 404', foreignReschedule.status === 404);

  // Лимит переносов: второй перенос доступен, третий — уже нет.
  const freeAgain = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`,
    { token: clientToken });
  const second = freeAgain.json.slots.find((s) => s.at_utc !== nextSlot.at_utc);
  const reschedule2 = await call('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: clientToken, body: { starts_at: second.at_utc },
  });
  check('второй перенос -> 200', reschedule2.status === 200, reschedule2.json);
  check('переносов больше не осталось',
    reschedule2.json.appointment.reschedules_left === 0
    && reschedule2.json.appointment.can_reschedule === false);

  const third = freeAgain.json.slots.find(
    (s) => s.at_utc !== nextSlot.at_utc && s.at_utc !== second.at_utc,
  );
  const reschedule3 = await call('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: clientToken, body: { starts_at: third.at_utc },
  });
  check('третий перенос -> 409 (лимит 2)', reschedule3.status === 409, reschedule3.json);

  console.log('\n— Админские эндпоинты —');
  const clientToAdmin = await call('GET', '/api/admin/appointments', { token: clientToken });
  check('клиент в админку -> 403', clientToAdmin.status === 403, clientToAdmin.json);

  const anonToAdmin = await call('GET', '/api/admin/appointments');
  check('админка без авторизации -> 401', anonToAdmin.status === 401);

  const allAppointments = await call('GET', '/api/admin/appointments', { token: adminToken });
  check('админ видит все записи -> 200',
    allAppointments.status === 200 && allAppointments.json.total >= 1);
  check('админу видны контакты клиента',
    allAppointments.json.appointments[0].client.phone === '+79991112233');
  check('но не хеш пароля',
    !JSON.stringify(allAppointments.json).toLowerCase().includes('password'));

  const filtered = await call('GET',
    `/api/admin/appointments?master_id=${master.id}&scope=active&date_from=${day.date}&date_to=${day.date}`,
    { token: adminToken });
  check('фильтры админского списка работают',
    filtered.status === 200 && filtered.json.appointments.length === 1, filtered.json.total);

  const badRange = await call('GET',
    '/api/admin/appointments?date_from=2026-10-20&date_to=2026-10-10', { token: adminToken });
  check('date_to раньше date_from -> 400', badRange.status === 400);

  const newService = await call('POST', '/api/admin/services', {
    token: ownerToken,
    body: {
      category_id: manicure.category.id, name: 'Парафинотерапия рук',
      description: 'Уход за кожей рук', duration_min: 30, buffer_after_min: 5,
      price_kopecks: 70000, is_visible: true,
    },
  });
  check('владелец создаёт услугу -> 201', newService.status === 201, newService.json);
  const newServiceId = newService.json.service.id;

  const oddDuration = await call('POST', '/api/admin/services', {
    token: ownerToken,
    body: { category_id: manicure.category.id, name: 'Тест', duration_min: 33, price_kopecks: 1000 },
  });
  check('длительность не кратна 5 -> 400', oddDuration.status === 400, oddDuration.json);

  const adminPrice = await call('PATCH', `/api/admin/services/${newServiceId}`, {
    token: adminToken, body: { price_kopecks: 99000 },
  });
  check('админ меняет цену -> 403', adminPrice.status === 403, adminPrice.json);

  const ownerPrice = await call('PATCH', `/api/admin/services/${newServiceId}`, {
    token: ownerToken, body: { price_kopecks: 99000 },
  });
  check('владелец меняет цену -> 200',
    ownerPrice.status === 200 && ownerPrice.json.service.price_kopecks === 99000);

  const adminRename = await call('PATCH', `/api/admin/services/${newServiceId}`, {
    token: adminToken, body: { name: 'Парафинотерапия' },
  });
  check('админ меняет название -> 200', adminRename.status === 200, adminRename.json);

  const emptyPatch = await call('PATCH', `/api/admin/services/${newServiceId}`, {
    token: adminToken, body: {},
  });
  check('пустой PATCH -> 400', emptyPatch.status === 400);

  const deleteService = await call('DELETE', `/api/admin/services/${newServiceId}`, { token: adminToken });
  check('мягкое удаление услуги -> 200', deleteService.status === 200);
  check('услуга скрыта из каталога',
    !(await call('GET', '/api/services')).json.services.some((s) => s.id === newServiceId));

  const busyService = await call('DELETE', `/api/admin/services/${manicure.id}`, { token: adminToken });
  check('удаление услуги с активной записью -> 409', busyService.status === 409, busyService.json);

  const newMaster = await call('POST', '/api/admin/masters', {
    token: adminToken,
    body: {
      first_name: 'Нина', last_name: 'Петрова', specialization: 'Брови',
      experience_years: 2, service_ids: [brows.id], is_visible: true,
    },
  });
  check('создание мастера -> 201', newMaster.status === 201, newMaster.json);
  const newMasterId = newMaster.json.master.id;
  check('у нового мастера доступ в систему не выдан',
    newMaster.json.master.access.granted === false);

  const ghostService = await call('POST', '/api/admin/masters', {
    token: adminToken,
    body: { first_name: 'Тест', last_name: 'Тестов', service_ids: [999999] },
  });
  check('мастер с несуществующей услугой -> 400', ghostService.status === 400);

  const schedule = await call('PUT', `/api/admin/masters/${newMasterId}/schedule`, {
    token: adminToken,
    body: {
      week: [
        { weekday: 1, start_min: 600, end_min: 1140, break_start_min: 840, break_end_min: 900 },
        { weekday: 2, start_min: 600, end_min: 1140 },
        { weekday: 7, is_day_off: true },
      ],
    },
  });
  check('график мастера сохранён -> 200', schedule.status === 200, schedule.json);

  const badBreak = await call('PUT', `/api/admin/masters/${newMasterId}/schedule`, {
    token: adminToken,
    body: { week: [{ weekday: 1, start_min: 600, end_min: 1140, break_start_min: 300, break_end_min: 400 }] },
  });
  check('перерыв вне рабочих часов -> 400', badBreak.status === 400, badBreak.json);

  const badWeekday = await call('PUT', `/api/admin/masters/${newMasterId}/schedule`, {
    token: adminToken, body: { week: [{ weekday: 9, start_min: 600, end_min: 700 }] },
  });
  check('день недели 9 -> 400', badWeekday.status === 400);

  const exception = await call('POST', `/api/admin/masters/${newMasterId}/exceptions`, {
    token: adminToken,
    body: { type: 'vacation', start_date: '2026-11-20', end_date: '2026-11-27', reason: 'Отпуск' },
  });
  check('исключение (отпуск) -> 201', exception.status === 201, exception.json);

  const badOverride = await call('POST', `/api/admin/masters/${newMasterId}/exceptions`, {
    token: adminToken,
    body: { type: 'hours_override', start_date: '2026-11-05', end_date: '2026-11-05' },
  });
  check('hours_override без часов -> 400', badOverride.status === 400, badOverride.json);

  const clashException = await call('POST', `/api/admin/masters/${master.id}/exceptions`, {
    token: adminToken,
    body: { type: 'vacation', start_date: day.date, end_date: day.date },
  });
  check('отпуск на день с записью -> 409', clashException.status === 409, clashException.json);

  // Блокировка времени закрывает слот для записи.
  const blockDay = day.date;
  const freeBefore = await call('GET',
    `/api/masters/${master.id}/availability?date=${blockDay}&service_ids=${bothServices}`);
  const victim = freeBefore.json.slots[0];
  const block = await call('POST', `/api/admin/masters/${master.id}/time-blocks`, {
    token: adminToken,
    body: {
      type: 'break', starts_at: victim.at_utc,
      ends_at: new Date(new Date(victim.at_utc).getTime() + 150 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      comment: 'Поставка материалов',
    },
  });
  check('блокировка времени -> 201', block.status === 201, block.json);
  const freeAfterBlock = await call('GET',
    `/api/masters/${master.id}/availability?date=${blockDay}&service_ids=${bothServices}`);
  check('заблокированное время ушло из свободных',
    !freeAfterBlock.json.slots.some((s) => s.at_utc === victim.at_utc));

  const blockOnBooked = await call('POST', `/api/admin/masters/${master.id}/time-blocks`, {
    token: adminToken,
    body: {
      type: 'break', starts_at: second.at_utc,
      ends_at: new Date(new Date(second.at_utc).getTime() + 60 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  });
  check('блокировка поверх записи -> 409', blockOnBooked.status === 409, blockOnBooked.json);

  const unblock = await call('DELETE',
    `/api/admin/masters/${master.id}/time-blocks/${block.json.time_block.id}`, { token: adminToken });
  check('снятие блокировки -> 200', unblock.status === 200);

  const statusChange = await call('POST', `/api/admin/appointments/${appointmentId}/status`, {
    token: adminToken, body: { status: 'confirmed' },
  });
  check('админ подтверждает запись -> 200', statusChange.status === 200);

  const sameStatus = await call('POST', `/api/admin/appointments/${appointmentId}/status`, {
    token: adminToken, body: { status: 'confirmed' },
  });
  check('тот же статус -> 409', sameStatus.status === 409, sameStatus.json);

  const badStatus = await call('POST', `/api/admin/appointments/${appointmentId}/status`, {
    token: adminToken, body: { status: 'teleported' },
  });
  check('неизвестный статус -> 400', badStatus.status === 400);

  const busyMaster = await call('DELETE', `/api/admin/masters/${master.id}`, { token: adminToken });
  check('удаление мастера с активной записью -> 409', busyMaster.status === 409, busyMaster.json);

  const deleteMaster = await call('DELETE', `/api/admin/masters/${newMasterId}`, { token: adminToken });
  check('мягкое удаление свободного мастера -> 200', deleteMaster.status === 200);

  console.log('\n— Отмена и выход —');
  const foreignCancel = await call('POST', `/api/appointments/${appointmentId}/cancel`,
    { token: marinaToken, body: {} });
  check('отмена чужой записи -> 404', foreignCancel.status === 404);

  const cancel = await call('POST', `/api/appointments/${appointmentId}/cancel`, {
    token: clientToken, body: { cancel_reason: 'Планы изменились' },
  });
  check('отмена своей записи -> 200', cancel.status === 200, cancel.json);
  check('статус — cancelled_by_client',
    cancel.json.appointment.status === 'cancelled_by_client');

  const cancelTwice = await call('POST', `/api/appointments/${appointmentId}/cancel`,
    { token: clientToken, body: {} });
  check('повторная отмена -> 409', cancelTwice.status === 409, cancelTwice.json);

  const freedUp = await call('GET',
    `/api/masters/${master.id}/availability?date=${day.date}&service_ids=${bothServices}`);
  check('после отмены время снова свободно',
    freedUp.json.slots.some((s) => s.at_utc === second.at_utc));

  // Позднюю отмену проверяем на записи, созданной админом через базу:
  // клиент такую запись отменить уже не может.
  const soonStart = new Date(Date.now() + 60 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const soonEnd = new Date(Date.now() + 120 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const soonInfo = db.run(
    `INSERT INTO appointments
       (client_user_id, master_id, starts_at_utc, ends_at_utc, service_duration_min,
        total_price_kopecks, status, created_at_utc, updated_at_utc)
     VALUES ((SELECT id FROM users WHERE email = 'client@lada.local'), ?, ?, ?, 60, 120000,
             'confirmed', ?, ?)`,
    [master.id, soonStart, soonEnd, soonStart, soonStart],
  );
  const soonId = Number(soonInfo.lastInsertRowid);
  const lateCancel = await call('POST', `/api/appointments/${soonId}/cancel`,
    { token: clientToken, body: {} });
  check('отмена позже чем за 4 ч -> 409', lateCancel.status === 409, lateCancel.json);
  const lateReschedule = await call('POST', `/api/appointments/${soonId}/reschedule`,
    { token: clientToken, body: { starts_at: second.at_utc } });
  check('перенос позже чем за 4 ч -> 409', lateReschedule.status === 409);
  const staffCancel = await call('POST', `/api/appointments/${soonId}/cancel`,
    { token: adminToken, body: { cancel_reason: 'Мастер заболел' } });
  check('студия отменяет поздно -> 200 и статус cancelled_by_studio',
    staffCancel.status === 200
    && staffCancel.json.appointment.status === 'cancelled_by_studio', staffCancel.json);

  const logout = await call('POST', '/api/auth/logout', { token: clientToken });
  check('выход -> 200', logout.status === 200);
  const afterLogout = await call('GET', '/api/appointments', { token: clientToken });
  check('токен после выхода не работает -> 401', afterLogout.status === 401);
  const logoutAgain = await call('POST', '/api/auth/logout', { token: clientToken });
  check('повторный выход -> 401', logoutAgain.status === 401);

  server.close();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Пройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length > 0) {
    console.log('Провалены:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
