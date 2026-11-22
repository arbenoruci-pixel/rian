import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { handoffActorKey, loadWorkerHandoffPreview } from '../lib/workerHandoffPreview.js';

// All identities, amounts and dates below are synthetic. The real bonus client
// is bundled with a mocked RPC transport; this runner cannot reach live data.
const TEST_ACTOR = { id:'preview-worker-id', pin:'preview-worker', role:'PUNTOR', is_active:true };
const TEST_DATE = '2040-04-12';
const SALARY_PROFILE = {
  salary_enabled:true, meal_enabled:false, commission_enabled:false,
  transport_bonus_enabled:false, ready_bonus_enabled:false, cash_mode:'FULL_CASH',
};
const READ_KEYS = ['finance', 'bonuses', 'meals', 'mealCoverage'];
const clone = value => structuredClone(value);
const makeFinance = () => ({
  worker:{ ...TEST_ACTOR },
  profile:{ ...SALARY_PROFILE },
  cash:{ rows:[{ id:'synthetic-cash-a' }, { id:'synthetic-cash-b' }], open_gross:100, open_due_to_base:100, open_commission:0 },
});
function makePreview(overrides = {}) {
  const requestActor = clone(overrides.actor || TEST_ACTOR);
  const state = {
    currentActor:clone(requestActor), finance:makeFinance(), bonuses:[], meals:[], mealCoverage:[],
    ...overrides,
  };
  const calls = Object.fromEntries(READ_KEYS.map(key => [key, []]));
  const failures = {};
  const read = key => async (...args) => {
    calls[key].push(args);
    if (failures[key]) throw failures[key];
    return clone(state[key]);
  };
  const load = (options = {}) => loadWorkerHandoffPreview({
    actor:requestActor, date:TEST_DATE, online:true, getCurrentActor:() => state.currentActor,
    readFinance:read('finance'), readBonuses:read('bonuses'),
    readMeals:read('meals'), readMealCoverage:read('mealCoverage'), ...options,
  });
  return { state, calls, failures, load };
}
const expectCode = (operation, code, label) => assert.rejects(operation, error => error.code === code, label);
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const fresh = makePreview({
  bonuses:[
    { payment_id:101, source:'BASE', remaining_amount:'4.25' },
    { payment_id:102, source:'TRANSPORT_CONTROL', remaining_amount:'2.50' },
  ],
  meals:[
    { id:'meal-older-day', amount:'3.00', created_at:'2040-04-10T10:00:00Z' },
    { id:'meal-today', amount:3, created_at:'2040-04-12T10:00:00Z' },
  ],
  mealCoverage:[{ id:'meal-today' }],
});
const first = await fresh.load();
assert.equal(first.bonusAvailable, 6.75, 'Base flag must not hide either ledger source');
assert.equal(first.unsettledMealDeduct, 6, 'Outstanding meals include earlier days');
assert.equal(first.existingMealCovered, true);
assert.equal(first.straightSalaryOnly, false);
assert.equal(first.grossTotal, 100);
assert.equal(first.baseTotal, 100);
assert.equal(first.commissionTotal, 0);
assert.equal(first.clientCount, 2);
assert.equal(first.actorKey, handoffActorKey(TEST_ACTOR));
assert.deepEqual(fresh.calls.finance[0], [{ pin:TEST_ACTOR.pin, date:TEST_DATE }]);
assert.deepEqual(fresh.calls.bonuses[0], [TEST_ACTOR.pin, { allowNonWorker:true, requireOnline:true }]);
assert.deepEqual(fresh.calls.meals[0], [TEST_ACTOR.pin, { limit:100 }]);
assert.deepEqual(fresh.calls.mealCoverage[0], [TEST_ACTOR.pin]);
fresh.state.finance.cash.open_gross = 120;
fresh.state.finance.cash.open_due_to_base = 120;
fresh.state.bonuses = [{ payment_id:103, source:'TRANSPORT_CONTROL', remaining_amount:1.25 }];
fresh.state.meals = [{ id:'meal-new-balance', amount:3 }];
fresh.state.mealCoverage = [];
const second = await fresh.load();
assert.equal(second.grossTotal, 120);
assert.equal(second.bonusAvailable, 1.25);
assert.equal(second.unsettledMealDeduct, 3);
assert.equal(second.existingMealCovered, false);
assert(READ_KEYS.every(key => fresh.calls[key].length === 2), 'Every reopening must read all four current sources');
const offline = makePreview();
await expectCode(() => offline.load({ online:false }), 'HANDOFF_PREVIEW_OFFLINE');
assert(READ_KEYS.every(key => offline.calls[key].length === 0));
console.log('PASS: each preview freshly reads cash, both bonus sources and all outstanding meals, and refuses offline preview.');

for (const changedActor of [
  null,
  { ...TEST_ACTOR, id:'another-worker-id', pin:'another-worker' },
  { ...TEST_ACTOR, id:'replaced-worker-id' },
  { ...TEST_ACTOR, role:'DISPATCH' },
  { ...TEST_ACTOR, is_active:false },
]) {
  const pending = makePreview();
  const reads = Object.fromEntries(READ_KEYS.map(key => [key, defer()]));
  const promise = pending.load({
    readFinance:() => reads.finance.promise,
    readBonuses:() => reads.bonuses.promise,
    readMeals:() => reads.meals.promise,
    readMealCoverage:() => reads.mealCoverage.promise,
  });
  const rejection = expectCode(promise, 'HANDOFF_SESSION_CHANGED', 'A pending read must not return the previous session balance');
  pending.state.currentActor = changedActor;
  for (const key of READ_KEYS) reads[key].resolve(clone(pending.state[key]));
  await rejection;
}
for (const options of [
  { currentActor:null },
  { currentActor:{ ...TEST_ACTOR, is_active:false } },
  { actor:{ ...TEST_ACTOR, is_active:false }, currentActor:{ ...TEST_ACTOR } },
  { actor:{ ...TEST_ACTOR, pin:'' } },
]) {
  const rejected = makePreview(options);
  await expectCode(() => rejected.load(), 'HANDOFF_SESSION_CHANGED');
  assert(READ_KEYS.every(key => rejected.calls[key].length === 0), 'Invalid sessions must fail before readers run');
}
const sameIdentity = makePreview();
sameIdentity.state.currentActor = { ...TEST_ACTOR, role:' puntor ', name:'Changed display name' };
await sameIdentity.load();
console.log('PASS: logout, account/ID/role switches and deactivation reject in-flight reads; invalid sessions perform no reads.');

for (const key of READ_KEYS) {
  const broken = makePreview();
  const failure = new Error(`SYNTHETIC_${key.toUpperCase()}_READ_FAILED`);
  broken.failures[key] = failure;
  await assert.rejects(() => broken.load(), error => error === failure, `${key} failure must propagate without a zero fallback`);
}
for (const mutate of [
  state => { state.finance = null; },
  state => { state.finance.profile = null; },
  state => { state.finance.cash.rows = {}; },
  state => { state.finance.worker.pin = 'another-worker'; },
  state => { state.bonuses = null; },
  state => { state.meals = {}; },
  state => { state.mealCoverage = undefined; },
]) {
  const incomplete = makePreview();
  mutate(incomplete.state);
  await expectCode(() => incomplete.load(), 'HANDOFF_PREVIEW_INCOMPLETE');
}
const invalidAmounts = [undefined, null, '', ' ', 'invalid', NaN, Infinity, -0.01, true, false, [], {}];
for (const invalid of invalidAmounts) {
  for (const field of ['open_gross', 'open_due_to_base', 'open_commission']) {
    const invalidCash = makePreview();
    invalidCash.state.finance.cash[field] = invalid;
    await expectCode(() => invalidCash.load(), 'HANDOFF_PREVIEW_INCOMPLETE', `${field} must reject ${String(invalid)}`);
  }
  const invalidBonus = makePreview({ bonuses:[{ remaining_amount:invalid }] });
  await expectCode(() => invalidBonus.load(), 'HANDOFF_PREVIEW_INCOMPLETE', `Bonus must reject ${String(invalid)}`);
  const invalidMeal = makePreview({ meals:[{ amount:invalid }] });
  await expectCode(() => invalidMeal.load(), 'HANDOFF_PREVIEW_INCOMPLETE', `Meal must reject ${String(invalid)}`);
}
for (const mutate of [
  state => { state.finance.cash.open_due_to_base = 0; },
  state => { state.finance.cash.rows = []; },
]) {
  const emptyCash = makePreview();
  mutate(emptyCash.state);
  await expectCode(() => emptyCash.load(), 'HANDOFF_CASH_EMPTY');
}
console.log('PASS: read errors, incomplete/mismatched workers, malformed money and empty cash fail closed without inventing zero balances.');

const salary = makePreview();
assert.equal((await salary.load()).straightSalaryOnly, true);
assert(READ_KEYS.every(key => salary.calls[key].length === 1), 'The salary shortcut still requires fresh verified reads');
for (const entries of [
  { bonuses:[{ remaining_amount:0.01 }] },
  { meals:[{ amount:0.01 }] },
]) {
  const withDeduction = makePreview(entries);
  assert.equal((await withDeduction.load()).straightSalaryOnly, false, 'Any outstanding deduction requires the wizard');
}
for (const override of [
  { salary_enabled:false }, { meal_enabled:true }, { commission_enabled:true },
  { transport_bonus_enabled:true }, { ready_bonus_enabled:true }, { cash_mode:'HYBRID_COMMISSION' },
]) {
  const changedProfile = makePreview();
  Object.assign(changedProfile.state.finance.profile, override);
  assert.equal((await changedProfile.load()).straightSalaryOnly, false);
}
const hybrid = makePreview({ actor:{ ...TEST_ACTOR, is_hybrid_transport:false } });
Object.assign(hybrid.state.finance.profile, { commission_enabled:true, cash_mode:'HYBRID_COMMISSION' });
Object.assign(hybrid.state.finance.cash, { open_commission:20, open_due_to_base:80 });
assert.equal((await hybrid.load()).hybridEnabled, true);
const canonicalSalary = makePreview({ actor:{ ...TEST_ACTOR, is_hybrid_transport:true } });
assert.equal((await canonicalSalary.load()).hybridEnabled, false);
console.log('PASS: straight-salary bypass requires fresh zero bonus/meal balances and the canonical profile controls hybrid eligibility.');

// Exercise the actual client implementation. Only its four dependencies are
// replaced; all online checks, validation and mapping run from production code.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin:{ contents:"export { listOpenBaseReadyBonusPayments } from './lib/baseReadyBonusClient.js';", resolveDir:repoRoot },
  bundle:true, write:false, platform:'browser', format:'iife', globalName:'PreviewBonusClient',
  plugins:[{
    name:'synthetic-bonus-client-dependencies',
    setup(builder) {
      builder.onResolve({ filter:/^@\/lib\/(actorSession|offlineSyncClient|supabaseClient|usersDb)$/ }, args => ({ path:args.path, namespace:'preview-mock' }));
      builder.onLoad({ filter:/.*/, namespace:'preview-mock' }, args => ({
        contents:{
          '@/lib/actorSession':'export const getActor = () => globalThis.__fixture.actor;',
          '@/lib/offlineSyncClient':'export const queueOp = () => { throw new Error("Unexpected queue write"); };',
          '@/lib/supabaseClient':'export const supabase = { rpc:(...args) => globalThis.__fixture.rpc(...args) };',
          '@/lib/usersDb':'export const listUsers = () => { throw new Error("Unexpected user lookup"); };',
        }[args.path], loader:'js',
      }));
    },
  }],
});
const clientCalls = [];
const fixture = {
  actor:{ ...TEST_ACTOR }, response:{ data:[], error:null },
  rpc:async (...args) => { clientCalls.push(args); return fixture.response; },
};
const context = vm.createContext({
  __fixture:fixture, navigator:{ onLine:true },
  fetch:() => { throw new Error('Live network access is forbidden in this regression test'); },
});
vm.runInContext(bundle.outputFiles[0].text, context);
const list = context.PreviewBonusClient.listOpenBaseReadyBonusPayments;
const strict = { allowNonWorker:true, requireOnline:true };
const plain = value => JSON.parse(JSON.stringify(value));
const validRow = (overrides = {}) => ({ payment_id:201, bonus_id:301, remaining_amount:'4.25', order_id:401, order_code:501, ready_at:null, ...overrides });
fixture.response = { data:[validRow({ source:'BASE' }), validRow({ payment_id:202, bonus_id:302, remaining_amount:'2.50', source:'TRANSPORT_CONTROL' })], error:null };
const onlineRows = await list(` ${TEST_ACTOR.pin} `, strict);
assert.equal(onlineRows.reduce((sum, row) => sum + row.remaining_amount, 0), 6.75);
assert.deepEqual(plain(clientCalls.at(-1)), ['list_worker_open_ready_bonus_payments_v1', { p_actor_pin:TEST_ACTOR.pin }]);
const beforeOffline = clientCalls.length;
context.navigator.onLine = false;
await assert.rejects(() => list(TEST_ACTOR.pin, strict), /internet/i);
assert.deepEqual(plain(await list(TEST_ACTOR.pin)), [], 'Legacy offline callers preserve their existing empty result');
assert.equal(clientCalls.length, beforeOffline, 'Offline rejection must not call the RPC');
context.navigator.onLine = true;
for (const data of [null, undefined, {}]) {
  fixture.response = { data, error:null };
  await assert.rejects(() => list(TEST_ACTOR.pin, strict), /ngarkuan|bonus/i);
}
fixture.response = { data:null, error:null };
assert.deepEqual(plain(await list(TEST_ACTOR.pin)), [], 'Legacy incomplete-data mapping remains compatible');
for (const invalid of invalidAmounts) {
  fixture.response = { data:[validRow({ remaining_amount:invalid })], error:null };
  await assert.rejects(() => list(TEST_ACTOR.pin, strict), undefined, `Strict RPC must reject invalid bonus amount ${String(invalid)} before normalization`);
}
for (const row of [null, {}, validRow({ payment_id:0 }), validRow({ payment_id:'invalid' })]) {
  fixture.response = { data:[row], error:null };
  await assert.rejects(() => list(TEST_ACTOR.pin, strict), undefined, 'Strict RPC must not silently discard an unreadable bonus row');
}
for (const duplicate of [validRow({ bonus_id:302 }), validRow({ payment_id:202 })]) {
  fixture.response = { data:[validRow(), duplicate], error:null };
  await assert.rejects(() => list(TEST_ACTOR.pin, strict), undefined, 'Duplicate payment/bonus identity must not double the preview deduction');
}
fixture.response = { data:[validRow({ remaining_amount:0 })], error:null };
assert.deepEqual(plain(await list(TEST_ACTOR.pin, strict)), [], 'A valid zero remainder remains a valid empty outstanding balance');
fixture.response = { data:[validRow({ remaining_amount:'invalid' })], error:null };
assert.deepEqual(plain(await list(TEST_ACTOR.pin)), [], 'Legacy malformed-row filtering remains unchanged');
for (const failure of [new Error('SYNTHETIC_NETWORK_FAILURE'), { code:'42501', message:'SYNTHETIC_ACCESS_DENIED' }]) {
  fixture.response = { data:null, error:failure };
  await assert.rejects(() => list(TEST_ACTOR.pin, strict), error => error === failure);
}
const nonWorker = { code:'P0001', message:'BONUS_WORKER_ONLY' };
fixture.response = { data:null, error:nonWorker };
assert.deepEqual(plain(await list(TEST_ACTOR.pin, strict)), [], 'The existing explicit non-worker bypass remains supported');
await assert.rejects(() => list(TEST_ACTOR.pin, { requireOnline:true }), error => error === nonWorker);
fixture.actor = null;
const beforeEmptyPin = clientCalls.length;
await assert.rejects(() => list('', strict), /llogaria|pin/i);
assert.deepEqual(plain(await list('')), []);
assert.equal(clientCalls.length, beforeEmptyPin, 'Empty identity must not call the RPC');
console.log('PASS: actual bonus client requireOnline rejects offline, missing identity, partial/malformed results and RPC errors while preserving explicit legacy/non-worker behavior.');
