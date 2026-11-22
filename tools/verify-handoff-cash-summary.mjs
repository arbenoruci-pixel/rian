import assert from 'node:assert/strict';
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

// Server-reviewed wizard interaction coverage lives in verify-worker-handoff-wizard-ui.mjs.
