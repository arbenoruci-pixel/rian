import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  StaffIdentityMutationError,
  normalizeStaffName,
  runStaffIdentityMutation,
  sanitizeStaffIdentityPatch,
} from '../lib/staffIdentityServer.js';
import { StaffIdentityApiError, staffIdentityRequest } from '../lib/staffIdentityClient.js';

const MANAGER = {
  id: '11111111-1111-4111-8111-111111111111',
  pin: '2380',
  name: 'Admin',
  role: 'ADMIN',
  is_active: true,
  updated_at: '2026-08-29T18:00:00.000Z',
};

function fakeSupabase({ users = [], rpcData = null, rpcError = null } = {}) {
  const rpcCalls = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    order() { return this; }
    rows() {
      const source = this.table === 'users' ? users : [];
      return source.filter((row) => this.filters.every(([field, value]) => String(row?.[field] ?? '') === String(value ?? '')));
    }
    async maybeSingle() {
      const rows = this.rows();
      return { data: rows.length === 1 ? rows[0] : null, error: rows.length > 1 ? { message: 'multiple rows' } : null };
    }
    async limit(count) { return { data: this.rows().slice(0, count), error: null }; }
  }

  return {
    rpcCalls,
    from(table) { return new Query(table); },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return {
        data: rpcData || { ok: true, user: { id: args.p_user_id || args.p_reactivate_user_id || '22222222-2222-4222-8222-222222222222', pin: args.p_pin } },
        error: rpcError,
      };
    },
  };
}

async function expectMutationError(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof StaffIdentityMutationError, `expected StaffIdentityMutationError for ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

assert.equal(normalizeStaffName('  Blerim   Kosumi '), 'BLERIM KOSUMI');
assert.deepEqual(
  sanitizeStaffIdentityPatch({
    name: ' Bujar Oruqi ',
    pin: '7311',
    role: 'puntor',
    salary: '700',
    is_active: true,
    is_master: true,
    actor_pin: '9999',
    created_at: 'forged',
  }),
  { name: 'Bujar Oruqi', role: 'PUNTOR', pin: '7311', is_active: true, salary: 700 },
  'server patch allowlist must discard identity escalation and forged audit fields',
);

{
  const dispatch = { ...MANAGER, id: '10101010-1010-4010-8010-101010101010', role: 'DISPATCH' };
  const db = fakeSupabase();
  await expectMutationError(runStaffIdentityMutation({
    action: 'CREATE',
    idempotencyKey: 'dispatch-cannot-create-1',
    patch: { name: 'Punetor Nga Dispatch', role: 'PUNTOR', pin: '4322' },
  }, { supabase: db, authUser: dispatch }), 'STAFF_ACTOR_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0, 'DISPATCH is operational and must not administer staff identities');
}

{
  const db = fakeSupabase();
  await expectMutationError(runStaffIdentityMutation({
    action: 'CREATE',
    idempotencyKey: 'admin-cannot-promote-1',
    patch: { name: 'Privileged User', role: 'SUPERADMIN', pin: '4323' },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_ROLE_ASSIGNMENT_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0, 'an actor must not assign a staff role above their own');
}

{
  const owner = {
    id: '20202020-2020-4020-8020-202020202020',
    pin: '2381',
    name: 'Owner',
    role: 'OWNER',
    is_active: true,
    updated_at: '2026-08-29T18:10:00.000Z',
  };
  const db = fakeSupabase({ users: [owner] });
  await expectMutationError(runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'admin-cannot-edit-owner-1',
    userId: owner.id,
    expectedCurrentPin: owner.pin,
    expectedUpdatedAt: owner.updated_at,
    patch: { name: 'Owner Edited' },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_TARGET_ROLE_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0, 'a lower-role actor must not mutate a higher-role target');
}

{
  const db = fakeSupabase({ users: [MANAGER] });
  await expectMutationError(runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'admin-cannot-change-own-role-1',
    userId: MANAGER.id,
    expectedCurrentPin: MANAGER.pin,
    expectedUpdatedAt: MANAGER.updated_at,
    patch: { role: 'PUNTOR' },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_SELF_ROLE_CHANGE_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0, 'an actor must not change their own role');
}

{
  const db = fakeSupabase({
    users: [{ id: '22222222-2222-4222-8222-222222222222', pin: '6666', name: '  Blerim Kosumi ', role: 'TRANSPORT', is_active: false }],
    rpcError: { code: 'P0001', message: 'STAFF_NAME_MATCH_REQUIRES_REACTIVATION' },
  });
  const error = await expectMutationError(runStaffIdentityMutation({
    action: 'CREATE',
    idempotencyKey: 'create-blerim-1',
    actorPin: '9999',
    patch: { name: 'BLERIM   KOSUMI', role: 'TRANSPORT', pin: '7422' },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_NAME_MATCH_REQUIRES_REACTIVATION');
  assert.equal(error.extra.can_reactivate, true);
  assert.equal(error.extra.existing_user.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(db.rpcCalls.length, 1, 'the atomic RPC must own the conflict decision before the API offers reactivation');
}

{
  const db = fakeSupabase();
  await runStaffIdentityMutation({
    action: 'CREATE',
    idempotencyKey: 'create-worker-1',
    actorPin: '9999',
    patch: {
      name: 'Punetor I Ri',
      role: 'PUNTOR',
      pin: '4321',
      is_master: true,
      pay_ready_bonus_enabled: true,
    },
  }, { supabase: db, authUser: MANAGER });
  assert.equal(db.rpcCalls.length, 1);
  const call = db.rpcCalls[0];
  assert.equal(call.name, 'save_staff_identity_v1');
  assert.equal(call.args.p_actor_pin, MANAGER.pin, 'RPC actor must come from the approved server session');
  assert.equal(call.args.p_pin, '4321');
  assert.deepEqual(call.args.p_patch, {
    pay_ready_bonus_enabled: true,
    idempotency_key: `staff:${MANAGER.id}:create-worker-1`,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(call.args.p_patch, 'is_master'), false);
}

{
  const worker = { id: '33333333-3333-4333-8333-333333333333', pin: '7311', name: 'Bujar Oruqi', role: 'PUNTOR', is_active: true, updated_at: '2026-08-29T20:00:00.000Z' };
  const db = fakeSupabase({ users: [worker] });
  await runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'update-bujar-1',
    userId: worker.id,
    expectedCurrentPin: '7311',
    expectedUpdatedAt: worker.updated_at,
    actorPin: '9999',
    patch: { pin: '7711', salary: 750 },
  }, { supabase: db, authUser: MANAGER });
  const args = db.rpcCalls[0].args;
  assert.equal(args.p_actor_pin, MANAGER.pin);
  assert.equal(args.p_pin, '7711');
  assert.equal(args.p_patch.expected_current_pin, '7311', 'RPC must atomically reject a stale PIN change');
  assert.equal(args.p_patch.expected_updated_at, worker.updated_at, 'RPC must atomically reject any stale staff edit');
  assert.equal(args.p_patch.idempotency_key, `staff:${MANAGER.id}:update-bujar-1`);
  assert.equal(args.p_patch.salary, 750);
}

{
  const worker = { id: '33333333-3333-4333-8333-333333333333', pin: '7711', name: 'Bujar Oruqi', role: 'PUNTOR', is_active: true, updated_at: '2026-08-29T20:01:00.000Z' };
  const db = fakeSupabase({ users: [worker], rpcError: { code: 'P0001', message: 'STAFF_CURRENT_PIN_STALE expected=7311 actual=7711' } });
  await expectMutationError(runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'update-bujar-2',
    userId: worker.id,
    expectedCurrentPin: '7311',
    expectedUpdatedAt: '2026-08-29T20:00:00.000Z',
    patch: { pin: '8822' },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_PIN_CHANGED');
  assert.equal(db.rpcCalls.length, 1);
}

{
  const inactive = { id: '44444444-4444-4444-8444-444444444444', pin: '6666', name: 'Blerim Kosumi', role: 'TRANSPORT', is_active: false, updated_at: '2026-08-29T19:00:00.000Z' };
  const db = fakeSupabase({ users: [inactive] });
  await runStaffIdentityMutation({
    action: 'REACTIVATE',
    idempotencyKey: 'reactivate-blerim-1',
    reactivateUserId: inactive.id,
    expectedCurrentPin: '6666',
    expectedUpdatedAt: inactive.updated_at,
    patch: { name: 'Blerim Kosumi', role: 'TRANSPORT', pin: '7422' },
  }, { supabase: db, authUser: MANAGER });
  const args = db.rpcCalls[0].args;
  assert.equal(args.p_action, 'REACTIVATE');
  assert.equal(args.p_reactivate_user_id, inactive.id, 'reactivation must target an explicit UUID');
  assert.equal(args.p_patch.expected_current_pin, '6666');
  assert.equal(args.p_patch.expected_updated_at, inactive.updated_at);
  assert.equal(args.p_pin, '7422');
}

{
  const db = fakeSupabase({ users: [MANAGER] });
  await expectMutationError(runStaffIdentityMutation({
    action: 'DEACTIVATE',
    idempotencyKey: 'deactivate-self-1',
    userId: MANAGER.id,
    expectedCurrentPin: MANAGER.pin,
    expectedUpdatedAt: MANAGER.updated_at,
  }, { supabase: db, authUser: MANAGER }), 'STAFF_SELF_DEACTIVATE_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0);
}

{
  const db = fakeSupabase({ users: [MANAGER] });
  await expectMutationError(runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'update-self-inactive-1',
    userId: MANAGER.id,
    expectedCurrentPin: MANAGER.pin,
    expectedUpdatedAt: MANAGER.updated_at,
    patch: { is_active: false },
  }, { supabase: db, authUser: MANAGER }), 'STAFF_SELF_DEACTIVATE_NOT_ALLOWED');
  assert.equal(db.rpcCalls.length, 0, 'UPDATE must not bypass the self-deactivation guard');
}

{
  // A response-lost retry reaches the RPC with the original stale guards.
  // The RPC idempotency log returns the first committed result before checking
  // the now-changed row, so the API must not reject it during its read phase.
  const changed = { id: '55555555-5555-4555-8555-555555555555', pin: '7711', name: 'Retry Worker', role: 'PUNTOR', is_active: true, updated_at: '2026-08-29T21:01:00.000Z' };
  const db = fakeSupabase({ users: [changed], rpcData: { ok: true, user: changed, idempotency_key: 'existing' } });
  const result = await runStaffIdentityMutation({
    action: 'UPDATE',
    idempotencyKey: 'lost-response-retry-1',
    userId: changed.id,
    expectedCurrentPin: '7311',
    expectedUpdatedAt: '2026-08-29T21:00:00.000Z',
    patch: { pin: '7711' },
  }, { supabase: db, authUser: MANAGER });
  assert.equal(result.user.pin, '7711');
  assert.equal(db.rpcCalls[0].args.p_patch.expected_current_pin, '7311');
  assert.equal(db.rpcCalls[0].args.p_patch.expected_updated_at, '2026-08-29T21:00:00.000Z');
}

{
  let request = null;
  const result = await staffIdentityRequest({ action: 'DEACTIVATE', userId: 'abc' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return { ok: true, action: 'DEACTIVATE' }; } };
    },
  });
  assert.equal(result.action, 'DEACTIVATE');
  assert.equal(request.url, '/api/admin/staff-identity');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(request.options.body), 'actorPin'), false);
  assert.ok(String(JSON.parse(request.options.body).idempotencyKey || '').length >= 8);

  let conflictAttempts = 0;
  await assert.rejects(
    staffIdentityRequest({ action: 'CREATE' }, {
      fetchImpl: async () => {
        conflictAttempts += 1;
        return {
          ok: false,
          status: 409,
          async json() {
            return {
              ok: false,
              error: 'STAFF_NAME_MATCH_REQUIRES_REACTIVATION',
              can_reactivate: true,
              existing_user: { id: 'x', name: 'Blerim Kosumi', is_active: false },
            };
          },
        };
      },
    }),
    (error) => error instanceof StaffIdentityApiError
      && error.code === 'STAFF_NAME_MATCH_REQUIRES_REACTIVATION'
      && error.canReactivate === true
      && error.existingUser?.id === 'x',
  );
  assert.equal(conflictAttempts, 1, '4xx business conflicts must never be retried');
}

{
  const bodies = [];
  let attempts = 0;
  const response = await staffIdentityRequest({ action: 'UPDATE', userId: 'abc' }, {
    fetchImpl: async (_url, options) => {
      attempts += 1;
      bodies.push(options.body);
      if (attempts === 1) throw new Error('transient network loss');
      return { ok: true, status: 200, async json() { return { ok: true, action: 'UPDATE' }; } };
    },
  });
  assert.equal(response.action, 'UPDATE');
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1], 'network retry must reuse the exact same idempotency key and payload');
}

const endpoint = fs.readFileSync('api/admin/staff-identity.js', 'utf8');
const usersService = fs.readFileSync('lib/usersService.js', 'utf8');
const usersDb = fs.readFileSync('lib/usersDb.js', 'utf8');
const login = fs.readFileSync('api/auth/login.js', 'utf8');
const staffPage = fs.readFileSync('app/arka/stafi/page.jsx', 'utf8');
const payrollPage = fs.readFileSync('app/arka/payroll/page.jsx', 'utf8');
const server = fs.readFileSync('server/index.mjs', 'utf8');
const staffServer = fs.readFileSync('lib/staffIdentityServer.js', 'utf8');

assert.match(endpoint, /tepiha_device_id/);
assert.match(endpoint, /authenticateStaffManager/);
assert.match(endpoint, /createAdminClientOrThrow/);
assert.match(endpoint, /ORIGIN_NOT_ALLOWED/);
assert.doesNotMatch(endpoint, /NEXT_PUBLIC_[A-Z_]*SERVICE/);
assert.match(server, /\/api\/admin\/staff-identity/);
assert.match(server, /DEVICE_LINKED_TO_OTHER_USER/, 'local login must not reassign a device to a different staff identity');
assert.match(usersService, /action: 'DEACTIVATE'/);
assert.match(usersService, /reactivateUserRecord/);
assert.doesNotMatch(usersService, /\.from\(USERS_TABLE\)\s*\.delete\(/s, 'staff removal must never delete a user');
assert.doesNotMatch(usersService, /DEL\$\{|archivedPin|buildArchivedPin/, 'deactivation must not free a PIN by renaming it');
assert.doesNotMatch(usersDb, /\.from\(WRITE_TABLE\)\s*\.delete\(/s, 'legacy staff removal must never delete a user');
assert.doesNotMatch(usersDb, /archivedPin|`DEL/, 'legacy deactivation must not free a PIN');
assert.match(staffPage, /canReactivate/);
assert.match(staffPage, /reactivateUserRecord\(existing\.id/);
assert.match(staffPage, /isStaffAdmin\(role\)/, 'Stafi route guard must use the stricter staff-admin role boundary');
assert.match(staffPage, /isStaffAdmin\(normalizedRole\)/, 'Stafi UI permissions must exclude operational DISPATCH');
assert.match(staffServer, /STAFF_ADMIN_ROLES/);
assert.match(staffServer, /STAFF_SELF_ROLE_CHANGE_NOT_ALLOWED/);
assert.match(staffServer, /STAFF_TARGET_ROLE_NOT_ALLOWED/);
assert.match(payrollPage, /updateUserRecord\(\s*salaryModal\.id,[\s\S]*expectedCurrentPin:[\s\S]*expectedUpdatedAt:/, 'manual advance transfer must use the guarded staff API with stale-state proof');
assert.doesNotMatch(payrollPage, /\.from\(["']users["']\)[\s\S]{0,160}\.update\([\s\S]{0,160}avans_manual/, 'payroll must not bypass the staff API with a browser users update');
assert.match(payrollPage, /const canManageStaffIdentity = isStaffAdmin\(normalizedRole\)/, 'Payroll must keep finance access separate from staff-identity mutation authority');
assert.match(payrollPage, /canManageStaffIdentity \? \([\s\S]*href="\/arka\/stafi"[\s\S]*DISPATCH: PAYROLL PA NDRYSHIME TË STAFIT/, 'DISPATCH must not see the staff-management navigation affordance');
assert.match(payrollPage, /editingId && canManageStaffIdentity &&/, 'Payroll staff editor must not render for DISPATCH');
assert.match(payrollPage, /\{canManageStaffIdentity \? \([\s\S]{0,500}EDITO RROGËN \/ PARAMETRAT[\s\S]{0,80}\) : null\}/, 'Payroll staff mutation button must not render for DISPATCH');
assert.match(login, /\.from\('users'\)[\s\S]*\.eq\('pin', pin\)/, 'login must authenticate only a current users.pin row');

console.log('PASS staff identity API V1: approved manager auth, service-role RPC, stale PIN guard, explicit reactivation, and non-destructive deactivation verified.');
