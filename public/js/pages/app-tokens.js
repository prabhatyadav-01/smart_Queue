/* Token cards, geofenced location check-in, slot grid and reschedule dialog for the app page. */
import { api, post } from '../core/api.js';
import {
  $, $$, esc, icon, fmt, STATUS, CATEGORY, toast, openModal, stateHTML, renderError, skeletons, localDateStr, addDays, setBusy,
} from '../core/ui.js';

const SLOTS_PER_PAGE = 24;
const LOCATION_MIN_INTERVAL_MS = 45_000;
const MAX_DOTS = 8;
const RESCHEDULE_DAYS = 14;

/* ---------------- Slot grid ---------------- */
export function renderSlotGrid(el, data, { selected = null, page = 0, conflicts = new Set(), onSelect, onPage }) {
  const upcoming = data.slots.filter((s) => !s.past);
  if (!upcoming.length) {
    el.innerHTML = stateHTML('empty', {
      title: 'No times left on this day',
      message: 'All appointment slots for this date are fully reserved. Try picking another date above.',
      iconName: 'calendar'
    });
    return;
  }
  const pages = Math.ceil(upcoming.length / SLOTS_PER_PAGE);
  const p = Math.min(page, pages - 1);
  const shown = upcoming.slice(p * SLOTS_PER_PAGE, (p + 1) * SLOTS_PER_PAGE);
  el.innerHTML = shown.map((s) => {
    const isConflict = conflicts && conflicts.has(s.index);
    const full = s.available <= 0 || isConflict;
    const few = !full && s.available <= Math.ceil(s.capacity / 3);
    const fill = s.taken > 0 ? Math.max(8, Math.round((s.taken / s.capacity) * 100)) : 0;
    const label = isConflict ? `${esc(s.time)} (Time conflict)` : `${esc(s.time)}, ${s.available} of ${s.capacity} free`;
    return `<button type="button" class="slot ${full ? 'full' : few ? 'few' : ''} ${isConflict ? 'conflict' : ''}" data-slot="${s.index}" style="--fill: ${fill}%" ${full ? 'disabled' : ''}
      aria-pressed="${selected === s.index}" aria-label="${label}" title="${label}">
      <b>${esc(s.time)}</b><span class="bar"><i style="width: ${fill}%"></i></span></button>`;
  }).join('') + (pages > 1 ? `<div class="row slot-pager">
      <button type="button" class="btn btn-sm btn-ghost" data-page="-1" ${p === 0 ? 'disabled' : ''}>Earlier</button>
      <span class="muted">${p + 1} / ${pages}</span>
      <button type="button" class="btn btn-sm btn-ghost" data-page="1" ${p >= pages - 1 ? 'disabled' : ''}>Later</button></div>` : '');
  el.onclick = (e) => {
    const pager = e.target.closest('[data-page]');
    if (pager) return onPage?.(p + Number(pager.dataset.page));
    const b = e.target.closest('[data-slot]');
    if (b && !b.disabled) {
      const idx = Number(b.dataset.slot);
      $$('.slot', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onSelect?.(idx);
    }
  };
}

export function renderDateStrip(el, { days, selected, onSelect }) {
  const today = localDateStr();
  el.innerHTML = Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i);
    const [y, m, day] = d.split('-').map(Number);
    const wd = i === 0 ? 'Today' : new Date(y, m - 1, day).toLocaleDateString([], { weekday: 'short' });
    return `<button type="button" role="tab" class="date-btn" data-date="${d}" aria-selected="${d === selected}"><small>${esc(wd)}</small><b>${day}</b></button>`;
  }).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-date]');
    if (!b) return;
    $$('.date-btn', el).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    onSelect(b.dataset.date);
  };
}

/* ---------------- Token cards ---------------- */
function queueViz(b) {
  if (b.status === 'called') {
    return `<div class="called-banner">${icon('door')}<div><strong>Go to ${esc(b.counter || 'the counter')} now</strong><span>Your token has been called.</span></div></div>`;
  }
  if (b.ahead === null) {
    return `<div class="qviz future">${icon('calendar')}<span>${esc(fmt.day(b.date))} at ${esc(b.slotTime)}. Check-in opens at ${esc(fmt.time(b.checkInOpensMs))}.</span></div>`;
  }
  const shown = Math.min(b.ahead, MAX_DOTS);
  const dots = '<i></i>'.repeat(shown) + (b.ahead > MAX_DOTS ? `<em>+${b.ahead - MAX_DOTS}</em>` : '');
  return `<div class="qviz">
    <div class="qviz-dots" aria-hidden="true">${dots}<b></b></div>
    <div class="qviz-text"><strong>${b.ahead === 0 ? "You're next" : `${b.ahead} ahead of you`}</strong><span>about ${esc(fmt.minutes(b.etaMin))}</span></div>
  </div>`;
}

function locationPanel(b, loc) {
  if (b.date !== localDateStr() || (b.status !== 'booked' && b.status !== 'checked_in')) return '';
  if (loc?.error) return `<div class="loc warn">${icon('alert')}<span>${esc(loc.error)}</span></div>`;
  if (b.status === 'checked_in') {
    const dist = loc?.distanceM ?? b.lastDistanceM;
    return `<div class="loc ok">${icon('pin')}<span>Checked in${dist !== null && dist !== undefined ? ` · ${esc(fmt.distance(dist))} from the entrance` : ''}. Please stay on site.</span></div>`;
  }
  if (loc?.message) return `<div class="loc ${loc.inside ? 'ok' : ''}">${icon('pin')}<span>${esc(loc.message)}</span></div>`;
  const text = b.away
    ? `You left the premises. Come back by ${fmt.time(b.graceEndsMs)} to keep this token.`
    : `Check in when you arrive. If you're not here by ${fmt.time(b.graceEndsMs)}, your token moves to a later slot.`;
  return `<div class="loc ${b.away ? 'warn' : ''}">${icon('pin')}<span>${esc(text)}</span></div>`;
}

function tokenCardHTML(b, loc) {
  const st = STATUS[b.status] || { label: b.status, tone: '' };
  const cat = CATEGORY[b.org.category] || CATEGORY.government;
  const changeable = b.status === 'booked' || b.status === 'checked_in';
  const today = b.date === localDateStr();
  return `<article class="tcard s-${b.status}" data-bid="${b.id}">
    <div class="tcard-top">
      <span class="pill ${st.tone}">${esc(st.label)}</span>
      ${b.deferrals ? `<span class="pill warn">Moved ${b.deferrals}×</span>` : ''}
      <span class="spacer"></span>
      <span class="tcard-org">${icon(cat.icon)}<span>${esc(b.org.name)}</span></span>
    </div>
    <div class="tcard-code mono">${esc(b.tokenCode)}</div>
    <div class="tcard-sub">${esc(b.service.name)} · ${esc(fmt.day(b.date))} at ${esc(b.slotTime)}${b.kind === 'walkin' ? ' · walk-in' : ''}</div>
    ${queueViz(b)}
    <div data-loc>${locationPanel(b, loc)}</div>
    ${changeable ? `<div class="tcard-actions">
      ${today ? `<button type="button" class="btn btn-primary btn-sm" data-act="locate">${icon('locate')}${b.status === 'checked_in' ? 'Refresh location' : 'Check in with location'}</button>` : ''}
      <button type="button" class="btn btn-sm" data-act="reschedule" ${b.reschedulesLeft ? '' : 'disabled title="No reschedules left"'}>${icon('calendar')}Reschedule</button>
      <button type="button" class="btn btn-ghost btn-sm btn-danger" data-act="cancel">Cancel</button>
    </div>` : ''}
  </article>`;
}

export function renderTokenList(el, bookings, tracker, previous, opts = {}) {
  const view = opts.view || 'booked';
  if (!bookings.length) {
    if (view === 'booking') {
      el.innerHTML = `
        <div class="state empty">
          <div class="state-icon">${icon('clock')}</div>
          <h4>No live queue ticket</h4>
          <p>You have no walk-in or checked-in tokens waiting in line right now. Get a token or check into an appointment.</p>
          <button type="button" class="btn btn-primary btn-sm" data-state-action="book">Get a token now</button>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="state empty">
          <div class="state-icon">${icon('ticket')}</div>
          <h4>No booked tokens</h4>
          <p>You don't have any booked appointments. Schedule a time below or get a token.</p>
          <button type="button" class="btn btn-primary btn-sm" data-state-action="book">Book a token</button>
        </div>
      `;
    }
    return;
  }
  el.innerHTML = bookings.map((b) => tokenCardHTML(b, tracker.get(b.id))).join('');
  for (const b of bookings) {
    const before = previous.get(b.id);
    if (before && before !== b.tokenCode) $(`[data-bid="${b.id}"]`, el)?.classList.add('changed');
  }
}

export function updateLocationPanel(el, booking, loc) {
  const card = $(`[data-bid="${booking.id}"] [data-loc]`, el);
  if (card) card.innerHTML = locationPanel(booking, loc);
}

export function renderHistory(el, history) {
  el.innerHTML = history.length ? history.map((b) => {
    const st = STATUS[b.status] || { label: b.status, tone: '' };
    return `<div class="hitem"><span class="mono">${esc(b.tokenCode)}</span><span class="hitem-mid">${esc(b.service.name)}<small>${esc(b.org.name)} · ${esc(b.date)}</small></span><span class="pill ${st.tone}">${esc(st.label)}</span></div>`;
  }).join('') : '<p class="muted">Nothing here yet.</p>';
}

/* ---------------- Geofenced location ---------------- */
export function createLocationTracker({ onResult }) {
  let watchId = null;
  let targets = [];
  const lastSent = new Map();
  const cache = new Map();

  const report = (id, result) => {
    cache.set(id, result);
    onResult(id, result);
  };

  async function send(pos, force) {
    const { latitude, longitude, accuracy } = pos.coords;
    for (const b of targets) {
      if (!force && Date.now() - (lastSent.get(b.id) || 0) < LOCATION_MIN_INTERVAL_MS) continue;
      lastSent.set(b.id, Date.now());
      try {
        report(b.id, await post(`/api/bookings/${b.id}/location`, { lat: latitude, lng: longitude, accuracy }));
      } catch (err) {
        report(b.id, { error: err.message });
      }
    }
  }

  function onError(err) {
    const msg = err.code === 1
      ? 'Location permission is blocked. Allow it in your browser, or ask the front desk to check you in.'
      : "Couldn't get your location. Try again near a window or with Wi-Fi on.";
    targets.forEach((b) => report(b.id, { error: msg }));
    if (err.code === 1) stop();
  }

  function start() {
    if (!('geolocation' in navigator)) {
      targets.forEach((b) => report(b.id, { error: "This browser can't share location. Ask the desk to check you in." }));
      return;
    }
    if (watchId !== null || !targets.length) return;
    watchId = navigator.geolocation.watchPosition((p) => send(p, false), onError, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 25_000 });
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  return Object.freeze({
    setTargets(bookings) {
      const today = localDateStr();
      targets = bookings.filter((b) => b.date === today && ['booked', 'checked_in', 'called'].includes(b.status));
      if (!targets.length) stop();
    },
    checkNow() {
      if (!('geolocation' in navigator)) return start();
      navigator.geolocation.getCurrentPosition((p) => send(p, true), onError, { enableHighAccuracy: true, timeout: 25_000, maximumAge: 0 });
      start();
    },
    async autoStart() {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'granted') start();
      } catch {
        // Permissions API unavailable — wait for the user to tap "Check in"
      }
    },
    get: (id) => cache.get(id),
  });
}

/* ---------------- Reschedule dialog ---------------- */
export function openReschedule(b, onDone, activeBookings = []) {
  const today = localDateStr();
  const view = { date: b.date < today ? today : b.date, page: 0, selected: null, data: null };
  const { body, close } = openModal({
    title: `Reschedule ${b.tokenCode}`,
    iconName: 'calendar',
    body: `<p class="muted">Pick a new time for ${esc(b.service.name)} at ${esc(b.org.name)}. Your token number will change to match the new slot, and nobody else's will. ${b.reschedulesLeft} reschedule${b.reschedulesLeft === 1 ? '' : 's'} left.</p>
      <div class="date-strip" role="tablist" aria-label="Date" data-rd></div>
      <div class="slot-grid" data-rs></div>
      <div class="confirm-bar" data-rc></div>`,
  });
  const grid = $('[data-rs]', body);
  const bar = $('[data-rc]', body);

  const renderBar = () => {
    const slot = view.data?.slots.find((s) => s.index === view.selected);
    if (!slot) {
      bar.innerHTML = '<span class="grow muted">Choose a time slot.</span>';
      return;
    }
    const conflict = activeBookings?.find((x) => x.id !== b.id && x.date === view.date && x.slotTime === slot.time);
    if (conflict) {
      bar.innerHTML = `<span class="grow muted"><b style="color:var(--danger,#ef4444)">Time conflict:</b> You already hold <b class="mono">${esc(conflict.tokenCode)}</b> at ${esc(conflict.slotTime)} (${esc(conflict.org.name)}). Choose another slot.</span>`;
      return;
    }
    bar.innerHTML = `<span class="grow"><span class="mono strike">${esc(b.tokenCode)}</span> ${icon('arrow-right')} <b class="mono">${esc(slot.nextToken)}</b> · ${esc(fmt.day(view.date))} ${esc(slot.time)}</span>
      <button type="button" class="btn btn-primary" data-go>Confirm</button>`;
    $('[data-go]', bar).onclick = async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, true, 'Saving…');
      try {
        const { booking } = await post(`/api/bookings/${b.id}/reschedule`, { date: view.date, slotIndex: view.selected }, { human: true });
        toast(`${b.tokenCode} → ${booking.tokenCode}`, { body: `${fmt.day(booking.date)} at ${booking.slotTime}`, type: 'success' });
        close(true);
        onDone();
      } catch (err) {
        setBusy(btn, false);
        toast("Couldn't reschedule", { body: err.message, type: 'danger' });
        if (err.code === 'SLOT_FULL') load();
      }
    };
  };

  const draw = () => {
    const conflicts = new Set();
    if (view.data?.slots && Array.isArray(activeBookings)) {
      for (const s of view.data.slots) {
        if (activeBookings.some((x) => x.id !== b.id && x.date === view.date && x.slotTime === s.time)) {
          conflicts.add(s.index);
        }
      }
    }
    renderSlotGrid(grid, view.data, {
      selected: view.selected,
      page: view.page,
      conflicts,
      onSelect: (i) => {
        view.selected = i;
        renderBar();
      },
      onPage: (p) => {
        view.page = p;
        draw();
      },
    });
  };

  async function load() {
    grid.innerHTML = skeletons(8, 'sk-slot');
    try {
      view.data = await api(`/api/services/${b.service.id}/slots?date=${view.date}`);
      draw();
    } catch (err) {
      renderError(grid, err, load);
    }
    renderBar();
  }

  renderDateStrip($('[data-rd]', body), {
    days: RESCHEDULE_DAYS,
    selected: view.date,
    onSelect: (d) => {
      Object.assign(view, { date: d, page: 0, selected: null });
      load();
    },
  });
  load();
}
