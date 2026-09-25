'use strict';

const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { seedOrganisations, ensureSystemUser, ensureAdmin } = require('../server/seed');

let cachedApp = null;
let initPromise = null;

async function getApp() {
  if (cachedApp) return cachedApp;
  if (!initPromise) {
    initPromise = (async () => {
      const db = await openDb(config);
      try {
        await seedOrganisations(db);
        await ensureSystemUser(db);
        await ensureAdmin(db, {
          email: config.ADMIN_EMAIL,
          password: config.ADMIN_PASSWORD,
          isProd: config.IS_PROD,
        });
      } catch (err) {
        console.warn('[serverless init] Seed warning:', err.message);
      }
      const { app } = createApp({ db, config });
      cachedApp = app;
      return app;
    })();
  }
  return initPromise;
}

module.exports = async function handler(req, res) {
  try {
    const app = await getApp();

    // In Vercel serverless functions:
    // req.url might be '/api/config', '/config', or have req.query.path
    if (req.query && req.query.path) {
      const subpath = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
      const queryIdx = req.url.indexOf('?');
      const search = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
      req.url = `/api/${subpath}${search}`;
    } else if (req.headers['x-matched-path'] && req.headers['x-matched-path'].startsWith('/api')) {
      const queryIdx = req.url.indexOf('?');
      const search = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
      req.url = req.headers['x-matched-path'] + search;
    } else if (!req.url.startsWith('/api')) {
      req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }

    return app(req, res);
  } catch (err) {
    console.error('[serverless handler error]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      data: null,
      error: { code: 'SERVERLESS_ERROR', message: err.message || 'Internal server error.' },
    }));
  }
};
