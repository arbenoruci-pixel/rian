import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  authenticateTransportSelfEntryActor,
  createTransportSelfEntryOrderServer,
} from '../lib/transport/transportSelfEntryServer.js';
import { sanitizeTransportOrderPayload } from '../lib/transport/sanitize.js';

const actor = {
  id: 'e0f09793-1d9d-4e46-8f67-e9cba9a4fc91',
  pin: '9999',
  name: 'TEST TRANSPORT',
  role: 'TRANSPORT',
  actualRole: 'TRANSPORT',
  deviceId: 'device-transport-test',
};
const orderId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const leaseToken = '33333333-3333-4333-8333-333333333333';

function createFakeSupabase(options = {}) {
  const state = {
    order: null,
    rpcArgs: null,
    pool: options.pool || null,
    lease: options.lease || null,
    finalCode: options.finalCode || 'T1300',
  };
  return {
    state,
    from(table) {
      const filters = {};
      const builder = {
        select() { return builder; },
        eq(key, value) { filters[key] = value; return builder; },
        maybeSingle: async () => {
          if (table === 'transport_orders') return { data: state.order, error: null };
          if (table === 'transport_code_pool') {
            const matches = state.pool && (!filters.code || filters.code === state.pool.code);
            return { data: matches ? state.pool : null, error: null };
          }
          if (table === 'offline_code_leases') {
            const matches = state.lease && (!filters.lease_token || filters.lease_token === state.lease.lease_token);
            return { data: matches ? state.lease : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(name, args) {
      if (name === 'finalize_transport_offline_code') {
        assert.equal(args.p_lease_token, state.lease?.lease_token);
        assert.equal(args.p_device_id, state.lease?.device_id);
        assert.equal(args.p_draft_session_id, state.order?.id);
        const finalCode = state.order?.client_tcode;
        state.lease = {
          ...state.lease,
          status: finalCode === state.lease.code ? 'consumed' : 'released',
          draft_session_id: state.order.id,
          order_id: state.order.id,
        };
        return {
          data: {
            ok: true,
            code: state.lease.code,
            final_code: finalCode,
            consumed: state.lease.status === 'consumed',
            released: state.lease.status === 'released',
          },
          error: null,
        };
      }
      assert.equal(name, 'create_transport_order');
      state.rpcArgs = args;
      const code = state.finalCode;
      const { offline_code_lease: strippedLease, ...storedData } = args.p_data;
      if (strippedLease && state.lease) {
        state.lease = {
          ...state.lease,
          status: code === strippedLease.code ? 'consumed' : 'released',
          draft_session_id: strippedLease.draft_session_id,
          order_id: args.p_id,
        };
      }
      state.order = {
        id: args.p_id,
        code_n: 1300,
        code_str: code,
        client_tcode: code,
        client_id: clientId,
        client_name: args.p_client_name,
        client_phone: args.p_client_phone,
        visit_nr: 1,
        status: args.p_status,
        transport_create_fingerprint_v1: args.p_data.transport_create_fingerprint_v1,
        data: {
          ...storedData,
          client_id: clientId,
          code_str: code,
          order_code: code,
          client_tcode: code,
          transport_client_tcode: code,
          client: {
            ...args.p_data.client,
            id: clientId,
            tcode: code,
            client_tcode: code,
            transport_client_tcode: code,
          },
        },
      };
      return {
        data: {
          success: true,
          order_id: args.p_id,
          client_id: clientId,
          code_str: code,
          client_tcode: code,
          visit_nr: 1,
          idempotent: false,
        },
        error: null,
      };
    },
  };
}

const supabase = createFakeSupabase();
const body = {
  id: orderId,
  client_name: 'KLIENT TEST',
  client_phone: '+38344111222',
  data: {
    queued_actor_id: actor.id,
    transport_id: actor.id,
    client_name: 'KLIENT TEST',
    client_phone: '+38344111222',
    client: { name: 'KLIENT TEST', phone: '+38344111222' },
    tepiha: [
      { id: 'a', m2: '5.8', qty: '1' },
      { id: 'b', m2: '3.7', qty: '1' },
      { id: 'c', m2: '2.0', qty: '1' },
      { id: 'd', m2: '1.0', qty: '1' },
    ],
    staza: [],
    shkallore: { qty: 0, per: 0.3 },
    pay: { rate: 1.8, paid: 0 },
    pickup_date: '2026-08-31',
    pickup_slot: 'paradite',
    pickup_window: '08:00-12:00',
  },
};

const created = await createTransportSelfEntryOrderServer(body, { supabase, authUser: actor });
assert.equal(created.ok, true);
assert.equal(created.data.id, orderId);
assert.equal(supabase.state.rpcArgs.p_code_n, null);
assert.equal(supabase.state.rpcArgs.p_code_str, null);
assert.equal(supabase.state.rpcArgs.p_data.transport_id, actor.id);
assert.equal(supabase.state.rpcArgs.p_data.created_by_role, 'TRANSPORT');
assert.equal(supabase.state.rpcArgs.p_data.tepiha.length, 4);
assert.equal(supabase.state.rpcArgs.p_data.pay.m2, 12.5);
assert.equal(supabase.state.rpcArgs.p_data.pay.euro, 22.5);

const retried = await createTransportSelfEntryOrderServer(body, { supabase, authUser: actor });
assert.equal(retried.ok, true);
assert.equal(retried.idempotent, true);
assert.equal(supabase.state.order.id, orderId);

await assert.rejects(
  createTransportSelfEntryOrderServer({
    ...body,
    data: { ...body.data, notes: 'PAYLOAD I NDRYSHUAR' },
  }, { supabase, authUser: actor }),
  (error) => error?.code === 'TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT'
    && error?.httpStatus === 409,
  'same UUID with changed canonical business data must conflict',
);

const reservationOnlyRetry = await createTransportSelfEntryOrderServer({
  ...body,
  code_str: 'T9999',
}, { supabase, authUser: actor });
assert.equal(reservationOnlyRetry.idempotent, true, 'ephemeral supplied code must not change the business fingerprint');

function offlineLeaseBody({ id, code, token = leaseToken, device = actor.deviceId, notes = '' }) {
  const lease = {
    version: 'offline-code-bank-v1',
    scope: 'transport',
    code,
    owner_id: actor.id,
    device_id: device,
    lease_token: token,
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    draft_session_id: id,
    state: 'assigned',
    source: 'CALLER_METADATA_MUST_NOT_BE_TRUSTED',
  };
  return {
    ...body,
    id,
    code_str: code,
    client_tcode: code,
    offline_code_lease: lease,
    data: {
      ...body.data,
      ...(notes ? { notes } : {}),
      code_str: code,
      client_tcode: code,
      offline_code_lease: lease,
    },
  };
}

const offlineOrderId = '44444444-4444-4444-8444-444444444444';
const offlineCode = 'T1400';
const offlineSupabase = createFakeSupabase({
  finalCode: offlineCode,
  pool: { code: offlineCode, status: 'used', owner_id: actor.id },
  lease: {
    lease_token: leaseToken,
    scope: 'transport',
    code: offlineCode,
    owner_id: actor.id,
    device_id: actor.deviceId,
    draft_session_id: null,
    status: 'available',
    expires_at: '2099-01-01T00:00:00.000Z',
    order_id: null,
  },
});
const offlineBody = offlineLeaseBody({ id: offlineOrderId, code: offlineCode });
const offlineCreated = await createTransportSelfEntryOrderServer(
  offlineBody,
  { supabase: offlineSupabase, authUser: actor },
);
assert.equal(offlineCreated.offlineLeaseResult?.consumed, true);
assert.equal(offlineCreated.offlineLeaseResult?.final_code, offlineCode);
assert.deepEqual(offlineSupabase.state.rpcArgs.p_data.offline_code_lease, {
  scope: 'transport',
  code: offlineCode,
  owner_id: actor.id,
  device_id: actor.deviceId,
  lease_token: leaseToken,
  draft_session_id: offlineOrderId,
});
assert.equal(
  Object.prototype.hasOwnProperty.call(offlineSupabase.state.order.data, 'offline_code_lease'),
  false,
  'DB trigger contract must strip the lease secret from stored business JSON',
);

const offlineRetry = await createTransportSelfEntryOrderServer({
  ...offlineBody,
  offline_code_lease: {
    ...offlineBody.offline_code_lease,
    lease_expires_at: '2098-01-01T00:00:00.000Z',
    source: 'RETRY_METADATA_CHANGED',
  },
  data: {
    ...offlineBody.data,
    offline_code_lease: {
      ...offlineBody.data.offline_code_lease,
      lease_expires_at: '2098-01-01T00:00:00.000Z',
      source: 'RETRY_METADATA_CHANGED',
    },
  },
}, { supabase: offlineSupabase, authUser: actor });
assert.equal(offlineRetry.idempotent, true);
assert.equal(offlineRetry.fingerprint, offlineCreated.fingerprint, 'lease metadata must not affect the business fingerprint');
assert.equal(offlineRetry.offlineLeaseResult?.consumed, true);

await assert.rejects(
  createTransportSelfEntryOrderServer(
    offlineLeaseBody({ id: offlineOrderId, code: offlineCode, device: 'device-attacker-test' }),
    { supabase: offlineSupabase, authUser: actor },
  ),
  (error) => error?.code === 'TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DEVICE_MISMATCH'
    && error?.httpStatus === 403,
  'offline lease must be pinned to the authenticated device cookie',
);

const canonicalOrderId = '55555555-5555-4555-8555-555555555555';
const supersededCode = 'T1401';
const canonicalSupabase = createFakeSupabase({
  finalCode: 'T1300',
  pool: { code: supersededCode, status: 'used', owner_id: actor.id },
  lease: {
    lease_token: leaseToken,
    scope: 'transport',
    code: supersededCode,
    owner_id: actor.id,
    device_id: actor.deviceId,
    draft_session_id: null,
    status: 'available',
    expires_at: '2099-01-01T00:00:00.000Z',
    order_id: null,
  },
});
const canonicalCreated = await createTransportSelfEntryOrderServer(
  offlineLeaseBody({ id: canonicalOrderId, code: supersededCode }),
  { supabase: canonicalSupabase, authUser: actor },
);
assert.equal(canonicalCreated.data.client_tcode, 'T1300');
assert.equal(canonicalCreated.offlineLeaseResult?.released, true);
assert.equal(canonicalCreated.offlineLeaseResult?.code, supersededCode);
assert.equal(canonicalCreated.offlineLeaseResult?.final_code, 'T1300');

const authRows = {
  tepiha_user_devices: { user_id: actor.id, is_approved: true },
  users: {
    id: actor.id,
    pin: actor.pin,
    name: 'HYBRID TEST',
    role: 'PUNTOR',
    is_active: true,
    is_hybrid_transport: true,
    transport_id: null,
    tid: null,
  },
};
const authSupabase = {
  from(table) {
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      maybeSingle: async () => ({ data: authRows[table] || null, error: null }),
    };
    return builder;
  },
};
const hybrid = await authenticateTransportSelfEntryActor(authSupabase, 'device-test');
assert.equal(hybrid.role, 'TRANSPORT');
assert.equal(hybrid.actualRole, 'PUNTOR');

const identityInput = {
  id: orderId,
  code_str: 'T1279',
  client_tcode: 'T1279',
  code_n: 1279,
  visit_nr: 3,
  status: 'pickup',
  data: { code_str: 'T1279', client_tcode: 'T1279', tepiha: [{ m2: 3.7, qty: 1 }] },
};
const createPayload = sanitizeTransportOrderPayload(identityInput);
const updatePayload = sanitizeTransportOrderPayload(identityInput, { patch: true });
assert.equal(createPayload.code_str, 'T1279');
for (const key of ['id', 'client_id', 'code_str', 'client_tcode', 'code_n', 'visit_nr']) {
  assert.equal(Object.prototype.hasOwnProperty.call(updatePayload, key), false, `patch leaked ${key}`);
}
assert.equal(updatePayload.status, 'pickup');
assert.equal(Array.isArray(updatePayload.data.tepiha), true);

const pranimi = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const transportDb = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const offlineRoute = fs.readFileSync('app/api/offline-sync/route.js', 'utf8');
const guardMigration = fs.readFileSync('supabase/migrations/20260831113000_transport_code_pool_guard_trigger_v1.sql', 'utf8');
assert.match(pranimi, /serverAllocatesOnlineTcode/);
assert.match(pranimi, /transport_tcode_allocation_mode: 'ATOMIC_DB'/);
assert.match(pranimi, /navigator\.vibrate\(24\)/);
assert.match(pranimi, /'✓ '/);
assert.match(transportDb, /fetch\('\/api\/transport\/self-order'/);
assert.match(offlineRoute, /table, \{ patch: true \}/);
assert.doesNotMatch(guardMigration, /update\s+public\.transport_code_pool/i);
assert.doesNotMatch(guardMigration, /insert\s+into\s+public\.transport_code_pool/i);
assert.match(guardMigration, /TRANSPORT_ORDER_IDENTITY_IMMUTABLE/);
assert.match(guardMigration, /create trigger trg_z_transport_order_identity_guard_v1/);

console.log('PASS: Transport save recovery keeps measurements, uses server allocation, strips immutable edit columns, supports hybrid Transport, and guards the pool without browser mutation.');
