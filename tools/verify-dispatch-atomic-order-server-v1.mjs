import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DispatchOrderServerError,
  authenticateDispatchOrderActor,
  buildDispatchOrderFingerprint,
  createDispatchTransportOrderServer,
} from '../lib/transport/dispatchOrderServer.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = {
  id: '22222222-2222-4222-8222-222222222222',
  pin: '4563',
  name: 'Dispatch Pro',
  role: 'DISPATCH',
};
const DRIVER = {
  id: '33333333-3333-4333-8333-333333333333',
  pin: '9012',
  name: 'Shoferi Pro',
  role: 'TRANSPORT',
  is_active: true,
  is_hybrid_transport: false,
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fakeSupabase({ rpcMode = 'success', approved = true } = {}) {
  const state = {
    orders: [],
    rpcCalls: [],
    users: [
      { ...ACTOR, is_active: true },
      { ...DRIVER },
    ],
    devices: [{ device_id: 'device-verified', user_id: ACTOR.id, is_approved: approved }],
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.columns = '*';
    }
    select(columns) { this.columns = columns; return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    matching() {
      const source = this.table === 'transport_orders'
        ? state.orders
        : this.table === 'tepiha_user_devices'
          ? state.devices
          : this.table === 'users'
            ? state.users
            : [];
      return source.filter((row) => this.filters.every(([field, value]) => row?.[field] === value));
    }
    async maybeSingle() {
      const rows = this.matching();
      if (rows.length > 1) return { data: null, error: { message: 'MULTIPLE_ROWS' } };
      return { data: clone(rows[0] || null), error: null };
    }
  }

  const supabase = {
    from(table) { return new Query(table); },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args: clone(args) });
      if (rpcMode === 'error') return { data: null, error: { message: 'DB_UNAVAILABLE' } };
      if (rpcMode === 'business-failure') return { data: { success: false, error: 'TRANSPORT_PHONE_IDENTITY_CONFLICT' }, error: null };

      const clientId = '44444444-4444-4444-8444-444444444444';
      const code = 'T1234';
      const row = {
        id: args.p_id,
        transport_create_fingerprint_v1: args.p_data.transport_create_fingerprint_v1,
        client_id: clientId,
        client_tcode: code,
        code_str: code,
        code_n: 1234,
        client_name: args.p_client_name,
        client_phone: args.p_client_phone,
        status: args.p_status,
        visit_nr: 1,
        data: {
          ...clone(args.p_data),
          code_str: code,
          order_code: code,
          client_tcode: code,
          transport_client_tcode: code,
          client_id: clientId,
          client: {
            ...clone(args.p_data.client),
            id: clientId,
            tcode: code,
            transport_client_tcode: code,
          },
        },
      };
      state.orders.push(row);
      if (rpcMode === 'mismatch') {
        return { data: { success: true, order_id: args.p_id, client_id: clientId, code_str: 'T9999', client_tcode: 'T9999', visit_nr: 1 }, error: null };
      }
      return {
        data: {
          success: true,
          order_id: args.p_id,
          client_id: clientId,
          code_str: code,
          client_tcode: code,
          visit_nr: 1,
          idempotent: false,
          allocated_in_transaction: true,
        },
        error: null,
      };
    },
  };
  return { supabase, state };
}

function request(overrides = {}) {
  return {
    id: ORDER_ID,
    status: 'assigned',
    client_name: 'Klienti Test',
    client_phone: '+383 44 123 456',
    address: 'Prishtinë',
    transport_id: DRIVER.id,
    code_str: 'T9',
    code_n: 9,
    data: {
      note: 'Shënim',
      pickup_date: '2026-08-31',
      pickup_slot: 'morning',
      pickup_window: '09:00 – 13:00',
      planning_bucket: 'tomorrow',
      planned_pieces: 2,
      pickup_plan: { pieces: 2, items: [{ kind: 'tepiha', m2: 4.5 }] },
      created_by_pin: '9999',
      created_by_role: 'SUPERADMIN',
      code_owner: '9999',
      transport_tcode_allocation_mode: 'SPOOFED',
      transport_pin: '9999',
      driver_name: 'Spoof',
      assigned_at: '1900-01-01T00:00:00Z',
      code_str: 'T9',
      client: {
        name: 'Klienti Test',
        phone: '+383 44 123 456',
        address: 'Prishtinë',
        tcode: 'T9',
      },
    },
    ...overrides,
  };
}

async function expectCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof DispatchOrderServerError);
    assert.equal(error.code, code);
    return true;
  });
}

{
  const a = buildDispatchOrderFingerprint({ b: 2, a: { y: 2, x: 1 } });
  const b = buildDispatchOrderFingerprint({ a: { x: 1, y: 2 }, b: 2 });
  assert.equal(a, b, 'fingerprint must ignore object key insertion order');
  assert.match(a, /^[a-f0-9]{64}$/);
}

{
  const { supabase } = fakeSupabase();
  const actor = await authenticateDispatchOrderActor(supabase, 'device-verified');
  assert.equal(actor.id, ACTOR.id);
  assert.equal(actor.pin, ACTOR.pin);
  assert.equal(actor.role, 'DISPATCH');
}

{
  const { supabase } = fakeSupabase({ approved: false });
  await expectCode(() => authenticateDispatchOrderActor(supabase, 'device-verified'), 'DEVICE_NOT_APPROVED');
}

{
  const { supabase, state } = fakeSupabase();
  const storedActor = state.users.find((user) => user.id === ACTOR.id);
  storedActor.role = 'PUNTOR';
  await expectCode(
    () => authenticateDispatchOrderActor(supabase, 'device-verified'),
    'DISPATCH_ORDER_ACTOR_NOT_ALLOWED',
  );
  await expectCode(
    () => createDispatchTransportOrderServer(request(), {
      supabase,
      authUser: { ...ACTOR, role: 'PUNTOR' },
    }),
    'DISPATCH_ORDER_ACTOR_NOT_ALLOWED',
  );
  assert.equal(state.rpcCalls.length, 0, 'a worker cannot spoof DISPATCH in request JSON');
}

{
  const { supabase, state } = fakeSupabase();
  const result = await createDispatchTransportOrderServer(request(), { supabase, authUser: ACTOR });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(state.rpcCalls.length, 1);
  const args = state.rpcCalls[0].args;
  assert.equal(args.p_code_n, null, 'atomic API must never pre-reserve a code');
  assert.equal(args.p_code_str, null, 'atomic API must never trust a client code');
  assert.equal(args.p_data.created_by_pin, ACTOR.pin);
  assert.equal(args.p_data.created_by_name, ACTOR.name);
  assert.equal(args.p_data.created_by_role, 'DISPATCH');
  assert.equal(args.p_data.code_owner, ACTOR.pin);
  assert.equal(args.p_data.transport_tcode_allocation_mode, 'ATOMIC_DB');
  assert.equal(args.p_data.transport_create_actor_id, ACTOR.id);
  assert.equal(args.p_data.transport_pin, DRIVER.pin);
  assert.equal(args.p_data.driver_name, DRIVER.name);
  assert.equal(args.p_data.code_str, undefined);
  assert.equal(args.p_data.client.tcode, undefined);

  const retry = await createDispatchTransportOrderServer(request({
    code_str: 'T8888',
    data: {
      ...request().data,
      created_by_pin: '0000',
      code_owner: '0000',
      assigned_at: '2100-01-01T00:00:00Z',
    },
  }), { supabase, authUser: ACTOR });
  assert.equal(retry.idempotent, true, 'same business request must reuse the UUID');
  assert.equal(state.rpcCalls.length, 1, 'verified retry must not allocate or call RPC twice');

  const retryAfterPinRotation = await createDispatchTransportOrderServer(request(), {
    supabase,
    authUser: { ...ACTOR, pin: '6543' },
  });
  assert.equal(retryAfterPinRotation.idempotent, true, 'canonical actor UUID must survive a PIN rotation');
  assert.equal(state.rpcCalls.length, 1, 'PIN rotation retry must not allocate or call RPC twice');

  const storedDriver = state.users.find((user) => user.id === DRIVER.id);
  storedDriver.is_active = false;
  const retryAfterDriverDisabled = await createDispatchTransportOrderServer(request(), {
    supabase,
    authUser: ACTOR,
  });
  assert.equal(retryAfterDriverDisabled.idempotent, true, 'committed UUID must survive later driver deactivation');
  assert.equal(state.rpcCalls.length, 1, 'driver deactivation retry must not allocate or call RPC twice');

  await expectCode(() => createDispatchTransportOrderServer(request({
    data: { ...request().data, note: 'Ndryshuar' },
  }), { supabase, authUser: ACTOR }), 'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT');
  assert.equal(state.rpcCalls.length, 1);

  await expectCode(() => createDispatchTransportOrderServer(request({
    data: {
      ...request().data,
      pickup_slot: 'evening',
      pickup_window: '18:00 – 21:00',
    },
  }), { supabase, authUser: ACTOR }), 'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT');
  assert.equal(state.rpcCalls.length, 1, 'edited slot must not create a second visit after a lost response');

  await expectCode(() => createDispatchTransportOrderServer(request({
    transport_id: '55555555-5555-4555-8555-555555555555',
  }), { supabase, authUser: ACTOR }), 'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT');
  assert.equal(state.rpcCalls.length, 1, 'edited driver must not create a second visit after a lost response');

  await expectCode(() => createDispatchTransportOrderServer(request({
    client_phone: '+383 49 999 999',
    data: {
      ...request().data,
      client: { ...request().data.client, phone: '+383 49 999 999' },
    },
  }), { supabase, authUser: ACTOR }), 'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT');
  assert.equal(state.rpcCalls.length, 1);
}

{
  const { supabase } = fakeSupabase({ rpcMode: 'business-failure' });
  await expectCode(
    () => createDispatchTransportOrderServer(request(), { supabase, authUser: ACTOR }),
    'TRANSPORT_PHONE_IDENTITY_CONFLICT',
  );
}

{
  const { supabase } = fakeSupabase({ rpcMode: 'mismatch' });
  await expectCode(
    () => createDispatchTransportOrderServer(request(), { supabase, authUser: ACTOR }),
    'DISPATCH_ORDER_RPC_RESPONSE_MISMATCH',
  );
}

{
  const endpoint = fs.readFileSync(new URL('../api/transport/order.js', import.meta.url), 'utf8');
  assert.match(endpoint, /ORIGIN_NOT_ALLOWED/);
  assert.match(endpoint, /CONTENT_TYPE_NOT_ALLOWED/);
  assert.match(endpoint, /tepiha_device_id/);
  assert.match(endpoint, /createAdminClientOrThrow/);
  assert.match(endpoint, /cache-control.*private, no-store/i);
  const server = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(server, /app\.post\('\/api\/transport\/order', transportOrderHandler\)/);
}

console.log('PASS verify-dispatch-atomic-order-server-v1');
