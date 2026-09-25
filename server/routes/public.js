'use strict';

const express = require('express');
const P = require('../policy');
const S = require('../lib/slots');
const { errors } = require('../errors');
const { z, parse, id, ok } = require('../lib/validate');

const slotsQuery = z.object({ date: z.string().optional() });
const streamQuery = z.object({ org: id.optional() });

function publicRoutes({ services, events, googleClientId, supabaseUrl, supabaseAnonKey, demoMode }) {
  const r = express.Router();

  r.get('/config', (_req, res) => {
    res.json(ok({
      googleClientId: googleClientId || null,
      supabaseUrl: supabaseUrl || null,
      supabaseAnonKey: supabaseAnonKey || null,
      demoMode,
      policy: {
        maxActiveBookings: P.MAX_ACTIVE_BOOKINGS,
        maxReschedules: P.MAX_RESCHEDULES,
        maxDeferrals: P.MAX_DEFERRALS,
        graceMin: P.GRACE_MIN,
        remindBeforeMin: P.REMIND_BEFORE_MIN,
        checkinEarlyMin: P.CHECKIN_EARLY_MIN,
        horizonDays: P.BOOKING_HORIZON_DAYS,
      },
    }));
  });

  r.get('/orgs', async (_req, res) => {
    res.json(ok({ orgs: await services.stats.listOrgs(Date.now()) }));
  });

  r.get('/orgs/:orgId/queue', async (req, res) => {
    const orgId = parse(id, req.params.orgId);
    res.json(ok(await services.stats.snapshot(orgId, Date.now())));
  });

  r.get('/services/:serviceId/slots', async (req, res) => {
    const serviceId = parse(id, req.params.serviceId);
    const now = Date.now();
    const { date } = parse(slotsQuery, req.query);
    res.json(ok(await services.bookings.slots(serviceId, date || S.toDateStr(now), now)));
  });

  /** Live updates: public queue for ?org=, plus private notifications when signed in. */
  r.get('/stream', async (req, res) => {
    const { org } = parse(streamQuery, req.query);
    if (!events.canSubscribe(req.ip)) throw errors.conflict('Too many open live connections.', 'TOO_MANY_STREAMS');
    if (org) await services.stats.snapshot(org, Date.now()); // 404s early for unknown orgs
    const userId = req.auth?.mfaOk ? req.auth.user.id : null;
    await events.subscribe(req, res, { orgId: org || null, userId });
  });

  return r;
}

module.exports = { publicRoutes };
