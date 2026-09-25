'use strict';

const { randomToken, sha256 } = require('./crypto');

/**
 * Stateless "human pass" + server-timed press-and-hold challenge.
 *
 * - A pass is an HMAC-signed expiry bound to a hash of IP + user agent, so it
 *   cannot be replayed from another client.
 * - A challenge token records when the server issued it. The client must hold
 *   for >= minHoldMs, and the server checks that at least that much *server*
 *   time has passed — a script cannot skip the wait. Tokens are single-use.
 */
function createHumanGate({ signer, passTtlMs, challengeTtlMs, minHoldMs }) {
  const usedChallenges = new Map(); // nonce -> expiry

  const fingerprint = (ip, ua) => sha256(`${ip}|${ua || ''}`).slice(0, 32);

  function pruneUsed(now) {
    for (const [nonce, exp] of usedChallenges) if (exp < now) usedChallenges.delete(nonce);
  }

  return Object.freeze({
    fingerprint,

    issuePass(fp, now) {
      const exp = now + passTtlMs;
      return `${exp}.${signer.sign(`pass|${exp}|${fp}`)}`;
    },

    checkPass(value, fp, now) {
      if (typeof value !== 'string') return false;
      const [expRaw, sig] = value.split('.');
      const exp = Number(expRaw);
      return Number.isFinite(exp) && exp > now && signer.verify(`pass|${exp}|${fp}`, sig);
    },

    issueChallenge(now) {
      const nonce = randomToken(12);
      return `${now}.${nonce}.${signer.sign(`challenge|${now}|${nonce}`)}`;
    },

    verifyChallenge(token, holdMs, now) {
      if (typeof token !== 'string' || !Number.isFinite(holdMs)) return false;
      const [issuedRaw, nonce, sig] = token.split('.');
      const issued = Number(issuedRaw);
      if (!Number.isFinite(issued) || !nonce || !signer.verify(`challenge|${issued}|${nonce}`, sig)) return false;
      const age = now - issued;
      if (age < minHoldMs || age > challengeTtlMs || holdMs < minHoldMs) return false;
      pruneUsed(now);
      if (usedChallenges.has(nonce)) return false;
      usedChallenges.set(nonce, issued + challengeTtlMs);
      return true;
    },
  });
}

module.exports = { createHumanGate };
