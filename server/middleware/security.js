'use strict';

const { rateLimit } = require('express-rate-limit');
const { AppError, errors } = require('../errors');
const { stmt } = require('../db');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth (cookies are already SameSite=Strict):
 *  - state-changing requests must be JSON (HTML forms cannot send JSON cross-site
 *    without a CORS preflight, which we never grant);
 *  - Origin / Sec-Fetch-Site must be same-origin.
 */
function createSameOriginGuard(publicOrigin) {
  return function sameOriginGuard(req, _res, next) {
    if (!MUTATING.has(req.method)) return next();
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be JSON.');
    }
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        allowed = publicOrigin ? origin === publicOrigin : new URL(origin).host === req.headers.host;
      } catch {
        allowed = false;
      }
      if (!allowed) throw errors.forbidden('Cross-site request blocked.', 'CSRF');
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw errors.forbidden('Cross-site request blocked.', 'CSRF');
    }
    next();
  };
}

function limiter(windowMs, limit, message, keyGenerator) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) =>
      res.status(429).json({ success: false, data: null, error: { code: 'RATE_LIMITED', message } }),
  });
}

const byUser = (req) => `u:${req.auth?.user?.id ?? 'anon'}`;

function createLimiters() {
  return Object.freeze({
    api: limiter(60_000, 240, 'Too many requests. Please slow down.'),
    auth: limiter(15 * 60_000, 20, 'Too many sign-in attempts. Try again in 15 minutes.'),
    totp: limiter(5 * 60_000, 10, 'Too many code attempts. Wait 5 minutes and try again.'),
    booking: limiter(10 * 60_000, 20, 'Too many booking changes. Try again in a few minutes.', byUser),
    location: limiter(60_000, 12, 'Location updates are too frequent.', byUser),
  });
}

function createAudit(db) {
  return async function audit(req, action, detail = null, userId = req.auth?.user?.id ?? null) {
    try {
      await stmt(db, 'INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)').run(
        userId,
        action,
        detail === null ? null : String(detail).slice(0, 300),
        req.ip || null,
        Date.now(),
      );
    } catch (err) {
      console.error('[audit] failed to write audit log:', err.message);
    }
  };
}

module.exports = { createSameOriginGuard, createLimiters, createAudit };
