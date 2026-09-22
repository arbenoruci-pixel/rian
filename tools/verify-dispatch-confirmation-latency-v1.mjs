import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDispatchOutbox, DISPATCH_OUTBOX_ITEM_PREFIX } from '../lib/dispatchOutbox.js';

const actor = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const payload = { id, client_name: 'SYNTHETIC TEST', client_phone: '+12025550100', data: { note: 'original' } };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function memory() {
  const rows = new Map();
  return { rows, getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value),
    removeItem: key => rows.delete(key), entries: () => [...rows] };
}
let passed = 0;
const failures = [];
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failures.push(name + ': ' + error.message); }
}

await test('a durably saved order reaches the server without waiting for an advisory sending write', async () => {
  const storage = memory(), write = storage.setItem, marker = deferred();
  let requests = 0;
  storage.setItem = async (key, raw) => {
    if (JSON.parse(raw).sending) await marker.promise;
    return write(key, raw);
  };
  const queue = createDispatchOutbox({ storage, getActorId: () => actor,
    submit: async body => { requests++; return { ok: true, data: { id: body.id, client_tcode: 'T123' } }; } });
  await queue.enqueue(payload);
  const sending = queue.send(id);
  try { await turn(); assert.equal(requests, 1, 'the status-only local write blocked CREATE'); }
  finally { marker.resolve(); await sending; await queue.drain(); }
});

await test('a verified server receipt releases the form and announces success while local receipt storage stalls', async () => {
  const storage = memory(), write = storage.setItem, receipt = deferred();
  let confirmed = 0, returned = false, requests = 0;
  storage.setItem = async (key, raw) => {
    if (JSON.parse(raw).state === 'sent') await receipt.promise;
    return write(key, raw);
  };
  const queue = createDispatchOutbox({ storage, getActorId: () => actor,
    submit: async body => { requests++; return { ok: true, data: { id: body.id, client_tcode: 'T123' } }; },
    onCommitted: () => { confirmed++; } });
  await queue.enqueue(payload);
  const sending = queue.send(id).then(result => { returned = true; return result; });
  try {
    await turn();
    assert.equal(confirmed, 1, 'the local receipt write hid a verified server confirmation');
    assert.equal(returned, true, 'the form still waited after the server confirmed');
    assert.equal((await queue.list())[0].state, 'sent');
    assert.equal((await queue.send(id, { force: true })).state, 'sent');
    assert.equal(requests, 1, 'receipt persistence must not cause another CREATE');
  } finally { receipt.resolve(); await sending; await queue.drain(); }
  assert.equal(JSON.parse(storage.rows.get(DISPATCH_OUTBOX_ITEM_PREFIX + id)).state, 'sent');
});

await test('an unavailable receipt store retains the exact durable request for idempotent replay after reload', async () => {
  const storage = memory(), write = storage.setItem, server = new Map(), bodies = [];
  let rejectReceipt = true;
  storage.setItem = (key, raw) => {
    if (rejectReceipt && JSON.parse(raw).state === 'sent') throw Error('DISPATCH_ORDER_STORAGE_TIMEOUT');
    return write(key, raw);
  };
  const make = () => createDispatchOutbox({ storage, getActorId: () => actor, submit: async body => {
    bodies.push(JSON.stringify(body));
    if (!server.has(body.id)) server.set(body.id, { id: body.id, client_tcode: 'T123' });
    return { ok: true, data: server.get(body.id) };
  } });
  const first = make(); await first.enqueue(payload);
  assert.equal((await first.send(id)).state, 'sent'); await first.drain();
  assert.equal(JSON.parse(storage.rows.get(DISPATCH_OUTBOX_ITEM_PREFIX + id)).payload.id, id);
  rejectReceipt = false;
  const reopened = make(); await reopened.drain();
  assert.equal((await reopened.list())[0].state, 'sent');
  assert.equal(server.size, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});

await test('a server rejection stays blocked and another actor cannot read or resend a cached receipt', async () => {
  let activeActor = actor, allowed = false, calls = 0;
  const queue = createDispatchOutbox({ storage: memory(), getActorId: () => activeActor, submit: async body => {
    calls++;
    return allowed ? { ok: true, data: { id: body.id, client_tcode: 'T123' } } : { ok: false, error: 'DEVICE_NOT_APPROVED' };
  } });
  await queue.enqueue(payload);
  assert.equal((await queue.send(id)).state, 'blocked');
  await queue.drain(); assert.equal(calls, 1);
  allowed = true; await queue.retry(id); assert.equal((await queue.send(id)).state, 'sent');
  await queue.drain();
  activeActor = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(await queue.list(), []);
  await assert.rejects(queue.send(id), /ACTOR_SESSION_MISMATCH/);
  assert.equal(calls, 2);
});

await test('diagnostics retain the observed time, loaded asset and safe correlation IDs without customer data', async () => {
  const bodies = [];
  const source = fs.readFileSync('lib/dispatchDiagnostics.js', 'utf8').replace(/^import .*$/gm, '').replace(/export /g, '');
  const ctx = { window: { location: { origin: 'https://example.test' }, __TEPIHA_BUILD_ID: 'test' },
    navigator: { onLine: true }, document: { visibilityState: 'visible', querySelector: () => ({ getAttribute: () => '/assets/index-test.js' }) },
    URL, Date, setTimeout, clearTimeout,
    fetchJsonWithDeadline: async (_url, init) => { bodies.push(JSON.parse(init.body)); } };
  vm.runInNewContext(source + '\nreportDispatchDiagnostic("confirmed", input);', { ...ctx,
    input: { requestId: id, orderId: id, attempts: 2, name: 'PRIVATE', phone: '+12025550100' } });
  const body = bodies[0];
  assert.equal(Date.parse(body.lastEventAt), Number(body.bootId.slice(9)));
  assert.equal(body.meta.requestId, id); assert.equal(body.meta.orderId, id);
  assert.equal(body.meta.asset, '/assets/index-test.js'); assert.equal(body.meta.release, 'dispatch-confirmation-v1');
  assert.equal(body.meta.attempts, 2); assert.equal(body.online, true); assert.equal(body.visibilityState, 'visible');
  assert(!JSON.stringify(body).includes('PRIVATE')); assert(!JSON.stringify(body).includes('+12025550100'));
  vm.runInNewContext(source + '\nreportDispatchDiagnostic("queue_issue", input);', { ...ctx,
    input: { requestId: 'PRIVATE', orderId: '+12025550100', code: 'DISPATCH_ORDER_STORAGE_TIMEOUT', storageStage: 'receipt_save' } });
  assert.equal(bodies[1].meta.requestId, ''); assert.equal(bodies[1].meta.orderId, '');
  assert.equal(bodies[1].meta.storageStage, 'receipt_save');
});

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
console.log(`${passed} passed; ${failures.length} failed: Dispatch confirmation latency v1`);
