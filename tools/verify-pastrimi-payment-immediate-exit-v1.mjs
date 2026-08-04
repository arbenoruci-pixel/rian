import fs from 'node:fs';

const source = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(source.includes('PASTRIMI_PAYMENT_IMMEDIATE_EXIT_V1'), 'marker missing');
check(source.includes('withTimeout(recordOrderCashPayment({'), 'payment timeout missing');
check(source.includes('}), 15000);'), '15 second timeout missing');
check(source.includes("if (engineStatus === 'dorzim')"), 'dorzim immediate branch missing');
check(source.includes('.filter((o) => String(o?.id) !== paymentOrderId)'), 'delivered row immediate removal missing');
check(source.includes('setRowPaySheet(false);'), 'sheet immediate close missing');
check(source.includes('setRowPayOrder(null);'), 'payment state clear missing');
check(source.includes('void Promise.resolve().then(async () => {'), 'background mirror write missing');
check(source.includes("source: 'pastrimi_payment_verified_exit'"), 'background DB refresh missing');
check(source.indexOf('setRowPaySheet(false);') < source.indexOf('void Promise.resolve().then(async () => {'), 'UI must close before cache work');
check(source.includes('KLIENTI U HOQ NGA PASTRIMI'), 'worker success message missing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} payment exit check(s) failed.`);
  failures.forEach((x, i) => console.error(`${i + 1}. ${x}`));
  process.exit(1);
}
console.log('PASS: 11 Pastrimi payment immediate-exit checks passed.');
