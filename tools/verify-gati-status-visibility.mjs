import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { parse } from '@babel/parser';

// Run the real reconciliation modules against synthetic browser storage only.
const storage = new Map();
const context = vm.createContext({
  window: { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  } },
  module: { exports: {} },
});
const bundle = buildSync({
  stdin: { contents: `export * from './lib/reconcile/tombstones.js'; export * from './lib/reconcile/reconcile.js';`, resolveDir: process.cwd() },
  alias: { '@': process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
}).outputFiles[0].text;
vm.runInContext(bundle, context);
const { recordReconcileTombstone, readReconcileTombstones, isCandidateBlockedByTombstone, buildReconciledRows } = context.module.exports;

// Exercise the actual Gati list/payment guard, not a copied policy model.
const page = fs.readFileSync('app/gati/page.jsx', 'utf8');
const guard = parse(page, { sourceType: 'module', plugins: ['jsx'] }).program.body
  .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'isGatiRowBlockedByDeliveryTombstone');
Object.assign(context, { isCandidateBlockedByTombstone, readReconcileTombstones });
vm.runInContext(page.slice(guard.start, guard.end), context);

const order = { id: 'test-3526', local_oid: 'test-visit', code: '1306', table: 'orders', status: 'pastrim' };
const ready = { ...order, status: 'gati' };
let passed = 0;
function check(name, run) { storage.clear(); run(); passed++; console.log(`PASS ${name}`); }
function mark(row) { recordReconcileTombstone(row, { reason: row.status === 'gati' ? 'pastrimi_mark_ready' : 'gati_confirm_delivery', ttlMs: 8 * 60 * 60 * 1000 }); }

check('Pastrim to Gati stays visible and can open payment on the same device', () => {
  mark(ready);
  assert.equal(context.isGatiRowBlockedByDeliveryTombstone(ready), false);
});
check('Gati marker still suppresses stale Pastrim copies', () => {
  mark(ready);
  assert.equal(isCandidateBlockedByTombstone(order, readReconcileTombstones()), true);
  assert.equal(buildReconciledRows({ page: 'pastrimi', baseRows: [order] }).length, 0);
});
check('Gati reconciliation keeps the destination row after a ready transition', () => {
  mark(ready);
  const rows = buildReconciledRows({ page: 'gati', baseRows: [ready], localRows: [order] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'gati');
});
check('Payment/delivery marker continues to hide stale Gati and block repeat payment', () => {
  mark({ ...ready, status: 'dorzim' });
  assert.equal(context.isGatiRowBlockedByDeliveryTombstone(ready), true);
  assert.equal(buildReconciledRows({ page: 'gati', baseRows: [ready] }).length, 0);
});
check('An existing eight-hour Gati marker recovers without clearing saved data', () => {
  storage.set('tepiha_reconcile_tombstones', JSON.stringify([{
    stableKey: 'orders:id:test-3526', status: 'gati', rank: 30,
    reason: 'pastrimi_mark_ready', expires_at: Date.now() + 8 * 60 * 60 * 1000,
  }]));
  assert.equal(context.isGatiRowBlockedByDeliveryTombstone(ready), false);
  assert.equal(readReconcileTombstones().length, 1);
});
check('A prior visit with the same permanent code cannot hide a new visit', () => {
  mark({ ...ready, id: 'previous-visit', status: 'dorzim' });
  assert.equal(context.isGatiRowBlockedByDeliveryTombstone(ready), false);
});
check('Base and Transport identities stay separate', () => {
  mark({ ...ready, table: 'transport_orders', status: 'dorzim' });
  assert.equal(context.isGatiRowBlockedByDeliveryTombstone(ready), false);
});
check('Advanced rows remain visible at their current status', () => {
  mark(ready);
  assert.equal(isCandidateBlockedByTombstone({ ...ready, status: 'dorzim' }, readReconcileTombstones()), false);
  mark({ ...ready, status: 'dorzim' });
  assert.equal(buildReconciledRows({ page: 'dorzim', baseRows: [{ ...ready, status: 'dorzim' }] }).length, 1);
});
console.log(`PASS: ${passed} status visibility regressions`);
