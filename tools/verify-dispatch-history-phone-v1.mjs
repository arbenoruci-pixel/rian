import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { authenticateDispatchOrderActor, inspectDispatchTransportPhoneServer, DispatchOrderServerError } from '../lib/transport/dispatchOrderServer.js';
import { normalizeTransportPhoneKey, isValidTransportPhoneDigits } from '../lib/transport/phone.js';

const actor = { id: '22222222-2222-4222-8222-222222222222', pin: '999999', role: 'DISPATCH', name: 'TEST DISPATCH', is_active: true };
const clientId = '33333333-3333-4333-8333-333333333333';
const historyId = '44444444-4444-4444-8444-444444444444';
const phone = '+38344999001';
const candidate = { id: null, row_id: historyId, source: 'transport_orders', tcode: 'T257', client_tcode: 'T257',
  code_str: 'T257', name: 'SYNTHETIC HISTORY', phone, phone_digits: '38344999001', address: 'TEST ADDRESS' };
const source = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const normalizer = source.slice(source.indexOf('function normalizeTransportClientCandidate('), source.indexOf('export async function findTransportClientByPhoneOnly('));
const inspectClient = source.slice(source.indexOf('export async function inspectDispatchTransportPhoneViaApi('), source.indexOf('export async function editDispatchTransportClientViaApi(')).replace('export ', '');
const api = fs.readFileSync('api/transport/order.js', 'utf8');
const apiFunctions = api.slice(api.indexOf('function setPrivateNoStore(')).replace('export default ', '');
let scenarios = 0;

// Run the production approved-device API handler and server inspection, then
// feed its actual response into the production browser client/normalizer.
function harness(payload, { approved = true, role = 'DISPATCH', rpcError = null } = {}) {
  let rpcCalls = 0;
  const db = {
    rpc: async (name, args) => {
      rpcCalls++;
      assert.equal(name, 'inspect_dispatch_transport_phone');
      assert.equal(normalizeTransportPhoneKey(args.p_phone), '44999001');
      return { data: payload, error: rpcError };
    },
    from: table => ({
      select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: table === 'tepiha_user_devices' ? { user_id: actor.id, is_approved: approved } : { ...actor, role }, error: null }),
    }),
  };
  const apiContext = vm.createContext({
    Buffer, URL, console: { info() {}, error() {} }, DispatchOrderServerError,
    authenticateDispatchOrderActor, inspectDispatchTransportPhoneServer,
    createAdminClientOrThrow: () => db, readBody: async req => req.body,
    apiOk: (res, data) => res.status(200).json(data),
    apiFail: (res, error, status) => res.status(status).json({ ok: false, error }),
  });
  vm.runInContext(apiFunctions, apiContext);
  const context = vm.createContext({
    normalizeTransportPhoneKey, isValidTransportPhoneDigits,
    onlyDigits: value => String(value || '').replace(/\D+/g, ''),
    normTCode: value => { const digits = String(value || '').replace(/\D+/g, '').replace(/^0+/, ''); return digits ? `T${digits}` : ''; },
    approvedApiRequest: async (url, body) => {
      assert.equal(url, '/api/transport/order');
      let status, output;
      const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { output = value; } };
      await apiContext.handler({ method: 'POST', headers: { host: 'test.invalid', origin: 'https://test.invalid', 'content-type': 'application/json', cookie: 'tepiha_device_id=synthetic-device' }, body }, res);
      if (status !== 200) throw Object.assign(new Error(output.error), { code: output.error, httpStatus: status });
      return output;
    },
  });
  vm.runInContext(normalizer + '\n' + inspectClient, context);
  return { context, run: value => context.inspectDispatchTransportPhoneViaApi(value || phone), calls: () => rpcCalls };
}

for (const variant of ['+383 44 999 001', '044999001', '00383 44 999 001']) {
  const h = harness({ status: 'FOUND', source_mode: 'ORDER_HISTORY', candidate, active_order: null });
  const result = await h.run(variant);
  assert.equal(result.client.id, null);
  assert.equal(result.client.row_id, historyId);
  assert.equal(result.client.tcode, 'T257');
  assert.equal(result.client.name, 'SYNTHETIC HISTORY');
  assert.equal(result.client.address, 'TEST ADDRESS');
  assert.equal(result.activeOrder, null);
  assert.equal(h.calls(), 1);
  scenarios++;
}
for (const sourceKind of ['transport_orders', 'transport_clients']) {
  const h = harness({ status: 'FOUND', candidate: { ...candidate, id: clientId, source: sourceKind } });
  const result = await h.run();
  assert.equal(result.client.id, clientId);
  if (sourceKind === 'transport_orders') assert.equal(result.client.row_id, historyId);
  scenarios++;
}
{
  const h = harness({ status: 'NOT_FOUND', candidate: null });
  const result = await h.run();
  assert.equal(result.client, null);
  scenarios++;
}
for (const bad of [
  { ...candidate, phone_digits: '38344999888' },
  { ...candidate, source: 'transport_clients' },
  { ...candidate, row_id: null },
  { ...candidate, row_id: 'not-an-order-id' },
  { ...candidate, id: 'not-a-client-id' },
  { ...candidate, tcode: '', client_tcode: '', code_str: '' },
]) {
  const h = harness({ status: 'FOUND', candidate: bad });
  await assert.rejects(h.run(), error => error.code === 'DISPATCH_PHONE_CHECK_CLIENT_MISMATCH');
  scenarios++;
}
for (const payload of [{ status: 'FOUND', candidate: null }, { status: 'NOT_FOUND', candidate }, { status: 'GARBAGE', candidate }]) {
  await assert.rejects(harness(payload).run(), error => error.code === 'DISPATCH_PHONE_CHECK_INVALID_RESPONSE');
  scenarios++;
}
{
  await assert.rejects(harness({ status: 'CONFLICT', candidate }).run(), error => error.code === 'TRANSPORT_PHONE_IDENTITY_CONFLICT');
  scenarios++;
}
for (const config of [{ approved: false }, { role: 'PUNTOR' }]) {
  const h = harness({ status: 'FOUND', candidate }, config);
  await assert.rejects(h.run(), error => error.httpStatus === 403);
  assert.equal(h.calls(), 0);
  scenarios++;
}
{
  const h = harness(null, { rpcError: { message: 'unavailable' } });
  await assert.rejects(h.run(), error => error.code === 'DISPATCH_PHONE_CHECK_FAILED' && error.httpStatus === 503);
  scenarios++;
}
// A raw order's UUID must never be used for client notes. The projected RPC
// candidate has a separate, explicitly nullable client ID.
{
  const h = harness(null);
  const raw = h.context.normalizeTransportClientCandidate({ id: historyId, client_id: null, client_phone: phone, client_tcode: 'T257', data: {} }, 'transport_orders');
  assert.equal(raw.id, null);
  assert.equal(raw.row_id, historyId);
  const linked = h.context.normalizeTransportClientCandidate({ id: historyId, client_id: clientId, client_phone: phone, client_tcode: 'T257' }, 'transport_orders');
  assert.equal(linked.id, clientId);
  scenarios++;
}
const page = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
assert.match(page, /phoneHit.id \? <CustomerCare/);
assert.match(page, /const canCreateNewDispatchOrder = canSend;/);
const migration = fs.readFileSync('supabase/migrations/20260911210000_dispatch_history_phone_v1.sql', 'utf8');
assert.match(migration, /if v_caller_role=''service_role'' then/);
assert.match(migration, /TRANSPORT_CREATE_CHANGED_SINCE_HISTORY_REVIEW/);
console.log(`PASS ${scenarios} Dispatch history phone scenarios through actual API/auth/server/browser code: orphan history, master identity, phone variants, malformed results, conflict, access denial, and raw-order identity.`);
