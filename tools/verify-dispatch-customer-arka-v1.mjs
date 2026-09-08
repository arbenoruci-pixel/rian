import assert from 'node:assert/strict';
import fs from 'node:fs';
import './verify-dispatch-request-recovery-v1.mjs';
import { buildDispatchEdit, editDispatchOrderServer } from '../lib/transport/dispatchEditServer.js';
import { customerCareServer, normalizeCustomerFeedback } from '../lib/customerCareServer.js';
import { isPersonalArkaMode } from '../lib/arkaPersonalMode.js';
import { fetchJsonWithDeadline, withDeadline } from '../lib/boundedRequest.js';
import { fixtureActor as actor, fixtureDriver as driver, fixtureClient as client, fixtureOrder as order, fixtureDatabase } from './customer-care-fixtures.mjs';

const input = { orderId: order.id, expectedUpdatedAt: order.updated_at, name: 'Emër i korrigjuar', address: 'Adresë Test', note: 'Telefononi para marrjes', driverId: null, changeAssignment: false };
const ownership = ['transport_id', 'transport_user_id', 'assigned_driver_id', 'transport_name', 'driver_name', 'transport_pin', 'driver_pin', 'assigned_at', 'worker_pin', 'rack', 'payment_intent'];
for (const status of ['assigned', 'accepted', 'pickup', 'pastrim', 'gati', 'loaded', 'delivery']) {
  const row = structuredClone(order); row.status = row.data.status = status;
  const patch = buildDispatchEdit(row, input, actor);
  assert.equal(patch.status, status); assert.equal(patch.data.status, status);
  for (const field of ownership) assert.deepEqual(patch.data[field], row.data[field], `${status}: ${field} preserved without driver list`);
  assert.equal(patch.data.client.tcode, 'T99998');
}
assert.throws(() => buildDispatchEdit(order, { ...input, expectedUpdatedAt: 'stale' }, actor), /DISPATCH_EDIT_CONFLICT/);
assert.throws(() => buildDispatchEdit(order, input, driver), /ACTOR_NOT_ALLOWED/);
assert.throws(() => buildDispatchEdit({ ...order, status: 'delivered' }, input, actor), /ORDER_CLOSED/);
const measured = buildDispatchEdit(order, { ...input, measurements: { tepiha: [{ ...order.data.tepiha[0], m2: 6, qty: 2 }], staza: [], shkallore: { qty: 0, per: .3 } } }, actor);
assert.equal(measured.data.pay.euro, 21.6); assert.equal(measured.data.pay.m2, 12); assert.equal(measured.data.pieces, 2);
assert.equal(measured.data.tepiha[0].photoUrl, '/sample-photo.jpg'); assert.equal(measured.data.pay.paid, 0); assert.equal(measured.status, 'pastrim');
const legacy = structuredClone(order);
legacy.data.tepihaRows = legacy.data.tepiha; delete legacy.data.tepiha;
legacy.data.price_total = legacy.data.totalEuro = 10.44;
legacy.data.total_m2 = 5.8;
legacy.data.totals = { grandTotal: 10.44, m2_total: 5.8 };
const legacyEdit = buildDispatchEdit(legacy, { ...input, measurements: { tepiha: [{ id: 'carpet1', m2: 6, qty: 2 }] } }, actor);
assert.equal(legacyEdit.data.tepihaRows[0].photoUrl, '/sample-photo.jpg');
assert.equal(legacyEdit.data.tepihaRows[0].m2, 6);
assert.equal(legacyEdit.data.price_total, 21.6); assert.equal(legacyEdit.data.totalEuro, 21.6);
assert.equal(legacyEdit.data.total_m2, 12); assert.deepEqual(legacyEdit.data.totals, { grandTotal: 21.6, m2_total: 12, m2: 12, pieces: 2, total: 21.6, euro: 21.6 });
const paid = structuredClone(order); paid.data.pay.arkaRecordedPaid = 5;
assert.throws(() => buildDispatchEdit(paid, { ...input, measurements: {} }, actor), /PAID_MEASUREMENTS/);
assert.equal(buildDispatchEdit(paid, input, actor).data.pay.arkaRecordedPaid, 5);
const assigned = buildDispatchEdit({ ...order, status: 'inbox' }, { ...input, changeAssignment: true, driverId: driver.id }, actor, driver);
assert.equal(assigned.status, 'assigned'); assert.equal(assigned.data.transport_id, driver.id); assert.equal(assigned.data.assigned_driver_pin, driver.pin);
assert.equal(buildDispatchEdit(order, { ...input, changeAssignment: true, driverId: driver.id }, actor, driver).status, 'pastrim');
assert.throws(() => buildDispatchEdit(order, { ...input, changeAssignment: true, driverId: driver.id }, actor, { ...driver, is_active: false }), /DRIVER_INVALID/);
const db = fixtureDatabase();
assert.equal((await editDispatchOrderServer(input, { supabase: db, authUser: actor })).order.status, 'pastrim');
const conflictDb = fixtureDatabase(); conflictDb.conflict = true;
await assert.rejects(editDispatchOrderServer(input, { supabase: conflictDb, authUser: actor }), /DISPATCH_EDIT_CONFLICT/);
assert.equal(conflictDb.tables.transport_clients[0].name, client.name);
const ledgerPaidDb = fixtureDatabase();
ledgerPaidDb.rpc = async () => ({ error: { message: 'DISPATCH_EDIT_PAID_MEASUREMENTS' } });
await assert.rejects(editDispatchOrderServer(input, { supabase: ledgerPaidDb, authUser: actor }), /DISPATCH_EDIT_PAID_MEASUREMENTS/);

const careDb = fixtureDatabase();
const feedback = { action: 'ADD_CUSTOMER_FEEDBACK', id: '55555555-5555-4555-8555-555555555555', orderId: order.id, rating: 2, note: 'Nuk ishte në adresë.', issue: 'NO_SHOW' };
const context = { supabase: careDb, authUser: driver };
await customerCareServer(feedback, context);
assert.equal((await customerCareServer(feedback, context)).duplicate, true);
assert.equal(careDb.tables.transport_customer_feedback.length, 1);
await assert.rejects(customerCareServer({ ...feedback, note: 'different' }, context), /RETRY_CONFLICT/);
await assert.rejects(customerCareServer({ ...feedback, noPickup: true }, context), /FLAG_NOT_ALLOWED/);
await assert.rejects(customerCareServer({ ...feedback, clientId: driver.id }, context), /IDENTITY_CONFLICT/);
await assert.rejects(customerCareServer(feedback, { ...context, authUser: { ...driver, id: actor.id } }), /NOT_ASSIGNED/);
await assert.rejects(customerCareServer({ action: 'GET_CUSTOMER_CARE', clientId: client.id }, context), /ORDER_REQUIRED/);
assert.throws(() => normalizeCustomerFeedback({ ...feedback, rating: 6 }, { clientId: client.id, actor, canManage: true }), /RATING_INVALID/);
await customerCareServer({ ...feedback, id: '66666666-6666-4666-8666-666666666666', noPickup: true }, { ...context, authUser: actor });
let care = await customerCareServer({ action: 'GET_CUSTOMER_CARE', clientId: client.id }, { ...context, authUser: actor });
assert.equal(care.flag.no_pickup, true); assert.equal(care.entries.length, 2);
await customerCareServer({ ...feedback, id: '77777777-7777-4777-8777-777777777777', noPickup: false }, { ...context, authUser: actor });
care = await customerCareServer({ action: 'GET_CUSTOMER_CARE', orderId: order.id }, context);
assert.equal(care.flag.no_pickup, false); assert.equal(care.entries.length, 3);
// History follows the permanent client into a newer visit.
careDb.tables.transport_orders.push({ ...order, id: '88888888-8888-4888-8888-888888888888' });
assert.equal((await customerCareServer({ action: 'GET_CUSTOMER_CARE', orderId: careDb.tables.transport_orders[1].id }, context)).entries.length, 3);
for (const role of ['MASTER', 'MASTER_USER', 'ADMIN_MASTER', 'DISPATCH']) {
  assert.equal(isPersonalArkaMode({ pin: '9000', role }, '?personal=1'), true);
  assert.equal(isPersonalArkaMode({ pin: '9000', role }, ''), false);
}
assert.equal(isPersonalArkaMode({ role: 'DISPATCH' }, '?personal=1'), false);
assert.equal(isPersonalArkaMode({ pin: '9001', role: 'TRANSPORT' }, '?personal=1'), false);

const originalFetch = globalThis.fetch;
try {
  let signal;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return { json: () => new Promise(() => {}) }; };
  await assert.rejects(fetchJsonWithDeadline('/fixture', {}, 20), /REQUEST_TIMEOUT/);
  assert.equal(signal.aborted, true, 'stalled response body aborts');
  await assert.rejects(withDeadline(() => new Promise(() => {}), 20, 'LIST_TIMEOUT'), /LIST_TIMEOUT/);
} finally { globalThis.fetch = originalFetch; }
const page = fs.readFileSync('app/arka/page.jsx', 'utf8');
assert(page.includes("key={search.get('personal') === '1' ? 'personal' : 'manager'}"), 'switching accounts remounts loaders');
assert(!page.includes('actorIsWorkerAccount(act) && !roleCanManage(act?.role)'), 'all personal loaders use the same mode');
assert(page.includes('ARKA IME · DORËZO PARATË'));
const payPage = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
assert(payPage.includes('ledgerResult?.paymentVerified !== true'));
assert(payPage.includes('setPaymentFeedback({ orderId: oid, returnToBoard: true })'));
console.log('PASS Dispatch/customer/Arka: lifecycle and ownership preservation, measures and paid guard, stale edits, verified actor scopes, repeat-client history, idempotent feedback, personal cash modes, full-response deadlines.');
