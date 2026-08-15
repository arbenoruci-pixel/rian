import fs from 'node:fs';

const page = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(page.includes('TRANSPORT_PAYMENT_BUTTON_V3:PAGE'), 'v3 page marker missing');
check(page.includes('function round2(value)'), 'round2 helper missing');
check(page.includes('const paymentActor = await requirePaymentPin({ label: pinLabel });'), 'PIN is not awaited with the real return contract');
check(page.includes("sourceModule: 'TRANSPORT'"), 'transport source is not a literal safe value');
check(page.includes('const applied = dueNow;'), 'cash-given is still being recorded instead of debt applied');
check(page.includes('orderId: oid'), 'payment verifier orderId key is wrong');
check(page.includes('code: transportCode'), 'payment verifier code key is wrong');
check(!page.includes('const pinResult = requirePaymentPin();'), 'old synchronous PIN bug remains');
check(!page.includes('sourceModule: ARKA_SOURCE_MODULE.TRANSPORT'), 'undefined ARKA_SOURCE_MODULE remains');
check(!page.includes('transportCode: displayCode || code'), 'undefined displayCode/code remains');
check(!page.includes('transportM2: totals.m2'), 'undefined totals remains');
check(!page.includes('clientPhone: fullPhone'), 'undefined fullPhone remains');
check(String(pkg.scripts?.prebuild || '').includes('apply-transport-payment-button-v3.mjs'), 'v3 installer missing from prebuild');
check(String(pkg.scripts?.build || '').includes('test:transport-payment-button-v3'), 'v3 verifier missing from build');
check(vite.includes('v44-query-authority-transport-guard-payment-button-v3'), 'PWA cache generation was not bumped');

if (failures.length) {
  console.error('FAIL transport payment button v3:', failures);
  process.exit(1);
}
console.log('PASS transport payment button v3');
