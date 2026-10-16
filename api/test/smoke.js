'use strict';

// Сквозная проверка API на отдельной временной базе.
// Запуск: npm run smoke

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lada-smoke-')), 'test.sqlite');
process.env.LADA_DB_PATH = DB_PATH;
// Сквозной прогон входит и регистрируется десятки раз с одного адреса.
// Потолок поднят, чтобы лимит не ломал остальные проверки; сам лимит
// проверяется отдельно, в разделе «Ограничение частоты».
process.env.AUTH_RATE_MAX_ATTEMPTS = '100';

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

  console.log('');
  console.log('— Защита от двойной записи —');

  // Уровень 1: триггеры БД. Пишем мимо API, напрямую в таблицу.
  const liveAppt = db.one(
    `SELECT id, master_id, client_user_id, starts_at_utc, ends_at_utc
       FROM appointments WHERE status IN ('pending','confirmed') ORDER BY id LIMIT 1`,
  );
  check('есть активная запись для проверки триггеров', !!liveAppt);

  const rawInsert = (masterId, startsAt, endsAt, status = 'pending') => db.run(
    `INSERT INTO appointments
       (client_user_id, master_id, starts_at_utc, ends_at_utc, service_duration_min,
        total_price_kopecks, status, created_at_utc, updated_at_utc)
     VALUES (?, ?, ?, ?, 60, 100000, ?, ?, ?)`,
    [liveAppt.client_user_id, masterId, startsAt, endsAt, status,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  );
  const shiftIso = (iso, minutes) =>
    new Date(new Date(iso).getTime() + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  let overlapBlocked = false;
  try {
    // Ровно поверх существующего визита.
    rawInsert(liveAppt.master_id, liveAppt.starts_at_utc, liveAppt.ends_at_utc);
  } catch (err) {
    overlapBlocked = err.message === 'appointment_overlap';
  }
  check('триггер INSERT: полное совпадение интервалов отклонено', overlapBlocked);

  let partialBlocked = false;
  try {
    // Частичное наложение: начинается внутри существующего визита.
    rawInsert(liveAppt.master_id,
      shiftIso(liveAppt.starts_at_utc, 15), shiftIso(liveAppt.ends_at_utc, 15));
  } catch (err) {
    partialBlocked = err.message === 'appointment_overlap';
  }
  check('триггер INSERT: частичное наложение отклонено', partialBlocked);

  // Встык — пересечением НЕ считается: границы равны, строгие сравнения ложны.
  let adjacentId = null;
  try {
    const info = rawInsert(liveAppt.master_id,
      liveAppt.ends_at_utc, shiftIso(liveAppt.ends_at_utc, 60));
    adjacentId = Number(info.lastInsertRowid);
  } catch {
    adjacentId = null;
  }
  check('триггер INSERT: визит встык разрешён', adjacentId !== null);

  // Отменённая запись слот не держит — поверх неё вставить можно.
  db.run("UPDATE appointments SET status = 'cancelled_by_client' WHERE id = ?", [adjacentId]);
  let overCancelledId = null;
  try {
    const info = rawInsert(liveAppt.master_id,
      liveAppt.ends_at_utc, shiftIso(liveAppt.ends_at_utc, 60));
    overCancelledId = Number(info.lastInsertRowid);
  } catch {
    overCancelledId = null;
  }
  check('триггер INSERT: поверх отменённой записи вставка проходит', overCancelledId !== null);

  // Уровень 1, UPDATE: перенос на чужое время.
  let updateBlocked = false;
  try {
    db.run('UPDATE appointments SET starts_at_utc = ?, ends_at_utc = ? WHERE id = ?',
      [liveAppt.starts_at_utc, liveAppt.ends_at_utc, overCancelledId]);
  } catch (err) {
    updateBlocked = err.message === 'appointment_overlap';
  }
  check('триггер UPDATE: перенос на занятое время отклонён', updateBlocked);

  // Смена мастера тоже проходит через триггер.
  const otherMaster = db.one(
    'SELECT id FROM masters WHERE id <> ? AND is_active = 1 LIMIT 1', [liveAppt.master_id],
  );
  db.run('UPDATE appointments SET master_id = ? WHERE id = ?', [otherMaster.id, overCancelledId]);
  let masterSwapBlocked = false;
  try {
    db.run('UPDATE appointments SET master_id = ?, starts_at_utc = ?, ends_at_utc = ? WHERE id = ?',
      [liveAppt.master_id, liveAppt.starts_at_utc, liveAppt.ends_at_utc, overCancelledId]);
  } catch (err) {
    masterSwapBlocked = err.message === 'appointment_overlap';
  }
  check('триггер UPDATE: смена мастера на занятое время отклонена', masterSwapBlocked);

  // Запись не мешает сама себе: правка без смены времени проходит.
  let selfUpdateOk = true;
  try {
    db.run("UPDATE appointments SET client_comment = 'правка' WHERE id = ?", [liveAppt.id]);
  } catch {
    selfUpdateOk = false;
  }
  check('триггер UPDATE: правка самой записи не считается конфликтом', selfUpdateOk);

  db.run('DELETE FROM appointments WHERE id = ?', [overCancelledId]);

  // Уровень 2: транзакция создания берёт блокировку сразу.
  const dbSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'lib', 'db.js'), 'utf8',
  );
  check('транзакция открывается как BEGIN IMMEDIATE, а не DEFERRED',
    dbSource.includes("exec('BEGIN IMMEDIATE')")
    && !dbSource.includes("exec('BEGIN')")
    && !dbSource.includes("exec('BEGIN DEFERRED')"));

  // Уровень 3: API отдаёт 409 с подсказками, без текста SQLite.
  const occupied = db.one(
    'SELECT starts_at_utc, ends_at_utc, master_id FROM appointments WHERE id = ?', [liveAppt.id],
  );
  const dupe = await call('POST', '/api/appointments', {
    token: marinaToken,
    body: {
      master_id: occupied.master_id,
      service_ids: [manicure.id, brows.id],
      starts_at: occupied.starts_at_utc,
      consent: true,
    },
  });
  check('повторная запись на занятое время -> 409', dupe.status === 409, dupe.json);
  check('сообщение понятное, без текста SQLite',
    typeof dupe.json.error.message === 'string'
    && !dupe.json.error.message.includes('appointment_overlap')
    && !dupe.json.error.message.toUpperCase().includes('SQLITE'), dupe.json.error.message);
  check('в ответе есть ближайшие свободные слоты',
    Array.isArray(dupe.json.error.details.nearest_slots)
    && dupe.json.error.details.nearest_slots.every((x) => x.at_utc && x.local_time),
    dupe.json.error.details);

  console.log('');
  console.log('— Осознанное наложение администратора —');

  const busySpot = db.one(
    `SELECT id, master_id, starts_at_utc FROM appointments
      WHERE status IN ('pending','confirmed') ORDER BY id LIMIT 1`,
  );
  const overrideBody = (extra = {}) => ({
    master_id: busySpot.master_id,
    service_ids: [manicure.id, brows.id],
    starts_at: busySpot.starts_at_utc,
    consent: true,
    ...extra,
  });

  // Клиент передаёт признак вручную — он игнорируется, наложения нет.
  const clientTriesOverride = await call('POST', '/api/appointments', {
    token: marinaToken, body: overrideBody({ is_override: true }),
  });
  check('клиент с is_override=true -> всё равно 409',
    clientTriesOverride.status === 409, clientTriesOverride.json);
  check('отказ клиенту не ссылается на права, а говорит про занятость',
    clientTriesOverride.json.error.details.reason === 'overlap');

  const beforeCount = db.one(
    'SELECT COUNT(*) AS n FROM appointments WHERE master_id = ? AND starts_at_utc = ?',
    [busySpot.master_id, busySpot.starts_at_utc],
  ).n;
  check('запись клиента не создалась', beforeCount === 1, beforeCount);

  // Тот же запрос от администратора проходит.
  const adminOverride = await call('POST', '/api/appointments', {
    token: adminToken, body: overrideBody({ is_override: true }),
  });
  check('администратор с is_override=true -> 201',
    adminOverride.status === 201, adminOverride.json);
  const overrideId = adminOverride.status === 201 ? adminOverride.json.appointment.id : null;
  check('в базе признак выставлен',
    overrideId !== null
    && db.one('SELECT is_override FROM appointments WHERE id = ?', [overrideId]).is_override === 1);

  // Администратор без признака получает обычный отказ.
  const adminNoFlag = await call('POST', '/api/appointments', {
    token: adminToken, body: overrideBody(),
  });
  check('администратор без признака -> 409 как обычно',
    adminNoFlag.status === 409, adminNoFlag.json);

  // Главное: наложенная запись дальше работает как обычная и блокирует others.
  const thirdOnTop = await call('POST', '/api/appointments', {
    token: marinaToken, body: overrideBody(),
  });
  check('наложенная запись сама блокирует следующие попытки',
    thirdOnTop.status === 409, thirdOnTop.json);

  let blockedByOverride = false;
  try {
    db.run(
      `INSERT INTO appointments
         (client_user_id, master_id, starts_at_utc, ends_at_utc, service_duration_min,
          total_price_kopecks, status, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, 60, 100000, 'pending', ?, ?)`,
      [busySpot.client_user_id || 1, busySpot.master_id, busySpot.starts_at_utc,
        new Date(new Date(busySpot.starts_at_utc).getTime() + 30 * 60000)
          .toISOString().replace(/\.\d{3}Z$/, 'Z'),
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    );
  } catch (err) {
    blockedByOverride = err.message === 'appointment_overlap';
  }
  check('триггер по-прежнему видит наложенную запись как занимающую время',
    blockedByOverride);

  // Признак описывает размещение: перенос не-администратором его сбрасывает.
  if (overrideId !== null) {
    db.run('UPDATE appointments SET is_override = 1 WHERE id = ?', [overrideId]);
    const freeDay = await call('GET',
      `/api/masters/${busySpot.master_id}/availability?date=${day.date}`
      + `&service_ids=${manicure.id},${brows.id}`, { token: adminToken });
    if (freeDay.json.slots.length > 0) {
      const moved = await call('POST', `/api/appointments/${overrideId}/reschedule`, {
        token: adminToken, body: { starts_at: freeDay.json.slots[0].at_utc },
      });
      check('перенос без признака сбрасывает is_override в 0',
        moved.status === 200
        && db.one('SELECT is_override FROM appointments WHERE id = ?', [overrideId]).is_override === 0,
        moved.json);
    }
  }

  // Признак виден в админском списке. Через GET /api/appointments/:id его не
  // видно: эту запись создал сам админ, поэтому он её владелец и получает
  // клиентское представление — там признака нет и не должно быть.
  const adminList = await call('GET', '/api/admin/appointments', { token: adminToken });
  const listed = adminList.json.appointments.find((a) => a.id === overrideId);
  check('в админском списке признак присутствует',
    !!listed && listed.is_override !== undefined, listed);
  check('в админском списке есть и данные клиента',
    !!listed && listed.client !== undefined);

  const asOwner = await call('GET', `/api/appointments/${overrideId}`, { token: adminToken });
  check('владельцу записи отдаётся клиентский вид, без признака',
    asOwner.status === 200 && asOwner.json.appointment.is_override === undefined
    && asOwner.json.appointment.client === undefined);

  console.log('');
  console.log('— Клиенты для администратора —');

  const marinaId = register.json.user.id;
  const annaUserId = login.json.user.id;
  const ownerUserId = db.one("SELECT id FROM users WHERE email = 'owner@lada.local'").id;

  const clientsForClient = await call('GET', '/api/admin/clients', { token: clientToken });
  check('список клиентов клиенту -> 403', clientsForClient.status === 403, clientsForClient.json);

  const clientsAll = await call('GET', '/api/admin/clients', { token: adminToken });
  check('GET /api/admin/clients -> 200 с постраничным выводом',
    clientsAll.status === 200 && Number.isInteger(clientsAll.json.total)
    && clientsAll.json.limit === 50 && clientsAll.json.offset === 0, clientsAll.json);
  check('в списке только клиенты, персонала в нём нет',
    clientsAll.json.clients.some((c) => c.email === 'client@lada.local')
    && clientsAll.json.clients.some((c) => c.email === 'marina@example.com')
    && !clientsAll.json.clients.some(
      (c) => c.email === 'admin@lada.local' || c.email === 'owner@lada.local'),
    clientsAll.json.clients.map((c) => c.email));
  check('хеш пароля в списке клиентов не появляется',
    !JSON.stringify(clientsAll.json).toLowerCase().includes('scrypt')
    && clientsAll.json.clients.every((c) => c.password_hash === undefined));

  const annaClient = clientsAll.json.clients.find((c) => c.email === 'client@lada.local');
  check('в строке клиента есть счётчики визитов и неявок',
    !!annaClient && Number.isInteger(annaClient.visits_count)
    && Number.isInteger(annaClient.no_show_count) && annaClient.is_blocked === false,
    annaClient);
  check('ближайшая запись клиента отдана моментом в UTC и в поясе салона',
    annaClient.next_visit_at !== null
    && annaClient.next_visit_at.at_utc.endsWith('Z')
    && annaClient.next_visit_at.timezone === 'Europe/Moscow', annaClient.next_visit_at);
  check('завершённых визитов у клиента ещё нет',
    annaClient.visits_count === 0 && annaClient.last_visit_at === null, annaClient);

  const byName = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('марина тест')}`, { token: adminToken });
  check('поиск по имени в нижнем регистре находит клиента',
    byName.status === 200 && byName.json.total === 1
    && byName.json.clients[0].id === marinaId, byName.json);

  const byNameUpper = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('МАРИНА')}`, { token: adminToken });
  check('поиск по имени в верхнем регистре находит того же клиента',
    byNameUpper.json.total === 1 && byNameUpper.json.clients[0].id === marinaId, byNameUpper.json);

  const byPhone = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('000-11-22')}`, { token: adminToken });
  check('поиск по телефону не зависит от формата ввода',
    byPhone.json.total === 1 && byPhone.json.clients[0].id === marinaId, byPhone.json);

  const byEmail = await call('GET', '/api/admin/clients?q=MARINA@exa', { token: adminToken });
  check('поиск по части e-mail без учёта регистра',
    byEmail.json.total === 1 && byEmail.json.clients[0].id === marinaId, byEmail.json);

  const byMiss = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('Зоркина')}`, { token: adminToken });
  check('поиск без совпадений -> 200 и пустой список',
    byMiss.status === 200 && byMiss.json.total === 0 && byMiss.json.clients.length === 0);

  const wildcard = await call('GET', '/api/admin/clients?q=%25%25', { token: adminToken });
  check('символы шаблона LIKE в запросе ищутся как литералы',
    wildcard.status === 200 && wildcard.json.total === 0, wildcard.json);

  const shortQuery = await call('GET', '/api/admin/clients?q=%D0%BC', { token: adminToken });
  check('слишком короткий запрос -> 400', shortQuery.status === 400, shortQuery.json);

  const badClientStatus = await call('GET', '/api/admin/clients?status=unknown', { token: adminToken });
  check('неизвестный status -> 400', badClientStatus.status === 400, badClientStatus.json);

  const blockedOnly = await call('GET', '/api/admin/clients?status=blocked', { token: adminToken });
  check('фильтр status=blocked -> 200 и пока никого',
    blockedOnly.status === 200 && blockedOnly.json.total === 0, blockedOnly.json);

  const firstPage = await call('GET', '/api/admin/clients?limit=1', { token: adminToken });
  const secondPage = await call('GET', '/api/admin/clients?limit=1&offset=1', { token: adminToken });
  check('пагинация: страница по одному, total считает всех',
    firstPage.json.clients.length === 1 && firstPage.json.total >= 2
    && secondPage.json.clients.length === 1
    && firstPage.json.clients[0].id !== secondPage.json.clients[0].id,
    [firstPage.json, secondPage.json]);

  console.log('');
  console.log('— Запись за клиента (администратор) —');

  // Свободный слот ищем заново перед каждой записью: предыдущие проверки
  // уже заняли часть сетки.
  const findFreeSlot = async () => {
    for (let offset = 1; offset <= 14; offset += 1) {
      const date = new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
      const res = await call('GET',
        `/api/masters/${master.id}/availability?date=${date}&service_ids=${manicure.id}`);
      if (res.status === 200 && res.json.slots.length > 0) return res.json.slots[0];
    }
    return null;
  };
  const bookFor = (token, extra) => call('POST', '/api/appointments', {
    token,
    body: { master_id: master.id, service_ids: [manicure.id], ...extra },
  });

  const slotForMarina = await findFreeSlot();
  check('есть свободный слот для записи за клиента', slotForMarina !== null);

  const forMarina = await bookFor(adminToken, {
    starts_at: slotForMarina.at_utc,
    client_user_id: marinaId,
    client_comment: 'Записана по телефону',
  });
  check('администратор записывает клиента (consent не требуется) -> 201',
    forMarina.status === 201, forMarina.json);
  const forMarinaId = forMarina.status === 201 ? forMarina.json.appointment.id : null;
  check('визит оформлен на клиента, а не на администратора',
    forMarinaId !== null
    && db.one('SELECT client_user_id FROM appointments WHERE id = ?',
      [forMarinaId]).client_user_id === marinaId,
    forMarinaId);
  check('оформителю отдан админский вид с данными клиента',
    !!forMarina.json.appointment.client
    && forMarina.json.appointment.client.id === marinaId
    && forMarina.json.appointment.is_override === false,
    forMarina.json.appointment.client);

  const marinaSees = await call('GET', '/api/appointments', { token: marinaToken });
  check('клиент видит запись, созданную администратором',
    marinaSees.status === 200
    && marinaSees.json.appointments.some((a) => a.id === forMarinaId),
    marinaSees.json.appointments.map((a) => a.id));
  const marinaDetails = await call('GET', `/api/appointments/${forMarinaId}`, { token: marinaToken });
  check('клиенту отдаётся клиентский вид с правилами отмены',
    marinaDetails.status === 200 && marinaDetails.json.appointment.can_cancel === true
    && marinaDetails.json.appointment.can_reschedule === true
    && marinaDetails.json.appointment.is_override === undefined, marinaDetails.json);

  // Наложение за клиента — то, ради чего поле и нужно: без client_user_id
  // администратор оформлял бы такой визит на себя.
  const overlapNoFlag = await bookFor(adminToken, {
    starts_at: slotForMarina.at_utc, client_user_id: annaUserId,
  });
  check('то же время без is_override -> 409 как обычно',
    overlapNoFlag.status === 409, overlapNoFlag.json);

  const overlapForAnna = await bookFor(adminToken, {
    starts_at: slotForMarina.at_utc, client_user_id: annaUserId, is_override: true,
  });
  check('наложение за клиента -> 201', overlapForAnna.status === 201, overlapForAnna.json);
  const overlapRow = overlapForAnna.status === 201
    ? db.one('SELECT client_user_id, is_override FROM appointments WHERE id = ?',
      [overlapForAnna.json.appointment.id])
    : null;
  check('наложенный визит принадлежит клиенту и помечен признаком',
    !!overlapRow && overlapRow.client_user_id === annaUserId && overlapRow.is_override === 1,
    overlapRow);

  // Клиент распоряжается такой записью сам, по обычным правилам.
  const moveTarget = await findFreeSlot();
  const marinaMoves = await call('POST', `/api/appointments/${forMarinaId}/reschedule`, {
    token: marinaToken, body: { starts_at: moveTarget.at_utc },
  });
  check('клиент переносит её по обычным правилам -> 200',
    marinaMoves.status === 200 && marinaMoves.json.appointment.reschedule_count === 1,
    marinaMoves.json);
  const marinaCancels = await call('POST', `/api/appointments/${forMarinaId}/cancel`, {
    token: marinaToken, body: { cancel_reason: 'Не смогу прийти' },
  });
  check('клиент сам отменяет её -> cancelled_by_client',
    marinaCancels.status === 200
    && marinaCancels.json.appointment.status === 'cancelled_by_client', marinaCancels.json);

  // Клиенту и мастеру поле молча игнорируется — как и is_override.
  const selfSlot = await findFreeSlot();
  const clientWithField = await bookFor(marinaToken, {
    starts_at: selfSlot.at_utc, client_user_id: annaUserId, consent: true,
  });
  check('клиент с client_user_id -> 201, но запись на него самого',
    clientWithField.status === 201
    && db.one('SELECT client_user_id FROM appointments WHERE id = ?',
      [clientWithField.json.appointment.id]).client_user_id === marinaId,
    clientWithField.json);
  check('клиенту по-прежнему отдаётся свой вид, без данных клиента',
    clientWithField.json.appointment.client === undefined);

  const unknownClient = await bookFor(adminToken, {
    starts_at: selfSlot.at_utc, client_user_id: 999999,
  });
  check('неизвестный client_user_id -> 404', unknownClient.status === 404, unknownClient.json);

  const staffAsClient = await bookFor(adminToken, {
    starts_at: selfSlot.at_utc, client_user_id: ownerUserId,
  });
  check('аккаунт персонала в client_user_id -> 404, роль не раскрывается',
    staffAsClient.status === 404
    && staffAsClient.json.error.message === unknownClient.json.error.message,
    staffAsClient.json);

  const withHold = await bookFor(adminToken, {
    starts_at: selfSlot.at_utc, client_user_id: marinaId, hold_token: 'a'.repeat(64),
  });
  check('hold_token вместе с client_user_id -> 400',
    withHold.status === 400 && !!withHold.json.error.details.hold_token, withHold.json);

  const selfNoConsent = await bookFor(marinaToken, { starts_at: selfSlot.at_utc });
  check('клиент без consent по-прежнему -> 400',
    selfNoConsent.status === 400 && !!selfNoConsent.json.error.details.consent,
    selfNoConsent.json);

  // Блокировка закрывает самостоятельную запись, но не запись через студию:
  // её текст как раз отправляет клиента звонить администратору.
  db.run('UPDATE users SET is_blocked = 1 WHERE id = ?', [marinaId]);
  const blockedSlot = await findFreeSlot();
  const blockedSelf = await bookFor(marinaToken, {
    starts_at: blockedSlot.at_utc, consent: true,
  });
  check('заблокированный клиент сам записаться не может -> 403',
    blockedSelf.status === 403, blockedSelf.json);
  const blockedByAdmin = await bookFor(adminToken, {
    starts_at: blockedSlot.at_utc, client_user_id: marinaId,
  });
  check('администратор записывает заблокированного клиента -> 201',
    blockedByAdmin.status === 201, blockedByAdmin.json);
  const blockedListed = await call('GET', '/api/admin/clients?status=blocked', { token: adminToken });
  check('заблокированный клиент виден в фильтре status=blocked',
    blockedListed.json.total === 1 && blockedListed.json.clients[0].is_blocked === true,
    blockedListed.json);
  db.run('UPDATE users SET is_blocked = 0 WHERE id = ?', [marinaId]);

  // Лимит активных записей — ограничение клиента визита, а не оформителя.
  // Доводим одного клиента до лимита записями за него же.
  const maxActive = db.settings().max_active_appointments;
  const countActive = (userId) => db.one(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE client_user_id = ? AND status IN ('pending','confirmed') AND starts_at_utc > ?`,
    [userId, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')],
  ).n;

  let marinaActive = countActive(marinaId);
  while (marinaActive < maxActive) {
    const fillerSlot = await findFreeSlot();
    const filler = await bookFor(adminToken, {
      starts_at: fillerSlot.at_utc, client_user_id: marinaId,
    });
    if (filler.status !== 201) break;
    marinaActive += 1;
  }
  check('клиент доведён до лимита активных записей',
    marinaActive === maxActive && countActive(annaUserId) < maxActive,
    [marinaActive, countActive(annaUserId)]);

  const overLimitSlot = await findFreeSlot();
  const overLimit = await bookFor(adminToken, {
    starts_at: overLimitSlot.at_utc, client_user_id: marinaId,
  });
  check('запись за клиента сверх его лимита -> 409',
    overLimit.status === 409 && overLimit.json.error.message.includes('лимит'), overLimit.json);

  const otherClient = await bookFor(adminToken, {
    starts_at: overLimitSlot.at_utc, client_user_id: annaUserId,
  });
  check('лимит считается по клиенту визита, а не по администратору',
    otherClient.status === 201, otherClient.json);

  console.log('');
  console.log('— Создание клиента администратором —');

  const newClient = {
    name: 'Виктория Белых',
    email: 'Victoria.B@Example.com',
    phone: '+7 999 321-11-00',
    consent: true,
  };

  const createByClient = await call('POST', '/api/admin/clients',
    { token: clientToken, body: newClient });
  check('создание клиента клиентом -> 403', createByClient.status === 403, createByClient.json);

  const createNoConsent = await call('POST', '/api/admin/clients',
    { token: adminToken, body: { ...newClient, consent: false } });
  check('создание без подтверждения согласия -> 400',
    createNoConsent.status === 400 && !!createNoConsent.json.error.details.consent,
    createNoConsent.json);

  const createBadPhone = await call('POST', '/api/admin/clients',
    { token: adminToken, body: { ...newClient, phone: '123' } });
  check('создание с неверным телефоном -> 400',
    createBadPhone.status === 400 && !!createBadPhone.json.error.details.phone,
    createBadPhone.json);

  const createTakenEmail = await call('POST', '/api/admin/clients',
    { token: adminToken, body: { ...newClient, email: 'client@lada.local' } });
  check('создание на занятый e-mail -> 409',
    createTakenEmail.status === 409 && !!createTakenEmail.json.error.details.email,
    createTakenEmail.json);

  const createdClient = await call('POST', '/api/admin/clients',
    { token: adminToken, body: newClient });
  check('администратор создаёт клиента -> 201', createdClient.status === 201, createdClient.json);
  const createdId = createdClient.status === 201 ? createdClient.json.client.id : null;
  check('e-mail приведён к нижнему регистру, телефон нормализован',
    createdClient.json.client.email === 'victoria.b@example.com'
    && createdClient.json.client.phone === '+79993211100', createdClient.json.client);
  check('созданный клиент без доступа в кабинет и без истории',
    createdClient.json.client.has_login === false
    && createdClient.json.client.is_blocked === false
    && createdClient.json.client.visits_count === 0
    && createdClient.json.client.last_visit_at === null
    && createdClient.json.client.next_visit_at === null, createdClient.json.client);
  check('ни хеш пароля, ни его заглушка в ответе не появляются',
    createdClient.json.client.password_hash === undefined
    && !JSON.stringify(createdClient.json).includes('scrypt')
    && !JSON.stringify(createdClient.json).includes('nologin'), createdClient.json);
  check('в базе вместо хеша лежит заглушка чужой схемы',
    db.one('SELECT password_hash FROM users WHERE id = ?', [createdId])
      .password_hash.startsWith('nologin$'));

  const cantLogin = await call('POST', '/api/auth/login',
    { body: { email: 'victoria.b@example.com', password: 'Lada12345' } });
  const unknownLogin = await call('POST', '/api/auth/login',
    { body: { email: 'nobody@example.com', password: 'Lada12345' } });
  check('войти в созданный аккаунт нельзя -> 401', cantLogin.status === 401, cantLogin.json);
  check('ответ тот же, что для неизвестного e-mail: отсутствие пароля не выдаётся',
    cantLogin.json.error.message === unknownLogin.json.error.message, cantLogin.json);

  const createdInList = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('Белых')}`, { token: adminToken });
  check('созданный клиент виден в списке со статусом «без аккаунта»',
    createdInList.json.total === 1 && createdInList.json.clients[0].id === createdId
    && createdInList.json.clients[0].has_login === false, createdInList.json);

  const registeredInList = await call('GET',
    `/api/admin/clients?q=${encodeURIComponent('Марина Тест')}`, { token: adminToken });
  check('у клиента, зарегистрировавшегося сам, has_login = true',
    registeredInList.json.clients[0].has_login === true, registeredInList.json.clients[0]);

  const createdSlot = await findFreeSlot();
  const bookCreated = await bookFor(adminToken, {
    starts_at: createdSlot.at_utc, client_user_id: createdId, source: 'phone',
  });
  check('созданного клиента можно записать -> 201', bookCreated.status === 201, bookCreated.json);
  check('источник записи сохранён и подписан для показа',
    bookCreated.json.appointment.source === 'phone'
    && bookCreated.json.appointment.source_label === 'Телефон', bookCreated.json.appointment);

  console.log('');
  console.log('— Правка клиента и блокировка —');

  const patchByClient = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: clientToken, body: { name: 'Чужое имя' } });
  check('правка клиента клиентом -> 403', patchByClient.status === 403, patchByClient.json);

  const emptyClientPatch = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: adminToken, body: {} });
  check('PATCH без полей -> 400',
    emptyClientPatch.status === 400 && !!emptyClientPatch.json.error.details.body, emptyClientPatch.json);

  const badIdPatch = await call('PATCH', '/api/admin/clients/abc',
    { token: adminToken, body: { name: 'Кто-то' } });
  check('нечисловой id в PATCH -> 400', badIdPatch.status === 400, badIdPatch.json);

  const unknownPatch = await call('PATCH', '/api/admin/clients/999999',
    { token: adminToken, body: { name: 'Кто-то' } });
  check('правка неизвестного клиента -> 404', unknownPatch.status === 404, unknownPatch.json);

  const staffPatch = await call('PATCH', `/api/admin/clients/${ownerUserId}`,
    { token: adminToken, body: { name: 'Не владелец' } });
  check('правка аккаунта персонала -> 404, роль не раскрывается',
    staffPatch.status === 404
    && staffPatch.json.error.message === unknownPatch.json.error.message, staffPatch.json);

  const contactsPatch = await call('PATCH', `/api/admin/clients/${createdId}`, {
    token: adminToken,
    body: { name: 'Виктория Белых-Орлова', phone: '8 999 321-11-01', email: 'Vika@Example.com' },
  });
  check('контакты из карточки клиента обновляются -> 200',
    contactsPatch.status === 200
    && contactsPatch.json.client.name === 'Виктория Белых-Орлова'
    && contactsPatch.json.client.phone === '+79993211101'
    && contactsPatch.json.client.email === 'vika@example.com', contactsPatch.json);

  const sameEmailPatch = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: adminToken, body: { email: 'vika@example.com' } });
  check('свой же e-mail занятым не считается -> 200',
    sameEmailPatch.status === 200, sameEmailPatch.json);

  const takenEmailPatch = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: adminToken, body: { email: 'client@lada.local' } });
  check('чужой e-mail в PATCH -> 409',
    takenEmailPatch.status === 409 && !!takenEmailPatch.json.error.details.email,
    takenEmailPatch.json);

  // Счётчик неявок и роль через этот эндпоинт не меняются: в SET попадают
  // только перечисленные в валидаторе поля.
  db.run('UPDATE users SET no_show_count = 3 WHERE id = ?', [createdId]);
  const forgedPatch = await call('PATCH', `/api/admin/clients/${createdId}`, {
    token: adminToken,
    body: { name: 'Виктория Белых-Орлова', role: 'owner', no_show_count: 0, has_login: true },
  });
  check('посторонние поля в PATCH игнорируются: роль и счётчик неявок на месте',
    forgedPatch.status === 200 && forgedPatch.json.client.no_show_count === 3
    && db.all('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role',
      [createdId]).map((r) => r.role).join(',') === 'client'
    && forgedPatch.json.client.has_login === false, forgedPatch.json);

  const blockPatch = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: adminToken, body: { is_blocked: true } });
  check('блокировка вручную -> 200 и признак выставлен',
    blockPatch.status === 200 && blockPatch.json.client.is_blocked === true, blockPatch.json);

  const unblockPatch = await call('PATCH', `/api/admin/clients/${createdId}`,
    { token: adminToken, body: { is_blocked: false } });
  check('разблокировка -> 200 и признак снят',
    unblockPatch.status === 200 && unblockPatch.json.client.is_blocked === false,
    unblockPatch.json);
  check('разблокировка не стирает историю неявок',
    unblockPatch.json.client.no_show_count === 3, unblockPatch.json.client);

  // Как блокировка и разблокировка действуют на клиента, который может войти.
  const olga = await call('POST', '/api/auth/register', {
    body: {
      name: 'Ольга Источникова',
      email: 'olga.src@example.com',
      phone: '+7 999 555-01-01',
      password: 'Lada12345',
      password_confirm: 'Lada12345',
      consent: true,
    },
  });
  const olgaToken = olga.json.session_token;
  const olgaId = olga.json.user.id;

  const olgaBlock = await call('PATCH', `/api/admin/clients/${olgaId}`,
    { token: adminToken, body: { is_blocked: true } });
  check('администратор блокирует клиента с доступом -> 200', olgaBlock.status === 200);
  const olgaSlot = await findFreeSlot();
  const olgaBlockedSelf = await bookFor(olgaToken, {
    starts_at: olgaSlot.at_utc, consent: true,
  });
  check('заблокированный вручную клиент сам записаться не может -> 403',
    olgaBlockedSelf.status === 403, olgaBlockedSelf.json);
  const olgaBlockedLogin = await call('POST', '/api/auth/login',
    { body: { email: 'olga.src@example.com', password: 'Lada12345' } });
  check('вход заблокированному клиенту закрыт -> 403',
    olgaBlockedLogin.status === 403, olgaBlockedLogin.json);

  const olgaUnblock = await call('PATCH', `/api/admin/clients/${olgaId}`,
    { token: adminToken, body: { is_blocked: false } });
  check('администратор снимает блокировку -> 200',
    olgaUnblock.status === 200 && olgaUnblock.json.client.is_blocked === false,
    olgaUnblock.json);
  const olgaSelf = await bookFor(olgaToken, { starts_at: olgaSlot.at_utc, consent: true });
  check('после разблокировки клиент записывается сам -> 201',
    olgaSelf.status === 201, olgaSelf.json);

  console.log('');
  console.log('— Источник записи —');

  check('запись, оформленная клиентом, помечена источником online',
    db.one('SELECT source FROM appointments WHERE id = ?',
      [olgaSelf.json.appointment.id]).source === 'online');
  check('источник клиенту не показывается',
    olgaSelf.json.appointment.source === undefined
    && olgaSelf.json.appointment.source_label === undefined);

  const unknownSource = await bookFor(adminToken, {
    starts_at: createdSlot.at_utc, client_user_id: createdId, source: 'mail',
  });
  check('неизвестный источник -> 400',
    unknownSource.status === 400 && !!unknownSource.json.error.details.source,
    unknownSource.json);

  const onlineSource = await bookFor(adminToken, {
    starts_at: createdSlot.at_utc, client_user_id: createdId, source: 'online',
  });
  check('источник online извне не принимается -> 400',
    onlineSource.status === 400 && !!onlineSource.json.error.details.source,
    onlineSource.json);

  const noSourceSlot = await findFreeSlot();
  const noSource = await bookFor(adminToken, {
    starts_at: noSourceSlot.at_utc, client_user_id: createdId,
  });
  check('запись за клиента без источника -> 201 и source = null',
    noSource.status === 201 && noSource.json.appointment.source === null
    && noSource.json.appointment.source_label === null, noSource.json);

  const whatsappSlot = await findFreeSlot();
  const whatsapp = await bookFor(adminToken, {
    starts_at: whatsappSlot.at_utc, client_user_id: createdId, source: 'whatsapp',
  });
  check('запись за клиента с источником WhatsApp -> 201',
    whatsapp.status === 201 && whatsapp.json.appointment.source === 'whatsapp'
    && whatsapp.json.appointment.source_label === 'WhatsApp', whatsapp.json);

  const whatsappId = whatsapp.status === 201 ? whatsapp.json.appointment.id : null;
  const sourceMoveSlot = await findFreeSlot();
  const sourceMove = await call('POST', `/api/appointments/${whatsappId}/reschedule`,
    { token: adminToken, body: { starts_at: sourceMoveSlot.at_utc } });
  check('перенос не меняет источник записи',
    sourceMove.status === 200
    && db.one('SELECT source FROM appointments WHERE id = ?', [whatsappId]).source === 'whatsapp',
    sourceMove.json);

  const olgaSourceSlot = await findFreeSlot();
  const olgaWithSource = await bookFor(olgaToken, {
    starts_at: olgaSourceSlot.at_utc, consent: true, source: 'phone',
  });
  check('присланный клиентом источник игнорируется: в базе online',
    olgaWithSource.status === 201
    && db.one('SELECT source FROM appointments WHERE id = ?',
      [olgaWithSource.json.appointment.id]).source === 'online', olgaWithSource.json);

  const adminFeed = await call('GET', '/api/admin/appointments?limit=200', { token: adminToken });
  const whatsappRow = adminFeed.json.appointments.find((a) => a.id === whatsappId);
  check('источник виден персоналу в общем списке записей',
    !!whatsappRow && whatsappRow.source === 'whatsapp'
    && whatsappRow.source_label === 'WhatsApp', whatsappRow);

  console.log('\n— Активные сессии —');
  // Блок «Активные сессии» на странице 16. Основную сессию клиента не трогаем:
  // открываем вторую и завершаем из первой.
  const secondLogin = await call('POST', '/api/auth/login',
    { body: { email: 'client@lada.local', password: 'Lada12345' } });
  check('второй вход тем же клиентом -> 200', secondLogin.status === 200);
  const secondToken = secondLogin.json.session_token;

  const sessionList = await call('GET', '/api/auth/sessions', { token: clientToken });
  check('список активных сессий -> 200 и обе сессии в нём',
    sessionList.status === 200 && sessionList.json.sessions.length >= 2, sessionList.json);
  check('текущая сессия помечена ровно одна',
    sessionList.json.sessions.filter((s) => s.is_current).length === 1);
  check('у сессии есть подпись устройства и срок',
    sessionList.json.sessions.every((s) => typeof s.device === 'string' && s.device.length > 0
      && typeof s.expires_at_utc === 'string'));

  // Главное свойство этого списка: он показывает все устройства разом,
  // поэтому токенов в нём быть не должно.
  const listText = JSON.stringify(sessionList.json);
  check('токены сессий наружу не отдаются',
    !listText.includes(clientToken) && !listText.includes(secondToken), listText.slice(0, 200));
  check('id сессии — хранимый хеш токена, а не сам токен',
    sessionList.json.sessions.every((s) => /^[0-9a-f]{64}$/.test(s.id))
    && db.one('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?',
      [sessionList.json.sessions[0].id]).n === 1);

  // Главное требование к хранению: по копии таблицы войти нельзя.
  const { hashToken } = require('../src/lib/auth');
  check('сам токен в базе не хранится',
    db.one('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', [clientToken]).n === 0
    && db.one('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?',
      [hashToken(clientToken)]).n === 1);
  check('колонки token в таблице sessions нет вовсе',
    db.all('PRAGMA table_info(sessions)').every((c) => c.name !== 'token'));
  check('ни одно значение в sessions не совпадает с действующим токеном',
    db.all('SELECT * FROM sessions').every(
      (row) => !Object.values(row).some((v) => v === clientToken || v === secondToken)));

  const otherSession = sessionList.json.sessions.find((s) => !s.is_current);
  check('чужую сессию завершить нельзя -> 404',
    (await call('DELETE', `/api/auth/sessions/${otherSession.id}`,
      { token: adminToken })).status === 404);
  check('несуществующий id -> 404',
    (await call('DELETE', `/api/auth/sessions/${'f'.repeat(64)}`,
      { token: clientToken })).status === 404);
  check('id не того формата -> 400',
    (await call('DELETE', '/api/auth/sessions/abc', { token: clientToken })).status === 400);
  check('список сессий без входа -> 401',
    (await call('GET', '/api/auth/sessions')).status === 401);

  const ended = await call('DELETE', `/api/auth/sessions/${otherSession.id}`,
    { token: clientToken });
  check('«Завершить» на другом устройстве -> 200',
    ended.status === 200 && ended.json.was_current === false, ended.json);
  check('завершённый токен больше не работает -> 401',
    (await call('GET', '/api/auth/me', { token: secondToken })).status === 401);
  check('своя сессия после этого цела',
    (await call('GET', '/api/auth/me', { token: clientToken })).status === 200);

  // Подпись устройства разбирается из User-Agent; HTTP-клиент теста своего
  // не шлёт, поэтому саму таблицу разбора проверяем напрямую.
  const { describeDevice } = require('../src/lib/auth');
  check('User-Agent разбирается в подпись устройства',
    describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120 Safari/537.36').device === 'Chrome · Windows'
    && describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1').kind === 'mobile'
    && describeDevice(null).device === 'Неизвестное устройство',
    describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120 Safari/537.36'));

  console.log('\n— Кабинет мастера —');
  // Основной `master` в тесте — Елена Смирнова, у неё доступа намеренно нет.
  // Кабинет проверяем на Анне, у которой аккаунт в сиде есть.
  const allMasters = (await call('GET', '/api/admin/masters', { token: adminToken })).json.masters;
  const annaCard = allMasters.find((m) => m.display_name === 'Анна Ковалева');
  const elenaCard = allMasters.find((m) => m.display_name === 'Елена Смирнова');
  check('доступ мастера виден админу: у Анны выдан, у Елены нет',
    annaCard.access.granted === true && annaCard.access.email === 'anna@lada.local'
    && elenaCard.access.granted === false,
    { anna: annaCard.access, elena: elenaCard.access });

  const annaLogin = await call('POST', '/api/auth/login',
    { body: { email: 'anna@lada.local', password: 'Lada12345' } });
  check('мастер входит по своему аккаунту -> 200', annaLogin.status === 200, annaLogin.json);
  const annaToken = annaLogin.json.session_token;
  const marinaMasterLogin = await call('POST', '/api/auth/login',
    { body: { email: 'marina.master@lada.local', password: 'Lada12345' } });
  const marinaMasterToken = marinaMasterLogin.json.session_token;

  check('клиенту кабинет мастера закрыт -> 403',
    (await call('GET', '/api/master/day', { token: clientToken })).status === 403);
  check('администратору кабинет мастера закрыт -> 403',
    (await call('GET', '/api/master/day', { token: adminToken })).status === 403);
  check('без входа кабинет мастера -> 401',
    (await call('GET', '/api/master/day')).status === 401);

  const annaMe = await call('GET', '/api/master/me', { token: annaToken });
  check('мастер видит свою карточку -> 200',
    annaMe.status === 200 && annaMe.json.master.id === annaCard.id
    && annaMe.json.account.email === 'anna@lada.local', annaMe.json);

  // Визит к Анне: оформляет администратор, как на странице 24.
  const annaSvc = (await call('GET', `/api/services?master_id=${annaCard.id}`)).json.services[0];
  let annaSlot = null;
  let annaDate = null;
  for (let i = 1; i <= 14 && annaSlot === null; i += 1) {
    annaDate = new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10);
    const av = await call('GET',
      `/api/masters/${annaCard.id}/availability?date=${annaDate}&service_ids=${annaSvc.id}`);
    if (av.status === 200 && av.json.slots.length > 0) annaSlot = av.json.slots[0];
  }
  check('есть свободный слот у мастера с доступом', annaSlot !== null);

  const masterClient = await call('POST', '/api/admin/clients', {
    token: adminToken,
    body: { name: 'Дарья Миронова', email: 'daria.m@example.com', phone: '+7 999 555-10-20', consent: true },
  });
  const annaVisit = await call('POST', '/api/appointments', {
    token: adminToken,
    body: {
      master_id: annaCard.id, service_ids: [annaSvc.id],
      starts_at: annaSlot.at_utc, client_user_id: masterClient.json.client.id,
    },
  });
  check('визит к мастеру создан администратором -> 201', annaVisit.status === 201, annaVisit.json);
  const annaVisitId = annaVisit.json.appointment.id;

  const annaDay = await call('GET', `/api/master/day?date=${annaDate}`, { token: annaToken });
  const dayVisit = annaDay.json.timeline.find((i) => i.kind === 'appointment');
  check('«Мой день»: визит, свободное окно и сводка',
    annaDay.status === 200 && annaDay.json.summary.appointments_count === 1
    && dayVisit.appointment_id === annaVisitId
    && dayVisit.client_name === 'Дарья Миронова'
    && annaDay.json.timeline.some((i) => i.kind === 'free')
    && annaDay.json.summary.free_min > 0,
    annaDay.json.summary);

  const annaWeek = await call('GET', `/api/master/week?date=${annaDate}`, { token: annaToken });
  check('«Неделя»: семь дней, загрузка и свой визит внутри',
    annaWeek.status === 200 && annaWeek.json.days.length === 7
    && annaWeek.json.summary.appointments_count >= 1
    && annaWeek.json.summary.load_percent > 0
    && annaWeek.json.days.some((d) => d.visits.some((v) => v.appointment_id === annaVisitId)),
    annaWeek.json.summary);

  const visitCard = await call('GET', `/api/master/appointments/${annaVisitId}`, { token: annaToken });
  check('детали визита: мастер видит контакты своего клиента',
    visitCard.status === 200 && visitCard.json.appointment.client.phone === '+79995551020'
    && visitCard.json.appointment.client.initials === 'ДМ'
    && visitCard.json.appointment.client.visits_with_me === 0, visitCard.json);
  check('внутренний учёт студии мастеру не отдаётся',
    visitCard.json.appointment.is_override === undefined
    && visitCard.json.appointment.source === undefined);

  check('чужой визит мастеру -> 404',
    (await call('GET', `/api/master/appointments/${annaVisitId}`,
      { token: marinaMasterToken })).status === 404);

  const arrived = await call('POST', `/api/master/appointments/${annaVisitId}/status`,
    { token: annaToken, body: { status: 'confirmed' } });
  check('«Клиент пришёл» от мастера -> 200',
    arrived.status === 200 && arrived.json.status === 'confirmed', arrived.json);
  check('статус записан той же функцией, что у админа',
    db.one('SELECT status FROM appointments WHERE id = ?', [annaVisitId]).status === 'confirmed');

  const masterCancel = await call('POST', `/api/master/appointments/${annaVisitId}/status`,
    { token: annaToken, body: { status: 'cancelled_by_studio' } });
  check('отмена мастеру недоступна -> 400, её нет среди значений',
    masterCancel.status === 400
    && /confirmed, completed, no_show/.test(masterCancel.json.error.details.status),
    masterCancel.json);
  check('колонки отмены после отказа пусты',
    db.one('SELECT status, cancelled_at_utc FROM appointments WHERE id = ?',
      [annaVisitId]).cancelled_at_utc === null);

  check('чужой визит мастер не переводит -> 404',
    (await call('POST', `/api/master/appointments/${annaVisitId}/status`,
      { token: marinaMasterToken, body: { status: 'completed' } })).status === 404);

  const myClients = await call('GET', '/api/master/clients', { token: annaToken });
  check('«Мои клиенты»: только те, кто записывался к этому мастеру',
    myClients.status === 200
    && myClients.json.clients.some((c) => c.name === 'Дарья Миронова')
    && myClients.json.clients.every((c) => c.name !== 'Марина Волкова'), myClients.json);
  check('поиск по имени в своих клиентах',
    (await call('GET', '/api/master/clients?q=дарья', { token: annaToken }))
      .json.clients.length === 1);
  check('у Марины-мастера своих клиентов нет',
    (await call('GET', '/api/master/clients', { token: marinaMasterToken })).json.total === 0);

  // Блокировка времени — страница 39.
  const blockOverVisit = await call('POST', '/api/master/time-blocks', {
    token: annaToken,
    body: { type: 'break', starts_at: annaSlot.at_utc, ends_at: annaVisit.json.appointment.ends_at.at_utc },
  });
  check('блокировка поверх своего визита -> 409',
    blockOverVisit.status === 409, blockOverVisit.json);

  const farStart = new Date(Date.now() + 200 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const overHorizon = await call('POST', '/api/master/time-blocks', {
    token: annaToken,
    body: {
      type: 'vacation', starts_at: farStart,
      ends_at: new Date(Date.now() + 201 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  });
  check('блокировка дальше горизонта -> 409', overHorizon.status === 409, overHorizon.json);

  const freeSlot = annaDay.json.timeline.find((i) => i.kind === 'free');
  const myBlock = await call('POST', '/api/master/time-blocks', {
    token: annaToken,
    body: {
      type: 'break', starts_at: freeSlot.starts_at.at_utc,
      ends_at: new Date(new Date(freeSlot.starts_at.at_utc).getTime() + 30 * 60000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z'),
      comment: 'Обед',
    },
  });
  check('мастер блокирует своё свободное время -> 201', myBlock.status === 201, myBlock.json);
  check('блокировка записана на самого мастера, а не на присланный id',
    db.one('SELECT master_id, created_by_user_id FROM time_blocks WHERE id = ?',
      [myBlock.json.time_block.id]).master_id === annaCard.id);
  check('заблокированное время ушло из свободных слотов',
    !(await call('GET',
      `/api/masters/${annaCard.id}/availability?date=${annaDate}&service_ids=${annaSvc.id}`))
      .json.slots.some((s) => s.at_utc === freeSlot.starts_at.at_utc));

  check('чужую блокировку снять нельзя -> 404',
    (await call('DELETE', `/api/master/time-blocks/${myBlock.json.time_block.id}`,
      { token: marinaMasterToken })).status === 404);
  check('свою блокировку мастер снимает -> 200',
    (await call('DELETE', `/api/master/time-blocks/${myBlock.json.time_block.id}`,
      { token: annaToken })).status === 200);
  check('после снятия время снова свободно',
    (await call('GET',
      `/api/masters/${annaCard.id}/availability?date=${annaDate}&service_ids=${annaSvc.id}`))
      .json.slots.some((s) => s.at_utc === freeSlot.starts_at.at_utc));

  check('создать запись через кабинет мастера нельзя: эндпоинта нет',
    (await call('POST', '/api/master/appointments',
      { token: annaToken, body: { master_id: annaCard.id } })).status === 404);

  console.log('\n— Роли списком и проверка прав —');
  // Марина — мастер И администратор одновременно: ради такого случая роли и
  // хранятся списком, а проверка спрашивает «есть ли роль», а не «равна ли».
  const marinaRoles = db.all(
    `SELECT r.role FROM user_roles r JOIN users u ON u.id = r.user_id
      WHERE u.email = 'marina.master@lada.local' ORDER BY r.role`,
  ).map((r) => r.role);
  check('у одного человека несколько ролей',
    marinaRoles.join(',') === 'admin,master', marinaRoles);
  check('колонки users.role больше нет — второго источника правды не осталось',
    db.all('PRAGMA table_info(users)').every((c) => c.name !== 'role'));

  const dualLogin = await call('POST', '/api/auth/login',
    { body: { email: 'marina.master@lada.local', password: 'Lada12345' } });
  const dualToken = dualLogin.json.session_token;
  check('/api/auth/me отдаёт роли списком',
    Array.isArray(dualLogin.json.user.roles)
    && dualLogin.json.user.roles.join(',') === 'admin,master', dualLogin.json.user);
  check('обе роли работают: и кабинет мастера, и админский раздел',
    (await call('GET', '/api/master/day', { token: dualToken })).status === 200
    && (await call('GET', '/api/admin/clients', { token: dualToken })).status === 200);
  check('роли владельца у неё нет: цену назначить нельзя -> 403',
    (await call('POST', '/api/admin/services', {
      token: dualToken,
      body: {
        category_id: 1, name: 'Проба', duration_min: 30,
        buffer_after_min: 0, price_kopecks: 100000,
      },
    })).status === 403);

  // Роль берётся из базы по user_id — подставить её запросом некуда.
  check('клиент админским разделом не становится -> 403',
    (await call('GET', '/api/admin/clients', { token: clientToken })).status === 403);
  const forgedRegister = await call('POST', '/api/auth/register', {
    body: {
      name: 'Самозванец', email: 'impostor@example.com', phone: '+79990000777',
      password: 'Lada12345', password_confirm: 'Lada12345', consent: true,
      role: 'admin', roles: ['admin', 'owner'], is_blocked: true, no_show_count: 99,
    },
  });
  check('регистрация с присланной ролью -> 201, но роль только client',
    forgedRegister.status === 201
    && forgedRegister.json.user.roles.join(',') === 'client', forgedRegister.json.user);
  const impostor = db.one(
    'SELECT id, no_show_count, is_blocked FROM users WHERE email = ?', ['impostor@example.com']);
  check('посторонние поля регистрации в базу не попали',
    impostor.no_show_count === 0 && impostor.is_blocked === 0, impostor);
  check('в user_roles у него только client',
    db.all('SELECT role FROM user_roles WHERE user_id = ?', [impostor.id])
      .map((r) => r.role).join(',') === 'client');

  console.log('\n— Ограничение частоты входа —');
  const { authLimit } = require('../src/routes/auth');
  const maxAttempts = Number(process.env.AUTH_RATE_MAX_ATTEMPTS);

  authLimit.reset();
  let limited = null;
  for (let i = 0; i <= maxAttempts && limited === null; i += 1) {
    const r = await call('POST', '/api/auth/login',
      { body: { email: 'nobody@example.com', password: 'WrongPass123' } });
    if (r.status === 429) limited = { attempt: i + 1, json: r.json };
  }
  check(`перебор пароля упирается в лимит (${maxAttempts} попыток)`,
    limited !== null && limited.attempt === maxAttempts + 1, limited);
  check('429 говорит, сколько ждать, и больше ничего',
    limited !== null && limited.json.error.code === 'too_many_requests'
    && Number.isInteger(limited.json.error.details.retry_after_sec),
    limited && limited.json);
  check('под лимитом не проходит и верный пароль — счёт идёт по адресу',
    (await call('POST', '/api/auth/login',
      { body: { email: 'client@lada.local', password: 'Lada12345' } })).status === 429);
  check('регистрация упирается в тот же лимит',
    (await call('POST', '/api/auth/register', {
      body: {
        name: 'Поздний', email: 'late@example.com', phone: '+79990000888',
        password: 'Lada12345', password_confirm: 'Lada12345', consent: true,
      },
    })).status === 429);

  authLimit.reset();
  check('после сброса окна вход снова работает',
    (await call('POST', '/api/auth/login',
      { body: { email: 'client@lada.local', password: 'Lada12345' } })).status === 200);

  // Удачный вход лимит не расходует: перебор — это неудачные попытки.
  authLimit.reset();
  for (let i = 0; i < maxAttempts + 5; i += 1) {
    await call('POST', '/api/auth/login',
      { body: { email: 'client@lada.local', password: 'Lada12345' } });
  }
  check('удачные входы лимит не тратят',
    (await call('POST', '/api/auth/login',
      { body: { email: 'client@lada.local', password: 'Lada12345' } })).status === 200);
  authLimit.reset();

  console.log('\n— Ошибки без внутренних подробностей —');
  const INTERNALS = /SQLITE|no such column|no such table|syntax error|ERR_SQLITE|[A-Za-z]:\\|\/home\/|node_modules|at Object\./i;
  const leakProbes = [
    ['GET', "/api/appointments/' OR 1=1--", clientToken],
    ['GET', "/api/admin/clients?q=');DROP TABLE users;--", adminToken],
    ['GET', '/api/masters/1/availability?date=not-a-date&service_ids=1', null],
    ['GET', '/api/masters/abc/availability?date=2027-01-01&service_ids=1', null],
    ['POST', '/api/appointments', clientToken],
  ];
  let leaked = null;
  for (const [method, url, token] of leakProbes) {
    const opts = {};
    if (token) opts.token = token;
    if (method !== 'GET') opts.body = {};
    const r = await call(method, encodeURI(url), opts);
    const text = JSON.stringify(r.json || {});
    if (INTERNALS.test(text)) leaked = { url, text };
  }
  check('ни текста ошибок БД, ни путей к файлам в ответах', leaked === null, leaked);
  check('таблица users цела после попытки инъекции',
    db.one('SELECT COUNT(*) AS n FROM users').n > 0);
  check('параметр запроса не исполняется как SQL: поиск просто ничего не нашёл',
    (await call('GET', `/api/admin/clients?q=${encodeURIComponent("');DROP TABLE users;--")}`,
      { token: adminToken })).json.total === 0);

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

  console.log('\n— Отмена: один путь на весь API —');
  // Свой клиент на этот раздел: у остальных лимит активных записей уже выбран.
  const cancelClient = await call('POST', '/api/admin/clients', {
    token: adminToken,
    body: { name: 'Ольга Тестова', email: 'olga.cancel@example.com', phone: '+7 999 777-00-11', consent: true },
  });
  check('клиент для проверки отмены создан -> 201', cancelClient.status === 201, cancelClient.json);
  const cancelClientId = cancelClient.json.client.id;

  // Отмена через админскую смену статуса своего UPDATE не имеет: она уходит в
  // ту же функцию, которой отменяет клиент. Проверяем, что результат совпадает
  // до колонок, а не только по коду ответа.
  const viaStatusSlot = await findFreeSlot();
  const viaStatus = await bookFor(adminToken, {
    starts_at: viaStatusSlot.at_utc, client_user_id: cancelClientId,
  });
  check('запись для отмены через смену статуса -> 201', viaStatus.status === 201, viaStatus.json);
  const viaStatusId = viaStatus.json.appointment.id;

  const adminCancel = await call('POST', `/api/admin/appointments/${viaStatusId}/status`, {
    token: adminToken, body: { status: 'cancelled_by_studio', cancel_reason: 'Студия закрыта' },
  });
  check('администратор отменяет сменой статуса -> 200',
    adminCancel.status === 200 && adminCancel.json.status === 'cancelled_by_studio',
    adminCancel.json);
  const cancelledRow = db.one(
    'SELECT status, cancel_reason, cancelled_at_utc FROM appointments WHERE id = ?',
    [viaStatusId],
  );
  check('смена статуса заполнила те же колонки, что и обычная отмена',
    cancelledRow.status === 'cancelled_by_studio'
    && cancelledRow.cancel_reason === 'Студия закрыта'
    && typeof cancelledRow.cancelled_at_utc === 'string', cancelledRow);
  check('после отмены время снова свободно и для админского пути',
    (await call('GET', `/api/masters/${master.id}/availability`
      + `?date=${viaStatusSlot.at_utc.slice(0, 10)}&service_ids=${manicure.id}`))
      .json.slots.some((s) => s.at_utc === viaStatusSlot.at_utc));

  const adminCancelTwice = await call('POST', `/api/admin/appointments/${viaStatusId}/status`, {
    token: adminToken, body: { status: 'cancelled_by_studio' },
  });
  check('повторная отмена сменой статуса -> 409', adminCancelTwice.status === 409,
    adminCancelTwice.json);

  // Визит, оформленный на самого администратора: в разделе студии он отменяет
  // его как студия, а не как владелец записи, и окно отмены к нему не применяется.
  const ownSlot = await findFreeSlot();
  const adminOwn = await bookFor(adminToken, { starts_at: ownSlot.at_utc, consent: true });
  check('администратор записывает себя -> 201', adminOwn.status === 201, adminOwn.json);
  const adminOwnCancel = await call('POST',
    `/api/admin/appointments/${adminOwn.json.appointment.id}/status`,
    { token: adminToken, body: { status: 'cancelled_by_studio' } });
  check('свой визит админ отменяет от имени студии',
    adminOwnCancel.status === 200
    && db.one('SELECT status FROM appointments WHERE id = ?',
      [adminOwn.json.appointment.id]).status === 'cancelled_by_studio', adminOwnCancel.json);

  // Статус, отмену не оформляющий, колонки отмены не трогает.
  const keepSlot = await findFreeSlot();
  const keepBooking = await bookFor(adminToken,
    { starts_at: keepSlot.at_utc, client_user_id: cancelClientId });
  const confirmKept = await call('POST',
    `/api/admin/appointments/${keepBooking.json.appointment.id}/status`,
    { token: adminToken, body: { status: 'confirmed', cancel_reason: 'не относится' } });
  const keptRow = db.one(
    'SELECT status, cancel_reason, cancelled_at_utc FROM appointments WHERE id = ?',
    [keepBooking.json.appointment.id],
  );
  check('подтверждение не заполняет колонки отмены',
    confirmKept.status === 200 && keptRow.status === 'confirmed'
    && keptRow.cancel_reason === null && keptRow.cancelled_at_utc === null, keptRow);

  // Несуществующая запись — это 404 на всех трёх операциях, а не 500:
  // подсказки к 409 строятся по записи, которой может не быть вовсе.
  const missingReschedule = await call('POST', '/api/appointments/999999/reschedule',
    { token: clientToken, body: { starts_at: second.at_utc } });
  check('перенос несуществующей записи -> 404', missingReschedule.status === 404,
    missingReschedule.json);
  const missingCancel = await call('POST', '/api/appointments/999999/cancel',
    { token: clientToken, body: {} });
  check('отмена несуществующей записи -> 404', missingCancel.status === 404, missingCancel.json);
  const missingStatus = await call('POST', '/api/admin/appointments/999999/status',
    { token: adminToken, body: { status: 'cancelled_by_studio' } });
  check('отмена несуществующей записи администратором -> 404',
    missingStatus.status === 404, missingStatus.json);

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
