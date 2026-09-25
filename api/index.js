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

    // Normalize URL path for Express routing
    // When rewritten in Vercel, req.url may be '/config', '/api/config', or '/api/index.js'
    const matchedPath = req.headers['x-matched-path'];
    if (matchedPath && matchedPath.startsWith('/api')) {
      const queryIdx = req.url.indexOf('?');
      req.url = matchedPath + (queryIdx !== -1 ? req.url.slice(queryIdx) : '');
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
