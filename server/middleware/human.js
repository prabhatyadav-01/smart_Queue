'use strict';

const BotScore = require('../lib/botScore');
const { stmt } = require('../db');
const { AppError, errors } = require('../errors');
const { parseCookies, cookieString } = require('./auth');

/**
 * Gate for sensitive actions (register, login, book, reschedule).
 *
 * 1. A valid signed "human pass" cookie → allowed.
 * 2. Hidden honeypot field filled → blocked.
 * 3. Behavioural telemetry scored server-side (the client never sends a score):
 *      human → allowed + pass cookie
 *      automation flags → blocked
 *      otherwise → 428 with a server-timed press-and-hold challenge.
 */
function createHumanCheck({ db, gate, secure, passTtlMs }) {
  const PASS_COOKIE = secure ? '__Host-sq_hp' : 'sq_hp';
  const record = async (action, ip, result, outcome) => {
    try {
      await stmt(db, 'INSERT INTO risk_events (action, ip, score, verdict, outcome, reasons, created_at) VALUES (?,?,?,?,?,?,?)').run(
        action,
        ip || null,
        result.score,
        result.verdict,
        outcome,
        result.reasons ? result.reasons.join(',').slice(0, 300) : null,
        Date.now(),
      );
    } catch (err) {
      console.error('[humanCheck] failed to log risk event:', err.message);
    }
  };

  return function requireHuman(action) {
    return async (req, res, next) => {
      try {
        const now = Date.now();
        const fp = gate.fingerprint(req.ip, req.headers['user-agent']);
        if (gate.checkPass(parseCookies(req.headers.cookie)[PASS_COOKIE], fp, now)) return next();

        const body = req.body || {};
        if (typeof body.website === 'string' && body.website.trim() !== '') {
          await record(action, req.ip, { score: 0, verdict: 'bot', reasons: ['honeypot'] }, 'blocked');
          throw errors.forbidden('Request blocked.', 'BOT_BLOCKED');
        }

        const result = BotScore.analyze(body.human);
        const challenge = body.challenge && typeof body.challenge === 'object' ? body.challenge : null;
        const challengeOk = !result.hard && challenge !== null
          && gate.verifyChallenge(String(challenge.token || ''), Number(challenge.holdMs), now);
        const passed = result.verdict === 'human' || challengeOk;
        const outcome = passed ? (challengeOk ? 'challenge-passed' : 'passed') : result.hard ? 'blocked' : 'challenged';
        await record(action, req.ip, result, outcome);

        if (passed) {
          res.append('Set-Cookie', cookieString(PASS_COOKIE, gate.issuePass(fp, now), { maxAgeSec: Math.floor(passTtlMs / 1000), secure }));
          return next();
        }
        if (result.hard) throw errors.forbidden('Automated browser detected. Please use a regular browser.', 'BOT_BLOCKED');
        throw new AppError(428, 'HUMAN_CHALLENGE', 'Quick check — press and hold to confirm you are human.', {
          challenge: gate.issueChallenge(now),
          score: result.score,
        });
      } catch (err) {
        next(err);
      }
    };
  };
}

module.exports = { createHumanCheck };
