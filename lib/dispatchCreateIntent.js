import { normalizeTransportPhoneKey } from './transport/phone.js';

const DISPATCH_CREATE_INTENT_STORAGE_KEY = 'tepiha_dispatch_create_intent_v1';
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? '').trim();
}

function phoneDigits(value) {
  return normalizeTransportPhoneKey(value);
}

function createUuid() {
  try {
    if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const random = Math.floor(Math.random() * 16);
    const value = ch === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}

function isUuid(value) {
  return UUID_RE.test(text(value));
}

function resolveStorage(candidate) {
  if (candidate) return candidate;
  try { return globalThis?.localStorage || null; } catch { return null; }
}

function fallbackHash(value) {
  // Four independent 32-bit lanes avoid persisting customer PII when SubtleCrypto
  // is unavailable (old WebViews). This is a local cache key, never a DB identity.
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const lanes = seeds.map((seed, lane) => {
    let hash = seed >>> 0;
    for (let index = lane; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
    }
    return hash.toString(16).padStart(8, '0');
  });
  return `fallback-${lanes.join('')}-${value.length}`;
}

async function hashSignature(value) {
  const input = String(value || '');
  try {
    const subtle = globalThis?.crypto?.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  return fallbackHash(input);
}

export function buildDispatchCreateIntentSignature(input = {}) {
  return JSON.stringify({
    version: 1,
    actor: text(input.actor),
    poolOwner: text(input.poolOwner),
    name: text(input.name),
    phone: phoneDigits(input.phone),
    address: text(input.address),
    note: text(input.note),
    pickupMeasurements: text(input.pickupMeasurements),
    plannedPieces: Number(input.plannedPieces) || 0,
    plannedDate: text(input.plannedDate),
    slot: text(input.slot),
    planMode: text(input.planMode),
    driverId: text(input.driverId),
  });
}

export function createDispatchCreateIntentJournal(options = {}) {
  const storage = resolveStorage(options.storage);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const uuidFactory = typeof options.uuidFactory === 'function' ? options.uuidFactory : createUuid;
  const signatureHasher = typeof options.hashSignature === 'function' ? options.hashSignature : hashSignature;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_INTENT_TTL_MS;
  let current = null;
  const records = new Map();

  function isExpired(record) {
    const startedAt = Number(record?.createdAt ?? record?.updatedAt);
    return !Number.isFinite(startedAt) || (now() - startedAt) > ttlMs;
  }

  function readPersisted() {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY) || 'null');
      const entries = parsed?.version === 2 ? parsed.intents :
        parsed?.version === 1 ? { legacy: parsed } : {};
      return Object.fromEntries(Object.entries(entries || {}).filter(([, record]) =>
        isUuid(record?.orderId) && Number.isFinite(Number(record?.updatedAt)) && !isExpired(record),
      ));
    } catch {
      return {};
    }
  }

  function persist(identityHash, record) {
    if (!storage) return;
    try {
      const intents = readPersisted();
      delete intents.legacy;
      intents[identityHash] = {
        signatureHash: record.signatureHash,
        orderId: record.orderId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      storage.setItem(DISPATCH_CREATE_INTENT_STORAGE_KEY, JSON.stringify({ version: 2, intents }));
    } catch {}
  }

  async function acquire(input = {}) {
    const signature = buildDispatchCreateIntentSignature(input);
    if (current && isExpired(current)) current = null;
    if (current?.signature === signature && isUuid(current?.orderId)) return current.orderId;
    // Serialize acquisition, then re-evaluate the caller's identity. A different
    // phone must never borrow the UUID of the acquisition already in flight.
    if (current?.pending) {
      await current.pending;
      return acquire(input);
    }

    const pending = (async () => {
      const signatureHash = await signatureHasher(signature);
      const identityHash = await signatureHasher(JSON.stringify({
        actor: text(input.actor), phone: phoneDigits(input.phone),
      }));
      const persisted = readPersisted();
      const cached = records.get(identityHash);
      const previous = cached && !isExpired(cached) ? cached :
        persisted[identityHash] || persisted.legacy;
      // Preserve unresolved retries per actor/phone, including when the operator
      // switches customers and returns later. Legacy records are probed once;
      // only an explicit server phone conflict permits replacing their UUID.
      const orderId = previous?.orderId || uuidFactory();
      if (!isUuid(orderId)) throw new Error('DISPATCH_CREATE_INTENT_UUID_INVALID');
      const record = {
        signature,
        signatureHash,
        orderId,
        createdAt: Number(previous?.createdAt ?? previous?.updatedAt ?? now()),
        updatedAt: now(),
        pending: null,
      };
      records.set(identityHash, record);
      persist(identityHash, record);
      if (current?.signature === signature && current?.pending === pending) current = record;
      return orderId;
    })();

    current = { signature, orderId: '', signatureHash: '', createdAt: now(), updatedAt: now(), pending };
    return pending;
  }

  function clear(orderId) {
    const wantedId = text(orderId);
    if (current?.orderId === wantedId) current = null;
    for (const [key, record] of records) {
      if (record.orderId === wantedId) records.delete(key);
    }
    if (!storage) return;
    try {
      const intents = readPersisted();
      for (const [key, record] of Object.entries(intents)) {
        if (record.orderId === wantedId) delete intents[key];
      }
      if (Object.keys(intents).length) {
        storage.setItem(DISPATCH_CREATE_INTENT_STORAGE_KEY, JSON.stringify({ version: 2, intents }));
      } else storage.removeItem(DISPATCH_CREATE_INTENT_STORAGE_KEY);
    } catch {}
  }

  function peek() {
    return current ? { signature: current.signature, orderId: current.orderId } : null;
  }

  return { acquire, clear, peek };
}

export async function recoverDispatchCreatePhoneConflict({ result, journal, input, payload, submit }) {
  let orderId = payload.id;
  // The server has verified that this UUID belongs to a DIFFERENT phone. It
  // cannot represent a committed retry of the current customer. Timeouts and
  // same-phone fingerprint conflicts must retain their original UUID.
  if (result?.ok !== false || result?.error !== 'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT') {
    return { result, orderId };
  }
  journal.clear(orderId);
  orderId = await journal.acquire(input);
  const retryPayload = {
    ...payload, id: orderId,
    data: { ...payload.data, order_id: orderId, public_order_id: orderId },
  };
  result = await submit(retryPayload);
  return { result, orderId };
}

export { DISPATCH_CREATE_INTENT_STORAGE_KEY };
