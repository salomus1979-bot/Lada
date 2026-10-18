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

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
