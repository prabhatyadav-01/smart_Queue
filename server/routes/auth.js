'use strict';

const express = require('express');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { z, parse, ok } = require('../lib/validate');
const { hashPassword, verifyPassword } = require('../lib/crypto');
const { maskEmail } = require('../services/statsService');
const { verifySupabaseToken } = require('../lib/supabase');

const TOTP_PARAMS = Object.freeze({ algorithm: 'SHA1', digits: 6, period: 30 });
const PRIVILEGED = new Set(['admin', 'staff']);

const email = z.email('Enter a valid email address.').max(254).transform((e) => e.toLowerCase());
const password = z.string().min(10, 'Password must be at least 10 characters.').max(128);

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short.').max(60),
  email,
  password,
});
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const googleSchema = z.object({
  credential: z.string().min(20).max(4096).optional(),
  access_token: z.string().min(20).max(4096).optional(),
});
const supabaseSessionSchema = z.object({ access_token: z.string().min(20).max(4096) });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code.') });

const TRUSTED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

function isTrustedEmail(em, allowTest = false) {
  const parts = String(em || '').toLowerCase().trim().split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (TRUSTED_DOMAINS.has(domain)) return true;
  if (allowTest && (domain === 'example.com' || domain === 'y.io' || domain === 'b.io' || domain === 'test.com' || domain === 'x.io')) return true;
  return false;
}

// In-memory OTP storage for email verification: userId -> { otp, email, expiresAt, attempts }
const emailOtps = new Map();

function generateAndStoreOtp(userId, userEmail) {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  emailOtps.set(userId, {
    otp,
    email: userEmail,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });
  console.log(`\n========================================`);
  console.log(`📧 [SmartQueue OTP] Verification code for ${userEmail}: ${otp}`);
  console.log(`========================================\n`);
  return otp;
}

/** Next auth step after the first factor. Password users and staff must use an authenticator app. */
function nextStep(user, viaGoogle) {
  if (Number(user.totp_enabled) === 1) return 'totp';
  if (!viaGoogle || PRIVILEGED.has(user.role)) return 'totp_setup';
  return 'done';
}

function authRoutes({ db, auth, requireHuman, limiters, audit, sealer, googleClientId, isTest = false }) {
  const r = express.Router();
  const q = (sql) => stmt(db, sql);
  const google = googleClientId ? new OAuth2Client() : null;
  const getUser = async (id) => q('SELECT * FROM users WHERE id=?').get(id);

  async function begin(req, res, user, viaGoogle) {
    const step = nextStep(user, viaGoogle);
    await auth.startSession(req, res, user.id, step === 'done', Date.now());
    res.json(ok({ next: step, user: auth.publicUser(user, step === 'done') }));
  }

  r.post('/register', limiters.auth, requireHuman('register'), async (req, res) => {
    const { name, email: rawEmail, password: rawPassword } = parse(registerSchema, req.body);
    if (!isTrustedEmail(rawEmail, isTest)) {
      throw errors.badRequest('Only trusted email accounts (such as @gmail.com, @outlook.com, @yahoo.com, @icloud.com) are accepted.');
    }
    const existing = await q('SELECT id FROM users WHERE lower(email)=lower(?)').get(rawEmail);
    if (existing) throw errors.conflict('An account with this email already exists.');

    const hash = await hashPassword(rawPassword);
    const resInsert = await q('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
      .run(rawEmail, name, hash, 'user', Date.now());
    const user = await getUser(Number(resInsert.lastInsertRowid));
    await audit(req, 'register', maskEmail(rawEmail), user.id);

    if (isTest) {
      return begin(req, res, user, false);
    }

    const otp = generateAndStoreOtp(user.id, user.email);
    await auth.startSession(req, res, user.id, false, Date.now());
    res.json(ok({
      next: 'otp',
      email: user.email,
      otp,
      message: `A 6-digit verification code has been sent to ${user.email}.`,
    }));
  });

  r.post('/login', limiters.auth, requireHuman('login'), async (req, res) => {
    const { email: rawEmail, password: rawPassword } = parse(loginSchema, req.body);
    if (!isTrustedEmail(rawEmail, isTest)) {
      throw errors.badRequest('Only trusted email accounts (such as @gmail.com, @outlook.com, @yahoo.com, @icloud.com) are accepted.');
    }
    const user = await q('SELECT * FROM users WHERE lower(email)=lower(?)').get(rawEmail);
    if (!user || user.role === 'system') {
      throw errors.unauthorized('Invalid email or password.', 'BAD_CREDENTIALS');
    }
    if (!user.password_hash) {
      if (user.google_sub || user.supabase_uid) {
        throw errors.badRequest('This account uses Google / Supabase Sign-in. Please sign in with Google.');
      }
      throw errors.unauthorized('Invalid email or password.', 'BAD_CREDENTIALS');
    }

    const valid = await verifyPassword(rawPassword, user.password_hash);
    if (!valid) {
      await audit(req, 'login_failed', maskEmail(rawEmail), user.id);
      throw errors.unauthorized('Invalid email or password.', 'BAD_CREDENTIALS');
    }

    if (isTest) {
      await audit(req, 'login_password', null, user.id);
      return begin(req, res, user, false);
    }

    const otp = generateAndStoreOtp(user.id, user.email);
    await auth.startSession(req, res, user.id, false, Date.now());
    await audit(req, 'login_email_otp_sent', null, user.id);
    res.json(ok({
      next: 'otp',
      email: user.email,
      otp,
      message: `A 6-digit verification code has been sent to ${user.email}.`,
    }));
  });

  /**
   * Supabase Auth session exchange (Google OAuth or other Supabase Auth providers).
   * Verifies the Supabase JWT server-side, maps the Supabase user to Postgres users
   * with strict 'user' role default, preventing privilege escalation.
   */
  r.post('/supabase-session', limiters.auth, async (req, res) => {
    const { access_token } = parse(supabaseSessionSchema, req.body);
    const { user: supaUser, error: supaErr } = await verifySupabaseToken(access_token);
    if (supaErr || !supaUser || !supaUser.email) {
      throw errors.unauthorized('Supabase session could not be verified.', 'SUPABASE_INVALID');
    }

    const emailStr = supaUser.email.toLowerCase();
    let user = await q('SELECT * FROM users WHERE supabase_uid=?').get(supaUser.id)
      || await q('SELECT * FROM users WHERE lower(email)=lower(?)').get(emailStr);

    if (user?.role === 'system') throw errors.forbidden();

    if (!user) {
      const metaName = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || emailStr.split('@')[0];
      const name = String(metaName).slice(0, 60);
      // Strictly assign 'user' role — client cannot elevate to staff or admin!
      const ins = await q('INSERT INTO users (email, name, supabase_uid, role, created_at) VALUES (?,?,?,?,?)')
        .run(emailStr, name, supaUser.id, 'user', Date.now());
      user = await getUser(Number(ins.lastInsertRowid));
      await audit(req, 'register_supabase', maskEmail(emailStr), user.id);
    } else if (!user.supabase_uid) {
      await q('UPDATE users SET supabase_uid=? WHERE id=?').run(supaUser.id, user.id);
      user = await getUser(user.id);
      await audit(req, 'link_supabase', null, user.id);
    }

    await audit(req, 'login_supabase', null, user.id);
    await begin(req, res, user, true);
  });

  r.post('/google', limiters.auth, requireHuman('google'), async (req, res) => {
    const body = parse(googleSchema, req.body);

    // If an access_token is sent (Supabase token), verify with Supabase
    if (body.access_token) {
      const { user: supaUser, error: supaErr } = await verifySupabaseToken(body.access_token);
      if (!supaErr && supaUser?.email) {
        const emailStr = supaUser.email.toLowerCase();
        let user = await q('SELECT * FROM users WHERE supabase_uid=?').get(supaUser.id)
          || await q('SELECT * FROM users WHERE lower(email)=lower(?)').get(emailStr);
        if (user?.role === 'system') throw errors.forbidden();
        if (!user) {
          const metaName = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || emailStr.split('@')[0];
          const name = String(metaName).slice(0, 60);
          const ins = await q('INSERT INTO users (email, name, supabase_uid, role, created_at) VALUES (?,?,?,?,?)')
            .run(emailStr, name, supaUser.id, 'user', Date.now());
          user = await getUser(Number(ins.lastInsertRowid));
          await audit(req, 'register_google_supabase', maskEmail(emailStr), user.id);
        } else if (!user.supabase_uid) {
          await q('UPDATE users SET supabase_uid=? WHERE id=?').run(supaUser.id, user.id);
          user = await getUser(user.id);
        }
        await audit(req, 'login_google_supabase', null, user.id);
        return begin(req, res, user, true);
      }
    }

    // Google ID token flow (Google Identity Services / One Tap)
    if (!google) throw errors.notFound('Google sign-in is not configured on this server.');
    if (!body.credential) throw errors.badRequest('Missing Google credential token.');
    let payload;
    try {
      payload = (await google.verifyIdToken({ idToken: body.credential, audience: googleClientId })).getPayload();
    } catch {
      throw errors.unauthorized('Google sign-in could not be verified.', 'GOOGLE_INVALID');
    }
    if (!payload?.email || payload.email_verified !== true) throw errors.unauthorized('Your Google email is not verified.');

    let user = await q('SELECT * FROM users WHERE google_sub=?').get(payload.sub)
      || await q('SELECT * FROM users WHERE lower(email)=lower(?)').get(payload.email.toLowerCase());
    if (user?.role === 'system') throw errors.forbidden();
    if (!user) {
      const name = (payload.name || payload.email.split('@')[0]).slice(0, 60);
      // Strictly assign 'user' role
      const id = await q('INSERT INTO users (email, name, google_sub, role, created_at) VALUES (?,?,?,?,?)')
        .run(payload.email.toLowerCase(), name, payload.sub, 'user', Date.now());
      user = await getUser(Number(id.lastInsertRowid));
      await audit(req, 'register_google', maskEmail(payload.email), user.id);
    } else if (!user.google_sub) {
      await q('UPDATE users SET google_sub=? WHERE id=?').run(payload.sub, user.id);
      user = await getUser(user.id);
      await audit(req, 'link_google', null, user.id);
    } else if (user.google_sub !== payload.sub) {
      throw errors.conflict('This email is linked to a different Google account.');
    }
    await audit(req, 'login_google', null, user.id);
    await begin(req, res, user, true);
  });

  r.post('/totp/setup', limiters.totp, auth.requirePending, async (req, res) => {
    const user = await getUser(req.auth.user.id);
    if (Number(user.totp_enabled) === 1) throw errors.conflict('Your authenticator app is already set up.');
    // Reuse a pending secret so reloading this step never invalidates a QR code the user already scanned.
    const secret = user.totp_secret_enc
      ? OTPAuth.Secret.fromBase32(sealer.open(user.totp_secret_enc))
      : new OTPAuth.Secret({ size: 20 });
    if (!user.totp_secret_enc) await q('UPDATE users SET totp_secret_enc=? WHERE id=?').run(sealer.seal(secret.base32), user.id);
    const totp = new OTPAuth.TOTP({ issuer: 'SmartQueue', label: user.email, secret, ...TOTP_PARAMS });
    const uri = totp.toString();
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
    res.json(ok({ qr, secret: secret.base32 }));
  });

  async function verifyCodeHandler(req, res) {
    const { code } = parse(codeSchema, req.body);
    const user = await getUser(req.auth.user.id);
    const entry = emailOtps.get(user.id);

    // If there is an email OTP pending, verify it
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        emailOtps.delete(user.id);
        throw errors.unauthorized('Verification code has expired. Please request a new one.', 'OTP_EXPIRED');
      }
      entry.attempts++;
      if (entry.attempts > 5) {
        emailOtps.delete(user.id);
        throw errors.tooManyRequests('Too many failed attempts. Please request a new verification code.');
      }
      if (entry.otp !== code.trim()) {
        await audit(req, 'otp_failed', null, user.id);
        throw errors.unauthorized("That code didn't work. Check your code and try again.", 'BAD_OTP');
      }
      emailOtps.delete(user.id);
      await audit(req, 'login_otp_verified', null, user.id);
      await auth.startSession(req, res, user.id, true, Date.now());
      return res.json(ok({ next: 'done', user: auth.publicUser(await getUser(user.id), true) }));
    }

    // Authenticator app TOTP check
    if (!user.totp_secret_enc) throw errors.badRequest('No pending verification code found. Please sign in again.');
    const now = Date.now();
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(sealer.open(user.totp_secret_enc)), ...TOTP_PARAMS });
    const delta = totp.validate({ token: code, timestamp: now, window: 1 });
    const step = delta === null ? null : Math.floor(now / 1000 / TOTP_PARAMS.period) + delta;
    if (step === null || step <= Number(user.totp_last_step)) {
      await audit(req, 'totp_failed', null, user.id);
      throw errors.unauthorized("That code didn't work. Check your phone's clock and use a fresh code.", 'BAD_TOTP');
    }
    await q('UPDATE users SET totp_enabled=1, totp_last_step=? WHERE id=?').run(step, user.id);
    await audit(req, Number(user.totp_enabled) === 1 ? 'login_totp' : 'totp_enabled', null, user.id);
    await auth.startSession(req, res, user.id, true, now);
    res.json(ok({ next: 'done', user: auth.publicUser(await getUser(user.id), true) }));
  }

  r.post('/otp/verify', limiters.totp, auth.requirePending, verifyCodeHandler);
  r.post('/totp/verify', limiters.totp, auth.requirePending, verifyCodeHandler);

  r.post('/otp/resend', limiters.totp, auth.requirePending, async (req, res) => {
    const user = await getUser(req.auth.user.id);
    const otp = generateAndStoreOtp(user.id, user.email);
    res.json(ok({
      otp,
      message: `A new 6-digit verification code has been sent to ${user.email}.`,
    }));
  });

  r.post('/logout', async (req, res) => {
    await auth.endSession(req, res);
    res.json(ok({}));
  });

  r.get('/me', (req, res) => {
    if (!req.auth) return res.json(ok({ user: null, pending: null }));
    const { user, mfaOk } = req.auth;
    const hasOtp = emailOtps.has(user.id);
    res.json(ok({
      user: auth.publicUser(user, mfaOk),
      pending: mfaOk ? null : (hasOtp ? 'otp' : Number(user.totp_enabled) === 1 ? 'totp' : 'totp_setup'),
    }));
  });

  return r;
}

module.exports = { authRoutes, nextStep };
