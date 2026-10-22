'use strict';

/**
 * Dev-сервер тестового фронтенда.
 *
 * Отдаёт статику из web/public и проксирует /api на API.
 * Прокси нужен, а не прямые запросы на порт API: сессия живёт в HttpOnly-cookie
 * с SameSite=Lax, а CORS в API нет — с другого порта браузер не отдал бы
 * cookie и не дал бы прочитать ответ. С одного origin всё работает как есть,
 * и API менять не требуется.
 *
 * Запуск:
 *   node web/server.js                  порт API ищется сам
 *   node web/server.js --api-port 3002  порт API задан явно
 *   node web/server.js --port 4100      свой порт фронтенда
 *
 * Переменные WEB_PORT, API_PORT и API_HOST тоже работают, но в PowerShell
 * запись `API_PORT=3002 node ...` не действует — там это пишется как
 * `$env:API_PORT=3002`. Поэтому основной способ — аргументы: они одинаковы
 * в любой оболочке.
 */

const http = require('node:http');
const path = require('node:path');
const express = require('express');

/** Аргументы вида `--api-port 3002` и `--api-port=3002`. */
function argValue(name) {
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const arg = args[index];
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1];
  return value === undefined || value === '' ? undefined : value;
}

const PORT = Number(argValue('port') || process.env.WEB_PORT || 4000);
const API_HOST = argValue('api-host') || process.env.API_HOST || '127.0.0.1';
const API_PORT_GIVEN = argValue('api-port') || process.env.API_PORT;

// Порт API: заданный или найденный при старте. Меняется только в resolveApiPort.
let apiPort = Number(API_PORT_GIVEN || 3001);

const app = express();

// Тело запроса не разбираем — поток уходит в API как есть.
app.use('/api', (req, res) => {
  const headers = { ...req.headers, host: `${API_HOST}:${apiPort}` };
  delete headers.connection;

  const upstream = http.request(
    { host: API_HOST, port: apiPort, method: req.method, path: `/api${req.url}`, headers },
    (apiRes) => {
      res.writeHead(apiRes.statusCode, apiRes.headers);
      apiRes.pipe(res);
    },
  );

  // Упавший или не запущенный API — это понятная ошибка на странице,
  // а не висящий запрос.
  upstream.on('error', (err) => {
    res.status(502).type('application/json').end(JSON.stringify({
      error: {
        code: 'api_unreachable',
        message: `API на ${API_HOST}:${apiPort} не отвечает (${err.code || err.message}). `
          + 'Запустите его: npm start',
      },
    }));
  });

  req.pipe(upstream);
});

/* ─────────────────────────── доступ в /admin ───────────────────────────── */

/**
 * ПРОВЕРКА ПРАВ НА СТРАНИЦЫ РАЗДЕЛА АДМИНИСТРАТОРА.
 *
 * Второй рубеж после API: `/api/admin/*` закрыт в самом API
 * (`router.use(requireRole('admin','owner'))` в начале api/src/routes/admin.js,
 * ответ — 403). Но страницы отдаёт этот сервер, и статика сама по себе никого
 * не спрашивает: без проверки разметку `/admin` получил бы любой. Поэтому
 * доступ закрыт здесь, а не только в интерфейсе — скрытый пункт меню в
 * кабинете защитой не является.
 *
 * ПОЧЕМУ СТРАНИЦЫ РАЗДЕЛА ЛЕЖАТ ОТДЕЛЬНО, В `web/pages-admin`.
 *
 * Сначала они лежали в `web/pages/admin`, то есть внутри статики, а доступ
 * закрывала одна middleware, которая смотрела на адрес: `/^\/admin(\/|$)/`.
 * Это оказалось дырой. Сравнение строки и поиск файла — разные вещи:
 * `express.static` декодирует `%XX`, схлопывает `//` и `/./`, а файловая
 * система Windows вдобавок не различает регистр. Поэтому мимо проверки
 * проходили и отдавались анониму `/ADMIN/appointments`,
 * `//admin/appointments`, `/./admin/appointments`, `/%61dmin/appointments`
 * и `/admin%2Fappointments`.
 *
 * Чинить это добавлением вариантов в регулярное выражение бессмысленно:
 * список обходов не закончится, пока проверка угадывает чужую нормализацию.
 * Поэтому страницы вынесены из каталога статики вовсе. Теперь к ним ведёт
 * ровно один путь — именованный роут ниже, и он под проверкой. Чего нет в
 * статике, того не отдать никаким написанием адреса: любой обход упирается
 * в 404, а не в страницу.
 *
 * Кто пришёл, сервер узнаёт у API: `GET /api/auth/me` с cookie запроса. Своей
 * проверки сессии у фронтенда нет и быть не должно — он не знает ни токенов,
 * ни ролей, и выдумывать вторую реализацию прав значило бы развести их с API.
 *
 * Роли приходят СПИСКОМ (`user.roles`), и проверка — вхождение в список, а не
 * равенство: у одного человека их может быть несколько.
 *
 * То же правило для страниц живёт в web/js/roles.js — это браузерный модуль,
 * и импортировать его сюда нельзя. Копия намеренная: она решает, что
 * показать, а что отдать — решает проверка ниже.
 */
const ADMIN_PATH = /^\/admin(\/|$)/;
const ADMIN_ROLES = ['admin', 'owner'];
const FORBIDDEN_PAGE = path.join(__dirname, 'pages', 'admin-forbidden.html');

/** Каталог страниц раздела. Статикой он не отдаётся — только роутом ниже. */
const ADMIN_DIR = path.join(__dirname, 'pages-admin');

/**
 * Страницы раздела: адрес → файл. Это белый список, а не склейка пути из
 * запроса, поэтому ни `..`, ни любое другое написание не выведет за каталог.
 */
const ADMIN_PAGES = new Map([
  ['appointments', 'appointments.html'],
  ['services', 'services.html'],
  ['masters', 'masters.html'],
]);

/** Есть ли у пользователя роль администратора. */
function hasAdminRole(user) {
  return !!user && Array.isArray(user.roles)
    && ADMIN_ROLES.some((role) => user.roles.includes(role));
}

/**
 * Спрашивает у API, кто пришёл.
 *
 * @returns {Promise<{status: number, user: object|null}>} `status` 200 с
 *   профилем, 401 без сессии, либо 0 — API не ответил вовсе.
 */
function whoAmI(req) {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: API_HOST,
        port: apiPort,
        method: 'GET',
        path: '/api/auth/me',
        // Пробрасывается только cookie: ответ зависит от сессии, и никакие
        // другие заголовки запроса на права не влияют.
        headers: { Accept: 'application/json', ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) },
        timeout: 2000,
      },
      (apiRes) => {
        let body = '';
        apiRes.on('data', (chunk) => { body += chunk; });
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ status: apiRes.statusCode, user: parsed.user || null });
          } catch {
            resolve({ status: apiRes.statusCode, user: null });
          }
        });
      },
    );
    upstream.on('timeout', () => { upstream.destroy(); resolve({ status: 0, user: null }); });
    upstream.on('error', () => resolve({ status: 0, user: null }));
    upstream.end();
  });
}

/**
 * Проверка входа и роли. Обе — здесь, одна за другой: сначала «вошёл ли»
 * (нет сессии → форма входа), потом «та ли роль» (нет роли → 403).
 *
 * Вызывается дважды: широкой сетью на всё, что похоже на `/admin`, и ещё раз
 * самим роутом страниц. Второй вызов — не перестраховка ради красоты:
 * именно он и есть проверка на маршруте, а сеть лишь ловит остальные адреса
 * раздела. Повторный запрос к API при этом не уходит — отметка `adminChecked`
 * ниже.
 */
async function guardAdmin(req, res, next) {
  if (req.adminChecked) return next();

  const { status, user } = await whoAmI(req);

  // API не ответил — пускать нельзя: прав мы не знаем. Молча отдавать 403
  // тоже неправильно, человек решил бы, что дело в роли.
  if (status === 0) {
    res.status(502).type('text/plain; charset=utf-8').end(
      `Права проверить не удалось: API на ${API_HOST}:${apiPort} не отвечает. `
      + 'Запустите его: npm start',
    );
    return;
  }

  // ПРОВЕРКА ВХОДА. Не вошёл — на форму входа. Она одна на всех: после входа
  // сервис смотрит роли и сам возвращает администратора в /admin
  // (web/js/login.js).
  if (status === 401 || !user) {
    res.redirect(302, '/login.html');
    return;
  }

  // ПРОВЕРКА РОЛИ. Вошёл, но роли нет — 403 и страница с сообщением.
  if (!hasAdminRole(user)) {
    res.status(403).sendFile(FORBIDDEN_PAGE);
    return;
  }

  req.adminChecked = true;
  next();
}

// Широкая сеть: всё, что похоже на адрес раздела, проходит проверку — даже
// то, для чего страницы нет. Так `/admin/что-угодно` отвечает 403, а не 404,
// и по ответу нельзя перебирать состав раздела.
app.use((req, res, next) => (
  ADMIN_PATH.test(req.path) ? guardAdmin(req, res, next) : next()
));

/** Корень раздела: первый пункт меню. */
app.get(['/admin', '/admin/'], guardAdmin, (_req, res) => res.redirect(302, '/admin/appointments'));

/**
 * Страницы раздела — единственный способ их получить.
 *
 * Роуты Express нечувствительны к регистру, поэтому `/ADMIN/Appointments`
 * попадает сюда же, а не в статику. Написания, до роута не дошедшие
 * (`//admin/…`, `/%61dmin/…`, `/admin%2F…`), упираются в 404: файлов этого
 * раздела в статике нет вовсе.
 */
app.get('/admin/:page', guardAdmin, (req, res, next) => {
  // `.html` в адресе допускается, но ищется всё равно по белому списку.
  const key = String(req.params.page).replace(/\.html$/i, '').toLowerCase();
  const file = ADMIN_PAGES.get(key);
  if (!file) return next();
  res.sendFile(path.join(ADMIN_DIR, file));
});

// Вёрстка: экран прототипа — страница в web/pages (правило 2), общий слой
// запросов и стили — рядом, токены дизайн-системы отдаются из корня web.
app.use(express.static(path.join(__dirname, 'pages'), { extensions: ['html'] }));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.get('/tokens.css', (_req, res) => res.sendFile(path.join(__dirname, 'tokens.css')));

// Черновой фронт из web/public — тот самый, которым проверяли API руками.
// От него остались только страница состояния API и админка: /draft/admin.html.
// Клиентские черновики удалены, их заменили экраны из web/pages.
app.use('/draft', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/** Отвечает ли на этом порту именно API «Лады». */
function isLadaApi(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: API_HOST, port, path: '/api/health', method: 'GET', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).ok === true);
          } catch {
            resolve(false); // не JSON — значит, на порту кто-то чужой
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Ищет порт API. Порт 3001 бывает занят посторонним сервисом — тогда API
 * поднимается на соседнем, и прокси молча стучался бы не туда. Поэтому
 * проверяем, кто отвечает, и перебираем соседние порты.
 *
 * Явно заданный порт не подменяется: если человек назвал порт и там не API,
 * это его ошибка, и о ней надо сказать, а не угадывать за него.
 */
async function resolveApiPort() {
  if (await isLadaApi(apiPort)) {
    console.log(`[web] /api -> http://${API_HOST}:${apiPort}`);
    return;
  }

  if (API_PORT_GIVEN) {
    console.warn(`[web] ВНИМАНИЕ: на ${API_HOST}:${apiPort} API «Лады» не отвечает. `
      + 'Проверьте, запущен ли он (npm start) и верен ли порт.');
    return;
  }

  for (const candidate of [3002, 3003, 3004, 3005]) {
    if (await isLadaApi(candidate)) {
      apiPort = candidate;
      console.log(`[web] порт 3001 занят другим сервисом, API найден на ${candidate}`);
      console.log(`[web] /api -> http://${API_HOST}:${apiPort}`);
      return;
    }
  }

  console.warn('[web] ВНИМАНИЕ: API «Лады» не найден на портах 3001-3005. '
    + 'Запустите его (npm start) или укажите порт: node web/server.js --api-port <порт>');
}

const server = app.listen(PORT, () => {
  console.log(`[web] тестовый фронтенд: http://localhost:${PORT}`);
  resolveApiPort();
});

// Занятый порт — обычная ситуация (сервер уже запущен в другом окне),
// и отвечать на неё стектрейсом ни к чему.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[web] порт ${PORT} уже занят. Фронтенд, возможно, уже запущен: `
      + `откройте http://localhost:${PORT} — или возьмите другой порт: `
      + 'node web/server.js --port 4100');
    process.exit(1);
  }
  throw err;
});
