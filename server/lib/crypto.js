'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

let dummyHash = null;

/** Constant-work verify. Pass stored=null to burn equivalent time for unknown users. */
async function verifyPassword(password, stored) {
  if (!stored) {
    dummyHash = dummyHash || (await hashPassword('timing-equaliser'));
    await verifyPassword(password, dummyHash);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** AES-256-GCM sealing for secrets at rest (TOTP seeds). */
function createSealer(appSecret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', appSecret, 'smartqueue', 'totp-at-rest', 32));
  return Object.freeze({
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  });
}

/** HMAC signer for short-lived, stateless tokens (human pass, challenges). */
function createSigner(appSecret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', appSecret, 'smartqueue', 'hmac-signing', 32));
  const mac = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  return Object.freeze({
    sign: mac,
    verify(data, signature) {
      if (typeof signature !== 'string') return false;
      const a = Buffer.from(mac(data));
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  });
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, createSealer, createSigner };
