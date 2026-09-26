'use strict';

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const errors = Object.freeze({
  badRequest: (msg, extra) => new AppError(400, 'BAD_REQUEST', msg, extra),
  unauthorized: (msg = 'Please sign in to continue.', code = 'UNAUTHORIZED') => new AppError(401, code, msg),
  forbidden: (msg = 'You do not have access to this.', code = 'FORBIDDEN') => new AppError(403, code, msg),
  notFound: (msg = 'Not found.') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg, code = 'CONFLICT') => new AppError(409, code, msg),
  unprocessable: (msg, code = 'UNPROCESSABLE') => new AppError(422, code, msg),
  tooManyRequests: (msg = 'Too many requests.', code = 'RATE_LIMITED') => new AppError(429, code, msg),
});

module.exports = { AppError, errors };
