'use strict';

const express = require('express');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { z, parse, id, ok } = require('../lib/validate');

const ACTIONS = Object.freeze({
  call: 'callNext',
  complete: 'complete',
  'no-show': 'noShow',
  recall: 'recall',
});

const statusSchema = z.object({ status: z.enum(['open', 'paused', 'closed']) });
const settingsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(30).max(2000),
});

function adminRoutes({ db, services, auth, audit }) {
  const r = express.Router();
  const staff = auth.requireRole('staff', 'admin');
  const admin = auth.requireRole('admin');

  /** Admins may act on any organisation; staff only on the one they are assigned to. */
  async function orgIdFrom(req) {
    const orgId = parse(id, req.params.orgId);
    const exists = await stmt(db, 'SELECT 1 AS x FROM organizations WHERE id=?').get(orgId);
    if (!exists) throw errors.notFound('Organisation not found.');
    const { role, org_id: staffOrg } = req.auth.user;
    if (role !== 'admin' && Number(staffOrg) !== Number(orgId)) throw errors.forbidden('You can only manage your own service centre.');
    return orgId;
  }

  r.get('/orgs/:orgId/overview', staff, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const now = Date.now();
    res.json(ok({
      overview: await services.stats.overview(orgId, now),
      snapshot: await services.stats.snapshot(orgId, now),
      queue: await services.stats.queueTable(orgId, now),
    }));
  });

  r.post('/orgs/:orgId/counters/:counterId/:action', staff, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const counterId = parse(id, req.params.counterId);
    const method = ACTIONS[req.params.action];
    if (!method) throw errors.notFound('Unknown counter action.');
    const result = await services.counters[method]({ orgId, counterId, now: Date.now() });
    await audit(req, `counter_${req.params.action}`, `org ${orgId} counter ${counterId} ${result?.tokenCode || 'none'}`);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/counters/:counterId', staff, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const counterId = parse(id, req.params.counterId);
    const { status } = parse(statusSchema, req.body);
    const result = await services.counters.setStatus({ orgId, counterId, status });
    await audit(req, 'counter_status', `org ${orgId} counter ${counterId} → ${status}`);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/auto-assign', staff, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const result = await services.counters.autoAssign({ orgId, now: Date.now() });
    await audit(req, 'auto_assign', `org ${orgId} assigned ${result.assigned.length}`);
    res.json(ok(result));
  });

  r.post('/orgs/:orgId/bookings/:bookingId/check-in', staff, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const bookingId = parse(id, req.params.bookingId);
    const result = await services.counters.manualCheckIn({ orgId, bookingId, now: Date.now() });
    await audit(req, 'desk_check_in', result.tokenCode);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/settings', admin, async (req, res) => {
    const orgId = await orgIdFrom(req);
    const body = parse(settingsSchema, req.body);
    await stmt(db, 'UPDATE organizations SET lat=?, lng=?, radius_m=? WHERE id=?').run(body.lat, body.lng, body.radiusM, orgId);
    await audit(req, 'geofence_update', `org ${orgId} ${body.lat.toFixed(5)},${body.lng.toFixed(5)} r=${body.radiusM}`);
    res.json(ok({ orgId, ...body }));
  });

  r.post('/monitor/run', admin, async (req, res) => {
    res.json(ok(await services.presence.runMonitor(Date.now())));
  });

  r.get('/risk', admin, async (_req, res) => res.json(ok({ events: await services.stats.riskEvents() })));
  r.get('/audit', admin, async (_req, res) => res.json(ok({ entries: await services.stats.auditLog() })));

  return r;
}

module.exports = { adminRoutes };
