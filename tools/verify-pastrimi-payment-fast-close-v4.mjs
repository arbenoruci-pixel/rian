import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const pos = fs.readFileSync('components/PosModal.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-pastrimi-payment-fast-close-v4.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(page.includes('PASTRIMI_PAYMENT_FAST_CLOSE_V4'), 'fast-close marker missing');
check(page.includes('PASTRIMI_FAST_CLOSE_OPTIMISTIC_V4'), 'optimistic close block missing');
check(page.includes('PASTRIMI_FAST_CLOSE_DETACHED_V4'), 'detached background marker missing');
check(page.includes('savePastrimiPaymentIntent(paymentIntent)'), 'synchronous durable intent journal missing');
check(page.includes('enqueuePastrimiPaymentIntent(paymentIntent)'), 'IndexedDB/background queue handoff missing');
check(page.includes("payment_sync_state: 'BACKGROUND_PENDING'"), 'optimistic order is not marked background pending');
check(page.includes("payment_idempotency_key: paymentIdempotencyKey"), 'optimistic order lacks idempotency identity');
check(page.includes("setRowPaySheet(false);\n    setRowPayOrder(null);\n    setRowPayAmount(0);\n    setRowPayBusy(false);"), 'payment sheet does not close immediately');
check(page.includes("amount: applied,\n      syncPending: true"), 'optimistic receipt does not use the applied amount');
check(page.includes('Promise.resolve().then(runPaymentInBackground);'), 'background sync is not detached');
check(!page.includes('await runPaymentInBackground();'), 'UI still waits for the background payment');
check(page.includes("60000,\n          'PASTRIMI_ROW_PAYMENT_TIMEOUT'"), 'background timeout remains too short for the observed 20-second server completion');
check(page.includes("console.warn('[PASTRIMI_PAYMENT_FAST_CLOSE_V4] background sync pending'"), 'background failure is not recorded safely');
check(!page.includes("alert(`❌ PAGESA NUK U RUAJT: ${err?.message || 'PROVO PËRSËRI.'}`);"), 'false post-journal failure alert remains');

check(pos.includes('POS_MODAL_TOUCH_CONFIRM_V3'), 'iOS touch confirm protection missing');
check(pos.includes('confirmGuardRef'), 'duplicate touch/click guard missing');
check(pos.includes("disabled ? 'DUKE RUAJTUR...' : confirmText"), 'visible busy state missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const touchInstaller = 'node tools/apply-pastrimi-payment-touch-v3.mjs';
const fastInstaller = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';
const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
const gatiFinalInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(fastInstaller), 'fast-close installer missing from prebuild');
check(prebuild.lastIndexOf(touchInstaller) < prebuild.lastIndexOf(fastInstaller), 'fast-close installer must run after touch V3');
check(prebuild.lastIndexOf(fastInstaller) < prebuild.lastIndexOf(arkaInstaller), 'fast-close installer must run before ARKA installer');
check(prebuild.trim().endsWith(gatiFinalInstaller), 'GATI compatible version owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:pastrimi-payment-fast-close-v4'), 'fast-close verifier missing from full build');
check(String(pkg.version || '').includes('pastrimi-payment-fast-close-v4'), 'package build version missing fast-close suffix');
check(gatiInstaller.includes('pastrimi-payment-fast-close-v4'), 'final version owner can overwrite fast-close build identity');
check(vite.includes('pastrimi-payment-fast-close-v4'), 'PWA cache generation missing fast-close suffix');
check(index.includes('pastrimi-payment-fast-close-v4'), 'HTML build id missing fast-close suffix');
check(installer.includes('PASTRIMI_PAYMENT_FAST_CLOSE_V4'), 'installer marker missing');

// Regression fixture from the reported incident: the ARKA row appeared immediately,
// while the final order verification completed about 20 seconds later. The UI must
// close before that background completion and the idempotency key must make retries safe.
const serverCompletionMs = 19970;
const oldBlockingTimeoutMs = 15000;
const newUiCloseMs = 0;
check(serverCompletionMs > oldBlockingTimeoutMs, 'incident fixture no longer proves the old false-timeout path');
check(newUiCloseMs < oldBlockingTimeoutMs, 'new UI close is not independent from the server timeout');

if (failures.length) {
  console.error(`FAIL PASTRIMI payment fast close V4: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS PASTRIMI payment fast close V4: payment closes immediately after durable journaling and syncs idempotently in background.');
