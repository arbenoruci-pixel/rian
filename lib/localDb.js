const DB_NAME = 'tepiha_offline_db';
const DB_VERSION = 5;

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function waitForTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

function ensureIndex(store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options);
  }
}

export function createSecureId(prefix = 'id') {
  const c = globalThis.crypto;

  if (c?.randomUUID) return `${prefix}_${c.randomUUID()}`;

  if (!c?.getRandomValues) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  const uuid = [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');

  return `${prefix}_${uuid}`;
}

export function createOfflineTransportId(prefix = 'transport') {
  return createSecureId(prefix);
}

export function openAppDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('orders')) {
        db.createObjectStore('orders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('clients')) {
        db.createObjectStore('clients', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      let opsStore;
      if (!db.objectStoreNames.contains('ops')) {
        opsStore = db.createObjectStore('ops', { keyPath: 'op_id' });
      } else {
        opsStore = event.target.transaction.objectStore('ops');
      }
      ensureIndex(opsStore, 'by_created_at', 'created_at', { unique: false });
      ensureIndex(opsStore, 'by_status', 'status', { unique: false });
      ensureIndex(opsStore, 'by_kind', 'kind', { unique: false });

      let deadStore;
      if (!db.objectStoreNames.contains('offline_ops_dead_letter')) {
        deadStore = db.createObjectStore('offline_ops_dead_letter', { keyPath: 'dead_id' });
      } else {
        deadStore = event.target.transaction.objectStore('offline_ops_dead_letter');
      }
      ensureIndex(deadStore, 'by_created_at', 'created_at', { unique: false });
      ensureIndex(deadStore, 'by_original_op_id', 'original_op_id', { unique: false });

      let transportStore;
      if (!db.objectStoreNames.contains('transport_orders')) {
        transportStore = db.createObjectStore('transport_orders', { keyPath: 'id' });
      } else {
        transportStore = event.target.transaction.objectStore('transport_orders');
      }
      ensureIndex(transportStore, 'by_status', 'status', { unique: false });
      ensureIndex(transportStore, 'by_transport_id', 'transport_id', { unique: false });
      ensureIndex(transportStore, 'by_client_tcode', 'client_tcode', { unique: false });
      ensureIndex(transportStore, 'by_updated_at', 'updated_at', { unique: false });
      ensureIndex(transportStore, 'by_created_at', 'created_at', { unique: false });
      ensureIndex(transportStore, 'by_sync_state', 'sync_state', { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

export async function getByKey(storeName, key) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).get(key);
  const value = await promisifyRequest(req);
  await waitForTx(tx);
  return value ?? null;
}

export async function putValue(storeName, value) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await waitForTx(tx);
  return value;
}

export async function deleteByKey(storeName, key) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await waitForTx(tx);
  return true;
}

export async function clearStore(storeName) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await waitForTx(tx);
  return true;
}

export async function getAllFromStore(storeName) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).getAll();
  const rows = await promisifyRequest(req);
  await waitForTx(tx);
  return Array.isArray(rows) ? rows : [];
}

export async function getAllFromIndex(storeName, indexName, value, limit = 0, direction = 'next') {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);
  const out = [];

  await new Promise((resolve, reject) => {
    const req = index.openCursor(value === undefined ? null : IDBKeyRange.only(value), direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      out.push(cursor.value);
      if (limit > 0 && out.length >= limit) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('Cursor failed'));
  });

  await waitForTx(tx);
  return out;
}

export async function iterateIndex(storeName, indexName, { value, direction = 'next', limit = 0, filter } = {}) {
  const db = await openAppDb();
  const tx = db.transaction(storeName, 'readonly');
  const source = tx.objectStore(storeName).index(indexName);
  const out = [];

  await new Promise((resolve, reject) => {
    const range = value === undefined ? null : IDBKeyRange.only(value);
    const req = source.openCursor(range, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const row = cursor.value;
      if (!filter || filter(row)) out.push(row);
      if (limit > 0 && out.length >= limit) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('Cursor failed'));
  });

  await waitForTx(tx);
  return out;
}

export async function getEarliestFromIndex(storeName, indexName) {
  const rows = await iterateIndex(storeName, indexName, { limit: 1, direction: 'next' });
  return rows[0] || null;
}
