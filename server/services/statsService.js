'use strict';

const S = require('../lib/slots');
const { errors } = require('../errors');
const { stmt } = require('../db');

const toMin = (ms) => (ms === null || ms === undefined ? null : Math.round((Number(ms) / 60_000) * 10) / 10);

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function isOpenNow(org, now) {
  const m = S.minuteOfDay(now);
  return m >= org.open_min && m < org.close_min;
}

/** Read models: public live queue, organisation catalogue, admin analytics. */
function createStatsService({ db }) {
  const q = (sql) => stmt(db, sql);

  async function listOrgs(now) {
    const today = S.toDateStr(now);
    const services = await q('SELECT id, org_id, name, code, slot_capacity, avg_service_min FROM services ORDER BY id').all();
    const orgs = await q('SELECT id, name, category, address, lat, lng, radius_m, open_min, close_min, slot_minutes FROM organizations ORDER BY category, name').all();
    const waitingRows = await q("SELECT org_id, COUNT(*) AS c FROM bookings WHERE date=? AND status IN ('booked','checked_in') GROUP BY org_id").all(today);
    const countersRows = await q("SELECT org_id, COUNT(*) AS c FROM counters WHERE status='open' GROUP BY org_id").all();

    const waitingMap = new Map(waitingRows.map((r) => [Number(r.org_id), Number(r.c)]));
    const countersMap = new Map(countersRows.map((r) => [Number(r.org_id), Number(r.c)]));

    return orgs.map((o) => {
      const orgId = Number(o.id);
      const svc = services.filter((s) => Number(s.org_id) === orgId);
      const avg = svc.length ? svc.reduce((a, s) => a + Number(s.avg_service_min), 0) / svc.length : 6;
      const waiting = waitingMap.get(orgId) || 0;
      const openCounters = countersMap.get(orgId) || 0;
      return {
        id: orgId,
        name: o.name,
        category: o.category,
        address: o.address,
        lat: Number(o.lat),
        lng: Number(o.lng),
        radiusM: Number(o.radius_m),
        hours: `${S.minutesLabel(o.open_min)}–${o.close_min >= 1440 ? '24:00' : S.minutesLabel(o.close_min)}`,
        slotMinutes: Number(o.slot_minutes),
        openNow: isOpenNow(o, now),
        waiting,
        openCounters,
        estWaitMin: Math.ceil((waiting * avg) / Math.max(1, openCounters)),
        services: svc.map((s) => ({ id: Number(s.id), name: s.name, code: s.code, capacity: Number(s.slot_capacity), avgServiceMin: Number(s.avg_service_min) })),
      };
    });
  }

  async function snapshot(orgId, now) {
    const org = await q('SELECT id, name, category, address, open_min, close_min, slot_minutes FROM organizations WHERE id=?').get(orgId);
    if (!org) throw errors.notFound('Organisation not found.');
    const today = S.toDateStr(now);
    const counters = await q(
      `SELECT c.id, c.name, c.status, b.token_code, b.called_at, s.name AS service_name
       FROM counters c
       LEFT JOIN bookings b ON b.id = c.current_booking_id AND b.status='called'
       LEFT JOIN services s ON s.id = b.service_id
       WHERE c.org_id=? ORDER BY c.id`,
    ).all(orgId);
    const waiting = await q(
      `SELECT b.token_code, b.status, b.slot_index, s.code, s.name
       FROM bookings b JOIN services s ON s.id = b.service_id
       WHERE b.org_id=? AND b.date=? AND b.status IN ('booked','checked_in')
       ORDER BY b.slot_index, b.seat, b.service_id LIMIT 40`,
    ).all(orgId, today);
    const t = await q(
      `SELECT COUNT(CASE WHEN status IN ('booked','checked_in') THEN 1 END) AS waiting,
              COUNT(CASE WHEN status='checked_in' THEN 1 END) AS present,
              COUNT(CASE WHEN status='called' THEN 1 END) AS serving,
              COUNT(CASE WHEN status='done' THEN 1 END) AS served,
              COUNT(CASE WHEN status='no_show' THEN 1 END) AS no_show,
              AVG(CASE WHEN called_at IS NOT NULL THEN called_at - COALESCE(checked_in_at, created_at) END) AS avg_wait,
              AVG(CASE WHEN completed_at IS NOT NULL THEN completed_at - called_at END) AS avg_service
       FROM bookings WHERE org_id=? AND date=?`,
    ).get(orgId, today) || {};
    const recent = await q(
      "SELECT token_code FROM bookings WHERE org_id=? AND date=? AND status='done' ORDER BY completed_at DESC LIMIT 6",
    ).all(orgId, today);
    const avgSvcRow = await q('SELECT AVG(avg_service_min) AS a FROM services WHERE org_id=?').get(orgId);
    const avgSvcMin = Number(avgSvcRow?.a) || 6;
    const openCounters = counters.filter((c) => c.status === 'open').length;
    const waitingCount = Number(t.waiting) || 0;

    return {
      org: { id: Number(org.id), name: org.name, category: org.category, address: org.address, openNow: isOpenNow(org, now) },
      updatedAt: now,
      counters: counters.map((c) => ({
        id: Number(c.id),
        name: c.name,
        status: c.status,
        serving: c.token_code ? { tokenCode: c.token_code, service: c.service_name, sinceMs: Number(c.called_at) } : null,
      })),
      waiting: waiting.map((w) => ({
        tokenCode: w.token_code,
        serviceCode: w.code,
        service: w.name,
        slotTime: S.slotLabel(org, w.slot_index),
        present: w.status === 'checked_in',
      })),
      recent: recent.map((r) => r.token_code),
      totals: {
        waiting: waitingCount,
        present: Number(t.present) || 0,
        serving: Number(t.serving) || 0,
        served: Number(t.served) || 0,
        noShow: Number(t.no_show) || 0,
        openCounters,
        avgWaitMin: toMin(t.avg_wait),
        avgServiceMin: toMin(t.avg_service),
        estClearMin: Math.ceil((waitingCount * avgSvcMin) / Math.max(1, openCounters)),
      },
    };
  }

  async function overview(orgId, now) {
    const today = S.toDateStr(now);
    const statusRows = await q('SELECT status, COUNT(*) AS c FROM bookings WHERE org_id=? AND date=? GROUP BY status').all(orgId, today);
    const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.c)]));
    const hourly = await q(
      `SELECT (o.open_min + b.slot_index * o.slot_minutes) / 60 AS hour,
              COUNT(CASE WHEN b.status NOT IN ('cancelled') THEN 1 END) AS booked,
              COUNT(CASE WHEN b.status='done' THEN 1 END) AS served
       FROM bookings b JOIN organizations o ON o.id=b.org_id
       WHERE b.org_id=? AND b.date=? GROUP BY (o.open_min + b.slot_index * o.slot_minutes) / 60 ORDER BY hour`,
    ).all(orgId, today);
    const counters = await q(
      `SELECT c.id, c.name, c.status, COUNT(b.id) AS served, AVG(b.completed_at - b.called_at) AS avg_handle
       FROM counters c LEFT JOIN bookings b ON b.counter_id=c.id AND b.date=? AND b.status='done'
       WHERE c.org_id=? GROUP BY c.id, c.name, c.status ORDER BY c.id`,
    ).all(today, orgId);
    const risk = await q(
      'SELECT verdict, outcome, COUNT(*) AS c FROM risk_events WHERE created_at > ? GROUP BY verdict, outcome',
    ).all(now - 24 * 3600_000);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const finished = (byStatus.done || 0) + (byStatus.no_show || 0);
    return {
      date: today,
      byStatus,
      total,
      noShowRate: finished ? Math.round(((byStatus.no_show || 0) / finished) * 100) : 0,
      hourly: hourly.map((h) => ({ hour: Number(h.hour), booked: Number(h.booked), served: Number(h.served) })),
      counters: counters.map((c) => ({ id: Number(c.id), name: c.name, status: c.status, served: Number(c.served), avgHandleMin: toMin(c.avg_handle) })),
      risk: risk.map((r) => ({ verdict: r.verdict, outcome: r.outcome, count: Number(r.c) })),
    };
  }

  async function queueTable(orgId, now) {
    const rows = await q(
      `SELECT b.id, b.token_code, b.status, b.kind, b.slot_index, b.deferrals, b.last_distance_m, b.last_seen_at,
              u.name, u.email, u.role, s.name AS service, c.name AS counter, o.open_min, o.slot_minutes
       FROM bookings b JOIN users u ON u.id=b.user_id JOIN services s ON s.id=b.service_id
       JOIN organizations o ON o.id=b.org_id LEFT JOIN counters c ON c.id=b.counter_id
       WHERE b.org_id=? AND b.date=? AND b.status IN ('booked','checked_in','called')
       ORDER BY b.slot_index, b.seat, b.service_id LIMIT 200`,
    ).all(orgId, S.toDateStr(now));

    return rows.map((r) => ({
      id: Number(r.id),
      tokenCode: r.token_code,
      status: r.status,
      kind: r.kind,
      slotTime: S.slotLabel(r, r.slot_index),
      deferrals: Number(r.deferrals),
      distanceM: r.last_distance_m !== null ? Number(r.last_distance_m) : null,
      lastSeenAt: r.last_seen_at !== null ? Number(r.last_seen_at) : null,
      name: r.role === 'system' ? 'Walk-in (kiosk)' : r.name,
      email: r.role === 'system' ? '' : maskEmail(r.email),
      service: r.service,
      counter: r.counter,
    }));
  }

  async function riskEvents(limit = 40) {
    const rows = await q('SELECT * FROM risk_events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      score: r.score !== null ? Number(r.score) : null,
      verdict: r.verdict,
      outcome: r.outcome,
      reasons: r.reasons ? r.reasons.split(',') : [],
      createdAt: Number(r.created_at),
    }));
  }

  async function auditLog(limit = 40) {
    const rows = await q(
      `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`,
    ).all(limit);
    return rows.map((a) => ({
      id: Number(a.id),
      action: a.action,
      detail: a.detail,
      who: a.email ? maskEmail(a.email) : 'system',
      createdAt: Number(a.created_at),
    }));
  }

  return Object.freeze({ listOrgs, snapshot, overview, queueTable, riskEvents, auditLog });
}

module.exports = { createStatsService, maskEmail };
