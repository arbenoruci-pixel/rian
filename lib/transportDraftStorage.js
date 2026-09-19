const DATABASE = 'tepiha-transport-drafts-v2';
const STORE = 'drafts';
const PREFIX = 'transport_draft_order_';
const LIST = 'transport_draft_orders_v1';

// Drafts are local work, not submitted orders. Never allocate codes, send SMS,
// update payments, or evict business records to make room here.
export function createTransportDraftStorage({ indexedDB, localStorage, timeoutMs = 5000 }) {
  let connection = null, opening = null, tail = Promise.resolve();
  const serialize = action => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('TRANSPORT_DRAFT_STORAGE_UNAVAILABLE'));
      let finished = false;
      const req = indexedDB.open(DATABASE, 1);
      const timer = setTimeout(() => finish(new Error('TRANSPORT_DRAFT_STORAGE_TIMEOUT')), timeoutMs);
      function finish(error, db) {
        if (finished) { db?.close(); return; }
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onerror = () => finish(req.error || new Error('TRANSPORT_DRAFT_STORAGE_FAILED'));
      req.onblocked = () => finish(new Error('TRANSPORT_DRAFT_STORAGE_BLOCKED'));
      req.onsuccess = () => {
        const db = req.result;
        if (!finished) connection = db;
        const forget = () => { if (connection === db) { connection = null; opening = null; } };
        db.onversionchange = () => { db.close(); forget(); };
        db.onclose = forget;
        finish(null, db);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function transaction(mode, action) {
    let db = await open(), tx;
    try { tx = db.transaction(STORE, mode); }
    catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      connection = null; opening = null;
      db = await open(); tx = db.transaction(STORE, mode);
    }
    return new Promise((resolve, reject) => {
      let value, failure, settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        failure = new Error('TRANSPORT_DRAFT_STORAGE_TIMEOUT');
        try { tx.abort(); db.close(); } catch {}
        if (connection === db) { connection = null; opening = null; }
        finish(failure);
      }, timeoutMs);
      tx.oncomplete = () => finish(failure);
      tx.onabort = () => finish(failure || tx.error || new Error('TRANSPORT_DRAFT_STORAGE_ABORTED'));
      tx.onerror = event => { failure ||= event?.target?.error || tx.error; };
      const fail = error => { failure = error; try { tx.abort(); } catch { finish(error); } };
      try { action(tx.objectStore(STORE), result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }
  function legacyRows() {
    const rows = new Map();
    // Only a user-initiated draft read scans legacy keys. This also recovers
    // orphan items whose old localStorage index failed to update at quota.
    try {
      const ids = JSON.parse(localStorage?.getItem(LIST) || '[]');
      for (const entry of Array.isArray(ids) ? ids : []) {
        if (entry?.id) rows.set(String(entry.id), entry);
      }
    } catch {} // A corrupt index must not hide intact per-draft entries.
    try {
      for (let i = 0; i < (localStorage?.length || 0); i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        try {
          const row = JSON.parse(localStorage.getItem(key));
          if (row?.id) rows.set(String(row.id), row);
        } catch {} // Preserve unreadable originals.
      }
    } catch {}
    return rows;
  }
  return {
    save(draft) {
      // Capture now, before any asynchronous wait or caller mutation.
      const row = JSON.parse(JSON.stringify(draft));
      if (!row?.id) return Promise.reject(new Error('TRANSPORT_DRAFT_ID_REQUIRED'));
      row.ts = Number(row.ts) || Date.now();
      row.transport_id = String(row.transport_id || '').trim() || null;
      return serialize(() => transaction('readwrite', (store, done, fail) => {
        const read = store.get(row.id);
        read.onsuccess = () => {
          try {
            const previous = read.result;
            // This draft operation is finished, regardless of a stale tab's
            // newer autosave timestamp. A later explicit edit uses a new key.
            if (previous?.deletedAt || Number(previous?.ts || 0) > row.ts) return done({ ok: true, skipped: true });
            const write = store.put(row); write.onsuccess = () => done({ ok: true });
          } catch (error) { fail(error); }
        };
      }));
    },
    list(scope = '', { editingOrderId = '' } = {}) {
      return serialize(async () => {
        const legacy = legacyRows();
        const saved = await transaction('readonly', (store, done) => {
          const read = store.getAll(); read.onsuccess = () => done(read.result);
        }); // Do not present legacy copies when completion tombstones cannot be read.
        for (const row of saved) {
          const old = legacy.get(String(row.id));
          // An explicit existing-order editor may recover a pre-upgrade edit
          // from its legacy copy into a NEW edit operation. Never expose this
          // exception to new-order admission or reopen the completed key.
          if (row.deletedAt && row.id === editingOrderId && old && Number(old.ts || 0) > row.deletedAt) continue;
          if (row.deletedAt || !old || Number(row.ts || 0) >= Number(old.ts || 0)) legacy.set(String(row.id), row);
        }
        return [...legacy.values()].filter(row => !row.deletedAt)
          .filter(row => !scope || String(row.transport_id || '').trim() === String(scope).trim())
          .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      });
    },
    remove(id) {
      const deletedAt = Date.now();
      return serialize(async () => {
        // Keep a tombstone so another tab or an old autosave cannot resurrect a
        // completed draft. This does not delete the order or any payment.
        await transaction('readwrite', store => store.put({ id, deletedAt }));
        try { localStorage?.removeItem(PREFIX + id); } catch {}
      });
    },
  };
}

let browserStorage;
export function transportDraftStorage() {
  if (!browserStorage) {
    let localStorage, indexedDB;
    try { localStorage = window.localStorage; } catch {}
    try { indexedDB = window.indexedDB; } catch {}
    browserStorage = createTransportDraftStorage({ indexedDB, localStorage });
  }
  return browserStorage;
}
