import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DispatchOrderServerError,
  createDispatchTransportPranimiOrderServer,
} from '../lib/transport/dispatchOrderServer.js';

const ACTOR = {
  id: '11111111-1111-4111-8111-111111111111',
  pin: '4563',
  name: 'Admin Pranimi',
  role: 'ADMIN',
};
const DRIVER = {
  id: '22222222-2222-4222-8222-222222222222',
  pin: '9012',
  name: 'Shoferi UUID',
  role: 'TRANSPORT',
  is_active: true,
  is_hybrid_transport: false,
};
const HYBRID = {
  id: '33333333-3333-4333-8333-333333333333',
  pin: '7788',
  name: 'Hybrid UUID',
  role: 'PUNTOR',
  is_active: true,
  is_hybrid_transport: true,
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fakeSupabase() {
  const state = {
    orders: [],
    rpcCalls: [],
    users: [{ ...DRIVER }, { ...HYBRID }],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    async maybeSingle() {
      const source = this.table === 'transport_orders' ? state.orders : this.table === 'users' ? state.users : [];
      const rows = source.filter((row) => this.filters.every(([field, value]) => row?.[field] === value));
      return { data: clone(rows[0] || null), error: null };
    }
  }
  const supabase = {
    from(table) { return new Query(table); },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args: clone(args) });
      const clientId = '44444444-4444-4444-8444-444444444444';
      const code = 'T1300';
      const row = {
        id: args.p_id,
        client_id: clientId,
        client_tcode: code,
        code_str: code,
        code_n: 1300,
        client_name: args.p_client_name,
        client_phone: args.p_client_phone,
        visit_nr: 1,
        status: args.p_status,
        transport_create_fingerprint_v1: args.p_data.transport_create_fingerprint_v1,
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
  return { supabase, state };
}

function request(id, assignment = DRIVER.id, overrides = {}) {
  return {
    flow: 'PRANIMI',
    id,
    status: 'assigned',
    client_name: 'Klienti Pranimi',
    client_phone: '+383 44 123 456',
    address: 'Prishtinë',
    transport_id: assignment,
    data: {
      status: 'loaded',
      tepiha: [
        { id: 't1', m2: '3.7', qty: '1' },
        { id: 't2', m2: '5.8', qty: '1' },
      ],
      staza: [
        { id: 's1', m2: '1.2', qty: '1' },
        { id: 's2', m2: '2', qty: '1' },
      ],
      shkallore: { qty: 2, per: 0.3 },
      pay: { m2: 999, euro: 999, paid: 5, rate: 1.8 },
      created_by_pin: '0000',
      created_by_role: 'TRANSPORT',
      transport_pin: '0000',
      driver_name: 'Spoof',
      pickup_date: '2026-08-31',
      pickup_slot: 'morning',
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
  const { supabase, state } = fakeSupabase();
  const body = request('55555555-5555-4555-8555-555555555555');
  const result = await createDispatchTransportPranimiOrderServer(body, { supabase, authUser: ACTOR });
  assert.equal(result.ok, true);
  assert.equal(state.rpcCalls.length, 1);
  const args = state.rpcCalls[0].args;
  assert.equal(args.p_code_n, null);
  assert.equal(args.p_code_str, null);
  assert.equal(args.p_status, 'pickup', 'Pranimi must ignore a caller status and force pickup');
  assert.equal(args.p_data.status, 'pickup');
  assert.equal(args.p_data.transport_id, DRIVER.id);
  assert.equal(args.p_data.transport_user_id, DRIVER.id);
  assert.equal(args.p_data.assigned_driver_id, DRIVER.id);
  assert.equal(args.p_data.transport_pin, DRIVER.pin);
  assert.equal(args.p_data.driver_name, DRIVER.name);
  assert.equal(args.p_data.created_by_pin, ACTOR.pin);
  assert.equal(args.p_data.created_by_role, ACTOR.role);
  assert.equal(args.p_data.transport_create_actor_id, ACTOR.id);
  assert.equal(args.p_data.transport_create_flow, 'PRANIMI');
  assert.equal(args.p_data.transport_assignment_scope, 'DRIVER');
  assert.equal(args.p_data.order_origin, 'TRANSPORT_PRANIMI_ADMIN');
  assert.equal(args.p_data.tepiha.length, 2);
  assert.equal(args.p_data.staza.length, 2);
  assert.equal(args.p_data.pay.m2, 13.3);
  assert.equal(args.p_data.pay.pieces, 6);
  assert.equal(args.p_data.pay.total, 23.94);
  assert.equal(args.p_data.pay.debt, 18.94);

  const retry = await createDispatchTransportPranimiOrderServer(body, {
    supabase,
    authUser: { ...ACTOR, pin: '6543', name: 'Admin Renamed' },
  });
  assert.equal(retry.idempotent, true);
  assert.equal(state.rpcCalls.length, 1, 'an exact UUID retry must not allocate again');

  state.users.find((user) => user.id === DRIVER.id).is_active = false;
  const disabledDriverRetry = await createDispatchTransportPranimiOrderServer(body, { supabase, authUser: ACTOR });
  assert.equal(disabledDriverRetry.idempotent, true);
  assert.equal(state.rpcCalls.length, 1, 'a committed retry must not re-check driver activity');

  await expectCode(
    () => createDispatchTransportPranimiOrderServer(request(body.id, DRIVER.id, {
      data: { ...body.data, tepiha: [...body.data.tepiha, { id: 't3', m2: 1, qty: 1 }] },
    }), { supabase, authUser: ACTOR }),
    'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
  );
  await expectCode(
    () => createDispatchTransportPranimiOrderServer(request(body.id, HYBRID.id), { supabase, authUser: ACTOR }),
    'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
  );
}

{
  const { supabase, state } = fakeSupabase();
  const result = await createDispatchTransportPranimiOrderServer(
    request('66666666-6666-4666-8666-666666666666', ''),
    { supabase, authUser: ACTOR },
  );
  assert.equal(result.ok, true);
  const data = state.rpcCalls[0].args.p_data;
  assert.equal(data.transport_assignment_scope, 'ADMIN_ONLY');
  assert.equal(data.transport_id, null);
  assert.equal(data.transport_user_id, null);
  assert.equal(data.assigned_driver_id, null);
  assert.equal(data.transport_pin, null);
  assert.equal(data.driver_pin, null);
}

{
  const { supabase, state } = fakeSupabase();
  const result = await createDispatchTransportPranimiOrderServer(
    request('77777777-7777-4777-8777-777777777777', HYBRID.id),
    { supabase, authUser: ACTOR },
  );
  assert.equal(result.ok, true);
  assert.equal(state.rpcCalls[0].args.p_data.transport_id, HYBRID.id);
  assert.equal(state.rpcCalls[0].args.p_data.transport_pin, HYBRID.pin);
}

{
  const { supabase, state } = fakeSupabase();
  state.users.find((user) => user.id === DRIVER.id).is_active = false;
  await expectCode(
    () => createDispatchTransportPranimiOrderServer(
      request('88888888-8888-4888-8888-888888888888'),
      { supabase, authUser: ACTOR },
    ),
    'DISPATCH_DRIVER_NOT_AVAILABLE',
  );
  assert.equal(state.rpcCalls.length, 0);
}

{
  const { supabase, state } = fakeSupabase();
  await expectCode(
    () => createDispatchTransportPranimiOrderServer(
      request('99999999-9999-4999-8999-999999999999', DRIVER.id, { code_str: 'T77' }),
      { supabase, authUser: ACTOR },
    ),
    'DISPATCH_PRANIMI_OFFLINE_CODE_UNSUPPORTED',
  );
  assert.equal(state.rpcCalls.length, 0, 'a supplied/offline code must fail before DB mutation');
}

{
  const endpoint = fs.readFileSync(new URL('../api/transport/order.js', import.meta.url), 'utf8');
  const db = fs.readFileSync(new URL('../lib/transport/transportDb.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../app/transport/pranimi/page.jsx', import.meta.url), 'utf8');
  assert.match(endpoint, /flow === 'PRANIMI'/);
  assert.match(db, /useAdminPranimiServerCreate/);
  assert.match(db, /flow: 'PRANIMI'/);
  assert.match(page, /transport_create_flow: 'PRANIMI'/);
  assert.match(page, /<option value="">VETËM ADMIN<\/option>/);
  assert.match(page, /<option key=\{user\.id\} value=\{user\.id\}>/);
  assert.match(page, /looksUuid\(expectedTid\)/, 'legacy PIN transport_id must not reject a canonical UUID row');
  assert.match(page, /ASNJË T-KOD NUK U REZERVUA/);
  assert.match(page, /allowOfflineQueue: !currentIsPranimiAdmin/);
  assert.match(page, /!currentIsPranimiAdmin && !e\?\.noOfflineQueue && browserOfflineNow/);
  assert.doesNotMatch(page, /from '@\/lib\/usersDb'/, 'Pranimi must not load the full staff/PIN directory');
  assert.match(page, /select\('id,name,role,is_active,is_hybrid_transport'\)/);
  assert.doesNotMatch(page, /select\('[^']*pin[^']*'\)/, 'driver dropdown must not fetch PINs');
}

console.log('PASS verify-transport-admin-pranimi-server-v1');
