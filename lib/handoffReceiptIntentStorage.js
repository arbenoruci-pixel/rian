import { validateReceiptAmount } from './handoffReceipts.js';

const PREFIX = 'tepiha_handoff_receipt_intent_v1:';
const DATABASE = 'tepiha-handoff-receipt-intents-v1';
const STORE = 'intents';
const REQUEST_KEY = /^[A-Za-z0-9:_-]{12,120}$/;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
const uncertain = () => failure('HANDOFF_RECEIPT_STORAGE_UNCERTAIN');
const unavailable = () => failure('HANDOFF_RECEIPT_STORAGE_UNAVAILABLE');
const conflict = () => failure('HANDOFF_RECEIPT_STORAGE_CONFLICT');
const corrupt = () => Object.assign(uncertain(), { storageCorrupt: true });

function normalize(raw, actorId, handoffId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw corrupt();
  const actor = typeof raw.actorId === 'string' ? raw.actorId.trim() : '';
  const handoff = Number(raw.handoffId);
  const amount = validateReceiptAmount(raw.amount, { allowZero: raw.action === 'receive' });
  const expected = validateReceiptAmount(raw.expectedOutstanding);
  if (!actor || !Number.isSafeInteger(handoff) || handoff <= 0
    || (actorId !== undefined && actor !== String(actorId))
    || (handoffId !== undefined && handoff !== Number(handoffId))
    || typeof raw.requestKey !== 'string' || !REQUEST_KEY.test(raw.requestKey)
    || !['receive', 'resolve'].includes(raw.action)
    || amount === null || expected === null || amount > expected
    || (raw.note !== undefined && typeof raw.note !== 'string')
    || (raw.confirmNoCash !== undefined && typeof raw.confirmNoCash !== 'boolean')) throw corrupt();
  const note = (raw.note || '').trim();
  if (note.length > 1000) throw corrupt();
  return { actorId: actor, handoffId: handoff, requestKey: raw.requestKey, action: raw.action,
    amount, expectedOutstanding: expected, note, confirmNoCash: raw.confirmNoCash === true };
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const keyFor = (actorId, handoffId) => PREFIX + actorId + ':' + handoffId;

function requireSame(existing, incoming) {
  if (!existing || same(existing, incoming)) return;
  throw existing.requestKey === incoming.requestKey
    ? conflict() : failure('HANDOFF_RECEIPT_PENDING_INTENT');
}

// A receipt is sent only after its exact retry payload has a verified durable
// copy. Web Storage quota errors use IndexedDB; neither memory nor session
// storage can authorize a financial POST after an application restart.
export function createHandoffReceiptIntentStorage({ localStorage, indexedDB, timeoutMs = 2000 } = {}) {
  let opening = null;
  let connection = null;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000;

  function forget(db) {
    if (connection === db) { connection = null; opening = null; }
  }

  function open() {
    if (!indexedDB) return Promise.reject(unavailable());
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const timer = setTimeout(() => finish(uncertain()), deadline);
      function finish(error, db) {
        if (settled) { try { db?.close(); } catch {} return; }
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      }
      try { request = indexedDB.open(DATABASE, 1); }
      catch { finish(uncertain()); return; }
      request.onupgradeneeded = () => {
        if (settled) { try { request.transaction.abort(); } catch {} return; }
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = () => finish(uncertain());
      request.onblocked = () => finish(uncertain());
      request.onsuccess = () => {
        const db = request.result;
        if (!settled) connection = db;
        db.onversionchange = () => { db.close(); forget(db); };
        db.onclose = () => forget(db);
        finish(null, db);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }

  async function transaction(mode, action) {
    let db = await open();
    let tx;
    try { tx = db.transaction(STORE, mode); }
    catch (error) {
      if (error?.name !== 'InvalidStateError') throw uncertain();
      forget(db);
      db = await open();
      try { tx = db.transaction(STORE, mode); } catch { throw uncertain(); }
    }
    return new Promise((resolve, reject) => {
      let result;
      let error;
      let settled = false;
      const timer = setTimeout(() => {
        error = uncertain();
        try { tx.abort(); } catch {}
        forget(db);
        try { db.close(); } catch {}
        finish(error);
      }, deadline);
      function finish(problem) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (problem) reject(problem); else resolve(result);
      }
      const abort = problem => {
        error = problem?.code?.startsWith('HANDOFF_RECEIPT_') ? problem : uncertain();
        try { tx.abort(); } catch { finish(error); }
      };
      tx.oncomplete = () => finish(error);
      tx.onabort = () => finish(error || uncertain());
      tx.onerror = event => { error ||= mode === 'readwrite' && (event.target?.error || tx.error)?.name === 'QuotaExceededError' ? unavailable() : uncertain(); };
      try { action(tx.objectStore(STORE), value => { result = value; }, abort); }
      catch (problem) { abort(problem); }
    });
  }

  function readLocal(actorId, handoffId) {
    if (!localStorage) return { intent: null, unreadable: true };
    let raw;
    try { raw = localStorage.getItem(keyFor(actorId, handoffId)); }
    catch { return { intent: null, unreadable: true }; }
    if (raw === null) return { intent: null, unreadable: false };
    try { return { intent: normalize(JSON.parse(raw), actorId, handoffId), unreadable: false }; }
    catch { throw corrupt(); } // Preserve corrupt originals for recovery.
  }

  async function readIndexed(actorId, handoffId) {
    return transaction('readonly', (store, done, abort) => {
      const request = store.get(keyFor(actorId, handoffId));
      request.onsuccess = () => {
        try { done(request.result === undefined ? null : normalize(request.result, actorId, handoffId)); }
        catch (error) { abort(error); }
      };
    });
  }

  async function inspect(actorId, handoffId) {
    const local = readLocal(actorId, handoffId);
    let saved = null;
    let indexedError = null;
    if (indexedDB) {
      try { saved = await readIndexed(actorId, handoffId); }
      catch (error) { indexedError = error; }
    }
    if (indexedError?.storageCorrupt) throw indexedError;
    if (local.intent && saved && !same(local.intent, saved)) throw conflict();
    // A verified existing copy authorizes only the exact retry. If neither
    // store can supply one, an unreadable store must not be treated as empty.
    const intent = local.intent || saved;
    if (!intent && (local.unreadable || indexedError)) throw uncertain();
    return { local, saved, intent, indexedError };
  }

  async function read(actorId, handoffId) {
    return (await inspect(String(actorId), Number(handoffId))).intent;
  }

  async function persist(raw) {
    const intent = normalize(raw);
    const { actorId, handoffId } = intent;
    const previous = await inspect(actorId, handoffId);
    requireSame(previous.intent, intent);
    if (previous.intent) return previous.intent;

    // Recheck immediately before the synchronous write. In-page/cross-tab
    // acquisition locks are owned by the caller; the fallback also uses an
    // atomic IndexedDB compare-and-put transaction.
    const before = readLocal(actorId, handoffId);
    if (before.unreadable) throw uncertain();
    requireSame(before.intent, intent);
    try { localStorage.setItem(keyFor(actorId, handoffId), JSON.stringify(intent)); } catch {}
    const after = readLocal(actorId, handoffId);
    if (after.unreadable) throw uncertain();
    requireSame(after.intent, intent);
    if (after.intent) {
      const verified = await inspect(actorId, handoffId);
      requireSame(verified.intent, intent);
      if (!verified.intent) throw uncertain();
      return verified.intent;
    }
    if (!indexedDB) throw unavailable();
    await transaction('readwrite', (store, done, abort) => {
      const key = keyFor(actorId, handoffId);
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const saved = request.result === undefined ? null : normalize(request.result, actorId, handoffId);
          requireSame(saved, intent);
          if (saved) { done(saved); return; }
          const write = store.put(intent, key);
          write.onsuccess = () => done(intent);
        } catch (error) { abort(error); }
      };
    });
    const verified = await inspect(actorId, handoffId);
    requireSame(verified.intent, intent);
    if (!verified.intent) throw uncertain();
    return verified.intent;
  }

  async function remove(raw) {
    const intent = normalize(raw);
    const { actorId, handoffId } = intent;
    const key = keyFor(actorId, handoffId);
    const local = readLocal(actorId, handoffId);
    if (local.unreadable) throw uncertain();
    if (local.intent?.requestKey === intent.requestKey && !same(local.intent, intent)) throw conflict();
    if (indexedDB) {
      await transaction('readwrite', (store, done, abort) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const saved = request.result === undefined ? null : normalize(request.result, actorId, handoffId);
            if (saved?.requestKey === intent.requestKey && !same(saved, intent)) throw conflict();
            if (saved && same(saved, intent)) store.delete(key);
            done();
          } catch (error) { abort(error); }
        };
      });
    }
    // Another tab may have acquired a newer intent while IndexedDB settled.
    const current = readLocal(actorId, handoffId);
    if (current.unreadable) throw uncertain();
    if (current.intent?.requestKey === intent.requestKey && !same(current.intent, intent)) throw conflict();
    if (current.intent && same(current.intent, intent)) {
      try { localStorage.removeItem(key); } catch { throw uncertain(); }
      const remaining = readLocal(actorId, handoffId);
      if (remaining.unreadable || (remaining.intent && same(remaining.intent, intent))) throw uncertain();
    }
  }

  return { read, persist, remove };
}
