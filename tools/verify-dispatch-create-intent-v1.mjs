import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCH_CREATE_INTENT_STORAGE_KEY,
  buildDispatchCreateIntentSignature,
  createDispatchCreateIntentJournal,
  recoverDispatchCreatePhoneConflict,
} from '../lib/dispatchCreateIntent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

const baseInput = {
  actor: 'dispatch-user-1',
  poolOwner: '2468',
  name: 'Klienti Test',
  phone: '+383 44 123 456',
  address: 'Rruga A',
  note: 'Thirre para ardhjes',
  pickupMeasurements: '5.8, 3.7',
  plannedPieces: 2,
  plannedDate: '2026-08-31',
  slot: 'morning',
  planMode: 'tomorrow',
  driverId: 'driver-1',
};

const formattedPhone = buildDispatchCreateIntentSignature(baseInput);
const digitsPhone = buildDispatchCreateIntentSignature({ ...baseInput, phone: '38344123456' });
assert.equal(formattedPhone, digitsPhone, 'phone formatting must not fork one create intent');
assert.notEqual(
  formattedPhone,
  buildDispatchCreateIntentSignature({ ...baseInput, slot: 'evening' }),
  'a meaningful form change must create a different intent',
);

const storage = new MemoryStorage();
let uuidIndex = 0;
const uuidFactory = () => UUIDS[uuidIndex++];
let nowMs = Date.parse('2026-08-30T20:00:00Z');

const firstJournal = createDispatchCreateIntentJournal({ storage, uuidFactory, now: () => nowMs });
const [firstId, rapidRetryId] = await Promise.all([
  firstJournal.acquire(baseInput),
  firstJournal.acquire(baseInput),
]);
assert.equal(firstId, UUIDS[0]);
assert.equal(rapidRetryId, firstId, 'rapid retries must share one UUID');
assert.equal(uuidIndex, 1, 'rapid retries must allocate only one UUID');
assert.equal(await firstJournal.acquire(baseInput), firstId, 'manual retry must reuse the same UUID');

const restartedJournal = createDispatchCreateIntentJournal({ storage, uuidFactory, now: () => nowMs });
assert.equal(
  await restartedJournal.acquire(baseInput),
  firstId,
  'a reload/lost response must recover the persisted UUID',
);
assert.equal(uuidIndex, 1);

const changedId = await restartedJournal.acquire({ ...baseInput, slot: 'evening' });
assert.equal(
  changedId,
  firstId,
  'an edited unresolved attempt must keep its UUID until DB commit is reconciled',
);
assert.equal(
  await restartedJournal.acquire({ ...baseInput, note: 'Shënim tjetër' }),
  firstId,
  'a note edit after an unresolved send must retain the UUID',
);
assert.equal(
  await restartedJournal.acquire({ ...baseInput, driverId: 'driver-2' }),
  firstId,
  'a driver edit after an unresolved send must retain the UUID',
);

const persisted = storage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY) || '';
assert.ok(persisted.includes(changedId));
assert.ok(!persisted.includes(baseInput.name));
assert.ok(!persisted.includes(baseInput.phone));
assert.ok(!persisted.includes(baseInput.address), 'intent persistence must not store customer PII');

restartedJournal.clear(changedId);
assert.equal(storage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY), null, 'verified success must clear the intent');
assert.equal(
  await restartedJournal.acquire({ ...baseInput, slot: 'evening' }),
  UUIDS[1],
  'a later, intentional identical order must get a new UUID after success',
);

nowMs += (25 * 60 * 60 * 1000);
const expiredJournal = createDispatchCreateIntentJournal({ storage, uuidFactory, now: () => nowMs });
assert.equal(
  await expiredJournal.acquire({ ...baseInput, slot: 'evening' }),
  UUIDS[2],
  'an abandoned intent must expire',
);

{
  const longTabStorage = new MemoryStorage();
  let longTabNow = Date.parse('2026-08-30T20:00:00Z');
  const longTabIds = [
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ];
  let longTabIndex = 0;
  const longTabJournal = createDispatchCreateIntentJournal({
    storage: longTabStorage,
    now: () => longTabNow,
    uuidFactory: () => longTabIds[longTabIndex++],
  });
  assert.equal(await longTabJournal.acquire(baseInput), longTabIds[0]);
  longTabNow += (25 * 60 * 60 * 1000);
  assert.equal(
    await longTabJournal.acquire(baseInput),
    longTabIds[1],
    'TTL must expire unresolved state in the same long-lived tab',
  );
}

const dispatchSource = fs.readFileSync(path.join(root, 'app/dispatch/page.jsx'), 'utf8');

// Regression: a lost success for customer A must not block customer B, and
// returning to A (even after a reload) must still reconcile A's original UUID.
{
  const phoneStorage = new MemoryStorage();
  let index = 0;
  const options = { storage: phoneStorage, uuidFactory: () => UUIDS[index++] };
  const journal = createDispatchCreateIntentJournal(options);
  const otherPhone = { ...baseInput, phone: '+383 49 999 999' };
  const [a, b] = await Promise.all([journal.acquire(baseInput), journal.acquire(otherPhone)]);
  assert.notEqual(a, b, 'concurrent different phones need separate UUIDs');
  assert.equal(await journal.acquire({ ...baseInput, phone: '044123456', slot: 'evening' }), a);
  const reloaded = createDispatchCreateIntentJournal(options);
  assert.equal(await reloaded.acquire(otherPhone), b);
  assert.equal(await reloaded.acquire(baseInput), a);
  journal.clear(b);
  assert.equal(await createDispatchCreateIntentJournal(options).acquire(baseInput), a,
    'completing B must preserve unresolved A');
  assert.notEqual(await journal.acquire({ ...baseInput, actor: 'another-dispatcher' }), a);
  const raw = phoneStorage.getItem(DISPATCH_CREATE_INTENT_STORAGE_KEY);
  for (const pii of [baseInput.name, '44123456', '49999999', baseInput.address, baseInput.actor]) {
    assert.ok(!raw.includes(pii), 'customer and actor details must stay out of persisted journal');
  }
}

// Upgrade path: old installations persisted a single UUID without phone identity.
{
  const legacyStorage = new MemoryStorage();
  legacyStorage.setItem(DISPATCH_CREATE_INTENT_STORAGE_KEY, JSON.stringify({
    version: 1, orderId: UUIDS[0], signatureHash: 'old', updatedAt: Date.now(),
  }));
  const journal = createDispatchCreateIntentJournal({ storage: legacyStorage, uuidFactory: () => UUIDS[1] });
  assert.equal(await journal.acquire(baseInput), UUIDS[0], 'probe legacy UUID before replacing it');
  let writes = 0;
  const payload = { id: UUIDS[0], client_phone: baseInput.phone,
    data: { order_id: UUIDS[0], public_order_id: UUIDS[0], pickup_slot: 'morning' } };
  const recovered = await recoverDispatchCreatePhoneConflict({
    result: { ok: false, error: 'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT' },
    journal, input: baseInput, payload,
    submit: async (retry) => {
      writes += 1;
      assert.equal(retry.id, UUIDS[1]);
      assert.equal(retry.data.order_id, retry.id);
      assert.equal(retry.data.public_order_id, retry.id);
      assert.equal(retry.client_phone, payload.client_phone);
      assert.equal(retry.data.pickup_slot, 'morning');
      return { ok: false, error: 'DISPATCH_ORDER_API_TIMEOUT' };
    },
  });
  assert.equal(writes, 1, 'phone conflict recovery is bounded to one retry');
  assert.equal(recovered.orderId, UUIDS[1]);
  assert.equal(await createDispatchCreateIntentJournal({ storage: legacyStorage }).acquire(baseInput), UUIDS[1],
    'lost response during recovery must preserve the replacement UUID across reload');
  assert.equal(payload.id, UUIDS[0], 'recovery must not mutate its original payload');
  for (const error of ['DISPATCH_ORDER_API_TIMEOUT', 'DISPATCH_ORDER_API_NETWORK_FAILED',
    'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT', 'TRANSPORT_PHONE_IDENTITY_CONFLICT', 'AUTH_REQUIRED']) {
    const result = { ok: false, error };
    const retry = await recoverDispatchCreatePhoneConflict({ result, journal, input: baseInput,
      payload: { ...payload, id: UUIDS[1] }, submit: () => assert.fail('unsafe retry') });
    assert.equal(retry.result, result);
    assert.equal(retry.orderId, UUIDS[1]);
    assert.equal(await journal.acquire(baseInput), UUIDS[1]);
  }
}

assert.match(dispatchSource, /createDispatchCreateIntentJournal/);
assert.match(dispatchSource, /if \(sendInFlightRef\.current\) return;/);
assert.match(dispatchSource, /const orderId = await createIntentJournalRef\.current\.acquire\(/);
assert.match(dispatchSource, /createIntentJournalRef\.current\?\.clear\(orderId\)/);
assert.ok(!dispatchSource.includes('const orderId = createDispatchOrderUuid()'));

const uuidAcquireIndex = dispatchSource.indexOf('const orderId = await createIntentJournalRef.current.acquire(');
const authoritativeV3 = dispatchSource.includes('DISPATCH_CREATE_SERVER_AUTHORITATIVE_V3');
const firstCreateAuthorityIndex = authoritativeV3
  ? dispatchSource.indexOf('const clientLink = {', uuidAcquireIndex)
  : dispatchSource.indexOf('const clientLink = await prepareDispatchTransportClientLink({', uuidAcquireIndex);
assert.ok(firstCreateAuthorityIndex > uuidAcquireIndex, authoritativeV3
  ? 'stable UUID must be acquired before server-authoritative create payload authority'
  : 'stable UUID must be acquired before T-code reservation');
if (authoritativeV3) {
  assert.match(dispatchSource, /server_atomic_create/);
  assert.ok(!dispatchSource.includes('let submitPhoneCheckDegraded = false;'), 'V3 must not run a second submit-time phone precheck');
}

const sendCatchStart = dispatchSource.indexOf('    } catch (e) {', dispatchSource.indexOf('  async function send()'));
const sendCatchEnd = dispatchSource.indexOf('    } finally {', sendCatchStart);
const sendCatch = dispatchSource.slice(sendCatchStart, sendCatchEnd);
assert.match(sendCatch, /const released = await releaseTransportCodeIfUnused\(pendingReservedTcode, pendingCodeOwner\)/);
assert.match(sendCatch, /if \(released && pendingOrderId\) clearTransportCodeReservationForOrder\(pendingOrderId\)/);
assert.ok(
  !sendCatch.includes('if (pendingOrderId) clearTransportCodeReservationForOrder(pendingOrderId);'),
  'an unconfirmed release must retain the order-to-code retry binding',
);

console.log(authoritativeV3
  ? 'PASS: Dispatch V3 keeps one UUID before server-authoritative create and preserves reconciliation safety.'
  : 'PASS: Dispatch keeps one UUID until reconciliation; completed/expired intents receive fresh UUIDs.');
