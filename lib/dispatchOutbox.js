import { normalizeTransportPhoneKey } from './transport/phone.js';
import { withDeadline } from './boundedRequest.js';

export const DISPATCH_OUTBOX_KEY = 'tepiha_dispatch_outbox_v1';
export const DISPATCH_OUTBOX_ITEM_PREFIX = 'tepiha_dispatch_outbox_item_v2:';
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clone = (value) => JSON.parse(JSON.stringify(value));

export function isRetryableDispatchFailure(result) {
  const code = String(result?.error || result?.code || '').toUpperCase();
  if (/AUTH_REQUIRED|NOT_APPROVED|NOT_ALLOWED|MISMATCH|CONFLICT|INVALID|DISABLED|RETIRED|OTHER_USER/.test(code)) return false;
  return /NETWORK|TIMEOUT|UNREACHABLE/.test(code)
    || /^(AUTH_DEVICE_LOOKUP_FAILED|AUTH_USER_LOOKUP_FAILED|DISPATCH_DRIVER_LOOKUP_FAILED|DISPATCH_ORDER_VERIFY_FAILED|DISPATCH_ORDER_RPC_FAILED|DISPATCH_ORDER_REQUEST_FAILED)$/.test(code)
    || /HTTP_(408|425|429|500|502|503|504)$/.test(code)
    || [408, 425, 429, 500, 502, 503, 504].includes(Number(result?.httpStatus));
}

// Persist the complete, immutable request BEFORE its first network write. The
// UUID journal alone cannot recover a lost form or prevent fingerprint changes.
export function createDispatchOutbox({ storage, getActorId, submit, online = () => true,
  now = () => Date.now(), onChange = () => {}, onCommitted = () => {}, onIssue = () => {}, submitTimeoutMs = 35000 }) {
  let running = null;
  let forceRequested = false, drainingForced = false;
  const sending = new Map();
  const receipts = new Map();
  const receiptWrites = new Map();
  const reported = new Set();
  function issue(error, id = '', stage = '') {
    const message = String(error?.code || error?.message || '');
    const code = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : String(error?.name || 'DISPATCH_QUEUE_FAILED');
    if (reported.has(code + id)) return;
    reported.add(code + id);
    try { onIssue({ code, id, stage }); } catch {}
  }
  function changed() { try { onChange(); } catch (error) { issue(error); } }

  const itemKey = (id) => DISPATCH_OUTBOX_ITEM_PREFIX + id;

  function decode(raw, expectedId = '') {
    const item = JSON.parse(raw);
    if (!UUID.test(item?.id || '') || (expectedId && item.id !== expectedId)
      || !UUID.test(item?.actorId || '') || !['pending', 'blocked', 'sent'].includes(item?.state)) {
      throw new Error('DISPATCH_OUTBOX_STORAGE_INVALID');
    }
    return item;
  }

  async function writeItem(item, notify = true) {
    const key = itemKey(item.id);
    const previous = await storage.getItem(key);
    // Respect a confirmation already visible from another tab.
    if (previous && decode(previous, item.id).state === 'sent') return decode(previous, item.id);
    const serialized = JSON.stringify(item);
    await storage.setItem(key, serialized);
    const saved = await storage.getItem(key);
    if (saved !== serialized) {
      if (saved && decode(saved, item.id).state === 'sent') return decode(saved, item.id);
      throw new Error('DISPATCH_OUTBOX_STORAGE_FAILED');
    }
    if (notify) changed();
    return item;
  }

  async function migrateLegacy() {
    const raw = await storage.getItem(DISPATCH_OUTBOX_KEY);
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error('DISPATCH_OUTBOX_STORAGE_INVALID');
    } catch (error) { issue(error, 'legacy'); return; }
    let intact = true;
    // Copy each original UUID/payload first. A failed copy keeps the old queue.
    for (const legacy of data.items) {
      let item;
      try { item = decode(JSON.stringify(legacy)); }
      catch (error) { intact = false; issue(error, 'legacy'); continue; }
      if (!await storage.getItem(itemKey(item.id))) await writeItem(item, false);
    }
    // Do not erase a legacy write that arrived during migration from an old tab.
    if (intact && await storage.getItem(DISPATCH_OUTBOX_KEY) === raw) await storage.removeItem(DISPATCH_OUTBOX_KEY);
  }

  async function read() {
    await migrateLegacy();
    let entries;
    if (typeof storage.entries === 'function') entries = await storage.entries(DISPATCH_OUTBOX_ITEM_PREFIX);
    else {
      const keys = typeof storage.keys === 'function' ? await storage.keys() : [];
      if (typeof storage.keys !== 'function') {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX)) keys.push(key);
        }
      }
      entries = await Promise.all(keys.filter(key => key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX)).map(async key => [key, await storage.getItem(key)]));
    }
    const items = [], expired = [];
    for (const [key, raw] of entries) {
      if (!key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX)) continue;
      let item;
      try { item = receipts.get(key.slice(DISPATCH_OUTBOX_ITEM_PREFIX.length)) || decode(raw, key.slice(DISPATCH_OUTBOX_ITEM_PREFIX.length)); }
      catch (error) { issue(error, key.slice(DISPATCH_OUTBOX_ITEM_PREFIX.length)); continue; }
      if (item.state === 'sent' && now() - item.updatedAt >= DAY) {
        expired.push(key);
      }
      else items.push(item);
    }
    if (expired.length) {
      try {
        if (typeof storage.removeItems === 'function') await storage.removeItems(expired);
        else await Promise.all(expired.map(key => storage.removeItem(key)));
        for (const key of expired) receipts.delete(key.slice(DISPATCH_OUTBOX_ITEM_PREFIX.length));
      } catch (error) { issue(error); }
    }
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function list() {
    const actorId = String(getActorId() || '');
    const items = await read();
    if (String(getActorId() || '') !== actorId) return [];
    return clone(items.filter((item) => item.actorId === actorId).map(item => {
      if (item.state === 'pending' && sending.has(item.id)) return { ...item, sending: true };
      return item.sending ? { ...item, sending: false } : item;
    }));
  }

  async function update(id, change) {
    const raw = await storage.getItem(itemKey(id));
    if (!raw) throw new Error('DISPATCH_OUTBOX_ITEM_MISSING');
    const item = decode(raw, id);
    if (item.state === 'sent') return item;
    // Device clocks can move backward on resume. State ordering must advance
    // independently of wall time so a blocked order can always be retried.
    return writeItem({ ...item, ...change, revision: Number(item.revision || 0) + 1, updatedAt: now() });
  }

  async function enqueue(payload) {
    const actorId = String(getActorId() || '');
    if (!UUID.test(actorId)) throw new Error('AUTH_REQUIRED');
    if (payload?.expected_actor_id != null && payload.expected_actor_id !== actorId) throw new Error('DISPATCH_ORDER_ACTOR_SESSION_MISMATCH');
    if (!UUID.test(payload?.id || '')) throw new Error('DISPATCH_ORDER_UUID_INVALID');
    const phoneKey = normalizeTransportPhoneKey(payload.client_phone);
    if (!phoneKey) throw new Error('TRANSPORT_PHONE_INVALID');
    const frozenPayload = clone(payload);
    const items = await read();
    if (String(getActorId() || '') !== actorId) throw new Error('DISPATCH_ORDER_ACTOR_SESSION_MISMATCH');
    const existing = items.find((item) => item.actorId === actorId && item.state !== 'sent' && item.phoneKey === phoneKey);
    if (existing) return { ...clone(existing), alreadyQueued: true };
    if (items.some((item) => item.id === frozenPayload.id)) throw new Error('DISPATCH_OUTBOX_ID_CONFLICT');
    const item = { id: frozenPayload.id, actorId, phoneKey, name: frozenPayload.client_name,
      phone: frozenPayload.client_phone, state: 'pending', attempts: 0, createdAt: now(),
      updatedAt: now(), nextAttemptAt: now(), reviewAfter: now() + DAY, error: '',
      payload: { ...frozenPayload, expected_actor_id: actorId } };
    // One storage key per request: independent tabs cannot overwrite another order.
    await writeItem(item);
    return clone(item);
  }

  function send(id, { force = false } = {}) {
    if (sending.has(id)) return sending.get(id);
    let started = false;
    const work = Promise.resolve().then(async () => {
        // A verified response remains authoritative even if IndexedDB is
        // temporarily unavailable while persisting its receipt.
        const confirmed = receipts.get(id);
        if (confirmed) {
          if (String(getActorId() || '') !== confirmed.actorId) throw new Error('DISPATCH_ORDER_ACTOR_SESSION_MISMATCH');
          return confirmed;
        }
        const raw = await storage.getItem(itemKey(id));
        if (!raw) throw new Error('DISPATCH_OUTBOX_ITEM_MISSING');
        const item = receipts.get(id) || decode(raw, id);
        if (String(getActorId() || '') !== item.actorId) throw new Error('DISPATCH_ORDER_ACTOR_SESSION_MISMATCH');
        if (item.state !== 'pending' || !online() || (!force && item.nextAttemptAt > now())) return item;
        if (now() > item.reviewAfter) {
          return update(item.id, { state: 'blocked', error: 'DISPATCH_OUTBOX_REVIEW_REQUIRED' });
        }
        // The complete request is already durable. The live sending map drives
        // the spinner; a status-only IndexedDB write must not delay CREATE.
        started = true;
        changed();
        if (!online() || String(getActorId() || '') !== item.actorId) return item;
        let result;
        try { result = await withDeadline(() => submit(clone(item.payload)), submitTimeoutMs, 'DISPATCH_ORDER_API_TIMEOUT'); }
        catch (error) { result = { ok: false, httpStatus: error?.httpStatus, error: error?.code || error?.message || 'DISPATCH_ORDER_API_NETWORK_FAILED' }; }
        if (result?.ok === true && result.data?.id) {
          const change = { state: 'sent', sending: false, payload: null, error: '',
            confirmedOrder: clone(result.data),
            code: result.data.client_tcode || result.data.code_str,
            orderId: result.data.id, deduplicatedActive: result.deduplicatedActive === true };
          const receipt = { ...item, ...change, revision: Number(item.revision || 0) + 1, updatedAt: now() };
          receipts.set(id, receipt);
          // Show the validated server result immediately. Persist in parallel;
          // on failure the original durable UUID/payload remains replayable.
          // Start the atomic write before publishing success: a fresh page's
          // read must not overtake several preparatory readonly transactions.
          // The storage adapter atomically merges; sent wins over stale writes.
          const saving = (async () => {
            await storage.setItem(itemKey(id), JSON.stringify(receipt));
            const saved = await storage.getItem(itemKey(id));
            if (!saved || decode(saved, id).state !== 'sent') throw new Error('DISPATCH_OUTBOX_STORAGE_FAILED');
          })()
            .catch(error => issue(error, id, 'receipt_save'))
            .finally(() => { receiptWrites.delete(id); changed(); });
          receiptWrites.set(id, saving);
          changed();
          try { Promise.resolve(onCommitted(item, result)).catch(error => issue(error, id)); } catch (error) { issue(error, id); }
          return receipt;
        } else {
          const attempts = item.attempts + 1;
          const retry = isRetryableDispatchFailure(result);
          return update(item.id, { sending: false, state: retry ? 'pending' : 'blocked', attempts,
            nextAttemptAt: now() + Math.min(30000, 2000 * (2 ** Math.min(attempts - 1, 4))),
            error: String(result?.error || 'DISPATCH_ORDER_RESPONSE_NOT_VERIFIED') });
        }
    }).finally(() => { sending.delete(id); if (started && !receipts.has(id)) changed(); });
    sending.set(id, work);
    return work;
  }

  async function drain({ force = false } = {}) {
    // A real reconnect may happen during a normal drain. Remember one follow-up
    // pass, while coalescing further resume events into an active forced pass.
    if (force && !drainingForced) forceRequested = true;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      const joinedRetries = new Set();
      do {
        if (!online()) return;
        drainingForced = forceRequested;
        forceRequested = false;
        const items = await list();
        // Two bounded workers prevent a slow response from blocking all old work.
        // A just-created order can call send(id) directly without waiting here.
        let next = 0;
        const worker = async () => {
          while (next < items.length) {
            const item = items[next++];
            if (item.state !== 'pending') continue;
            try {
              const joined = drainingForced && sending.has(item.id);
              const result = await send(item.id, { force: drainingForced });
              // The form can own a direct send outside this drain. Joining that
              // pre-reconnect attempt must not consume the recovery attempt.
              // Bound it to one follow-up per ID, preserving failure backoff.
              if (joined && result?.state === 'pending' && !joinedRetries.has(item.id)) {
                joinedRetries.add(item.id);
                forceRequested = true;
              }
            } catch (error) { issue(error, item.id); }
          }
        };
        await Promise.all([worker(), worker()]);
        // A completed background drain also flushes receipt persistence. Direct
        // submissions return as soon as the authoritative response is validated.
        await Promise.all([...receiptWrites.values()]);
        drainingForced = false;
      } while (forceRequested);
    });
    try { await running; } finally { running = null; drainingForced = false; forceRequested = false; }
  }

  async function retry(id) {
    const item = (await list()).find((item) => item.id === id);
    if (!item || item.state === 'sent') return;
    await update(id, { state: 'pending', sending: false, nextAttemptAt: now(), reviewAfter: now() + DAY });
  }

  return { enqueue, list, drain, retry, send };
}
