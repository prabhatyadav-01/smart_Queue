/*
 * Behavioural telemetry for bot detection.
 * Collects pointer movement, click positions and keystroke *timing* (never key
 * values). The server scores it; the client never decides it is human.
 */
import { icon, openModal, esc, $ } from './ui.js';

const T0 = performance.now();
const LIMITS = { moves: 400, clicks: 60, keys: 200 };
const HOLD_MS = 1650;
const t = () => Math.round(performance.now() - T0);

const state = { 
  moves: [], 
  touchMoves: [],
  clicks: [], 
  keys: [], 
  touches: 0, 
  untrusted: 0,
  touchMetrics: { avgRadius: 10, pressureVariance: 0.1, count: 0 }
};
let lastMoveT = -1;
let lastTouchT = -1;

const pushCapped = (arr, item, max) => {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

// Pointer tracking (mouse and pen)
addEventListener('pointermove', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  const now = t();
  if (e.pointerType === 'touch') {
    // Touch pointer events
    if (now === lastTouchT) return;
    lastTouchT = now;
    const pt = [now, Math.round(e.clientX), Math.round(e.clientY)];
    pushCapped(state.touchMoves, pt, LIMITS.moves);
    pushCapped(state.moves, pt, LIMITS.moves);
    if (e.width && e.height) {
      const radius = (e.width + e.height) / 4;
      state.touchMetrics.avgRadius = Math.round((state.touchMetrics.avgRadius * 0.8) + (radius * 0.2));
    }
    return;
  }
  if (now === lastMoveT) return;
  lastMoveT = now;
  pushCapped(state.moves, [now, Math.round(e.clientX), Math.round(e.clientY)], LIMITS.moves);
}, { passive: true, capture: true });

// Touch event tracking (swipes, drags, taps)
addEventListener('touchmove', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  const touch = e.touches[0];
  if (!touch) return;
  const now = t();
  if (now === lastTouchT) return;
  lastTouchT = now;
  const pt = [now, Math.round(touch.clientX), Math.round(touch.clientY)];
  pushCapped(state.touchMoves, pt, LIMITS.moves);
  pushCapped(state.moves, pt, LIMITS.moves);
  if (touch.radiusX && touch.radiusY) {
    const r = (touch.radiusX + touch.radiusY) / 2;
    state.touchMetrics.avgRadius = Math.round((state.touchMetrics.avgRadius * 0.7) + (r * 0.3));
  }
}, { passive: true, capture: true });

addEventListener('touchstart', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  state.touches++;
  state.touchMetrics.count++;
  const touch = e.touches[0];
  if (touch) {
    const pt = [t(), Math.round(touch.clientX), Math.round(touch.clientY)];
    pushCapped(state.touchMoves, pt, LIMITS.moves);
    pushCapped(state.moves, pt, LIMITS.moves);
  }
}, { passive: true, capture: true });

addEventListener('pointerdown', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    state.touches++;
    return;
  }
  pushCapped(state.clicks, [t(), Math.round(e.clientX), Math.round(e.clientY)], LIMITS.clicks);
}, { passive: true, capture: true });

addEventListener('keydown', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  if (!e.repeat) pushCapped(state.keys, t(), LIMITS.keys);
}, { capture: true });

function snapshot() {
  const isTouch = state.touches > 0 || state.touchMoves.length > 0;
  return {
    moves: state.moves.slice(),
    touchMoves: state.touchMoves.slice(),
    clicks: state.clicks.slice(),
    keys: state.keys.slice(),
    touches: state.touches,
    touchMetrics: { ...state.touchMetrics },
    untrusted: state.untrusted,
    webdriver: navigator.webdriver === true,
    dwellMs: t(),
    mode: isTouch ? 'touch' : 'pointer',
  };
}

/** Score only the most recent movement window (for the live meter on the landing page). */
function liveScore(windowSize = 160) {
  if (!window.BotScore) return null;
  const snap = snapshot();
  const moves = snap.moves.slice(-windowSize);
  const touchMoves = snap.touchMoves.slice(-windowSize);
  return window.BotScore.analyze({ 
    ...snap, 
    moves: moves, 
    touchMoves: touchMoves,
    clicks: [], 
    dwellMs: 0 
  });
}

/**
 * Press-and-hold challenge shown when the server can't tell from behaviour.
 * Resolves { token, holdMs } or null if the user closes it.
 */
function challenge(token, message) {
  const { body, close, result } = openModal({
    title: 'Quick human check',
    iconName: 'fingerprint',
    body: `
      <p>${esc(message || 'Press and hold to confirm you are human.')} Keep holding until the ring fills. This stops automated bots from grabbing tokens.</p>
      <button type="button" class="hold" aria-label="Press and hold to verify">${icon('hand')}</button>
      <p class="muted" data-hold-status aria-live="polite">Hold for about 2 seconds.</p>`,
  });
  const btn = $('.hold', body);
  const status = $('[data-hold-status]', body);
  let start = 0;
  let raf = 0;
  let done = false;

  const setP = (p) => btn.style.setProperty('--p', String(p));
  const reset = () => {
    if (done) return;
    cancelAnimationFrame(raf);
    btn.classList.remove('is-holding');
    setP(0);
    if (start) status.textContent = 'Released too early — hold a little longer.';
    start = 0;
  };
  const tick = () => {
    const elapsed = performance.now() - start;
    setP(Math.min(1, elapsed / HOLD_MS));
    if (elapsed >= HOLD_MS) {
      done = true;
      btn.classList.remove('is-holding');
      btn.classList.add('is-done');
      btn.innerHTML = icon('check');
      status.textContent = 'Thanks — verifying…';
      setTimeout(() => close({ token, holdMs: Math.round(elapsed) }), 350);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    if (done || start || !e.isTrusted) return;
    e.preventDefault();
    start = performance.now();
    btn.classList.add('is-holding');
    status.textContent = 'Keep holding…';
    raf = requestAnimationFrame(tick);
  };

  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture?.(e.pointerId);
    begin(e);
  });
  btn.addEventListener('pointerup', reset);
  btn.addEventListener('pointercancel', reset);
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') begin(e);
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') reset();
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.focus();
  return result;
}

function recordTouchPoint(x, y) {
  const now = t();
  const pt = [now, Math.round(x), Math.round(y)];
  state.touches++;
  pushCapped(state.touchMoves, pt, LIMITS.moves);
  pushCapped(state.moves, pt, LIMITS.moves);
}

export const Human = Object.freeze({ snapshot, liveScore, challenge, recordTouchPoint });
