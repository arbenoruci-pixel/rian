import { queueOp } from '@/lib/offlineSyncClient';

const KEY = 'tepiha_pastrimi_payment_intents_v1';
const SESSION_KEY = 'tepiha_pastrimi_payment_intents_session_v3';
const DB_NAME = 'tepiha-pastrimi-payment-intents-v3';
const DB_STORE = 'intents';
const CACHE_NAME = 'tepiha-pastrimi-payment-intents-v3';
const CACHE_PREFIX = '/__tepiha_pastrimi_payment_intent_v3__/';
const LIMIT = 50;
const RETRY_COMPACT_LIMIT = 12;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ASYNC_STORE_TIMEOUT_MS = 1800;
const memoryJournal = new Map();
const removedKeys = new Set();
let flushing = null;
let installed = false;
let dbPromise = null;

// PASTRIMI_PAYMENT_INTENT_RESILIENCE_V3

function text(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function errorText(error) {
  const name = text(error?.name);
  const message = text(error?.message || error);
  return [name, message].filter(Boolean).join(': ') || 'UNKNOWN_STORAGE_ERROR';
}

function rowKey(row = {}) {
  return text(row?.idempotencyKey || row?.idempotency_key);
}

function rowTs(row = {}) {
  const numeric = Number(row?.saved_ts || 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(row?.saved_at || row?.last_attempt_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function cloneSerializable(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeIntent(intent = {}) {
  const idempotencyKey = text(intent?.idempotencyKey || intent?.idempotency_key);
  if (!idempotencyKey) throw new Error('PASTRIMI_PAYMENT_INTENT_IDEMPOTENCY_REQUIRED');

  const safe = cloneSerializable(intent, {
    transaction: cloneSerializable(intent?.transaction, null),
    orderId: intent?.orderId || intent?.order_id || null,
    code: intent?.code || null,
    clientName: intent?.clientName || intent?.client_name || '',
    pickupNow: intent?.pickupNow === true,
  });

  return {
    ...(safe && typeof safe === 'object' ? safe : {}),
    idempotencyKey,
    idempotency_key: idempotencyKey,
    saved_at: safe?.saved_at || intent?.saved_at || new Date().toISOString(),
    saved_ts: Number(safe?.saved_ts || intent?.saved_ts || Date.now()),
    attempts: Number(safe?.attempts || intent?.attempts || 0),
  };
}

function compactRows(rows = []) {
  const now = Date.now();
  const byKey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const key = rowKey(raw);
    if (!key || removedKeys.has(key)) return;
    let item;
    try { item = normalizeIntent(raw); } catch { return; }
    const ts = rowTs(item);
    if (ts > 0 && now - ts > MAX_AGE_MS) return;
    const previous = byKey.get(key);
    if (!previous || rowTs(item) >= rowTs(previous)) byKey.set(key, item);
  });
  return Array.from(byKey.values())
    .sort((a, b) => rowTs(a) - rowTs(b))
    .slice(-LIMIT);
}

function mergeRows(...groups) {
  return compactRows(groups.flatMap((group) => (Array.isArray(group) ? group : [])));
}

function getStorage(kind) {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStorageRows(kind, key) {
  const storage = getStorage(kind);
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) || '[]');
    return compactRows(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    try { storage.removeItem(key); } catch {}
    emitDiagnostic('storage_read_reset', { kind, error: errorText(error) });
    return [];
  }
}

function writeStorageRows(kind, key, rows = []) {
  const storage = getStorage(kind);
  if (!storage) return { ok: false, kind, error: 'STORAGE_UNAVAILABLE' };
  const clean = compactRows(rows);
  try {
    storage.setItem(key, JSON.stringify(clean));
    return { ok: true, kind, count: clean.length };
  } catch (firstError) {
    // The old journal may be the quota offender. Remove only this journal and
    // retry with the newest compact subset; unrelated app data stays untouched.
    try {
      storage.removeItem(key);
      const reduced = clean.slice(-RETRY_COMPACT_LIMIT);
      storage.setItem(key, JSON.stringify(reduced));
      emitDiagnostic('storage_compact_recovery', {
        kind,
        count: reduced.length,
        firstError: errorText(firstError),
      });
      return { ok: true, kind, count: reduced.length, recovered: true };
    } catch (secondError) {
      emitDiagnostic('storage_write_failed', {
        kind,
        firstError: errorText(firstError),
        secondError: errorText(secondError),
      });
      return { ok: false, kind, error: errorText(secondError || firstError) };
    }
  }
}

function readMemoryRows() {
  return compactRows(Array.from(memoryJournal.values()));
}

function syncMemory(rows = []) {
  memoryJournal.clear();
  compactRows(rows).forEach((row) => memoryJournal.set(rowKey(row), row));
}

function readAllSync() {
  return mergeRows(
    readStorageRows('local', KEY),
    readStorageRows('session', SESSION_KEY),
    readMemoryRows(),
  );
}

function writeAllSync(rows = []) {
  const clean = compactRows(rows);
  syncMemory(clean);
  const local = writeStorageRows('local', KEY, clean);
  const session = writeStorageRows('session', SESSION_KEY, clean);
  return { clean, local, session, anySync: local.ok || session.ok };
}

function emitDiagnostic(type, detail = {}) {
  const payload = {
    type: text(type) || 'unknown',
    at: new Date().toISOString(),
    source: 'pastrimiPaymentIntentV3',
    ...detail,
  };
  try { console.warn('[PASTRIMI PAYMENT INTENT]', payload); } catch {}
  try {
    if (typeof window !== 'undefined') {
      window.__TEPIHA_PASTRIMI_PAYMENT_INTENT_LAST__ = payload;
      window.dispatchEvent(new CustomEvent('tepiha:pastrimi-payment-intent-diagnostic', { detail: payload }));
    }
  } catch {}
}

function withTimeout(promise, timeoutMs = ASYNC_STORE_TIMEOUT_MS, code = 'ASYNC_STORAGE_TIMEOUT') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(code));
    }, Math.max(250, Number(timeoutMs || ASYNC_STORE_TIMEOUT_MS)));
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
    if (typeof indexedDB === 'undefined') {
      reject(new Error('INDEXEDDB_UNAVAILABLE'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'idempotencyKey' });
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

async function idbRequest(mode, executor) {
  const db = await withTimeout(openIntentDb(), ASYNC_STORE_TIMEOUT_MS, 'INDEXEDDB_OPEN_TIMEOUT');
  return await withTimeout(new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(DB_STORE, mode);
      const store = transaction.objectStore(DB_STORE);
      executor(store, resolve, reject);
      transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_TRANSACTION_FAILED'));
      transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_TRANSACTION_ABORTED'));
    } catch (error) {
      reject(error);
    }
  }), ASYNC_STORE_TIMEOUT_MS, 'INDEXEDDB_OPERATION_TIMEOUT');
}

async function putIntentIdb(intent) {
  const item = normalizeIntent(intent);
  const key = rowKey(item);
  if (removedKeys.has(key)) return false;
  await idbRequest('readwrite', (store, resolve, reject) => {
    const request = store.put(item);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_PUT_FAILED'));
  });
  if (removedKeys.has(key)) {
    await deleteIntentIdb(key).catch(() => {});
    return false;
  }
  return true;
}

async function deleteIntentIdb(idempotencyKey) {
  const key = text(idempotencyKey);
  if (!key) return false;
  await idbRequest('readwrite', (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_DELETE_FAILED'));
  });
  return true;
}

async function listIntentIdb() {
  return await idbRequest('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(compactRows(request.result || []));
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_GET_ALL_FAILED'));
  });
}

function cacheUrl(idempotencyKey) {
  const key = encodeURIComponent(text(idempotencyKey));
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://tepiha.local';
  return new URL(`${CACHE_PREFIX}${key}.json`, origin).href;
}

async function putIntentCache(intent) {
  if (typeof caches === 'undefined') throw new Error('CACHE_STORAGE_UNAVAILABLE');
  const item = normalizeIntent(intent);
  const key = rowKey(item);
  if (removedKeys.has(key)) return false;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheUrl(key), new Response(JSON.stringify(item), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }));
  if (removedKeys.has(key)) {
    await cache.delete(cacheUrl(key)).catch(() => {});
    return false;
  }
  return true;
}

async function deleteIntentCache(idempotencyKey) {
  if (typeof caches === 'undefined') return false;
  const key = text(idempotencyKey);
  if (!key) return false;
  const cache = await caches.open(CACHE_NAME);
  return await cache.delete(cacheUrl(key));
}

async function listIntentCache() {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const rows = [];
  for (const request of requests) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(CACHE_PREFIX)) continue;
      const response = await cache.match(request);
      if (!response) continue;
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {}
  }
  return compactRows(rows);
}

async function persistIntentAsync(intent) {
  const item = normalizeIntent(intent);
  const key = rowKey(item);
  if (removedKeys.has(key)) return { idb: false, cache: false, skipped: true };

  const [idbResult, cacheResult] = await Promise.allSettled([
    withTimeout(putIntentIdb(item), ASYNC_STORE_TIMEOUT_MS, 'INDEXEDDB_PUT_TIMEOUT'),
    withTimeout(putIntentCache(item), ASYNC_STORE_TIMEOUT_MS, 'CACHE_PUT_TIMEOUT'),
  ]);
  const result = {
    idb: idbResult.status === 'fulfilled' && idbResult.value !== false,
    cache: cacheResult.status === 'fulfilled' && cacheResult.value !== false,
    idbError: idbResult.status === 'rejected' ? errorText(idbResult.reason) : '',
    cacheError: cacheResult.status === 'rejected' ? errorText(cacheResult.reason) : '',
  };
  if (!result.idb && !result.cache) emitDiagnostic('async_storage_failed', { key, ...result });
  return result;
}

async function deleteIntentAsync(idempotencyKey) {
  const key = text(idempotencyKey);
  if (!key) return { idb: false, cache: false };
  const [idbResult, cacheResult] = await Promise.allSettled([
    withTimeout(deleteIntentIdb(key), ASYNC_STORE_TIMEOUT_MS, 'INDEXEDDB_DELETE_TIMEOUT'),
    withTimeout(deleteIntentCache(key), ASYNC_STORE_TIMEOUT_MS, 'CACHE_DELETE_TIMEOUT'),
  ]);
  return {
    idb: idbResult.status === 'fulfilled',
    cache: cacheResult.status === 'fulfilled',
  };
}

async function readAllAsync() {
  const [idbResult, cacheResult] = await Promise.allSettled([
    withTimeout(listIntentIdb(), ASYNC_STORE_TIMEOUT_MS, 'INDEXEDDB_LIST_TIMEOUT'),
    withTimeout(listIntentCache(), ASYNC_STORE_TIMEOUT_MS, 'CACHE_LIST_TIMEOUT'),
  ]);
  return mergeRows(
    readAllSync(),
    idbResult.status === 'fulfilled' ? idbResult.value : [],
    cacheResult.status === 'fulfilled' ? cacheResult.value : [],
  );
}

function removeIntentSync(idempotencyKey) {
  const key = text(idempotencyKey);
  if (!key) return false;
  removedKeys.add(key);
  memoryJournal.delete(key);
  const before = readAllSync();
  const filtered = before.filter((row) => rowKey(row) !== key);
  writeAllSync(filtered);
  return true;
}

export function savePastrimiPaymentIntent(intent = {}) {
  const next = normalizeIntent(intent);
  const key = rowKey(next);
  removedKeys.delete(key);
  const result = writeAllSync(mergeRows(readAllSync(), [next]));

  // A localStorage quota/private-mode failure must never block a real payment.
  // sessionStorage, IndexedDB, Cache Storage and the ARKA outbox remain available.
  if (!result.anySync) {
    emitDiagnostic('sync_storage_fallback', {
      key,
      localError: result.local?.error || '',
      sessionError: result.session?.error || '',
    });
  }
  void persistIntentAsync(next).catch((error) => {
    emitDiagnostic('async_persist_exception', { key, error: errorText(error) });
  });
  return next;
}

export function removePastrimiPaymentIntent(idempotencyKey) {
  const key = text(idempotencyKey);
  if (!key) return false;
  const removed = removeIntentSync(key);
  void deleteIntentAsync(key).catch(() => {});
  return removed;
}

export function listPastrimiPaymentIntents() {
  return readAllSync();
}

export async function enqueuePastrimiPaymentIntent(intent = {}) {
  const stored = savePastrimiPaymentIntent(intent);
  const transaction = stored?.transaction && typeof stored.transaction === 'object'
    ? stored.transaction
    : null;
  if (!transaction) throw new Error('PASTRIMI_PAYMENT_INTENT_TRANSACTION_REQUIRED');

  // Finish at least one async persistence attempt before the outbox handoff.
  // Even if both async stores fail, the online ARKA request still gets a chance.
  await persistIntentAsync(stored).catch(() => ({ idb: false, cache: false }));

  const opId = await queueOp('arka_transaction', { transaction });
  if (!opId) throw new Error('PASTRIMI_PAYMENT_INTENT_QUEUE_FAILED');
  removeIntentSync(stored.idempotencyKey);
  await deleteIntentAsync(stored.idempotencyKey).catch(() => {});
  try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
  return opId;
}

export async function flushPastrimiPaymentIntents() {
  if (typeof window === 'undefined') return { queued: 0, pending: 0 };
  if (flushing) return flushing;
  flushing = (async () => {
    let queued = 0;
    const rows = await readAllAsync();
    for (const item of rows) {
      const updated = {
        ...item,
        attempts: Number(item?.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
      };
      try {
        savePastrimiPaymentIntent(updated);
        await persistIntentAsync(updated).catch(() => ({}));
        const transaction = updated?.transaction && typeof updated.transaction === 'object'
          ? updated.transaction
          : null;
        if (!transaction) {
          removePastrimiPaymentIntent(rowKey(updated));
          continue;
        }
        const opId = await queueOp('arka_transaction', { transaction });
        if (!opId) throw new Error('PASTRIMI_PAYMENT_INTENT_QUEUE_FAILED');
        removeIntentSync(rowKey(updated));
        await deleteIntentAsync(rowKey(updated)).catch(() => {});
        queued += 1;
      } catch (error) {
        emitDiagnostic('flush_retry_pending', {
          key: rowKey(updated),
          attempts: updated.attempts,
          error: errorText(error),
        });
      }
    }
    const pendingRows = await readAllAsync();
    return { queued, pending: pendingRows.length };
  })().finally(() => { flushing = null; });
  return flushing;
}

export function installPastrimiPaymentIntentAutoFlush() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  const run = () => { void flushPastrimiPaymentIntents(); };
  window.setTimeout(run, 500);
  window.addEventListener('online', run);
  window.addEventListener('pageshow', run);
  window.addEventListener('focus', run);
  window.addEventListener('storage', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
}

if (typeof window !== 'undefined') installPastrimiPaymentIntentAutoFlush();
