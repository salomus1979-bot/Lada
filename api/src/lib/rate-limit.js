'use strict';

/**
 * Ограничение частоты запросов. Нужно на входе и регистрации: без него пароль
 * к известному e-mail подбирается запросами, а регистрация позволяет завести
 * сколько угодно аккаунтов подряд.
 *
 * Счётчики живут в памяти процесса. Это сознательный предел: внешних сервисов
 * в проекте нет ни одного, а Redis ради одного счётчика тянуть не стали. Для
 * одного процесса этого достаточно; если сервис когда-нибудь запустят в
 * несколько процессов, лимит станет «на процесс» — тогда счётчик надо будет
 * вынести в общее хранилище, и это единственное место, которое придётся
 * переписать.
 *
 * Окно скользящее: держим отметки времени попыток и выбрасываем те, что
 * старше окна. Это честнее фиксированных интервалов, где на стыке двух окон
 * проходит двойная порция запросов.
 */

const { tooManyRequests } = require('./errors');

/**
 * Адрес источника. `req.ip` у Express за прокси вернёт адрес прокси, поэтому
 * заголовкам вроде X-Forwarded-For здесь НЕ доверяем: их подделывает кто
 * угодно, и ограничение обошлось бы одной лишней строкой в запросе. Пока
 * сервис работает без прокси, socket.remoteAddress — единственный источник,
 * которому можно верить.
 */
function clientKey(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * @param {object} opts
 *   windowMin    — ширина окна в минутах
 *   maxAttempts  — сколько запросов за окно разрешено
 *   name         — имя лимита, попадает в сообщение об ошибке
 */
function rateLimit({ windowMin, maxAttempts, name = 'запросов' }) {
  const windowMs = windowMin * 60_000;
  const hits = new Map();

  // Чтобы карта не росла от разовых посетителей, раз в окно выбрасываем всё
  // протухшее целиком. unref, чтобы таймер не держал процесс живым.
  const sweeper = setInterval(() => {
    const edge = Date.now() - windowMs;
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((t) => t > edge);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }, windowMs);
  sweeper.unref();

  const middleware = (req, _res, next) => {
    const key = clientKey(req);
    const now = Date.now();
    const edge = now - windowMs;

    const stamps = (hits.get(key) || []).filter((t) => t > edge);

    if (stamps.length >= maxAttempts) {
      // Сколько ждать до освобождения самой старой попытки.
      const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
      hits.set(key, stamps);
      return next(tooManyRequests(
        `Слишком много попыток ${name}. Повторите через ${Math.ceil(retryAfterSec / 60)} мин.`,
        { retry_after_sec: retryAfterSec },
      ));
    }

    stamps.push(now);
    hits.set(key, stamps);
    next();
  };

  // Удачный вход не должен расходовать лимит на будущие попытки соседа по
  // адресу: роут вызывает это, когда запрос оказался законным.
  middleware.forget = (req) => {
    const key = clientKey(req);
    const stamps = hits.get(key);
    if (!stamps) return;
    stamps.pop();
    if (stamps.length === 0) hits.delete(key);
  };

  middleware.reset = () => hits.clear();

  return middleware;
}

module.exports = { rateLimit };
