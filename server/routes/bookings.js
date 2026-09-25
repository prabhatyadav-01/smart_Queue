'use strict';

const express = require('express');
const { z, parse, id, ok } = require('../lib/validate');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('walkin'), serviceId: id }),
  z.object({ kind: z.literal('appointment'), serviceId: id, date: dateStr, slotIndex: z.number().int().min(0).max(1440) }),
]);
const rescheduleSchema = z.object({ date: dateStr, slotIndex: z.number().int().min(0).max(1440) });
const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000),
});

function bookingRoutes({ services, auth, requireHuman, limiters, audit }) {
  const r = express.Router();
  const signedIn = auth.requireUser;
  const userId = (req) => req.auth.user.id;

  r.get('/me/bookings', signedIn, async (req, res) => {
    res.json(ok(await services.bookings.myBookings(userId(req), Date.now())));
  });

  r.post('/bookings', signedIn, limiters.booking, requireHuman('book'), async (req, res) => {
    const body = parse(createSchema, req.body);
    const booking = await services.bookings.create({
      userId: userId(req),
      serviceId: body.serviceId,
      date: body.date,
      slotIndex: body.slotIndex,
      kind: body.kind,
      now: Date.now(),
    });
    await audit(req, 'book', `${booking.tokenCode} ${booking.date} ${booking.slotTime}`);
    res.status(201).json(ok({ booking }));
  });

  r.post('/bookings/:bookingId/reschedule', signedIn, limiters.booking, requireHuman('reschedule'), async (req, res) => {
    const bookingId = parse(id, req.params.bookingId);
    const body = parse(rescheduleSchema, req.body);
    const booking = await services.bookings.reschedule({ userId: userId(req), bookingId, ...body, now: Date.now() });
    await audit(req, 'reschedule', `${booking.tokenCode} ${booking.date} ${booking.slotTime}`);
    res.json(ok({ booking }));
  });

  r.post('/bookings/:bookingId/cancel', signedIn, limiters.booking, async (req, res) => {
    const bookingId = parse(id, req.params.bookingId);
    const booking = await services.bookings.cancel({ userId: userId(req), bookingId, now: Date.now() });
    await audit(req, 'cancel', booking.tokenCode);
    res.json(ok({ booking }));
  });

  r.post('/bookings/:bookingId/location', signedIn, limiters.location, async (req, res) => {
    const bookingId = parse(id, req.params.bookingId);
    const fix = parse(locationSchema, req.body);
    res.json(ok(await services.presence.updateLocation({ userId: userId(req), bookingId, ...fix, now: Date.now() })));
  });

  r.get('/me/notifications', signedIn, async (req, res) => {
    res.json(ok({ notifications: await services.notifier.list(userId(req)) }));
  });

  r.post('/me/notifications/read', signedIn, async (req, res) => {
    await services.notifier.markAllRead(userId(req));
    res.json(ok({}));
  });

  return r;
}

module.exports = { bookingRoutes };
