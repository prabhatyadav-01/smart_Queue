'use strict';

const P = require('../policy');
const S = require('../lib/slots');
const { assessPresence } = require('../lib/geo');
const { errors } = require('../errors');
const { stmt, tx } = require('../db');
const { graceDeadline } = require('./bookingService');

const formatDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * Geofenced presence: location check-in, reminders for absent users, and
 * moving an absent user's token to a later free seat. The token they vacate
 * simply becomes free — nobody else's token number changes.
 */
function createPresenceService({ db, notifier, bookings }) {
  const q = (sql) => stmt(db, sql);

  async function applyStrike(userId, now) {
    const user = await q('SELECT strikes, role FROM users WHERE id=?').get(userId);
    if (!user || user.role === 'system') return { blocked: false };
    const strikes = Number(user.strikes) + 1;
    if (strikes >= P.NO_SHOW_STRIKE_LIMIT) {
      await q('UPDATE users SET strikes=0, blocked_until=? WHERE id=?').run(now + P.STRIKE_BLOCK_MS, userId);
      return { blocked: true };
    }
    await q('UPDATE users SET strikes=? WHERE id=?').run(strikes, userId);
    return { blocked: false };
  }

  /** Move a booking to the next free seat ≥ DEFER_GAP from now, or expire it. Must run inside tx. */
  async function deferInTx(b, now, reason, outbox) {
    const svc = await bookings.requireService(b.service_id);
    const today = S.toDateStr(now);
    const why = reason === 'missed_call'
      ? `you didn't reach the counter when ${b.token_code} was called`
      : `you weren't at ${svc.org_name} for your ${S.slotLabel(svc, Number(b.slot_index))} slot`;
    const deferrals = Number(b.deferrals);
    const canMove = deferrals < P.MAX_DEFERRALS && b.date === today;
    const pick = canMove ? await bookings.firstFree(svc, today, S.firstOpenSlotIndex(svc, today, now + P.DEFER_GAP_MIN * P.MIN)) : null;

    if (!pick) {
      await q("UPDATE bookings SET status='no_show', counter_id=NULL WHERE id=?").run(b.id);
      const { blocked } = await applyStrike(b.user_id, now);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'no_show',
        level: 'danger',
        title: `Token ${b.token_code} expired`,
        body: `Marked as a no-show because ${why}. ${blocked ? 'Booking is paused for 7 days after repeated no-shows.' : 'Repeated no-shows pause booking for 7 days.'}`,
      }]);
      return null;
    }

    const tokenNo = S.tokenNumber(svc.slot_capacity, pick.slotIndex, pick.seat);
    const code = S.tokenCode(svc.code, tokenNo);
    await q(
      `UPDATE bookings SET slot_index=?, seat=?, token_no=?, token_code=?, status='booked', counter_id=NULL,
       deferrals=deferrals+1, reminder_sent=0, away_since=NULL, checked_in_at=NULL, called_at=NULL, created_at=? WHERE id=?`,
    ).run(pick.slotIndex, pick.seat, tokenNo, code, now, b.id);
    const movesLeft = P.MAX_DEFERRALS - deferrals - 1;
    outbox.push([b.user_id, {
      bookingId: Number(b.id),
      type: 'token_moved',
      level: 'warning',
      title: `Token moved: ${b.token_code} → ${code}`,
      body: `Because ${why}, your token moved to ${S.slotLabel(svc, pick.slotIndex)}. Everyone else keeps their place. ${movesLeft > 0 ? `${movesLeft} more move left before it expires.` : 'Next miss will expire it.'}`,
    }]);
    return code;
  }

  async function updateLocation({ userId, bookingId, lat, lng, accuracy, now }) {
    if (accuracy > P.MAX_GPS_ACCURACY_M) {
      throw errors.unprocessable(
        `Location is too imprecise (±${Math.round(accuracy)} m). Turn on precise location and try again.`,
        'LOW_ACCURACY',
      );
    }
    const outbox = [];
    const result = await tx(db, async () => {
      const b = await bookings.requireOwned(userId, bookingId);
      if (!['booked', 'checked_in', 'called'].includes(b.status)) throw errors.conflict('This token is no longer active.');
      const org = await q('SELECT * FROM organizations WHERE id=?').get(b.org_id);
      const presence = assessPresence(org, { lat, lng, accuracy }, { toleranceCapM: P.GPS_TOLERANCE_CAP_M, awayFactor: P.AWAY_FACTOR });
      await q('UPDATE bookings SET last_distance_m=?, last_seen_at=? WHERE id=?').run(presence.distance, now, b.id);

      const slotStart = S.slotStartMs(org, b.date, Number(b.slot_index));
      const opensAt = slotStart - P.CHECKIN_EARLY_MIN * P.MIN;
      let status = b.status;
      let message;

      if (b.date !== S.toDateStr(now)) {
        message = `This token is for ${b.date}. Check-in opens that day.`;
      } else if (b.status === 'booked' && presence.inside && now >= opensAt) {
        await q("UPDATE bookings SET status='checked_in', checked_in_at=?, away_since=NULL WHERE id=?").run(now, b.id);
        status = 'checked_in';
        message = "Checked in — you're in the live queue.";
        outbox.push([userId, {
          bookingId: Number(b.id),
          type: 'checked_in',
          level: 'success',
          title: `Checked in: ${b.token_code}`,
          body: `You're at ${org.name}. Keep this page open — we'll call you to a counter.`,
        }]);
      } else if (b.status === 'booked' && presence.inside) {
        message = `You're early. Check-in opens at ${S.clockLabel(opensAt)}.`;
      } else if (b.status === 'checked_in' && presence.away) {
        await q("UPDATE bookings SET status='booked', away_since=?, checked_in_at=NULL WHERE id=?").run(now, b.id);
        status = 'booked';
        const deadline = graceDeadline({ ...b, away_since: now }, slotStart);
        message = `You left ${org.name}. Return by ${S.clockLabel(deadline)} to keep your token.`;
        outbox.push([userId, {
          bookingId: Number(b.id),
          type: 'left_premises',
          level: 'warning',
          title: `You left ${org.name}`,
          body: `Token ${b.token_code} is on hold. Come back by ${S.clockLabel(deadline)} or it moves to a later slot.`,
        }]);
      } else if (presence.inside) {
        message = "You're on-site.";
      } else {
        message = `You're ${formatDistance(presence.distance)} from ${org.name}.`;
      }
      return { bookingId: Number(b.id), orgId: Number(org.id), distanceM: presence.distance, inside: presence.inside, status, message };
    });
    await notifier.flush(outbox, [result.orgId]);
    return result;
  }

  /**
   * Expire live tokens from earlier days — but only once their slot ended well
   * in the past, so 24-hour centres keep serving people across midnight.
   * Absent visitors get a strike; people who were present do not.
   */
  async function expirePastDays(now, today, outbox, orgs) {
    const rows = await q(
      `SELECT b.*, o.open_min, o.slot_minutes FROM bookings b JOIN organizations o ON o.id = b.org_id
       WHERE b.date < ? AND b.status IN ('booked','checked_in','called')`,
    ).all(today);
    for (const b of rows) {
      if (now < S.slotEndMs(b, b.date, Number(b.slot_index)) + P.EXPIRE_AFTER_SLOT_MIN * P.MIN) continue;
      await q("UPDATE bookings SET status='no_show', counter_id=NULL WHERE id=?").run(b.id);
      const absent = b.status === 'booked';
      if (absent) await applyStrike(b.user_id, now);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'no_show',
        level: absent ? 'danger' : 'info',
        title: `Token ${b.token_code} expired`,
        body: absent
          ? 'You did not check in for this appointment. Repeated no-shows pause booking for 7 days.'
          : 'This token was not completed before the service day ended. Please book a new one if you still need help.',
      }]);
      orgs.add(Number(b.org_id));
    }
  }

  /** Location check-ins with no fresh GPS fix go back on hold (grace period applies). Desk check-ins are exempt. */
  async function holdStalePresence(now, today, outbox, orgs) {
    const staleBefore = now - P.PRESENCE_STALE_MIN * P.MIN;
    const rows = await q(
      `SELECT * FROM bookings WHERE date=? AND status='checked_in' AND last_seen_at IS NOT NULL AND last_seen_at < ?`,
    ).all(today, staleBefore);
    for (const b of rows) {
      await q("UPDATE bookings SET status='booked', away_since=?, checked_in_at=NULL, reminder_sent=1 WHERE id=?").run(now, b.id);
      outbox.push([b.user_id, {
        bookingId: Number(b.id),
        type: 'left_premises',
        level: 'warning',
        title: `We lost your location — ${b.token_code} on hold`,
        body: `Open SmartQueue and tap "Check in with location" within ${P.GRACE_MIN} min to keep your place.`,
      }]);
      orgs.add(Number(b.org_id));
    }
  }

  /** Periodic job: reminders, deferrals, stale presence and expiry of previous days. */
  async function runMonitor(now) {
    const today = S.toDateStr(now);
    const outbox = [];
    const orgs = new Set();
    await tx(db, async () => {
      await expirePastDays(now, today, outbox, orgs);
      await holdStalePresence(now, today, outbox, orgs);
      await q(`UPDATE counters SET current_booking_id=NULL WHERE current_booking_id IS NOT NULL
         AND current_booking_id NOT IN (SELECT id FROM bookings WHERE status='called')`).run();

      const due = await q(
        `SELECT b.*, o.open_min, o.slot_minutes, o.name AS org_name FROM bookings b
         JOIN organizations o ON o.id = b.org_id WHERE b.date=? AND b.status='booked'`,
      ).all(today);
      for (const b of due) {
        const slotStart = S.slotStartMs(b, b.date, Number(b.slot_index));
        const deadline = graceDeadline(b, slotStart);
        if (now >= deadline) {
          await deferInTx(b, now, 'absent', outbox);
          orgs.add(Number(b.org_id));
        } else if (!b.reminder_sent && now >= slotStart - P.REMIND_BEFORE_MIN * P.MIN) {
          await q('UPDATE bookings SET reminder_sent=1 WHERE id=?').run(b.id);
          const where = b.last_distance_m !== null
            ? `Your last location was ${formatDistance(Number(b.last_distance_m))} away.`
            : "We haven't received your location yet.";
          outbox.push([b.user_id, {
            bookingId: Number(b.id),
            type: 'reminder',
            level: 'warning',
            title: `${b.token_code} is at ${S.slotLabel(b, Number(b.slot_index))}`,
            body: `You're not checked in at ${b.org_name}. ${where} Check in by ${S.clockLabel(deadline)} or your token moves to a later slot.`,
          }]);
        }
      }
    });
    await notifier.flush(outbox, [...orgs]);
    return { notified: outbox.length, orgsTouched: orgs.size };
  }

  return Object.freeze({ updateLocation, runMonitor, deferInTx });
}

module.exports = { createPresenceService };
