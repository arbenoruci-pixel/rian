import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/WorkerBonusAccount.jsx';import Wallet from './app/llogaria-ime/page.jsx';const root=createRoot(document.getElementById('root'));window.renderBonus=(actor,targetPin)=>root.render(<Panel actor={actor} targetPin={targetPin}/>);window.renderWallet=()=>root.render(<Wallet/>);`,
    resolveDir: process.cwd(), loader: 'jsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', alias: { '@': process.cwd() },
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'read-only-account-fixtures', setup(builder) {
    builder.onResolve({ filter: /(?:lib\/(workerBonusAccountClient\.js|actorSession|routerCompat\.jsx|corporateFinance|arkaService|usersService|ordersService|supabaseClient|mealPolicyClient)|components\/HandoffReceiptsPanel)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      const file = args.path.split('/').at(-1);
      const contents = {
        'workerBonusAccountClient.js': `export const workerBonusMonthKey=()=> '2026-11';export const fetchWorkerBonusAccount=args=>window.fetchAccount(args);`,
        actorSession: `export const getActor=()=>window.actor;`,
        'routerCompat.jsx': `import React from 'react';const router={replace:()=>{}};export const useRouter=()=>router;export default function Link({href,to,children,...props}){const {prefetch,...rest}=props;return <a href={href||to} {...rest}>{children}</a>}`,
        corporateFinance: `export const listWorkerDebtRows=async()=>[];`,
        arkaService: `export const listWorkerPendingPayments=async()=>window.paymentFixture||[];export const listWorkerHandoffs=async()=>[];`,
        usersService: `export const fetchSessionUserByPin=async()=>({salary:0,bonus_transport:0,bonus_ushqim:0});`,
        ordersService: `export const listMixedOrderRecords=async()=>[];`,
        supabaseClient: `export const supabase={rpc:async()=>({data:{cash:window.financeFixture||{today_gross:0,open_due_to_base:0,received_handoff_total:0,pending_handoff_total:0,pending_handoff_count:0}},error:null})};`,
        mealPolicyClient: `export const fetchMealPolicy=async()=>({actorId:window.actor.id,businessDate:'2026-11-21',settings:[],policies:[],dailyMealsAllowed:true});`,
        HandoffReceiptsPanel: `export default function Receipts(){return null;}`,
      }[file];
      if (!contents) throw new Error(`Missing fixture: ${file}`);
      return { contents, loader: 'jsx', resolveDir: process.cwd() };
    });
  } }],
});

const actor = { id: 'fixture-manager', pin: 'fixture-manager-pin', role: 'DISPATCH' };
const fixture = {
  version: 1, enabled: true, worker: { id: 'fixture-worker', name: 'Punëtori test' }, month: '2026-11', timezone: 'Europe/Belgrade', generatedAt: '2026-11-21T12:00:00Z',
  totals: { earned: 22, earnedCount: 6, retained: 13.5, retainedCount: 5, available: 3, reserved: 5.5, retainedAllTime: 57, ledgerRetainedAllTime: 57 },
  sources: [
    { source: 'BASE', label: 'Bazë', earned: 20, earnedCount: 2, retained: 12, retainedCount: 2, available: 3, reserved: 5, retainedAllTime: 52, ledgerRetainedAllTime: 52 },
    { source: 'TRANSPORT_CONTROL', label: 'Kontroll transporti', earned: 2, earnedCount: 4, retained: 1.5, retainedCount: 3, available: 0, reserved: .5, retainedAllTime: 5, ledgerRetainedAllTime: 5 },
  ],
  rows: [
    { id: 'base-1', source: 'BASE', code: '#501', earnedAt: '2026-11-05T12:00:00Z', m2: 100, amount: 10, status: 'PARTIAL_RESERVED', available: 3, reserved: 2, retained: 5, ledgerRetained: 5, handoffs: [{ id: '105', status: 'ACCEPTED', allocationStatus: 'RETAINED', amount: 5, submittedAt: '2026-11-05T12:00:00Z', decidedAt: '2026-11-05T13:00:00Z' }], reconciliationDifference: 0 },
    { id: 'control-1', source: 'TRANSPORT_CONTROL', code: 'T99', earnedAt: '2026-11-05T12:00:00Z', m2: 0, amount: .5, status: 'RETAINED', available: 0, reserved: 0, retained: .5, ledgerRetained: .5, handoffs: [{ id: '105', status: 'ACCEPTED', allocationStatus: 'RETAINED', amount: .5, decidedAt: '2026-11-05T13:00:00Z' }], reconciliationDifference: 0 },
    { id: 'control-2', source: 'TRANSPORT_CONTROL', code: 'T100', earnedAt: '2026-11-06T12:00:00Z', m2: 0, amount: .5, status: 'RESERVED', available: 0, reserved: .5, retained: 0, ledgerRetained: 0, handoffs: [{ id: '106', status: 'PENDING_DISPATCH_APPROVAL', allocationStatus: 'RESERVED', amount: .5, submittedAt: '2026-11-06T12:00:00Z' }], reconciliationDifference: 0 },
  ],
  handoffs: [
    { id: '105', status: 'ACCEPTED', submittedAt: '2026-11-05T12:00:00Z', decidedAt: '2026-11-05T13:00:00Z', base: 5, transport: .5, total: 5.5, allocations: [{ bonusId: 'base-1', source: 'BASE', code: '#501', amount: 5, status: 'RETAINED' }, { bonusId: 'control-1', source: 'TRANSPORT_CONTROL', code: 'T99', amount: .5, status: 'RETAINED' }] },
    { id: '106', status: 'PENDING_DISPATCH_APPROVAL', submittedAt: '2026-11-06T12:00:00Z', base: 5, transport: .5, total: 5.5, allocations: [{ bonusId: 'control-2', source: 'TRANSPORT_CONTROL', code: 'T100', amount: .5, status: 'RESERVED' }] },
    { id: '107', status: 'CANCELLED', submittedAt: '2026-11-07T12:00:00Z', decidedAt: '2026-11-07T13:00:00Z', base: 0, transport: 0, total: 0, allocations: [{ bonusId: 'control-2', source: 'TRANSPORT_CONTROL', code: 'T100', amount: .5, status: 'REVERSED' }] },
  ],
  pendingControls: [
    { id: 'pending-normal', code: 'T111', status: 'PENDING', orderStatus: 'pastrim', submittedAt: '2026-11-20T12:00:00Z', potentialAmount: .5, blocked: false },
    { id: 'pending-done', code: 'T112', status: 'PENDING', orderStatus: 'done', submittedAt: '2026-11-20T12:00:00Z', potentialAmount: .5, blocked: true },
    { id: 'pending-cancelled', code: 'T113', status: 'PENDING', orderStatus: 'cancelled', submittedAt: '2026-11-20T12:00:00Z', potentialAmount: .5, blocked: true },
  ],
  warnings: [{ code: 'HISTORICAL_DIFFERENCE', bonusId: 'old-1', orderCode: '#OLD', difference: 3.21 }],
};

let dom;
const copy = value => JSON.parse(JSON.stringify(value));
const text = () => dom.window.document.body.textContent;
const query = selector => dom.window.document.querySelector(selector);
const button = label => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
async function wait(predicate, message = 'UI update') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timeout: ${message}\n${text()}`);
}
async function click(label) { await wait(() => button(label) && !button(label).disabled, label); button(label).click(); await new Promise(resolve => setTimeout(resolve, 20)); }
function setInput(selector, value) {
  const element = query(selector);
  const proto = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
async function open() {
  dom?.window.close();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (!String(error.message).includes('Could not parse CSS')) throw error; });
  dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.local/account#bonuset', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  w.actor = actor;
  w.calls = [];
  w.scrollCalls = 0;
  w.HTMLElement.prototype.scrollIntoView = () => { w.scrollCalls++; };
  w.setInterval = () => { throw new Error('Bonus account must not add interval polling'); };
  w.fetchAccount = async args => { w.calls.push(args); return copy(fixture); };
  w.eval(bundle.outputFiles[0].text);
  w.renderBonus(actor, 'fixture-worker-pin');
  await wait(() => query('#bonuset') && text().includes('Punëtori test'));
  return w;
}

const w = await open();
assert.equal(w.calls.length, 1);
await wait(() => w.scrollCalls === 1, 'bonus anchor scroll after data load');
assert.equal(w.scrollCalls, 1);
assert.equal(query('[aria-label="Muaji i bonuseve"]').value, '2026-11');
assert.match(query('[data-bonus-source="BASE"] .wba-source-main').textContent, /12,00\s*€/);
assert.match(query('[data-bonus-source="TRANSPORT_CONTROL"] .wba-source-main').textContent, /1,50\s*€/);
assert.match(query('.wba-metrics').textContent, /Mbajtur në muaj13,50\s*€/);
assert.match(query('[data-bonus-handoff="105"]').textContent, /Bazë 5,00\s*€/);
assert.match(query('[data-bonus-handoff="105"]').textContent, /Kontroll transporti 0,50\s*€/);
assert(text().includes('Mbajtja u anulua'));
assert(text().includes('1 për shqyrtim · 2 kërkojnë sqarim'));
assert(query('[data-pending-control="pending-done"]').textContent.includes('Porosia është dorëzuar'));
assert(query('[data-pending-control="pending-cancelled"]').textContent.includes('Porosia është anuluar'));
assert(text().includes('mospërputhje në historikun e bonusit #OLD prej 3,21 €'));
console.log('PASS bonus UI distinguishes month earnings/accepted retention, current balances, both sources, reversed allocations and blocked controls');

await click('Transport');
assert.equal(dom.window.document.querySelectorAll('[data-bonus-id]').length, 2);
assert(!query('[data-bonus-id="base-1"]'));
setInput('[aria-label="Gjendja e bonusit"]', 'RESERVED');
await wait(() => dom.window.document.querySelectorAll('[data-bonus-id]').length === 1);
assert(query('[data-bonus-id="control-2"]'));
setInput('[aria-label="Gjendja e bonusit"]', 'ALL');
await click('Të gjitha');
await click('Rifresko');
assert.equal(w.calls.at(-1).force, true);
assert.equal(w.scrollCalls, 1, 'Refresh must not scroll the user again');
w.dispatchEvent(new w.Event('base-ready-bonus:refresh'));
await wait(() => w.calls.length === 3);
assert.equal(w.calls.at(-1).force, true);
let resolveMonth;
w.fetchAccount = args => { w.calls.push(args); return new Promise(resolve => { resolveMonth = resolve; }); };
setInput('[aria-label="Muaji i bonuseve"]', '2026-10');
await wait(() => w.calls.at(-1).month === '2026-10');
assert(query('#bonuset'), 'Eligible account keeps its controls during month loading');
assert(!query('[data-bonus-id]'), 'Old month amounts must not appear under the new month');
resolveMonth({ ...copy(fixture), month: '2026-10' });
await wait(() => query('[data-bonus-id]'));
assert.equal(query('[aria-label="Muaji i bonuseve"]').value, '2026-10');
console.log('PASS source/status filters, forced refresh, existing refresh events and month-loading isolation');

w.fetchAccount = async () => { throw new Error('Rrjeti nuk u përgjigj.'); };
await click('Rifresko');
await wait(() => query('[role="alert"]'));
assert(query('[role="alert"]').textContent.includes('ngarkimi i fundit'));
assert(query('[data-bonus-source="BASE"]'), 'A failed refresh retains the labelled last snapshot');
for (const [code, httpStatus] of [['WORKER_BONUS_FORBIDDEN', 403], ['AUTH_REQUIRED', 401], ['DEVICE_NOT_APPROVED', 403], ['WORKER_BONUS_SESSION_CHANGED', 403]]) {
  w.fetchAccount = async () => copy(fixture);
  await click('Rifresko');
  await wait(() => query('[data-bonus-source="BASE"]'));
  w.fetchAccount = async () => { throw Object.assign(new Error('Qasja në llogari u refuzua.'), { code, httpStatus }); };
  await click('Rifresko');
  await wait(() => query('[role="alert"]') && !query('.wba-metrics'));
  assert(!text().includes('Punëtori test'), `${code} must clear the worker identity and financial snapshot`);
  assert(!query('[data-bonus-id]'));
  assert(!query('[data-bonus-handoff]'));
}
w.fetchAccount = async () => copy(fixture);
await click('Rifresko');
await wait(() => query('[data-bonus-id]'));
w.actor = null;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => !query('#bonuset'));
w.actor = { id: 'another-session', pin: 'another-session-pin', role: 'PUNTOR' };
w.dispatchEvent(new w.Event('storage'));
await new Promise(resolve => setTimeout(resolve, 20));
assert(!query('#bonuset'), 'A stale parent actor cannot retain data after another login');
w.actor = actor;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => query('[data-bonus-id]'));
console.log('PASS authorization/session/device denials clear all financial data; logout and changed storage reject a stale parent actor');
let resolveOldIdentity;
w.fetchAccount = args => args.targetPin === 'slow-worker'
  ? new Promise(resolve => { resolveOldIdentity = resolve; })
  : Promise.resolve({ enabled: false, worker: { id: 'disabled-worker', name: 'Punëtor pa bonus' } });
w.renderBonus(actor, 'slow-worker');
await wait(() => !!resolveOldIdentity);
assert(!text().includes('Punëtori test'), 'Prior worker data disappears immediately');
w.renderBonus(actor, 'disabled-worker');
await new Promise(resolve => setTimeout(resolve, 30));
resolveOldIdentity(copy(fixture));
await new Promise(resolve => setTimeout(resolve, 30));
assert(!query('#bonuset'), 'Disabled worker stays empty even if prior identity resolves late');
console.log('PASS failed-refresh honesty, stale-identity response protection and hidden empty accounts');

// Exercise the actual personal-account component: bonus receipts must never
// inflate customer cash or be duplicated in the old generic history.
w.actor = { id: 'fixture-self', pin: 'fixture-self-pin', name: 'Punëtori test', role: 'PUNTOR' };
w.fetchAccount = async () => ({ enabled: false });
const today = new Date().toISOString();
w.paymentFixture = [
  { id: 'cash', type: 'CASH', amount: 101.92, status: 'COLLECTED', created_at: today, note: 'Pagesa reale test' },
  { id: 'base-bonus', type: 'READY_48H_BONUS', amount: 10.79, status: 'ACCEPTED_BY_DISPATCH', created_at: today, note: 'BONUS TEST BAZË' },
  { id: 'control-bonus', type: 'READY_48H_BONUS', source_module: 'TRANSPORT_CONTROL', amount: .50, status: 'ACCEPTED_BY_DISPATCH', created_at: today, note: 'BONUS TEST TRANSPORT' },
];
w.financeFixture = {today_gross:101.92,open_due_to_base:101.92,received_handoff_total:0,pending_handoff_total:0,pending_handoff_count:0};
w.renderWallet();
await wait(() => button('CASH & POROSI') && !text().includes('DUKE NGARKUAR TË DHËNAT'));
await click('CASH & POROSI');
await wait(() => [...dom.window.document.querySelectorAll('.statLabel')].some(element => element.textContent === 'CASH SOT'));
const metric = label => [...dom.window.document.querySelectorAll('.statCard')].find(element => element.querySelector('.statLabel')?.textContent === label)?.querySelector('.statValue')?.textContent;
assert.match(metric('CASH SOT'), /101,92\s*€/);
assert.match(metric('NË DORË'), /101,92\s*€/);
assert.match(metric('DORËZUAR'), /0,00\s*€/);
assert.match(metric('TOTAL PAGESA'), /101,92\s*€/);
assert.equal(metric('POROSI ME CASH'), '1');
await click('HISTORIA');
await wait(() => text().includes('Pagesa reale test'));
assert(!text().includes('BONUS TEST BAZË'));
assert(!text().includes('BONUS TEST TRANSPORT'));
console.log('PASS personal account keeps €101.92 customer cash separate from €11.29 bonuses and avoids duplicate generic-history entries');

dom.window.close();
console.log('Worker bonus account UI checks passed.');
