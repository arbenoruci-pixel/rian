import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  getExistingDeviceApproval,
  isDeviceLinkedToOtherUser,
} from '../lib/authDeviceApproval.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'device-auth-approval-v1';
const APPROVED_AT = '2026-08-29T18:10:00.000Z';
const APPROVED_BY = 'manager-device-approval';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fakeSupabase(seed = {}, failures = []) {
  const tables = {
    users: clone(seed.users || []),
    tepiha_user_devices: clone(seed.tepiha_user_devices || []),
    tepiha_device_approvals: clone(seed.tepiha_device_approvals || []),
  };
  const calls = [];
  let generatedId = 0;

  function project(row, columns) {
    if (!row || !columns || columns === '*') return clone(row);
    const fields = String(columns).split(',').map((field) => field.trim()).filter(Boolean);
    return Object.fromEntries(fields.map((field) => [field, clone(row?.[field])]));
  }

  function forcedError(table, operation) {
    const match = failures.find((failure) => (
      failure.table === table
      && failure.operation === operation
      && failure.remaining !== 0
    ));
    if (!match) return null;
    match.remaining = Number.isFinite(match.remaining) ? match.remaining - 1 : 0;
    return { message: match.message || `${table}:${operation}:forced` };
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = 'select';
      this.columns = '*';
      this.filters = [];
      this.payload = null;
    }

    select(columns = '*') { this.columns = columns; return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    update(payload) { this.operation = 'update'; this.payload = clone(payload); return this; }
    insert(payload) { this.operation = 'insert'; this.payload = clone(payload); return this; }

    matchingRows() {
      return (tables[this.table] || []).filter((row) => this.filters.every(
        ([field, value]) => String(row?.[field] ?? '') === String(value ?? ''),
      ));
    }

    async execute() {
      calls.push({
        table: this.table,
        operation: this.operation,
        filters: clone(this.filters),
        payload: clone(this.payload),
      });
      const error = forcedError(this.table, this.operation);
      if (error) return { data: null, error };

      const source = tables[this.table] || (tables[this.table] = []);
      if (this.operation === 'insert') {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((row) => ({
          id: row?.id || `generated-${++generatedId}`,
          ...clone(row || {}),
        }));
        source.push(...rows);
        return { data: rows.map((row) => project(row, this.columns)), error: null };
      }

      if (this.operation === 'update') {
        const rows = [];
        for (let index = 0; index < source.length; index += 1) {
          const row = source[index];
          if (!this.filters.every(([field, value]) => String(row?.[field] ?? '') === String(value ?? ''))) continue;
          source[index] = { ...row, ...clone(this.payload || {}) };
          rows.push(source[index]);
        }
        return { data: rows.map((row) => project(row, this.columns)), error: null };
      }

      return {
        data: this.matchingRows().map((row) => project(row, this.columns)),
        error: null,
      };
    }

    async maybeSingle() {
      const result = await this.execute();
      if (result.error) return result;
      if (result.data.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: result.data[0] || null, error: null };
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
  }

  return {
    tables,
    calls,
    from(table) { return new Query(table); },
  };
}

function testUser(role = 'ADMIN') {
  return {
    id: USER_ID,
    pin: '7311',
    role,
    name: 'Test User',
    is_active: true,
    is_hybrid_transport: false,
  };
}

function testDevice(overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: USER_ID,
    device_id: DEVICE_ID,
    is_approved: false,
    approved_at: null,
    approved_by: null,
    ...overrides,
  };
}

function testMirror(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    pin: '7311',
    role: 'ADMIN',
    device_id: DEVICE_ID,
    approved: false,
    approved_at: null,
    approved_by: null,
    ...overrides,
  };
}

async function bundleProductionLogin() {
  const result = await build({
    entryPoints: [path.join(ROOT, 'api/auth/login.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'auth-test-api-helpers',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/_helpers\.js$/ }, (args) => (
          args.importer.endsWith('/api/auth/login.js')
            ? { path: 'helpers', namespace: 'auth-test' }
            : null
        ));
        builder.onLoad({ filter: /.*/, namespace: 'auth-test' }, () => ({
          loader: 'js',
          contents: `
            export function createAdminClientOrThrow() { return globalThis.__AUTH_DEVICE_DB__; }
            export async function readBody(req) { return req.body || {}; }
            export function normalizePin(value, { min = 3, max = 12 } = {}) {
              const clean = String(value || '').replace(/\\D/g, '');
              return clean.length >= min && clean.length <= max ? clean : '';
            }
            export function normalizeRole(value) { return String(value || '').trim().toUpperCase(); }
            export function normalizeDeviceId(value) { return String(value || '').trim().slice(0, 120); }
            export function apiOk(res, payload = {}, status = 200) {
              res.statusCode = status; res.body = { ok: true, ...payload }; return res.body;
            }
            export function apiFail(res, error, status = 400, extra = {}) {
              res.statusCode = status;
              res.body = { ok: false, error: String(error?.message || error), ...extra };
              return res.body;
            }
            export function setClientCookie(res, name, value) {
              res.cookies.push({ name, value: String(value) });
            }
          `,
        }));
      },
    }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#production-login`;
  return (await import(url)).default;
}

function nextMocksPlugin() {
  return {
    name: 'auth-test-next-mocks',
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/apiService$/ }, () => ({ path: 'api-service', namespace: 'next-auth-test' }));
      builder.onResolve({ filter: /^@\/lib\/validation$/ }, () => ({ path: 'validation', namespace: 'next-auth-test' }));
      builder.onResolve({ filter: /^@\/lib\/(authDeviceApproval|staffIdentityAliases)$/ }, (args) => ({
        path: path.join(ROOT, 'lib', `${args.path.split('/').at(-1)}.js`),
      }));
      builder.onLoad({ filter: /^api-service$/, namespace: 'next-auth-test' }, () => ({
        loader: 'js',
        contents: `
          export function createServiceClientOrThrow() { return globalThis.__AUTH_NEXT_DB__; }
          export async function readBody(req) { return req.body || {}; }
          function json(payload, status) {
            return new Response(JSON.stringify(payload), {
              status,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }
          export function apiOk(payload = {}, status = 200) { return json({ ok: true, ...payload }, status); }
          export function apiFail(error, status = 400, extra = {}) {
            return json({ ok: false, error: String(error?.message || error), ...extra }, status);
          }
          export function logApiError(scope, error) {
            globalThis.__AUTH_NEXT_LOGS__ = [...(globalThis.__AUTH_NEXT_LOGS__ || []), { scope, error: String(error?.message || error) }];
          }
        `,
      }));
      builder.onLoad({ filter: /^validation$/, namespace: 'next-auth-test' }, () => ({
        loader: 'js',
        contents: `
          export function normalizePin(value, { min = 3, max = 12 } = {}) {
            const clean = String(value || '').replace(/\\D/g, '');
            return clean.length >= min && clean.length <= max ? clean : '';
          }
          export function normalizeRole(value) { return String(value || '').trim().toUpperCase(); }
          export function normalizeDeviceId(value) { return String(value || '').trim().slice(0, 120); }
        `,
      }));
    },
  };
}

async function bundleNextModule(relativePath, fragment) {
  const result = await build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [nextMocksPlugin()],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${fragment}`;
  return import(url);
}

function productionResponse() {
  return { statusCode: 0, body: null, cookies: [] };
}

async function parseResponse(response) {
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}

// The decision is intentionally role-free and retains approval provenance only
// for an existing row belonging to the exact same canonical user.
assert.deepEqual(getExistingDeviceApproval(null, USER_ID), {
  approved: false,
  approvedAt: null,
  approvedBy: null,
});
assert.deepEqual(getExistingDeviceApproval(testDevice(), USER_ID), {
  approved: false,
  approvedAt: null,
  approvedBy: null,
});
assert.deepEqual(getExistingDeviceApproval(testDevice({
  is_approved: true,
  approved_at: APPROVED_AT,
  approved_by: APPROVED_BY,
}), USER_ID), {
  approved: true,
  approvedAt: APPROVED_AT,
  approvedBy: APPROVED_BY,
});
assert.equal(getExistingDeviceApproval(testDevice({ user_id: OTHER_USER_ID, is_approved: true }), USER_ID).approved, false);
assert.equal(isDeviceLinkedToOtherUser(testDevice({ user_id: OTHER_USER_ID }), USER_ID), true);
assert.equal(isDeviceLinkedToOtherUser(testDevice(), USER_ID), false);

const productionLogin = await bundleProductionLogin();
const privilegedAndWorkerRoles = ['ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN', 'DISPATCH', 'PUNTOR', 'TRANSPORT'];

for (const role of privilegedAndWorkerRoles) {
  const db = fakeSupabase({ users: [testUser(role)] });
  globalThis.__AUTH_DEVICE_DB__ = db;
  const res = productionResponse();
  await productionLogin({ method: 'POST', body: { pin: '7311', role, deviceId: DEVICE_ID } }, res);
  assert.equal(res.statusCode, 403, `${role}: a new device must stay pending`);
  assert.equal(res.body?.error, 'DEVICE_NOT_APPROVED');
  assert.equal(res.cookies.length, 0, `${role}: pending login must not set an approved-device cookie`);
  assert.equal(db.tables.tepiha_user_devices.length, 1);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_user_devices[0].approved_at, null);
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, null);
}

{
  const pending = testDevice({ approved_at: APPROVED_AT, approved_by: APPROVED_BY });
  const db = fakeSupabase({ users: [testUser('ADMIN')], tepiha_user_devices: [pending] });
  globalThis.__AUTH_DEVICE_DB__ = db;
  const res = productionResponse();
  await productionLogin({ method: 'POST', body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_user_devices[0].approved_at, null, 'pending rows must not retain stale approval provenance');
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, null);
}

{
  const approved = testDevice({ is_approved: true, approved_at: APPROVED_AT, approved_by: APPROVED_BY });
  const db = fakeSupabase({ users: [testUser('ADMIN')], tepiha_user_devices: [approved] });
  globalThis.__AUTH_DEVICE_DB__ = db;
  const res = productionResponse();
  await productionLogin({ method: 'POST', body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cookies.length, 1);
  assert.equal(db.tables.tepiha_user_devices[0].approved_at, APPROVED_AT, 'login must preserve the original approval timestamp');
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, APPROVED_BY, 'login must preserve the original approver');
}

{
  const foreign = testDevice({ user_id: OTHER_USER_ID, is_approved: true });
  const db = fakeSupabase({ users: [testUser('ADMIN')], tepiha_user_devices: [foreign] });
  globalThis.__AUTH_DEVICE_DB__ = db;
  const res = productionResponse();
  await productionLogin({ method: 'POST', body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error, 'DEVICE_LINKED_TO_OTHER_USER');
  assert.equal(db.calls.some((call) => call.operation === 'update' || call.operation === 'insert'), false);
  assert.equal(res.cookies.length, 0);
}

const { POST: nextLogin } = await bundleNextModule('app/api/auth/login/route.js', 'next-login');

{
  const db = fakeSupabase({ users: [testUser('SUPERADMIN')] });
  globalThis.__AUTH_NEXT_DB__ = db;
  const parsed = await parseResponse(await nextLogin({ body: { pin: '7311', role: 'SUPERADMIN', deviceId: DEVICE_ID } }));
  assert.equal(parsed.status, 403);
  assert.equal(parsed.body.error, 'DEVICE_NOT_APPROVED');
  assert.equal(parsed.cookie, null);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false);
}

{
  const db = fakeSupabase({
    users: [testUser('OWNER')],
    tepiha_user_devices: [testDevice({ is_approved: true, approved_at: APPROVED_AT, approved_by: APPROVED_BY })],
    tepiha_device_approvals: [testMirror({ approved: true, approved_at: APPROVED_AT, approved_by: APPROVED_BY })],
  });
  globalThis.__AUTH_NEXT_DB__ = db;
  const parsed = await parseResponse(await nextLogin({ body: { pin: '7311', role: 'OWNER', deviceId: DEVICE_ID } }));
  assert.equal(parsed.status, 200);
  assert.match(parsed.cookie || '', /^tepiha_device_id=/);
  assert.match(parsed.cookie || '', /SameSite=Lax/);
  assert.equal(db.tables.tepiha_user_devices[0].approved_at, APPROVED_AT);
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, APPROVED_BY);
  assert.equal(db.tables.tepiha_device_approvals[0].approved_at, APPROVED_AT);
  assert.equal(db.tables.tepiha_device_approvals[0].approved_by, APPROVED_BY);
}

{
  const failures = [{ table: 'tepiha_device_approvals', operation: 'insert', remaining: 1, message: 'mirror unavailable' }];
  const db = fakeSupabase({ users: [testUser('ADMIN')] }, failures);
  globalThis.__AUTH_NEXT_DB__ = db;
  const parsed = await parseResponse(await nextLogin({ body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }));
  assert.equal(parsed.status, 500);
  assert.equal(parsed.body.error, 'mirror unavailable');
  assert.equal(parsed.cookie, null);
  assert.equal(db.tables.tepiha_user_devices.length, 0, 'mirror failure must stop before authoritative device mutation');
}

{
  const db = fakeSupabase({
    users: [testUser('ADMIN')],
    tepiha_user_devices: [testDevice({ user_id: OTHER_USER_ID, is_approved: true })],
  });
  globalThis.__AUTH_NEXT_DB__ = db;
  const parsed = await parseResponse(await nextLogin({ body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }));
  assert.equal(parsed.status, 409);
  assert.equal(parsed.body.error, 'DEVICE_LINKED_TO_OTHER_USER');
  assert.equal(parsed.cookie, null);
  assert.equal(db.calls.some((call) => call.operation === 'update' || call.operation === 'insert'), false);
}

const { POST: nextDeviceStatus } = await bundleNextModule('app/api/auth/device-status/route.js', 'next-device-status');

for (const { device, expected } of [
  { device: null, expected: false },
  { device: testDevice(), expected: false },
  { device: testDevice({ is_approved: true, approved_at: APPROVED_AT, approved_by: APPROVED_BY }), expected: true },
]) {
  const db = fakeSupabase({ users: [testUser('ADMIN')], tepiha_user_devices: device ? [device] : [] });
  globalThis.__AUTH_NEXT_DB__ = db;
  const parsed = await parseResponse(await nextDeviceStatus({ body: { pin: '7311', role: 'ADMIN', deviceId: DEVICE_ID } }));
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.approved, expected, `ADMIN status must reflect only the exact approved device row (${expected})`);
}

const loginSources = {
  'api/auth/login.js': read('api/auth/login.js'),
  'app/api/auth/login/route.js': read('app/api/auth/login/route.js'),
  'server/index.mjs': (() => {
    const server = read('server/index.mjs');
    const start = server.indexOf("app.post('/api/auth/login'");
    const end = server.indexOf("\napp.post('/api/runtime-incident'", start);
    assert.ok(start >= 0 && end > start, 'Express login block must be discoverable');
    return server.slice(start, end);
  })(),
};

for (const [relativePath, source] of Object.entries(loginSources)) {
  assert.match(source, /getExistingDeviceApproval\(dev, user\.id\)/, `${relativePath}: exact-row approval helper missing`);
  assert.match(source, /isDeviceLinkedToOtherUser\(dev, user\.id\)/, `${relativePath}: cross-user guard missing`);
  assert.match(source, /isCurrentlyApproved = existingApproval\.approved/, `${relativePath}: approval must come only from the existing row`);
  assert.match(source, /approved_at: existingApproval\.approvedAt/, `${relativePath}: original approval timestamp must be preserved`);
  assert.match(source, /approved_by: existingApproval\.approvedBy/, `${relativePath}: original approver must be preserved`);
  assert.doesNotMatch(source, /canAutoApproveDevice|\bisAdmin\b|!!isAdmin|approved_by:\s*[^\n]*['"]SYSTEM['"]/, `${relativePath}: role/system auto-approval remains`);
  assert.ok(source.indexOf('DEVICE_LINKED_TO_OTHER_USER') < source.indexOf('const devicePayload'), `${relativePath}: cross-user guard must precede mutation payload`);
}

const nextLoginSource = loginSources['app/api/auth/login/route.js'];
assert.match(nextLoginSource, /res\?\.headers\?\.append/, 'App Router login must set the cookie on a standard Response');
assert.equal((nextLoginSource.match(/attachDeviceCookie\(/g) || []).length, 2, 'only the successful App Router login may attach a device cookie');
assert.match(nextLoginSource, /mirrorLookupError/);
assert.match(nextLoginSource, /mirrorUpdateError/);
assert.match(nextLoginSource, /mirrorInsertError/);
assert.ok(nextLoginSource.indexOf('await syncApprovalMirror(existingApproval)') < nextLoginSource.indexOf("from('tepiha_user_devices').update"));

const deviceStatusSource = read('app/api/auth/device-status/route.js');
assert.match(deviceStatusSource, /getExistingDeviceApproval\(dev, user\.id\)\.approved/);
assert.doesNotMatch(deviceStatusSource, /userRole\s*===\s*['"]ADMIN['"]|canAutoApproveDevice|\bisAdmin\b/);
assert.doesNotMatch(read('lib/roles.js'), /canAutoApproveDevice/);

for (const validationPath of [
  'api/auth/validate-pin.js',
  'app/api/auth/validate-pin/route.js',
  'app/api/auth/pin/route.js',
]) {
  assert.doesNotMatch(read(validationPath), /tepiha_user_devices|is_approved|approved_at|approved_by/, `${validationPath}: PIN validation must not grant device approval`);
}

delete globalThis.__AUTH_DEVICE_DB__;
delete globalThis.__AUTH_NEXT_DB__;
delete globalThis.__AUTH_NEXT_LOGS__;

console.log('PASS auth device approval V1: every new device stays pending for every role, approved-row provenance is preserved, cross-user reassignment is blocked, and App Router parity is fail-closed.');
