// Diagnostics only: independent of order/payment storage and safe under retries.
export const INCIDENT_PENDING_PREFIX = 'tepiha_incident_pending_v3:';
const CONFIRMED_KEY = 'tepiha_incident_confirmed_v3';
export const MAX_PENDING_INCIDENTS = 40;
export const MAX_PENDING_INCIDENT_CHARS = 32768; // At most ~64 KiB of UTF-16 diagnostic entries.
const MAX_BODY_CHARS = 8192;
const OVERFLOW_KEY = 'tepiha_incident_overflow_v3';

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

  function recordOverflow(reason) {
    // Compact evidence of an error storm; never evict an unconfirmed sample or
    // touch order/payment keys to make room for diagnostics.
    try {
      const previous = JSON.parse(storage?.getItem(OVERFLOW_KEY) || '{}');
      const at = new Date().toISOString();
      storage?.setItem(OVERFLOW_KEY, JSON.stringify({
        count: Math.min(Number(previous?.count || 0) + 1, Number.MAX_SAFE_INTEGER),
        firstAt: previous?.firstAt || at, lastAt: at, reason,
      }));
    } catch {}
  }

  function hasCapacity(key, raw) {
    if (raw.length > MAX_BODY_CHARS) return false;
    // Include other tabs' stored entries and in-memory entries whose storage
    // write failed. Both queues remain bounded even when Web Storage is full.
    const entries = new Map([...pending].map(([k, b]) => [INCIDENT_PENDING_PREFIX + k, JSON.stringify(b)]));
    try {
      for (let i = 0; i < (storage?.length || 0); i++) {
        const name = storage.key(i);
        if (name?.startsWith(INCIDENT_PENDING_PREFIX)) entries.set(name, storage.getItem(name) || '');
      }
    } catch {}
    entries.set(INCIDENT_PENDING_PREFIX + key, raw);
    return entries.size <= MAX_PENDING_INCIDENTS
      && [...entries].reduce((size, [k, value]) => size + k.length + value.length, 0) <= MAX_PENDING_INCIDENT_CHARS;
  }

  function restore() {
    try {
      for (let i = 0; i < (storage?.length || 0); i++) {
        const name = storage.key(i);
        if (!name?.startsWith(INCIDENT_PENDING_PREFIX)) continue;
        try {
          const body = JSON.parse(storage.getItem(name));
          if (body?.bootId && body?.lastEventAt && name === INCIDENT_PENDING_PREFIX + incidentKey(body)
            && pending.size < MAX_PENDING_INCIDENTS) {
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
      let raw;
      try { raw = JSON.stringify(body); } catch { return Promise.resolve({ ok: false, skipped: true }); }
      // Existing samples remain retryable at capacity. Refuse additional
      // samples explicitly, without marking them sent or clearing their source.
      if (!pending.has(key) && !hasCapacity(key, raw)) {
        recordOverflow('INCIDENT_QUEUE_CAPACITY');
        return Promise.resolve({ ok: false, skipped: true, queued: false, reason: 'INCIDENT_QUEUE_CAPACITY' });
      }
      if (pending.has(key)) return deliver(pending.get(key));
      pending.set(key, body);
      // Separate keys prevent a new event or another tab from replacing the
      // whole pending queue. On quota failure, keep the in-memory copy and the
      // original interrupted/early record; never evict business data.
      try { storage?.setItem(INCIDENT_PENDING_PREFIX + key, raw); } catch {}
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
