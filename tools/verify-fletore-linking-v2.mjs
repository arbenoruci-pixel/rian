import assert from 'node:assert/strict';
import {
  baseOrderTotalEur,
  buildBaseOrderBuckets,
  isBaseOrderActive,
} from '../lib/fletoreBase.js';
import { fetchAllRows } from '../api/_pagination.js';

const clients = [
  { id: 11, code: 101, full_name: 'Klienti A', phone: '044100001' },
  { id: 12, code: 202, full_name: 'Klienti B', phone: '044100002' },
  { id: 13, code: 303, full_name: 'Klienti C', phone: '044100003' },
  { id: 14, code: 404, full_name: 'Klienti D', phone: '044100004' },
  { id: 15, code: 505, full_name: 'Klienti E', phone: '044100005' },
  { id: 16, code: 606, full_name: 'Klienti F', phone: '044100006' },
];

const order = (id, clientId, code, createdAt, extra = {}) => ({
  id,
  client_id: clientId,
  code,
  status: 'gati',
  created_at: createdAt,
  data: { pay: { euro: 1, m2: 1 }, ...(extra.data || {}) },
  ...extra,
});

const orders = [
  order(1001, 11, 101, '2026-06-01T10:00:00Z'),
  order(1002, 11, 101, '2026-08-01T10:00:00Z'),
  order(2001, 12, 202, '2026-05-01T10:00:00Z'),
  order(2002, 12, 202, '2026-08-02T10:00:00Z'),
  order(3001, 13, 303, '2026-04-01T10:00:00Z'),
  order(3002, 13, 303, '2026-07-01T10:00:00Z'),
  order(3003, 13, 303, '2025-12-01T10:00:00Z', {
    total: 21.32,
    data: {
      pay: { euro: 19.89, m2: 15.3 },
      total: 41.21,
      debt: 41.21,
      partial_pickup_transfer_in: { from_order_id: 1378, amount: 21.32 },
    },
  }),
  order(4001, 14, 404, '2026-03-01T10:00:00Z'),
  order(4002, 14, 404, '2026-03-02T10:00:00Z'),
  order(5001, 15, 505, '2026-02-01T10:00:00Z'),
  order(5002, 15, 505, '2026-02-02T10:00:00Z'),
  {
    id: 6001,
    client_id: 16,
    code: 606,
    status: 'pranim',
    created_at: '2026-02-10T10:00:00Z',
    data: {
      is_archived_stale_draft: true,
      fletore_cleanup: { archived: true, state: 'ARCHIVED_STALE_DRAFT' },
    },
  },
];

const buckets = buildBaseOrderBuckets(clients, orders);
const preservedIds = buckets.resolvedActiveOrders.map((entry) => entry.order.id);
for (const id of [1001, 2001, 3001, 4001, 5001, 3003]) {
  assert.ok(preservedIds.includes(id), `affected active order ${id} was lost`);
}
assert.equal(buckets.activeClients.length, 5, 'five real clients should be active');
assert.equal(buckets.activeOrderCount, 11, 'all eleven real active orders should be preserved');
assert.equal(buckets.repairActiveOrders.length, 0, 'valid client_id rows must not be repair warnings');
assert.equal(buckets.unlinkedActiveOrders.length, 0, 'valid client_id rows must not be unlinked warnings');
assert.equal(isBaseOrderActive(orders.at(-1)), false, 'archived stale draft must not remain active');
assert.equal(baseOrderTotalEur(orders.find((row) => row.id === 3003)), 41.21, 'transferred debt must be included in the combined total');

const missingFk = order(7001, null, 303, '2026-08-20T10:00:00Z');
const missingFkBuckets = buildBaseOrderBuckets(clients, [missingFk]);
assert.equal(missingFkBuckets.repairActiveOrders[0]?.linkIssue, 'MISSING_CLIENT_ID');
assert.equal(missingFkBuckets.repairActiveOrders[0]?.linkedBy, 'code');
assert.equal(missingFkBuckets.unlinkedActiveOrders.length, 0);

const brokenFk = order(7002, 999999, 303, '2026-08-21T10:00:00Z');
const brokenFkBuckets = buildBaseOrderBuckets(clients, [brokenFk]);
assert.equal(brokenFkBuckets.repairActiveOrders[0]?.linkIssue, 'BROKEN_CLIENT_ID');
assert.equal(brokenFkBuckets.repairActiveOrders[0]?.linkedBy, 'code');

const noCustomerData = {
  id: 7003,
  status: 'pranim',
  created_at: '2026-08-22T10:00:00Z',
  data: {},
};
const noCustomerBuckets = buildBaseOrderBuckets(clients, [noCustomerData]);
assert.equal(noCustomerBuckets.unlinkedActiveOrders[0]?.linkIssue, 'MISSING_CUSTOMER_DATA');

const sourceRows = Array.from({ length: 1453 }, (_, index) => ({ id: 1453 - index }));
const ranges = [];
const fakeSupabase = {
  from(table) {
    assert.equal(table, 'orders');
    return {
      select() { return this; },
      order() { return this; },
      async range(from, to) {
        ranges.push([from, to]);
        return { data: sourceRows.slice(from, to + 1), error: null };
      },
    };
  },
};
const pagedRows = await fetchAllRows(fakeSupabase, {
  table: 'orders',
  orderBy: [{ column: 'created_at', ascending: false }, { column: 'id', ascending: false }],
});
assert.equal(pagedRows.length, 1453, 'pagination must read past the first 1000 rows');
assert.deepEqual(ranges, [[0, 999], [1000, 1999]], 'pagination ranges changed unexpectedly');

console.log('FLETORE_LINKING_V2_VERIFY_OK');
