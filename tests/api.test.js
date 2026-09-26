'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OTPAuth = require('otpauth');
const { openDb } = require('../server/db');
const { seedOrganisations } = require('../server/seed');
const { createApp } = require('../server/app');
const { humanTelemetry } = require('./helpers');

const HOSPITAL_GENERAL_MEDICINE = 9; // 24h org → walk-ins work at any time of day

const config = Object.freeze({
  IS_PROD: false,
  APP_SECRET: 'test-secret-'.repeat(4),
  GOOGLE_CLIENT_ID: '',
  TRUST_PROXY: false,
  PUBLIC_ORIGIN: '',
  DEMO_MODE: false,
});

let server;
let base;
let db;

test.before(async () => {
  db = await openDb(':memory:');
  await seedOrganisations(db);
  const { app } = createApp({ db, config });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
});

/** Minimal browser-like client with a cookie jar. */
function client() {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, body: await res.json() };
  };
}

async function registeredUser(email) {
  const call = client();
  const reg = await call('POST', '/api/auth/register', { name: 'Test User', email, password: 'a-long-passphrase-9', human: humanTelemetry(3) });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.data.next, 'totp_setup');
  const setup = await call('POST', '/api/auth/totp/setup', {});
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.data.secret), digits: 6, period: 30 });
  const code = totp.generate();
  const verify = await call('POST', '/api/auth/totp/verify', { code });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return { call, code };
}

test('public catalogue lists organisations with services', async () => {
  const { status, body } = await client()('GET', '/api/orgs');
  assert.equal(status, 200);
  assert.equal(body.data.orgs.length, 8);
  assert.ok(body.data.orgs.every((o) => o.services.length > 0));
});

test('registration without behavioural telemetry gets a human challenge', async () => {
  const { status, body } = await client()('POST', '/api/auth/register', { name: 'X', email: 'x@y.io', password: 'a-long-passphrase-9' });
  assert.equal(status, 428);
  assert.equal(body.error.code, 'HUMAN_CHALLENGE');
  assert.ok(body.error.challenge);
});

test('press-and-hold challenge passes only after real server-side time', async () => {
  const call = client();
  const first = await call('POST', '/api/auth/login', { email: 'nobody@y.io', password: 'whatever-123' });
  const token = first.body.error.challenge;
  const tooSoon = await call('POST', '/api/auth/login', { email: 'nobody@y.io', password: 'whatever-123', challenge: { token, holdMs: 1600 } });
  assert.equal(tooSoon.status, 428);
  const again = tooSoon.body.error.challenge;
  await new Promise((r) => setTimeout(r, 1600));
  const passed = await call('POST', '/api/auth/login', { email: 'nobody@y.io', password: 'whatever-123', challenge: { token: again, holdMs: 1600 } });
  assert.equal(passed.status, 401); // human check passed; credentials are simply wrong
  assert.equal(passed.body.error.code, 'BAD_CREDENTIALS');
});

test('automation-flagged browsers are blocked outright', async () => {
  const { status, body } = await client()('POST', '/api/auth/login', { email: 'a@b.io', password: 'x', human: { webdriver: true } });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'BOT_BLOCKED');
});

test('honeypot field blocks form-filling bots', async () => {
  const { status } = await client()('POST', '/api/auth/login', { email: 'a@b.io', password: 'x', website: 'spam', human: humanTelemetry(5) });
  assert.equal(status, 403);
});

test('full flow: register → authenticator → book walk-in → live position', async () => {
  const email = 'flow@y.io';
  const pending = client();
  await pending('POST', '/api/auth/register', { name: 'Flow', email, password: 'a-long-passphrase-9', human: humanTelemetry(4) });
  const blocked = await pending('GET', '/api/me/bookings');
  assert.equal(blocked.status, 401);
  assert.equal(blocked.body.error.code, 'MFA_REQUIRED');

  const { call, code } = await registeredUser('flow2@y.io');
  const replay = await call('POST', '/api/auth/totp/verify', { code });
  assert.equal(replay.status, 401, 'a TOTP code must not be accepted twice');

  const booked = await call('POST', '/api/bookings', { kind: 'walkin', serviceId: HOSPITAL_GENERAL_MEDICINE });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.match(booked.body.data.booking.tokenCode, /^M-\d{3}$/);

  const mine = await call('GET', '/api/me/bookings');
  assert.equal(mine.body.data.active.length, 1);
  assert.equal(typeof mine.body.data.active[0].etaMin, 'number');

  const notes = await call('GET', '/api/me/notifications');
  assert.equal(notes.body.data.notifications[0].type, 'booked');
});

test('reloading authenticator setup keeps the same secret', async () => {
  const call = client();
  await call('POST', '/api/auth/register', { name: 'Reload', email: 'reload@y.io', password: 'a-long-passphrase-9', human: humanTelemetry(6) });
  const first = await call('POST', '/api/auth/totp/setup', {});
  const second = await call('POST', '/api/auth/totp/setup', {});
  assert.equal(second.body.data.secret, first.body.data.secret);
});

test('staff can only manage their own organisation', async () => {
  const { call } = await registeredUser('staff@y.io');
  await db.run("UPDATE users SET role='staff', org_id=2 WHERE lower(email)='staff@y.io'");
  assert.equal((await call('GET', '/api/admin/orgs/2/overview')).status, 200);
  const other = await call('GET', '/api/admin/orgs/1/overview');
  assert.equal(other.status, 403);
  assert.equal((await call('POST', '/api/admin/orgs/1/auto-assign', {})).status, 403);
});

test('regular users cannot reach admin endpoints', async () => {
  const { call } = await registeredUser('plain@y.io');
  const res = await call('GET', '/api/admin/orgs/1/overview');
  assert.equal(res.status, 403);
});

test('cross-site and non-JSON writes are rejected', async () => {
  const call = client();
  const cross = await call('POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'CSRF');
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(res.status, 415);
});

test('security headers are present', async () => {
  const res = await fetch(`${base}/api/orgs`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(res.headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
});
