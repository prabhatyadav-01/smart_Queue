import { icon } from './ui.js';

const STORAGE_KEY = 'sq-theme';
const THEMES = Object.freeze([
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'gray', label: 'Neutral gray', icon: 'gray' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
]);
const FALLBACK_TRANSITION_MS = 520;

export const getTheme = () => document.documentElement.dataset.theme || 'light';

function apply(id) {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable — the theme still applies for this page view
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: id }));
}

/** Switch theme with a circular reveal from `origin` (View Transitions), or a cross-fade fallback. */
export function setTheme(id, origin) {
  if (!THEMES.some((t) => t.id === id) || id === getTheme()) return;
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && typeof document.startViewTransition === 'function') {
    if (origin) {
      const r = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
      root.style.setProperty('--vt-x', `${origin.x}px`);
      root.style.setProperty('--vt-y', `${origin.y}px`);
      root.style.setProperty('--vt-r', `${r}px`);
    }
    document.startViewTransition(() => apply(id));
    return;
  }
  root.classList.add('theme-anim');
  apply(id);
  setTimeout(() => root.classList.remove('theme-anim'), FALLBACK_TRANSITION_MS);
}

export function mountThemeSwitcher(host) {
  if (!host) return;
  host.classList.add('theme-switch');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Colour theme');
  host.innerHTML = `<span class="thumb" aria-hidden="true"></span>${THEMES.map(
    (t) => `<button type="button" data-theme-id="${t.id}" aria-label="${t.label} theme" title="${t.label}">${icon(t.icon)}</button>`,
  ).join('')}`;

  const sync = () => {
    const current = getTheme();
    host.style.setProperty('--i', String(Math.max(0, THEMES.findIndex((t) => t.id === current))));
    host.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeId === current)));
  };

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme-id]');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setTheme(btn.dataset.themeId, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  });
  document.addEventListener('themechange', sync);
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) setTheme(e.newValue);
  });
  sync();
}
