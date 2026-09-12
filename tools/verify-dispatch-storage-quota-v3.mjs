import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb';
import { createDispatchOutboxStorage } from '../lib/dispatchOutboxStorage.js';
import { createDispatchOutbox, DISPATCH_OUTBOX_KEY, DISPATCH_OUTBOX_ITEM_PREFIX } from '../lib/dispatchOutbox.js';

const actor = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const payload = n => ({ id: uuid(n), client_name: 'SYNTHETIC TEST', client_phone: `1202555${String(n).padStart(4, '0')}`, data: { note: 'Original', pickup_date: '2026-09-12', pickup_plan: { pieces: 1, measurements_m2: [5.8] }, transport_id: otherActor } });
function local(full = true) {
  const map = new Map();
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: key => map.get(key) ?? null, removeItem: key => map.delete(key),
    setItem(key, value) { if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); map.set(key, value); } };
}
function fixture(options = {}) {
  const indexedDB = options.indexedDB || new IDBFactory(), localStorage = options.localStorage || local();
  const state = { actor, online: false, now: 1000, calls: [], acknowledgements: 0 };
  const durable = () => createDispatchOutboxStorage({ indexedDB, localStorage });
  const queue = (storage = durable()) => createDispatchOutbox({ storage, getActorId: () => state.actor, online: () => state.online, now: () => state.now,
    onChange: () => state.acknowledgements++, submit: async body => { state.calls.push(body); return options.submit ? options.submit(body) : { ok: true, data: { id: body.id, client_tcode: 'T101' } }; } });
  return { indexedDB, localStorage, state, durable, queue };
}
let passed = 0; const failures = [];
async function test(name, run) { try { await run(); passed++; } catch (e) { failures.push(`${name}: ${e.stack}`); } }

await test('full Web Storage accepts an online order without clearing unrelated data', async () => {
  const f = fixture();
  for (const key of ['CURRENT_USER_DATA', 'payment-intent', 'unknown-cache']) f.localStorage.map.set(key, 'KEEP');
  const q = f.queue(); f.state.online = true;
  const saved = await q.enqueue(payload(1)); assert.equal(saved.id, uuid(1)); await q.drain();
  assert.equal(f.state.calls.length, 1); assert.equal((await q.list())[0].state, 'sent');
  for (const key of ['CURRENT_USER_DATA', 'payment-intent', 'unknown-cache']) assert.equal(f.localStorage.getItem(key), 'KEEP');
});
await test('100 offline orders survive new storage/outbox instances and replay once', async () => {
  const f = fixture(); let q = f.queue();
  for (let n = 1; n <= 100; n++) await q.enqueue(payload(n));
  await q.drain(); assert.equal(f.state.calls.length, 0);
  q = f.queue(); assert.equal((await q.list()).length, 100); f.state.online = true;
  await q.drain(); await q.drain(); assert.equal(f.state.calls.length, 100);
  assert((await q.list()).every(row => row.state === 'sent'));
});
await test('lost server response and reload retain the original UUID and payload', async () => {
  const server = new Map(); let lose = true;
  const f = fixture({ submit: async body => {
    server.set(body.id, body);
    if (lose) { lose = false; return { ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' }; }
    return { ok: true, data: { id: body.id, client_tcode: 'T101' } };
  } });
  let q = f.queue(); await q.enqueue(payload(1)); f.state.online = true; await q.drain();
  q = f.queue(); f.state.now += 30001; await q.drain();
  assert.equal(server.size, 1); assert.deepEqual(f.state.calls[0], f.state.calls[1]); assert.equal((await q.list())[0].state, 'sent');
});
await test('legacy per-order rows remain readable and migrate only after a committed update', async () => {
  const old = local(false), f = fixture({ localStorage: old });
  const legacyQueue = f.queue(old); const original = await legacyQueue.enqueue(payload(1));
  old.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const q = f.queue(); assert.deepEqual((await q.list())[0], original);
  assert(old.getItem(DISPATCH_OUTBOX_ITEM_PREFIX + uuid(1)));
  f.state.online = true; await q.drain();
  assert.equal(old.getItem(DISPATCH_OUTBOX_ITEM_PREFIX + uuid(1)), null);
  assert.equal((await f.queue().list())[0].state, 'sent');
});
await test('legacy array migrates under full local quota with all payloads intact', async () => {
  const old = local(false), f = fixture({ localStorage: old }); const oldQueue = f.queue(old);
  await oldQueue.enqueue(payload(1)); await oldQueue.enqueue(payload(2)); const items = await oldQueue.list();
  old.map.clear(); old.map.set(DISPATCH_OUTBOX_KEY, JSON.stringify({ version: 1, items }));
  old.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  assert.deepEqual(await f.queue().list(), items); assert.equal(old.getItem(DISPATCH_OUTBOX_KEY), null);
  assert.deepEqual(await f.queue().list(), items);
});
await test('IndexedDB transaction abort after put success never acknowledges or sends', async () => {
  const f = fixture(); f.state.online = true; const q = f.queue();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args); request.addEventListener('success', () => this.transaction.abort()); return request;
  };
  try { await assert.rejects(q.enqueue(payload(1))); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(f.state.acknowledgements, 0); await q.drain(); assert.equal(f.state.calls.length, 0); assert.equal((await q.list()).length, 0);
});
await test('IndexedDB quota failure preserves the legacy backup and sends nothing', async () => {
  const old = local(false), f = fixture({ localStorage: old }); const legacy = f.queue(old);
  await legacy.enqueue(payload(1)); const items = await legacy.list(); old.map.clear();
  const raw = JSON.stringify({ version: 1, items }); old.map.set(DISPATCH_OUTBOX_KEY, raw);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('IndexedDB full', 'QuotaExceededError'); };
  try { await assert.rejects(f.queue().enqueue(payload(2))); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(old.getItem(DISPATCH_OUTBOX_KEY), raw); assert.equal(f.state.calls.length, 0);
  assert.deepEqual(await f.queue().list(), items);
});
await test('late pending writes from another tab cannot overwrite a committed receipt', async () => {
  const f = fixture(); const q = f.queue(); await q.enqueue(payload(1)); const stale = (await q.list())[0];
  f.state.online = true; await q.drain();
  await f.durable().setItem(DISPATCH_OUTBOX_ITEM_PREFIX + stale.id, JSON.stringify({ ...stale, updatedAt: 999999 }));
  assert.equal((await f.queue().list())[0].state, 'sent');
  f.localStorage.map.set(DISPATCH_OUTBOX_ITEM_PREFIX + stale.id, JSON.stringify({ ...stale, updatedAt: 999999 }));
  assert.equal((await f.queue().list())[0].state, 'sent');
});
await test('two instances preserve simultaneous independent requests', async () => {
  const f = fixture(); await Promise.all([f.queue().enqueue(payload(1)), f.queue().enqueue(payload(2))]);
  assert.deepEqual((await f.queue().list()).map(row => row.id).sort(), [uuid(1), uuid(2)]);
});
await test('actor changes during async enqueue cannot submit another actors request', async () => {
  const f = fixture(), storage = f.durable(); const keys = storage.keys;
  storage.keys = async () => { f.state.actor = otherActor; return keys(); };
  await assert.rejects(f.queue(storage).enqueue(payload(1)), /ACTOR_SESSION_MISMATCH/);
  assert.equal((await f.queue().list()).length, 0); assert.equal(f.state.calls.length, 0);
});
await test('actor changes during list cannot reveal previous actors saved rows', async () => {
  const f = fixture(); await f.queue().enqueue(payload(1)); const storage = f.durable(), keys = storage.keys;
  storage.keys = async () => { f.state.actor = otherActor; return keys(); };
  assert.deepEqual(await f.queue(storage).list(), []);
});
await test('mutation while persistence waits cannot alter the frozen order', async () => {
  const f = fixture(), input = payload(1); const pending = f.queue().enqueue(input);
  input.id = uuid(99); input.client_name = 'CHANGED'; input.data.note = 'CHANGED';
  const saved = await pending; assert.equal(saved.id, uuid(1)); assert.equal(saved.name, 'SYNTHETIC TEST'); assert.equal(saved.payload.data.note, 'Original');
});
await test('blocked storage open has a deadline and permits a later recovery', async () => {
  const f = fixture(); let stuck = true;
  const storage = createDispatchOutboxStorage({ indexedDB: { open(...args) { if (stuck) return {}; return f.indexedDB.open(...args); } }, localStorage: f.localStorage, timeoutMs: 20 });
  await assert.rejects(f.queue(storage).enqueue(payload(1)), /STORAGE_TIMEOUT/);
  stuck = false; assert.equal((await f.queue(storage).enqueue(payload(1))).id, uuid(1));
});
await test('blocked order retries after the device clock moves backward', async () => {
  let allowed = false;
  const f = fixture({ submit: async body => allowed
    ? { ok: true, data: { id: body.id, client_tcode: 'T101' } }
    : { ok: false, error: 'AUTH_REQUIRED' } });
  const q = f.queue(); f.state.now = 100000; f.state.online = true;
  await q.enqueue(payload(1)); await q.drain();
  assert.equal((await q.list())[0].state, 'blocked');
  f.state.now = 1000; allowed = true;
  await q.retry(uuid(1)); await q.drain();
  assert.equal((await f.queue().list())[0].state, 'sent');
  assert.deepEqual(f.state.calls[0], f.state.calls[1]);
});
await test('unexpected database close recovers in the same running queue', async () => {
  const factory = new IDBFactory(); let db;
  const f = fixture({ indexedDB: { open(...args) {
    const request = factory.open(...args);
    request.addEventListener('success', () => { db = request.result; });
    return request;
  } } });
  const q = f.queue(); await q.enqueue(payload(1));
  forceCloseDatabase(db);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await q.list())[0].id, uuid(1));
  f.state.online = true; await q.drain();
  assert.equal((await q.list())[0].state, 'sent');
});
await test('form awaits persistence and runtime uses the durable adapter', () => {
  assert.match(fs.readFileSync('app/dispatch/page.jsx', 'utf8'), /const queued = await getDispatchOutbox\(\)\.enqueue\(/);
  assert.match(fs.readFileSync('lib/dispatchOutboxRuntime.js', 'utf8'), /storage: createDispatchOutboxStorage\(/);
});

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
console.log(`${passed} passed; ${failures.length} failed: Dispatch storage quota v3`);
