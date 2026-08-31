const DISPATCH_CREATE_INTENT_STORAGE_KEY = 'tepiha_dispatch_create_intent_v1';
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? '').trim();
}

function phoneDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
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

  function isExpired(record) {
    const startedAt = Number(record?.createdAt ?? record?.updatedAt);
    return !Number.isFinite(startedAt) || (now() - startedAt) > ttlMs;
  }

  function readPersisted() {
    if (!storage) return null;
    try {
      const parsed = JSON.parse(storage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY) || 'null');
      if (!parsed || parsed.version !== 1 || !isUuid(parsed.orderId)) return null;
      if (!Number.isFinite(Number(parsed.updatedAt))) return null;
      if (isExpired(parsed)) {
        storage.removeItem(DISPATCH_CREATE_INTENT_STORAGE_KEY);
        return null;
      }
      return { ...parsed, createdAt: Number(parsed.createdAt ?? parsed.updatedAt) };
    } catch {
      return null;
    }
  }

  function persist(record) {
    if (!storage) return;
    try {
      storage.setItem(DISPATCH_CREATE_INTENT_STORAGE_KEY, JSON.stringify({
        version: 1,
        signatureHash: record.signatureHash,
        orderId: record.orderId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
    } catch {}
  }

  async function acquire(input = {}) {
    const signature = buildDispatchCreateIntentSignature(input);
    if (current && isExpired(current)) current = null;
    if (current?.signature === signature && isUuid(current?.orderId)) return current.orderId;
    // One unresolved send owns one UUID even if the operator edits the form
    // after a timeout. The DB may already have committed the first payload; a
    // new UUID here could silently create a duplicate visit for the same phone.
    if (current?.pending) return current.pending;

    const currentOrderId = isUuid(current?.orderId) ? current.orderId : '';
    const currentCreatedAt = Number(current?.createdAt);

    const pending = (async () => {
      const signatureHash = await signatureHasher(signature);
      const persisted = readPersisted();
      const orderId = currentOrderId
        || (isUuid(persisted?.orderId) ? persisted.orderId : '')
        || uuidFactory();
      if (!isUuid(orderId)) throw new Error('DISPATCH_CREATE_INTENT_UUID_INVALID');
      const record = {
        signature,
        signatureHash,
        orderId,
        createdAt: Number.isFinite(currentCreatedAt)
          ? currentCreatedAt
          : Number(persisted?.createdAt ?? now()),
        updatedAt: now(),
        pending: null,
      };
      persist(record);
      if (current?.signature === signature && current?.pending === pending) current = record;
      return orderId;
    })();

    current = { signature, orderId: '', signatureHash: '', createdAt: now(), updatedAt: now(), pending };
    return pending;
  }

  function clear(orderId) {
    const wantedId = text(orderId);
    if (current?.orderId === wantedId) current = null;
    if (!storage) return;
    try {
      const persisted = JSON.parse(storage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY) || 'null');
      if (persisted?.orderId === wantedId) storage.removeItem(DISPATCH_CREATE_INTENT_STORAGE_KEY);
    } catch {}
  }

  function peek() {
    return current ? { signature: current.signature, orderId: current.orderId } : null;
  }

  return { acquire, clear, peek };
}

export { DISPATCH_CREATE_INTENT_STORAGE_KEY };
