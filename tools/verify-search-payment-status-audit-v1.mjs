import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Execute shipping modules with synthetic network/storage boundaries. No live writes.
let checks = 0;
const failures = [];
async function test(name, fn) { try { await fn(); checks++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
function moduleUnderTest(file, deps = {}, globals = {}) {
  const source = fs.readFileSync(file, 'utf8').replace(/import\((['"])([^'"]+)\1\)/g, (_, q, name) => `Promise.resolve(__deps[${JSON.stringify(name)}])`);
  const code = transformSync(source, { loader: 'js', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (!(name in deps)) throw new Error(`Missing fixture ${name}`); return deps[name]; }, __deps: deps, URLSearchParams, AbortController, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout, console: { warn() {} }, ...globals });
  return module.exports;
}
const actor = { id: 'fixture-worker', pin: 'fixture-pin' };
let reply, submitted;
const pay = moduleUnderTest('components/payments/payService.js', {
  '@/lib/arka/arkaConstants': { ARKA_ACTION: { BASE_ORDER_PAYMENT: 'BASE_ORDER_PAYMENT' } },
  '@/lib/arka/arkaClient': { arkaTransaction: async payload => { submitted = payload; return reply; }, buildArkaIdempotencyKey: () => 'fixture-intent' },
});
const payInput = { orderId: 101, amount: 5, user: actor, idempotencyKey: 'fixture-intent' };
for (const queueFlag of ['offlineQueued', 'queued', 'localOnly']) await test(`payment ${queueFlag} is pending, never successful`, async () => {
  reply = { ok: true, [queueFlag]: true, queuedOpId: 'fixture-queue' };
  const result = await pay.recordOrderCashPayment(payInput);
  assert.equal(result.ok, false); assert.equal(result.pending, true); assert.equal(result.offlineQueued, true);
});
for (const badReply of [{ ok: true }, { ok: true, payment: { id: 'fixture-payment' } }, { ok: true, order: { id: 101 } }, { ok: true, payment: { id: 'fixture-payment' }, order: { id: 102 } }, { ok: false, payment: { id: 'fixture-payment' }, order: { id: 101 } }]) await test('payment requires complete matching confirmed response', async () => {
  reply = badReply; assert.equal((await pay.recordOrderCashPayment(payInput)).ok, false);
});
await test('verified payment and explicit zero debt remain valid', async () => {
  reply = { ok: true, payment: { id: 'fixture-payment' }, order: { id: '101' } };
  assert.equal((await pay.recordOrderCashPayment({ ...payInput, expectedDebt: 0 })).ok, true);
  assert.equal(submitted.expectedDebt, 0); assert.equal(submitted.idempotencyKey, 'fixture-intent');
});
await test('absent debt is not converted into zero', async () => {
  await pay.recordOrderCashPayment({ ...payInput, expectedDebt: null, expected_debt: null });
  assert.equal('expectedDebt' in submitted, false);
});

const status = moduleUnderTest('lib/statusEngine.js');
for (const terminal of ['done', 'completed', 'cancelled', 'canceled', 'anuluar']) for (const next of ['loaded', 'gati', 'delivery']) await test(`${terminal} cannot return to ${next}`, () => assert.equal(status.canTransitionStatus('transport_orders', terminal, next), false));
for (const [table, from, to] of [['orders','pastrim','gati'], ['orders','gati','pastrim'], ['orders','gati','dorzim'], ['transport_orders','pastrim','gati'], ['transport_orders','loaded','gati']]) await test(`valid ${table} ${from} -> ${to}`, () => assert.equal(status.canTransitionStatus(table, from, to), true));

const uuid = '11111111-1111-4111-8111-111111111111';
function searchHarness(find, { online = true, snapshot = [], hang = false } = {}) {
  const db = { from(table) {
    const filters = {};
    const q = { select: () => q, eq: (k,v) => { filters[k]=v; return q; }, order: () => q, limit: () => q, maybeSingle: () => q, ilike: () => q, in: () => q, abortSignal: () => q, then: (yes,no) => (hang ? new Promise(() => {}) : Promise.resolve(find(table, filters))).then(yes,no) };
    return q;
  }, rpc: () => hang ? new Promise(() => {}) : Promise.resolve({ data: [] }) };
  return moduleUnderTest('lib/homeSearch.js', {
    '@/lib/supabaseClient': { supabase: db },
    '@/lib/baseMasterCache': { readBaseMasterCache: () => ({ rows: snapshot }) },
  }, { navigator: { onLine: online } });
}
await test('typed BASE query rejects conflicting cached ID', async () => {
  const search = searchHarness((_t, f) => ({ data: f.id ? { id: 101, code: 999, status: 'gati' } : null }));
  const result = await search.resolveHomeSearchTarget({ kind: 'BASE', id: 101, code: '999' }, { query: '123' });
  assert.equal(result.resolved, false); assert.equal(result.result.code, '123'); assert(!result.href.includes('openId=101'));
});
await test('typed Transport query rejects conflicting cached UUID', async () => {
  const search = searchHarness((_t, f) => ({ data: f.id ? { id: uuid, code_n: 999, code_str: 'T999', status: 'loaded' } : null }));
  const result = await search.resolveHomeSearchTarget({ kind: 'TRANSPORT', id: uuid, code: 'T999' }, { query: 'T123' });
  assert.equal(result.resolved, false); assert(result.href.includes('code=T123')); assert(!result.href.includes(uuid));
});
await test('offline mismatch routes by requested code only', async () => {
  const search = searchHarness(() => ({}), { online: false });
  const result = await search.resolveHomeSearchTarget({ kind: 'BASE', id: 101, code: '999' }, { query: '123' });
  assert(!result.href.includes('openId=101')); assert(result.href.includes('openCode=123'));
});
await test('live matching code chooses latest status', async () => {
  const search = searchHarness(() => ({ data: { id: 102, code: 123, status: 'gati' } }));
  const result = await search.resolveHomeSearchTarget({ kind: 'BASE', id: 101, code: '123', status: 'pastrim' }, { query: '123' });
  assert.equal(result.resolved, true); assert(result.href.startsWith('/gati?')); assert(result.href.includes('openId=102'));
});
for (const phone of ['12025550199', '+1 202 555 0199', '2025550199']) await test(`phone ${phone} searches both modules`, async () => {
  const search=searchHarness(() => ({data:[]}), {online:false,snapshot:[
    {id:101,code:123,status:'gati',client_phone:'+12025550199',client_name:'Synthetic base'},
    {id:uuid,code_str:'T123',code_n:123,status:'loaded',client_phone:'+12025550199',client_name:'Synthetic transport',_table:'transport_orders'},
  ]});
  assert.equal(search.getHomeSearchQueryMode(phone),'GENERAL');
  const result=await search.searchHomeLocalFirst(phone);
  assert(result.results.some(row=>row.kind==='BASE'));assert(result.results.some(row=>row.kind==='TRANSPORT'));
});
await test('short numeric codes still select only BASE; T codes only Transport',()=>{
  const search=searchHarness(()=>({})); assert.equal(search.getHomeSearchQueryMode('123'),'BASE_ONLY');assert.equal(search.getHomeSearchQueryMode('T123'),'TRANSPORT_ONLY');
});
// A watchdog fails the test if the application has no own bounded read.
async function watchdog(promise) { let timer; try { return await Promise.race([promise, new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('operation never releases UI')), 400); })]); } finally { clearTimeout(timer); } }
await test('hanging DB does not hide available cached results indefinitely', async () => {
  const search = searchHarness(() => ({}), { hang: true, snapshot: [{ id: 101, code: 123, status: 'gati', client_name: 'Synthetic fixture' }] });
  const result = await watchdog(search.searchHomeLocalFirst('123'));
  assert(result.results.some(row => row.code === '123')); assert.equal(result.incomplete, true);
});
await test('hanging click resolver releases UI to a safe fallback', async () => {
  const search = searchHarness(() => ({}), { hang: true });
  const result = await watchdog(search.resolveHomeSearchTarget({ kind: 'BASE', id: 101, code: '123' }, { query: '123' }));
  assert.equal(result.resolved, false); assert(result.href.includes('openCode=123'));
});

// Run the actual shared write and transition functions: an HTTP 200/zero-row update
// is not a successful status change; a concurrent version must not be overwritten.
const service = fs.readFileSync('lib/ordersService.js', 'utf8');
const updateSource = service.slice(service.indexOf('export async function updateOrderRecord'), service.indexOf('export async function createOrderRecord')).replace('export ', '');
const transitionSource = service.slice(service.indexOf('export async function transitionOrderStatus'), service.indexOf('export async function fetchOrderByIdSafe')).replace('export ', '');
function statusHarness({ missing = false, denied = false, concurrent = false, dbError = null } = {}) {
  let stored = { id: 101, status: 'pastrim', updated_at: 'version-1' }, writes = 0;
  const context = vm.createContext({
    resolveTable: t => t, normalizeStatusForTable: status.normalizeStatusForTable, assertTransitionStatus: status.assertTransitionStatus,
    fetchOrderById: async () => { const read = { ...stored }; if (concurrent) stored = { ...stored, status: 'dorzim', updated_at: 'version-2' }; return missing ? null : read; },
    protectTransportAssignStatusOverwrite: async (_t,_id,p) => p,
    normalizeBaseOrderWritePayload: async (_t,_id,p) => p,
    sanitizeTransportOrdersPayload: (_t,p) => p,
    supabase: { from() { return { update(patch) { const filters={}; const q={ eq: (k,v) => { filters[k]=v; return q; }, select: async () => {
      if (dbError) return { error: dbError };
      if (denied || (filters.updated_at && filters.updated_at !== stored.updated_at)) return { data: [] };
      writes++; stored={ ...stored, ...patch }; return { data:[{ id: stored.id }] };
    } }; return q; } }; } },
  });
  vm.runInContext(updateSource + transitionSource, context);
  return { context, state: () => ({ stored, writes }) };
}
await test('zero affected rows never report a saved update', async () => {
  const h=statusHarness({ denied:true }); await assert.rejects(h.context.updateOrderRecord('orders',101,{status:'gati'}), /ORDER_UPDATE_NOT_APPLIED/); assert.equal(h.state().writes,0);
});
await test('concurrent status is preserved, caller receives conflict', async () => {
  const h=statusHarness({ concurrent:true }); await assert.rejects(h.context.transitionOrderStatus('orders',101,'gati'), /ORDER_STATUS_CONFLICT/); assert.equal(h.state().stored.status,'dorzim'); assert.equal(h.state().writes,0);
});
await test('missing order never reaches update', async () => {
  const h=statusHarness({ missing:true }); await assert.rejects(h.context.transitionOrderStatus('orders',101,'gati'), /ORDER_NOT_FOUND/); assert.equal(h.state().writes,0);
});
await test('ordinary ready transition writes and timestamps once', async () => {
  const h=statusHarness(); assert.equal((await h.context.transitionOrderStatus('orders',101,'gati')).ok,true); assert.equal(h.state().writes,1); assert(h.state().stored.ready_at);
});
await test('database failure is preserved without success', async () => {
  const error={code:'42501',message:'denied'}; const h=statusHarness({dbError:error}); await assert.rejects(h.context.updateOrderRecord('orders',101,{status:'gati'}), e => e.code==='42501');
});

// Execute the shipping search handlers from both components with controlled late replies.
for (const file of ['app/page.jsx','components/GlobalHomeSearch.jsx']) {
  const source=fs.readFileSync(file,'utf8'), home=file==='app/page.jsx';
  const start=source.indexOf(home ? '  const submitSearch = ' : '  const resetSearch = ');
  const end=source.indexOf(home ? '  const handleCreateNewForClient = ' : '  const createNewForClient = ',start);
  const handlers=source.slice(start,end);
  function uiHarness() {
    let finishSearch, finishOpen;
    const values={query:'123',results:[],opening:'',routes:[],message:''};
    const noop=()=>{};
    const ctx=vm.createContext({
      React:{useCallback:fn=>fn}, q:'123',query:'123',searching:false,openingResultKey:'',searchTokenRef:{current:0},inputRef:{current:null},
      cleanSearch:s=>s.trim(),setSearching:noop,setDidSearch:noop,setOpen:noop,
      setQ:v=>{values.query=v;},setQuery:v=>{values.query=v;},setResults:v=>{values.results=v;},setOpeningResultKey:v=>{values.opening=v;},
      setMessage:v=>{values.message=v;},setSearchMessage:v=>{values.message=v;},
      searchHomeLocalFirst:()=>new Promise(resolve=>{finishSearch=resolve;}),
      resolveHomeSearchTarget:()=>new Promise(resolve=>{finishOpen=resolve;}),buildHomeSearchHref:()=>'/gati',
      router:{push:href=>values.routes.push(href)},
    });
    vm.runInContext(handlers+`\nthis.handlers={submitSearch,openSearchResult,reset:${home?'clearSearch':'resetSearch'}${home?'':',closeModal'}}`,ctx);
    return { values, ctx, search:()=>finishSearch, open:()=>finishOpen };
  }
  await test(`${file}: editing query invalidates late search`, async () => {
    const h=uiHarness();const pending=h.ctx.handlers.submitSearch();h.ctx.handlers.reset('456');h.search()({results:[{code:'123'}]});await pending;
    assert.equal(h.values.query,'456');assert.equal(h.values.results.length,0);
  });
  await test(`${file}: editing query invalidates late navigation`, async () => {
    const h=uiHarness();const pending=h.ctx.handlers.openSearchResult({id:101,kind:'BASE',code:'123'});h.ctx.handlers.reset('456');h.open()({href:'/gati?openCode=123'});await pending;
    assert.equal(h.values.routes.length,0);assert.equal(h.values.opening,'');
  });
  await test(`${file}: successful open releases lock for another search`, async () => {
    const h=uiHarness();const pending=h.ctx.handlers.openSearchResult({id:101,kind:'BASE',code:'123'});h.open()({href:'/gati?openCode=123'});await pending;
    assert.equal(h.values.routes.length,1);assert.equal(h.values.opening,'');
  });
  await test(`${file}: unavailable DB is not presented as no orders`, async () => {
    const h=uiHarness();const pending=h.ctx.handlers.submitSearch();h.search()({results:[],incomplete:true});await pending;
    assert(h.values.message.includes('nuk u përfundua'));
  });
}
if (failures.length) { console.error(failures.join('\n')); console.error(`${checks} passed, ${failures.length} failed`); process.exitCode=1; }
else console.log(`PASS search/payment/status audit: ${checks} behavioral checks`);
