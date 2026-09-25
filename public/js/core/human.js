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

const state = { moves: [], clicks: [], keys: [], touches: 0, untrusted: 0 };
let lastMoveT = -1;

const pushCapped = (arr, item, max) => {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

addEventListener('pointermove', (e) => {
  if (!e.isTrusted) {
    state.untrusted++;
    return;
  }
  if (e.pointerType === 'touch') return;
  const now = t();
  if (now === lastMoveT) return;
  lastMoveT = now;
  pushCapped(state.moves, [now, Math.round(e.clientX), Math.round(e.clientY)], LIMITS.moves);
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
  return {
    moves: state.moves.slice(),
    clicks: state.clicks.slice(),
    keys: state.keys.slice(),
    touches: state.touches,
    untrusted: state.untrusted,
    webdriver: navigator.webdriver === true,
    dwellMs: t(),
  };
}

/** Score only the most recent movement window (for the live meter on the landing page). */
function liveScore(windowSize = 160) {
  if (!window.BotScore) return null;
  const snap = snapshot();
  return window.BotScore.analyze({ ...snap, moves: snap.moves.slice(-windowSize), clicks: [], dwellMs: 0 });
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

export const Human = Object.freeze({ snapshot, liveScore, challenge });
