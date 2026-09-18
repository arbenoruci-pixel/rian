import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { createIncidentDelivery, incidentKey, INCIDENT_PENDING_PREFIX, MAX_PENDING_INCIDENTS, MAX_PENDING_INCIDENT_CHARS } from '../lib/runtimeIncidentDelivery.js';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const runtime = fs.readFileSync('lib/offlineRuntime.js', 'utf8');
const mergeSource = runtime.slice(runtime.indexOf('function isDirtyLocalRow('), runtime.indexOf('async function fetchPaged('));
async function database() {
  const idb = new IDBFactory();
  let opens = 0;
  const open = () => new Promise((resolve, reject) => {
    const req = idb.open('test', 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('orders', { keyPath: 'id' });
      store.createIndex('unique', 'unique', { unique: true });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
  async function seed(rows) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('orders', 'readwrite');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      for (const row of rows) tx.objectStore('orders').put(row);
    }); db.close();
  }
  async function read() {
    const db = await open();
    const result = await new Promise((resolve, reject) => {
      const req = db.transaction('orders').objectStore('orders').getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }); db.close(); return result;
  }
  function merger({ abort = () => false, beforeOpen = async () => {}, putError } = {}) {
    const ctx = vm.createContext({ DOMException, OFFLINE_RUNTIME_VERSION: 'test', nowIso: () => 'test-time',
      openAppDb: async () => {
        const attempt = ++opens; await beforeOpen(attempt);
        const db = await open(), original = db.transaction.bind(db);
        db.transaction = (...args) => {
          const tx = original(...args);
          if (abort(attempt)) queueMicrotask(() => tx.abort());
          if (putError) {
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = (...a) => {
              const store = objectStore(...a);
              store.put = () => { throw putError; };
              return store;
            };
          }
          return tx;
        };
        return db;
      },
    });
    vm.runInContext(mergeSource, ctx);
    return rows => ctx.batchMergeRows('orders', rows);
  }
  return { seed, read, merger, opens: () => opens };
}

await test('aborted snapshot retries once with a fresh transaction and preserves local edits made between attempts', async () => {
  const f = await database();
  await f.seed([{ id: 'pending', _dirty: true, note: 'local' }, { id: 'clean', note: 'old' }]);
  const merge = f.merger({ abort: n => n === 1, beforeOpen: async n => {
    if (n === 2) await f.seed([{ id: 'clean', _syncPending: true, note: 'new local edit' }]);
  } });
  const result = await merge([{ id: 'pending', note: 'remote' }, { id: 'clean', note: 'remote' }, { id: 'new', note: 'remote' }]);
  assert.equal(f.opens(), 2); assert.equal(result.preserved, 2); assert.equal(result.written, 1);
  const rows = await f.read();
  assert.equal(rows.find(r => r.id === 'pending').note, 'local');
  assert.equal(rows.find(r => r.id === 'clean').note, 'new local edit');
  assert.equal(rows.find(r => r.id === 'new')._synced, true);
});
await test('repeated abort is bounded and never overwrites existing data', async () => {
  const f = await database(); await f.seed([{ id: 'keep', note: 'local' }]);
  await assert.rejects(f.merger({ abort: () => true })(Array.from({ length: 60 }, (_, id) => ({ id }))), { name: 'AbortError' });
  assert.equal(f.opens(), 2); assert.deepEqual(await f.read(), [{ id: 'keep', note: 'local' }]);
});
await test('synchronous quota failure is caught without retry or unhandled callbacks', async () => {
  const f = await database(); await f.seed([{ id: 'keep', _dirty: true }]);
  await assert.rejects(f.merger({ putError: new DOMException('full', 'QuotaExceededError') })([{ id: 'new' }]), { name: 'QuotaExceededError' });
  assert.equal(f.opens(), 1); assert.deepEqual(await f.read(), [{ id: 'keep', _dirty: true }]);
});
await test('asynchronous write failure rolls back all rows and stops pending read callbacks', async () => {
  const f = await database(); await f.seed([{ id: 'keep', note: 'unchanged' }]);
  await assert.rejects(f.merger()(Array.from({ length: 60 }, (_, id) => ({ id, unique: 'collision' }))), { name: 'ConstraintError' });
  assert.equal(f.opens(), 1); assert.deepEqual(await f.read(), [{ id: 'keep', note: 'unchanged' }]);
});
await test('all existing pending-work markers survive a normal snapshot merge', async () => {
  const f = await database();
  const rows = [{ _dirty: true }, { _local: true }, { _syncPending: true }, { _syncing: true },
    ...['pending', 'queued', 'local', 'dirty', 'syncing', 'failed'].map(sync_state => ({ sync_state }))].map((r, id) => ({ id, ...r }));
  await f.seed(rows); const result = await f.merger()(rows.map(r => ({ id: r.id, remote: true })));
  assert.equal(result.preserved, rows.length); assert.equal(result.written, 0); assert.deepEqual(await f.read(), rows);
});

function storage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}
const body = n => ({ bootId: 'boot-test', incidentType: 'window_error', currentPath: '/dispatch', lastEventType: 'window_error', lastEventAt: `2026-09-18T21:03:10.${String(n).padStart(3, '0')}Z` });
const reply = (json, ok = true) => ({ ok, json: async () => json });
const pendingCount = s => [...s.map.keys()].filter(k => k.startsWith(INCIDENT_PENDING_PREFIX)).length;

await test('offline error storm has bounded count/size and keeps every accepted sample retryable', async () => {
  const s = storage(); s.setItem('payment-intent', 'KEEP'); let online = false, ack = 0;
  const q = createIncidentDelivery({ storage: s, online: () => online, onConfirmed: () => ack++, fetcher: async () => reply({ ok: true, stored: true }) });
  for (let n = 0; n < 500; n++) await q.send({ ...body(n), meta: { message: 'repeat', stack: 'x'.repeat(1200) } });
  const accepted = pendingCount(s);
  assert(accepted > 0 && accepted <= MAX_PENDING_INCIDENTS);
  const size = [...s.map].filter(([k]) => k.startsWith(INCIDENT_PENDING_PREFIX)).reduce((total, [k, v]) => total + k.length + v.length, 0);
  assert(size <= MAX_PENDING_INCIDENT_CHARS); assert.equal(s.getItem('payment-intent'), 'KEEP');
  assert.equal(JSON.parse(s.getItem('tepiha_incident_overflow_v3')).count, 500 - accepted);
  assert(s.getItem(INCIDENT_PENDING_PREFIX + incidentKey(body(0))), 'oldest unconfirmed evidence retained');
  online = true; for (let i = 0; i < 3; i++) await q.flush();
  assert.equal(ack, accepted); assert.equal(pendingCount(s), 0);
});
await test('full Web Storage also bounds the memory queue and rejects oversized new diagnostics', async () => {
  const s = storage(); s.setItem = () => { throw new Error('quota'); }; let online = false, ack = 0;
  const q = createIncidentDelivery({ storage: s, online: () => online, onConfirmed: () => ack++, fetcher: async () => reply({ ok: true, stored: true }) });
  assert.equal((await q.send({ ...body(999), meta: { stack: 'x'.repeat(9000) } })).queued, false);
  for (let n = 0; n < 500; n++) await q.send(body(n));
  online = true; for (let i = 0; i < 5; i++) await q.flush();
  assert(ack > 0 && ack <= MAX_PENDING_INCIDENTS);
});

for (const [label, response] of [
  ['stored false', reply({ ok: true, stored: false })], ['malformed', reply(null)],
  ['non-JSON', { ok: true, json: async () => { throw new Error('html'); } }],
  ['ok false', reply({ ok: false, stored: true })], ['HTTP failure', reply({ ok: true, stored: true }, false)],
  ['unverified duplicate', reply({ ok: true, duplicate: true })],
]) await test(`unconfirmed ${label} response retains the incident`, async () => {
  const s = storage(); let ack = 0;
  const q = createIncidentDelivery({ storage: s, fetcher: async () => response, onConfirmed: () => ack++ });
  assert.equal((await q.send(body(1))).ok, false); assert.equal(ack, 0); assert.equal(pendingCount(s), 1);
});
await test('lost acknowledgement survives reload and verifies the existing server row', async () => {
  const s = storage(), ledger = new Map(); let fail = true, ack = 0;
  const fetcher = async (_, options) => {
    const b = JSON.parse(options.body), key = incidentKey(b), duplicate = ledger.has(key);
    ledger.set(key, 'server-id');
    if (fail) { fail = false; throw new Error('reply lost'); }
    return reply({ ok: true, stored: !duplicate, duplicate, id: ledger.get(key) });
  };
  let q = createIncidentDelivery({ storage: s, fetcher, onConfirmed: () => ack++ });
  await q.send(body(1)); assert.equal(pendingCount(s), 1); assert.equal(ack, 0);
  q = createIncidentDelivery({ storage: s, fetcher, onConfirmed: () => ack++ });
  await q.flush(); assert.equal(ledger.size, 1); assert.equal(ack, 1); assert.equal(pendingCount(s), 0);
});
await test('offline start queues, reconnect flushes, simultaneous callers share one request', async () => {
  const s = storage(); let online = false, requests = 0;
  const q = createIncidentDelivery({ storage: s, online: () => online, fetcher: async () => {
    requests++; await new Promise(resolve => setTimeout(resolve, 5)); return reply({ ok: true, stored: true, id: 'id' });
  } });
  await q.send(body(1)); assert.equal(requests, 0); online = true;
  await Promise.all([q.flush(), q.send(body(1)), q.send(body(1))]); assert.equal(requests, 1); assert.equal(pendingCount(s), 0);
});
await test('timeout is bounded even when abort is ignored, and a late response cannot acknowledge', async () => {
  const s = storage(); let finish, ack = 0;
  const q = createIncidentDelivery({ storage: s, timeoutMs: 5, onConfirmed: () => ack++, fetcher: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal((await q.send(body(1))).ok, false);
  finish(reply({ ok: true, stored: true })); await new Promise(setImmediate);
  assert.equal(ack, 0); assert.equal(pendingCount(s), 1);
});
await test('storage quota preserves unrelated business data and retries the in-memory report', async () => {
  const s = storage(); s.map.set('order-outbox', 'KEEP'); s.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  let online = false, ack = 0;
  const q = createIncidentDelivery({ storage: s, online: () => online, onConfirmed: () => ack++, fetcher: async () => reply({ ok: true, stored: true }) });
  await q.send(body(1)); online = true; await q.flush();
  assert.equal(ack, 1); assert.equal(s.getItem('order-outbox'), 'KEEP');
});
await test('two queue instances preserve distinct pending events and ignore the old unverified sent ledger', async () => {
  const s = storage(); s.map.set('tepiha_simple_incident_sent_v2', JSON.stringify([incidentKey(body(1))]));
  for (const n of [1, 2]) await createIncidentDelivery({ storage: s, online: () => false }).send(body(n));
  assert.equal(pendingCount(s), 2);
});

const handlerSource = fs.readFileSync('api/runtime-incident.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
function api({ insertError, lookupError, missing = false } = {}) {
  const ledger = new Map(); let lastMatch, logged, output;
  const context = vm.createContext({
    readBody: async req => req.body,
    createAdminClientOrThrow: () => ({ from: table => {
      assert.equal(table, 'runtime_incidents');
      const key = row => JSON.stringify([row.boot_id, row.incident_type, row.current_path, row.last_event_type, row.last_event_at_client]);
      return {
        insert: row => ({ select: () => ({ single: async () => {
          if (insertError) return { error: insertError };
          if (ledger.has(key(row))) return { error: { code: '23505' } };
          const id = `row-${ledger.size}`; ledger.set(key(row), id); return { data: { id } };
        } }) }),
        select: () => ({ match: match => { lastMatch = match; return { maybeSingle: async () => ({
          error: lookupError, data: missing ? null : ledger.has(key(match)) ? { id: ledger.get(key(match)) } : null,
        }) }; } }),
      };
    } }),
    apiOk: (_, data, status = 200) => { output = { status, ok: true, ...data }; },
    apiFail: (_, error, status) => { output = { status, ok: false, error }; },
    console: { error: (_, data) => { logged = data; } },
  }); vm.runInContext(handlerSource, context);
  return { call: async b => { await context.handler({ method: 'POST', body: b }, {}); return output; }, ledger,
    match: () => lastMatch, logged: () => logged };
}
await test('server acknowledges insert then exact duplicate without conflating different event times', async () => {
  const h = api(); assert.equal((await h.call(body(1))).stored, true);
  const duplicate = await h.call(body(1)); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.id, 'row-0');
  assert.deepEqual(Object.keys(h.match()).sort(), ['boot_id', 'current_path', 'incident_type', 'last_event_at_client', 'last_event_type']);
  assert.equal((await h.call(body(2))).stored, true); assert.equal(h.ledger.size, 2);
});
for (const options of [{ insertError: { code: '23502', message: 'PRIVATE' } },
  { insertError: { code: '23505' }, missing: true }, { insertError: { code: '23505' }, lookupError: { code: 'timeout' } }]) {
  await test(`server refuses unverified persistence ${JSON.stringify(options)}`, async () => {
    const h = api(options), result = await h.call(body(1));
    assert.equal(result.ok, false); assert.equal(result.stored, false); assert.equal(result.status, 503);
    assert(!JSON.stringify(h.logged()).includes('PRIVATE'));
  });
}

await test('component preserves newer same-boot incidents, original early boot identity, and unrelated queue items', async () => {
  const s = storage(); let pending = body(2), cleared = 0;
  const source = fs.readFileSync('components/RuntimeIncidentUploader.jsx', 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
  const ctx = vm.createContext({ createIncidentDelivery, incidentKey, useEffect: () => {},
    window: { localStorage: s, location: { pathname: '/dispatch', search: '' } }, document: { visibilityState: 'visible' },
    navigator: { onLine: true }, isSafeModeDisabledUntil: () => false, isTepihaSafeModeActive: () => false,
    bootSnapshot: () => ({ bootId: 'new-boot' }), bootReadLastInterrupted: () => pending,
    bootClearLastInterrupted: () => { cleared++; pending = null; }, fetch: async () => reply({ ok: true, stored: true }),
  }); vm.runInContext(source, ctx);
  await ctx.postIncident(body(1)); assert.equal(cleared, 0);
  await ctx.postIncident(body(2)); assert.equal(cleared, 1);
  assert.equal(ctx.buildChunkCapturePayload({ bootId: 'original', at: 'original-time' }).bootId, 'original');
  const a = { bootId: 'a' }, b = { bootId: 'b' };
  s.setItem('tepiha_early_incident_queue_v1', JSON.stringify([a, b]));
  ctx.acknowledgeEarlyItem(a); assert.deepEqual(JSON.parse(s.getItem('tepiha_early_incident_queue_v1')), [b]);
  assert(!source.includes('sendBeacon(')); assert(!source.includes('clearEarlyQueue('));
});

console.log(`PASS offline snapshot/incident safety: ${passed} regression checks; synthetic local data only.`);
