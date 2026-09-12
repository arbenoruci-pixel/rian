const DATABASE = 'tepiha-dispatch-outbox-v3';
const STORE = 'entries';

// The complete order lives in IndexedDB, independently of the small Web Storage
// quota used by UI caches. Legacy localStorage rows remain readable until a
// verified IndexedDB commit allows their identical old copy to be removed.
export function createDispatchOutboxStorage({ indexedDB, localStorage, timeoutMs = 5000 }) {
  let opening = null;
  let connection = null;
  function forget(db) {
    if (connection === db) { connection = null; opening = null; }
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('DISPATCH_ORDER_STORAGE_UNAVAILABLE')); return; }
      let settled = false;
      const request = indexedDB.open(DATABASE, 1);
      const timer = setTimeout(() => finish(new Error('DISPATCH_ORDER_STORAGE_TIMEOUT')), timeoutMs);
      function finish(error, db) {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = () => finish(request.error || new Error('DISPATCH_ORDER_STORAGE_UNAVAILABLE'));
      request.onblocked = () => finish(new Error('DISPATCH_ORDER_STORAGE_BLOCKED'));
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
      // A suspended browser may close IndexedDB before delivering onclose.
      // No transaction started, so reopening once cannot repeat a write.
      if (error?.name !== 'InvalidStateError') throw error;
      forget(db);
      db = await open();
      tx = db.transaction(STORE, mode);
    }
    return new Promise((resolve, reject) => {
      let value;
      let failure;
      const timer = setTimeout(() => {
        failure = new Error('DISPATCH_ORDER_STORAGE_TIMEOUT');
        try { tx.abort(); } catch { reject(failure); }
      }, timeoutMs);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = () => { clearTimeout(timer); reject(failure || tx.error || new Error('DISPATCH_ORDER_STORAGE_ABORTED')); };
      tx.onerror = () => { failure ||= tx.error; };
      const fail = error => { failure = error; tx.abort(); };
      try { action(tx.objectStore(STORE), result => { value = result; }, fail); }
      catch (error) { failure = error; tx.abort(); }
    });
  }

  function newest(left, right) {
    if (!left) return right || null;
    if (!right || left === right) return left;
    const a = JSON.parse(left), b = JSON.parse(right);
    if (!a.id || a.id !== b.id || a.actorId !== b.actorId) throw new Error('DISPATCH_OUTBOX_STORAGE_CONFLICT');
    if (a.state === 'sent') return left;
    if (b.state === 'sent') return right;
    const aRevision = Number(a.revision || 0), bRevision = Number(b.revision || 0);
    if (aRevision || bRevision) return aRevision >= bRevision ? left : right;
    return Number(a.updatedAt) > Number(b.updatedAt) ? left : right;
  }

  return {
    async getItem(key) {
      const saved = await transaction('readonly', (store, done) => {
        const request = store.get(key); request.onsuccess = () => done(request.result || null);
      });
      return newest(saved, localStorage?.getItem(key));
    },
    async keys() {
      const saved = await transaction('readonly', (store, done) => {
        const request = store.getAllKeys(); request.onsuccess = () => done(request.result);
      });
      const keys = new Set(saved);
      for (let i = 0; i < (localStorage?.length || 0); i++) keys.add(localStorage.key(i));
      return [...keys];
    },
    async setItem(key, raw) {
      const legacy = localStorage?.getItem(key);
      await transaction('readwrite', (store, done, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const value = newest(newest(request.result, legacy), raw);
            const write = store.put(value, key); write.onsuccess = () => done(value);
          } catch (error) { fail(error); }
        };
      });
      // A quota or interrupted transaction above leaves the old row untouched.
      try { if (legacy && localStorage?.getItem(key) === legacy) localStorage.removeItem(key); } catch {}
    },
    async removeItem(key) {
      const legacy = localStorage?.getItem(key);
      await transaction('readwrite', (store, done) => {
        const request = store.delete(key); request.onsuccess = () => done();
      });
      try { if (legacy && localStorage?.getItem(key) === legacy) localStorage.removeItem(key); } catch {}
    },
  };
}
