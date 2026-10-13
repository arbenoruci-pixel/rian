import assert from 'node:assert/strict';
import { selectInventoryAuditRows, canSelectAuditMove } from '../lib/inventoryAuditSearch.js';

// Synthetic regression for the reported label 1339, never live customer data.
const row = (id, extra = {}) => ({ key: `orders:${id}`, id: String(id), table: 'orders', code: '1339', name: 'Klienti Test', phone: '044000000', location: '', stage: 'processing', overdue: false, ageDays: 1, result: 'unverified', ...extra });
const rows = [
  row(1), row(2, { overdue: true, ageDays: 6 }),
  row(3, { ageDays: null }),
  row(4, { stage: 'ready' }),
  row(5, { stage: 'ready', result: 'seen_in_depot' }),
  row(6, { stage: 'ready', result: 'not_found' }),
  row(7, { table: 'transport_orders', code: 'T1339', key: 'transport_orders:7' }),
  row(8, { code: '13390' }), row(9, { code: '11339' }),
  row(10, { code: '71', phone: '044133900', location: 'A1339' }),
  row(11, { stage: 'inactive' }),
];
const before = JSON.stringify(rows);
const ids = options => selectInventoryAuditRows(rows, options).map(r => r.id).sort();
for (const stage of ['processing', 'ready']) {
  for (const filter of ['unverified', 'seen_in_depot', 'not_found', 'all']) {
    assert.deepEqual(ids({ stage, filter, query: '1339' }), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(ids({ stage, filter, query: '#01339' }), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(ids({ stage, filter, query: 't 01339' }), ['7']);
    assert.deepEqual(ids({ stage, filter, query: '1339x' }), []);
    assert.deepEqual(ids({ stage, filter, query: '9999' }), []);
  }
}
console.log('PASS 1339 across both stages, all audit results, fresh/unknown-date visits, exact Base/Transport boundary and honest misses');
assert.deepEqual(ids({ stage: 'processing', query: '' }), ['2']);
assert.deepEqual(ids({ stage: 'processing', query: '  ' }), ['2']);
assert.deepEqual(ids({ stage: 'ready' }), ['4']);
assert.deepEqual(ids({ stage: 'ready', filter: 'seen_in_depot' }), ['5']);
assert.deepEqual(ids({ stage: 'ready', filter: 'not_found' }), ['6']);
assert.deepEqual(ids({ stage: 'ready', filter: 'all' }), ['4', '5', '6']);
assert.deepEqual(selectInventoryAuditRows(rows, { query: '1339' }).filter(canSelectAuditMove).map(r => r.id), ['2']);
assert.equal(canSelectAuditMove(row(12, { stage: 'ready', overdue: true })), false);
assert.equal(canSelectAuditMove(row(13, { overdue: 'true' })), false);
assert.equal(JSON.stringify(rows), before);
console.log('PASS empty-query workflow, strict eligible-only bulk selection, inactive exclusion and no source mutation');
const details = [row(20, { name: 'Shkëndije Test', phone: '+383 (44) 001-122', location: 'A12' }), row(21, { name: 'Shkëndije Test', phone: '+383 (44) 001-122', location: 'A12', stage: 'ready', result: 'seen_in_depot' })];
for (const query of ['shkendije test', '38344001122', 'a12']) {
  for (const stage of ['processing', 'ready']) {
    assert.equal(selectInventoryAuditRows(details, { stage, query, mode: 'details' }).length, 2);
  }
}
console.log('PASS explicit name/phone/rack lookup searches both stages without the age or result filter');
