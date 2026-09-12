import assert from 'node:assert/strict';
import fs from 'node:fs';
import { watchDispatchPhoneCheck, isRecoverableDispatchPhoneCheck } from '../lib/dispatchPhoneCheck.js';
import { normalizeTransportPhoneKey, isValidTransportPhoneDigits } from '../lib/transport/phone.js';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const failure = code => Object.assign(new Error(code), { code });
function fixture(inspect) {
  const events = new EventTarget(), visibility = new EventTarget(); visibility.hidden = false;
  let connected = true, calls = 0, index = 0;
  const timers = new Map(), results = [], errors = [], busy = [];
  const stop = watchDispatchPhoneCheck({ events, visibility, online: () => connected,
    inspect: () => { calls++; return inspect(calls); },
    onResult: value => results.push(value), onError: error => errors.push(error), onBusy: value => busy.push(value),
    setTimer: (run, delay) => { const id = ++index; timers.set(id, { run, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { events, visibility, timers, results, errors, busy, stop,
    get calls() { return calls; }, connect(value) { connected = value; },
    async tick() { const next = timers.entries().next().value; assert(next, 'expected scheduled lookup'); timers.delete(next[0]); await next[1].run(); },
  };
}
await test('temporary iPhone Load failed recovers without another tap', async () => {
  const f = fixture(async n => { if (n === 1) throw failure('DISPATCH_PHONE_CHECK_NETWORK_FAILED'); return { client: { tcode: 'T101' } }; });
  await f.tick(); assert.equal(f.errors.length, 1); await f.tick();
  assert.equal(f.results[0].client.tcode, 'T101'); assert.equal(f.calls, 2); assert.equal(f.timers.size, 0); f.stop();
});
await test('failed pre-check backs off and resumes when connection returns', async () => {
  const f = fixture(async n => { if (n <= 3) throw failure('DISPATCH_PHONE_CHECK_TIMEOUT'); return { client: null }; });
  await f.tick(); await f.tick(); await f.tick(); assert.equal(f.calls, 3); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 15000);
  f.events.dispatchEvent(new Event('online')); f.events.dispatchEvent(new Event('focus'));
  assert.equal(f.timers.size, 1); await f.tick(); assert.equal(f.calls, 4); assert.equal(f.results.length, 1); f.stop();
});
await test('offline form waits and checks the phone when it becomes online', async () => {
  const f = fixture(async () => ({ client: null })); f.connect(false); await f.tick();
  assert.equal(f.calls, 0); f.connect(true); f.events.dispatchEvent(new Event('online'));
  await f.tick(); assert.equal(f.results.length, 1); f.stop();
});
await test('suspended form waits for visibility before recovering', async () => {
  const f = fixture(async () => ({ client: null })); f.visibility.hidden = true; await f.tick();
  assert.equal(f.calls, 0); f.visibility.hidden = false; f.visibility.dispatchEvent(new Event('visibilitychange'));
  await f.tick(); assert.equal(f.results.length, 1); f.stop();
});
await test('hard device and identity denials never auto-retry', async () => {
  for (const code of ['DEVICE_NOT_APPROVED', 'AUTH_REQUIRED', 'DISPATCH_PHONE_CHECK_CLIENT_MISMATCH', 'TRANSPORT_PHONE_IDENTITY_CONFLICT']) {
    const f = fixture(async () => { throw failure(code); }); await f.tick();
    f.events.dispatchEvent(new Event('online')); assert.equal(f.timers.size, 0); assert.equal(f.calls, 1); f.stop();
  }
});
await test('changing phone/closing form ignores late replies and removes resume listeners', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; })); const pending = f.tick();
  await Promise.resolve(); await Promise.resolve();
  f.stop(); resolve({ client: { name: 'OLD PHONE' } }); await pending;
  assert.equal(f.results.length, 0); assert.deepEqual(f.busy, [true]);
  f.events.dispatchEvent(new Event('online')); assert.equal(f.timers.size, 0);
});
await test('closing a failed form cancels its scheduled retry', async () => {
  const f = fixture(async () => { throw failure('DISPATCH_PHONE_CHECK_TIMEOUT'); }); await f.tick(); f.stop();
  f.events.dispatchEvent(new Event('focus')); assert.equal(f.timers.size, 0); assert.equal(f.calls, 1);
});
await test('HTTP gateway failures retry while auth/identity failures stay explicit', async () => {
  const source = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
  const inspect = source.slice(source.indexOf('export async function inspectDispatchTransportPhoneViaApi('), source.indexOf('export async function editDispatchTransportClientViaApi(')).replace('export ', '');
  for (const [status, code, expected, recoverable] of [
    [503, 'REQUEST_FAILED', 'DISPATCH_PHONE_CHECK_HTTP_503', true],
    [429, 'REQUEST_FAILED', 'DISPATCH_PHONE_CHECK_HTTP_429', true],
    [403, 'DEVICE_NOT_APPROVED', 'DEVICE_NOT_APPROVED', false],
    [409, 'TRANSPORT_PHONE_IDENTITY_CONFLICT', 'TRANSPORT_PHONE_IDENTITY_CONFLICT', false],
  ]) {
    const run = new Function('approvedApiRequest', 'normalizeTransportPhoneKey', 'isValidTransportPhoneDigits', `${inspect}; return inspectDispatchTransportPhoneViaApi;`)(
      async () => { throw Object.assign(failure(code), { httpStatus: status }); }, normalizeTransportPhoneKey, isValidTransportPhoneDigits);
    await assert.rejects(run('+38344999001'), error => error.code === expected && isRecoverableDispatchPhoneCheck(error) === recoverable);
  }
  const run = new Function('approvedApiRequest', 'normalizeTransportPhoneKey', 'isValidTransportPhoneDigits', `${inspect}; return inspectDispatchTransportPhoneViaApi;`)(
    async () => { throw Object.assign(failure('DEVICE_NOT_APPROVED'), { status: 403 }); }, normalizeTransportPhoneKey, isValidTransportPhoneDigits);
  await assert.rejects(run('+38344999001'), /DEVICE_NOT_APPROVED/);
});
console.log(`${passed} passed: Dispatch resume/retry`);
