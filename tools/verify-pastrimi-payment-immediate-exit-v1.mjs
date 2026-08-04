import fs from 'node:fs';

const source = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const legacy = source.includes('PASTRIMI_PAYMENT_IMMEDIATE_EXIT_V1');
const background = source.includes('PASTRIMI_PAYMENT_BACKGROUND_V1');
check(legacy || background, 'payment exit marker missing');
check(source.includes('setRowPaySheet(false);'), 'sheet immediate close missing');
check(source.includes('setRowPayOrder(null);'), 'payment state clear missing');

if (background) {
  check(source.includes("const pickupNow = willSettleFull && fullPaymentTargetStatus === 'dorzim'"), 'pickup immediate branch missing');
  check(source.includes("setOrders((prev) => (prev || []).filter"), 'delivered row immediate removal missing');
  check(source.includes("queueOp('arka_transaction'"), 'durable background queue missing');
  check(source.includes('Promise.resolve().then(runPaymentInBackground)'), 'background payment execution missing');
  check(source.includes("payment_sync_state: 'BACKGROUND_PENDING'"), 'background payment state missing');
  check(source.includes('durableQueueCreated'), 'queued retry protection missing');
  check(source.includes('originalRow'), 'hard-failure restore missing');
  check(source.indexOf('setRowPaySheet(false);') < source.indexOf('Promise.resolve().then(runPaymentInBackground)'), 'UI must close before background work');
} else {
  check(source.includes('withTimeout(recordOrderCashPayment({'), 'payment timeout missing');
  check(source.includes('}), 15000);'), '15 second timeout missing');
  check(source.includes("if (engineStatus === 'dorzim')"), 'dorzim immediate branch missing');
  check(source.includes('.filter((o) => String(o?.id) !== paymentOrderId)'), 'delivered row immediate removal missing');
  check(source.includes('void Promise.resolve().then(async () => {'), 'background mirror write missing');
  check(source.includes("source: 'pastrimi_payment_verified_exit'"), 'background DB refresh missing');
  check(source.includes('KLIENTI U HOQ NGA PASTRIMI'), 'worker success message missing');
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} payment exit check(s) failed.`);
  failures.forEach((x, i) => console.error(`${i + 1}. ${x}`));
  process.exit(1);
}
console.log('PASS: Pastrimi payment immediate-exit checks passed.');
