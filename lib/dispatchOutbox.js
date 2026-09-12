import { normalizeTransportPhoneKey } from './transport/phone.js';

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
  now = () => Date.now(), onChange = () => {}, onCommitted = () => {} }) {
  let running = null;

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
    if (notify) onChange();
    return item;
  }

  async function migrateLegacy() {
    const raw = await storage.getItem(DISPATCH_OUTBOX_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error('DISPATCH_OUTBOX_STORAGE_INVALID');
    // Copy each original UUID/payload first. A failed copy keeps the old queue.
    for (const legacy of data.items) {
      const item = decode(JSON.stringify(legacy));
      if (!await storage.getItem(itemKey(item.id))) await writeItem(item, false);
    }
    // Do not erase a legacy write that arrived during migration from an old tab.
    if (await storage.getItem(DISPATCH_OUTBOX_KEY) === raw) await storage.removeItem(DISPATCH_OUTBOX_KEY);
  }

  async function read() {
    await migrateLegacy();
    const keys = typeof storage.keys === 'function' ? await storage.keys() : [];
    if (typeof storage.keys !== 'function') {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX)) keys.push(key);
      }
    }
    const items = [];
    for (const key of keys) {
      if (!key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX)) continue;
      const raw = await storage.getItem(key);
      if (!raw) continue;
      const item = decode(raw, key.slice(DISPATCH_OUTBOX_ITEM_PREFIX.length));
      if (item.state === 'sent' && now() - item.updatedAt >= DAY) await storage.removeItem(key);
      else items.push(item);
    }
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function list() {
    const actorId = String(getActorId() || '');
    const items = await read();
    if (String(getActorId() || '') !== actorId) return [];
    return clone(items.filter((item) => item.actorId === actorId));
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

  async function drain() {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      if (!online()) return;
      for (const item of await list()) {
        if (item.state !== 'pending' || item.nextAttemptAt > now()) continue;
        if (now() > item.reviewAfter) {
          await update(item.id, { state: 'blocked', error: 'DISPATCH_OUTBOX_REVIEW_REQUIRED' });
          continue;
        }
        if (!online() || String(getActorId() || '') !== item.actorId) return;
        const persisted = await update(item.id, { sending: true });
        if (persisted.state !== 'pending') continue;
        if (!online() || String(getActorId() || '') !== item.actorId) return;
        let result;
        try { result = await submit(clone(item.payload)); }
        catch (error) { result = { ok: false, error: error?.code || error?.message || 'DISPATCH_ORDER_API_NETWORK_FAILED' }; }
        if (result?.ok === true && result.data?.id) {
          await update(item.id, { state: 'sent', sending: false, payload: null, error: '',
            code: result.data.client_tcode || result.data.code_str,
            orderId: result.data.id, deduplicatedActive: result.deduplicatedActive === true });
          await onCommitted(item, result);
        } else {
          const attempts = item.attempts + 1;
          const retry = isRetryableDispatchFailure(result);
          await update(item.id, { sending: false, state: retry ? 'pending' : 'blocked', attempts,
            nextAttemptAt: now() + Math.min(30000, 2000 * (2 ** Math.min(attempts - 1, 4))),
            error: String(result?.error || 'DISPATCH_ORDER_RESPONSE_NOT_VERIFIED') });
        }
      }
    });
    try { await running; } finally { running = null; }
  }

  async function retry(id) {
    const item = (await list()).find((item) => item.id === id);
    if (!item || item.state === 'sent') return;
    await update(id, { state: 'pending', sending: false, nextAttemptAt: now(), reviewAfter: now() + DAY });
  }

  return { enqueue, list, drain, retry };
}
