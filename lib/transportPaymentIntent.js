import { newTransportFinanceIdempotencyKey } from './transportReceivablesClient.js';

const LOCAL_PREFIX = 'transport_receivable_payment_intent_v1:';
const SESSION_PREFIX = 'transport_receivable_payment_intent_session_v2:';
const DB_NAME = 'tepiha-transport-payment-intents-v2';
const DB_STORE = 'intents';
const CACHE_NAME = 'tepiha-transport-payment-intents-v2';
const CACHE_PREFIX = '/__tepiha_transport_payment_intent_v2__/';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const ASYNC_STORAGE_TIMEOUT_MS = 1500;

const memoryJournal = new Map();
const acquisitionLocks = new Map();
const removedIntents = new Set();
const pendingCleanups = new Map();
let dbPromise = null;

// TRANSPORT_PAYMENT_INTENT_RESILIENCE_V2

function text(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function round2(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function intentPair(orderId, idempotencyKey) {
  return text(orderId) + '::' + text(idempotencyKey);
}

function orderLockName(orderId) {
  return 'tepiha-transport-payment-intent:' + text(orderId);
}

function normalizeIntent(raw, expectedOrderId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const orderId = text(raw.orderId || raw.order_id);
  const expected = text(expectedOrderId);
  const idempotencyKey = text(raw.idempotencyKey || raw.idempotency_key);
  const amountReceived = round2(raw.amountReceived ?? raw.amount_received);
  const rawExpectedTotalDue = raw.expectedTotalDue ?? raw.expected_total_due;
  const hasExpectedTotalDue = rawExpectedTotalDue !== undefined
    && rawExpectedTotalDue !== null
    && rawExpectedTotalDue !== '';
  const expectedTotalDueNumber = hasExpectedTotalDue ? Number(rawExpectedTotalDue) : null;
  const expectedTotalDue = hasExpectedTotalDue ? round2(expectedTotalDueNumber) : null;
  const createdAt = Number(raw.createdAt || raw.created_at || 0);
  if (
    !orderId
    || (expected && orderId !== expected)
    || !idempotencyKey
    || amountReceived <= 0
    || (hasExpectedTotalDue && (!Number.isFinite(expectedTotalDueNumber) || expectedTotalDue < 0))
  ) return null;
  return {
    orderId,
    amountReceived,
    // Null means a legacy intent created before balance snapshots existed.
    // It may verify an already-committed key, but it must never authorize a
    // fresh payment against the UI's newer balance.
    expectedTotalDue,
    idempotencyKey,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
    stale: Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt > STALE_AFTER_MS,
  };
}

function sameIntent(left, right) {
  return Boolean(
    left
    && right
    && text(left.orderId) === text(right.orderId)
    && text(left.idempotencyKey) === text(right.idempotencyKey)
    && Math.abs(round2(left.amountReceived) - round2(right.amountReceived)) <= 0.001
    && (
      (left.expectedTotalDue == null && right.expectedTotalDue == null)
      || (
        left.expectedTotalDue != null
        && right.expectedTotalDue != null
        && Math.abs(round2(left.expectedTotalDue) - round2(right.expectedTotalDue)) <= 0.001
      )
    )
  );
}

function storageKey(kind, orderId) {
  return (kind === 'session' ? SESSION_PREFIX : LOCAL_PREFIX) + text(orderId);
}

function getStorage(kind) {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStorageState(kind, orderId) {
  const storage = getStorage(kind);
  if (!storage) return { intent: null, uncertain: kind === 'local' };
  const key = storageKey(kind, orderId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return { intent: null, uncertain: false };
    const intent = normalizeIntent(JSON.parse(raw), orderId);
    if (!intent) {
      try { storage.removeItem(key); } catch {}
      return { intent: null, uncertain: true };
    }
    return { intent, uncertain: false };
  } catch {
    return { intent: null, uncertain: kind === 'local' };
  }
}

function writeStorageIntent(kind, intent) {
  const storage = getStorage(kind);
  if (!storage) return false;
  const key = storageKey(kind, intent.orderId);
  const serialized = JSON.stringify(intent);
  const writeAndVerify = () => {
    storage.setItem(key, serialized);
    const persisted = normalizeIntent(JSON.parse(storage.getItem(key) || 'null'), intent.orderId);
    return sameIntent(persisted, intent);
  };

  try {
    if (writeAndVerify()) return true;
  } catch {}

  // Recover quota used by an obsolete/corrupt copy of this one intent only.
  try {
    storage.removeItem(key);
    return writeAndVerify();
  } catch {
    return false;
  }
}

function removeStorageIntent(kind, orderId, idempotencyKey = '') {
  const storage = getStorage(kind);
  if (!storage) return false;
  const key = storageKey(kind, orderId);
  try {
    const existingRaw = storage.getItem(key);
    if (!existingRaw) return true;
    const existing = normalizeIntent(JSON.parse(existingRaw), orderId);
    if (idempotencyKey && existing && existing.idempotencyKey !== text(idempotencyKey)) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(code));
    }, ASYNC_STORAGE_TIMEOUT_MS);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function openIntentDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const indexedDb = globalThis?.indexedDB;
    if (!indexedDb) {
      reject(new Error('INDEXEDDB_UNAVAILABLE'));
      return;
    }
    let request;
    try {
      request = indexedDb.open(DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'orderId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('INDEXEDDB_OPEN_BLOCKED'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function getIntentIdb(orderId) {
  const db = await withTimeout(openIntentDb(), 'INDEXEDDB_OPEN_TIMEOUT');
  return await withTimeout(new Promise((resolve, reject) => {
    try {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(text(orderId));
      request.onsuccess = () => resolve(normalizeIntent(request.result, orderId));
      request.onerror = () => reject(request.error || new Error('INDEXEDDB_GET_FAILED'));
    } catch (error) {
      reject(error);
    }
  }), 'INDEXEDDB_GET_TIMEOUT');
}

async function putIntentIdb(intent) {
  const db = await openIntentDb();
  return await new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).put(intent);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_PUT_FAILED'));
      transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_PUT_ABORTED'));
    } catch (error) {
      reject(error);
    }
  });
}

async function deleteIntentIdb(orderId, idempotencyKey = '') {
  const db = await openIntentDb();
  return await new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      const store = transaction.objectStore(DB_STORE);
      let removed = false;
      const request = store.get(text(orderId));
      request.onsuccess = () => {
        const existing = normalizeIntent(request.result, orderId);
        if (!existing || !idempotencyKey || existing.idempotencyKey === text(idempotencyKey)) {
          store.delete(text(orderId));
          removed = true;
        }
      };
      request.onerror = () => reject(request.error || new Error('INDEXEDDB_DELETE_READ_FAILED'));
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_DELETE_FAILED'));
      transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_DELETE_ABORTED'));
    } catch (error) {
      reject(error);
    }
  });
}

function cacheUrl(orderId) {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'https://tepiha.local';
  return new URL(CACHE_PREFIX + encodeURIComponent(text(orderId)) + '.json', origin).href;
}

async function getIntentCache(orderId) {
  if (!globalThis?.caches) throw new Error('CACHE_STORAGE_UNAVAILABLE');
  const cache = await globalThis.caches.open(CACHE_NAME);
  const response = await cache.match(cacheUrl(orderId));
  if (!response) return null;
  return normalizeIntent(await response.json(), orderId);
}

async function putIntentCache(intent) {
  if (!globalThis?.caches) throw new Error('CACHE_STORAGE_UNAVAILABLE');
  const cache = await globalThis.caches.open(CACHE_NAME);
  await cache.put(cacheUrl(intent.orderId), new Response(JSON.stringify(intent), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }));
  return true;
}

async function deleteIntentCache(orderId, idempotencyKey = '') {
  if (!globalThis?.caches) return false;
  const cache = await globalThis.caches.open(CACHE_NAME);
  const url = cacheUrl(orderId);
  const response = await cache.match(url);
  if (!response) return true;
  const existing = normalizeIntent(await response.json().catch(() => null), orderId);
  if (idempotencyKey && existing && existing.idempotencyKey !== text(idempotencyKey)) return false;
  return await cache.delete(url);
}

async function readAsyncCandidates(orderId) {
  const [idbResult, cacheResult] = await Promise.allSettled([
    withTimeout(getIntentIdb(orderId), 'INDEXEDDB_READ_TIMEOUT'),
    withTimeout(getIntentCache(orderId), 'CACHE_READ_TIMEOUT'),
  ]);
  const unavailable = (result, code) => result.status === 'rejected'
    && text(result.reason?.message || result.reason).includes(code);
  return {
    candidates: [
      idbResult.status === 'fulfilled' ? idbResult.value : null,
      cacheResult.status === 'fulfilled' ? cacheResult.value : null,
    ].filter(Boolean),
    uncertain: (
      idbResult.status === 'rejected' && !unavailable(idbResult, 'INDEXEDDB_UNAVAILABLE')
    ) || (
      cacheResult.status === 'rejected' && !unavailable(cacheResult, 'CACHE_STORAGE_UNAVAILABLE')
    ),
  };
}

function analyzeCandidates(orderId, candidates = []) {
  const normalized = candidates
    .map((candidate) => normalizeIntent(candidate, orderId))
    .filter((intent) => intent && !removedIntents.has(intentPair(intent.orderId, intent.idempotencyKey)));
  if (!normalized.length) return null;

  const byIdentity = new Map();
  normalized.forEach((intent) => {
    const expectedIdentity = intent.expectedTotalDue == null
      ? 'LEGACY'
      : intent.expectedTotalDue.toFixed(2);
    const identity = intent.idempotencyKey + '::' + intent.amountReceived.toFixed(2) + '::' + expectedIdentity;
    const previous = byIdentity.get(identity);
    if (!previous || intent.createdAt > previous.createdAt) byIdentity.set(identity, intent);
  });
  const distinct = Array.from(byIdentity.values()).sort((a, b) => b.createdAt - a.createdAt);
  if (distinct.length > 1) {
    return {
      ...distinct[0],
      storageConflict: true,
      conflicts: distinct.map((intent) => ({
        amountReceived: intent.amountReceived,
        expectedTotalDue: intent.expectedTotalDue,
        idempotencyKey: intent.idempotencyKey,
        createdAt: intent.createdAt,
      })),
    };
  }
  return distinct[0];
}

export async function readTransportPaymentIntent(orderId) {
  const cleanOrderId = text(orderId);
  if (!cleanOrderId || typeof window === 'undefined') return null;
  const localState = readStorageState('local', cleanOrderId);
  const sessionState = readStorageState('session', cleanOrderId);
  const syncCandidates = [
    localState.intent,
    sessionState.intent,
    memoryJournal.get(cleanOrderId),
  ];
  const syncResult = analyzeCandidates(cleanOrderId, syncCandidates);
  if (syncResult?.storageConflict) return syncResult;

  // A verified local copy is authoritative. We intentionally do not mirror a
  // local success asynchronously, so there cannot be a newer fallback-only key.
  if (localState.intent) {
    memoryJournal.set(cleanOrderId, syncResult);
    return syncResult;
  }

  const asyncState = await readAsyncCandidates(cleanOrderId);
  const result = analyzeCandidates(cleanOrderId, [
    ...syncCandidates,
    ...asyncState.candidates,
  ]);
  if (result && !result.storageConflict) memoryJournal.set(cleanOrderId, result);
  const storageReadUncertain = localState.uncertain || asyncState.uncertain;
  if (result) return { ...result, storageReadUncertain };
  return storageReadUncertain ? { orderId: cleanOrderId, storageReadUncertain: true } : null;
}

async function persistIntentAsync(intent) {
  // A timed-out write may still finish later. That is safe only when the POST
  // stays blocked: the late copy retains this same key for a future retry.
  try {
    const stored = await withTimeout(putIntentIdb(intent), 'INDEXEDDB_WRITE_TIMEOUT');
    if (stored === true && sameIntent(await getIntentIdb(intent.orderId), intent)) {
      return { idb: true, cache: false };
    }
    return { idb: false, cache: false, uncertain: true };
  } catch (idbError) {
    if (text(idbError?.message || idbError).includes('TIMEOUT')) {
      return { idb: false, cache: false, uncertain: true };
    }
    try {
      const stored = await withTimeout(putIntentCache(intent), 'CACHE_WRITE_TIMEOUT');
      if (stored === true && sameIntent(await getIntentCache(intent.orderId), intent)) {
        return { idb: false, cache: true };
      }
      return { idb: false, cache: false, uncertain: true };
    } catch (cacheError) {
      return {
        idb: false,
        cache: false,
        uncertain: text(cacheError?.message || cacheError).includes('TIMEOUT'),
      };
    }
  }
}

async function persistIntent(intent) {
  memoryJournal.set(intent.orderId, intent);
  const local = writeStorageIntent('local', intent);
  const session = writeStorageIntent('session', intent);
  // A verified localStorage copy is sufficient and must not be followed by an
  // asynchronous writer that could finish after success cleanup.
  const asyncResult = local
    ? { idb: false, cache: false, skipped: true }
    : await persistIntentAsync(intent);
  return {
    local,
    session,
    idb: asyncResult.idb,
    cache: asyncResult.cache,
    uncertain: asyncResult.uncertain === true,
    // sessionStorage and memory do not survive every Android/PWA restart.
    durable: local || asyncResult.idb || asyncResult.cache,
  };
}

async function acquireIntentUnlocked(orderId, amountReceived, expectedTotalDue) {
  const cleanOrderId = text(orderId);
  const cleanAmount = round2(amountReceived);
  const expectedNumber = Number(expectedTotalDue);
  const cleanExpectedTotalDue = round2(expectedNumber);
  const existing = await readTransportPaymentIntent(cleanOrderId);
  if (existing?.storageReadUncertain) return existing;
  if (existing?.storageConflict) return existing;
  if (existing && Math.abs(existing.amountReceived - cleanAmount) > 0.001) {
    return { ...existing, amountConflict: true };
  }

  if (!existing && (!Number.isFinite(expectedNumber) || cleanExpectedTotalDue < 0)) {
    return {
      orderId: cleanOrderId,
      amountReceived: cleanAmount,
      expectedTotalDueInvalid: true,
      storageUnavailable: true,
    };
  }

  const intent = existing || {
    orderId: cleanOrderId,
    amountReceived: cleanAmount,
    expectedTotalDue: cleanExpectedTotalDue,
    idempotencyKey: newTransportFinanceIdempotencyKey('TRANSPORT_CLIENT_PAYMENT', cleanOrderId),
    createdAt: Date.now(),
    stale: false,
  };
  removedIntents.delete(intentPair(intent.orderId, intent.idempotencyKey));
  const persisted = await persistIntent(intent);
  if (persisted.durable !== true || persisted.uncertain === true) {
    return {
      ...intent,
      storageUnavailable: true,
      storage: persisted,
    };
  }
  const verified = await readTransportPaymentIntent(cleanOrderId);
  if (verified?.storageReadUncertain) return verified;
  if (verified?.storageConflict || !sameIntent(verified, intent)) {
    return {
      ...intent,
      storageConflict: true,
      conflicts: verified?.conflicts || [],
    };
  }
  return {
    ...intent,
    storageUnavailable: persisted.durable !== true,
    storage: persisted,
  };
}

async function withInPageOrderLock(orderId, work) {
  const previous = acquisitionLocks.get(orderId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  acquisitionLocks.set(orderId, current);
  try {
    return await current;
  } finally {
    if (acquisitionLocks.get(orderId) === current) acquisitionLocks.delete(orderId);
  }
}

export async function acquireTransportPaymentIntent(orderId, amountReceived, expectedTotalDue) {
  const cleanOrderId = text(orderId);
  const cleanAmount = round2(amountReceived);
  const expectedNumber = Number(expectedTotalDue);
  const cleanExpectedTotalDue = round2(expectedNumber);
  if (!cleanOrderId || cleanAmount <= 0 || typeof window === 'undefined') {
    return {
      orderId: cleanOrderId,
      amountReceived: cleanAmount,
      expectedTotalDue: Number.isFinite(expectedNumber) ? cleanExpectedTotalDue : null,
      storageUnavailable: true,
    };
  }

  const cleanupBeforeLock = pendingCleanups.get(cleanOrderId);
  if (cleanupBeforeLock) {
    try {
      await withTimeout(cleanupBeforeLock, 'PAYMENT_INTENT_CLEANUP_TIMEOUT');
    } catch {
      return { orderId: cleanOrderId, amountReceived: cleanAmount, storageReadUncertain: true };
    }
  }
  const work = () => withInPageOrderLock(
    cleanOrderId,
    async () => {
      // A cleanup queued after the pre-lock wait must win. Do not wait while
      // holding a Web Lock because that cleanup may be next in the same queue.
      if (pendingCleanups.get(cleanOrderId)) {
        return { orderId: cleanOrderId, amountReceived: cleanAmount, storageReadUncertain: true };
      }
      return await acquireIntentUnlocked(cleanOrderId, cleanAmount, expectedNumber);
    },
  );
  const lockManager = globalThis?.navigator?.locks;
  if (lockManager && typeof lockManager.request === 'function') {
    return await lockManager.request(
      orderLockName(cleanOrderId),
      { mode: 'exclusive' },
      work,
    );
  }
  return await work();
}

export async function clearTransportPaymentIntent(orderId, idempotencyKey = '') {
  const cleanOrderId = text(orderId);
  const cleanKey = text(idempotencyKey);
  if (!cleanOrderId || typeof window === 'undefined') return false;

  const keyToRemove = cleanKey;
  if (keyToRemove) removedIntents.add(intentPair(cleanOrderId, keyToRemove));

  const memoryIntent = memoryJournal.get(cleanOrderId);
  if (!keyToRemove || !memoryIntent || memoryIntent.idempotencyKey === keyToRemove) {
    memoryJournal.delete(cleanOrderId);
  }
  removeStorageIntent('local', cleanOrderId, keyToRemove);
  removeStorageIntent('session', cleanOrderId, keyToRemove);
  // Deletes cannot resurrect data. Let verified-success UI finish immediately;
  // acquisition of a later intent for this order waits for this cleanup.
  const runCleanup = () => Promise.allSettled([
    deleteIntentIdb(cleanOrderId, keyToRemove),
    deleteIntentCache(cleanOrderId, keyToRemove),
  ]);
  const startCleanup = async () => {
    const lockManager = globalThis?.navigator?.locks;
    if (lockManager && typeof lockManager.request === 'function') {
      return await lockManager.request(orderLockName(cleanOrderId), { mode: 'exclusive' }, runCleanup);
    }
    return await runCleanup();
  };
  const previousCleanup = pendingCleanups.get(cleanOrderId);
  const cleanup = (previousCleanup
    ? previousCleanup.catch(() => {}).then(startCleanup)
    : startCleanup()
  ).finally(() => {
    if (pendingCleanups.get(cleanOrderId) === cleanup) pendingCleanups.delete(cleanOrderId);
  });
  pendingCleanups.set(cleanOrderId, cleanup);
  return true;
}
