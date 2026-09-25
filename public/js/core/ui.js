/* Shared UI helpers: escaping, icons, toasts, modals, states, formatting, number animation. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape any dynamic value before it goes into an HTML template. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" aria-hidden="true" focusable="false"><use href="/img/icons.svg#${name}"></use></svg>`;

export const CATEGORY = Object.freeze({
  government: { label: 'Government', icon: 'government' },
  hospital: { label: 'Hospitals', icon: 'hospital' },
  corporate: { label: 'Companies', icon: 'corporate' },
  bank: { label: 'Banks', icon: 'bank' },
});

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- Dates & formatting ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
export const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + n));
}

export const fmt = Object.freeze({
  minutes(m) {
    if (m === null || m === undefined) return '—';
    if (m <= 0) return 'now';
    if (m < 60) return `${Math.round(m)} min`;
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h} h ${r} min` : `${h} h`;
  },
  distance(m) {
    if (m === null || m === undefined) return '—';
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  },
  time: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  relative(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  },
  day(dateStr) {
    const today = localDateStr();
    if (dateStr === today) return 'Today';
    if (dateStr === addDays(today, 1)) return 'Tomorrow';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  },
});

export const STATUS = Object.freeze({
  booked: { label: 'Booked', tone: 'accent' },
  checked_in: { label: 'Checked in', tone: 'success' },
  called: { label: 'Your turn', tone: 'warn' },
  done: { label: 'Served', tone: '' },
  no_show: { label: 'Expired', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: '' },
});

/* ---------- Toasts ---------- */
export function toast(title, { body = '', type = 'info', timeout = 5200 } = {}) {
  let host = $('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = { success: 'check', warning: 'alert', danger: 'alert' }[type] || 'info';
  el.innerHTML = `<span class="t-icon">${icon(ic)}</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  host.append(el);
  const close = () => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const timer = setTimeout(close, timeout);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    close();
  });
}

/* ---------- Modal ---------- */
/**
 * Opens a native <dialog>. `body` is an HTML string (escape dynamic values!) or a Node.
 * Resolves with the clicked action's value, or null if dismissed.
 */
export function openModal({ title, iconName = null, body = '', actions = [], onMount } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.innerHTML = `
    <div class="modal-head">
      ${iconName ? `<span class="state-icon">${icon(iconName)}</span>` : ''}
      <h3>${esc(title)}</h3>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-icon" data-close aria-label="Close">${icon('x')}</button>
    </div>
    <div class="modal-body"></div>
    ${actions.length ? '<div class="modal-foot"></div>' : ''}`;
  const bodyEl = $('.modal-body', dialog);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);

  let settle;
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  const close = (value = null) => {
    settle(value);
    if (dialog.open) dialog.close();
  };
  const foot = $('.modal-foot', dialog);
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${a.variant || ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => close(a.value));
    foot.append(b);
  }
  $('[data-close]', dialog).addEventListener('click', () => close(null));
  dialog.addEventListener('close', () => {
    settle(null);
    setTimeout(() => dialog.remove(), 50);
  });
  document.body.append(dialog);
  dialog.showModal();
  onMount?.({ dialog, body: bodyEl, close });
  return { dialog, body: bodyEl, close, result };
}

export async function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  const { result } = openModal({
    title,
    iconName: danger ? 'alert' : 'info',
    body: `<p>${esc(message)}</p>`,
    actions: [
      { label: 'Keep it', value: false, variant: 'btn-ghost' },
      { label: confirmLabel, value: true, variant: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });
  return (await result) === true;
}

/* ---------- Loading / empty / error states ---------- */
export function stateHTML(kind, { title = '', message = '', actionLabel = '', iconName } = {}) {
  const ic = iconName || { error: 'alert', success: 'check', empty: 'layers', loading: 'clock' }[kind] || 'info';
  return `<div class="state ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
    <span class="state-icon">${kind === 'loading' ? '<span class="spinner"></span>' : icon(ic)}</span>
    ${title ? `<h4>${esc(title)}</h4>` : ''}
    ${message ? `<p class="muted">${esc(message)}</p>` : ''}
    ${actionLabel ? `<button type="button" class="btn btn-sm" data-state-action>${esc(actionLabel)}</button>` : ''}
  </div>`;
}

export const skeletons = (n, cls = '') =>
  Array.from({ length: n }, () => `<div class="skeleton ${cls}"></div>`).join('');

/** Render an error state into `el` with a retry button wired to `retry`. */
export function renderError(el, err, retry) {
  el.innerHTML = stateHTML('error', { title: "Couldn't load this", message: err?.message || 'Please try again.', actionLabel: retry ? 'Retry' : '' });
  if (retry) $('[data-state-action]', el)?.addEventListener('click', retry, { once: true });
}

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${busyLabel ? `<span>${esc(busyLabel)}</span>` : ''}`;
  } else {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

/* ---------- Motion helpers ---------- */
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

/** Smoothly count a number element to `to`. */
export function animateNumber(el, to, { duration = 900, decimals = 0 } = {}) {
  if (!el) return;
  const target = Number(to) || 0;
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(target);
  if (reducedMotion() || from === target) {
    el.textContent = target.toFixed(decimals);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    el.textContent = (from + (target - from) * easeOutExpo(p)).toFixed(decimals);
    if (p < 1 && el.dataset.value === String(target)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Split-flap style roll when text changes (token numbers). */
export function rollText(el, text) {
  if (!el) return;
  const next = String(text ?? '');
  if (el.dataset.text === next) return;
  const had = el.dataset.text !== undefined;
  el.dataset.text = next;
  if (!had || reducedMotion()) {
    el.textContent = next;
    return;
  }
  el.classList.add('roll');
  const out = document.createElement('span');
  out.className = 'roll-out';
  out.textContent = el.textContent;
  const inn = document.createElement('span');
  inn.className = 'roll-in';
  inn.textContent = next;
  el.replaceChildren(out, inn);
  inn.addEventListener('animationend', () => {
    el.replaceChildren(document.createTextNode(next));
    el.classList.remove('roll');
  }, { once: true });
}
