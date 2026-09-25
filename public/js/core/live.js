/* Live updates over Server-Sent Events, with a polling fallback and manual reconnect. */
import { api } from './api.js';

const POLL_MS = 5000;
const RECONNECT_MS = 5000;

/**
 * @param {number|null} orgId  public queue channel to follow (null = personal events only)
 * @param {{onSnapshot?: Function, onUser?: Function, onStatus?: Function}} handlers
 * @returns {() => void} disconnect
 */
export function connectLive(orgId, { onSnapshot, onUser, onStatus } = {}) {
  let closed = false;
  let es = null;
  let timer = null;

  const status = (s) => onStatus?.(s);

  if (!('EventSource' in window)) {
    const poll = async () => {
      if (closed || !orgId) return;
      try {
        onSnapshot?.(await api(`/api/orgs/${orgId}/queue`));
        status('live');
      } catch {
        status('reconnecting');
      }
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }

  const open = () => {
    if (closed) return;
    status('connecting');
    es = new EventSource(orgId ? `/api/stream?org=${orgId}` : '/api/stream');
    es.onopen = () => status('live');
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        status('offline');
        timer = setTimeout(open, RECONNECT_MS);
      } else {
        status('reconnecting');
      }
    };
    es.addEventListener('queue', (e) => {
      try {
        onSnapshot?.(JSON.parse(e.data));
      } catch (err) {
        console.error('[live] bad queue event', err);
      }
    });
    es.addEventListener('user', (e) => {
      try {
        onUser?.(JSON.parse(e.data));
      } catch (err) {
        console.error('[live] bad user event', err);
      }
    });
  };
  open();

  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
}

const LABELS = {
  connecting: ['off', 'Connecting…'],
  live: ['', 'Live'],
  reconnecting: ['warn', 'Reconnecting…'],
  offline: ['off', 'Offline — retrying'],
};

export function renderLiveStatus(el, status) {
  if (!el) return;
  const [cls, label] = LABELS[status] || LABELS.connecting;
  el.innerHTML = `<span class="live-dot ${cls}"></span>${label}`;
  el.classList.toggle('success', status === 'live');
}
