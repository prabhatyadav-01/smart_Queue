'use strict';

/**
 * In-process pub/sub for Server-Sent Events.
 *
 * Org channels carry the public live-queue snapshot; user channels carry
 * private notifications. Org emits are debounced so a burst of queue changes
 * produces one snapshot computation per channel.
 *
 * Scaling note: to run several instances, replace emitOrg/emitUser with a
 * Redis pub/sub fan-out — the interface stays the same.
 */
const HEARTBEAT_MS = 25_000;
const DEBOUNCE_MS = 200;
const MAX_STREAMS_PER_IP = 12;

function createEventHub() {
  const orgSubs = new Map(); // orgId -> Set<res>
  const userSubs = new Map(); // userId -> Set<res>
  const perIp = new Map(); // ip -> count
  const pending = new Map(); // orgId -> timer
  let snapshotProvider = null;

  const write = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const add = (map, key, res) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(res);
  };
  const remove = (map, key, res) => {
    const set = map.get(key);
    if (!set) return;
    set.delete(res);
    if (!set.size) map.delete(key);
  };

  async function flushOrg(orgId) {
    pending.delete(orgId);
    const subs = orgSubs.get(orgId);
    if (!subs || !snapshotProvider) return;
    let snapshot;
    try {
      snapshot = await snapshotProvider(orgId, Date.now());
    } catch (err) {
      console.error('[events] snapshot failed for org', orgId, err);
      return;
    }
    for (const res of subs) write(res, 'queue', snapshot);
  }

  return {
    setSnapshotProvider(fn) {
      snapshotProvider = fn;
    },

    canSubscribe(ip) {
      return (perIp.get(ip) || 0) < MAX_STREAMS_PER_IP;
    },

    async subscribe(req, res, { orgId, userId }) {
      const ip = req.ip;
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      if (orgId) {
        add(orgSubs, orgId, res);
        if (snapshotProvider) {
          try {
            const snap = await snapshotProvider(orgId, Date.now());
            write(res, 'queue', snap);
          } catch (err) {
            console.error('[events] initial snapshot failed', err);
          }
        }
      }
      if (userId) add(userSubs, userId, res);
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

      req.on('close', () => {
        clearInterval(beat);
        if (orgId) remove(orgSubs, orgId, res);
        if (userId) remove(userSubs, userId, res);
        const left = (perIp.get(ip) || 1) - 1;
        if (left > 0) perIp.set(ip, left);
        else perIp.delete(ip);
      });
    },

    emitOrg(orgId) {
      if (!orgSubs.has(orgId) || pending.has(orgId)) return;
      pending.set(orgId, setTimeout(() => flushOrg(orgId), DEBOUNCE_MS));
    },

    emitUser(userId, payload) {
      const subs = userSubs.get(userId);
      if (!subs) return;
      for (const res of subs) write(res, 'user', payload);
    },

    stats() {
      let streams = 0;
      for (const s of orgSubs.values()) streams += s.size;
      return { orgChannels: orgSubs.size, userChannels: userSubs.size, streams };
    },
  };
}

module.exports = { createEventHub };
