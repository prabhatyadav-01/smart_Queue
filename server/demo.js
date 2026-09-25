'use strict';

const { stmt } = require('./db');
const { AppError } = require('./errors');

const TICK_MS = 6000;
const MAX_DEMO_WAITING = 10;
const ARRIVAL_PROBABILITY = 0.6;
const MIN_DEMO_SERVICE_MS = 45_000;
const DEMO_SERVICE_JITTER_MS = 60_000;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Development-only traffic simulator so the live queue, counters and charts
 * have motion during a demo. Kiosk walk-ins arrive at open organisations and
 * counters serve them. Real users' tokens are called by the simulator too
 * (so you receive the "your turn" notification) but are only completed by staff.
 */
function startDemoSimulator({ db, services, systemUserId }) {
  const tick = async () => {
    const now = Date.now();
    try {
      const orgs = await services.stats.listOrgs(now);
      for (const org of orgs) {
        if (!org.openNow) continue;
        try {
          if (org.waiting < MAX_DEMO_WAITING && Math.random() < ARRIVAL_PROBABILITY && org.services.length > 0) {
            await services.bookings.create({
              userId: systemUserId,
              serviceId: pick(org.services).id,
              kind: 'walkin',
              now,
              system: true,
              status: 'checked_in',
            });
          }
          await advanceCounters(org.id, now);
        } catch (err) {
          if (!(err instanceof AppError)) console.error('[demo] org tick failed', err);
        }
      }
    } catch (err) {
      console.error('[demo] tick failed', err);
    }
  };

  async function advanceCounters(orgId, now) {
    const counters = await stmt(db,
      `SELECT c.id, c.status, b.user_id, b.called_at FROM counters c
       LEFT JOIN bookings b ON b.id=c.current_booking_id AND b.status='called' WHERE c.org_id=?`).all(orgId);
    for (const c of counters) {
      if (c.status !== 'open') continue;
      if (c.called_at === null) {
        await services.counters.callNext({ orgId, counterId: c.id, now });
      } else if (Number(c.user_id) === Number(systemUserId) && now - Number(c.called_at) > MIN_DEMO_SERVICE_MS + Math.random() * DEMO_SERVICE_JITTER_MS) {
        await services.counters.complete({ orgId, counterId: c.id, now });
      }
    }
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick().catch(() => {});
  return () => clearInterval(timer);
}

module.exports = { startDemoSimulator };
