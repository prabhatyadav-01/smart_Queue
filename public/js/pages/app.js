import { initNav } from '../core/nav.js';
import { initMagnetic, initAnchorLinks, scrollToTarget, initHover3D } from '../core/motion.js';
import { initParticleDrift } from '../core/particle-drift.js';
import { api, post } from '../core/api.js';
import { connectLive, renderLiveStatus } from '../core/live.js';
import {
  $, $$, esc, icon, fmt, CATEGORY, toast, confirmDialog, stateHTML, renderError, skeletons, localDateStr, debounce, setBusy,
} from '../core/ui.js';
import {
  renderSlotGrid, renderDateStrip, renderTokenList, renderHistory, updateLocationPanel, createLocationTracker, openReschedule,
} from './app-tokens.js';

const BOOK_DAYS = 14;
const REFRESH_MS = 30_000;
const params = new URLSearchParams(location.search);

const state = {
  me: null,
  orgs: [],
  policy: null,
  bookings: { active: [], history: [] },
  codes: new Map(),
  flow: { category: 'all', search: '', orgId: null, serviceId: null, mode: 'walkin', date: localDateStr(), page: 0, slot: null, slots: null },
  notifs: [],
  liveOrg: undefined,
  disconnect: null,
};

const tracker = createLocationTracker({
  onResult: (id, result) => {
    const b = state.bookings.active.find((x) => x.id === id);
    if (b) updateLocationPanel($('[data-active]'), b, result);
    if (result.status && b && result.status !== b.status) refreshBookings();
  },
});

/* ---------------- Tokens ---------------- */
async function loadBookings() {
  const list = $('[data-active]');
  try {
    state.bookings = await api('/api/me/bookings');
  } catch (err) {
    renderError(list, err, loadBookings);
    return;
  }
  renderTokenList(list, state.bookings.active, tracker, state.codes);
  state.codes = new Map(state.bookings.active.map((b) => [b.id, b.tokenCode]));
  renderHistory($('[data-history]'), state.bookings.history);
  tracker.setTargets(state.bookings.active);
  tracker.autoStart();
  followLive();
  const max = state.policy?.maxActiveBookings ?? 3;
  const left = max - state.bookings.active.length;
  $('[data-limit-note]').textContent = left > 0 ? `${left} of ${max} tokens available` : 'Token limit reached';
}
const refreshBookings = debounce(loadBookings, 600);

function bindTokenActions() {
  $('[data-active]').addEventListener('click', async (e) => {
    if (e.target.closest('[data-state-action]')) return scrollToTarget('#book');
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-bid]').dataset.bid);
    const b = state.bookings.active.find((x) => x.id === id);
    if (!b) return;
    if (btn.dataset.act === 'locate') {
      updateLocationPanel($('[data-active]'), b, { message: 'Getting your location…' });
      tracker.checkNow();
    } else if (btn.dataset.act === 'reschedule') {
      openReschedule(b, loadBookings, state.bookings.active);
    } else if (btn.dataset.act === 'cancel') {
      const yes = await confirmDialog({ title: `Cancel ${b.tokenCode}?`, message: 'Your slot will be released to someone else. This cannot be undone.', confirmLabel: 'Cancel token', danger: true });
      if (!yes) return;
      setBusy(btn, true);
      try {
        await post(`/api/bookings/${b.id}/cancel`);
        toast(`${b.tokenCode} cancelled`, { type: 'info' });
        loadBookings();
      } catch (err) {
        setBusy(btn, false);
        toast("Couldn't cancel", { body: err.message, type: 'danger' });
      }
    }
  });
}

/* ---------------- Live connection ---------------- */
function followLive() {
  const soonest = state.bookings.active.find((b) => b.date === localDateStr());
  const orgId = soonest ? soonest.org.id : null;
  if (orgId === state.liveOrg) return;
  state.liveOrg = orgId;
  state.disconnect?.();
  state.disconnect = connectLive(orgId, {
    onStatus: (s) => renderLiveStatus($('[data-live-status]'), s),
    onSnapshot: () => refreshBookings(),
    onUser: (evt) => {
      if (evt.kind === 'notification') onNotification(evt.notification);
      refreshBookings();
    },
  });
}

/* ---------------- Notifications ---------------- */
const LEVEL_ICON = { success: 'check', warning: 'alert', danger: 'alert', info: 'bell' };

function renderNotifs() {
  const unread = state.notifs.filter((n) => !n.read).length;
  const badge = $('[data-unread]');
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  const body = $('[data-notifs]');
  body.innerHTML = state.notifs.length ? state.notifs.map((n) => `
    <div class="nitem ${n.level} ${n.read ? '' : 'unread'}">
      <span class="n-ico">${icon(LEVEL_ICON[n.level] || 'bell')}</span>
      <div><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p><small>${esc(fmt.relative(n.createdAt))}</small></div>
    </div>`).join('') : stateHTML('empty', { title: "You're all caught up", message: 'Reminders and turn alerts will appear here.', iconName: 'bell' });
}

async function loadNotifs() {
  try {
    state.notifs = (await api('/api/me/notifications')).notifications;
    renderNotifs();
  } catch (err) {
    renderError($('[data-notifs]'), err, loadNotifs);
  }
}

function playAlertChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.12);
    gain2.gain.setValueAtTime(0.25, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.55);
  } catch {
    // AudioContext blocked or unsupported
  }
}

function onNotification(n) {
  state.notifs = [n, ...state.notifs].slice(0, 30);
  renderNotifs();
  playAlertChime();
  toast(n.title, { body: n.body, type: n.level, timeout: n.type === 'called' ? 12_000 : 6000 });
  if (n.type === 'called' || n.type === 'recall') navigator.vibrate?.([200, 100, 200]);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(n.title, { body: n.body, icon: '/img/favicon.svg', tag: `sq-${n.bookingId || n.id}` });
    } catch {
      // some mobile browsers only allow notifications from a service worker
    }
  }
}

function initDrawer() {
  const drawer = $('[data-drawer]');
  const scrim = $('[data-scrim]');
  const bell = $('[data-bell]');
  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.inert = !open;
    scrim.hidden = !open;
    if (open) $('[data-drawer-close]').focus();
    else bell.focus();
  };
  bell.addEventListener('click', () => setOpen(true));
  scrim.addEventListener('click', () => setOpen(false));
  $('[data-drawer-close]').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) setOpen(false);
  });
  $('[data-read-all]').addEventListener('click', async () => {
    try {
      await post('/api/me/notifications/read');
      state.notifs = state.notifs.map((n) => ({ ...n, read: true }));
      renderNotifs();
    } catch (err) {
      toast("Couldn't update notifications", { body: err.message, type: 'danger' });
    }
  });
}

function initAlertsButton() {
  const btn = $('[data-enable-alerts]');
  if (!btn) return;
  const label = $('[data-alert-label]', btn) || btn;
  const dot = $('.live-dot', btn);

  let alertsEnabled = localStorage.getItem('sq_alerts_enabled') !== '0';

  const updateUI = () => {
    const perm = 'Notification' in window ? Notification.permission : 'denied';
    if (alertsEnabled) {
      btn.classList.add('on');
      btn.classList.remove('off');
      btn.setAttribute('aria-pressed', 'true');
      label.textContent = 'Alerts on';
      if (dot) dot.className = 'live-dot';
      btn.title = perm === 'granted'
        ? 'Real-time and desktop notifications are active'
        : 'Real-time notifications are active. Click to enable desktop notifications.';
    } else {
      btn.classList.remove('on');
      btn.classList.add('off');
      btn.setAttribute('aria-pressed', 'false');
      label.textContent = 'Turn on alerts';
      if (dot) dot.className = 'live-dot off';
      btn.title = 'Click to enable real-time notifications';
    }
  };

  btn.addEventListener('click', async () => {
    if (!alertsEnabled) {
      alertsEnabled = true;
      localStorage.setItem('sq_alerts_enabled', '1');
      if ('Notification' in window && Notification.permission === 'default') {
        try {
          const res = await Notification.requestPermission();
          if (res === 'granted') {
            toast('Desktop notifications enabled', { body: "We'll notify you when it's your turn in real time.", type: 'success' });
          }
        } catch {}
      }
      playAlertChime();
      toast('Alerts turned on', { body: 'You will receive real-time notifications for your tokens.', type: 'success' });
    } else {
      if ('Notification' in window && Notification.permission === 'default') {
        try {
          const res = await Notification.requestPermission();
          toast(res === 'granted' ? 'Desktop alerts enabled' : 'In-app alerts active', {
            body: res === 'granted' ? "We'll notify you even in other tabs." : 'You will receive in-app and audio alerts.',
            type: res === 'granted' ? 'success' : 'info',
          });
        } catch {}
      } else {
        toast('Alerts active', { body: 'Real-time alerts and audio notifications are active.', type: 'info' });
        playAlertChime();
      }
    }
    updateUI();
  });

  if ('Notification' in window && Notification.permission === 'default') {
    const askOnGesture = () => {
      Notification.requestPermission().then(() => updateUI()).catch(() => {});
      document.removeEventListener('click', askOnGesture);
    };
    document.addEventListener('click', askOnGesture, { once: true });
  }

  updateUI();
}

/* ---------------- Booking flow ---------------- */
const flow = state.flow;
const selectedOrg = () => state.orgs.find((o) => o.id === flow.orgId);

function renderCats() {
  const cats = [['all', { label: 'All', icon: 'layers' }], ...Object.entries(CATEGORY)];
  const el = $('[data-cats]');
  el.innerHTML = cats.map(([id, c]) => `<button type="button" class="chip" data-cat="${id}" aria-pressed="${flow.category === id}">${icon(c.icon)}${esc(c.label)}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    flow.category = b.dataset.cat;
    renderCats();
    renderOrgs();
  };
}

function renderOrgs() {
  const q = flow.search.trim().toLowerCase();
  const list = state.orgs.filter((o) => (flow.category === 'all' || o.category === flow.category)
    && (!q || `${o.name} ${o.address} ${o.services.map((s) => s.name).join(' ')}`.toLowerCase().includes(q)));
  const el = $('[data-orgs]');
  el.innerHTML = list.length ? list.map((o) => {
    const existing = state.bookings.active.find((b) => b.org.id === o.id);
    return `
    <button type="button" class="org-opt ${existing ? 'has-active' : ''}" role="radio" aria-checked="${o.id === flow.orgId}" data-org="${o.id}">
      <span class="org-ico">${icon(CATEGORY[o.category].icon)}</span>
      <span><span class="org-name">${esc(o.name)}</span><span class="org-meta">${esc(o.address)} · ${esc(o.hours)}</span></span>
      <span class="org-side">${existing ? `<span class="pill warn">Active: ${esc(existing.tokenCode)}</span>` : o.openNow ? `<b class="tnum">${o.waiting}</b>waiting · ~${esc(fmt.minutes(o.estWaitMin))}` : '<span class="pill">Closed now</span>'}</span>
    </button>`;
  }).join('') : stateHTML('empty', { title: 'No places match', message: 'Try a different search or category.', iconName: 'search' });
  el.onclick = (e) => {
    const b = e.target.closest('[data-org]');
    if (!b) return;
    const org = state.orgs.find((o) => o.id === Number(b.dataset.org));
    Object.assign(flow, { orgId: org.id, serviceId: org.services[0].id, slot: null, page: 0, mode: org.openNow ? flow.mode : 'appointment' });
    renderOrgs();
    renderServices();
  };
}

function renderServices() {
  const org = selectedOrg();
  $('[data-step2]').hidden = !org;
  $('[data-step3]').hidden = !org;
  if (!org) return;
  const el = $('[data-services]');
  el.innerHTML = org.services.map((s) => `<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${s.id === flow.serviceId}">${esc(s.name)}<small>~${s.avgServiceMin} min</small></button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-svc]');
    if (!b) return;
    Object.assign(flow, { serviceId: Number(b.dataset.svc), slot: null, page: 0 });
    renderServices();
  };
  renderMode();
}

function renderMode() {
  $$('[data-mode-v]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modeV === flow.mode)));
  $('[data-schedule]').hidden = flow.mode !== 'appointment';
  if (flow.mode === 'appointment') {
    renderDateStrip($('[data-dates]'), {
      days: BOOK_DAYS,
      selected: flow.date,
      onSelect: (d) => {
        Object.assign(flow, { date: d, slot: null, page: 0 });
        loadFlowSlots();
      },
    });
  }
  loadFlowSlots();
}

const flowKey = () => `${flow.serviceId}|${flow.mode}|${flow.mode === 'walkin' ? localDateStr() : flow.date}`;

async function loadFlowSlots() {
  const confirmEl = $('[data-confirm]');
  const date = flow.mode === 'walkin' ? localDateStr() : flow.date;
  const key = flowKey();
  if (flow.mode === 'appointment') $('[data-slots]').innerHTML = skeletons(12, 'sk-slot');
  confirmEl.innerHTML = '<div class="skeleton sk-row grow"></div>';
  let data;
  try {
    data = await api(`/api/services/${flow.serviceId}/slots?date=${date}`);
  } catch (err) {
    renderError(confirmEl, err, loadFlowSlots);
    return;
  }
  if (flowKey() !== key) return; // selection changed while loading
  flow.slots = data;
  if (flow.mode === 'appointment') drawFlowSlots();
  renderConfirm();
}

function drawFlowSlots() {
  const currentDate = flow.mode === 'walkin' ? localDateStr() : flow.date;
  const conflicts = new Set();
  if (flow.slots?.slots) {
    for (const s of flow.slots.slots) {
      if (state.bookings.active.some((b) => b.date === currentDate && b.slotTime === s.time)) {
        conflicts.add(s.index);
      }
    }
  }
  renderSlotGrid($('[data-slots]'), flow.slots, {
    selected: flow.slot,
    page: flow.page,
    conflicts,
    onSelect: (i) => {
      flow.slot = i;
      renderConfirm();
    },
    onPage: (p) => {
      flow.page = p;
      drawFlowSlots();
    },
  });
}

function renderConfirm() {
  const el = $('[data-confirm]');
  const org = selectedOrg();
  const data = flow.slots;
  if (!org || !data) return;

  const existingOrg = state.bookings.active.find((b) => b.org.id === org.id);
  if (existingOrg) {
    el.innerHTML = `<span class="grow muted"><b style="color:var(--warn,#f59e0b)">Active booking:</b> You already hold token <b class="mono">${esc(existingOrg.tokenCode)}</b> for ${esc(org.name)}. Complete, reschedule, or cancel it before booking another.</span>`;
    return;
  }

  let slot;
  if (flow.mode === 'walkin') {
    slot = data.slots.find((s) => s.available > 0);
    if (!slot) {
      el.innerHTML = `<span class="grow muted">${org.openNow ? 'No walk-in tokens left today.' : `${esc(org.name)} is closed right now.`} Schedule a time instead.</span>`;
      return;
    }
  } else {
    slot = data.slots.find((s) => s.index === flow.slot && s.available > 0);
    if (!slot) {
      el.innerHTML = '<span class="grow muted">Choose a time slot to see your token number.</span>';
      return;
    }
  }

  const currentDate = flow.mode === 'walkin' ? localDateStr() : flow.date;
  const timeConflict = state.bookings.active.find((b) => b.date === currentDate && b.slotTime === slot.time);
  if (timeConflict) {
    el.innerHTML = `<span class="grow muted"><b style="color:var(--danger,#ef4444)">Time conflict:</b> You already have token <b class="mono">${esc(timeConflict.tokenCode)}</b> booked at ${esc(timeConflict.slotTime)} (${esc(timeConflict.org.name)}). Choose another time slot.</span>`;
    return;
  }

  const when = flow.mode === 'walkin' ? `today, slot ${slot.time}` : `${fmt.day(flow.date)} at ${slot.time}`;
  el.innerHTML = `<div class="grow confirm-preview"><span class="ticket-label">Your token will be</span><b class="mono">${esc(slot.nextToken)}</b><span class="muted">${esc(data.service.name)} · ${esc(when)}</span></div>
    <button type="button" class="btn btn-primary btn-lg" data-magnetic data-confirm-btn>${flow.mode === 'walkin' ? 'Get token now' : 'Book this time'}</button>`;
  initMagnetic(el);
  $('[data-confirm-btn]', el).onclick = (e) => confirmBooking(e.currentTarget, slot);
}

async function confirmBooking(button, slot) {
  setBusy(button, true, 'Issuing…');
  const body = flow.mode === 'walkin'
    ? { kind: 'walkin', serviceId: flow.serviceId }
    : { kind: 'appointment', serviceId: flow.serviceId, date: flow.date, slotIndex: slot.index };
  try {
    const { booking } = await post('/api/bookings', body, { human: true });
    toast(`Token ${booking.tokenCode} confirmed`, { body: `${booking.org.name} · ${fmt.day(booking.date)} at ${booking.slotTime}`, type: 'success' });
    flow.slot = null;
    await loadBookings();
    scrollToTarget('#tokens');
    loadFlowSlots();
  } catch (err) {
    setBusy(button, false);
    toast("Couldn't issue a token", { body: err.message, type: 'danger' });
    if (err.code === 'SLOT_FULL' || err.code === 'SLOT_TAKEN') loadFlowSlots();
  }
}

function initFlow() {
  renderCats();
  const search = $('[data-search]');
  search.addEventListener('input', debounce(() => {
    flow.search = search.value;
    renderOrgs();
  }, 150));
  $('[data-mode]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode-v]');
    if (!b || b.dataset.modeV === flow.mode) return;
    Object.assign(flow, { mode: b.dataset.modeV, slot: null, page: 0 });
    renderMode();
  });

  // Prefill from links like /app.html?service=9&date=2026-03-10&slot=12
  const svcId = Number(params.get('service'));
  const org = svcId ? state.orgs.find((o) => o.services.some((s) => s.id === svcId)) : null;
  if (org) {
    Object.assign(flow, { orgId: org.id, serviceId: svcId });
    const date = params.get('date');
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Object.assign(flow, { mode: 'appointment', date, slot: Number(params.get('slot')) });
    }
  }
  renderOrgs();
  renderServices();
  if (org) setTimeout(() => scrollToTarget('#book'), 300);
}

/* ---------------- Boot ---------------- */
function greet(me) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('[data-greeting]').textContent = `${part}, ${me.name.split(' ')[0]}`;
}

async function boot() {
  state.me = await initNav({ requireAuth: true });
  greet(state.me);
  initAnchorLinks();
  initHover3D();
  initParticleDrift();
  initDrawer();
  initAlertsButton();
  bindTokenActions();
  $('[data-refresh]').addEventListener('click', loadBookings);
  $('[data-active]').innerHTML = skeletons(2, 'sk-token');
  $('[data-orgs]').innerHTML = skeletons(3, 'sk-row');

  try {
    const [config, orgs] = await Promise.all([api('/api/config'), api('/api/orgs')]);
    state.policy = config.policy;
    state.orgs = orgs.orgs;
  } catch (err) {
    renderError($('[data-orgs]'), err, () => location.reload());
  }
  if (state.orgs.length) initFlow();
  await loadBookings();
  loadNotifs();
  if (state.me.blockedUntil && state.me.blockedUntil > Date.now()) {
    toast('Booking paused', { body: `After repeated no-shows, booking is paused until ${new Date(state.me.blockedUntil).toLocaleString()}.`, type: 'warning', timeout: 10_000 });
  }
  setInterval(() => {
    if (!document.hidden) loadBookings();
  }, REFRESH_MS);
}

boot();
