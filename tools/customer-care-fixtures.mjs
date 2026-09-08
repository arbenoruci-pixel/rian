export const fixtureActor = { id: '22222222-2222-4222-8222-222222222222', name: 'Dispatch Test', role: 'DISPATCH', pin: '9000' };
export const fixtureDriver = { id: '33333333-3333-4333-8333-333333333333', name: 'Driver Test', role: 'TRANSPORT', pin: '9001', is_active: true };
export const fixtureClient = { id: '44444444-4444-4444-8444-444444444444', name: 'Klient Test', notes: 'Telefono para mbërritjes.', updated_at: '2026-09-08T10:00:00.123456+00:00' };
export const fixtureOrder = { id: '11111111-1111-4111-8111-111111111111', client_id: fixtureClient.id, client_tcode: 'T99998', status: 'pastrim', updated_at: fixtureClient.updated_at,
  data: { status: 'pastrim', client: { id: fixtureClient.id, tcode: 'T99998', name: fixtureClient.name }, transport_id: fixtureDriver.id, transport_user_id: fixtureDriver.id, assigned_driver_id: fixtureDriver.id, transport_name: fixtureDriver.name, driver_name: fixtureDriver.name, transport_pin: fixtureDriver.pin, driver_pin: fixtureDriver.pin, assigned_at: '2026-09-07T09:00:00Z', note: 'Shënim i vizitës', rack: 'A12', worker_pin: '9002', tepiha: [{ id: 'carpet1', m2: 5.8, qty: 1, photoUrl: '/sample-photo.jpg' }], staza: [], shkallore: { qty: 0, per: 0.3 }, pay: { rate: 1.8, m2: 5.8, euro: 10.44, paid: 0, arkaRecordedPaid: 0 }, payment_intent: { key: 'untouched' } } };

// In-memory adapter: never contacts Supabase or writes production records.
export function fixtureDatabase() {
  const tables = { transport_orders: [structuredClone(fixtureOrder)], transport_clients: [structuredClone(fixtureClient)], users: [fixtureActor, fixtureDriver], transport_customer_feedback: [] };
  let revision = 0;
  return { tables, conflict: false,
    from(table) {
      let filters = [], newEntry = null, single = false, max = Infinity, sort = null;
      const query = {
        select() { return query; }, eq(key, value) { filters.push((row) => row[key] === value); return query; },
        not(key, _operator, _value) { filters.push((row) => row[key] !== null); return query; },
        order(key, options) { sort = [key, options]; return query; }, limit(value) { max = value; return query; },
        insert(value) { newEntry = structuredClone(value); return query; },
        maybeSingle() { single = true; return query; }, single() { single = true; return query; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (!tables[table]) throw Error('Unknown fixture table: ' + table);
          if (newEntry) {
            if (tables[table].some((row) => row.id === newEntry.id)) return { data: null, error: { code: '23505' } };
            const row = { ...newEntry, created_at: new Date(Date.now() + revision++).toISOString() };
            tables[table].push(row); return { data: structuredClone(row), error: null };
          }
          let rows = tables[table].filter((row) => filters.every((fn) => fn(row)));
          if (sort) rows.sort((a, b) => String(a[sort[0]]).localeCompare(String(b[sort[0]])) * (sort[1]?.ascending === false ? -1 : 1));
          rows = rows.slice(0, max);
          return { data: structuredClone(single ? rows[0] || null : rows), error: null };
        }).then(resolve, reject); },
      }; return query;
    },
    async rpc(name, args) {
      if (name !== 'edit_dispatch_order_v1') throw Error('Unknown fixture RPC');
      const row = tables.transport_orders.find((v) => v.id === args.p_order_id);
      const client = tables.transport_clients.find((v) => v.id === args.p_client_id);
      if (this.conflict || row.updated_at !== args.p_expected_updated_at || client.updated_at !== args.p_client_expected_updated_at) return { error: { message: 'DISPATCH_EDIT_CONFLICT' } };
      Object.assign(client, args.p_client_patch, { updated_at: new Date().toISOString() });
      Object.assign(row, { client_name: client.name, status: args.p_next_status, data: args.p_order_data, updated_at: new Date().toISOString() });
      return { data: structuredClone(row), error: null };
    },
  };
}
