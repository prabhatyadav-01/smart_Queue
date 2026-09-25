'use strict';

const S = require('../lib/slots');
const { errors } = require('../errors');
const { stmt, tx } = require('../db');

/**
 * Counter assignment. The next person called is always the earliest
 * *checked-in* token (by slot, then seat), so people who are physically
 * present are never blocked by people who haven't arrived.
 */
function createCounterService({ db, notifier, presence }) {
  const q = (sql) => stmt(db, sql);

  async function requireCounter(orgId, counterId) {
    const counter = await q('SELECT * FROM counters WHERE id=? AND org_id=?').get(counterId, orgId);
    if (!counter) throw errors.notFound('Counter not found.');
    return counter;
  }

  async function servingAt(counter) {
    if (!counter.current_booking_id) return null;
    const b = await q('SELECT * FROM bookings WHERE id=?').get(counter.current_booking_id);
    return b && b.status === 'called' ? b : null;
  }

  async function requireServing(counter) {
    const b = await servingAt(counter);
    if (!b) throw errors.conflict(`No token is being served at ${counter.name}.`);
    return b;
  }

  async function callNextInTx(orgId, counter, now, outbox) {
    if (counter.status !== 'open') throw errors.conflict(`${counter.name} is ${counter.status}.`);
    const current = await servingAt(counter);
    if (current) throw errors.conflict(`Finish ${current.token_code} at ${counter.name} first.`, 'COUNTER_BUSY');
    const next = await q(
      `SELECT * FROM bookings WHERE org_id=? AND date=? AND status='checked_in'
       ORDER BY slot_index, seat, service_id LIMIT 1`,
    ).get(orgId, S.toDateStr(now));
    if (!next) {
      await q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      return null;
    }
    await q("UPDATE bookings SET status='called', counter_id=?, called_at=? WHERE id=?").run(counter.id, now, next.id);
    await q('UPDATE counters SET current_booking_id=? WHERE id=?').run(next.id, counter.id);
    outbox.push([next.user_id, {
      bookingId: Number(next.id),
      type: 'called',
      level: 'success',
      title: `It's your turn — ${next.token_code}`,
      body: `Please proceed to ${counter.name} now.`,
    }]);
    return { counterId: Number(counter.id), counter: counter.name, tokenCode: next.token_code, bookingId: Number(next.id) };
  }

  async function run(orgId, fn) {
    const outbox = [];
    const result = await tx(db, () => fn(outbox));
    await notifier.flush(outbox, [orgId]);
    return result;
  }

  const callNext = async ({ orgId, counterId, now }) => {
    const counter = await requireCounter(orgId, counterId);
    return run(orgId, (outbox) => callNextInTx(orgId, counter, now, outbox));
  };

  const complete = async ({ orgId, counterId, now }) =>
    run(orgId, async (outbox) => {
      const counter = await requireCounter(orgId, counterId);
      const b = await requireServing(counter);
      await q("UPDATE bookings SET status='done', completed_at=? WHERE id=?").run(now, b.id);
      await q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'done',
        level: 'success',
        title: `Served: ${b.token_code}`,
        body: 'Thanks for your visit. We hope it was quick!',
      }]);
      return { tokenCode: b.token_code };
    });

  const noShow = async ({ orgId, counterId, now }) =>
    run(orgId, async (outbox) => {
      const counter = await requireCounter(orgId, counterId);
      const b = await requireServing(counter);
      await q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      const movedTo = await presence.deferInTx(b, now, 'missed_call', outbox);
      return { tokenCode: b.token_code, movedTo };
    });

  const recall = async ({ orgId, counterId }) =>
    run(orgId, async (outbox) => {
      const counter = await requireCounter(orgId, counterId);
      const b = await requireServing(counter);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'recall',
        level: 'warning',
        title: `Final call — ${b.token_code}`,
        body: `${counter.name} is waiting for you. Please come now or your token will move.`,
      }]);
      return { tokenCode: b.token_code };
    });

  const setStatus = async ({ orgId, counterId, status }) =>
    run(orgId, async () => {
      const counter = await requireCounter(orgId, counterId);
      if (status !== 'open' && (await servingAt(counter))) throw errors.conflict('Complete or release the current token first.');
      await q('UPDATE counters SET status=? WHERE id=?').run(status, counter.id);
      return { counterId: Number(counter.id), status };
    });

  /** Fill every idle open counter, least-loaded (fewest served today) first. */
  const autoAssign = async ({ orgId, now }) =>
    run(orgId, async (outbox) => {
      const counters = await q(
        `SELECT c.id, c.name, c.status, c.current_booking_id
         FROM counters c WHERE c.org_id=? AND c.status='open'
         AND (c.current_booking_id IS NULL OR c.current_booking_id NOT IN (SELECT id FROM bookings WHERE status='called'))
         ORDER BY c.id ASC`,
      ).all(orgId);
      const servedCounts = await q(
        "SELECT counter_id, COUNT(*) AS c FROM bookings WHERE org_id=? AND date=? AND status='done' AND counter_id IS NOT NULL GROUP BY counter_id",
      ).all(orgId, S.toDateStr(now));
      const servedMap = new Map(servedCounts.map((r) => [Number(r.counter_id), Number(r.c)]));
      const idle = counters
        .map((c) => ({ ...c, served: servedMap.get(Number(c.id)) || 0 }))
        .sort((a, b) => a.served - b.served || Number(a.id) - Number(b.id));
      const assigned = [];
      for (const counter of idle) {
        const r = await callNextInTx(orgId, counter, now, outbox);
        if (!r) break;
        assigned.push(r);
      }
      return { assigned };
    });

  /** Desk staff verified the visitor in person (e.g. no GPS on their phone). */
  const manualCheckIn = async ({ orgId, bookingId, now }) =>
    run(orgId, async (outbox) => {
      const b = await q('SELECT * FROM bookings WHERE id=? AND org_id=?').get(bookingId, orgId);
      if (!b) throw errors.notFound('Token not found.');
      if (b.status !== 'booked' || b.date !== S.toDateStr(now)) throw errors.conflict('Only today\'s pending tokens can be checked in.');
      await q("UPDATE bookings SET status='checked_in', checked_in_at=?, away_since=NULL WHERE id=?").run(now, b.id);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'checked_in',
        level: 'success',
        title: `Checked in at the desk: ${b.token_code}`,
        body: "You're in the live queue. We'll call you to a counter.",
      }]);
      return { tokenCode: b.token_code };
    });

  return Object.freeze({ callNext, complete, noShow, recall, setStatus, autoAssign, manualCheckIn });
}

module.exports = { createCounterService };
