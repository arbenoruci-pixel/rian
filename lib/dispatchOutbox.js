import { normalizeTransportPhoneKey } from './transport/phone.js';

export const DISPATCH_OUTBOX_KEY = 'tepiha_dispatch_outbox_v1';
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

  function read() {
    const raw = storage.getItem(DISPATCH_OUTBOX_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error('DISPATCH_OUTBOX_STORAGE_INVALID');
    return data.items;
  }

  function write(items) {
    const retained = items.filter((item) => item.state !== 'sent' || now() - item.updatedAt < DAY);
    const serialized = JSON.stringify({ version: 1, items: retained });
    storage.setItem(DISPATCH_OUTBOX_KEY, serialized);
    if (storage.getItem(DISPATCH_OUTBOX_KEY) !== serialized) throw new Error('DISPATCH_OUTBOX_STORAGE_FAILED');
    onChange();
  }

  function list() {
    const actorId = String(getActorId() || '');
    return clone(read().filter((item) => item.actorId === actorId && (item.state !== 'sent' || now() - item.updatedAt < DAY)));
  }

  function update(id, change) {
    const items = read();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('DISPATCH_OUTBOX_ITEM_MISSING');
    // A second tab may already have confirmed this same immutable request.
    if (items[index].state === 'sent') return items[index];
    items[index] = { ...items[index], ...change, updatedAt: now() };
    write(items);
    return items[index];
  }

  function enqueue(payload) {
    const actorId = String(getActorId() || '');
    if (!UUID.test(actorId)) throw new Error('AUTH_REQUIRED');
    if (payload?.expected_actor_id != null && payload.expected_actor_id !== actorId) throw new Error('DISPATCH_ORDER_ACTOR_SESSION_MISMATCH');
    if (!UUID.test(payload?.id || '')) throw new Error('DISPATCH_ORDER_UUID_INVALID');
    const phoneKey = normalizeTransportPhoneKey(payload.client_phone);
    if (!phoneKey) throw new Error('TRANSPORT_PHONE_INVALID');
    const items = read();
    const existing = items.find((item) => item.actorId === actorId && item.state !== 'sent' && item.phoneKey === phoneKey);
    if (existing) return { ...clone(existing), alreadyQueued: true };
    if (items.some((item) => item.id === payload.id)) throw new Error('DISPATCH_OUTBOX_ID_CONFLICT');
    const item = { id: payload.id, actorId, phoneKey, name: payload.client_name,
      phone: payload.client_phone, state: 'pending', attempts: 0, createdAt: now(),
      updatedAt: now(), nextAttemptAt: now(), reviewAfter: now() + DAY, error: '',
      payload: clone({ ...payload, expected_actor_id: actorId }) };
    write([...items, item]);
    return clone(item);
  }

  async function drain() {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      if (!online()) return;
      for (const item of list()) {
        if (item.state !== 'pending' || item.nextAttemptAt > now()) continue;
        if (now() > item.reviewAfter) {
          update(item.id, { state: 'blocked', error: 'DISPATCH_OUTBOX_REVIEW_REQUIRED' });
          continue;
        }
        if (!online() || String(getActorId() || '') !== item.actorId) return;
        update(item.id, { sending: true });
        let result;
        try { result = await submit(clone(item.payload)); }
        catch (error) { result = { ok: false, error: error?.code || error?.message || 'DISPATCH_ORDER_API_NETWORK_FAILED' }; }
        if (result?.ok === true && result.data?.id) {
          update(item.id, { state: 'sent', sending: false, payload: null, error: '',
            code: result.data.client_tcode || result.data.code_str,
            orderId: result.data.id, deduplicatedActive: result.deduplicatedActive === true });
          onCommitted(item, result);
        } else {
          const attempts = item.attempts + 1;
          const retry = isRetryableDispatchFailure(result);
          update(item.id, { sending: false, state: retry ? 'pending' : 'blocked', attempts,
            nextAttemptAt: now() + Math.min(30000, 2000 * (2 ** Math.min(attempts - 1, 4))),
            error: String(result?.error || 'DISPATCH_ORDER_RESPONSE_NOT_VERIFIED') });
        }
      }
    });
    try { await running; } finally { running = null; }
  }

  function retry(id) {
    const item = list().find((item) => item.id === id);
    if (!item || item.state === 'sent') return;
    update(id, { state: 'pending', sending: false, nextAttemptAt: now(), reviewAfter: now() + DAY });
  }

  return { enqueue, list, drain, retry };
}
