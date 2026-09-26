import { initNav } from '../core/nav.js';
import { initMotion, initTilt, initMagnetic, scrollToTarget } from '../core/motion.js';
import { initParticleDrift } from '../core/particle-drift.js';
import { api, post } from '../core/api.js';
import { Human } from '../core/human.js';
import { connectLive, renderLiveStatus } from '../core/live.js';
import {
  $, $$, esc, icon, CATEGORY, fmt, toast, animateNumber, rollText, stateHTML, renderError, skeletons, localDateStr, addDays, setBusy,
} from '../core/ui.js';

const SLOTS_PER_PAGE = 24;
const MAX_SAMPLES = 60;
const LANE_LIMIT = 14;

const state = {
  me: null,
  orgs: [],
  kiosk: { category: 'hospital', orgId: null, serviceId: null },
  booker: { serviceId: null, date: localDateStr(), page: 0, slots: null, selected: null },
  snapshot: null,
  samples: [],
  disconnect: null,
  knownLane: new Set(),
};

const orgById = (id) => state.orgs.find((o) => o.id === id);
const serviceById = (id) => {
  for (const o of state.orgs) {
    const s = o.services.find((x) => x.id === id);
    if (s) return { ...s, org: o };
  }
  return null;
};
const loginUrl = (next) => `/login.html?next=${encodeURIComponent(next)}`;

/* ---------------- Hero ---------------- */
function renderHeroStats() {
  const open = state.orgs.filter((o) => o.openNow);
  const waits = open.map((o) => o.estWaitMin).sort((a, b) => a - b);
  animateNumber($('[data-count="waiting"]'), state.orgs.reduce((a, o) => a + o.waiting, 0));
  animateNumber($('[data-count="counters"]'), state.orgs.reduce((a, o) => a + o.openCounters, 0));
  animateNumber($('[data-count="wait"]'), waits.length ? waits[Math.floor(waits.length / 2)] : 0);
}

/** Decorative token counts down "ahead" to demonstrate queue movement. */
function heroLoop() {
  const dots = $$('[data-hero-dots] i');
  const eta = $('[data-hero-eta]');
  const pill = $('[data-hero-status]');
  const foot = $('.token-foot span:last-child');
  let ahead = 3;
  setInterval(() => {
    ahead = ahead === 0 ? 3 : ahead - 1;
    dots.forEach((d, i) => {
      const gone = i >= ahead;
      d.style.opacity = gone ? '0' : '1';
      d.style.transform = gone ? 'scale(0.3)' : 'none';
    });
    if (ahead === 0) {
      eta.textContent = "It's your turn";
      pill.className = 'pill warn';
      pill.textContent = 'Your turn';
      foot.textContent = 'Counter 2';
    } else {
      eta.textContent = `${ahead} ahead · ~${ahead * 2} min`;
      pill.className = 'pill success';
      pill.textContent = 'Checked in';
      foot.textContent = 'Counter —';
    }
  }, 2600);
}

function heroFromSnapshot(snap) {
  const serving = snap.counters.find((c) => c.serving);
  rollText($('[data-hero-serving]'), serving ? serving.serving.tokenCode : '—');
  const lane = $('[data-hero-lane]');
  const next = snap.waiting.slice(0, 4);
  if (next.length) {
    lane.innerHTML = next.map((w) => `<li><span class="mono">${esc(w.tokenCode)}</span><i></i></li>`).join('');
  }
}

/* ---------------- 01 · Kiosk ---------------- */
function renderKiosk() {
  const cats = $('[data-kiosk-cats]');
  cats.innerHTML = Object.entries(CATEGORY).map(([id, c]) =>
    `<button type="button" role="tab" data-cat="${id}" aria-selected="${id === state.kiosk.category}">${icon(c.icon)}<span>${esc(c.label)}</span></button>`).join('');
  cats.onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.kiosk = { category: b.dataset.cat, orgId: null, serviceId: null };
    renderKiosk();
  };

  const list = state.orgs.filter((o) => o.category === state.kiosk.category);
  if (!state.kiosk.orgId && list.length) {
    const pick = list.find((o) => o.openNow) || list[0];
    state.kiosk.orgId = pick.id;
    state.kiosk.serviceId = pick.services[0].id;
  }
  const orgsEl = $('[data-kiosk-orgs]');
  orgsEl.setAttribute('role', 'radiogroup');
  orgsEl.innerHTML = list.map((o) => `
    <button type="button" class="org-opt" role="radio" aria-checked="${o.id === state.kiosk.orgId}" data-org="${o.id}">
      <span class="org-ico">${icon(CATEGORY[o.category].icon)}</span>
      <span><span class="org-name">${esc(o.name)}</span><span class="org-meta">${esc(o.address)} · ${esc(o.hours)}</span></span>
      <span class="org-side">${o.openNow ? `<b class="tnum">${o.waiting}</b>waiting` : '<span class="pill">Closed</span>'}</span>
    </button>`).join('');
  orgsEl.onclick = (e) => {
    const b = e.target.closest('[data-org]');
    if (!b) return;
    const org = orgById(Number(b.dataset.org));
    state.kiosk.orgId = org.id;
    state.kiosk.serviceId = org.services[0].id;
    renderKiosk();
  };

  const org = orgById(state.kiosk.orgId);
  $('[data-kiosk-services]').innerHTML = org ? org.services.map((s) =>
    `<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${s.id === state.kiosk.serviceId}">${esc(s.name)}</button>`).join('') : '';
  $('[data-kiosk-services]').onclick = (e) => {
    const b = e.target.closest('[data-svc]');
    if (!b) return;
    state.kiosk.serviceId = Number(b.dataset.svc);
    renderKiosk();
  };
  renderKioskResult();
}

async function renderKioskResult() {
  const el = $('[data-kiosk-result]');
  const svc = serviceById(state.kiosk.serviceId);
  if (!svc) {
    el.innerHTML = stateHTML('empty', { title: 'Pick a place to see the next token' });
    return;
  }
  el.innerHTML = `<div class="ticket">${skeletons(1, 'sk-code')}<div class="stack">${skeletons(3)}</div></div>`;
  const requested = svc.id;
  let data;
  try {
    data = await api(`/api/services/${svc.id}/slots?date=${localDateStr()}`);
  } catch (err) {
    renderError(el, err, renderKioskResult);
    return;
  }
  if (state.kiosk.serviceId !== requested) return; // user moved on
  const next = data.slots.find((s) => s.available > 0);
  if (!next) {
    el.innerHTML = stateHTML('empty', { title: 'No more tokens today', message: 'Book an appointment for another day instead.', actionLabel: 'Book another day', iconName: 'calendar' });
    $('[data-state-action]', el).onclick = () => {
      state.booker.serviceId = svc.id;
      state.booker.date = addDays(localDateStr(), 1);
      renderBooker();
      scrollToTarget('#book');
    };
    return;
  }
  const signed = Boolean(state.me);
  el.innerHTML = `
    <div class="ticket">
      <div><div class="ticket-label">Next token</div><div class="ticket-code" data-kiosk-code>${esc(next.nextToken)}</div></div>
      <div class="ticket-meta">
        <span class="row">${icon('clock')} Slot ${esc(next.time)} · ${svc.org.estWaitMin > 0 ? `about ${esc(fmt.minutes(svc.org.estWaitMin))} wait` : 'no wait right now'}</span>
        <span class="row">${icon('pin')} ${esc(svc.org.name)}</span>
        <span class="row">${icon('users')} ${svc.org.waiting} in the queue now</span>
      </div>
      <div class="ticket-cta">
        ${signed
          ? '<button type="button" class="btn btn-primary" data-magnetic data-take>Get this token</button>'
          : `<a class="btn btn-primary" data-magnetic href="${esc(loginUrl(`/app.html?service=${svc.id}`))}">Sign in to get it</a>`}
      </div>
    </div>`;
  initMagnetic(el);
  $('[data-take]', el)?.addEventListener('click', (e) => takeWalkIn(e.currentTarget, svc));
}

async function takeWalkIn(button, svc) {
  setBusy(button, true, 'Issuing…');
  try {
    const { booking } = await post('/api/bookings', { kind: 'walkin', serviceId: svc.id }, { human: true });
    const el = $('[data-kiosk-result]');
    el.innerHTML = `
      <div class="ticket">
        <div><div class="ticket-label">Your token</div><div class="ticket-code">${esc(booking.tokenCode)}</div></div>
        <div class="ticket-meta">
          <span class="row">${icon('check')} Confirmed for ${esc(booking.slotTime)}</span>
          <span class="row">${icon('users')} ${booking.ahead ?? 0} ahead · ~${esc(fmt.minutes(booking.etaMin))}</span>
        </div>
        <div class="ticket-cta"><a class="btn btn-primary" href="/app.html">Track it live ${icon('arrow-right', 'i-arrow')}</a></div>
      </div>`;
    toast(`Token ${booking.tokenCode} confirmed`, { body: 'Check in on arrival from the My tokens page.', type: 'success' });
  } catch (err) {
    setBusy(button, false);
    toast("Couldn't issue a token", { body: err.message, type: 'danger' });
  }
}

/* ---------------- 02 · Live board ---------------- */
function initLiveBoard() {
  const select = $('[data-live-org]');
  const groups = Object.entries(CATEGORY).map(([id, c]) => {
    const opts = state.orgs.filter((o) => o.category === id)
      .map((o) => `<option value="${o.id}">${esc(o.name)}${o.openNow ? '' : ' (closed)'}</option>`).join('');
    return opts ? `<optgroup label="${esc(c.label)}">${opts}</optgroup>` : '';
  }).join('');
  select.innerHTML = groups;
  const busiest = [...state.orgs].filter((o) => o.openNow).sort((a, b) => b.waiting - a.waiting)[0] || state.orgs[0];
  select.value = String(busiest.id);
  select.onchange = () => follow(Number(select.value));

  $('[data-live-body]').innerHTML = `
    <div class="serving-grid" data-serving>${skeletons(4, 'sk-card')}</div>
    <div>
      <div class="qlane-head"><strong>Waiting list</strong><span class="muted">Solid = on site · Dashed = on the way</span></div>
      <div class="qlane" data-lane></div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Waiting</span><b class="tnum" data-k="waiting">0</b></div>
      <div class="kpi"><span>On site</span><b class="tnum" data-k="present">0</b></div>
      <div class="kpi"><span>Avg wait today</span><b class="tnum" data-k="avg">0</b><small>min</small></div>
      <div class="kpi"><span>Queue clears in</span><b class="tnum" data-k="clear">0</b><small>min</small></div>
    </div>
    <div class="recent" data-recent></div>`;
  follow(busiest.id);
}

function follow(orgId) {
  state.disconnect?.();
  state.samples = [];
  state.knownLane = new Set();
  state.disconnect = connectLive(orgId, {
    onStatus: (s) => renderLiveStatus($('[data-live-status]'), s),
    onSnapshot: (snap) => {
      state.snapshot = snap;
      state.samples = [...state.samples, { t: Date.now(), v: snap.totals.waiting }].slice(-MAX_SAMPLES);
      renderBoard(snap);
      renderCounters(snap);
      renderDash(snap);
      heroFromSnapshot(snap);
    },
  });
}

function renderBoard(snap) {
  const serving = $('[data-serving]');
  if (!serving.querySelector('.serving')) serving.innerHTML = '';
  for (const c of snap.counters) {
    let card = serving.querySelector(`[data-counter="${c.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.dataset.counter = String(c.id);
      card.innerHTML = `<div class="serving-top"><span>${esc(c.name)}</span><span data-st></span></div>
        <div class="serving-code" data-code></div><div class="serving-sub" data-sub></div>`;
      serving.append(card);
    }
    card.className = `serving ${c.serving ? 'active' : ''} ${c.status !== 'open' ? 'paused' : ''}`;
    $('[data-st]', card).innerHTML = c.status === 'open' ? (c.serving ? '<span class="pill success">Serving</span>' : '<span class="pill">Free</span>') : `<span class="pill warn">${esc(c.status)}</span>`;
    const code = $('[data-code]', card);
    code.classList.toggle('idle', !c.serving);
    rollText(code, c.serving ? c.serving.tokenCode : '— —');
    $('[data-sub]', card).textContent = c.serving ? c.serving.service : c.status === 'open' ? 'Ready for the next token' : 'Not taking tokens';
  }

  const lane = $('[data-lane]');
  const items = snap.waiting.slice(0, LANE_LIMIT);
  lane.innerHTML = items.length ? items.map((w, i) => `
    <div class="qchip ${w.present ? '' : 'expected'} ${state.knownLane.has(w.tokenCode) ? '' : 'new'}">
      <span class="pos">#${i + 1}</span><span class="mono">${esc(w.tokenCode)}</span><small>${esc(w.slotTime)} · ${w.present ? 'on site' : 'expected'}</small>
    </div>`).join('') : stateHTML('empty', { title: 'Nobody is waiting', message: 'New tokens will appear here in real time.' });
  state.knownLane = new Set(items.map((w) => w.tokenCode));

  animateNumber($('[data-k="waiting"]'), snap.totals.waiting);
  animateNumber($('[data-k="present"]'), snap.totals.present);
  animateNumber($('[data-k="avg"]'), snap.totals.avgWaitMin ?? 0, { decimals: 1 });
  animateNumber($('[data-k="clear"]'), snap.totals.estClearMin);
  $('[data-recent]').innerHTML = snap.recent.length
    ? `Recently served ${snap.recent.map((c) => `<span class="mono">${esc(c)}</span>`).join('')}`
    : '';
}

/* ---------------- 04 · Counters ---------------- */
function renderCounters(snap) {
  const host = $('[data-counters-live]');
  const shown = snap.counters.slice(0, 4);
  if (!host.querySelector('.counter-row')) {
    host.innerHTML = '<div class="counter-row" data-crow></div><div class="next-up" data-next></div>';
  }
  const row = $('[data-crow]', host);
  for (const c of shown) {
    let card = row.querySelector(`[data-cc="${c.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'counter-card';
      card.dataset.cc = String(c.id);
      card.innerHTML = `<div class="serving-top"><strong>${esc(c.name)}</strong><span data-st></span></div>
        <div class="serving-code" data-code></div><div class="elapsed"><i></i></div><div class="serving-sub" data-sub></div>`;
      row.append(card);
    }
    const code = c.serving ? c.serving.tokenCode : '— —';
    if (card.dataset.code && card.dataset.code !== code && c.serving) {
      card.classList.remove('flash');
      void card.offsetWidth; // restart animation
      card.classList.add('flash');
    }
    card.dataset.code = code;
    card.dataset.since = c.serving ? String(c.serving.sinceMs) : '';
    $('[data-st]', card).innerHTML = c.status !== 'open' ? `<span class="pill warn">${esc(c.status)}</span>` : c.serving ? '<span class="pill success">Serving</span>' : '<span class="pill">Free</span>';
    rollText($('[data-code]', card), code);
    $('[data-code]', card).classList.toggle('idle', !c.serving);
  }
  tickElapsed();
  const present = snap.waiting.filter((w) => w.present).slice(0, 6);
  $('[data-next]', host).innerHTML = present.length
    ? `<span>Next to be called</span>${present.map((w) => `<span class="mono">${esc(w.tokenCode)}</span>`).join('')}`
    : '<span>No one is checked in yet. Counters call people only once they arrive.</span>';
}

function tickElapsed() {
  const avg = (state.snapshot?.totals.avgServiceMin || 1) * 60_000;
  for (const card of $$('.counter-card')) {
    const since = Number(card.dataset.since);
    const bar = $('.elapsed i', card);
    const sub = $('[data-sub]', card);
    if (!since) {
      bar.style.setProperty('--w', '0%');
      sub.textContent = 'Waiting for the next checked-in token';
      continue;
    }
    const ms = Date.now() - since;
    bar.style.setProperty('--w', `${Math.min(100, (ms / avg) * 100).toFixed(1)}%`);
    sub.textContent = `Serving for ${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
}

/* ---------------- 06 · Dashboard preview ---------------- */
function renderDash(snap) {
  const k = $('[data-dash-kpis]');
  if (!k.firstElementChild) {
    k.innerHTML = [['served', 'Served today'], ['waiting', 'Waiting'], ['noShow', 'No-shows'], ['avg', 'Avg wait (min)']]
      .map(([id, label]) => `<div class="kpi"><span>${label}</span><b class="tnum" data-dk="${id}">0</b></div>`).join('');
  }
  animateNumber($('[data-dk="served"]'), snap.totals.served);
  animateNumber($('[data-dk="waiting"]'), snap.totals.waiting);
  animateNumber($('[data-dk="noShow"]'), snap.totals.noShow);
  animateNumber($('[data-dk="avg"]'), snap.totals.avgWaitMin ?? 0, { decimals: 1 });
  drawSpark();
  const avg = (snap.totals.avgServiceMin || 1) * 60_000;
  $('[data-dash-util]').innerHTML = snap.counters.map((c) => {
    const pct = c.serving ? Math.min(100, ((Date.now() - c.serving.sinceMs) / avg) * 100) : 0;
    return `<div class="util-row ${c.status !== 'open' ? 'paused' : ''}"><span>${esc(c.name)}</span>
      <div class="util-bar"><i data-w="${pct.toFixed(0)}"></i></div><span class="tnum">${c.serving ? `${pct.toFixed(0)}%` : '—'}</span></div>`;
  }).join('');
  $$('[data-dash-util] i[data-w]').forEach((i) => i.style.setProperty('--w', `${i.dataset.w}%`));
}

function drawSpark() {
  const svg = $('[data-dash-spark]');
  const pts = state.samples;
  const W = 600;
  const H = 160;
  const max = Math.max(4, ...pts.map((p) => p.v));
  const grid = [0.25, 0.5, 0.75].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${H * f}" y2="${H * f}"/>`).join('');
  if (pts.length < 2) {
    svg.innerHTML = `${grid}<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="14">Collecting live samples…</text>`;
    return;
  }
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - 8 - (p.v / max) * (H - 24)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  svg.innerHTML = `${grid}<path class="area" d="${line} L${W},${H} L0,${H} Z"/><path class="line" d="${line}"/><circle class="dot" cx="${lx}" cy="${ly}" r="5"/>`;
}

/* ---------------- 03 · Booker ---------------- */
function renderBooker() {
  const select = $('[data-book-service]');
  if (!select.options.length) {
    select.innerHTML = state.orgs.map((o) => `<optgroup label="${esc(o.name)}">${o.services
      .map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
    select.onchange = () => {
      state.booker = { ...state.booker, serviceId: Number(select.value), page: 0, selected: null };
      loadSlots();
    };
  }
  if (!state.booker.serviceId) {
    const gov = state.orgs.find((o) => o.category === 'government' && o.openNow) || state.orgs[0];
    state.booker.serviceId = gov.services[0].id;
  }
  select.value = String(state.booker.serviceId);

  const dates = $('[data-book-dates]');
  const today = localDateStr();
  dates.innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(today, i);
    const [y, m, day] = d.split('-').map(Number);
    const wd = i === 0 ? 'Today' : new Date(y, m - 1, day).toLocaleDateString([], { weekday: 'short' });
    return `<button type="button" role="tab" class="date-btn" data-date="${d}" aria-selected="${d === state.booker.date}"><small>${esc(wd)}</small><b>${day}</b></button>`;
  }).join('');
  dates.onclick = (e) => {
    const b = e.target.closest('[data-date]');
    if (!b) return;
    state.booker = { ...state.booker, date: b.dataset.date, page: 0, selected: null };
    $$('.date-btn', dates).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    loadSlots();
  };
  loadSlots();
}

async function loadSlots() {
  const grid = $('[data-book-slots]');
  grid.innerHTML = skeletons(12, 'sk-slot');
  const { serviceId, date } = state.booker;
  try {
    const data = await api(`/api/services/${serviceId}/slots?date=${date}`);
    if (state.booker.serviceId !== serviceId || state.booker.date !== date) return;
    state.booker.slots = data;
    renderSlots();
  } catch (err) {
    renderError(grid, err, loadSlots);
  }
}

function renderSlots() {
  const grid = $('[data-book-slots]');
  const data = state.booker.slots;
  const upcoming = data.slots.filter((s) => !s.past);
  const pages = Math.max(1, Math.ceil(upcoming.length / SLOTS_PER_PAGE));
  const page = Math.min(state.booker.page, pages - 1);
  const shown = upcoming.slice(page * SLOTS_PER_PAGE, (page + 1) * SLOTS_PER_PAGE);
  if (!shown.length) {
    grid.innerHTML = stateHTML('empty', {
      title: 'No times left on this day',
      message: 'All appointment slots for this date are fully reserved. Try picking another date above.',
      actionLabel: 'Check next available date',
      iconName: 'calendar'
    });
    const nextBtn = $('[data-action]', grid);
    if (nextBtn) {
      nextBtn.onclick = () => {
        const active = $('[data-book-dates] [aria-selected="true"]');
        const next = active?.nextElementSibling;
        if (next) next.click();
      };
    }
    renderSummary();
    return;
  }
  grid.innerHTML = shown.map((s) => {
    const full = s.available <= 0;
    const few = !full && s.available <= Math.ceil(s.capacity / 3);
    const fill = s.taken > 0 ? Math.max(8, Math.round((s.taken / s.capacity) * 100)) : 0;
    return `<button type="button" class="slot ${full ? 'full' : few ? 'few' : ''}" data-slot="${s.index}" style="--fill: ${fill}%" ${full ? 'disabled' : ''}
      aria-pressed="${state.booker.selected === s.index}" aria-label="${esc(s.time)}, ${s.available} of ${s.capacity} free">
      <b>${esc(s.time)}</b><span class="bar"><i style="width: ${fill}%"></i></span></button>`;
  }).join('') + (pages > 1 ? `<div class="row slot-pager">
      <button type="button" class="btn btn-sm btn-ghost" data-page="-1" ${page === 0 ? 'disabled' : ''}>Earlier</button>
      <span class="muted">${page + 1} / ${pages}</span>
      <button type="button" class="btn btn-sm btn-ghost" data-page="1" ${page >= pages - 1 ? 'disabled' : ''}>Later</button></div>` : '');
  grid.onclick = (e) => {
    const pager = e.target.closest('[data-page]');
    if (pager) {
      state.booker.page = page + Number(pager.dataset.page);
      renderSlots();
      return;
    }
    const b = e.target.closest('[data-slot]');
    if (!b || b.disabled) return;
    state.booker.selected = Number(b.dataset.slot);
    $$('.slot', grid).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderSummary();
  };
  renderSummary();
}

function renderSummary() {
  const el = $('[data-book-summary]');
  const data = state.booker.slots;
  const slot = data?.slots.find((s) => s.index === state.booker.selected);
  if (!slot) {
    el.innerHTML = `<span class="grow muted">Pick a time to see your token number.</span>`;
    return;
  }
  const next = `/app.html?service=${data.service.id}&date=${state.booker.date}&slot=${slot.index}`;
  el.innerHTML = `<span class="grow">${esc(fmt.day(state.booker.date))} at <b>${esc(slot.time)}</b> gets token <b>${esc(slot.nextToken)}</b></span>
    ${state.me
      ? '<button type="button" class="btn btn-primary" data-magnetic data-book>Book this slot</button>'
      : `<a class="btn btn-primary" data-magnetic href="${esc(loginUrl(next))}">Sign in to book</a>`}`;
  initMagnetic(el);
  $('[data-book]', el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, 'Booking…');
    try {
      const { booking } = await post('/api/bookings', { kind: 'appointment', serviceId: data.service.id, date: state.booker.date, slotIndex: slot.index }, { human: true });
      toast(`Booked ${booking.tokenCode}`, { body: `${fmt.day(booking.date)} at ${booking.slotTime}, ${booking.org.name}`, type: 'success' });
      el.innerHTML = `<span class="grow">${icon('check')} Booked <b>${esc(booking.tokenCode)}</b> for ${esc(booking.slotTime)}</span><a class="btn" href="/app.html">View my tokens</a>`;
      loadSlots();
    } catch (err) {
      setBusy(btn, false);
      toast("Couldn't book that slot", { body: err.message, type: 'danger' });
      if (err.code === 'SLOT_FULL') loadSlots();
    }
  });
}

/* ---------------- 05 · Notification phone ---------------- */
const DEMO_NOTIFS = [
  { type: 'info', icon: 'ticket', title: 'Token P-025 confirmed', body: 'Passport Application · Today at 10:00' },
  { type: 'warning', icon: 'pin', title: "You're 2.4 km away", body: 'Check in by 10:10 or your token moves to a later slot.' },
  { type: 'success', icon: 'check', title: 'Checked in automatically', body: "You're inside the geofence. 3 people ahead." },
  { type: 'warning', icon: 'bell', title: 'Almost your turn', body: 'Two tokens ahead of you. Head towards the counters.' },
  { type: 'success', icon: 'door', title: "It's your turn — P-025", body: 'Please go to Counter 3 now.' },
];

function notifLoop() {
  const stack = $('[data-notif-stack]');
  const clock = $('[data-phone-time]');
  let i = 0;
  const push = () => {
    const n = DEMO_NOTIFS[i % DEMO_NOTIFS.length];
    if (i % DEMO_NOTIFS.length === 0) stack.replaceChildren();
    const el = document.createElement('div');
    el.className = `notif ${n.type}`;
    el.innerHTML = `<span class="n-ico">${icon(n.icon)}</span><div><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p></div>`;
    stack.prepend(el);
    [...stack.children].slice(4).forEach((x) => x.remove());
    i++;
  };
  const tickClock = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  tickClock();
  setInterval(tickClock, 15_000);
  onVisible($('#notify'), () => {
    push();
    return setInterval(push, 2600);
  });
}

/* ---------------- 08 · Human meter ---------------- */
const REASON_LABELS = {
  'uniform-speed': 'constant speed',
  'perfectly-straight-moves': 'too straight',
  'repeated-identical-steps': 'repeated steps',
  'metronomic-timing': 'machine-like timing',
  'no-path-curvature': 'no curvature',
  'cursor-teleports': 'teleporting cursor',
  'not-enough-signal': 'need more movement',
};

function meterLoop() {
  const gauge = $('[data-gauge]');
  const update = () => {
    const r = Human.liveScore();
    if (!r || r.samples < 15 || r.verdict === 'inconclusive') {
      $('[data-meter-verdict]').textContent = 'Keep moving your cursor or finger';
      $('[data-meter-samples]').textContent = String(r?.samples ?? 0);
      return;
    }
    const score = Math.round(r.score * 100);
    gauge.style.setProperty('--score', String(score));
    gauge.className = `gauge is-${r.verdict}`;
    animateNumber($('[data-meter-score]'), score, { duration: 400 });
    const verdict = $('[data-meter-verdict]');
    verdict.className = `pill ${r.verdict === 'human' ? 'success' : r.verdict === 'bot' ? 'danger' : 'warn'}`;
    verdict.textContent = r.verdict === 'human' ? 'Looks human' : r.verdict === 'bot' ? 'Bot-like' : 'Suspicious';
    $('[data-meter-samples]').textContent = String(r.samples);
    $('[data-meter-flags]').textContent = r.reasons.length ? r.reasons.slice(0, 2).map((x) => REASON_LABELS[x] || x).join(', ') : 'none';
  };
  onVisible($('#trust'), () => setInterval(update, 450));
}

/* ---------------- 07 · Latency probe ---------------- */
async function probeOnce() {
  const times = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    try {
      await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
      times.push(performance.now() - t0);
    } catch {
      $('[data-probe-note]').textContent = 'Network unavailable — retrying.';
      return;
    }
  }
  times.sort((a, b) => a - b);
  animateNumber($('[data-probe-ms]'), Math.round(times[Math.floor(times.length / 2)]), { duration: 600 });
  $('[data-probe-note]').textContent = 'Median of 4 live requests from this browser.';
}

/** Run start() while `el` is on screen; start returns an interval id to clear. */
function onVisible(el, start) {
  if (!el) return;
  let id = null;
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && id === null) id = start();
    else if (!entry.isIntersecting && id !== null) {
      clearInterval(id);
      id = null;
    }
  }, { threshold: 0.15 }).observe(el);
}

/* ---------------- Boot ---------------- */
async function loadOrgs() {
  const kiosk = $('[data-kiosk-orgs]');
  kiosk.innerHTML = skeletons(3, 'sk-row');
  try {
    state.orgs = (await api('/api/orgs')).orgs;
  } catch (err) {
    renderError(kiosk, err, boot);
    renderError($('[data-live-body]'), err, boot);
    return false;
  }
  return true;
}

async function boot() {
  if (!(await loadOrgs())) return;
  renderHeroStats();
  renderKiosk();
  initLiveBoard();
  renderBooker();
  setInterval(tickElapsed, 1000);
  setInterval(async () => {
    try {
      state.orgs = (await api('/api/orgs')).orgs;
      renderHeroStats();
    } catch {
      // transient — the next refresh will try again
    }
  }, 20_000);
}

initMotion();
initParticleDrift();
initTilt($('[data-stage]'), { max: 9 });
initTilt($('[data-tilt-phone]'), { max: 6 });
heroLoop();
notifLoop();
meterLoop();
onVisible($('#reliability'), () => {
  probeOnce();
  return setInterval(probeOnce, 15_000);
});
state.me = await initNav();
boot();
