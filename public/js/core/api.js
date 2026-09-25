/* JSON API client. Handles the response envelope and the human-verification retry. */
import { Human } from './human.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Connection lost. Check your internet and try again.');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok && json?.success) return json.data;
  const err = json?.error || {};
  throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message || `Unexpected server response (${res.status}).`, err);
}

/**
 * @param {string} path
 * @param {{method?: string, body?: object, human?: boolean}} [opts]
 *   human: attach behavioural telemetry (for protected actions).
 */
export async function api(path, { method = 'GET', body, human = false } = {}) {
  if (method === 'GET') return send('GET', path);
  const payload = { ...(body || {}), ...(human ? { human: Human.snapshot() } : {}) };
  try {
    return await send(method, path, payload);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'HUMAN_CHALLENGE') throw err;
    const proof = await Human.challenge(err.extra.challenge, err.message);
    if (!proof) throw new ApiError(0, 'CANCELLED', 'Verification was cancelled.');
    return send(method, path, { ...payload, challenge: proof });
  }
}

export const post = (path, body = {}, opts = {}) => api(path, { method: 'POST', body, ...opts });
