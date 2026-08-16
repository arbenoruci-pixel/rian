import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const pos = fs.readFileSync('components/PosModal.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-pastrimi-payment-touch-v3.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const gatiVerifier = fs.readFileSync('tools/verify-gati-rack-save-v1.mjs', 'utf8');
const arkaVerifier = fs.readFileSync('tools/verify-arka-daily-close-v2.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

check(page.includes('PASTRIMI_PAYMENT_TOUCH_V3'), 'Pastrimi touch marker missing');
check(page.includes('PASTRIMI_ROW_PAYMENT_TIMEOUT'), 'bounded row-payment wait missing');
check(page.includes("withTimeout(\n          recordOrderCashPayment("), 'background payment is not wrapped by timeout');

const openStart = page.indexOf('async function openRowPay(row)');
const setOrderAt = page.indexOf('setRowPayOrder({', openStart);
const resetAt = page.lastIndexOf('setRowPayBusy(false);', setOrderAt);
check(openStart >= 0, 'openRowPay function missing');
check(setOrderAt > openStart, 'setRowPayOrder missing from openRowPay');
check(resetAt > openStart && resetAt < setOrderAt, 'stale busy state is not reset before a new POS sheet opens');

check(pos.includes('POS_MODAL_TOUCH_CONFIRM_V3'), 'POS touch marker missing');
check(pos.includes("import React, { useMemo, useRef } from 'react';"), 'POS duplicate-tap ref missing');
check(pos.includes("onPointerUp={(event) =>"), 'pointer-up fallback missing');
check(pos.includes("onTouchEnd={() => fireConfirm('touchend')}"), 'touch-end fallback missing');
check(pos.includes("onClick={() => fireConfirm('click')}"), 'click fallback missing');
check(pos.includes('confirmGuardRef.current'), 'duplicate confirmation guard missing');
check(pos.includes("disabled ? 'DUKE RUAJTUR...' : confirmText"), 'busy state is not visible on the confirmation button');
check(pos.includes('.posbtn--ok:disabled'), 'disabled confirmation styling missing');
check(pos.includes('touch-action: manipulation'), 'mobile touch action optimization missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const touchInstaller = 'node tools/apply-pastrimi-payment-touch-v3.mjs';
const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
const gatiFinalInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(touchInstaller), 'touch installer missing from prebuild');
check(prebuild.includes(arkaInstaller), 'ARKA installer missing from prebuild');
check(prebuild.trim().endsWith(gatiFinalInstaller), 'combined GATI final version owner is not last');
check(prebuild.lastIndexOf(touchInstaller) < prebuild.lastIndexOf(arkaInstaller), 'touch installer must run before ARKA finalization');
check(prebuild.lastIndexOf(arkaInstaller) < prebuild.lastIndexOf(gatiFinalInstaller), 'GATI version owner must run after ARKA');
check(String(pkg.scripts?.build || '').includes('npm run test:pastrimi-payment-touch-v3'), 'touch verifier missing from full build');
check(String(pkg.scripts?.['test:pastrimi-payment-touch-v3'] || '').includes('verify-pastrimi-payment-touch-v3.mjs'), 'touch test script missing');
check(String(pkg.version || '').includes('pastrimi-payment-touch-v3'), 'combined package version missing touch suffix');

check(installer.includes('PASTRIMI_PAYMENT_TOUCH_V3'), 'installer marker missing');
check(installer.includes('PASTRIMI_ROW_PAYMENT_TIMEOUT'), 'installer timeout patch missing');
check(gatiInstaller.includes('pastrimi-payment-touch-v3'), 'final version owner can overwrite touch build id');
check(gatiInstaller.includes('sw-navigation-diag.js?v=3512'), 'final service worker import generation is not 3512');
check(gatiVerifier.includes('sw-navigation-diag.js?v=3512'), 'GATI verifier does not accept service worker generation 3512');
check(arkaVerifier.includes('pastrimi-payment-touch-v3'), 'ARKA verifier does not accept combined touch cache generation');
check(arkaVerifier.includes('sw-navigation-diag.js?v=3512'), 'ARKA verifier does not accept service worker generation 3512');

if (failures.length) {
  console.error(`FAIL Pastrimi payment touch V3: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS Pastrimi payment touch V3: stale busy state resets, touch/click handlers are deduplicated, busy is visible, payment wait is bounded, and build ownership is compatible.');
