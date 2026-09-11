import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the shipping client and handlers. All I/O is synthetic: no customer
// message, production order, or money write is performed by this test.
const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const client = fs.readFileSync('lib/baseReadyBonusClient.js', 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
const mark = page.slice(page.indexOf('  async function handleMarkReady('), page.indexOf('  const totalM2 = useMemo'));
const rack = page.slice(page.indexOf('  async function confirmReadyPlaceAndSend('), page.indexOf('  async function handleMarkReady('));
const packaging = page.slice(page.indexOf('  async function paketimiMakeReady('), page.indexOf('  function openPaketimiSms('));
const order = { id: 1104, code: 1104, status: 'pastrim', phone: 'test-phone', fullOrder: { paketimi_v1: { status: 'final_ready' } } };
const options = { readySlots: ['A1'] };
let checks = 0;

function clientHarness({ online = true, rpc, storageFails = false, emptyQueue = false } = {}) {
  const rows = [], calls = [];
  const context = vm.createContext({
    navigator: { onLine: online }, getActor: () => ({ pin: 'test-actor', role: 'DISPATCH' }),
    setTimeout: fn => setTimeout(fn, 10), clearTimeout,
    supabase: { rpc: async (name, args) => { calls.push({ name, args }); return rpc ? rpc(args) : { data: { ok: true, order: { id: 1104, status: 'gati' } } }; } },
    queueOp: async (type, payload) => { if (storageFails) throw new Error('QuotaExceededError'); if (emptyQueue) return null; rows.push({ type, payload }); return 'durable-ready-op'; },
  });
  vm.runInContext(client, context);
  return { context, rows, calls, run: () => context.markBaseOrderReadyWithBonus({ orderRef: '1104', readySlots: ['a1', 'A1'], readyAt: '2026-09-11T10:00:00Z' }) };
}

// Online success, an offline device, resolved network errors, rejected fetches,
// and a hung request all preserve the original actor/time/key.
for (const config of [
  {}, { online: false },
  { rpc: async () => ({ error: new Error('Failed to fetch') }) },
  { rpc: async () => { throw new Error('Load failed'); } },
  { rpc: () => new Promise(() => {}) },
]) {
  const h = clientHarness(config);
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(h.rows.length, Object.keys(config).length ? 1 : 0);
  if (h.rows.length) {
    const p = h.rows[0].payload;
    assert.equal(p.p_worker_pin, 'test-actor');
    assert.equal(p.p_ready_at, '2026-09-11T10:00:00Z');
    assert.equal(p.p_idempotency_key, 'BASE_READY_48H_BONUS:1104');
    assert.equal(p.idempotency_key, p.p_idempotency_key);
    assert.equal(p.p_ready_slots.join(','), 'A1');
  }
  checks++;
}
for (const config of [
  { rpc: async () => ({ error: new Error('BASE_READY_WORKER_ROLE_NOT_ALLOWED:TRANSPORT') }) },
  { rpc: async () => ({ data: { ok: true } }) },
  { rpc: async () => ({ data: { ok: true, order: { id: 1104, status: 'pastrim' } } }) },
  { online: false, storageFails: true }, { online: false, emptyQueue: true },
]) {
  const h = clientHarness(config);
  await assert.rejects(h.run());
  assert.equal(h.rows.length, 0);
  checks++;
}

function uiHarness({ role = 'DISPATCH', fail, queued = false, transport = false, online = true } = {}) {
  const events = [], alerts = [], saved = [], button = { disabled: false, innerText: 'GATI' };
  let transitions = 0, purges = 0, reads = 0, sms;
  const context = vm.createContext({
    console: { warn() {}, error() {} }, window: {}, navigator: { onLine: online },
    document: { getElementById: () => button }, markReadyLocksRef: { current: new Set() },
    alert: text => alerts.push(text), normalizeRackSlots: v => v, formatConcreteRackSlots: v => v.join(', '),
    buildConcreteRackRequiredMessage: () => 'Rack required', isPastrimTransportScopedRow: () => transport,
    getActor: () => ({ pin: 'test-actor', name: 'Test', role }),
    mergeReadyMetaIntoOrder: (a, b) => ({ ...a, ...b }), normalizeLocalOidValue: (...v) => v.find(Boolean) || '',
    isLocalReadyTransitionRow: () => false, getReadyTargetTable: () => transport ? 'transport_orders' : 'orders',
    withTimeout: p => p, fetchOrderDataById: async () => { reads++; throw new Error('Load failed'); },
    markBaseOrderReadyWithBonus: async args => {
      transitions++; events.push('transition'); assert.equal(args.worker.role, role);
      await Promise.resolve();
      if (fail) throw new Error(fail);
      return queued ? { ok: true, offlineQueued: true, queuedOpId: 'durable-ready-op', idempotencyKey: 'stable-key' } :
        { ok: true, order: { id: 1104, status: 'gati', ready_at: '2026-09-11T09:00:00Z', data: { ready_at: '2026-09-11T09:00:00Z', ready_slots: ['A1'], paketimi_v1: { status: 'final_ready' } } } };
    },
    transitionOrderStatus: async table => { transitions++; assert.equal(table, 'transport_orders'); events.push('transition'); if (fail) throw new Error(fail); },
    describeReadyBonusResult: () => 'Saved', safeRecordReconcileTombstone: async () => events.push('tombstone'),
    saveOrderLocal: async row => saved.push(row), patchBaseMasterRow() {},
    normalizeRenderableOrderRow: row => row, removePastrimTransportRowsFromLocalCaches() {}, pastrimRowMatchesCleanupTarget: () => false,
    setOrders() {}, refreshOrders: async () => {}, scheduleRackMapRefresh() {},
    buildSmartSmsText: () => 'Synthetic GATI message', setSmsModal: value => { sms = value; },
    purgeGhostPastrimArtifacts: () => purges++,
  });
  vm.runInContext(mark, context);
  return { context, events, alerts, saved, button, run: (o = order, opts = options) => context.handleMarkReady(o, opts),
    state: () => ({ transitions, purges, reads, sms }) };
}

for (const config of [{}, { role: 'PUNTOR' }, { queued: true, online: false }, { transport: true }]) {
  const h = uiHarness(config);
  assert.equal(await h.run(), true);
  assert.deepEqual(h.events.slice(0, 2), ['transition', 'tombstone']);
  assert.equal(h.state().purges, 0);
  assert.equal(h.state().reads, config.transport ? 1 : 0);
  assert.equal(h.button.disabled, false);
  assert.equal(h.context.markReadyLocksRef.current.size, 0);
  if (!config.transport) {
    assert.equal(h.state().sms.orderId, '1104');
    assert.equal(h.saved[0]._synced, !config.queued);
    if (!config.queued) assert.equal(h.saved[0].ready_at, '2026-09-11T09:00:00Z');
  }
  checks++;
}
for (const fail of ['BASE_READY_WORKER_ROLE_NOT_ALLOWED:DISPATCH', 'BASE_READY_WORKER_NOT_FOUND', 'QuotaExceededError', 'Load failed']) {
  const h = uiHarness({ fail });
  assert.equal(await h.run(), false);
  assert.equal(h.state().purges, 0);
  assert.equal(h.events.includes('tombstone'), false);
  assert.equal(h.saved.length, 0);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.innerText, 'GATI');
  assert.equal(h.context.markReadyLocksRef.current.size, 0);
  await h.run();
  assert.equal(h.state().transitions, 2, 'A failed action must remain retryable');
  checks++;
}
{
  const h = uiHarness();
  await Promise.all([h.run(), h.run()]);
  assert.equal(h.state().transitions, 1);
  assert.equal(h.saved.length, 1);
  checks++;
}
{
  const h = uiHarness();
  await h.run(order, { readySlots: [] });
  assert.equal(h.state().transitions, 0);
  assert.equal(h.button.disabled, false);
  assert.equal(h.context.markReadyLocksRef.current.size, 0);
  checks++;
}
// The actual sheet handlers retain the draft/rack on failure, close on success,
// and release their busy state regardless of the transition outcome.
for (const completed of [false, true]) {
  const events = [];
  const context = vm.createContext({
    readyPlaceOrder: order, readyPlaceBusy: false, readyPlaceText: '', cancelReadyPlaceWarmup() {},
    normalizeRackSlots: v => Array.isArray(v) ? v : [v], setReadyPlaceBusy: v => events.push(['busy', v]),
    handleMarkReady: async () => completed, setReadyPlaceSheet: v => events.push(['rack', v]),
    setReadyPlaceOrder() {}, setReadyPlaceText() {}, setReadySlots() {}, scheduleRackMapRefresh() {},
    paketimiDraft: { final_rack: 'A1', wrapped: true }, paketimiOrder: order,
    getPaketimiStats: () => ({ allFound: true }), normalizePaketimiFinalRack: v => v,
    hasConcreteRackLocation: () => true, formatConcreteRackSlots: v => v.join(', '),
    persistPaketimi: async () => {}, setPaketimiSheet: v => events.push(['packaging', v]),
    setPaketimiOrder() {}, setPaketimiDraft() {}, alert: e => { throw new Error(e); },
  });
  vm.runInContext(rack + '\n' + packaging, context);
  await context.confirmReadyPlaceAndSend('A1');
  assert.equal(events.some(([name]) => name === 'rack'), completed);
  assert.deepEqual(events.filter(([name]) => name === 'busy'), [['busy', true], ['busy', false]]);
  await context.paketimiMakeReady();
  assert.equal(events.some(([name]) => name === 'packaging'), completed);
  checks++;
}
assert.match(page, /<TrackedReadySmsModal[\s\S]*?orderId=\{smsModal.orderId\}/);
// Execute the production outbox branch with the exact command persisted by the
// client. A lost connection cannot acknowledge/remove that pending operation.
{
  const queued = clientHarness({ online: false });
  await queued.run();
  const sync = fs.readFileSync('lib/syncEngine.js', 'utf8');
  const start = sync.indexOf("  if (type === 'base_ready_bonus_transition') {", sync.indexOf('async function processOp('));
  assert.ok(start > 0);
  const branch = sync.slice(start, sync.indexOf("  if (type === 'arka_transaction')", start));
  for (const failed of [false, true]) {
    const saved = [];
    const context = vm.createContext({
      type: queued.rows[0].type, payload: queued.rows[0].payload, op: {}, nowIso: () => new Date().toISOString(),
      supabase: { rpc: async (name, args) => {
        assert.equal(name, 'mark_base_order_ready_with_bonus_v1');
        assert.equal(args.p_idempotency_key, queued.rows[0].payload.p_idempotency_key);
        assert.equal(args.p_worker_pin, 'test-actor');
        assert.equal(args.p_ready_at, '2026-09-11T10:00:00Z');
        if (failed) return { error: new Error('Load failed') };
        return { data: { ok: true, alreadyApplied: true, order: { id: 1104, status: 'gati', ready_at: '2026-09-11T10:00:00Z', data: { ready_slots: ['A1'] } } } };
      } }, saveOrderLocal: async row => saved.push(row), deleteOrderLocal: async () => {},
    });
    vm.runInContext(`async function replay() { ${branch} }`, context);
    if (failed) { await assert.rejects(context.replay()); assert.equal(saved.length, 0); }
    else { assert.equal(await context.replay(), true); assert.equal(saved[0]._synced, true); assert.equal(saved[0].ready_at, '2026-09-11T10:00:00Z'); }
    checks++;
  }
}
console.log(`PASS ${checks} actual base-ready flow scenarios: roles, network, queue failure, duplicate taps, retryable sheets, transport, notification identity.`);
