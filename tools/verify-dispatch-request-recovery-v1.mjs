import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchJsonWithDeadline, withDeadline } from '../lib/boundedRequest.js';

const source = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const start = source.indexOf('async function insertAtomicDispatchOrderViaApi(');
const end = source.indexOf('\nasync function insertAtomicTransportSelfEntryViaApi(', start);
assert(start > 0 && end > start);
const createSource = source.slice(start, end);
const approvedSource = fs.readFileSync('lib/approvedApiRequest.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function');
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const expected = { id: '11111111-1111-4111-8111-111111111111' };
const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { id: expected.id } }) });
let repairs = 0, calls = [], reconcileRow = null;
const repair = async () => { repairs++; return { ok: true }; };
const create = new Function('fetchJsonWithDeadline', 'withDeadline', 'ensureApprovedDeviceSession', 'reconcileAtomicDispatchOrder', 'assertAtomicTransportOrder', 'assertDeduplicatedActiveDispatchOrder', `${createSource}\nreturn insertAtomicDispatchOrderViaApi;`)(
  (url, init) => fetchJsonWithDeadline(url, init, 20),
  (work) => withDeadline(work, 20), repair, async () => reconcileRow,
  (row, wanted) => assert.equal(row.id, wanted.id), (row) => assert(row.id),
);
const approved = new Function('fetchJsonWithDeadline', 'ensureApprovedDeviceSession', `${approvedSource}\nreturn approvedApiRequest;`)(
  (url, init) => fetchJsonWithDeadline(url, init, 20), repair,
);
try {
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); if (calls.length === 1) throw new TypeError('network lost'); return ok(); };
  assert.equal((await create({ id: expected.id }, expected)).ok, true);
  assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
  calls = []; reconcileRow = { id: expected.id };
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); return { json: () => new Promise(() => {}) }; };
  assert.equal((await create({ id: expected.id }, expected)).reconciledAfterTimeout, true);
  assert.equal(calls.length, 1, 'response loss reconciles without another write');
  reconcileRow = null; calls = []; repairs = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); return calls.length === 1 ? { ok: false, status: 401, json: async () => ({ error: 'AUTH_REQUIRED' }) } : ok(); };
  assert.equal((await create({ id: expected.id }, expected)).ok, true); assert.equal(repairs, 1); assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
  calls = []; repairs = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); return { ok: false, status: 403, json: async () => ({ error: 'DEVICE_NOT_APPROVED' }) }; };
  assert.equal((await create({ id: expected.id }, expected)).ok, false); assert.equal(calls.length, 1); assert.equal(repairs, 0);
  await assert.rejects(approved('/api/client-profile', { action: 'ADD_CUSTOMER_FEEDBACK' }), /DEVICE_NOT_APPROVED/); assert.equal(repairs, 0);
  calls = []; repairs = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); return calls.length === 1 ? { ok: false, status: 401, json: async () => ({ error: 'AUTH_REQUIRED' }) } : ok(); };
  assert.equal((await approved('/api/client-profile', { id: expected.id })).ok, true); assert.equal(repairs, 1); assert.equal(calls[0].body, calls[1].body);
} finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
console.log('PASS Dispatch request recovery: network retry reuses UUID, lost body reconciles, missing cookie repairs once, explicit 403 stays denied, feedback retry retains its exact payload.');
