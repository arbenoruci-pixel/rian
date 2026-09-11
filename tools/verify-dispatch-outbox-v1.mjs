import assert from 'node:assert/strict';
import { createDispatchOutbox, DISPATCH_OUTBOX_KEY, isRetryableDispatchFailure } from '../lib/dispatchOutbox.js';
import { createDispatchTransportOrderServer } from '../lib/transport/dispatchOrderServer.js';

const actor = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const id = '11111111-1111-4111-8111-111111111111';
const payload = { id, client_name: 'TEST ONLY', client_phone: '+38344123456', data: { note: 'Original', pickup_date: '2026-09-11' } };
function memory() { const map = new Map(); return { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, value) }; }
function setup(options = {}) {
  const state = { time: 1000, actor, online: true, calls: [], committed: 0 };
  const storage = options.storage || memory();
  const args = { storage, getActorId: () => state.actor, online: () => state.online, now: () => state.time,
    submit: async (body) => { state.calls.push(body); return { ok: true, data: { id: body.id, client_tcode: 'T123' } }; },
    onCommitted: () => state.committed++, ...options };
  return { state, storage, args, queue: createDispatchOutbox(args) };
}

// Offline submit survives reload with exact original customer, schedule, note and UUID.
{
  const { queue, state, args, storage } = setup(); state.online = false;
  const input = structuredClone(payload); queue.enqueue(input); input.data.note = 'Changed outside queue';
  await queue.drain(); assert.equal(state.calls.length, 0);
  const restored = createDispatchOutbox(args);
  assert.equal(restored.list()[0].payload.data.note, 'Original');
  assert.equal(restored.enqueue({ ...payload, id: otherActor, data: { note: 'Changed form' } }).id, id);
  state.online = true; await restored.drain();
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].expected_actor_id, actor);
  assert.equal(state.calls[0].data.note, 'Original');
  assert.equal(restored.list()[0].state, 'sent');
  assert.equal(JSON.parse(storage.getItem(DISPATCH_OUTBOX_KEY)).items[0].payload, null);
}

// Repeated failures are retried by the runtime, never by clicking/creating another UUID.
{
  let attempts = 0; const bodies = [];
  const { queue, state } = setup({ submit: async (body) => { bodies.push(JSON.stringify(body)); attempts++;
    return attempts <= 5 ? { ok: false, error: 'DISPATCH_ORDER_API_NETWORK_FAILED' } : { ok: true, data: { id, code_str: 'T1' } }; } });
  queue.enqueue(payload);
  for (let n = 0; n < 6; n++) { await queue.drain(); state.time += 30001; }
  assert.equal(queue.list()[0].state, 'sent'); assert.equal(new Set(bodies).size, 1); assert.equal(state.committed, 1);
}

// A committed write whose response was lost is replayed under the same key.
{
  const database = new Map(); let inserts = 0;
  const { queue, state } = setup({ submit: async (body) => {
    if (!database.has(body.id)) { database.set(body.id, body); inserts++; return { ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' }; }
    return { ok: true, data: { id: body.id, client_tcode: 'T55' }, idempotent: true };
  } });
  queue.enqueue(payload); await queue.drain(); state.time += 30000; await queue.drain();
  assert.equal(inserts, 1); assert.equal(queue.list()[0].state, 'sent');
}

// Concurrent drains are serialized; separate tabs preserve the same request.
{
  let release; let calls = 0;
  const { queue, args } = setup({ submit: async () => { calls++; await new Promise((resolve) => { release = resolve; }); return { ok: true, data: { id, code_str: 'T1' } }; } });
  queue.enqueue(payload); const first = queue.drain(); const second = queue.drain();
  await Promise.resolve();
  assert.equal(calls, 1); release(); await Promise.all([first, second]);
  assert.equal(createDispatchOutbox(args).list()[0].state, 'sent');
}

// Another login cannot view or send pending work; server checks the expected actor too.
{
  const { queue, state } = setup(); queue.enqueue(payload); state.actor = otherActor;
  assert.throws(() => queue.enqueue({ ...payload, expected_actor_id: actor }), /ACTOR_SESSION_MISMATCH/);
  assert.equal(queue.list().length, 0); await queue.drain(); assert.equal(state.calls.length, 0);
  await assert.rejects(createDispatchTransportOrderServer({ ...payload, expected_actor_id: actor }, {
    authUser: { id: otherActor, pin: '1234', role: 'DISPATCH' }, supabase: { from() { assert.fail('must reject before DB access'); } },
  }), /ACTOR_SESSION_MISMATCH/);
  state.actor = actor; await queue.drain(); assert.equal(state.calls.length, 1);
}

// Explicit denial/conflict/invalid data stays visible and never auto-retries.
for (const error of ['DEVICE_NOT_APPROVED', 'AUTH_REQUIRED', 'DISPATCH_ORDER_ACTOR_SESSION_MISMATCH', 'TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT', 'TRANSPORT_PHONE_INVALID']) {
  let calls = 0; const { queue, state } = setup({ submit: async () => { calls++; return { ok: false, error }; } });
  queue.enqueue(payload); await queue.drain(); state.time += 60000; await queue.drain();
  assert.equal(calls, 1); assert.equal(queue.list()[0].state, 'blocked'); assert.equal(queue.list()[0].error, error);
}
assert(isRetryableDispatchFailure({ error: 'DISPATCH_ORDER_API_HTTP_429', httpStatus: 429 }));
assert(!isRetryableDispatchFailure({ error: 'DEVICE_NOT_APPROVED', httpStatus: 503 }));

// No network call or false saved acknowledgement when persistence is unavailable/corrupt.
for (const storage of [
  { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } },
  { getItem: () => '{broken', setItem() { assert.fail('corrupt queue must not be overwritten'); } },
]) {
  const { queue, state } = setup({ storage }); assert.throws(() => queue.enqueue(payload)); assert.equal(state.calls.length, 0);
}

// Old pending work remains recoverable; explicit review reuses its frozen UUID/payload.
{
  const { queue, state } = setup(); queue.enqueue(payload); state.time += 25 * 60 * 60 * 1000;
  await queue.drain(); assert.equal(state.calls.length, 0); assert.equal(queue.list()[0].state, 'blocked');
  queue.retry(id); await queue.drain(); assert.equal(state.calls[0].id, id);
}
console.log('PASS durable Dispatch: offline/reload, frozen payload, repeated failures, lost response, concurrency, actor isolation, auth denial, storage failure and overdue review.');
