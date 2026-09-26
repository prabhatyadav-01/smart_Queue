'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/lib/slots');
const { haversineMeters, assessPresence } = require('../server/lib/geo');
const BotScore = require('../server/lib/botScore');
const { hashPassword, verifyPassword, createSealer, createSigner } = require('../server/lib/crypto');
const { createHumanGate } = require('../server/lib/humanGate');
const { humanTelemetry, linearBotTelemetry } = require('./helpers');

const org = { open_min: 540, close_min: 1020, slot_minutes: 15 }; // 09:00–17:00

test('slots: count, labels and token numbering', () => {
  assert.equal(S.slotCount(org), 32);
  assert.equal(S.slotLabel(org, 4), '10:00');
  assert.equal(S.tokenNumber(6, 4, 0), 25);
  assert.equal(S.tokenCode('P', 25), 'P-025');
});

test('slots: first open slot is the one containing "now"', () => {
  const day = '2026-03-10';
  assert.equal(S.firstOpenSlotIndex(org, day, new Date(2026, 2, 10, 8, 0).getTime()), 0);
  assert.equal(S.firstOpenSlotIndex(org, day, new Date(2026, 2, 10, 10, 5).getTime()), 4);
  assert.equal(S.firstOpenSlotIndex(org, day, new Date(2026, 2, 10, 18, 0).getTime()), 32);
});

test('slots: date validation and arithmetic', () => {
  assert.equal(S.isValidDateStr('2026-02-30'), false);
  assert.equal(S.isValidDateStr('2026-02-28'), true);
  assert.equal(S.addDays('2026-02-28', 1), '2026-03-01');
});

test('geo: haversine and geofence with accuracy tolerance', () => {
  const d = haversineMeters(17.4399, 78.4636, 17.4409, 78.4636);
  assert.ok(Math.abs(d - 111) < 2, `expected ~111 m, got ${d}`);
  const office = { lat: 17.4399, lng: 78.4636, radius_m: 100 };
  const opts = { toleranceCapM: 50, awayFactor: 1.5 };
  assert.equal(assessPresence(office, { lat: 17.4399, lng: 78.4636, accuracy: 10 }, opts).inside, true);
  assert.equal(assessPresence(office, { lat: 17.4409, lng: 78.4636, accuracy: 20 }, opts).inside, true); // 111 m ≤ 100+20
  assert.equal(assessPresence(office, { lat: 17.4419, lng: 78.4636, accuracy: 500 }, opts).inside, false); // tolerance capped
  assert.equal(assessPresence(office, { lat: 17.4499, lng: 78.4636, accuracy: 10 }, opts).away, true);
});

test('botScore: human-like curved movement scores as human', () => {
  for (const seed of [1, 7, 42, 99]) {
    const r = BotScore.analyze(humanTelemetry(seed));
    assert.equal(r.verdict, 'human', `seed ${seed}: ${JSON.stringify(r)}`);
  }
});

test('botScore: linear constant-speed cursor is flagged', () => {
  const r = BotScore.analyze(linearBotTelemetry());
  assert.notEqual(r.verdict, 'human');
  assert.ok(r.reasons.includes('uniform-speed'));
});

test('botScore: automation flag and synthetic events are hard blocks', () => {
  assert.equal(BotScore.analyze({ webdriver: true }).hard, true);
  assert.equal(BotScore.analyze({ untrusted: 5 }).verdict, 'bot');
});

test('botScore: no telemetry is inconclusive, never human', () => {
  assert.equal(BotScore.analyze(undefined).verdict, 'inconclusive');
  assert.equal(BotScore.analyze({ moves: [[0, 1, 1]] }).verdict, 'inconclusive');
});

test('botScore: robotic fixed-interval typing is penalised', () => {
  const keys = Array.from({ length: 20 }, (_, i) => 1000 + i * 50);
  const r = BotScore.analyze({ ...linearBotTelemetry(), keys });
  assert.ok(r.reasons.includes('robotic-keystroke-rhythm'));
});

test('botScore: human touch gesture with curvature and speed variation scores as human', () => {
  const touchMoves = [];
  let t = 100;
  for (let i = 0; i <= 20; i++) {
    const progress = i / 20;
    t += Math.round(15 + 25 * Math.sin(progress * Math.PI));
    const x = Math.round(50 + 200 * progress);
    const y = Math.round(100 + 80 * Math.sin(progress * Math.PI * 0.8) + (i % 2 === 0 ? 1 : -1));
    touchMoves.push([t, x, y]);
  }
  const r = BotScore.analyze({
    touches: 2,
    touchMoves,
    touchMetrics: { avgRadius: 12, pressureVariance: 0.15 },
    dwellMs: 1500,
  });
  assert.equal(r.verdict, 'human', `touch verdict: ${JSON.stringify(r)}`);
  assert.equal(r.mode, 'touch');
});

test('crypto: password hashing verifies and rejects', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('crypto: sealer round-trips and detects tampering', () => {
  const sealer = createSealer('s'.repeat(40));
  const sealed = sealer.seal('JBSWY3DPEHPK3PXP');
  assert.equal(sealer.open(sealed), 'JBSWY3DPEHPK3PXP');
  const [iv, tag, enc] = sealed.split('.');
  assert.throws(() => sealer.open([iv, tag, `${enc.slice(0, -2)}AA`].join('.')));
});

test('humanGate: pass is bound to fingerprint and expires', () => {
  const gate = createHumanGate({ signer: createSigner('k'.repeat(40)), passTtlMs: 1000, challengeTtlMs: 60_000, minHoldMs: 1500 });
  const fp = gate.fingerprint('1.2.3.4', 'UA');
  const pass = gate.issuePass(fp, 0);
  assert.equal(gate.checkPass(pass, fp, 500), true);
  assert.equal(gate.checkPass(pass, gate.fingerprint('5.6.7.8', 'UA'), 500), false);
  assert.equal(gate.checkPass(pass, fp, 1500), false);
});

test('humanGate: challenge needs real elapsed server time and is single-use', () => {
  const gate = createHumanGate({ signer: createSigner('k'.repeat(40)), passTtlMs: 1000, challengeTtlMs: 60_000, minHoldMs: 1500 });
  const token = gate.issueChallenge(10_000);
  assert.equal(gate.verifyChallenge(token, 1600, 10_500), false); // too soon on the server clock
  assert.equal(gate.verifyChallenge(token, 1600, 12_000), true);
  assert.equal(gate.verifyChallenge(token, 1600, 12_100), false); // replay
  assert.equal(gate.verifyChallenge(`${token}x`, 1600, 12_000), false); // forged
});
