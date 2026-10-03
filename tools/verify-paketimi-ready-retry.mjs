import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const failures = [];
let checks = 0;
async function check(name, run) {
  try { await run(); checks++; }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}
const row = (status, extra = {}) => ({ id: 'synthetic-visit', table: 'orders', code: '42', status, source: 'DB', ...extra });
const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const ast = parse(page, { sourceType: 'module', plugins: ['jsx'] });
function findFunction(name, node = ast) {
  if (node?.type === 'FunctionDeclaration' && node.id?.name === name) return page.slice(node.start, node.end);
  for (const value of Object.values(node || {})) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) { const found = findFunction(name, child); if (found) return found; }
    } else if (value?.type) { const found = findFunction(name, value); if (found) return found; }
  }
  return '';
}
const primary = page.slice(page.indexOf("        let primaryLabel = 'RUAJ GRUMBULLIMIN';"), page.indexOf('        const selectRackZone =', page.indexOf("        let primaryLabel = 'RUAJ GRUMBULLIMIN';")));
function actionFor(status, busy = false) {
  const context = vm.createContext({
    isFinalReady: true, paketimiBusy: busy, paketimiOrder: row(status), orderData: { status },
    paketimiDraft: { status: 'final_ready', final_rack: 'A1', wrapped: true },
    stats: { allFound: true }, rackValue: 'A1', hasConcreteRackLocation: () => true,
    savePaketimiGrouping() {}, markPaketimiWrapped() {}, paketimiMakeReady() {},
    TRANSPORT_PASTRIMI_STATUS_SET: new Set(['pastrim', 'pastrimi', 'at_base', 'in_base', 'base']),
  });
  vm.runInContext(findFunction('normalizeStatus') + '\n' + findFunction('isPaketimiReadyTransitionPending') + '\n' + primary + '\nresult = { primaryLabel, primaryDisabled, canRetry: primaryAction === paketimiMakeReady };', context);
  return context.result;
}
await check('A finalized package in Pastrim keeps a retry action', () => {
  for (const status of ['pastrim', 'pastrimi', 'at_base', 'in_base', 'base']) {
    assert.equal(actionFor(status).primaryDisabled, false);
    assert.equal(actionFor(status).canRetry, true);
  }
  assert.equal(actionFor('pastrim', true).primaryDisabled, true);
});
await check('An already ready/delivered package cannot be transitioned again from this sheet', () => {
  for (const status of ['gati', 'dorzim', 'done', 'cancelled']) assert.equal(actionFor(status).primaryDisabled, true);
});

function makeHarness({ table = 'orders', status = 'final_ready', completed = true, saveError = false, noSavedResult = false, busy = false } = {}) {
  const events = [];
  const draft = { status, wrapped: true, final_rack: 'A1', pieces: [{ piece_id: '1', found: true, m2: 2.5 }], updated_by: 'synthetic-worker' };
  const oldData = { status: 'pastrim', paid: 20, paketimi_v1: { status: 'wrapped_ready_for_rack' } };
  const savedData = { ...oldData, paid: 25, paketimi_v1: { ...draft, status: 'final_ready', updated_at: '2026-10-03T12:00:00Z' } };
  const context = vm.createContext({
    paketimiBusy: busy, paketimiOrder: row('pastrim', { table, data: oldData, fullOrder: oldData }), paketimiDraft: draft,
    getPaketimiStats: () => ({ allFound: true }), normalizePaketimiFinalRack: v => v,
    normalizeRackSlots: () => ['A1'], hasConcreteRackLocation: () => true, formatConcreteRackSlots: () => 'A1',
    persistPaketimi: async () => {
      events.push('save');
      if (saveError) throw new Error('synthetic write failure');
      return noSavedResult ? null : { data: savedData };
    },
    handleMarkReady: async order => {
      events.push('transition');
      assert.equal(order.table, table);
      assert.equal(order.data, order.fullOrder);
      if (status === 'final_ready') {
        assert.equal(order.fullOrder.paketimi_v1, draft, 'Retry must retain the finalized package exactly');
        assert.equal(order.fullOrder.paid, oldData.paid);
      } else {
        assert.equal(order.fullOrder, savedData, 'Transition must use the saved snapshot, including concurrent data changes');
      }
      return completed;
    },
    setPaketimiSheet: v => { if (!v) events.push('close'); }, setPaketimiOrder() {}, setPaketimiDraft() {},
    alert: message => events.push(['alert', message]),
  });
  vm.runInContext(findFunction('paketimiMakeReady'), context);
  return { run: () => context.paketimiMakeReady(), events };
}
for (const table of ['orders', 'transport_orders']) {
  for (const completed of [false, true]) await check(`${table}: retry finalized packaging, completed=${completed}`, async () => {
    const harness = makeHarness({ table, completed });
    await harness.run();
    assert.deepEqual(harness.events, completed ? ['transition', 'close'] : ['transition']);
  });
  await check(`${table}: first finalization uses the saved data in the transition`, async () => {
    const harness = makeHarness({ table, status: 'wrapped_ready_for_rack' });
    await harness.run();
    assert.deepEqual(harness.events, ['save', 'transition', 'close']);
  });
}
await check('A packaging save failure keeps the sheet open and never transitions', async () => {
  const harness = makeHarness({ status: 'wrapped_ready_for_rack', saveError: true });
  await harness.run();
  assert.equal(harness.events.length, 2);
  assert.equal(harness.events[0], 'save');
  assert.equal(harness.events[1][0], 'alert');
  assert.match(harness.events[1][1], /synthetic write failure/);
});
await check('An empty save result never transitions or closes the sheet', async () => {
  const harness = makeHarness({ status: 'wrapped_ready_for_rack', noSavedResult: true });
  await harness.run();
  assert.deepEqual(harness.events, ['save']);
});
await check('Busy packaging cannot start a concurrent action', async () => {
  const harness = makeHarness({ busy: true });
  await harness.run();
  assert.deepEqual(harness.events, []);
});
if (failures.length) {
  failures.forEach(f => console.error(`FAIL ${f}`));
  process.exitCode = 1;
} else console.log(`PASS: ${checks} packaging-ready retry behavior checks`);
