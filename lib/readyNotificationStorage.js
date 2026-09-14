export const READY_NOTIFICATION_LEGACY_KEY = 'tepiha_ready_notifications_v1';
export const READY_NOTIFICATION_ITEM_PREFIX = 'tepiha_ready_notification_item_v2:';

function eventKey(event) {
  if (!event || typeof event.id !== 'string' || !event.id || typeof event.viewer_id !== 'string' || !event.viewer_id) {
    throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
  }
  return READY_NOTIFICATION_ITEM_PREFIX + (event.pending === false ? 'ack:' : 'pending:') + encodeURIComponent(event.viewer_id) + ':' + event.id;
}

// Notifications have their own IndexedDB store. Never evict orders, payment
// intents or sessions to make room in the much smaller localStorage quota.
export function createReadyNotificationStorage({ indexedDB, localStorage, timeoutMs = 5000 }) {
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('READY_NOTIFICATION_STORAGE_UNAVAILABLE')); return; }
      const request = indexedDB.open('tepiha-ready-notifications-v3', 1);
      let settled = false;
      const timer = setTimeout(() => finish(new Error('READY_NOTIFICATION_STORAGE_TIMEOUT')), timeoutMs);
      function finish(error, db) {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('events')) request.result.createObjectStore('events');
      };
      request.onerror = () => finish(request.error || new Error('READY_NOTIFICATION_STORAGE_UNAVAILABLE'));
      request.onblocked = () => finish(new Error('READY_NOTIFICATION_STORAGE_BLOCKED'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        finish(null, db);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }

  async function transaction(mode, action) {
    let db = await open(), tx;
    try { tx = db.transaction('events', mode); }
    catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      opening = null; db = await open(); tx = db.transaction('events', mode);
    }
    return new Promise((resolve, reject) => {
      let value, failure;
      const timer = setTimeout(() => {
        failure = new Error('READY_NOTIFICATION_STORAGE_TIMEOUT');
        try { tx.abort(); } catch {}
        opening = null; try { db.close(); } catch {}
        reject(failure);
      }, timeoutMs);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = () => { clearTimeout(timer); reject(failure || tx.error || new Error('READY_NOTIFICATION_STORAGE_ABORTED')); };
      tx.onerror = () => { failure ||= tx.error; };
      const fail = error => { failure = error; try { tx.abort(); } catch {} };
      try { action(tx.objectStore('events'), result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }

  function legacySnapshot() {
    const copies = new Map(), events = new Map();
    const raw = localStorage?.getItem(READY_NOTIFICATION_LEGACY_KEY);
    if (raw) {
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
      for (const event of rows) events.set(eventKey(event), event);
      copies.set(READY_NOTIFICATION_LEGACY_KEY, raw);
    }
    for (let i = 0; i < (localStorage?.length || 0); i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(READY_NOTIFICATION_ITEM_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (!value) continue;
      const event = JSON.parse(value);
      if (eventKey(event) !== key) throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
      copies.set(key, value); events.set(key, event);
    }
    return { copies, events };
  }

  async function read() {
    const legacy = legacySnapshot();
    const rows = await transaction(legacy.events.size ? 'readwrite' : 'readonly', (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const saved = new Map(request.result.map(event => [eventKey(event), event]));
          for (const [key, event] of legacy.events) {
            if (!saved.has(key)) { store.put(event, key); saved.set(key, event); }
          }
          done([...saved.values()]);
        } catch (error) { fail(error); }
      };
    });
    // Only a completed transaction permits removal of identical legacy copies.
    // Interrupted migrations and concurrent old-tab writes remain recoverable.
    for (const [key, raw] of legacy.copies) {
      try { if (localStorage.getItem(key) === raw) localStorage.removeItem(key); } catch {}
    }
    const result = new Map();
    for (const event of rows) {
      const identity = JSON.stringify([event.viewer_id, event.id]);
      const previous = result.get(identity);
      if (!previous || event.pending === false || previous.pending !== false) result.set(identity, event);
    }
    return [...result.values()];
  }

  async function write(events) {
    const rows = events.map(event => [eventKey(event), event]);
    await transaction('readwrite', store => {
      for (const [key, event] of rows) store.put(event, key);
    });
  }
  return { read, write };
}

export function readyNotificationStorageError(error) {
  if (error?.name === 'QuotaExceededError' || /quota/i.test(String(error?.message || ''))) {
    return 'Telefoni s’ka hapësirë për ta ruajtur lajmërimin. Liro pak hapësirë dhe provo përsëri.';
  }
  if (/READY_NOTIFICATION_STORAGE/.test(String(error?.message || ''))) {
    return 'Ruajtja në telefon nuk u përfundua. Provo përsëri.';
  }
  return error?.message || 'Lajmërimi nuk u ruajt. Provo përsëri.';
}
