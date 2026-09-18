// Diagnostics only: independent of order/payment storage and safe under retries.
export const INCIDENT_PENDING_PREFIX = 'tepiha_incident_pending_v3:';
const CONFIRMED_KEY = 'tepiha_incident_confirmed_v3';

export function incidentKey(body = {}) {
  return JSON.stringify([
    String(body.bootId || ''), String(body.incidentType || body.reason || 'runtime_incident').slice(0, 120),
    String(body.currentPath || body.bootRootPath || '/').slice(0, 240),
    String(body.lastEventType || body.incidentType || body.reason || '').slice(0, 120),
    String(body.lastEventAt || body.startedAt || ''),
  ]);
}

export function createIncidentDelivery({ storage, fetcher, online = () => true, onConfirmed = () => {}, timeoutMs = 8000 }) {
  const pending = new Map();
  const inFlight = new Map();
  let flushing = null;
  const confirmed = new Set();
  try {
    const saved = JSON.parse(storage?.getItem(CONFIRMED_KEY) || '[]');
    if (Array.isArray(saved)) for (const key of saved) confirmed.add(String(key));
  } catch {}

  function restore() {
    try {
      for (let i = 0; i < (storage?.length || 0); i++) {
        const name = storage.key(i);
        if (!name?.startsWith(INCIDENT_PENDING_PREFIX)) continue;
        try {
          const body = JSON.parse(storage.getItem(name));
          if (body?.bootId && body?.lastEventAt && name === INCIDENT_PENDING_PREFIX + incidentKey(body)) {
            pending.set(incidentKey(body), body);
          }
        } catch {} // Preserve unreadable records; do not delete diagnostic evidence.
      }
    } catch {}
  }

  function acknowledge(key, body) {
    confirmed.add(key);
    // Only this v3 ledger contains server-confirmed acknowledgements. The old
    // sendBeacon-based sent ledger cannot prove persistence and is not reused.
    while (confirmed.size > 100) confirmed.delete(confirmed.values().next().value);
    try { storage?.setItem(CONFIRMED_KEY, JSON.stringify([...confirmed])); } catch {}
    pending.delete(key);
    try { storage?.removeItem(INCIDENT_PENDING_PREFIX + key); } catch {}
    try { onConfirmed(body); } catch {}
  }

  function deliver(body) {
    const key = incidentKey(body);
    if (confirmed.has(key)) {
      acknowledge(key, body);
      return Promise.resolve({ ok: true, duplicate: true });
    }
    if (inFlight.has(key)) return inFlight.get(key);
    if (!online()) return Promise.resolve({ ok: false, queued: true });
    const work = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        // An explicit deadline also covers a fetch implementation which ignores
        // abort. A late response cannot clear an unacknowledged pending item.
        const response = await Promise.race([
          (async () => {
            const res = await fetcher('/api/runtime-incident', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body), keepalive: true, cache: 'no-store', signal: controller.signal,
            });
            const json = await res.json().catch(() => null);
            return { res, json };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('INCIDENT_UPLOAD_TIMEOUT')); }, timeoutMs);
          }),
        ]);
        const { res, json } = response;
        if (!res.ok || json?.ok !== true || !(json.stored === true || (json.duplicate === true && json.id))) {
          return { ok: false, queued: true };
        }
        acknowledge(key, body);
        return { ok: true };
      } catch { return { ok: false, queued: true }; }
      finally { clearTimeout(timer); }
    })();
    inFlight.set(key, work);
    void work.finally(() => inFlight.delete(key));
    return work;
  }

  function send(body) {
    if (!body?.bootId || !body?.lastEventAt) return Promise.resolve({ ok: false, skipped: true });
    const key = incidentKey(body);
    if (!confirmed.has(key)) {
      pending.set(key, body);
      // Separate keys prevent a new event or another tab from replacing the
      // whole pending queue. On quota failure, keep the in-memory copy and the
      // original interrupted/early record; never evict business data.
      try { storage?.setItem(INCIDENT_PENDING_PREFIX + key, JSON.stringify(body)); } catch {}
    }
    return deliver(body);
  }

  function flush() {
    if (flushing) return flushing;
    restore();
    flushing = (async () => {
      // Bound each retry sweep; stop on failure so an outage is not flooded.
      for (const body of [...pending.values()].slice(0, 20)) {
        if (!(await deliver(body)).ok) break;
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  return { send, flush };
}
