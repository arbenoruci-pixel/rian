import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBaseCodeStatusHandler } from '../api/base-codes/status.js';
import {
  BASE_CODE_STATUS_ROLES,
  authenticateBaseCodeStatusActor,
  normalizeBaseCodeStatusCodes,
  readBaseCodeStatuses,
} from '../lib/baseCodeStatusServer.js';
import { fetchJsonWithDeadline } from '../lib/boundedRequest.js';
import { getDeviceId } from '../lib/deviceId.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const deviceId = 'fixture-approved-device';
const lease = '2026-11-22T12:00:00.000Z';
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}, failures = {}) {
  const seed = {
    tepiha_user_devices: [{ user_id: actorId, device_id: deviceId, is_approved: true }],
    users: [{ id: actorId, role: 'PUNTOR', is_active: true }],
    base_code_pool: [
      { code: '1', status: 'available', lease_expires_at: null },
      { code: '2', status: 'reserved', lease_expires_at: lease, reserved_by: 'fixture-pin', draft_session_id: 'fixture-draft', owner_id: 'fixture-owner', lease_token: 'fixture-token' },
      { code: '3', status: 'used', lease_expires_at: null, used_by_pin: 'fixture-pin', used_order_id: 'fixture-order' },
    ],
    ...overrides,
  };
  const calls = [];
  const db = {
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const result = () => failures[table]
        ? { data: null, error: { message: 'database internal details must remain private' } }
        : { data: clone(seed[table] || []).filter((row) => call.filters.every(([column, values]) => values.includes(String(row[column])))) };
      const q = {
        select(columns) { call.columns = columns; return q; },
        eq(column, value) { call.filters.push([column, [String(value)]]); return q; },
        in(column, values) { call.filters.push([column, values.map(String)]); return q; },
        limit(count) { call.limit = count; return q; },
        async maybeSingle() { const r = result(); return { ...r, data: r.data?.[0] || null }; },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return q;
    },
  };
  return { db, calls, seed };
}

async function request({ db, method = 'POST', headers = {}, body = { codes: [1, 2, 3] } } = {}) {
  let createdClients = 0;
  const handler = createBaseCodeStatusHandler({ createClient: () => { createdClients++; return db || fixture().db; } });
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = JSON.parse(value); } };
  await handler({ method, headers: {
    host: 'tepiha.test', origin: 'https://tepiha.test', 'content-type': 'application/json',
    cookie: `tepiha_device_id=${deviceId}`, ...headers,
  }, body }, res);
  return { ...res, createdClients };
}

const base = fixture();
const before = clone(base.seed);
const response = await request({ db: base.db, body: { codes: [1, '2', 2, 3], pin: 'forged', role: 'ADMIN', user_id: 'forged' } });
assert.equal(response.statusCode, 200);
assert.deepEqual(response.body.items, [
  { code: 1, status: 'available', lease_expires_at: null },
  { code: 2, status: 'reserved', lease_expires_at: lease },
  { code: 3, status: 'used', lease_expires_at: null },
]);
assert.deepEqual(base.seed, before, 'status lookup preserves all fixture rows');
assert.equal(base.calls.at(-1).columns, 'code,status,lease_expires_at');
assert.deepEqual(base.calls.at(-1).filters, [['code', ['1', '2', '3']]]);
assert.equal(base.calls.at(-1).limit, 160);
assert.match(response.headers['cache-control'], /private, no-store/);
for (const secret of ['fixture-pin', 'fixture-draft', 'fixture-owner', 'fixture-token', 'fixture-order']) assert(!JSON.stringify(response.body).includes(secret));
console.log('PASS Base code statuses: exact available/reserved/used verdicts, bounded read, no reservation secrets or data writes.');

const withContext = fixture({ base_code_pool: [
  ...base.seed.base_code_pool,
  { code: '4', status: 'reserved', lease_expires_at: lease, reserved_by: 'other-owner-pin', draft_session_id: 'other-draft' },
] });
const shared = await request({ db: withContext.db, body: { codes: [1, 2, 3, 4], draft: { code: 2, draft_session_id: 'fixture-draft' } } });
assert.equal(shared.statusCode, 200);
assert.deepEqual(shared.body.items[1], {
  code: 2, status: 'reserved', lease_expires_at: lease,
  reserved_by: 'fixture-pin', draft_session_id: 'fixture-draft',
});
assert.equal(withContext.calls.at(-1).columns, 'code,status,lease_expires_at,reserved_by,draft_session_id');
for (const item of shared.body.items.filter((row) => row.code !== 2)) {
  assert.deepEqual(Object.keys(item).sort(), ['code', 'lease_expires_at', 'status']);
}
assert(!JSON.stringify(shared.body).includes('other-owner-pin'));
assert(!JSON.stringify(shared.body).includes('fixture-owner'));
assert(!JSON.stringify(shared.body).includes('fixture-token'));
for (const context of [
  { code: 2, draft_session_id: 'wrong-draft' },
  { code: 3, draft_session_id: 'fixture-draft' },
  { code: 1, draft_session_id: 'fixture-draft' },
]) {
  const mismatch = await request({ body: { codes: [1, 2, 3], draft: context } });
  assert.equal(mismatch.statusCode, 200);
  assert.deepEqual(mismatch.body.items, response.body.items);
}
const missingDraft = fixture({ base_code_pool: [{ code: '2', status: 'reserved', lease_expires_at: lease, reserved_by: 'private-pin', draft_session_id: null }] });
const missingDraftResult = await request({ db: missingDraft.db, body: { codes: [2], draft: { code: 2, draft_session_id: 'fixture-draft' } } });
assert.equal(missingDraftResult.statusCode, 200);
assert.deepEqual(Object.keys(missingDraftResult.body.items[0]).sort(), ['code', 'lease_expires_at', 'status']);
console.log('PASS Shared draft ownership: exact known reserved draft can resume its original owner; lists, mismatched codes/sessions and non-reserved rows reveal no owner.');

for (const role of BASE_CODE_STATUS_ROLES) {
  const f = fixture({ users: [{ id: actorId, role, is_active: true }] });
  assert.equal((await request({ db: f.db })).statusCode, 200, role);
}
for (const [overrides, error] of [
  [{ tepiha_user_devices: [] }, 'DEVICE_NOT_APPROVED'],
  [{ tepiha_user_devices: [{ user_id: actorId, device_id: deviceId, is_approved: false }] }, 'DEVICE_NOT_APPROVED'],
  [{ users: [] }, 'AUTH_USER_DISABLED'],
  [{ users: [{ id: actorId, role: 'PUNTOR', is_active: false }] }, 'AUTH_USER_DISABLED'],
  [{ users: [{ id: actorId, role: 'TRANSPORT', is_active: true }] }, 'BASE_CODE_STATUS_FORBIDDEN'],
  [{ users: [{ id: actorId, role: 'UNKNOWN', is_active: true }] }, 'BASE_CODE_STATUS_FORBIDDEN'],
]) {
  const f = fixture(overrides);
  const denied = await request({ db: f.db, body: { codes: [2], role: 'ADMIN', pin: 'forged', user_id: actorId, draft: { code: 2, draft_session_id: 'fixture-draft' } } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, error);
  assert(!f.calls.some((call) => call.table === 'base_code_pool'));
}
const missingCookie = await request({ headers: { cookie: '' }, body: { codes: [1], deviceId, role: 'ADMIN' } });
assert.equal(missingCookie.statusCode, 401);
assert.equal(missingCookie.body.error, 'AUTH_REQUIRED');
assert.equal(missingCookie.createdClients, 0);
await assert.rejects(authenticateBaseCodeStatusActor(base.db, ''), /AUTH_REQUIRED/);
await assert.rejects(readBaseCodeStatuses({ codes: [1] }, { supabase: base.db }), /AUTH_REQUIRED/);
await assert.rejects(readBaseCodeStatuses({ codes: [1] }, { supabase: base.db, authUser: { id: actorId, role: 'TRANSPORT' } }), /BASE_CODE_STATUS_FORBIDDEN/);
console.log('PASS Base code authorization: all base roles work; missing/unapproved devices, disabled users, Transport-only and forged identity stay denied.');

for (const [input, status, error] of [
  [{ method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
  [{ headers: { origin: '' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { origin: 'https://other.test' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { 'content-type': 'text/plain' } }, 415, 'CONTENT_TYPE_NOT_ALLOWED'],
  [{ headers: { 'content-length': '9000' } }, 413, 'BASE_CODE_STATUS_BODY_TOO_LARGE'],
  [{ body: { codes: [1], extra: 'x'.repeat(9000) } }, 413, 'BASE_CODE_STATUS_BODY_TOO_LARGE'],
  [{ body: [] }, 400, 'BASE_CODE_STATUS_BODY_INVALID'],
  [{ headers: { cookie: 'tepiha_device_id=%GG' } }, 401, 'AUTH_REQUIRED'],
]) {
  const denied = await request(input);
  assert.equal(denied.statusCode, status);
  assert.equal(denied.body.error, error);
  assert.equal(denied.createdClients, 0);
}
for (const codes of [null, '1', [0], [-1], [1.5], [true], [{}], ['1e3'], ['+1'], ['1,2'], [Number.MAX_SAFE_INTEGER + 1], Array(161).fill(1)]) {
  const f = fixture();
  const denied = await request({ db: f.db, body: { codes } });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.body.error, 'BASE_CODE_STATUS_CODES_INVALID');
  assert(!f.calls.some((call) => call.table === 'base_code_pool'));
}
for (const draft of [null, false, [], {}, { code: 2 }, { code: 2, draft_session_id: '' }, { code: 2, draft_session_id: ' ' },
  { code: 2, draft_session_id: 123 }, { code: 0, draft_session_id: 'fixture-draft' },
  { code: 3, draft_session_id: 'fixture-draft' }, { code: 2, draft_session_id: 'x'.repeat(513) }]) {
  const f = fixture();
  const denied = await request({ db: f.db, body: { codes: [2], draft } });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.body.error, 'BASE_CODE_STATUS_DRAFT_INVALID');
  assert(!f.calls.some((call) => call.table === 'base_code_pool'));
}
assert.deepEqual(normalizeBaseCodeStatusCodes([1, '001', ' 2 ', Number.MAX_SAFE_INTEGER]), [1, 2, Number.MAX_SAFE_INTEGER]);
assert.equal(normalizeBaseCodeStatusCodes(Array.from({ length: 160 }, (_, i) => i + 1)).length, 160);
const empty = fixture();
assert.deepEqual((await request({ db: empty.db, body: { codes: [] } })).body.items, []);
assert(!empty.calls.some((call) => call.table === 'base_code_pool'));
for (const table of ['tepiha_user_devices', 'users', 'base_code_pool']) {
  const failed = await request({ db: fixture({}, { [table]: true }).db });
  assert.equal(failed.statusCode, 503);
  assert(!JSON.stringify(failed.body).includes('database internal'));
}
console.log('PASS Base code boundary: same-origin JSON only, bounded payload/codes, malformed input rejection, database failures never look like a successful empty pool.');

// Exercise the real browser helper and existing approved-request recovery with
// the real stable-device cookie writer; no online login is needed for a lost cookie.
const approvedSource = fs.readFileSync('lib/approvedApiRequest.js', 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export async function', 'async function');
const clientSource = fs.readFileSync('lib/baseCodeStatusClient.js', 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export async function', 'async function');
let repairs = 0;
const approved = new Function('fetchJsonWithDeadline', 'ensureApprovedDeviceSession', `${approvedSource}\nreturn approvedApiRequest;`)(
  fetchJsonWithDeadline, async () => { repairs++; return { ok: true }; },
);
const fetchStatuses = new Function('approvedApiRequest', 'getDeviceId', `${clientSource}\nreturn fetchBaseCodeStatuses;`)(approved, getDeviceId);
const draftContext = { code: 2, draft_session_id: 'fixture-draft' };
const fetchWithContext = new Function('approvedApiRequest', 'getDeviceId', `${clientSource}\nreturn fetchBaseCodeStatuses;`)(
  async (url, body, options) => {
    assert.equal(url, '/api/base-codes/status');
    assert.deepEqual(body, { codes: [2], draft: draftContext });
    assert.deepEqual(options, { timeoutMs: 5000 });
    return { ok: true, items: shared.body.items.slice(1, 2) };
  }, () => deviceId,
);
assert.deepEqual(await fetchWithContext([2], { draft: draftContext, timeoutMs: 5000 }), shared.body.items.slice(1, 2));
const savedGlobals = new Map(['window', 'document', 'localStorage', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const storage = new Map([['tepiha_device_id_v1', deviceId], ['fixture-draft', 'preserve'], ['fixture-outbox', 'preserve']]);
let cookie = '', calls = 0;
try {
  globalThis.window = {};
  globalThis.document = { get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, '/api/base-codes/status');
    assert.match(cookie, /tepiha_device_id=fixture-approved-device/);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(JSON.parse(init.body), { codes: [2] });
    return { ok: true, status: 200, json: async () => ({ ok: true, items: response.body.items.slice(1, 2) }) };
  };
  assert.deepEqual(await fetchStatuses([2, '2']), response.body.items.slice(1, 2));
  assert.equal(calls, 1);
  assert.equal(repairs, 0);
  assert.equal(storage.get('fixture-draft'), 'preserve');
  assert.equal(storage.get('fixture-outbox'), 'preserve');
  assert.deepEqual(await fetchStatuses([]), []);
  assert.equal(calls, 1);
  await assert.rejects(fetchStatuses(['1e3']), /BASE_CODE_STATUS_CODES_INVALID/);
  assert.equal(calls, 1);

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 401, json: async () => ({ error: 'AUTH_REQUIRED' }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
  };
  assert.deepEqual(await fetchStatuses([1]), []);
  assert.equal(calls, 2);
  assert.equal(repairs, 1);

  calls = 0; repairs = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 403, json: async () => ({ error: 'DEVICE_NOT_APPROVED' }) }; };
  await assert.rejects(fetchStatuses([1]), /DEVICE_NOT_APPROVED/);
  assert.equal(calls, 1);
  assert.equal(repairs, 0);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await assert.rejects(fetchStatuses([1]), /BASE_CODE_STATUS_INVALID_RESPONSE/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  await assert.rejects(fetchStatuses([1], { timeoutMs: 10 }), /REQUEST_TIMEOUT/);
} finally {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log('PASS Base code client: lost cookie restored without login, one auth repair, explicit denial closed, response deadline bounded, drafts/outbox preserved.');
