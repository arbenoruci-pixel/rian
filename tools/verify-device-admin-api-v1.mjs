import assert from 'node:assert/strict';
import fs from 'node:fs';
import deviceAdminHandler from '../api/admin/devices.js';
import {
  DeviceAdminError,
  normalizeDeviceAdminId,
  runDeviceAdminAction,
} from '../lib/deviceAdminServer.js';
import { authenticateStaffManager } from '../lib/staffIdentityServer.js';

const MANAGER = {
  id: '11111111-1111-4111-8111-111111111111',
  pin: '2380',
  name: 'Admin',
  role: 'ADMIN',
  is_active: true,
};
const WORKER = {
  id: '22222222-2222-4222-8222-222222222222',
  pin: '7311',
  name: 'Bujar Oruqi',
  role: 'PUNTOR',
  is_active: true,
};
const DEVICE_ID = 'device-a1b2c3d4';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pendingDevice(overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: WORKER.id,
    device_id: DEVICE_ID,
    label: 'Chrome',
    is_approved: false,
    requested_pin: WORKER.pin,
    requested_role: WORKER.role,
    created_at: '2026-08-29T20:00:00.000Z',
    approved_at: null,
    approved_by: null,
    server_secret: 'must-not-be-returned',
    ...overrides,
  };
}

function approvalMirror(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    pin: WORKER.pin,
    role: WORKER.role,
    device_id: DEVICE_ID,
    label: 'Chrome',
    approved: false,
    approved_by: null,
    approved_at: null,
    last_seen_at: '2026-08-29T20:00:00.000Z',
    created_at: '2026-08-29T20:00:00.000Z',
    mirror_secret: 'must-not-be-returned',
    ...overrides,
  };
}

function roleTarget(role, overrides = {}) {
  return {
    ...WORKER,
    id: '66666666-6666-4666-8666-666666666666',
    pin: '7942',
    name: `Target ${role}`,
    role,
    ...overrides,
  };
}

function roleActionSeed(action, user) {
  const isApproved = action === 'REVOKE';
  return {
    users: [user],
    tepiha_user_devices: [pendingDevice({
      user_id: user.id,
      requested_pin: user.pin,
      requested_role: user.role,
      is_approved: isApproved,
      approved_by: isApproved ? MANAGER.id : null,
      approved_at: isApproved ? '2026-08-29T20:30:00.000Z' : null,
    })],
    tepiha_device_approvals: [approvalMirror({
      pin: user.pin,
      role: user.role,
      approved: isApproved,
      approved_by: isApproved ? MANAGER.id : null,
      approved_at: isApproved ? '2026-08-29T20:30:00.000Z' : null,
    })],
  };
}

function fakeSupabase(seed = {}, failureSpecs = [], options = {}) {
  const tables = {
    users: clone(seed.users || []),
    tepiha_user_devices: clone(seed.tepiha_user_devices || []),
    tepiha_device_approvals: clone(seed.tepiha_device_approvals || []),
  };
  const calls = [];
  const failures = failureSpecs.map((spec) => ({ remaining: 1, ...spec }));
  let generatedId = 0;

  function postgresTimestamp(value) {
    if (!options.postgresTimestamps || typeof value !== 'string') return value;
    const match = value.match(/^(.*?)(?:\.(\d+))?Z$/);
    if (!match) return value;
    const fraction = String(match[2] || '').replace(/0+$/, '');
    return `${match[1]}${fraction ? `.${fraction}` : ''}+00:00`;
  }

  function project(row, columns) {
    if (!row || !columns || columns === '*') return clone(row);
    const fields = String(columns).split(',').map((field) => field.trim()).filter(Boolean);
    return Object.fromEntries(fields.map((field) => [
      field,
      clone(field.endsWith('_at') ? postgresTimestamp(row[field]) : row[field]),
    ]));
  }

  function takeFailure(table, operation) {
    const match = failures.find((item) => (
      item.remaining > 0
      && item.table === table
      && item.operation === operation
    ));
    if (!match) return null;
    match.remaining -= 1;
    return match;
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = 'select';
      this.columns = '*';
      this.filters = [];
      this.payload = null;
      this.orderBy = null;
      this.limitValue = null;
    }

    select(columns = '*') { this.columns = columns; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    delete() { this.operation = 'delete'; return this; }
    eq(field, value) { this.filters.push(['eq', field, value]); return this; }
    in(field, values) { this.filters.push(['in', field, [...values]]); return this; }
    order(field, options = {}) { this.orderBy = [field, options]; return this; }
    limit(value) { this.limitValue = Number(value); return this; }

    matchingIndexes() {
      const source = tables[this.table] || [];
      const matches = [];
      for (let index = 0; index < source.length; index += 1) {
        const row = source[index];
        if (this.filters.every(([operator, field, value]) => (
          operator === 'in' ? value.includes(row?.[field]) : row?.[field] === value
        ))) matches.push(index);
      }
      return matches;
    }

    async execute() {
      calls.push({
        table: this.table,
        operation: this.operation,
        columns: this.columns,
        filters: clone(this.filters),
        payload: clone(this.payload),
      });
      const forcedFailure = takeFailure(this.table, this.operation);
      const forcedError = forcedFailure?.error || {
        message: `${this.table}:${this.operation}:forced failure`,
      };
      if (forcedFailure && !forcedFailure.afterCommit && !forcedFailure.invalidData) {
        return { data: null, error: forcedError };
      }

      const source = tables[this.table] || (tables[this.table] = []);
      let rows = [];
      if (this.operation === 'insert') {
        const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((item) => ({
          id: item?.id || `generated-${++generatedId}`,
          created_at: item?.created_at || '2026-08-29T21:00:00.000Z',
          ...clone(item || {}),
        }));
        source.push(...inserted);
        rows = inserted;
      } else {
        const indexes = this.matchingIndexes();
        if (this.operation === 'update') {
          for (const index of indexes) source[index] = { ...source[index], ...clone(this.payload || {}) };
          rows = indexes.map((index) => source[index]);
        } else if (this.operation === 'delete') {
          rows = indexes.map((index) => source[index]);
          for (const index of [...indexes].sort((a, b) => b - a)) source.splice(index, 1);
        } else {
          rows = indexes.map((index) => source[index]);
        }
      }

      if (this.orderBy) {
        const [field, options] = this.orderBy;
        const direction = options?.ascending === false ? -1 : 1;
        rows = [...rows].sort((a, b) => String(a?.[field] || '').localeCompare(String(b?.[field] || '')) * direction);
      }
      if (Number.isFinite(this.limitValue)) rows = rows.slice(0, this.limitValue);
      if (forcedFailure?.afterCommit) return { data: null, error: forcedError };
      if (forcedFailure?.invalidData) return { data: [{}], error: null };
      return { data: rows.map((row) => project(row, this.columns)), error: null };
    }

    async maybeSingle() {
      const response = await this.execute();
      if (response.error) return response;
      if (response.data.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: response.data[0] || null, error: null };
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

async function expectCode(promise, code, status = null) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DeviceAdminError, `expected DeviceAdminError ${code}`);
  assert.equal(caught.code, code);
  if (status != null) assert.equal(caught.httpStatus, status);
  return caught;
}

assert.equal(normalizeDeviceAdminId(`  ${DEVICE_ID}  `), DEVICE_ID);
assert.equal(normalizeDeviceAdminId('short'), '');
assert.equal(normalizeDeviceAdminId('device/../../escape'), '');
assert.equal(normalizeDeviceAdminId(`d${'x'.repeat(120)}`), '');

{
  const db = fakeSupabase();
  await assert.rejects(
    authenticateStaffManager(db, ''),
    (error) => error?.code === 'AUTH_REQUIRED' && error?.httpStatus === 401,
  );
}

{
  const db = fakeSupabase({
    users: [MANAGER],
    tepiha_user_devices: [pendingDevice({ user_id: MANAGER.id })],
  });
  await assert.rejects(
    authenticateStaffManager(db, DEVICE_ID),
    (error) => error?.code === 'DEVICE_NOT_APPROVED' && error?.httpStatus === 403,
  );
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [
      pendingDevice(),
      pendingDevice({
        id: '55555555-5555-4555-8555-555555555555',
        device_id: 'device-approved1',
        is_approved: true,
        server_secret: 'approved-secret',
      }),
    ],
  });
  const result = await runDeviceAdminAction({ action: 'LIST_PENDING' }, { supabase: db, authUser: MANAGER });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].device_id, DEVICE_ID);
  assert.deepEqual(result.devices[0].tepiha_users, {
    id: WORKER.id,
    name: WORKER.name,
    pin: WORKER.pin,
    role: WORKER.role,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.devices[0], 'server_secret'), false);
  assert.equal(db.calls.some((call) => call.table === 'tepiha_users'), false);
}

{
  const targets = [
    roleTarget('ADMIN', {
      id: '70000000-0000-4000-8000-000000000001',
      pin: '9811',
    }),
    roleTarget('DISPATCH', {
      id: '70000000-0000-4000-8000-000000000002',
      pin: '9822',
    }),
    roleTarget('PUNTOR', {
      id: '70000000-0000-4000-8000-000000000003',
      pin: '9833',
    }),
    roleTarget('OWNER', {
      id: '70000000-0000-4000-8000-000000000004',
      pin: '9844',
    }),
    roleTarget('SUPERADMIN', {
      id: '70000000-0000-4000-8000-000000000005',
      pin: '9855',
    }),
    roleTarget('UNKNOWN_ROLE', {
      id: '70000000-0000-4000-8000-000000000006',
      pin: '9866',
    }),
  ];
  const devices = targets.map((user, index) => pendingDevice({
    id: `pending-list-${index}`,
    user_id: user.id,
    device_id: `device-list-${index}`,
    requested_pin: user.pin,
    requested_role: user.role,
  }));
  devices.push(pendingDevice({
    id: 'pending-list-missing',
    user_id: '70000000-0000-4000-8000-000000000099',
    device_id: 'device-list-missing',
    requested_pin: '9877',
    requested_role: 'PUNTOR',
  }));

  const db = fakeSupabase({
    users: targets,
    tepiha_user_devices: devices,
  });
  const result = await runDeviceAdminAction({ action: 'LIST_PENDING' }, {
    supabase: db,
    authUser: MANAGER,
  });
  assert.deepEqual(
    result.devices.map((device) => device.tepiha_users.role).sort(),
    ['ADMIN', 'DISPATCH', 'PUNTOR'],
    'ADMIN pending list must include only equal/lower known roles',
  );
  const serialized = JSON.stringify(result);
  for (const hidden of ['9844', '9855', '9866', '9877', 'device-list-3', 'device-list-4', 'device-list-5', 'device-list-missing']) {
    assert.equal(serialized.includes(hidden), false, `pending list must not disclose hidden target data: ${hidden}`);
  }
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  });
  const result = await runDeviceAdminAction({
    action: 'APPROVE',
    deviceId: DEVICE_ID,
    approved_by: 'attacker',
    user_id: 'attacker',
    master_pin: '0000',
  }, { supabase: db, authUser: MANAGER });
  assert.equal(result.device.is_approved, true);
  assert.equal(result.device.approved_by, MANAGER.id);
  assert.equal(result.device.tepiha_users.name, WORKER.name);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, true);
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, MANAGER.id);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, true);
  assert.equal(db.tables.tepiha_device_approvals[0].approved_by, MANAGER.id);
  const deviceUpdateIndex = db.calls.findIndex((call) => call.table === 'tepiha_user_devices' && call.operation === 'update');
  const mirrorUpdateIndex = db.calls.findIndex((call) => call.table === 'tepiha_device_approvals' && call.operation === 'update');
  assert.ok(mirrorUpdateIndex >= 0 && deviceUpdateIndex > mirrorUpdateIndex, 'authoritative approval must be the final elevating write');
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [], { postgresTimestamps: true });
  const result = await runDeviceAdminAction({
    action: 'APPROVE',
    deviceId: DEVICE_ID,
  }, { supabase: db, authUser: MANAGER });
  assert.equal(result.device.is_approved, true);
  assert.match(result.device.approved_at, /\+00:00$/);
  const approvalUpdate = db.calls.find((call) => (
    call.table === 'tepiha_user_devices'
    && call.operation === 'update'
    && call.payload?.is_approved === true
  ));
  assert.notEqual(result.device.approved_at, approvalUpdate?.payload?.approved_at);
  assert.equal(
    Date.parse(result.device.approved_at),
    Date.parse(approvalUpdate?.payload?.approved_at),
    'PostgREST timestamp formatting must preserve the approved instant',
  );
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, true);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, true);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [{ table: 'tepiha_device_approvals', operation: 'update' }]);
  const error = await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_MIRROR_UPDATE_FAILED',
    500,
  );
  assert.equal(error.extra.authoritative_approval_absent, true);
  assert.equal(error.extra.mirror_rollback_verified, true);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false, 'mirror failure must never elevate the authoritative row');
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
  }, [{ table: 'tepiha_device_approvals', operation: 'insert' }]);
  const error = await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', device_id: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_MIRROR_UPDATE_FAILED',
  );
  assert.equal(error.extra.authoritative_approval_absent, true);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_device_approvals.length, 0);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [{ table: 'tepiha_device_approvals', operation: 'update', afterCommit: true }]);
  const error = await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_MIRROR_UPDATE_FAILED',
  );
  assert.equal(error.extra.authoritative_approval_absent, true);
  assert.equal(error.extra.mirror_rollback_verified, true);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false, 'commit-then-error mirror write must be compensated');
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [{ table: 'tepiha_device_approvals', operation: 'update', invalidData: true }]);
  await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_MIRROR_NOT_VERIFIED',
  );
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false, 'unverifiable committed mirror write must be compensated');
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [{ table: 'tepiha_user_devices', operation: 'update' }]);
  const error = await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_UPDATE_FAILED',
  );
  assert.equal(error.extra.authoritative_rollback_verified, true);
  assert.equal(error.extra.mirror_rollback_verified, true);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false, 'forced final-step failure must leave actual approval false');
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  }, [{ table: 'tepiha_user_devices', operation: 'update', afterCommit: true }]);
  const error = await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_APPROVAL_UPDATE_FAILED',
  );
  assert.equal(error.extra.authoritative_rollback_verified, true);
  assert.equal(error.extra.mirror_rollback_verified, true);
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false, 'commit-then-error final write must be guardedly rolled back');
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false);
}

{
  const alreadyApproved = pendingDevice({ is_approved: true });
  const db = fakeSupabase({ users: [WORKER], tepiha_user_devices: [alreadyApproved] });
  await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_ALREADY_APPROVED',
    409,
  );
  assert.equal(db.calls.some((call) => call.operation === 'update'), false);
}

{
  const db = fakeSupabase({ users: [WORKER] });
  await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_NOT_FOUND',
    404,
  );
  await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: 'bad/id' }, { supabase: db, authUser: MANAGER }),
    'DEVICE_ID_INVALID',
    400,
  );
  await expectCode(
    runDeviceAdminAction({ action: 'LIST_PENDING' }, {
      supabase: db,
      authUser: { ...MANAGER, role: 'DISPATCH' },
    }),
    'DEVICE_ADMIN_ACTOR_NOT_ALLOWED',
    403,
  );
}

for (const action of ['APPROVE', 'REJECT', 'REVOKE']) {
  for (const role of ['OWNER', 'PRONAR', 'ADMIN_MASTER', 'SUPERADMIN']) {
    const target = roleTarget(role);
    const db = fakeSupabase(roleActionSeed(action, target));
    await expectCode(
      runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
        supabase: db,
        authUser: MANAGER,
      }),
      'DEVICE_ADMIN_TARGET_NOT_ALLOWED',
      403,
    );
    assert.equal(
      db.calls.some((call) => ['insert', 'update', 'delete'].includes(call.operation)),
      false,
      `ADMIN must not mutate ${role} devices through ${action}`,
    );
  }
}

for (const action of ['APPROVE', 'REJECT', 'REVOKE']) {
  const target = roleTarget('UNRECOGNIZED_ROLE');
  const db = fakeSupabase(roleActionSeed(action, target));
  await expectCode(
    runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
      supabase: db,
      authUser: MANAGER,
    }),
    'DEVICE_ADMIN_TARGET_NOT_ALLOWED',
    403,
  );
  assert.equal(
    db.calls.some((call) => ['insert', 'update', 'delete'].includes(call.operation)),
    false,
    `unknown target roles must fail closed for ${action}`,
  );
}

for (const action of ['APPROVE', 'REJECT', 'REVOKE']) {
  const seed = roleActionSeed(action, WORKER);
  seed.users = [];
  const db = fakeSupabase(seed);
  await expectCode(
    runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
      supabase: db,
      authUser: MANAGER,
    }),
    'DEVICE_USER_NOT_FOUND',
    409,
  );
  assert.equal(
    db.calls.some((call) => ['insert', 'update', 'delete'].includes(call.operation)),
    false,
    `missing target users must fail closed for ${action}`,
  );
}

for (const action of ['APPROVE', 'REJECT', 'REVOKE']) {
  const target = roleTarget('ADMIN');
  const db = fakeSupabase(roleActionSeed(action, target));
  const result = await runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
    supabase: db,
    authUser: MANAGER,
  });
  assert.equal(result.device.tepiha_users.role, 'ADMIN');
  if (action === 'APPROVE') assert.equal(result.device.is_approved, true);
  if (action === 'REJECT') assert.equal(result.device.removed, true);
  if (action === 'REVOKE') assert.equal(result.device.is_approved, false);
}

for (const action of ['APPROVE', 'REJECT', 'REVOKE']) {
  const db = fakeSupabase(roleActionSeed(action, WORKER));
  await expectCode(
    runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
      supabase: db,
      authUser: { ...MANAGER, role: 'DISPATCH' },
    }),
    'DEVICE_ADMIN_ACTOR_NOT_ALLOWED',
    403,
  );
  assert.equal(db.calls.length, 0, `DISPATCH must be rejected before database access for ${action}`);
}

{
  const inactiveWorker = { ...WORKER, is_active: false };
  const db = fakeSupabase(roleActionSeed('APPROVE', inactiveWorker));
  await expectCode(
    runDeviceAdminAction({ action: 'APPROVE', deviceId: DEVICE_ID }, {
      supabase: db,
      authUser: MANAGER,
    }),
    'DEVICE_USER_DISABLED',
    409,
  );
}

for (const action of ['REJECT', 'REVOKE']) {
  const inactiveWorker = { ...WORKER, is_active: false, pin: '' };
  const db = fakeSupabase(roleActionSeed(action, inactiveWorker));
  const result = await runDeviceAdminAction({ action, deviceId: DEVICE_ID }, {
    supabase: db,
    authUser: MANAGER,
  });
  if (action === 'REJECT') assert.equal(result.device.removed, true);
  if (action === 'REVOKE') assert.equal(result.device.is_approved, false);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  });
  const result = await runDeviceAdminAction({ action: 'REJECT', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER });
  assert.equal(result.device.removed, true);
  assert.equal(result.device.revocation, 'PENDING_REQUEST_REJECTED');
  assert.equal(db.tables.tepiha_user_devices.length, 0);
  assert.equal(db.tables.tepiha_device_approvals.length, 0);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice()],
    tepiha_device_approvals: [approvalMirror()],
  });
  await expectCode(
    runDeviceAdminAction({ action: 'REVOKE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_REVOKE_REQUIRES_APPROVED',
    409,
  );
  assert.equal(db.tables.tepiha_user_devices.length, 1);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice({
      is_approved: true,
      approved_by: MANAGER.id,
      approved_at: '2026-08-29T20:30:00.000Z',
    })],
    tepiha_device_approvals: [approvalMirror({
      approved: true,
      approved_by: MANAGER.id,
      approved_at: '2026-08-29T20:30:00.000Z',
    })],
  });
  const result = await runDeviceAdminAction({ action: 'REVOKE', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER });
  assert.equal(result.device.removed, false);
  assert.equal(result.device.revocation, 'APPROVED_DEVICE_REVOKED');
  assert.equal(db.tables.tepiha_user_devices.length, 1, 'approved revocation must retain the durable device link');
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, false);
  assert.equal(db.tables.tepiha_user_devices[0].approved_by, null);
  assert.equal(db.tables.tepiha_device_approvals[0].approved, false);
}

{
  const db = fakeSupabase({
    users: [WORKER],
    tepiha_user_devices: [pendingDevice({ is_approved: true })],
    tepiha_device_approvals: [approvalMirror({ approved: true })],
  });
  await expectCode(
    runDeviceAdminAction({ action: 'REJECT', deviceId: DEVICE_ID }, { supabase: db, authUser: MANAGER }),
    'DEVICE_REJECT_REQUIRES_PENDING',
    409,
  );
  assert.equal(db.tables.tepiha_user_devices[0].is_approved, true);
}

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(value = '') { this.body = String(value); },
    headers,
  };
}

{
  const res = responseRecorder();
  await deviceAdminHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'METHOD_NOT_ALLOWED');
  assert.equal(res.getHeader('allow'), 'POST');
  assert.match(String(res.getHeader('cache-control')), /private, no-store/);
  assert.equal(res.getHeader('vary'), 'Cookie');
  assert.equal(res.getHeader('x-content-type-options'), 'nosniff');
}

{
  const res = responseRecorder();
  await deviceAdminHandler({
    method: 'POST',
    headers: { origin: 'https://evil.example', host: 'tepiha.example' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'ORIGIN_NOT_ALLOWED');
}

const endpoint = fs.readFileSync('api/admin/devices.js', 'utf8');
const appRoute = fs.readFileSync('app/api/admin/devices/route.js', 'utf8');
const core = fs.readFileSync('lib/deviceAdminServer.js', 'utf8');
const client = fs.readFileSync('lib/deviceAdminClient.js', 'utf8');
const staffPage = fs.readFileSync('app/arka/stafi/page.jsx', 'utf8');
const server = fs.readFileSync('server/index.mjs', 'utf8');

assert.match(endpoint, /createAdminClientOrThrow/);
assert.match(endpoint, /authenticateStaffManager/);
assert.match(endpoint, /readCookie\(req, 'tepiha_device_id'\)/);
assert.match(endpoint, /ORIGIN_NOT_ALLOWED/);
assert.match(endpoint, /private, no-store/);
assert.doesNotMatch(endpoint, /master_pin|ADMIN_PIN|TEPIHA_RESET_PIN/);
assert.doesNotMatch(endpoint, /NEXT_PUBLIC_[A-Z_]*SERVICE/);
assert.match(appRoute, /createServiceClientOrThrow/);
assert.match(appRoute, /authenticateStaffManager/);
assert.match(appRoute, /readCookie\(req, 'tepiha_device_id'\)/);
assert.match(appRoute, /runDeviceAdminAction\(body, \{ supabase, authUser \}\)/);
assert.match(appRoute, /ORIGIN_NOT_ALLOWED/);
assert.match(appRoute, /private, no-store/);
assert.doesNotMatch(appRoute, /master_pin|ADMIN_PIN|TEPIHA_RESET_PIN|ADMIN_RESET_PIN/);
assert.doesNotMatch(appRoute, /\.select\(['"]\*['"]\)|\.from\(['"]tepiha_users['"]\)/);
assert.doesNotMatch(appRoute, /NEXT_PUBLIC_[A-Z_]*SERVICE/);
assert.doesNotMatch(core, /\.select\(['"]\*['"]\)/, 'device admin responses must use explicit projections');
assert.doesNotMatch(core, /\.from\(['"]tepiha_users['"]\)/, 'canonical user lookup must use public.users');
assert.match(core, /DEVICE_MANAGER_ROLES/);
assert.doesNotMatch(core, /DEVICE_MANAGER_ROLES[\s\S]{0,180}DISPATCH/, 'DISPATCH must not receive device-admin authority');
assert.match(client, /rejectPendingDevice[\s\S]*deviceAdminRequest\('REJECT', \{ deviceId \}\)/, 'pending UI rejection must use an explicitly named REJECT helper');
assert.match(client, /revokeApprovedDevice[\s\S]*deviceAdminRequest\('REVOKE', \{ deviceId \}\)/, 'approved-device revocation must remain an explicit separate operation');
assert.match(staffPage, /rejectPendingDevice\(device\?\.device_id\)/, 'pending device UI must never call the approved-device revocation helper');
assert.doesNotMatch(staffPage, /\.from\(["']tepiha_(?:user_devices|device_approvals)["']\)/, 'browser staff UI must not mutate device tables directly');
assert.match(server, /import deviceAdminHandler from ['"]\.\.\/api\/admin\/devices\.js['"]/);
assert.match(server, /app\.post\(['"]\/api\/admin\/devices['"], deviceAdminHandler\)/);

console.log('PASS device admin API V1: manager-cookie auth boundary, safe pending list, verified dual-table approval, explicit reject/revoke semantics, rollback, and DEV/deploy parity verified.');
