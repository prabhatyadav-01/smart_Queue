'use strict';

const { stmt } = require('../db');

/**
 * Persists in-app notifications and pushes them live over SSE.
 *
 * Services collect messages in an "outbox" while inside a transaction and
 * call flush() only after COMMIT, so a rolled-back change never produces a
 * notification.
 */
function createNotifier({ db, events }) {
  async function notify(userId, { bookingId = null, type, level = 'info', title, body }, now = Date.now()) {
    const info = await stmt(
      db,
      'INSERT INTO notifications (user_id, booking_id, type, level, title, body, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(userId, bookingId, type, level, title, body, now);
    const notification = { id: Number(info.lastInsertRowid), bookingId, type, level, title, body, createdAt: now, read: false };
    events.emitUser(userId, { kind: 'notification', notification });
    return notification;
  }

  async function flush(outbox, orgIds = []) {
    const users = new Set();
    for (const [userId, message] of outbox) {
      await notify(userId, message);
      users.add(userId);
    }
    for (const userId of users) events.emitUser(userId, { kind: 'bookings' });
    for (const orgId of orgIds) events.emitOrg(orgId);
  }

  async function list(userId, limit = 30) {
    const rows = await stmt(db, 'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(userId, limit);
    return rows.map((n) => ({
      id: n.id,
      bookingId: n.booking_id,
      type: n.type,
      level: n.level,
      title: n.title,
      body: n.body,
      createdAt: n.created_at,
      read: n.read_at !== null,
    }));
  }

  async function markAllRead(userId, now = Date.now()) {
    await stmt(db, 'UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now, userId);
  }

  return Object.freeze({ notify, flush, list, markAllRead });
}

module.exports = { createNotifier };
