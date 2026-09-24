import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDispatchOutbox } from '../lib/dispatchOutbox.js';

let passed = 0, failed = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
const actor = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const payload = { id, client_name: 'SYNTHETIC TEST', client_phone: '12025550100', expected_actor_id: actor };
function queueFixture(submit) {
  const values = new Map(); let currentActor = actor, online = true, now = 100000;
  const q = createDispatchOutbox({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key), entries: () => [...values] },
    getActorId: () => currentActor, online: () => online, now: () => now, submit,
  });
  return { q, values, setActor: value => { currentActor = value; }, setOnline: value => { online = value; }, advance: value => { now += value; } };
}

await test('reconnection retries a pending immutable request immediately while normal polling keeps backoff', async () => {
  const calls = [], server = new Map();
  const f = queueFixture(async body => {
    calls.push(JSON.stringify(body));
    if (!server.has(body.id)) server.set(body.id, { id: body.id, client_tcode: 'T123' });
    if (calls.length === 1) return { ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' };
    return { ok: true, data: server.get(body.id), idempotent: true };
  });
  await f.q.enqueue(payload); await f.q.send(id);
  await f.q.drain(); assert.equal(calls.length, 1, 'ordinary polling must respect retry delay');
  await f.q.drain({ force: true });
  assert.equal(calls.length, 2, 'reconnect left the saved order waiting for its backoff');
  assert.equal((await f.q.list())[0].state, 'sent');
  assert.equal(calls[0], calls[1]); assert.equal(server.size, 1);
});

await test('reconnect during a running normal drain is coalesced into one immediate recovery', async () => {
  let finish, calls = 0;
  const f = queueFixture(async body => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return { ok: true, data: { id: body.id, client_tcode: 'T123' } };
  });
  await f.q.enqueue(payload);
  const running = f.q.drain(); await turn();
  const wakes = [f.q.drain({ force: true }), f.q.drain({ force: true })];
  finish({ ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' });
  await Promise.all([running, ...wakes]);
  assert.equal(calls, 2); assert.equal((await f.q.list())[0].state, 'sent');
});
await test('reconnect while the form is awaiting a direct send preserves one recovery attempt', async () => {
  let finish, calls = 0;
  const f = queueFixture(async body => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return { ok: true, data: { id: body.id, client_tcode: 'T123' } };
  });
  await f.q.enqueue(payload);
  const foreground = f.q.send(id, { force: true }); await turn();
  const reconnect = f.q.drain({ force: true }); await turn();
  assert.equal(calls, 1, 'reconnect must share the active request');
  finish({ ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' });
  await Promise.all([foreground, reconnect]);
  assert.equal(calls, 2, 'the reconnect was lost while joining the foreground send');
  assert.equal((await f.q.list())[0].state, 'sent');
});
await test('repeated resume events during a forced attempt preserve backoff after failure', async () => {
  let finish, calls = 0;
  const f = queueFixture(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  await f.q.enqueue(payload);
  const running = f.q.drain({ force: true }); await turn();
  const wakes = [f.q.drain({ force: true }), f.q.drain({ force: true })];
  finish({ ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' });
  await Promise.all([running, ...wakes]); await f.q.drain();
  assert.equal(calls, 1); assert.equal((await f.q.list())[0].attempts, 1);
});
await test('a failed recovery after joining a foreground send returns to normal backoff', async () => {
  let finish, calls = 0;
  const failure = { ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' };
  const f = queueFixture(async () => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return failure;
  });
  await f.q.enqueue(payload);
  const foreground = f.q.send(id, { force: true }); await turn();
  const reconnect = f.q.drain({ force: true }); await turn();
  finish(failure); await Promise.all([foreground, reconnect]);
  await f.q.drain(); assert.equal(calls, 2);
  assert.equal((await f.q.list())[0].attempts, 2);
});
await test('forced recovery respects offline state, actor boundaries, expiry and explicit denial', async () => {
  let calls = 0;
  const f = queueFixture(async () => { calls++; return { ok: false, error: 'DEVICE_NOT_APPROVED' }; });
  await f.q.enqueue(payload); f.setOnline(false);
  await f.q.drain({ force: true }); assert.equal(calls, 0);
  f.setOnline(true); f.setActor('33333333-3333-4333-8333-333333333333');
  await f.q.drain({ force: true }); assert.equal(calls, 0);
  f.setActor(actor); await f.q.drain({ force: true });
  await f.q.drain({ force: true }); assert.equal(calls, 1);
  assert.equal((await f.q.list())[0].state, 'blocked');
  const expired = queueFixture(() => assert.fail('expired intent was submitted'));
  await expired.q.enqueue(payload); expired.advance(86400001);
  await expired.q.drain({ force: true });
  assert.equal((await expired.q.list())[0].error, 'DISPATCH_OUTBOX_REVIEW_REQUIRED');
});
await test('shipping outbox runtime distinguishes reconnect from ordinary polling and coalesces browser events', async () => {
  const source = fs.readFileSync('lib/dispatchOutboxRuntime.js', 'utf8');
  const events = new EventTarget(), visibility = new EventTarget(); visibility.hidden = false;
  const timers = new Map(), calls = []; let serial = 0, poll, connected = true;
  const window = Object.assign(events, { setTimeout: fn => { timers.set(++serial, fn); return serial; }, setInterval: fn => { poll = fn; } });
  const context = { window, document: visibility, navigator: { get onLine() { return connected; } }, CustomEvent,
    installed: false, DISPATCH_OUTBOX_KEY: 'queue', DISPATCH_OUTBOX_ITEM_PREFIX: 'item:', changed: () => {},
    getDispatchOutbox: () => ({ drain: async options => { calls.push(options); } }),
  };
  vm.runInNewContext(source.slice(source.indexOf('export function wakeDispatchOutbox')).replaceAll('export function ', 'function ') + '\ninstallDispatchOutbox();', context);
  assert.equal(calls.length, 1); assert.equal(calls[0].force, false);
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  events.dispatchEvent(new Event('online'));
  events.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(timers.size, 1);
  for (const fn of timers.values()) fn(); timers.clear();
  assert.equal(calls.length, 2); assert.equal(calls[1].force, true);
  poll(); events.dispatchEvent(new Event('focus'));
  assert.equal(calls[2].force, false); assert.equal(calls[3].force, false);
  connected = false; events.dispatchEvent(new Event('online')); assert.equal(timers.size, 0);
});

// Execute the shipping component's launch/resume effect without a real service
// worker or network. Browser events and completion results drive its behavior.
async function swFixture({ online = true, check = async () => true } = {}) {
  const source = fs.readFileSync('components/ServiceWorkerRegister.jsx', 'utf8');
  const begin = source.indexOf('    const readNavigationType =');
  const end = source.indexOf('    const startManualFallback =', begin);
  assert(begin > 0 && end > begin);
  const events = new EventTarget(), visibility = new EventTarget(); visibility.visibilityState = 'visible'; visibility.hidden = false;
  const timers = new Map(), saved = new Map(); let serial = 0, connected = online, calls = 0;
  const cleanup = { current: null };
  const window = Object.assign(events, {
    location: { search: '' },
    sessionStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    setTimeout: (fn, delay) => { timers.set(++serial, { fn, delay }); return serial; },
    clearTimeout: key => timers.delete(key),
  });
  const context = { window, document: visibility, navigator: { get onLine() { return connected; } },
    performance: { getEntriesByType: () => [] }, Date, URLSearchParams,
    cancelledRef: { current: false }, APP_VERSION: 'synthetic-build', RESUME_UPDATE_CHECK_INTERVAL_MS: 60000,
    CLEAN_LAUNCH_UPDATE_CHECK_DELAY_MS: 1400, cleanupCleanLaunchUpdateCheckRef: cleanup,
    clearCleanLaunchUpdateCheck: () => cleanup.current?.(), shouldSkipUpdateChecksForSafeMode: () => false,
    safeModeLeftMs: () => 0, logSwEvent: () => {}, registrationRef: { current: {} }, updateSWRef: { current: null },
    checkForUpdate: async () => { calls++; return check(calls); },
  };
  if (fs.existsSync('lib/serviceWorkerUpdateRecovery.js')) {
    Object.assign(context, await import('../lib/serviceWorkerUpdateRecovery.js'));
  }
  vm.runInNewContext(source.slice(begin, end) + '\ninstallCleanLaunchUpdateCheck("synthetic", "/vite-sw.js");', context);
  return { events, visibility, timers, saved, get calls() { return calls; },
    connect(value) { connected = value; events.dispatchEvent(new Event(value ? 'online' : 'offline')); },
    async tick() { const entry = timers.entries().next().value; assert(entry, 'expected scheduled retry'); timers.delete(entry[0]); await entry[1].fn(); await turn(); },
    stop() { cleanup.current?.(); },
  };
}
await test('PWA update waits while offline and starts when the connection returns', async () => {
  const f = await swFixture({ online: false });
  try {
    if (f.timers.size) await f.tick();
    assert.equal(f.calls, 0, 'offline launch still fetched the service-worker script');
    f.connect(true); await f.tick(); assert.equal(f.calls, 1);
  } finally { f.stop(); }
});
await test('failed PWA update retries while visible and is not marked as a successful cooldown', async () => {
  const f = await swFixture({ check: async calls => calls > 1 });
  try {
    await f.tick(); assert.equal(f.calls, 1);
    assert.equal(f.saved.size, 0, 'failed update was stamped as completed');
    await f.tick(); assert.equal(f.calls, 2); assert.equal(f.saved.size, 1);
    f.events.dispatchEvent(new Event('pageshow'));
    if (f.timers.size) await f.tick();
    assert.equal(f.calls, 2, 'successful checks retain their cooldown');
  } finally { f.stop(); }
});

await test('PWA events coalesce around an active check and unmount ignores late success', async () => {
  let finish;
  const f = await swFixture({ check: () => new Promise(resolve => { finish = resolve; }) });
  const active = f.tick(); await turn();
  f.events.dispatchEvent(new Event('online')); f.events.dispatchEvent(new Event('pageshow'));
  assert.equal(f.calls, 1); assert.equal(f.timers.size, 0);
  f.stop(); finish(true); await active;
  assert.equal(f.saved.size, 0); assert.equal(f.timers.size, 0);
});
await test('PWA failure backoff is bounded and pauses while hidden', async () => {
  const f = await swFixture({ check: async () => false });
  try {
    await f.tick(); assert.equal([...f.timers.values()][0].delay, 5000);
    f.visibility.hidden = true; f.visibility.visibilityState = 'hidden';
    f.visibility.dispatchEvent(new Event('visibilitychange')); assert.equal(f.timers.size, 0);
    f.visibility.hidden = false; f.visibility.visibilityState = 'visible';
    f.visibility.dispatchEvent(new Event('visibilitychange'));
    await f.tick(); await f.tick(); await f.tick(); await f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.saved.size, 0);
    f.connect(false); f.connect(true); assert.equal(f.timers.size, 1);
  } finally { f.stop(); }
});
await test('actual service-worker update reports completion, deduplicates in-flight checks and preserves failure evidence', async () => {
  const source = fs.readFileSync('components/ServiceWorkerRegister.jsx', 'utf8');
  const begin = source.indexOf('const activeUpdateChecks =');
  assert(begin > 0);
  const records = [], navigator = { onLine: true };
  const check = vm.runInNewContext(source.slice(begin, source.indexOf('\nfunction safeApplyViteUpdate', begin)) + '\nsafeUpdateRegistration;', {
    navigator, shouldSkipUpdateChecksForSafeMode: () => false, safeModeLeftMs: () => 0,
    logSwEvent: type => records.push(type), safeMessage: error => error.message,
  });
  let calls = 0, finish;
  const registration = { update: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const a = check(registration, 'launch'), b = check(registration, 'resume');
  await turn(); assert.equal(calls, 1); finish();
  assert.equal(await a, true); assert.equal(await b, true);
  registration.update = () => { throw new Error('synthetic script fetch failed'); };
  assert.equal(await check(registration, 'failure'), false);
  assert(records.includes('vite_pwa_sw_update_check_error'));
  navigator.onLine = false;
  registration.update = () => assert.fail('offline script fetch');
  assert.equal(await check(registration, 'offline'), false);
});

console.log(`${passed} passed, ${failed} failed: reconnect recovery v1`);
process.exitCode = failed ? 1 : 0;
