import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

// Run the actual finance module. All external reads and the mutation RPC are
// replaced by synthetic fixtures; this verifier never connects to a database.
const source = fs.readFileSync('lib/corporateFinance.js', 'utf8');
const fixtures = {
  '@/lib/supabaseClient': `export const supabase = { from: (...args) => globalThis.fixture.from(...args), rpc: (...args) => globalThis.fixture.rpc(...args) };`,
  '@/lib/arkaCashSync': `export const listPendingCashForActor = (...args) => globalThis.fixture.cash(...args);`,
  '@/lib/arkaService': `export const listWorkerUnsettledMealPayments = (...args) => globalThis.fixture.meals(...args); export const settleWorkerExtrasForHandoff = () => { throw new Error('UNEXPECTED_EXTRA_SETTLEMENT'); };`,
  '@/lib/arka/arkaClient': `export const buildArkaIdempotencyKey = (action, parts) => [action, ...parts].join('|'); export const arkaTransaction = () => { throw new Error('UNEXPECTED_HTTP_FALLBACK'); };`,
  '@/lib/baseReadyBonusClient': `export const BASE_READY_BONUS_TYPE = 'READY_48H_BONUS'; export const listOpenBaseReadyBonusPayments = (...args) => globalThis.fixture.bonuses(...args);`,
  '@/lib/payrollMonthClose': `export const matchesPayrollRecipient = () => false;`,
};
const compiled = await build({
  stdin: { contents: `${source}\nexport { verifyHandoffSubmitResponse };`, resolveDir: process.cwd(), sourcefile: 'lib/corporateFinance.js' },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'synthetic-handoff', setup(builder) {
    builder.onResolve({ filter: /^@\// }, args => args.path === '@/lib/arka/arkaConstants'
      ? { path: path.resolve('lib/arka/arkaConstants.js') }
      : { path: args.path, namespace: 'fixture' });
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      assert(args.path in fixtures, `Unstubbed dependency: ${args.path}`);
      return { contents: fixtures[args.path], loader: 'js' };
    });
  } }],
});
const module = { exports: {} };
const context = { module, exports: module.exports, fixture: null };
vm.runInNewContext(compiled.outputFiles[0].text, context);
const { submitWorkerCashToDispatch, verifyHandoffSubmitResponse } = module.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const actor = { pin: '9000', name: 'Punëtori test', role: 'PUNTOR' };
const openBonuses = [
  { payment_id: 201, bonus_id: 501, remaining_amount: 3, order_id: 101 },
  { payment_id: 202, bonus_id: 502, remaining_amount: 0.5, order_id: 0 },
];
const options = { expectedMealPaymentIds: [], expectedReadyBonusPaymentIds: [201, 202], expectedReadyBonusRows: openBonuses };
const cappedResponse = () => ({
  ok: true, total: 0.01, grossTotal: 2, mealTotal: 0, readyBonusTotal: 1.99,
  handoff: { id: 900, amount: 0.01, status: 'PENDING_DISPATCH_APPROVAL' },
  readyBonusAllocations: [{ id: 701, bonus_id: 501, amount: 1.99, status: 'RESERVED' }],
  verification: { paymentCount: 3, itemCount: 1, itemSum: 0.01, handoffAmount: 0.01, paymentStatuses: [
    { id: 101, type: 'IN', status: 'PENDING_DISPATCH_APPROVAL', handoff_note: 'HANDOFF:900' },
    { id: 201, type: 'READY_48H_BONUS', status: 'ACCEPTED_BY_DISPATCH', handoff_note: 'READY_BONUS_OPEN:501|PARTIAL_IN_HANDOFF:900:1.99' },
    { id: 202, type: 'READY_48H_BONUS', status: 'ACCEPTED_BY_DISPATCH', handoff_note: 'READY_BONUS_OPEN:502' },
  ] },
});
const fullResponse = () => {
  const response = cappedResponse();
  Object.assign(response, { total: 5.5, grossTotal: 12, mealTotal: 3, readyBonusTotal: 3.5 });
  response.handoff.amount = 5.5;
  response.readyBonusAllocations = [
    { id: 701, bonus_id: 501, amount: 3, status: 'RESERVED' },
    { id: 702, bonus_id: 502, amount: 0.5, status: 'RESERVED' },
  ];
  Object.assign(response.verification, { paymentCount: 4, itemSum: 5.5, handoffAmount: 5.5 });
  response.verification.paymentStatuses[1].handoff_note = 'SETTLED_IN_HANDOFF:900|READY_BONUS:501';
  response.verification.paymentStatuses[2].handoff_note = 'SETTLED_IN_HANDOFF:900|READY_BONUS:502';
  response.verification.paymentStatuses.push({ id: 301, type: 'MEAL_PAYMENT', status: 'PENDING', handoff_note: 'SETTLED_IN_HANDOFF:900|MEAL_DAY:2026-11-20' });
  return response;
};
function useFixture({ response = cappedResponse(), meals = [], bonuses = openBonuses, mealError = '', bonusError = '' } = {}) {
  const calls = [];
  context.fixture = {
    cash: async () => ({ items: [
      { id: 101, type: 'IN', status: 'PENDING', amount: response.grossTotal },
      { id: 201, type: 'READY_48H_BONUS', status: 'PENDING', amount: 3 },
    ] }),
    meals: async () => { if (mealError) throw new Error(mealError); return clone(meals); },
    bonuses: async () => { if (bonusError) throw new Error(bonusError); return clone(bonuses); },
    from: table => {
      assert.equal(table, 'arka_pending_payments');
      const chain = {
        update(patch) { calls.push({ kind: 'owner-update', patch }); return chain; },
        in() { return chain; }, eq() { return chain; }, is() { return chain; },
        select: async () => ({ data: [], error: null }),
      };
      return chain;
    },
    rpc: async (name, args) => { calls.push({ kind: 'rpc', name, args: clone(args) }); return { data: clone(response), error: null }; },
  };
  return calls;
}
let groups = 0;
const pass = message => { groups++; console.log(`PASS ${message}`); };

let calls = useFixture();
const capped = await submitWorkerCashToDispatch({ actor });
assert.equal(capped.total, 0.01);
assert.equal(capped.readyBonusTotal, 1.99);
assert.deepEqual(calls.find(call => call.kind === 'rpc').args.ready_bonus_payment_ids, [201, 202]);
assert.deepEqual(calls.find(call => call.kind === 'rpc').args.payment_ids, [101]);
assert.equal(calls.filter(call => call.kind === 'rpc').length, 1);
assert.equal(capped.verification.paymentStatuses[2].handoff_note, 'READY_BONUS_OPEN:502');
pass('A capped handoff succeeds with a partial Base bonus and an untouched Transport bonus, without a second RPC or counting bonuses as client cash.');

calls = useFixture({ response: fullResponse(), meals: [{ id: 301, amount: 3 }] });
const full = await submitWorkerCashToDispatch({ actor });
assert.equal(full.total, 5.5);
assert.equal(full.readyBonusTotal, 3.5);
assert.equal(full.mealTotal, 3);
assert.deepEqual(calls.find(call => call.kind === 'rpc').args.meal_payment_ids, [301]);
assert.equal(calls.find(call => call.kind === 'rpc').name, 'submit_cash_handoff_with_ready_bonus_v1');
pass('Full Base and Transport allocations preserve meal proof and the server-confirmed net cash.');

const minimum = cappedResponse();
minimum.grossTotal = 0.01;
minimum.readyBonusTotal = 0;
minimum.readyBonusAllocations = [];
minimum.verification.paymentStatuses[1].handoff_note = 'READY_BONUS_OPEN:501';
useFixture({ response: minimum });
assert.equal((await submitWorkerCashToDispatch({ actor })).readyBonusTotal, 0);
const noBonus = cappedResponse();
Object.assign(noBonus, { total: 2, readyBonusTotal: 0, readyBonusAllocations: [] });
noBonus.handoff.amount = 2;
Object.assign(noBonus.verification, { itemSum: 2, handoffAmount: 2, paymentCount: 1, paymentStatuses: noBonus.verification.paymentStatuses.slice(0, 1) });
useFixture({ response: noBonus, bonuses: [] });
assert.equal((await submitWorkerCashToDispatch({ actor })).total, 2);
pass('The one-cent floor leaves all bonuses open; a cash-only handoff retains its existing behavior.');

for (const mutate of [
  response => { response.readyBonusAllocations[0].bonus_id = 999; },
  response => { response.readyBonusAllocations.push({ ...response.readyBonusAllocations[0] }); },
  response => { response.readyBonusAllocations.push({ ...response.readyBonusAllocations[0], id: 702 }); },
  response => { response.readyBonusAllocations[0].status = 'REVERSED'; },
  ...[0, -1, NaN, Infinity, 0.001].map(amount => response => { response.readyBonusAllocations[0].amount = amount; }),
  response => { response.readyBonusTotal = 2; },
  response => { response.readyBonusTotal = NaN; },
  response => { delete response.readyBonusAllocations; },
  response => { delete response.readyBonusTotal; },
]) {
  const response = cappedResponse(); mutate(response);
  assert.throws(() => verifyHandoffSubmitResponse(response, [101], options), /HANDOFF_BONUS_/);
}
assert.throws(() => verifyHandoffSubmitResponse(cappedResponse(), [101], { ...options, expectedReadyBonusRows: [] }), /HANDOFF_BONUS_REQUEST_MAPPING_MISSING/);
pass('Allocation proof rejects unknown or duplicate bonuses, invalid amounts/statuses, missing evidence, and a total that differs from the allocation sum.');

for (const mutate of [
  response => { response.verification.paymentStatuses[1].id = 999; },
  response => { response.verification.paymentStatuses[1].type = 'IN'; },
  response => { response.verification.paymentStatuses[1].handoff_note = 'READY_BONUS_OPEN:501'; },
  response => { response.verification.paymentStatuses[1].handoff_note = 'SETTLED_IN_HANDOFF:900|READY_BONUS:502'; },
  response => { response.verification.paymentStatuses[1].handoff_note = 'SETTLED_IN_HANDOFF:9000|READY_BONUS:501'; },
  response => { response.verification.paymentStatuses[2].handoff_note = 'SETTLED_IN_HANDOFF:901|READY_BONUS:502'; },
  response => { response.handoff.amount = 1; response.verification.itemSum = 1; response.verification.handoffAmount = 1; },
]) {
  const response = cappedResponse(); mutate(response);
  assert.throws(() => verifyHandoffSubmitResponse(response, [101], options), /HANDOFF_(DEDUCTION_VERIFY_MISSING|PAYMENT_VERIFY_FAILED)/);
}
pass('Allocated proof must identify the correct requested payment, bonus and exact handoff; untouched bonuses are accepted only when the cash cap is exhausted.');

for (const mutate of [
  response => { response.verification.paymentStatuses[0].status = 'COLLECTED'; },
  response => { response.verification.paymentStatuses = response.verification.paymentStatuses.slice(1); },
  response => { response.handoff.amount = 9; },
  response => { response.handoff.cash_handoff_items = [{ pending_payment_id: 201, amount: 0.01 }]; },
]) {
  const response = cappedResponse(); mutate(response);
  assert.throws(() => verifyHandoffSubmitResponse(response, [101], options), /HANDOFF_/);
}
const badMeal = fullResponse();
badMeal.verification.paymentStatuses.at(-1).handoff_note = 'MEAL_DAY:2026-11-20';
assert.throws(() => verifyHandoffSubmitResponse(badMeal, [101], { ...options, expectedMealPaymentIds: [301] }), /HANDOFF_PAYMENT_VERIFY_FAILED:301/);
pass('Missing cash proof, changed client totals, bonus-as-cash items and unsettled meal proofs still fail.');

for (const [field, error] of [['mealError', 'MEAL_READ_FAILED'], ['bonusError', 'BONUS_READ_FAILED']]) {
  calls = useFixture({ [field]: error });
  await assert.rejects(() => submitWorkerCashToDispatch({ actor }), new RegExp(error));
  assert.equal(calls.length, 0, 'Failed deduction reads must stop before owner updates or the handoff RPC.');
  useFixture();
  assert.equal((await submitWorkerCashToDispatch({ actor })).total, 0.01, 'A failed read releases the existing submit lock.');
}
pass('Meal or bonus read failure blocks all submit actions and permits a safe retry after the read recovers.');

console.log(`Verified ${groups} handoff allocation proof groups with synthetic fixtures.`);
