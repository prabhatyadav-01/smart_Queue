'use strict';

const { openDb } = require('../server/db');
const { seedOrganisations } = require('../server/seed');
const { createServices } = require('../server/services');

/** Deterministic PRNG so telemetry fixtures are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Curved, eased, jittery pointer paths — what a real hand produces. */
function humanTelemetry(seed = 7) {
  const rng = mulberry32(seed);
  const moves = [];
  let t = 50;
  let x = 120;
  let y = 140;
  for (let seg = 0; seg < 6; seg++) {
    const tx = 100 + rng() * 800;
    const ty = 100 + rng() * 500;
    const cx = (x + tx) / 2 + (rng() - 0.5) * 300;
    const cy = (y + ty) / 2 + (rng() - 0.5) * 300;
    const steps = 20 + Math.floor(rng() * 20);
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      const bx = (1 - e) ** 2 * x + 2 * (1 - e) * e * cx + e * e * tx + (rng() - 0.5) * 3;
      const by = (1 - e) ** 2 * y + 2 * (1 - e) * e * cy + e * e * ty + (rng() - 0.5) * 3;
      t += 8 + rng() * 12;
      moves.push([Math.round(t), Math.round(bx), Math.round(by)]);
    }
    x = tx;
    y = ty;
    t += 100 + rng() * 400;
  }
  const last = moves[moves.length - 1];
  return {
    moves,
    clicks: [[last[0] + 120, last[1] + 2, last[2] - 1]],
    keys: [],
    touches: 0,
    untrusted: 0,
    webdriver: false,
    dwellMs: Math.round(t + 500),
  };
}

/** Straight line, constant speed, fixed 10 ms cadence — typical scripted cursor. */
function linearBotTelemetry() {
  const moves = [];
  for (let i = 0; i <= 100; i++) moves.push([1000 + i * 10, i * 8, i * 4]);
  return { moves, clicks: [[2015, 800, 400]], keys: [], touches: 0, untrusted: 0, webdriver: false, dwellMs: 2100 };
}

/** Fresh in-memory database with seed organisations and wired services. */
async function setupServices() {
  const db = await openDb(':memory:');
  await seedOrganisations(db);
  const sent = { orgs: [], users: [] };
  const events = {
    emitOrg: (id) => sent.orgs.push(id),
    emitUser: (id, payload) => sent.users.push([id, payload]),
    setSnapshotProvider() {},
  };
  const services = createServices({ db, events });
  const addUser = async (email) => {
    const res = await db.run('INSERT INTO users (email, name, role, created_at) VALUES (?,?,?,0)', email, email, 'user');
    return Number(res.lastInsertRowid);
  };
  return { db, services, addUser, sent };
}

module.exports = { humanTelemetry, linearBotTelemetry, setupServices, mulberry32 };
