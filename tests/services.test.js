'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupServices } = require('./helpers');

// Org 1 = Regional Passport Office (09:00–17:00, 15-min slots). Service 1 = Passport Application (code P, 6 seats/slot).
const ORG = 1;
const SVC = 1;
const OFFICE = { lat: 17.4399, lng: 78.4636 };
const FAR = { lat: 17.5, lng: 78.5 };
const DATE = '2026-03-10';
const at = (h, m) => new Date(2026, 2, 10, h, m).getTime();

const book = async (services, userId, slotIndex, now = at(8, 0)) => {
  const uid = typeof userId.then === 'function' ? await userId : userId;
  return services.bookings.create({ userId: uid, serviceId: SVC, date: DATE, slotIndex, kind: 'appointment', now });
};

const checkIn = async (services, userId, bookingId, now) => {
  const uid = typeof userId.then === 'function' ? await userId : userId;
  return services.presence.updateLocation({ userId: uid, bookingId, ...OFFICE, accuracy: 15, now });
};

test('token number is derived from the chosen slot and seat', async () => {
  const { services, addUser } = await setupServices();
  const b = await book(services, await addUser('a@x.io'), 4);
  assert.equal(b.tokenCode, 'P-025');
  assert.equal(b.slotTime, '10:00');
});

test('a full slot rejects further bookings (capacity enforced)', async () => {
  const { services, addUser } = await setupServices();
  for (let i = 0; i < 6; i++) await book(services, await addUser(`u${i}@x.io`), 4);
  await assert.rejects(async () => book(services, await addUser('late@x.io'), 4), { code: 'SLOT_FULL' });
});

test('rescheduling changes only the rescheduling user\'s token', async () => {
  const { services, addUser } = await setupServices();
  const a = await addUser('a@x.io');
  const b = await addUser('b@x.io');
  const tokenA = await book(services, a, 4);
  const tokenB = await book(services, b, 4);
  assert.equal(tokenB.tokenCode, 'P-026');
  const moved = await services.bookings.reschedule({ userId: a, bookingId: tokenA.id, date: DATE, slotIndex: 8, now: at(8, 5) });
  assert.equal(moved.tokenCode, 'P-049');
  assert.equal(moved.slotTime, '11:00');
  assert.equal((await services.bookings.viewById(tokenB.id, at(8, 5))).tokenCode, 'P-026');
  // the vacated seat is reusable
  assert.equal((await book(services, await addUser('c@x.io'), 4)).tokenCode, 'P-025');
});

test('reschedule limit is enforced', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  for (const slot of [5, 6, 7]) await services.bookings.reschedule({ userId: u, bookingId: t.id, date: DATE, slotIndex: slot, now: at(8, 0) });
  await assert.rejects(
    async () => services.bookings.reschedule({ userId: u, bookingId: t.id, date: DATE, slotIndex: 9, now: at(8, 0) }),
    { code: 'LIMIT_RESCHEDULE' },
  );
});

test('walk-in token lands in the current slot', async () => {
  const { services, addUser } = await setupServices();
  const t = await services.bookings.create({ userId: await addUser('w@x.io'), serviceId: SVC, kind: 'walkin', now: at(10, 5) });
  assert.equal(t.slotTime, '10:00');
  assert.equal(t.date, DATE);
});

test('one live token per user per place per day; past slots rejected', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  await book(services, u, 4);
  await assert.rejects(async () => book(services, u, 6), { code: 'DUPLICATE_BOOKING' });
  await assert.rejects(async () => book(services, await addUser('b@x.io'), 1, at(10, 0)), /already passed/);
});

test('cannot book two different slots at the same time across places', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('simultaneous@x.io');
  await book(services, u, 4); // Org 1 at 10:00
  // Org 2, slot 8 is also at 10:00
  await assert.rejects(
    async () => services.bookings.create({ userId: u, serviceId: 4, date: DATE, slotIndex: 8, kind: 'appointment', now: at(8, 0) }),
    { code: 'TIME_CONFLICT' },
  );
});

test('cannot book multiple active tokens for the same organisation across days', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('multiday@x.io');
  await book(services, u, 4); // Booked for DATE
  await assert.rejects(
    async () => services.bookings.create({ userId: u, serviceId: 1, date: '2026-03-11', slotIndex: 4, kind: 'appointment', now: at(8, 0) }),
    { code: 'DUPLICATE_BOOKING' },
  );
});

test('user paused after no-shows cannot book', async () => {
  const { db, services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  await db.run('UPDATE users SET blocked_until=? WHERE id=?', at(23, 0), u);
  await assert.rejects(async () => book(services, u, 4), { code: 'BOOKING_SUSPENDED' });
});

test('location inside the geofence checks in; far away does not', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  const far = await services.presence.updateLocation({ userId: u, bookingId: t.id, ...FAR, accuracy: 20, now: at(9, 50) });
  assert.equal(far.inside, false);
  assert.equal(far.status, 'booked');
  const near = await checkIn(services, u, t.id, at(9, 50));
  assert.equal(near.inside, true);
  assert.equal(near.status, 'checked_in');
});

test('imprecise GPS fixes are rejected', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  await assert.rejects(
    async () => services.presence.updateLocation({ userId: u, bookingId: t.id, ...OFFICE, accuracy: 900, now: at(9, 50) }),
    { code: 'LOW_ACCURACY' },
  );
});

test('leaving the premises puts a checked-in token on hold', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  await checkIn(services, u, t.id, at(9, 50));
  const left = await services.presence.updateLocation({ userId: u, bookingId: t.id, ...FAR, accuracy: 20, now: at(9, 55) });
  assert.equal(left.status, 'booked');
  assert.equal((await services.notifier.list(u))[0].type, 'left_premises');
});

test('reminder is sent once before the slot when the user is not checked in', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  await book(services, u, 4);
  await services.presence.runMonitor(at(9, 46));
  await services.presence.runMonitor(at(9, 47));
  const notes = await services.notifier.list(u);
  assert.equal(notes.filter((n) => n.type === 'reminder').length, 1);
});

test('absent user is moved to a later slot; other users keep their tokens', async () => {
  const { services, addUser } = await setupServices();
  const a = await addUser('a@x.io');
  const b = await addUser('b@x.io');
  const tA = await book(services, a, 4);
  const tB = await book(services, b, 4);
  await checkIn(services, b, tB.id, at(9, 55));

  await services.presence.runMonitor(at(10, 11));

  const movedA = await services.bookings.viewById(tA.id, at(10, 11));
  assert.equal(movedA.status, 'booked');
  assert.equal(movedA.deferrals, 1);
  assert.equal(movedA.slotTime, '10:15');
  assert.equal(movedA.tokenCode, 'P-031');
  assert.equal((await services.bookings.viewById(tB.id, at(10, 11))).tokenCode, 'P-026');
  assert.equal((await services.notifier.list(a))[0].type, 'token_moved');
});

test('counter calls the earliest *present* token, skipping absent ones', async () => {
  const { services, addUser } = await setupServices();
  const absent = await addUser('absent@x.io');
  const present = await addUser('present@x.io');
  await book(services, absent, 3);
  const tP = await book(services, present, 4);
  await checkIn(services, present, tP.id, at(9, 40));
  const r = await services.counters.callNext({ orgId: ORG, counterId: 1, now: at(9, 45) });
  assert.equal(r.tokenCode, tP.tokenCode);
  assert.equal((await services.notifier.list(present))[0].type, 'called');
  await assert.rejects(async () => services.counters.callNext({ orgId: ORG, counterId: 1, now: at(9, 46) }), { code: 'COUNTER_BUSY' });
  await services.counters.complete({ orgId: ORG, counterId: 1, now: at(9, 50) });
  assert.equal((await services.bookings.viewById(tP.id, at(9, 50))).status, 'done');
});

test('auto-assign fills idle counters, least-loaded first', async () => {
  const { services, addUser } = await setupServices();
  for (let i = 0; i < 3; i++) {
    const u = await addUser(`p${i}@x.io`);
    const t = await book(services, u, 4);
    await checkIn(services, u, t.id, at(9, 40));
  }
  const { assigned } = await services.counters.autoAssign({ orgId: ORG, now: at(9, 45) });
  assert.equal(assigned.length, 3);
  assert.deepEqual(assigned.map((a) => a.tokenCode), ['P-025', 'P-026', 'P-027']);
});

test('missed calls move the token, then expire it with a strike', async () => {
  const { db, services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  const cycle = async (minute) => {
    await checkIn(services, u, t.id, at(10, minute));
    await services.counters.callNext({ orgId: ORG, counterId: 1, now: at(10, minute) });
    return services.counters.noShow({ orgId: ORG, counterId: 1, now: at(10, minute + 1) });
  };
  assert.ok((await cycle(0)).movedTo);
  assert.ok((await cycle(5)).movedTo);
  assert.equal((await cycle(10)).movedTo, null);
  assert.equal((await services.bookings.viewById(t.id, at(10, 20))).status, 'no_show');
  const userRow = await db.get('SELECT strikes FROM users WHERE id=?', u);
  assert.equal(Number(userRow.strikes), 1);
});

test('24-hour centre keeps serving across midnight; stale tokens expire later with a notice', async () => {
  const { services, addUser } = await setupServices();
  const HOSPITAL = 4;
  const u = await addUser('night@x.io');
  const t = await services.bookings.create({ userId: u, serviceId: 9, date: DATE, slotIndex: 143, kind: 'appointment', now: at(23, 0) });
  assert.equal(t.slotTime, '23:50');
  await services.presence.updateLocation({ userId: u, bookingId: t.id, lat: 17.4239, lng: 78.4575, accuracy: 10, now: at(23, 45) });
  const snap = await services.stats.snapshot(HOSPITAL, at(23, 50));
  await services.counters.callNext({ orgId: HOSPITAL, counterId: snap.counters[0].id, now: at(23, 55) });

  const afterMidnight = new Date(2026, 2, 11, 0, 5).getTime();
  await services.presence.runMonitor(afterMidnight);
  assert.equal((await services.bookings.viewById(t.id, afterMidnight)).status, 'called', 'must not be expired mid-service');

  const later = new Date(2026, 2, 11, 2, 30).getTime();
  await services.presence.runMonitor(later);
  assert.equal((await services.bookings.viewById(t.id, later)).status, 'no_show');
  assert.equal((await services.notifier.list(u))[0].type, 'no_show');
});

test('location check-in without fresh fixes goes back on hold', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const t = await book(services, u, 4);
  await checkIn(services, u, t.id, at(9, 50));
  await services.presence.runMonitor(at(10, 5));
  assert.equal((await services.bookings.viewById(t.id, at(10, 5))).status, 'checked_in');
  await services.presence.runMonitor(at(10, 15));
  assert.equal((await services.bookings.viewById(t.id, at(10, 15))).status, 'booked');
  assert.equal((await services.notifier.list(u))[0].type, 'left_premises');
});

test('a checked-in visitor is not counted behind people who have not arrived', async () => {
  const { services, addUser } = await setupServices();
  await book(services, await addUser('late@x.io'), 3);
  const u = await addUser('here@x.io');
  const t = await book(services, u, 4);
  await checkIn(services, u, t.id, at(9, 40));
  assert.equal((await services.bookings.viewById(t.id, at(9, 41))).ahead, 0);
});

test('database unique index blocks double-issuing a seat', async () => {
  const { db, addUser } = await setupServices();
  const u = await addUser('a@x.io');
  const insert = (userId) => db.run(
    `INSERT INTO bookings (user_id, org_id, service_id, date, slot_index, seat, token_no, token_code, kind, status, created_at)
     VALUES (?, 1, 1, '2026-03-10', 4, 0, 25, 'P-025', 'appointment', 'booked', 0)`,
    userId,
  );
  await insert(u);
  await assert.rejects(async () => insert(u), /ux_bookings_seat|unique|duplicate/i);
});

test('live snapshot exposes no personal data', async () => {
  const { services, addUser } = await setupServices();
  const u = await addUser('secret.person@x.io');
  const t = await book(services, u, 4);
  await checkIn(services, u, t.id, at(9, 50));
  const snap = await services.stats.snapshot(ORG, at(9, 50));
  assert.equal(snap.totals.present, 1);
  assert.ok(!JSON.stringify(snap).includes('secret.person'));
});
