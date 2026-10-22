'use strict';

/* Общий слой для всех страниц: запросы к API, показ ошибок, навигация. */

/** Ошибка API: код, человеческий текст и details по полям. */
class ApiError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `Ошибка ${status}`);
    this.status = status;
    this.code = err.code || 'http_error';
    this.details = err.details;
  }

  /**
   * Текст для показа на странице: сообщение плюс разбор details по полям.
   * Отдельно разворачивается nearest_slots — это подсказка API при 409
   * «время занято», и без неё сообщение теряет половину смысла.
   */
  toText() {
    const lines = [`${this.status} ${this.code}: ${this.message}`];
    const details = this.details;
    if (details && typeof details === 'object') {
      for (const [field, value] of Object.entries(details)) {
        if (field === 'nearest_slots' && Array.isArray(value)) {
          const times = value.map((s) => `${s.local_date} ${s.local_time}`).join(', ');
          lines.push(`ближайшее свободное время: ${times || 'не нашлось'}`);
        } else if (value && typeof value === 'object') {
          lines.push(`${field}: ${JSON.stringify(value)}`);
        } else {
          lines.push(`${field}: ${value}`);
        }
      }
    }
    return lines.join('\n');
  }
}

/**
 * Запрос к API. Возвращает разобранный JSON, при ошибке бросает ApiError —
 * её текст страницы выводят в блок сообщений, а не только в консоль.
 */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, {
      error: { code: 'network_error', message: `Сеть недоступна: ${err.message}` },
    });
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, {
        error: { code: 'bad_response', message: `Ответ не JSON: ${text.slice(0, 200)}` },
      });
    }
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

/** Строка запроса: пустые значения не отправляются вовсе. */
function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, value);
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/* ----------------------------------------------------------- сообщения */

/** Блок сообщений страницы: ошибки API показываются текстом здесь. */
function msgBox(id) {
  const node = document.getElementById(id);
  const set = (kind, text) => {
    node.className = `msg ${kind}`;
    node.textContent = text;
  };
  return {
    node,
    clear: () => set('msg', ''),
    info: (text) => set('info', text),
    ok: (text) => set('ok', text),
    error: (text) => set('error', text),
    /** Любая ошибка — на страницу; у ApiError с разбором по полям. */
    fail(err) {
      set('error', err instanceof ApiError ? err.toText() : `Сбой страницы: ${err.message}`);
      console.error(err);
    },
  };
}

/** Обёртка обработчиков: ошибка не теряется, а уходит в блок сообщений. */
const guard = (box, fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    box.fail(err);
  }
};

/* ------------------------------------------------------------ разметка */

/** Элемент с атрибутами и детьми: ручной DOM вместо вставки HTML строками. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else node[key] = value;
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Таблица из массива объектов: columns = [[заголовок, (row) => ячейка], ...]. */
function table(columns, rows) {
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, columns.map(([title]) => el('th', { textContent: title })))),
    el('tbody', {}, rows.map((row) => el('tr', {}, columns.map(([, cell]) => {
      const value = cell(row);
      if (value instanceof Node) return el('td', {}, value);
      return el('td', {
        textContent: value === null || value === undefined || value === '' ? '—' : String(value),
      });
    })))),
  );
}

/** Моменты API приходят объектом { at_utc, local_date, local_time, timezone }. */
const whenText = (instant) => (instant
  ? `${instant.local_date} ${instant.local_time}`
  : '—');

/** Значения формы объектом. Чекбоксы с data-multi собираются в массив. */
function formValues(form) {
  const out = {};
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox' && field.dataset.multi !== undefined) {
      if (!Array.isArray(out[field.name])) out[field.name] = [];
      if (field.checked) out[field.name].push(field.value);
    } else if (field.type === 'checkbox') {
      out[field.name] = field.checked;
    } else {
      out[field.name] = field.value;
    }
  }
  return out;
}

/** Пустое необязательное поле — это «не присылать», а не пустая строка. */
const optional = (value) => (value === '' || value === undefined || value === null ? undefined : value);
const intOrUndef = (value) => (optional(value) === undefined ? undefined : Number(value));

/** Значение <input type="datetime-local"> в UTC-метку, которую ждёт API. */
const localInputToUtc = (value) => (value
  ? new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
  : undefined);

/** Сегодняшняя дата в формате YYYY-MM-DD по часам браузера. */
function todayInputValue() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ----------------------------------------------------------- навигация */

// Клиентские черновики удалены — их заменили свёрстанные экраны в web/pages,
// и ссылки на них вели бы в 404. Остались страница состояния API и админка.
const PAGES = [
  ['index.html', 'Главная'],
  ['admin.html', 'Администрирование'],
];

/**
 * Шапка со ссылками и текущим пользователем.
 * Профиль читается через /api/auth/me: 401 здесь — обычное состояние
 * «не вошёл», а не ошибка страницы.
 */
async function renderNav() {
  const nav = el('nav');
  const here = location.pathname.split('/').pop() || 'index.html';
  for (const [href, title] of PAGES) {
    nav.append(href === here
      ? el('strong', { textContent: title })
      : el('a', { href, textContent: title }));
  }
  const who = el('span', { className: 'who', textContent: 'профиль…' });
  nav.append(who);
  document.body.prepend(nav);

  try {
    const { user } = await api('GET', '/auth/me');
    who.textContent = `${user.name} · ${user.email} · роли: ${user.roles.join(', ') || '—'} · `;
    const out = el('a', { href: '#', textContent: 'выйти' });
    out.onclick = async (event) => {
      event.preventDefault();
      try {
        await api('POST', '/auth/logout');
      } finally {
        location.reload();
      }
    };
    who.append(out);
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      who.textContent = 'не вошли · ';
      // Своей формы входа у черновика больше нет — ведём на настоящий экран.
      who.append(el('a', { href: '/login.html', textContent: 'войти' }));
      return null;
    }
    who.textContent = `профиль недоступен: ${err.message}`;
    return null;
  }
}
