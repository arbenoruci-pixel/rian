import fs from 'node:fs';

const db = fs.readFileSync('lib/transportOrdersDb.js', 'utf8');
const item = fs.readFileSync('app/transport/item/page.jsx', 'utf8');
const pranimi = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pay = fs.readFileSync('app/transport/pay/page.jsx', 'utf8');
const api = fs.readFileSync('api/transport/receivables.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(db.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:DB'), 'database guard marker missing');
check(db.includes('export function isTransportOrderPaymentBlocked'), 'shared cancelled-order classifier missing');
check(db.includes("'cancelled'") && db.includes("'anuluar'"), 'cancelled status aliases incomplete');
check(db.includes('.limit(25)'), 'T-code lookup still reads only one historical visit');
check(db.includes('matches.find((candidate) => !isTransportOrderPaymentBlocked(candidate))'), 'T-code lookup does not prefer a valid active visit');
check(db.includes("return new Error('TRANSPORT_ORDER_CANCELLED')") && db.includes('throw transportOrderCancelledError()'), 'cancelled-only T-code result is not explicit');

check(item.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:ITEM'), 'transport item route guard missing');
check(item.includes('isTransportOrderPaymentBlocked(t)'), 'transport item route can open a cancelled visit');
check(item.includes('MOS REGJISTRO PAGESË NË KËTË POROSI'), 'cancelled visit guidance missing');

check(pranimi.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PRANIMI_LOAD'), 'pranimi direct-link guard missing');
check(pranimi.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PRANIMI_PAY'), 'pranimi payment recheck missing');
check(pranimi.includes('Number(totalM2 || 0) <= 0') && pranimi.includes('Number(totalEuro || 0) <= 0'), 'pranimi permits payment without measurements/total');

check(pay.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PAY_LOAD'), 'standalone payment load guard missing');
check(pay.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PAY_SAVE'), 'standalone payment submit guard missing');
check(pay.includes('totals.m2 <= 0 || totals.total <= 0'), 'standalone payment permits missing measurements/total');

check(api.includes('TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:API'), 'server payment guard missing');
check(api.includes("apiFail(res, 'TRANSPORT_ORDER_CANCELLED', 409)"), 'server does not reject cancelled payments');
check(api.indexOf("apiFail(res, 'TRANSPORT_ORDER_CANCELLED', 409)") < api.indexOf("transport_collect_client_payment_guarded_v2"), 'server rejection occurs after the payment RPC');

check(String(pkg.scripts?.prebuild || '').includes('apply-transport-cancelled-payment-guard-v1.mjs'), 'prebuild preservation check missing');
check(String(pkg.scripts?.build || '').includes('test:transport-cancelled-payment-guard-v1'), 'build verifier missing');

if (failures.length) {
  console.error('FAIL transport cancelled-payment guard v1:', failures);
  process.exit(1);
}

console.log('PASS transport cancelled-payment guard v1');
