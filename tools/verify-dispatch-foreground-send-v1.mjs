import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDispatchListLoader } from '../lib/dispatchList.js';
import { watchDispatchPhoneCheck } from '../lib/dispatchPhoneCheck.js';
import { createDispatchOutbox } from '../lib/dispatchOutbox.js';
import { fetchJsonWithDeadline, withDeadline } from '../lib/boundedRequest.js';

let passed = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }

function board(fetchRows) {
  let rows = [], busy = false;
  const errors = [], timers = new Map(); let next = 0;
  const loader = createDispatchListLoader({ fetchRows, getActorId: () => 'actor',
    onRows: update => { rows = update(rows); }, onBusy: value => { busy = value; }, onError: error => errors.push(error),
    setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; }, clearTimer: id => timers.delete(id) });
  return { loader, errors, timers, get rows() { return rows; }, get busy() { return busy; } };
}

await test('opening a form aborts the full list and defers poll/realtime reads until close', async () => {
  let calls = 0, signal;
  const stale = deferred();
  const f = board((_actor, input) => { calls++; signal = input; return calls === 1 ? stale.promise : Promise.resolve([]); });
  const first = f.loader.refresh(); await turn();
  f.loader.setPaused(true); assert.equal(signal.aborted, true);
  await first;
  for (let n = 0; n < 5; n++) await f.loader.refresh({ followUp: n % 2 === 0 });
  assert.equal(calls, 1); assert.equal(f.busy, false); assert.equal(f.errors.length, 0); assert.equal(f.timers.size, 0);
  const receipt = { id: 'committed', updated_at: '2026-09-20T20:00:00Z' };
  f.loader.record(receipt); assert.equal(f.rows[0].id, receipt.id);
  f.loader.setPaused(false); await turn(); assert.equal(calls, 2);
  stale.resolve([{ id: 'stale' }]); await turn(); assert.equal(f.rows.some(row => row.id === 'stale'), false);
  f.loader.stop();
});

await test('rapid hide/show starts one fresh read while cancellation is still unwinding', async () => {
  let calls = 0;
  const f = board(() => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve([{ id: 'fresh' }]); });
  const first = f.loader.refresh(); await turn();
  f.loader.setPaused(true); f.loader.setPaused(false);
  await first;
  assert.equal(calls, 2); assert.equal(f.rows[0].id, 'fresh'); assert.equal(f.errors.length, 1); assert.equal(f.errors[0], null);
  f.loader.stop();
});

await test('pausing clears scheduled retries and stopped loaders cannot restart', async () => {
  let calls = 0;
  const f = board(async () => { calls++; throw new Error('DISPATCH_LIST_TIMEOUT'); });
  await f.loader.refresh(); assert.equal(f.timers.size, 1);
  f.loader.setPaused(true); assert.equal(f.timers.size, 0);
  f.loader.stop(); f.loader.setPaused(false); await f.loader.refresh(); assert.equal(calls, 1);
});

function phone(inspect, hidden = false) {
  const events = new EventTarget(), visibility = new EventTarget(); visibility.hidden = hidden;
  const results = [], errors = [], timers = new Map(); let next = 0, busy = false;
  const stop = watchDispatchPhoneCheck({ inspect, events, visibility, online: () => true,
    onResult: result => results.push(result), onError: error => errors.push(error), onBusy: value => { busy = value; },
    setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; }, clearTimer: id => timers.delete(id) });
  return { events, visibility, results, errors, timers, stop, get busy() { return busy; },
    hide(value) { visibility.hidden = value; visibility.dispatchEvent(new Event('visibilitychange')); },
    tick() { const [id, { fn }] = timers.entries().next().value; timers.delete(id); return fn(); } };
}

await test('phone lookup cancels silently in background and recovers immediately without waiting for the old request', async () => {
  let calls = 0, signal; const stale = deferred();
  const f = phone(input => { calls++; signal = input; return calls === 1 ? stale.promise : Promise.resolve({ client: 'current' }); });
  const first = f.tick(); await turn();
  f.hide(true); assert.equal(signal.aborted, true); assert.equal(f.busy, false); assert.equal(f.timers.size, 0);
  f.hide(false); f.events.dispatchEvent(new Event('pageshow')); f.events.dispatchEvent(new Event('focus'));
  assert.equal(f.timers.size, 1); await f.tick(); await first;
  stale.resolve({ client: 'stale' }); await turn();
  assert.deepEqual(f.results, [{ client: 'current' }]); assert.equal(f.errors.length, 0);
  f.hide(true); f.hide(false); assert.equal(f.timers.size, 0, 'completed lookup must not repeat'); f.stop();
});

await test('a form first rendered hidden checks the phone on return', async () => {
  let calls = 0; const f = phone(async () => { calls++; return {}; }, true);
  await f.tick(); assert.equal(calls, 0); assert.equal(f.errors.length, 0);
  f.hide(false); await f.tick(); assert.equal(calls, 1); f.stop();
});

await test('explicit device denial remains blocked through focus and visibility events', async () => {
  let calls = 0; const f = phone(async () => { calls++; throw new Error('DEVICE_NOT_APPROVED'); });
  await f.tick(); f.hide(true); f.hide(false); f.events.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1); assert.equal(f.timers.size, 0); f.stop();
});

await test('shipping page pauses board for the form and restarts it after closing', async () => {
  const page = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
  const start = page.indexOf('  useEffect(() => {\n    // The full board');
  const callback = page.slice(start + '  useEffect('.length, page.indexOf(', [createOpen, getRowsLoader]);', start));
  const document = new EventTarget(); document.hidden = false;
  const pauses = []; const context = { createOpen: true, document, getRowsLoader: () => ({ setPaused: value => pauses.push(value) }) };
  const effect = vm.runInNewContext('(' + callback + ')', context);
  const cleanup = effect(); assert.equal(pauses.at(-1), true); cleanup();
  context.createOpen = false; const close = effect(); assert.equal(pauses.at(-1), false);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(pauses.at(-1), true); close();
});

await test('shipping phone effect releases the lookup during submission', async () => {
  const page = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
  const start = page.indexOf('  useEffect(() => {\n    // Cleanup cancels');
  const callback = page.slice(start + '  useEffect('.length, page.indexOf(', [phone, phoneCheckNonce, createOpen, busy]);', start));
  let busy;
  const effect = vm.runInNewContext('(' + callback + ')', { busy: true, setPhoneBusy: value => { busy = value; } });
  assert.equal(effect(), undefined); assert.equal(busy, false);
});

await test('lost CREATE response retries the identical durable request without keepalive or duplicate order', async () => {
  const source = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
  const begin = source.indexOf('async function insertAtomicDispatchOrderViaApi(');
  const end = source.indexOf('\nasync function insertAtomicTransportSelfEntryViaApi(', begin);
  const expected = { id: '11111111-1111-4111-8111-111111111111' };
  const actor = '22222222-2222-4222-8222-222222222222';
  const create = new Function('fetchJsonWithDeadline', 'withDeadline', 'ensureApprovedDeviceSession', 'reconcileAtomicDispatchOrder', 'assertAtomicTransportOrder', 'assertDeduplicatedActiveDispatchOrder',
    source.slice(begin, end) + '\nreturn insertAtomicDispatchOrderViaApi;')(
    (url, init) => fetchJsonWithDeadline(url, init, 20), withDeadline,
    () => assert.fail('unexpected auth repair'), () => assert.fail('must use approved server'),
    (row, wanted) => assert.equal(row.id, wanted.id), () => assert.fail('unexpected dedupe'));
  const storage = new Map(); const db = new Map(); const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init); assert.equal(init.keepalive, false);
    const body = JSON.parse(init.body);
    if (!db.has(body.id)) db.set(body.id, { id: body.id, client_tcode: 'T123' });
    if (calls.length === 1) return { json: () => new Promise(() => {}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: db.get(body.id), idempotent: true }) };
  };
  try {
    const q = createDispatchOutbox({ storage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key), entries: () => [...storage] },
      getActorId: () => actor, submit: body => create(body, expected) });
    await q.enqueue({ ...expected, client_name: 'SYNTHETIC TEST', client_phone: '12025550100', expected_actor_id: actor });
    assert.equal((await q.send(expected.id)).state, 'pending');
    const retry = await q.send(expected.id, { force: true });
    assert.equal(retry.state, 'sent'); assert.equal(retry.code, 'T123'); assert.equal(db.size, 1);
    assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

console.log(`${passed} passed: Dispatch foreground send v1`);
