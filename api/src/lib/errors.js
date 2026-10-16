'use strict';

/**
 * Единая ошибка API. Все ответы — JSON вида
 * { "error": { "code": "...", "message": "...", "details": {...} } }
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return { error: body };
  }
}

/** 400 — неверные входные данные. */
const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
/** 401 — нет авторизации. */
const unauthorized = (message = 'Требуется авторизация') => new ApiError(401, 'unauthorized', message);
/** 403 — не хватает прав. */
const forbidden = (message = 'Недостаточно прав') => new ApiError(403, 'forbidden', message);
/** 404 — объекта нет (или он не принадлежит текущему пользователю). */
const notFound = (message = 'Не найдено') => new ApiError(404, 'not_found', message);
/** 409 — конфликт состояния: слот занят, e-mail занят, лимит исчерпан. */
const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
/** 429 — слишком часто: сработало ограничение частоты запросов. */
const tooManyRequests = (message, details) => new ApiError(429, 'too_many_requests', message, details);

module.exports = {
  ApiError, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests,
};
