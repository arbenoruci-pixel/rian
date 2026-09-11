import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/gati/page.jsx', 'utf8');
const confirm = source.slice(source.indexOf('  async function confirmDelivery()'), source.indexOf('  async function closeDeliveryOnlyRetry()'));
const finish = source.slice(source.indexOf('  async function finishFastDeliverySync('), source.indexOf('  function formatPendingPaymentNotice('));
function harness({ online = false, storageFails = false, denied = false } = {}) {
  const rows = [], events = [], alerts = [];
  let receipt, closed = false, sends = 0, verified = 0;
  const context = vm.createContext({
    console: { error() {} }, navigator: { onLine: online },
    window: { dispatchEvent() {}, setTimeout() {} }, Event: class {},
    payOrder: { id: 1185, code: '1185', name: 'Test', phone: '', total: 16.64, paid: 0 },
    payBusy: false, paySubmitLockRef: { current: false }, payAdd: 16.64, payMethod: 'CASH',
    setPayBusy() {}, setPayErr() {}, alert: value => alerts.push(value),
    requirePaymentPin: async () => ({ pin: 'test-worker', role: 'TRANSPORT' }),
    buildDeliveredPayload: ({ newPaid, newDebt, actionAt }) => ({ id: '1185', paid: newPaid, debt: newDebt, updated_at: actionAt }),
    buildFastBasePaymentIdempotencyKey: () => 'stable-payment-test-key',
    withOptimisticArkaRecordedPaid: value => value,
    buildFastPaymentTransaction: ({ amount, pinData, idempotencyKey }) => ({ amount, actorPin: pinData.pin, idempotencyKey }),
    queueOp: async (type, payload) => {
      events.push('persist');
      if (storageFails) throw new Error('QuotaExceededError');
      rows.push(JSON.parse(JSON.stringify({ type, payload })));
      return 'durable-op';
    },
    finalizeDeliveredUi: async () => { assert.equal(rows.length, 1); closed = true; events.push('close'); },
    setPaymentSmsReceipt: value => { receipt = typeof value === 'function' ? value(receipt) : value; },
    showFastPayNotice() {}, refreshOrders() {}, isDeviceSessionError: () => false,
    ensureApprovedDeviceSession: async () => { verified++; events.push('verify'); if (denied) { const e = new Error('DEVICE_NOT_APPROVED'); e.status = 403; throw e; } },
    recordOrderCashPayment: async () => { sends++; events.push('send'); throw Object.assign(new Error('Load failed'), { network: true }); },
    markPaymentDoneButDeliveryPending() {},
  });
  vm.runInContext(`${finish}\n${confirm}`, context);
  return { context, rows, events, alerts, state: () => ({ receipt, closed, sends, verified }) };
}
// The actual UI handler queues without any network/approval cache, closes only
// after persistence, and retains the command when the detached sender fails.
for (const online of [false, true]) {
  const h = harness({ online });
  assert.equal(await h.context.confirmDelivery(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].payload.transaction.amount, 16.64);
  assert.equal(h.rows[0].payload.transaction.actorPin, 'test-worker');
  assert.equal(h.rows[0].payload.idempotency_key, 'stable-payment-test-key');
  assert.equal(h.state().closed, true);
  assert.equal(h.state().receipt.syncState, 'pending');
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(h.events.slice(0, 2), ['persist', 'close']);
  assert.equal(h.state().sends, online ? 1 : 0);
  assert.equal(h.state().verified, online ? 1 : 0);
}
// Explicit denial never reaches the money write; durable work stays visible.
{
  const h = harness({ online: true, denied: true });
  await h.context.confirmDelivery(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state().sends, 0);
  assert.equal(h.rows.length, 1);
  assert.equal(h.state().receipt.syncState, 'error');
  assert.equal(h.state().receipt.syncError, 'DEVICE_NOT_APPROVED');
}
// Storage failure leaves the sheet intact, with no success receipt or sender.
{
  const h = harness({ storageFails: true });
  assert.equal(await h.context.confirmDelivery(), false);
  assert.equal(h.state().closed, false);
  assert.equal(h.state().receipt, undefined);
  assert.equal(h.state().sends, 0);
  assert.equal(h.context.paySubmitLockRef.current, false);
}
// Two synchronous taps cannot queue the same payment twice.
{
  const h = harness();
  await Promise.all([h.context.confirmDelivery(), h.context.confirmDelivery()]);
  assert.equal(h.rows.length, 1);
}
// Reconnection sends the original key, saves the canonical result, then removes
// the durable command. This is the same detached sender used after confirmation.
{
  const h = harness();
  await h.context.confirmDelivery(); await new Promise(resolve => setImmediate(resolve));
  const queued = h.rows[0].payload;
  h.context.navigator.onLine = true;
  h.context.recordOrderCashPayment = async (body) => {
    assert.equal(body.idempotencyKey, queued.idempotency_key);
    return { ok: true, payment: { id: 'payment-test' }, order: { id: 1185, status: 'dorzim', data: { paid: 16.64, debt: 0 } } };
  };
  h.context.isDeliveredStatus = status => status === 'dorzim';
  h.context.clearPaymentDoneButDeliveryPending = () => {};
  h.context.saveOrderLocal = async row => { assert.equal(row._synced, true); h.events.push('canonical-save'); };
  h.context.patchBaseMasterRow = () => {};
  h.context.deleteOp = async () => { h.events.push('delete'); h.rows.pop(); };
  await h.context.finishFastDeliverySync({ payload: queued.delivery_patch.data, applied: 16.64,
    pinData: { pin: 'test-worker', role: 'TRANSPORT' }, method: 'CASH', orderId: 1185,
    idempotencyKey: queued.idempotency_key, deliveryOpId: 'durable-op' });
  assert.equal(h.state().receipt.syncState, 'synced');
  assert.equal(h.rows.length, 0);
  assert.deepEqual(h.events.slice(-2), ['canonical-save', 'delete']);
}
console.log('PASS GATI queue-first: real confirm handler offline, failed connection, authorization denial, storage failure, duplicate taps.');
