'use strict';

// Валидация входных данных. Вызывается ДО любого обращения к базе:
// каждый роут сначала собирает проблемы в Validator, и только потом читает БД.

const { badRequest } = require('./errors');
const { parseUtcIso, isValidDate, isValidTimeZone } = require('./time');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

class Validator {
  constructor(source) {
    this.src = source && typeof source === 'object' ? source : {};
    this.errors = {};
    this.out = {};
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return undefined;
  }

  /** Бросает 400 со списком полей, если что-то не прошло. */
  done() {
    if (Object.keys(this.errors).length > 0) {
      throw badRequest('Неверные входные данные', this.errors);
    }
    return this.out;
  }

  #present(field, required) {
    const raw = this.src[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, 'обязательное поле');
      return { missing: true };
    }
    return { raw };
  }

  string(field, { required = true, min = 1, max = 500, trim = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (typeof raw !== 'string') return this.fail(field, 'ожидается строка'), this;
    const value = trim ? raw.trim() : raw;
    if (value.length < min) return this.fail(field, `минимум ${min} символов`), this;
    if (value.length > max) return this.fail(field, `максимум ${max} символов`), this;
    this.out[field] = value;
    return this;
  }

  email(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (typeof raw !== 'string') return this.fail(field, 'ожидается строка'), this;
    const value = raw.trim().toLowerCase();
    if (value.length > 254 || !EMAIL_RE.test(value)) return this.fail(field, 'неверный e-mail'), this;
    this.out[field] = value;
    return this;
  }

  /** Телефон приводим к `+7XXXXXXXXXX`: в базе должен лежать один формат. */
  phone(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (typeof raw !== 'string') return this.fail(field, 'ожидается строка'), this;
    const digits = raw.replace(/\D/g, '');
    let normalized = digits;
    if (digits.length === 11 && digits.startsWith('8')) normalized = `7${digits.slice(1)}`;
    if (normalized.length !== 11 || !normalized.startsWith('7')) {
      return this.fail(field, 'ожидается российский номер, например +7 999 123-45-67'), this;
    }
    this.out[field] = `+${normalized}`;
    return this;
  }

  /** Пароль: минимум 8 символов, буквы и цифры (требование страницы регистрации). */
  password(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (typeof raw !== 'string') return this.fail(field, 'ожидается строка'), this;
    if (raw.length < 8 || raw.length > 200) return this.fail(field, 'минимум 8 символов'), this;
    if (!/[a-zA-Zа-яА-Я]/.test(raw) || !/\d/.test(raw)) {
      return this.fail(field, 'пароль должен содержать буквы и цифры'), this;
    }
    this.out[field] = raw;
    return this;
  }

  int(field, { required = true, min = null, max = null } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isInteger(value)) return this.fail(field, 'ожидается целое число'), this;
    if (min !== null && value < min) return this.fail(field, `минимум ${min}`), this;
    if (max !== null && value > max) return this.fail(field, `максимум ${max}`), this;
    this.out[field] = value;
    return this;
  }

  /** Деньги — только целые копейки, без дробей. */
  kopecks(field, { required = true } = {}) {
    return this.int(field, { required, min: 0, max: 100_000_000 });
  }

  /** Минуты от полуночи в поясе салона. */
  minuteOfDay(field, { required = true } = {}) {
    return this.int(field, { required, min: 0, max: 1440 });
  }

  bool(field, { required = true, def = undefined } = {}) {
    const raw = this.src[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, 'обязательное поле');
      else if (def !== undefined) this.out[field] = def;
      return this;
    }
    if (typeof raw === 'boolean') this.out[field] = raw;
    else if (raw === 'true' || raw === 1 || raw === '1') this.out[field] = true;
    else if (raw === 'false' || raw === 0 || raw === '0') this.out[field] = false;
    else this.fail(field, 'ожидается true или false');
    return this;
  }

  enum(field, allowed, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (!allowed.includes(raw)) {
      return this.fail(field, `допустимые значения: ${allowed.join(', ')}`), this;
    }
    this.out[field] = raw;
    return this;
  }

  /** Момент времени: принимаем только UTC, явно с `Z`. */
  utcInstant(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    const parsed = parseUtcIso(raw);
    if (!parsed) {
      return this.fail(field, 'ожидается время в UTC, например 2026-10-23T11:00:00Z'), this;
    }
    this.out[field] = raw.replace(/\.\d{1,3}Z$/, 'Z');
    return this;
  }

  /** Календарная дата в поясе салона. */
  date(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (!isValidDate(raw)) return this.fail(field, 'ожидается дата YYYY-MM-DD'), this;
    this.out[field] = raw;
    return this;
  }

  timezone(field, { required = true } = {}) {
    const { missing, raw } = this.#present(field, required);
    if (missing) return this;
    if (typeof raw !== 'string' || !isValidTimeZone(raw)) {
      return this.fail(field, 'неизвестный часовой пояс'), this;
    }
    this.out[field] = raw;
    return this;
  }

  /** Массив уникальных положительных id. */
  idArray(field, { required = true, min = 1, max = 20 } = {}) {
    const raw = this.src[field];
    if (raw === undefined || raw === null) {
      if (required) this.fail(field, 'обязательное поле');
      return this;
    }
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    if (list.length < min) return this.fail(field, `нужно минимум ${min} значение`), this;
    if (list.length > max) return this.fail(field, `не больше ${max} значений`), this;
    const ids = [];
    for (const item of list) {
      const value = typeof item === 'number' ? item : Number(String(item).trim());
      if (!Number.isInteger(value) || value <= 0) {
        return this.fail(field, 'ожидается список целых id'), this;
      }
      ids.push(value);
    }
    if (new Set(ids).size !== ids.length) return this.fail(field, 'значения не должны повторяться'), this;
    this.out[field] = ids;
    return this;
  }
}

/** Валидация числового id из пути — всегда до запроса в базу. */
function requireIdParam(value, field = 'id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest('Неверный идентификатор', { [field]: 'ожидается целое положительное число' });
  }
  return parsed;
}

module.exports = { Validator, requireIdParam };
