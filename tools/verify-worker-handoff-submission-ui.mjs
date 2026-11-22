import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Synthetic worker declarations and dispatch identities only. The test performs
// no production read, authentication or financial write.
const actor = { id:'30000000-0000-4000-8000-000000000001', name:'Fixture Dispatch', role:'DISPATCH' };
const another = { ...actor, id:'30000000-0000-4000-8000-000000000002', name:'Another Fixture' };
const clone = value => JSON.parse(JSON.stringify(value));
const wait = async (predicate, label = 'dispatch state') => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const identityPlugin = { name:'synthetic-identity', setup(builder) {
  builder.onResolve({ filter:/lib\/actorSession$/ }, args => ({ path:args.path, namespace:'fixture' }));
  builder.onLoad({ filter:/.*/, namespace:'fixture' }, () => ({ contents:'export const getActor=()=>window.actor;' }));
} };
async function bundle(contents) {
  return (await build({ stdin:{ contents, loader:'jsx', resolveDir:process.cwd() }, bundle:true, write:false, format:'iife', jsx:'automatic', alias:{ '@':process.cwd() }, define:{ 'process.env.NODE_ENV':'"test"' }, plugins:[identityPlugin] })).outputFiles[0].text;
}
function browser() {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('<div id="root"></div>', { url:'https://fixture.test/arka', pretendToBeVisual:true, runScripts:'outside-only', virtualConsole });
  const w = dom.window;
  w.actor = clone(actor);
  w.fetch = () => { throw new Error('Unexpected fixture network access'); };
  return { w, close() { w.__unmount?.(); w.close(); assert.equal(errors.length, 0, errors.map(String).join('\n')); } };
}

const clientBundle = await bundle("import * as client from './lib/workerHandoffClient.js';window.client=client;");
const durable = browser();
durable.w.eval(clientBundle);
const requests = [];
let response = async () => { throw new Error('Synthetic reply lost after decision commit'); };
durable.w.fetch = async (url, options) => {
  assert.equal(url, '/api/worker-handoff');
  requests.push(JSON.parse(options.body));
  return response();
};
const decision = { claimId:71, approve:true, note:'Receipt and source checked', confirmFunding:true };
await assert.rejects(durable.w.client.decideWorkerHandoffExpense(decision), /reply lost/);
const firstRequest = clone(requests[0]);
assert.equal(firstRequest.action, 'decide-expense');
assert.equal(firstRequest.expectedActorId, actor.id);
assert.match(firstRequest.requestKey, /^WHE1:/);
assert.equal(durable.w.client.readWorkerHandoffExpenseIntent(71).approve, true);
await assert.rejects(durable.w.client.decideWorkerHandoffExpense({ ...decision, approve:false }), /pret përgjigjen/);
assert.equal(requests.length, 1);
response = async () => ({ ok:true, status:200, json:async () => ({ ok:true, replayed:true, claimId:71 }) });
await durable.w.client.decideWorkerHandoffExpense({ claimId:71, approve:false, note:'Changed text' }, { retry:true });
assert.deepEqual(requests[1], firstRequest);
assert.equal(durable.w.client.readWorkerHandoffExpenseIntent(71), null);
response = async () => ({ ok:false, status:409, json:async () => ({ ok:false, error:'WHW_ACTUAL_RECEIPT_REQUIRED' }) });
await assert.rejects(durable.w.client.decideWorkerHandoffExpense(decision), /pranove fizikisht/);
assert.equal(durable.w.client.readWorkerHandoffExpenseIntent(71), null);
response = async () => { throw new Error('Synthetic uncertain response'); };
await assert.rejects(durable.w.client.decideWorkerHandoffExpense(decision));
durable.w.actor = clone(another);
assert.equal(durable.w.client.readWorkerHandoffExpenseIntent(71), null);
await assert.rejects(durable.w.client.decideWorkerHandoffExpense(decision, { retry:true }), /Nuk ka vendim/);
durable.close();
console.log('PASS dispatch client persists a decision before sending, retries its exact original payload after a lost reply, clears definite rejections, and isolates actor identities');

const payoutClient = browser(); payoutClient.w.eval(clientBundle);
const payoutRequests = [];
let payoutResponse = async () => { throw new Error('Synthetic payout reply lost after commit'); };
payoutClient.w.fetch = async (url, options) => { assert.equal(url, '/api/worker-handoff'); payoutRequests.push(JSON.parse(options.body)); return payoutResponse(); };
const payoutPayload = { claimId:72, amount:12.34, note:'Paid physically from the drawer', confirmPaid:true };
await assert.rejects(payoutClient.w.client.reimburseWorkerHandoffExpense(payoutPayload), /reply lost/);
const originalPayout = clone(payoutRequests[0]);
assert.equal(originalPayout.action, 'reimburse-expense'); assert.equal(originalPayout.amount, 12.34); assert.equal(originalPayout.confirmPaid, true);
assert.match(originalPayout.requestKey, /^WHR1:/);
assert.equal(payoutClient.w.client.readWorkerHandoffReimbursementIntent(72).note, payoutPayload.note);
await assert.rejects(payoutClient.w.client.reimburseWorkerHandoffExpense({ ...payoutPayload, amount:99 }), /pret përgjigjen/);
assert.equal(payoutRequests.length, 1);
payoutClient.w.actor = clone(another);
assert.equal(payoutClient.w.client.readWorkerHandoffReimbursementIntent(72), null);
await assert.rejects(payoutClient.w.client.reimburseWorkerHandoffExpense(payoutPayload, { retry:true }), /Nuk ka rimbursim/);
payoutClient.w.actor = clone(actor);
payoutResponse = async () => ({ ok:true, status:200, json:async () => ({ ok:true, replayed:true, claim:{ id:72, status:'REIMBURSED', expenseLedgerId:501 } }) });
await payoutClient.w.client.reimburseWorkerHandoffExpense({ ...payoutPayload, amount:99, note:'Different note' }, { retry:true });
assert.deepEqual(payoutRequests[1], originalPayout);
assert.equal(payoutClient.w.client.readWorkerHandoffReimbursementIntent(72), null);
payoutResponse = async () => ({ ok:false, status:409, json:async () => ({ ok:false, error:'WHW_SELF_APPROVAL' }) });
await assert.rejects(payoutClient.w.client.reimburseWorkerHandoffExpense(payoutPayload));
assert.equal(payoutClient.w.client.readWorkerHandoffReimbursementIntent(72), null);
payoutClient.close();
console.log('PASS reimbursement client preserves the exact amount, payment note, confirmation and request key for replay, and separates payout intent by actor');

const uiBundle = await bundle("import React from 'react';import {createRoot} from 'react-dom/client';import Submission from './components/WorkerHandoffSubmission.jsx';const root=createRoot(document.getElementById('root'));window.__render=props=>{window.__props=props;root.render(<Submission {...props}/>);};window.__unmount=()=>root.unmount();window.__render(window.__props);");
const baseClaim = { id:71, description:'Buk\nARKA_EXPENSE_REQUEST_V1 type=BUSINESS_EXPENSE', amount:12, deductionAmount:9, mealAlreadyDeducted:3, spentOn:'2026-11-21', category:'FOOD', recipient:'Fixture team', fundingSource:'WORKER_COLLECTIONS', status:'PENDING', canDecide:true, requiresActualReceipt:true };
function record(claims = [baseClaim]) {
  return { ok:true, canDecide:true, submission:{ id:1, handoffId:42, expectedCash:87, projectedCash:78, physicalCash:25, differenceAmount:-53, differenceReason:'Only 25 physically counted. Expense evidence remains under review.', snapshot:{ totals:{ grossCash:100, commission:0, bonusDeduction:10, bonusRemaining:0, mealDeduction:3, claimedCollectionExpenses:9 }, payments:[{ id:11, code:'C1001', clientName:'Fixture Client', amount:100, collectedAt:'2026-11-21T10:00:00Z' }], bonuses:[{ bonusId:21, paymentId:31, kind:'BASE', amount:6, remainingAmount:6 }, { bonusId:22, paymentId:32, kind:'TRANSPORT', amount:4, remainingAmount:4 }] } }, claims:clone(claims) };
}
async function mount({ api, onChange = () => {} }) {
  const fixture = browser(), w = fixture.w;
  w.__props = { actor:clone(actor), handoffId:42, api, onChange };
  w.eval(uiBundle);
  await wait(() => w.document.querySelector('details'));
  const query = selector => w.document.querySelector(selector);
  const text = () => w.document.body.textContent.replace(/\s+/g, ' ');
  const button = label => [...w.document.querySelectorAll('button')].find(element => element.textContent.trim() === label);
  const click = async label => { await wait(() => button(label), label); const el = button(label); assert.equal(el.disabled, false); el.click(); await new Promise(resolve => setTimeout(resolve, 10)); };
  const open = async () => { query('details > summary').click(); await wait(() => query('details').open); await new Promise(resolve => setTimeout(resolve, 10)); };
  const input = async (selector, value) => { const el = query(selector); assert.ok(el); Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new w.Event('input', { bubbles:true })); await new Promise(resolve => setTimeout(resolve, 10)); };
  const rerender = props => w.__render({ ...w.__props, ...props });
  return { ...fixture, query, text, button, click, open, input, rerender };
}

let reads = 0, currentClaim = clone(baseClaim), pending = null, decideResolve, changed = 0;
const decisions = [];
const api = {
  read:async id => { assert.equal(id, 42); reads++; return record([currentClaim]); },
  pendingExpense:id => id === 71 ? pending : null,
  decideExpense:async (payload, options) => {
    decisions.push({ payload:clone(payload), options:clone(options) });
    if (!options.retry) return new Promise((resolve, reject) => { decideResolve = { resolve, reject }; });
    assert.ok(pending); pending = null; return { ok:true, replayed:true };
  },
};
const ui = await mount({ api, onChange:() => { changed++; } });
assert.equal(reads, 0);
await ui.open(); await wait(() => ui.text().includes('Llogaritja e ruajtur'));
assert.equal(reads, 1);
assert.match(ui.text(), /87,00/); assert.match(ui.text(), /78,00/); assert.match(ui.text(), /25,00/); assert.match(ui.text(), /53,00/);
assert.match(ui.text(), /Buk · 12,00/); assert.match(ui.text(), /Ushqim personal i zbritur tashmë.*3,00/); assert.match(ui.text(), /Kërkesë për ulje të dorëzimit.*9,00/);
assert.doesNotMatch(ui.text(), /ARKA_EXPENSE_REQUEST_V1/); assert.equal(ui.query('article').getAttribute('aria-label'), 'Shpenzimi Buk');
assert.equal(currentClaim.description, 'Buk\nARKA_EXPENSE_REQUEST_V1 type=BUSINESS_EXPENSE');
assert.equal(ui.button('Aprovo shpenzimin').disabled, true);
assert.equal(ui.button('Refuzo kërkesën').disabled, false);
assert.match(ui.text(), /regjistro shumën që e numërove fizikisht/);
currentClaim = { ...currentClaim, requiresActualReceipt:false };
ui.rerender({ receiptVersion:'receipt-recorded' });
await wait(() => ui.button('Aprovo shpenzimin')?.disabled === false);
await ui.click('Aprovo shpenzimin');
assert.equal(ui.button('Konfirmo aprovimin').disabled, true);
await ui.input('textarea', 'Receipt and source checked');
assert.equal(ui.button('Konfirmo aprovimin').disabled, true);
ui.query('input[type="checkbox"]').click(); await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(ui.button('Konfirmo aprovimin').disabled, false);
const approve = ui.button('Konfirmo aprovimin'); approve.click(); approve.click();
await wait(() => decisions.length === 1);
assert.equal(decisions[0].payload.approve, true); assert.equal(decisions[0].payload.confirmFunding, true);
pending = { actorId:actor.id, requestKey:'WHE1:fixture', ...decisions[0].payload };
currentClaim = { ...currentClaim, status:'APPROVED', canDecide:false, decisionNote:decisions[0].payload.note };
decideResolve.reject(new Error('Reply lost after commit'));
await wait(() => ui.button('Riprovo të njëjtin vendim'));
ui.rerender({ receiptVersion:'decision-committed' });
await wait(() => ui.text().includes('Aprovuar'));
assert.ok(ui.button('Riprovo të njëjtin vendim'));
await ui.click('Riprovo të njëjtin vendim');
await wait(() => changed === 1);
assert.equal(decisions.length, 2); assert.equal(decisions[1].options.retry, true);
assert.equal(ui.button('Riprovo të njëjtin vendim'), undefined);
assert.equal(ui.button('Aprovo shpenzimin'), undefined);
ui.close();
console.log('PASS dispatch lazily reads immutable totals, distinguishes full expense/meal credit/additional claim, requires actual cash receipt plus funding checkbox and note, and safely retries after the saved claim status changes');

let rejectionPayload, rejectRecord = record([{ ...baseClaim, requiresActualReceipt:true }]);
const rejection = await mount({ api:{ read:async () => rejectRecord, pendingExpense:() => null, decideExpense:async payload => { rejectionPayload = clone(payload); rejectRecord = record([{ ...baseClaim, status:'REJECTED', canDecide:false, decisionNote:payload.note }]); return { ok:true }; } } });
await rejection.open(); await rejection.click('Refuzo kërkesën');
assert.equal(rejection.button('Konfirmo refuzimin').disabled, true);
assert.equal(rejection.query('input[type="checkbox"]'), null);
await rejection.input('textarea', 'Funding evidence does not support this claim');
await rejection.click('Konfirmo refuzimin'); await wait(() => rejection.text().includes('Refuzuar'));
assert.equal(rejectionPayload.approve, false); assert.equal(rejectionPayload.confirmFunding, false);
rejection.close();
console.log('PASS rejection needs an explanation and never records a payment');

let ownClaim = { ...baseClaim, id:72, amount:12.34, fundingSource:'OWN_MONEY', deductionAmount:0, mealAlreadyDeducted:0, requiresActualReceipt:false, canReimburse:false };
let payoutIntent = null, finishPayout, ownChanges = 0;
const acknowledgments = [], payouts = [];
function personalRecord() {
  const value = record([ownClaim]);
  value.submission.projectedCash = 87; value.submission.differenceAmount = -62; value.submission.snapshot.totals.claimedCollectionExpenses = 0;
  return value;
}
const ownApi = {
  read:async () => personalRecord(), pendingExpense:() => null, pendingReimbursement:() => payoutIntent,
  decideExpense:async payload => { acknowledgments.push(clone(payload)); ownClaim = { ...ownClaim, status:'REIMBURSEMENT_PENDING', canDecide:false, canReimburse:true, decisionNote:payload.note, decidedByName:'Fixture Reviewer', decidedAt:'2026-11-21T10:00:00Z' }; return { ok:true }; },
  reimburseExpense:async (payload, options) => {
    payouts.push({ payload:clone(payload), options:clone(options) });
    if (!options.retry) { payoutIntent = { actorId:actor.id, requestKey:'WHR1:synthetic-ui', ...clone(payload) }; return new Promise((resolve, reject) => { finishPayout = { resolve, reject }; }); }
    assert.deepEqual(clone(payload), payoutIntent);
    payoutIntent = null; return { ok:true, replayed:true, claim:clone(ownClaim) };
  },
};
const personal = await mount({ api:ownApi, onChange:() => { ownChanges++; } });
await personal.open();
assert.equal(personal.button('Regjistro rimbursimin'), undefined);
await personal.click('Verifiko shpenzimin');
assert.match(personal.text(), /rimbursim veçmas/); assert.match(personal.text(), /shuma për dorëzim mbetet e njëjtë/);
await personal.input('textarea', 'Receipt checked, worker used personal money');
personal.query('input[type="checkbox"]').click(); await new Promise(resolve => setTimeout(resolve, 10));
await personal.click('Konfirmo aprovimin'); await wait(() => personal.button('Regjistro rimbursimin'));
assert.equal(acknowledgments.length, 1); assert.equal(payouts.length, 0); assert.equal(ownChanges, 1);
assert.equal(acknowledgments[0].approve, true); assert.match(personal.text(), /Pret rimbursimin veçmas/);
assert.match(personal.query('[data-handoff-decision-audit]').textContent, /Fixture Reviewer/);
await personal.click('Regjistro rimbursimin');
assert.equal(personal.query('textarea').value, ''); assert.equal(personal.query('input[type="checkbox"]').checked, false);
assert.equal(personal.query('input[type="number"]'), null);
assert.match(personal.query('[data-handoff-reimbursement-form]').textContent, /Shuma e plotë e rimbursimit.*12,34/);
assert.match(personal.text(), /Konfirmoj se ia pagova fizikisht 12,34.*nga arka/);
assert.equal(personal.button('Konfirmo rimbursimin').disabled, true);
await personal.input('textarea', 'abc'); personal.query('input[type="checkbox"]').click(); await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(personal.button('Konfirmo rimbursimin').disabled, true);
await personal.input('textarea', 'Paid physically from drawer after verification');
personal.query('input[type="checkbox"]').click(); await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(personal.button('Konfirmo rimbursimin').disabled, true);
personal.query('input[type="checkbox"]').click(); await new Promise(resolve => setTimeout(resolve, 10));
const pay = personal.button('Konfirmo rimbursimin'); assert.equal(pay.disabled, false); pay.click(); pay.click();
await wait(() => payouts.length === 1);
assert.deepEqual(payouts[0].payload, { claimId:72, amount:12.34, note:'Paid physically from drawer after verification', confirmPaid:true });
assert.equal(payouts[0].options.retry, false);
ownClaim = { ...ownClaim, status:'REIMBURSED', canReimburse:false, expenseLedgerId:501, reimbursementNote:payouts[0].payload.note, reimbursedByName:'Fixture Cashier', reimbursedAt:'2026-11-21T11:00:00Z' };
finishPayout.reject(new Error('Payout committed but response was lost'));
await wait(() => personal.button('Riprovo të njëjtin rimbursim'));
personal.rerender({ receiptVersion:'payout-already-recorded' }); await wait(() => personal.query('[data-handoff-reimbursement-audit]'));
assert.match(personal.text(), /Rimbursuar nga arka/); assert.ok(personal.button('Riprovo të njëjtin rimbursim'));
assert.equal(personal.button('Regjistro rimbursimin'), undefined);
assert.match(personal.query('[data-handoff-decision-audit]').textContent, /Receipt checked, worker used personal money/);
assert.match(personal.query('[data-handoff-reimbursement-audit]').textContent, /Fixture Cashier/);
assert.match(personal.query('[data-handoff-reimbursement-audit]').textContent, /Paid physically from drawer after verification/);
await personal.click('Riprovo të njëjtin rimbursim'); await wait(() => ownChanges === 2);
assert.equal(payouts.length, 2); assert.equal(payouts[1].options.retry, true);
assert.equal(payouts[1].payload.requestKey, 'WHR1:synthetic-ui'); assert.equal(payouts[1].payload.amount, 12.34);
assert.equal(personal.button('Riprovo të njëjtin rimbursim'), undefined);
assert.ok(personal.query('[data-handoff-decision-audit]')); assert.ok(personal.query('[data-handoff-reimbursement-audit]'));
personal.close();
console.log('PASS own-money acknowledgment creates no payout; explicit reimbursement requires full exact amount, a new note and physical-payment confirmation, submits once, preserves both audits, and replays after REIMBURSED');

let restrictedPayouts = 0;
const restricted = await mount({ api:{ pendingExpense:() => null, pendingReimbursement:() => null, read:async () => record([{ ...ownClaim, status:'REIMBURSEMENT_PENDING', canReimburse:false, reimbursementNote:null, reimbursedAt:null }]), reimburseExpense:async () => { restrictedPayouts++; } } });
await restricted.open();
await wait(() => restricted.text().includes('Llogaritja e ruajtur'));
assert.equal(restricted.button('Regjistro rimbursimin'), undefined); assert.equal(restricted.query('[data-handoff-reimbursement-form]'), null); assert.equal(restrictedPayouts, 0);
restricted.close();
console.log('PASS an actor blocked by canReimburse, including a self-reimbursement restriction, receives no payment control');

let resolveRead, lateReads = 0;
const session = await mount({ api:{ pendingExpense:() => null, read:async () => { lateReads++; return new Promise(resolve => { resolveRead = resolve; }); } } });
await session.open(); await wait(() => resolveRead);
session.w.actor = clone(another);
session.w.dispatchEvent(new session.w.Event('tepiha:session-changed'));
await wait(() => session.query('details').open === false);
resolveRead(record()); await new Promise(resolve => setTimeout(resolve, 20));
assert.doesNotMatch(session.text(), /Only 25|Fixture Client|Buk ·/);
assert.equal(lateReads, 1);
session.close();
console.log('PASS session change closes dispatch evidence and discards a late read from the previous account');
