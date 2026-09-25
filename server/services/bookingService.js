'use strict';

const P = require('../policy');
const S = require('../lib/slots');
const { errors } = require('../errors');
const { stmt, tx } = require('../db');

const LIVE = "('booked','checked_in','called')";
const WAITING = "('booked','checked_in')";
const HELD_SEAT = "status NOT IN ('cancelled','no_show')";

const SERVICE_SQL = `
  SELECT s.id, s.org_id, s.name, s.code, s.slot_capacity, s.avg_service_min,
         o.name AS org_name, o.category, o.address, o.lat, o.lng, o.radius_m,
         o.open_min, o.close_min, o.slot_minutes
  FROM services s JOIN organizations o ON o.id = s.org_id
  WHERE s.id = ?`;

const VIEW_SQL = `
  SELECT b.*, s.name AS service_name, s.code AS service_code, s.slot_capacity, s.avg_service_min,
         o.name AS org_name, o.category, o.address, o.lat, o.lng, o.radius_m,
         o.open_min, o.close_min, o.slot_minutes, c.name AS counter_name
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN organizations o ON o.id = b.org_id
  LEFT JOIN counters c ON c.id = b.counter_id`;

/** When an absent booking gets moved: GRACE after the latest of slot start, leaving the premises, or booking. */
function graceDeadline(row, slotStartMs) {
  return Math.max(slotStartMs, Number(row.away_since) || 0, Number(row.created_at) || 0) + P.GRACE_MIN * P.MIN;
}

function whenLabel(date, time, now) {
  if (date === S.toDateStr(now)) return `today at ${time}`;
  if (date === S.addDays(S.toDateStr(now), 1)) return `tomorrow at ${time}`;
  return `${date} at ${time}`;
}

function createBookingService({ db, notifier, events }) {
  const q = (sql) => stmt(db, sql);

  async function requireService(serviceId) {
    const svc = await q(SERVICE_SQL).get(serviceId);
    if (!svc) throw errors.notFound('Service not found.');
    return svc;
  }

  async function requireOwned(userId, bookingId) {
    const b = await q('SELECT * FROM bookings WHERE id=? AND user_id=?').get(bookingId, userId);
    if (!b) throw errors.notFound('Token not found.');
    return b;
  }

  function assertBookableDate(date, now) {
    if (!S.isValidDateStr(date)) throw errors.badRequest('Invalid date.');
    const today = S.toDateStr(now);
    if (date < today) throw errors.badRequest('That date is in the past.');
    if (date > S.addDays(today, P.BOOKING_HORIZON_DAYS)) {
      throw errors.badRequest(`You can book up to ${P.BOOKING_HORIZON_DAYS} days ahead.`);
    }
  }

  const firstBookableIndex = (svc, date, now) => (date === S.toDateStr(now) ? S.firstOpenSlotIndex(svc, date, now) : 0);

  /** slot_index -> Set(seat) of held seats for one service/day (single query). */
  async function takenBySlot(serviceId, date) {
    const map = new Map();
    const rows = await q(`SELECT slot_index, seat FROM bookings WHERE service_id=? AND date=? AND ${HELD_SEAT}`).all(serviceId, date);
    for (const r of rows) {
      const slot = Number(r.slot_index);
      const seat = Number(r.seat);
      if (!map.has(slot)) map.set(slot, new Set());
      map.get(slot).add(seat);
    }
    return map;
  }

  function freeSeatIn(svc, taken, slotIndex) {
    const held = taken.get(slotIndex);
    for (let seat = 0; seat < svc.slot_capacity; seat++) if (!held || !held.has(seat)) return seat;
    return -1;
  }

  async function firstFree(svc, date, fromIndex) {
    const taken = await takenBySlot(svc.id, date);
    const n = S.slotCount(svc);
    for (let i = Math.max(0, fromIndex); i < n; i++) {
      const seat = freeSeatIn(svc, taken, i);
      if (seat >= 0) return { slotIndex: i, seat };
    }
    return null;
  }

  async function assertUserCanBook(userId, svcOrOrgId, date, slotIndex, now, excludeId = 0) {
    const user = await q('SELECT id, blocked_until FROM users WHERE id=?').get(userId);
    if (!user) throw errors.unauthorized();
    if (user.blocked_until && Number(user.blocked_until) > now) {
      throw errors.forbidden(
        `Booking is paused until ${new Date(Number(user.blocked_until)).toLocaleString()} after repeated no-shows.`,
        'BOOKING_SUSPENDED',
      );
    }
    const activeRow = await q(`SELECT COUNT(*) AS c FROM bookings WHERE user_id=? AND status IN ${LIVE} AND id<>?`).get(userId, excludeId);
    const active = Number(activeRow?.c) || 0;
    if (active >= P.MAX_ACTIVE_BOOKINGS) {
      throw errors.conflict(`You can hold at most ${P.MAX_ACTIVE_BOOKINGS} active tokens.`, 'LIMIT_ACTIVE');
    }

    const orgId = typeof svcOrOrgId === 'object' ? svcOrOrgId.org_id : svcOrOrgId;
    const svc = typeof svcOrOrgId === 'object' ? svcOrOrgId : null;

    // Rule 1: No multiple active tokens for the same company / organisation.
    const dup = await q(
      `SELECT b.id, b.token_code, o.name AS org_name
       FROM bookings b
       JOIN organizations o ON o.id = b.org_id
       WHERE b.user_id = ? AND b.org_id = ? AND b.status IN ${LIVE} AND b.id <> ?`
    ).get(userId, orgId, excludeId);
    if (dup) {
      throw errors.conflict(
        `You already hold an active token (${dup.token_code}) for ${dup.org_name}. You cannot book another token for the same company or office until your current visit is completed.`,
        'DUPLICATE_BOOKING',
      );
    }

    // Rule 2: No booking 2 different slots at the same time (overlapping / simultaneous time slots).
    if (svc && Number.isInteger(slotIndex)) {
      const reqStartMs = S.slotStartMs(svc, date, slotIndex);
      const reqEndMs = S.slotEndMs(svc, date, slotIndex);

      const existingBookings = await q(
        `SELECT b.id, b.token_code, b.date, b.slot_index, o.name AS org_name, o.open_min, o.slot_minutes
         FROM bookings b
         JOIN organizations o ON o.id = b.org_id
         WHERE b.user_id = ? AND b.status IN ${LIVE} AND b.id <> ?`
      ).all(userId, excludeId);

      for (const b of existingBookings) {
        const bStartMs = S.slotStartMs(b, b.date, Number(b.slot_index));
        const bEndMs = S.slotEndMs(b, b.date, Number(b.slot_index));
        const overlaps = reqStartMs < bEndMs && reqEndMs > bStartMs;
        if (overlaps) {
          const timeLabel = S.slotLabel(b, Number(b.slot_index));
          throw errors.conflict(
            `Time conflict: You already have token ${b.token_code} booked for ${timeLabel} at ${b.org_name}. You cannot book two different slots at the same time.`,
            'TIME_CONFLICT',
          );
        }
      }
    }
  }

  async function pickSeat(svc, date, slotIndex, kind, now) {
    const first = firstBookableIndex(svc, date, now);
    if (kind === 'walkin') {
      const pick = await firstFree(svc, date, first);
      if (!pick) throw errors.conflict('No tokens left for today. Try booking another day.', 'SOLD_OUT');
      return pick;
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= S.slotCount(svc)) {
      throw errors.badRequest('Invalid time slot.');
    }
    if (slotIndex < first) throw errors.badRequest('That time slot has already passed.');
    const taken = await takenBySlot(svc.id, date);
    const seat = freeSeatIn(svc, taken, slotIndex);
    if (seat < 0) throw errors.conflict('That slot just filled up — please pick another time.', 'SLOT_FULL');
    return { slotIndex, seat };
  }

  async function insertBooking({ userId, svc, date, slotIndex, seat, kind, status, now }) {
    const tokenNo = S.tokenNumber(svc.slot_capacity, slotIndex, seat);
    const info = await q(
      `INSERT INTO bookings (user_id, org_id, service_id, date, slot_index, seat, token_no, token_code, kind, status, created_at, checked_in_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, svc.org_id, svc.id, date, slotIndex, seat, tokenNo, S.tokenCode(svc.code, tokenNo), kind, status, now,
      status === 'checked_in' ? now : null);
    return Number(info.lastInsertRowid);
  }

  async function toView(row, now) {
    const slotIndex = Number(row.slot_index);
    const seat = Number(row.seat);
    const slotStart = S.slotStartMs(row, row.date, slotIndex);
    const waiting = row.status === 'booked' || row.status === 'checked_in';
    let ahead = null;
    let etaMin = null;
    if (waiting) {
      const minsToSlot = Math.max(0, Math.ceil((slotStart - now) / P.MIN));
      etaMin = minsToSlot;
      if (row.date === S.toDateStr(now)) {
        // Counters only call checked-in tokens, so a checked-in visitor is only behind other checked-in ones.
        const competing = row.status === 'checked_in' ? "('checked_in')" : WAITING;
        const aheadRow = await q(
          `SELECT COUNT(*) AS c FROM bookings WHERE org_id=? AND date=? AND status IN ${competing}
           AND (slot_index < ? OR (slot_index = ? AND (seat < ? OR (seat = ? AND service_id < ?))))`,
        ).get(row.org_id, row.date, slotIndex, slotIndex, seat, seat, row.service_id);
        ahead = Number(aheadRow?.c) || 0;
        const openRow = await q("SELECT COUNT(*) AS c FROM counters WHERE org_id=? AND status='open'").get(row.org_id);
        const open = Math.max(1, Number(openRow?.c) || 1);
        etaMin = Math.max(minsToSlot, Math.ceil((ahead * Number(row.avg_service_min)) / open));
      }
    }
    return {
      id: Number(row.id),
      tokenCode: row.token_code,
      tokenNo: Number(row.token_no),
      status: row.status,
      kind: row.kind,
      date: row.date,
      slotIndex,
      slotTime: S.slotLabel(row, slotIndex),
      slotStartMs: slotStart,
      checkInOpensMs: slotStart - P.CHECKIN_EARLY_MIN * P.MIN,
      graceEndsMs: graceDeadline(row, slotStart),
      org: { id: Number(row.org_id), name: row.org_name, category: row.category, address: row.address, lat: Number(row.lat), lng: Number(row.lng), radiusM: Number(row.radius_m) },
      service: { id: Number(row.service_id), name: row.service_name, code: row.service_code },
      counter: row.counter_name || null,
      ahead,
      etaMin,
      deferrals: Number(row.deferrals) || 0,
      reschedulesLeft: Math.max(0, P.MAX_RESCHEDULES - (Number(row.reschedules) || 0)),
      lastDistanceM: row.last_distance_m !== null ? Number(row.last_distance_m) : null,
      lastSeenAt: row.last_seen_at !== null ? Number(row.last_seen_at) : null,
      away: Boolean(row.away_since),
      createdAt: Number(row.created_at),
      calledAt: row.called_at !== null ? Number(row.called_at) : null,
      completedAt: row.completed_at !== null ? Number(row.completed_at) : null,
    };
  }

  async function viewById(id, now) {
    const row = await q(`${VIEW_SQL} WHERE b.id = ?`).get(id);
    if (!row) throw errors.notFound('Token not found.');
    return toView(row, now);
  }

  async function publish(userId, orgId, message) {
    await notifier.flush(message ? [[userId, message]] : [], [orgId]);
    if (!message) events.emitUser(userId, { kind: 'bookings' });
  }

  async function create({ userId, serviceId, date, slotIndex, kind, now, system = false, status = 'booked' }) {
    const { id, orgId } = await tx(db, async () => {
      const svc = await requireService(serviceId);
      const day = kind === 'walkin' ? S.toDateStr(now) : date;
      assertBookableDate(day, now);
      const pick = await pickSeat(svc, day, slotIndex, kind, now);
      if (!system) await assertUserCanBook(userId, svc, day, pick.slotIndex, now);
      const insertId = await insertBooking({ userId, svc, date: day, ...pick, kind, status, now });
      return { id: insertId, orgId: svc.org_id };
    });
    const view = await viewById(id, now);
    await publish(userId, orgId, system ? null : {
      bookingId: id,
      type: 'booked',
      level: 'success',
      title: `Token ${view.tokenCode} confirmed`,
      body: `${view.service.name} at ${view.org.name}, ${whenLabel(view.date, view.slotTime, now)}. Check in when you arrive — we'll remind you ${P.REMIND_BEFORE_MIN} min before.`,
    });
    return view;
  }

  async function reschedule({ userId, bookingId, date, slotIndex, now }) {
    const { id, oldCode, orgId } = await tx(db, async () => {
      const b = await requireOwned(userId, bookingId);
      if (b.status !== 'booked' && b.status !== 'checked_in') throw errors.conflict('Only upcoming tokens can be rescheduled.');
      if (Number(b.reschedules) >= P.MAX_RESCHEDULES) {
        throw errors.conflict(`A token can be rescheduled at most ${P.MAX_RESCHEDULES} times.`, 'LIMIT_RESCHEDULE');
      }
      if (b.date === date && Number(b.slot_index) === slotIndex) throw errors.badRequest('Pick a different time.');
      const svc = await requireService(b.service_id);
      assertBookableDate(date, now);
      const pick = await pickSeat(svc, date, slotIndex, 'appointment', now);
      await assertUserCanBook(userId, svc, date, pick.slotIndex, now, b.id);
      const tokenNo = S.tokenNumber(svc.slot_capacity, pick.slotIndex, pick.seat);
      await q(
        `UPDATE bookings SET date=?, slot_index=?, seat=?, token_no=?, token_code=?, kind='appointment', status='booked',
         reschedules=reschedules+1, reminder_sent=0, away_since=NULL, checked_in_at=NULL, created_at=? WHERE id=?`,
      ).run(date, pick.slotIndex, pick.seat, tokenNo, S.tokenCode(svc.code, tokenNo), now, b.id);
      return { id: b.id, oldCode: b.token_code, orgId: svc.org_id };
    });
    const view = await viewById(id, now);
    await publish(userId, orgId, {
      bookingId: id,
      type: 'rescheduled',
      level: 'info',
      title: `Rescheduled: ${oldCode} → ${view.tokenCode}`,
      body: `New time ${whenLabel(view.date, view.slotTime, now)} at ${view.org.name}. Nobody else's token changed.`,
    });
    return view;
  }

  async function cancel({ userId, bookingId, now }) {
    const b = await tx(db, async () => {
      const row = await requireOwned(userId, bookingId);
      if (row.status !== 'booked' && row.status !== 'checked_in') throw errors.conflict('This token can no longer be cancelled.');
      await q("UPDATE bookings SET status='cancelled' WHERE id=?").run(row.id);
      return row;
    });
    await publish(userId, b.org_id, {
      bookingId: b.id,
      type: 'cancelled',
      level: 'info',
      title: `Token ${b.token_code} cancelled`,
      body: 'Your slot has been released for someone else.',
    });
    return viewById(b.id, now);
  }

  async function myBookings(userId, now) {
    const active = await q(`${VIEW_SQL} WHERE b.user_id=? AND b.status IN ${LIVE} ORDER BY b.date, b.slot_index`).all(userId);
    const history = await q(`${VIEW_SQL} WHERE b.user_id=? AND b.status NOT IN ${LIVE} ORDER BY b.id DESC LIMIT 8`).all(userId);
    return {
      active: await Promise.all(active.map((r) => toView(r, now))),
      history: await Promise.all(history.map((r) => toView(r, now))),
    };
  }

  async function slots(serviceId, date, now) {
    const svc = await requireService(serviceId);
    assertBookableDate(date, now);
    const first = firstBookableIndex(svc, date, now);
    const taken = await takenBySlot(svc.id, date);
    return {
      date,
      service: { id: Number(svc.id), name: svc.name, code: svc.code, capacity: Number(svc.slot_capacity), avgServiceMin: Number(svc.avg_service_min) },
      org: { id: Number(svc.org_id), name: svc.org_name, slotMinutes: Number(svc.slot_minutes) },
      slots: Array.from({ length: S.slotCount(svc) }, (_, i) => {
        const held = taken.get(i)?.size || 0;
        const past = i < first;
        return {
          index: i,
          time: S.slotLabel(svc, i),
          capacity: Number(svc.slot_capacity),
          taken: held,
          available: past ? 0 : Number(svc.slot_capacity) - held,
          past,
          nextToken: past || held >= svc.slot_capacity
            ? null
            : S.tokenCode(svc.code, S.tokenNumber(svc.slot_capacity, i, freeSeatIn(svc, taken, i))),
        };
      }),
    };
  }

  return Object.freeze({
    requireService,
    requireOwned,
    firstFree,
    create,
    reschedule,
    cancel,
    myBookings,
    slots,
    viewById,
  });
}

module.exports = { createBookingService, graceDeadline, whenLabel };
