import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildHandoffCashSummary, readConfirmedHandoffReceipt } from '../lib/handoffCashSummary.js';

// Synthetic amounts and identities only. No live account, payment or RPC calls.
const full = buildHandoffCashSummary({ grossTotal:100, baseTotal:100, mealDeduct:3, bonusAvailable:6.50 });
assert.deepEqual(full, { gross:100, commission:0, baseBeforeDeductions:100, mealDeduct:3, afterMeal:97, bonusHeld:6.50, bonusRemaining:0, netToDispatch:90.50, canSubmit:true });
const capped = buildHandoffCashSummary({ grossTotal:5, bonusAvailable:10 });
assert.equal(capped.bonusHeld, 4.99);
assert.equal(capped.netToDispatch, 0.01);
assert.equal(capped.bonusRemaining, 5.01);
assert.equal(buildHandoffCashSummary({ grossTotal:0.01, bonusAvailable:10 }).bonusHeld, 0);
assert.equal(buildHandoffCashSummary({ grossTotal:0.01, bonusAvailable:10 }).canSubmit, true);
assert.equal(buildHandoffCashSummary({ grossTotal:3, mealDeduct:3, bonusAvailable:10 }).canSubmit, false);
assert.equal(buildHandoffCashSummary({ grossTotal:2, mealDeduct:3 }).canSubmit, false);
assert.equal(buildHandoffCashSummary({ grossTotal:100, baseTotal:0, bonusAvailable:10 }).netToDispatch, 0);
const hybrid = buildHandoffCashSummary({ grossTotal:100, workerHybrid:true, commissionTotal:20, mealDeduct:3, bonusAvailable:6.50 });
assert.equal(hybrid.baseBeforeDeductions, 80);
assert.equal(hybrid.netToDispatch, 70.50);
const salary = buildHandoffCashSummary({ grossTotal:100, commissionTotal:20, workerHybrid:false });
assert.equal(salary.commission, 0);
assert.equal(salary.netToDispatch, 100);
assert.equal(buildHandoffCashSummary({ grossTotal:Infinity, baseTotal:NaN, bonusAvailable:Infinity }).netToDispatch, 0);
assert.equal(buildHandoffCashSummary({ grossTotal:0.30, bonusAvailable:0.10 }).netToDispatch, 0.20);
const actual = { ok:true, handoff:{ id:'test-handoff', amount:89.75 }, readyBonusTotal:7.25 };
assert.deepEqual(readConfirmedHandoffReceipt(actual), { handoffId:'test-handoff', netToDispatch:89.75, bonusHeld:7.25 });
for (const bad of [undefined, { ...actual, ok:false }, { ok:true, handoff:{amount:' '}, readyBonusTotal:0 }, { ok:true, handoff:{amount:5}, readyBonusTotal:false }]) {
  assert.equal(readConfirmedHandoffReceipt(bad), null);
}
console.log('PASS: preview uses cash after meals, preserves the final cent, carries unused bonus and leaves ordinary salary/hybrid arithmetic intact.');

const bundle = await build({
  stdin:{ contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import Wizard from './components/HandoffWizard.jsx';
    const root = createRoot(document.getElementById('root'));
    window.__render = props => { window.__props = props; root.render(<Wizard {...props}/>); };
    window.__unmount = () => root.unmount();
    window.__render(window.__props);
  `, loader:'jsx', resolveDir:process.cwd() },
  bundle:true, write:false, format:'iife', jsx:'automatic', alias:{ '@':process.cwd() },
  define:{ 'process.env.NODE_ENV':'"test"' },
});
const wait = async (check) => {
  const until = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for actual handoff wizard');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function open(props = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM('<div id="root"></div>', { url:'https://tepiha.test/arka', pretendToBeVisual:true, runScripts:'outside-only', virtualConsole });
  const w = dom.window;
  w.fetch = () => { throw new Error('Wizard must not introduce network requests'); };
  w.__props = { open:true, actor:{ id:'test-worker-id', pin:'test-worker', name:'PUNËTOR TEST', role:'PUNTOR' }, grossTotal:100, baseTotal:100, bonusAvailable:6.50, clientCount:2, ...props };
  w.eval(bundle.outputFiles[0].text);
  const button = (label) => [...w.document.querySelectorAll('button')].find((item) => item.textContent.trim() === label || item.querySelector('b')?.textContent.trim() === label);
  const text = () => w.document.body.textContent;
  await wait(() => button('VAZHDO'));
  const click = async (label) => { assert(button(label), `Missing button ${label}`); button(label).click(); await new Promise((resolve) => setTimeout(resolve, 10)); };
  const close = () => { w.__unmount(); dom.window.close(); assert.equal(errors.length, 0); };
  return { w, button, text, click, close };
}

let submitCalls = [];
let resolveSubmit;
const ui = await open({ onSubmit:async (decision) => { submitCalls.push(JSON.parse(JSON.stringify(decision))); return new Promise((resolve) => { resolveSubmit = resolve; }); } });
assert(ui.text().includes('Bonus për ta mbajtur nga ky cash'));
assert(ui.text().includes('93.50 €'));
assert(ui.text().includes('Ushqimi llogaritet në hapin tjetër.'));
await ui.click('VAZHDO');
await ui.click('Po, e kam pagu vetZbriten 3.00 € prej dorëzimit');
await ui.click('VAZHDO');
assert.equal(ui.w.document.querySelector('[data-handoff-net]').textContent, '90.50 €');
assert(ui.w.document.querySelector('[data-handoff-bonus-held]').textContent.includes('6.50 €'));
assert(ui.text().includes('Kjo shumë e përfshin zbritjen e bonusit dhe të ushqimit.'));
const finish = ui.button('DORËZO 90.50 €');
finish.click(); finish.click();
await wait(() => submitCalls.length === 1);
assert.deepEqual(submitCalls[0], { mealChoice:'1', mealPayerPin:'' });
assert(!ui.text().includes('Dorëzimi u regjistrua'));
// Simulate the parent reloading its now-empty cash balance before resolving.
ui.w.__render({ ...ui.w.__props, grossTotal:0, baseTotal:0, bonusAvailable:0 });
resolveSubmit(actual);
await wait(() => ui.w.document.querySelector('[data-handoff-confirmed-receipt]'));
const receipt = ui.w.document.querySelector('[data-handoff-confirmed-receipt]').textContent;
assert(receipt.includes('7.25 €'));
assert(receipt.includes('89.75 €'));
assert(!receipt.includes('82.50 €'));
assert.equal(submitCalls.length, 1);
ui.close();
console.log('PASS: real wizard shows gross/bonus/NET, submits once, and renders the verified server receipt without subtracting the bonus again.');

const capUi = await open({ grossTotal:5, baseTotal:5, bonusAvailable:10 });
await capUi.click('VAZHDO');
await capUi.click('Jo, nuk kam marrë ushqimPa zbritje për ushqim');
await capUi.click('VAZHDO');
assert.equal(capUi.w.document.querySelector('[data-handoff-net]').textContent, '0.01 €');
assert(capUi.text().includes('4.99 €'));
assert(capUi.text().includes('Edhe 5.01 € bonus mbeten në dispozicion'));
capUi.close();

let attempts = 0;
const retryUi = await open({ existingMealCovered:true, existingMealDeduct:3, bonusAvailable:0, onSubmit:async (decision) => {
  assert.equal(decision.mealChoice, '');
  attempts++;
  if (attempts === 1) throw new Error('TEST_HANDOFF_NOT_SAVED');
  return { ok:true, handoff:{ id:'test-retry', amount:97 }, readyBonusTotal:0 };
} });
await retryUi.click('VAZHDO');
await retryUi.click('VAZHDO');
assert.equal(retryUi.w.document.querySelector('[data-handoff-net]').textContent, '97.00 €');
await retryUi.click('DORËZO 97.00 €');
await wait(() => retryUi.text().includes('TEST_HANDOFF_NOT_SAVED'));
assert(!retryUi.w.document.querySelector('[data-handoff-confirmed-receipt]'));
await retryUi.click('DORËZO 97.00 €');
await wait(() => retryUi.w.document.querySelector('[data-handoff-confirmed-receipt]'));
assert(retryUi.w.document.querySelector('[data-handoff-confirmed-receipt]').textContent.includes('97.00 €'));
assert.equal(attempts, 2);
retryUi.close();
console.log('PASS: cash-limited bonus remainder is explicit; existing meals are preserved and failed submission stays reviewable until a successful retry.');

for (const choice of ['none', 'other', 'self']) {
  const carryUi = await open({ unsettledMealDeduct:3, staffOptions:[{ pin:'test-payer', name:'PAYER TEST' }] });
  assert(carryUi.text().includes('Ushqim i mbetur për zbritje'));
  await carryUi.click('VAZHDO');
  await carryUi.click(({ none:'Jo, nuk kam marrë ushqim', other:'Po, ma ka pagu dikush tjetër', self:'Po, e kam pagu vet' })[choice]);
  if (choice === 'other') {
    const select = carryUi.w.document.querySelector('select');
    select.value = 'test-payer';
    select.dispatchEvent(new carryUi.w.Event('change', { bubbles:true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await carryUi.click('VAZHDO');
  assert.equal(carryUi.w.document.querySelector('[data-handoff-net]').textContent, choice === 'self' ? '87.50 €' : '90.50 €');
  assert(carryUi.text().includes('Përfshin 3.00 € të mbetura nga regjistrimet e ushqimit.'));
  carryUi.close();
}
const settledToday = await open({ existingMealCovered:true, existingMealDeduct:3, unsettledMealDeduct:6 });
await settledToday.click('VAZHDO');
assert(settledToday.text().includes('Zbriten 6.00 € sipas regjistrimit'));
await settledToday.click('VAZHDO');
assert.equal(settledToday.w.document.querySelector('[data-handoff-net]').textContent, '87.50 €');
settledToday.close();
let blockedSubmits = 0;
const blocked = await open({ grossTotal:3, baseTotal:3, unsettledMealDeduct:3, onSubmit:async () => { blockedSubmits++; } });
await blocked.click('VAZHDO');
await blocked.click('Jo, nuk kam marrë ushqim');
await blocked.click('VAZHDO');
assert(blocked.text().includes('Nuk mbetet cash për Dispatch pas ushqimit.'));
assert(blocked.button('DORËZO 0.00 €').disabled);
blocked.button('DORËZO 0.00 €').click();
assert.equal(blockedSubmits, 0);
blocked.close();
console.log('PASS: all unsettled meals remain deducted for none/other/existing choices; a new self-paid meal adds €3 once, and exhausted cash cannot submit.');

for (const canonicalHybrid of [false, true]) {
  const canonical = await open({
    actor:{ id:'test-profile', pin:'test-worker', name:'PUNËTOR TEST', role:'PUNTOR', is_hybrid_transport:!canonicalHybrid },
    hybridEnabled:canonicalHybrid, commissionTotal:20, grossTotal:100, baseTotal:canonicalHybrid ? 80 : 100, bonusAvailable:0, unsettledMealDeduct:0,
  });
  assert.equal(canonical.text().includes('Komision transporti që e mban'), canonicalHybrid);
  await canonical.click('VAZHDO');
  await canonical.click('Jo, nuk kam marrë ushqim');
  await canonical.click('VAZHDO');
  assert.equal(canonical.w.document.querySelector('[data-handoff-net]').textContent, canonicalHybrid ? '80.00 €' : '100.00 €');
  assert.equal(canonical.text().includes('Komisioni që e mban'), canonicalHybrid);
  canonical.close();
}
console.log('PASS: canonical hybrid flag overrides stale actor commission in both directions.');
