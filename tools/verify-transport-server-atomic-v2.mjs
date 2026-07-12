import assert from 'node:assert/strict';
import {
  createTransportOrderAtomicServer,
  normalizeTransportPhoneKeyServer,
} from '../lib/transport/transportServer.js';

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.limitCount = null;
    this.patch = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push((row) => String(row?.[column] ?? '') === String(value ?? '')); return this; }
  in(column, values) { const set = new Set((values || []).map(String)); this.filters.push((row) => set.has(String(row?.[column] ?? ''))); return this; }
  limit(value) { this.limitCount = Number(value); return this; }
  update(patch) { this.patch = { ...(patch || {}) }; return this; }
  rows() {
    let rows = Array.isArray(this.db.state[this.table]) ? this.db.state[this.table] : [];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (Number.isFinite(this.limitCount)) rows = rows.slice(0, this.limitCount);
    return rows;
  }
  execute() {
    const rows = this.rows();
    if (this.patch) {
      for (const row of rows) Object.assign(row, this.patch);
    }
    return { data: rows.map((row) => structuredClone(row)), error: null };
  }
  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({ data: result.data[0] || null, error: null });
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

class FakeSupabase {
  constructor({ clients = [], orders = [], pool = [], raceCanonicalTcode = '' } = {}) {
    this.state = {
      transport_clients: structuredClone(clients),
      transport_orders: structuredClone(orders),
      transport_code_pool: structuredClone(pool),
    };
    this.raceCanonicalTcode = raceCanonicalTcode;
    this.calls = { reserve: 0, release: 0, create: 0, createArgs: [] };
  }
  from(table) { return new Query(this, table); }
  async rpc(name, args = {}) {
    if (name === 'reserve_transport_codes_batch') {
      this.calls.reserve += 1;
      const row = this.state.transport_code_pool
        .filter((item) => item.status === 'available')
        .sort((a, b) => Number(String(a.code).replace(/\D/g, '')) - Number(String(b.code).replace(/\D/g, '')))[0];
      if (!row) return { data: null, error: { message: 'NO_CODE' } };
      row.status = 'used';
      row.owner_id = args.p_owner_id;
      return { data: [row.code], error: null };
    }
    if (name === 'release_transport_code_if_unused') {
      this.calls.release += 1;
      const code = String(args.p_code || '').toUpperCase();
      const referenced = this.state.transport_clients.some((row) => String(row.tcode).toUpperCase() === code)
        || this.state.transport_orders.some((row) => String(row.code_str).toUpperCase() === code || String(row.client_tcode).toUpperCase() === code);
      if (referenced) return { data: false, error: null };
      const poolRow = this.state.transport_code_pool.find((row) => String(row.code).toUpperCase() === code);
      if (!poolRow) return { data: false, error: null };
      poolRow.status = 'available';
      poolRow.owner_id = 'POOL';
      return { data: true, error: null };
    }
    if (name === 'create_transport_order') {
      this.calls.create += 1;
      this.calls.createArgs.push(structuredClone(args));
      const phoneKey = normalizeTransportPhoneKeyServer(args.p_client_phone);
      let client = this.state.transport_clients.find((row) => normalizeTransportPhoneKeyServer(row.phone_digits || row.phone) === phoneKey);
      if (!client && this.raceCanonicalTcode) {
        client = {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tcode: this.raceCanonicalTcode,
          name: args.p_client_name,
          phone: args.p_client_phone,
          phone_digits: String(args.p_client_phone).replace(/\D/g, ''),
        };
        this.state.transport_clients.push(client);
      }
      if (!client) {
        client = {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tcode: args.p_code_str,
          name: args.p_client_name,
          phone: args.p_client_phone,
          phone_digits: String(args.p_client_phone).replace(/\D/g, ''),
        };
        this.state.transport_clients.push(client);
      }
      const visitNr = this.state.transport_orders.filter((row) => row.client_tcode === client.tcode).length + 1;
      const data = {
        ...(args.p_data || {}),
        order_id: args.p_id,
        public_order_id: args.p_id,
        transport_client_tcode: client.tcode,
        client: {
          ...((args.p_data || {}).client || {}),
          id: client.id,
          tcode: client.tcode,
          code: client.tcode,
        },
      };
      const order = {
        id: args.p_id,
        code_n: Number(String(args.p_code_str).replace(/\D/g, '')),
        code_str: args.p_code_str,
        client_tcode: client.tcode,
        client_id: client.id,
        client_name: args.p_client_name,
        client_phone: args.p_client_phone,
        visit_nr: visitNr,
        status: args.p_status,
        data,
      };
      this.state.transport_orders.push(order);
      const poolRow = this.state.transport_code_pool.find((row) => String(row.code).toUpperCase() === String(args.p_code_str).toUpperCase());
      if (poolRow) poolRow.status = 'used';
      return { data: { success: true, order_id: order.id, client_id: client.id, client_tcode: client.tcode, code_str: order.code_str, visit_nr: visitNr }, error: null };
    }
    return { data: null, error: { message: `UNKNOWN_RPC:${name}` } };
  }
}

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const RACE_ID = '33333333-3333-4333-8333-333333333333';

{
  const db = new FakeSupabase({
    clients: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', tcode: 'T272', name: 'Mati 1', phone: '38345255074', phone_digits: '38345255074' }],
    orders: [
      { id: '44444444-4444-4444-8444-444444444444', code_str: 'T272', client_tcode: 'T272' },
      { id: '55555555-5555-4555-8555-555555555555', code_str: 'T272', client_tcode: 'T272' },
    ],
    pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }],
  });
  const first = await createTransportOrderAtomicServer(db, {
    id: EXISTING_ID,
    client_name: 'Mati 1',
    client_phone: '045255074',
    status: 'inbox',
  });
  assert.equal(first.data.code_str, 'T272');
  assert.equal(first.data.client_tcode, 'T272');
  assert.equal(first.data.visit_nr, 3);
  assert.equal(db.calls.reserve, 0, 'existing client must not reserve a code');
  assert.equal(db.state.transport_code_pool[0].status, 'available');
  assert.equal(db.calls.createArgs[0].p_client_phone, '38345255074', 'RPC uses canonical stored phone formatting');

  const retry = await createTransportOrderAtomicServer(db, {
    id: EXISTING_ID,
    client_name: 'Mati 1',
    client_phone: '045255074',
    status: 'inbox',
  });
  assert.equal(retry.idempotent, true);
  assert.equal(db.state.transport_orders.filter((row) => row.id === EXISTING_ID).length, 1);
}

{
  const db = new FakeSupabase({
    clients: [{
      id: 'abababab-abab-4bab-8bab-abababababab',
      tcode: 'T88',
      name: 'Klient Shqipëri',
      phone: '355681234567',
      phone_digits: '355681234567',
    }],
    orders: [{ id: 'acacacac-acac-4cac-8cac-acacacacacac', code_str: 'T88', client_tcode: 'T88' }],
    pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }],
  });
  const created = await createTransportOrderAtomicServer(db, {
    id: 'adadadad-adad-4dad-8dad-adadadadadad',
    client_name: 'Klient Shqipëri',
    client_phone: '00355 068 123 4567',
    status: 'inbox',
  });
  assert.equal(created.data.code_str, 'T88');
  assert.equal(created.data.client_tcode, 'T88');
  assert.equal(created.data.visit_nr, 2);
  assert.equal(db.calls.reserve, 0, 'international format variants must not allocate a new T-code');
  assert.equal(db.calls.createArgs[0].p_client_phone, '355681234567', 'RPC uses the stored international phone format');
}

{
  const db = new FakeSupabase({ pool: [
    { code: 'T15', status: 'available', owner_id: 'POOL' },
    { code: 'T5', status: 'available', owner_id: 'POOL' },
  ] });
  const created = await createTransportOrderAtomicServer(db, {
    id: NEW_ID,
    client_name: 'Klient i ri',
    client_phone: '049123456',
    status: 'inbox',
    owner: 'ONLINE_BOOKING',
  });
  assert.equal(created.data.code_str, 'T5');
  assert.equal(created.data.client_tcode, 'T5');
  assert.equal(created.data.visit_nr, 1);
  assert.equal(db.calls.reserve, 1);
  assert.equal(db.state.transport_code_pool.find((row) => row.code === 'T5').status, 'used');
  assert.equal(db.state.transport_code_pool.find((row) => row.code === 'T15').status, 'available');
}

{
  const db = new FakeSupabase({
    clients: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tcode: 'T272', name: 'Existing offline', phone: '38345255074', phone_digits: '38345255074' }],
    pool: [{ code: 'T5', status: 'used', owner_id: 'OFFLINE_SYNC' }],
  });
  const created = await createTransportOrderAtomicServer(db, {
    id: '12121212-1212-4121-8121-121212121212',
    code_str: 'T5',
    client_name: 'Existing offline',
    client_phone: '+383 45 255 074',
    status: 'pickup',
    owner: 'OFFLINE_SYNC',
  });
  assert.equal(created.data.code_str, 'T272');
  assert.equal(created.data.client_tcode, 'T272');
  assert.equal(db.calls.reserve, 0, 'existing offline client cannot reserve another code');
  assert.equal(db.calls.release, 1, 'superseded offline reservation is released');
  assert.equal(db.state.transport_code_pool[0].status, 'available');
}

{
  const db = new FakeSupabase({
    pool: [{ code: 'T9', status: 'used', owner_id: 'OFFLINE_SYNC' }, { code: 'T5', status: 'available', owner_id: 'POOL' }],
  });
  const created = await createTransportOrderAtomicServer(db, {
    id: '13131313-1313-4131-8131-131313131313',
    code_str: 'T9',
    client_name: 'New offline',
    client_phone: '049876543',
    status: 'pickup',
    owner: 'OFFLINE_SYNC',
  });
  assert.equal(created.data.code_str, 'T9');
  assert.equal(created.data.client_tcode, 'T9');
  assert.equal(db.calls.reserve, 0, 'new offline client reuses its one reserved code');
  assert.equal(db.state.transport_code_pool.find((row) => row.code === 'T5').status, 'available');
}

{
  const db = new FakeSupabase({
    pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }],
    raceCanonicalTcode: 'T272',
  });
  const created = await createTransportOrderAtomicServer(db, {
    id: RACE_ID,
    client_name: 'Race client',
    client_phone: '045255074',
    status: 'inbox',
  });
  assert.equal(created.data.code_str, 'T272');
  assert.equal(created.data.client_tcode, 'T272');
  assert.equal(db.calls.reserve, 1);
  assert.equal(db.calls.release, 1);
  assert.equal(db.state.transport_code_pool[0].status, 'available');
}

{
  const historicalId = '66666666-6666-4666-8666-666666666666';
  const db = new FakeSupabase({
    orders: [{
      id: '77777777-7777-4777-8777-777777777777',
      code_str: 'T57',
      client_tcode: 'T57',
      client_id: null,
      client_name: 'Klient historik',
      client_phone: '383491441322',
      data: { client: { phone: '383491441322', tcode: 'T57' } },
    }],
    pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }],
  });
  const created = await createTransportOrderAtomicServer(db, {
    id: historicalId,
    client_name: 'Klient historik',
    client_phone: '0491441322',
    status: 'inbox',
  });
  assert.equal(created.data.code_str, 'T57');
  assert.equal(created.data.client_tcode, 'T57');
  assert.equal(db.calls.reserve, 0, 'one unambiguous historical T-code must be reused');
}

{
  const db = new FakeSupabase({
    orders: [
      { id: '88888888-8888-4888-8888-888888888888', code_str: 'T3', client_tcode: 'T3', client_phone: '044735312', data: {} },
      { id: '99999999-9999-4999-8999-999999999999', code_str: 'T6', client_tcode: 'T6', client_phone: '00383044735312', data: {} },
    ],
    pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }],
  });
  await assert.rejects(
    createTransportOrderAtomicServer(db, {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      client_name: 'Konflikt historik',
      client_phone: '044735312',
    }),
    /TRANSPORT_HISTORICAL_PHONE_TCODE_CONFLICT/,
  );
  assert.equal(db.calls.reserve, 0, 'historical conflict must block before allocation');
}

{
  const db = new FakeSupabase({ pool: [{ code: 'T5', status: 'available', owner_id: 'POOL' }] });
  await assert.rejects(
    createTransportOrderAtomicServer(db, { client_name: 'Bad', client_phone: '1234' }),
    /TRANSPORT_PHONE_INVALID/,
  );
  assert.equal(db.calls.reserve, 0);
  assert.equal(db.calls.create, 0);
}

console.log('PASS: Transport server atomic V2 behavior tests.');
