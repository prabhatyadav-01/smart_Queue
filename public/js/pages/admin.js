import { initNav } from '../core/nav.js';
import { initAnchorLinks, initMagnetic, initHover3D } from '../core/motion.js';
import { initParticleDrift } from '../core/particle-drift.js';
import { api, post } from '../core/api.js';
import { connectLive, renderLiveStatus } from '../core/live.js';
import {
  $, $$, esc, icon, fmt, CATEGORY, STATUS, toast, stateHTML, renderError, skeletons, debounce, setBusy, animateNumber,
} from '../core/ui.js';

const ORG_KEY = 'sq-admin-org';
const STATUS_COLORS = {
  booked: 'var(--chart-2)',
  checked_in: 'var(--chart-1)',
  called: 'var(--chart-4)',
  done: 'var(--chart-3)',
  no_show: 'var(--danger)',
  cancelled: 'var(--faint)',
};

const state = { me: null, orgs: [], orgId: null, data: null, disconnect: null };
const isAdmin = () => state.me?.role === 'admin';
const org = () => state.orgs.find((o) => o.id === state.orgId);

/* ---------------- Rendering ---------------- */
function renderKpis(ov, snap) {
  const el = $('[data-kpis]');
  const items = [
    ['total', 'Tokens today', ov.total],
    ['waiting', 'Waiting', snap.totals.waiting],
    ['present', 'On site', snap.totals.present],
    ['served', 'Served', snap.totals.served],
    ['avg', 'Avg wait (min)', snap.totals.avgWaitMin ?? 0],
    ['noshow', 'No-show rate %', ov.noShowRate],
  ];
  if (!el.firstElementChild) {
    el.innerHTML = items.map(([id, label]) => `<div class="kpi card"><span>${label}</span><b class="tnum" data-kpi="${id}">0</b></div>`).join('');
  }
  for (const [id, , value] of items) animateNumber($(`[data-kpi="${id}"]`, el), value, { decimals: id === 'avg' ? 1 : 0 });
}

function counterCard(c, stats) {
  const s = stats.find((x) => x.id === c.id) || { served: 0, avgHandleMin: null };
  const serving = c.serving;
  const elapsed = serving ? Math.floor((Date.now() - serving.sinceMs) / 1000) : 0;
  const statusBtns = ['open', 'paused', 'closed'].map((st) =>
    `<button type="button" data-act="status" data-status="${st}" aria-pressed="${c.status === st}">${st}</button>`).join('');
  return `<div class="acounter s-${c.status} ${serving ? 'busy' : ''}" data-cid="${c.id}">
    <div class="row"><strong>${esc(c.name)}</strong><span class="spacer"></span><span class="muted small">${s.served} served${s.avgHandleMin ? ` · ${s.avgHandleMin} min avg` : ''}</span></div>
    <div class="acounter-code mono ${serving ? '' : 'idle'}">${serving ? esc(serving.tokenCode) : 'Idle'}</div>
    <div class="muted small" data-elapsed="${serving ? serving.sinceMs : ''}">${serving ? `${esc(serving.service)} · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : c.status === 'open' ? 'Ready for the next token' : 'Not taking tokens'}</div>
    <div class="row wrap acounter-actions">
      ${serving
        ? `<button type="button" class="btn btn-primary btn-sm" data-act="complete">${icon('check')}Complete</button>
           <button type="button" class="btn btn-sm" data-act="recall">${icon('bell')}Recall</button>
           <button type="button" class="btn btn-ghost btn-sm btn-danger" data-act="no-show">No-show</button>`
        : `<button type="button" class="btn btn-primary btn-sm" data-act="call" ${c.status === 'open' ? '' : 'disabled'}>${icon('users')}Call next</button>`}
      <span class="spacer"></span>
      <div class="mini-seg" role="group" aria-label="Counter status">${statusBtns}</div>
    </div>
  </div>`;
}

function renderCounters(snap, ov) {
  $('[data-counters]').innerHTML = snap.counters.length
    ? snap.counters.map((c) => counterCard(c, ov.counters)).join('')
    : stateHTML('empty', { title: 'No counters configured' });
}

function renderQueue(rows) {
  $('[data-queue-count]').textContent = `${rows.length} active`;
  const el = $('[data-queue]');
  if (!rows.length) {
    el.innerHTML = stateHTML('empty', { title: 'Queue is empty', message: 'Tokens booked for today will appear here.', iconName: 'ticket' });
    return;
  }
  el.innerHTML = `<table class="table">
    <thead><tr><th>Token</th><th>Visitor</th><th>Service</th><th>Slot</th><th>Status</th><th>Location</th><th></th></tr></thead>
    <tbody>${rows.map((r) => {
      const st = STATUS[r.status] || { label: r.status, tone: '' };
      const loc = r.distanceM === null ? '<span class="muted">—</span>' : `${esc(fmt.distance(r.distanceM))}<small class="muted"> · ${esc(fmt.relative(r.lastSeenAt))}</small>`;
      return `<tr>
        <td class="mono strong">${esc(r.tokenCode)}${r.deferrals ? ` <span class="pill warn">moved ${r.deferrals}×</span>` : ''}</td>
        <td>${esc(r.name)}<small class="muted block">${esc(r.email)}</small></td>
        <td>${esc(r.service)}</td>
        <td class="mono">${esc(r.slotTime)}</td>
        <td><span class="pill ${st.tone}">${esc(st.label)}</span>${r.counter ? `<small class="muted block">${esc(r.counter)}</small>` : ''}</td>
        <td>${loc}</td>
        <td class="right">${r.status === 'booked' ? `<button type="button" class="btn btn-sm" data-checkin="${r.id}">Desk check-in</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function renderHourly(hourly) {
  const el = $('[data-hourly]');
  if (!hourly.length) {
    el.innerHTML = stateHTML('empty', { title: 'No tokens yet today', iconName: 'chart' });
    return;
  }
  const W = 640;
  const H = 240;
  const pad = { l: 34, r: 8, t: 12, b: 28 };
  const max = Math.max(4, ...hourly.map((h) => h.booked));
  const bw = (W - pad.l - pad.r) / hourly.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens booked and served per hour">
    ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
    ${hourly.map((h, i) => {
      const x = pad.l + i * bw;
      const w = Math.max(4, bw * 0.34);
      return `<g><title>${String(h.hour).padStart(2, '0')}:00 · ${h.booked} booked · ${h.served} served</title>
        <rect class="bar-a" x="${x + bw * 0.14}" y="${y(h.booked)}" width="${w}" height="${H - pad.b - y(h.booked)}" rx="4"/>
        <rect class="bar-b" x="${x + bw * 0.14 + w + 3}" y="${y(h.served)}" width="${w}" height="${H - pad.b - y(h.served)}" rx="4"/>
        <text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${String(h.hour).padStart(2, '0')}</text></g>`;
    }).join('')}
  </svg>`;
}

function renderDonut(byStatus, total, noShowRate) {
  $('[data-noshow]').textContent = `No-show rate ${noShowRate}%`;
  const el = $('[data-donut]');
  if (!total) {
    el.innerHTML = stateHTML('empty', { title: 'Nothing to chart yet', iconName: 'chart' });
    return;
  }
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const present = Object.keys(STATUS_COLORS).filter((k) => byStatus[k]);
  const segs = present.map((k) => {
    const len = (byStatus[k] / total) * C;
    const seg = `<circle r="${R}" cx="90" cy="90" fill="none" data-color="${k}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"><title>${STATUS[k].label}: ${byStatus[k]}</title></circle>`;
    offset += len;
    return seg;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 180 180" class="donut" role="img" aria-label="Tokens by status">
      <g transform="rotate(-90 90 90)">${segs}</g>
      <text x="90" y="88" text-anchor="middle" class="donut-total">${total}</text>
      <text x="90" y="108" text-anchor="middle" class="axis">tokens</text>
    </svg>
    <ul class="donut-legend">${present.map((k) => `<li><i data-color="${k}"></i>${esc(STATUS[k].label)}<b class="tnum">${byStatus[k]}</b></li>`).join('')}</ul>`;
  $$('circle[data-color]', el).forEach((c) => c.style.setProperty('stroke', STATUS_COLORS[c.dataset.color]));
  $$('.donut-legend i', el).forEach((i) => i.style.setProperty('background', STATUS_COLORS[i.dataset.color]));
}

function renderRisk(summary, events) {
  const counts = summary.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + r.count }), {});
  $('[data-risk-summary]').innerHTML = [
    ['passed', 'Passed', 'success'], ['challenge-passed', 'Passed after check', 'accent'], ['challenged', 'Challenged', 'warn'], ['blocked', 'Blocked', 'danger'],
  ].map(([k, label, tone]) => `<div class="risk-chip ${tone}"><b class="tnum">${counts[k] || 0}</b><span>${label}</span></div>`).join('');
  const el = $('[data-risk]');
  if (!isAdmin()) {
    el.innerHTML = '<p class="muted">Only admins can see individual events.</p>';
    return;
  }
  el.innerHTML = events.length ? `<table class="table">
    <thead><tr><th>When</th><th>Action</th><th>Score</th><th>Outcome</th><th>Signals</th></tr></thead>
    <tbody>${events.map((e) => `<tr><td>${esc(fmt.relative(e.createdAt))}</td><td>${esc(e.action)}</td>
      <td class="mono">${e.score === null ? '—' : Math.round(e.score * 100)}</td>
      <td><span class="pill ${e.outcome === 'blocked' ? 'danger' : e.outcome === 'challenged' ? 'warn' : 'success'}">${esc(e.outcome)}</span></td>
      <td class="muted small">${esc(e.reasons.join(', ') || '—')}</td></tr>`).join('')}</tbody></table>`
    : stateHTML('empty', { title: 'No verification events yet', iconName: 'shield' });
}

function renderAudit(entries) {
  const el = $('[data-audit]');
  if (!isAdmin()) {
    el.innerHTML = '<p class="muted">Only admins can see the audit log.</p>';
    return;
  }
  el.innerHTML = entries.length ? `<table class="table">
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
    <tbody>${entries.map((a) => `<tr><td>${esc(fmt.relative(a.createdAt))}</td><td>${esc(a.who)}</td><td class="mono">${esc(a.action)}</td><td class="muted small">${esc(a.detail || '')}</td></tr>`).join('')}</tbody></table>`
    : stateHTML('empty', { title: 'Nothing logged yet' });
}

/* ---------------- Data ---------------- */
async function loadOverview() {
  const orgId = state.orgId;
  try {
    const data = await api(`/api/admin/orgs/${orgId}/overview`);
    if (orgId !== state.orgId) return;
    state.data = data;
    renderKpis(data.overview, data.snapshot);
    renderCounters(data.snapshot, data.overview);
    renderQueue(data.queue);
    renderHourly(data.overview.hourly);
    renderDonut(data.overview.byStatus, data.overview.total, data.overview.noShowRate);
    if (!isAdmin()) renderRisk(data.overview.risk, []);
  } catch (err) {
    renderError($('[data-counters]'), err, loadOverview);
    return;
  }
  if (isAdmin()) loadSecurity();
}
const reload = debounce(loadOverview, 400);

async function loadSecurity() {
  try {
    const [risk, audit] = await Promise.all([api('/api/admin/risk'), api('/api/admin/audit')]);
    renderRisk(state.data?.overview.risk || [], risk.events);
    renderAudit(audit.entries);
  } catch (err) {
    renderError($('[data-risk]'), err, loadSecurity);
  }
}

function selectOrg(id) {
  state.orgId = id;
  try {
    localStorage.setItem(ORG_KEY, String(id));
  } catch {
    // storage unavailable; selection just won't persist
  }
  const o = org();
  $('[data-org-title]').textContent = o.name;
  $('[data-org-cat]').textContent = `${CATEGORY[o.category].label} · ${o.hours}${o.openNow ? ' · Open now' : ' · Closed'}`;
  $('[data-kpis]').innerHTML = '';
  $('[data-counters]').innerHTML = skeletons(3, 'sk-card');
  $('[data-queue]').innerHTML = skeletons(4, 'sk-row');
  fillGeofence(o);
  state.disconnect?.();
  state.disconnect = connectLive(id, {
    onStatus: (s) => renderLiveStatus($('[data-live-status]'), s),
    onSnapshot: () => reload(),
  });
  loadOverview();
}

/* ---------------- Actions ---------------- */
function reportCounterResult(act, result) {
  if (act === 'call') {
    toast(result ? `Called ${result.tokenCode}` : 'Nobody is checked in yet', {
      type: result ? 'success' : 'info',
      body: result ? `to ${result.counter}` : 'Visitors must check in by location or at the desk.',
    });
  } else if (act === 'no-show') {
    toast(result.movedTo ? `${result.tokenCode} moved to ${result.movedTo}` : `${result.tokenCode} expired`, { type: 'warning' });
  } else if (act === 'complete') {
    toast(`${result.tokenCode} served`, { type: 'success' });
  } else if (act === 'recall') {
    toast(`Recalled ${result.tokenCode}`, { type: 'info' });
  }
}

async function counterAction(btn) {
  const cid = Number(btn.closest('[data-cid]').dataset.cid);
  const act = btn.dataset.act;
  setBusy(btn, true);
  try {
    if (act === 'status') {
      await post(`/api/admin/orgs/${state.orgId}/counters/${cid}`, { status: btn.dataset.status });
    } else {
      const { result } = await post(`/api/admin/orgs/${state.orgId}/counters/${cid}/${act}`);
      reportCounterResult(act, result);
    }
  } catch (err) {
    toast('Action failed', { body: err.message, type: 'danger' });
  } finally {
    setBusy(btn, false);
    loadOverview();
  }
}

function fillGeofence(o) {
  const form = $('[data-geofence]');
  form.lat.value = o.lat.toFixed(6);
  form.lng.value = o.lng.toFixed(6);
  form.radiusM.value = String(o.radiusM);
}

function bindGeofence() {
  const form = $('[data-geofence]');
  $('[data-use-location]').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (!('geolocation' in navigator)) return toast('Location is not available in this browser', { type: 'warning' });
    setBusy(btn, true, 'Locating…');
    navigator.geolocation.getCurrentPosition((pos) => {
      form.lat.value = pos.coords.latitude.toFixed(6);
      form.lng.value = pos.coords.longitude.toFixed(6);
      setBusy(btn, false);
      toast('Location filled in', { body: `Accuracy ±${Math.round(pos.coords.accuracy)} m. Save to apply.`, type: 'info' });
    }, (err) => {
      setBusy(btn, false);
      toast("Couldn't get your location", { body: err.message, type: 'danger' });
    }, { enableHighAccuracy: true, timeout: 20_000 });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { lat: Number(form.lat.value), lng: Number(form.lng.value), radiusM: Number(form.radiusM.value) };
    if (![body.lat, body.lng, body.radiusM].every(Number.isFinite)) return toast('Enter valid numbers', { type: 'warning' });
    const btn = $('button[type=submit]', form);
    setBusy(btn, true, 'Saving…');
    try {
      await post(`/api/admin/orgs/${state.orgId}/settings`, body);
      state.orgs = state.orgs.map((o) => (o.id === state.orgId ? { ...o, ...body } : o));
      toast('Geofence saved', { type: 'success' });
    } catch (err) {
      toast("Couldn't save", { body: err.message, type: 'danger' });
    } finally {
      setBusy(btn, false);
    }
  });
}

function bindActions() {
  $('[data-counters]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && !btn.disabled) counterAction(btn);
  });
  $('[data-queue]').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-checkin]');
    if (!btn) return;
    setBusy(btn, true);
    try {
      const { result } = await post(`/api/admin/orgs/${state.orgId}/bookings/${btn.dataset.checkin}/check-in`);
      toast(`${result.tokenCode} checked in at the desk`, { type: 'success' });
    } catch (err) {
      toast('Check-in failed', { body: err.message, type: 'danger' });
    } finally {
      loadOverview();
    }
  });
  $('[data-auto-assign]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, 'Assigning…');
    try {
      const { assigned } = await post(`/api/admin/orgs/${state.orgId}/auto-assign`);
      toast(assigned.length ? `Assigned ${assigned.length} token${assigned.length > 1 ? 's' : ''}` : 'Nothing to assign', {
        body: assigned.map((a) => `${a.tokenCode} → ${a.counter}`).join(', ') || 'No free counter, or nobody is checked in.',
        type: assigned.length ? 'success' : 'info',
      });
    } catch (err) {
      toast('Auto-assign failed', { body: err.message, type: 'danger' });
    } finally {
      setBusy(btn, false);
      loadOverview();
    }
  });
  $('[data-org]').addEventListener('change', (e) => selectOrg(Number(e.target.value)));
  $('[data-run-monitor]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, 'Checking…');
    try {
      const r = await post('/api/admin/monitor/run');
      toast('Presence check complete', { body: `${r.notified} notification${r.notified === 1 ? '' : 's'} sent.`, type: 'success' });
    } catch (err) {
      toast('Presence check failed', { body: err.message, type: 'danger' });
    } finally {
      setBusy(btn, false);
      loadOverview();
    }
  });
  bindGeofence();
  setInterval(() => {
    for (const el of $$('[data-elapsed]')) {
      const since = Number(el.dataset.elapsed);
      if (!since) continue;
      const s = Math.floor((Date.now() - since) / 1000);
      el.textContent = el.textContent.replace(/\d+m \d+s$/, `${Math.floor(s / 60)}m ${s % 60}s`);
    }
  }, 1000);
}

/* ---------------- Boot ---------------- */
function showDenied() {
  $('[data-admin-body]').hidden = true;
  $('.app-hero-actions').hidden = true;
  const denied = $('[data-denied]');
  denied.hidden = false;
  denied.innerHTML = stateHTML('error', { title: 'Staff only', message: 'This dashboard is for service-centre staff. You are signed in with a visitor account.', iconName: 'lock' });
}

async function boot() {
  state.me = await initNav({ requireAuth: true });
  initAnchorLinks();
  if (state.me.role !== 'admin' && state.me.role !== 'staff') return showDenied();
  if (!isAdmin()) {
    $$('[data-admin-only]').forEach((b) => {
      b.disabled = true;
      b.title = 'Admins only';
    });
  }
  initMagnetic();
  initHover3D();
  initParticleDrift();
  bindActions();
  try {
    const all = (await api('/api/orgs')).orgs;
    // Staff see only their assigned centre (the server enforces this too).
    state.orgs = isAdmin() ? all : all.filter((o) => o.id === state.me.orgId);
    if (!state.orgs.length) return showDenied();
  } catch (err) {
    renderError($('[data-counters]'), err, () => location.reload());
    return;
  }
  const select = $('[data-org]');
  select.innerHTML = Object.entries(CATEGORY).map(([id, c]) => `<optgroup label="${esc(c.label)}">${state.orgs
    .filter((o) => o.category === id).map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
  let saved = null;
  try {
    saved = Number(localStorage.getItem(ORG_KEY));
  } catch {
    saved = null;
  }
  const initial = state.orgs.find((o) => o.id === saved) || state.orgs.find((o) => o.openNow) || state.orgs[0];
  select.value = String(initial.id);
  selectOrg(initial.id);
}

boot();
