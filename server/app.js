'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const P = require('./policy');
const { AppError } = require('./errors');
const { createEventHub } = require('./lib/events');
const { createHumanGate } = require('./lib/humanGate');
const { createSealer, createSigner } = require('./lib/crypto');
const { createServices } = require('./services');
const { createAuth } = require('./middleware/auth');
const { createHumanCheck } = require('./middleware/human');
const { createSameOriginGuard, createLimiters, createAudit } = require('./middleware/security');
const { authRoutes } = require('./routes/auth');
const { publicRoutes } = require('./routes/public');
const { bookingRoutes } = require('./routes/bookings');
const { adminRoutes } = require('./routes/admin');

const ROOT = path.resolve(__dirname, '..');
const GSI = 'https://accounts.google.com/gsi/';

function securityHeaders(isProd, supabaseUrl) {
  const supaOrigin = supabaseUrl ? new URL(supabaseUrl).origin : null;
  const connectSources = ["'self'", GSI];
  if (supaOrigin) {
    connectSources.push(supaOrigin);
  } else {
    connectSources.push('https://*.supabase.co');
  }

  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'", `${GSI}client`, 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', `${GSI}style`],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
        connectSrc: connectSources,
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        frameSrc: [GSI],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
    // Prevent clickjacking by denying any iframing of the app
    xFrameOptions: { action: 'deny' },
    // Prevent MIME-sniffing
    xContentTypeOptions: true,
    // Privacy-preserving referrer policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Google Identity Services opens a popup that must be able to post back.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    strictTransportSecurity: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
}

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, data: null, error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ success: false, data: null, error: { code: 'BAD_REQUEST', message: 'Malformed request body.' } });
  }
  // Postgres 23505 unique violation or partial unique index ux_bookings_seat
  if (
    err?.code === '23505' ||
    String(err?.message).includes('ux_bookings_seat') ||
    String(err?.message).includes('UNIQUE constraint failed: bookings') ||
    String(err?.detail).includes('ux_bookings_seat')
  ) {
    return res.status(409).json({ success: false, data: null, error: { code: 'SLOT_TAKEN', message: 'That seat was just taken — please try again.' } });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ success: false, data: null, error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
}

function createApp({ db, config }) {
  const app = express();
  const secure = config.IS_PROD;
  const events = createEventHub();
  const services = createServices({ db, events });
  const auth = createAuth({ db, secure });
  const gate = createHumanGate({
    signer: createSigner(config.APP_SECRET),
    passTtlMs: P.HUMAN_PASS_TTL_MS,
    challengeTtlMs: P.CHALLENGE_TTL_MS,
    minHoldMs: P.CHALLENGE_MIN_HOLD_MS,
  });
  const requireHuman = createHumanCheck({ db, gate, secure, passTtlMs: P.HUMAN_PASS_TTL_MS });
  const limiters = createLimiters();
  const audit = createAudit(db);

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);
  app.use(securityHeaders(config.IS_PROD, config.SUPABASE_URL));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=(), fullscreen=(self)');
    next();
  });

  const api = express.Router();
  api.use(limiters.api);
  api.use(express.json({ limit: '48kb' }));
  api.use(createSameOriginGuard(config.PUBLIC_ORIGIN));
  api.use(auth.loadSession);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/auth', authRoutes({
    db,
    auth,
    requireHuman,
    limiters,
    audit,
    sealer: createSealer(config.APP_SECRET),
    googleClientId: config.GOOGLE_CLIENT_ID,
    isTest: Boolean(config.APP_SECRET && config.APP_SECRET.startsWith('test-secret-')),
    isProd: config.IS_PROD,
    demoMode: config.DEMO_MODE,
  }));
  api.use('/admin', adminRoutes({ db, services, auth, audit }));
  api.use(publicRoutes({
    services,
    events,
    googleClientId: config.GOOGLE_CLIENT_ID,
    supabaseUrl: config.SUPABASE_URL,
    supabaseAnonKey: config.SUPABASE_ANON_KEY,
    demoMode: config.DEMO_MODE,
  }));
  api.use(bookingRoutes({ services, auth, requireHuman, limiters, audit }));
  api.use((_req, res) => res.status(404).json({ success: false, data: null, error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }));
  app.use('/api', api);

  app.use('/vendor/lenis', express.static(path.join(ROOT, 'node_modules', 'lenis', 'dist'), { maxAge: '7d' }));
  app.get('/shared/botScore.js', (_req, res) => res.sendFile(path.join(__dirname, 'lib', 'botScore.js')));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: config.IS_PROD ? '1h' : 0 }));
  app.use((_req, res) => res.status(404).sendFile(path.join(ROOT, 'public', '404.html')));
  app.use(errorHandler);

  return { app, services, events, auth };
}

module.exports = { createApp };
