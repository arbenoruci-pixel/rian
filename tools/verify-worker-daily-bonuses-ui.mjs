import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Daily from './components/WorkerDailyBonusLedger.jsx';import Account from './components/ArkaUnifiedWorkerAccount.jsx';const root=createRoot(document.getElementById('root'));window.renderDaily=(actor,targetPin)=>root.render(<Daily actor={actor} targetPin={targetPin}/>);window.renderAccount=(actor,targetPin)=>root.render(<Account actor={actor} targetPin={targetPin} onHandoff={()=>window.handoffOpened++}/>);`,
    resolveDir: process.cwd(), loader: 'jsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', alias: { '@': process.cwd() },
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'read-only-daily-bonus-fixtures', setup(builder) {
    builder.onResolve({ filter: /(?:lib\/(?:workerBonusAccountClient\.js|actorSession|routerCompat\.jsx|supabaseClient)|WorkerBonusAccount\.jsx|HandoffReceiptsPanel\.jsx)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      const contents = {
        'workerBonusAccountClient.js': `export const fetchWorkerBonusAccount=args=>window.fetchAccount(args);`,
        actorSession: `export const getActor=()=>window.actor;`,
        'routerCompat.jsx': `import React from 'react';export default function Link({href,to,children,...props}){return <a href={href||to} {...props}>{children}</a>}`,
        supabaseClient: `export const supabase={rpc:async(name,args)=>{window.rpcCalls.push({name,args});if(name!=='get_worker_finance_snapshot_v1')throw new Error('Unexpected mutation');return {data:window.financeFixture,error:null}}};`,
        'WorkerBonusAccount.jsx': `import React from 'react';export default function Monthly(){return <section id="bonuset" data-monthly-bonus-fixture="true">Llogaria e plotë e bonuseve</section>}`,
        'HandoffReceiptsPanel.jsx': `export default function Receipts(){return null;}`,
      }[args.path.split('/').at(-1)];
      if (!contents) throw new Error(`Missing fixture: ${args.path}`);
      return { contents, loader: 'jsx', resolveDir: process.cwd() };
    });
  } }],
});

const actor = { id: 'fixture-worker', pin: 'fixture-worker-pin', role: 'PUNTOR' };
const fixture = {
  version: 1, enabled: true, worker: { id: actor.id, name: 'Punëtori test' }, month: '2026-11',
  totals: { available: 12.25, reserved: 2.5 },
  dailyRows: [
    { id: 'base-today', source: 'BASE', code: 'TEST-BASE-1', eligible: true, amount: 3.25, creditedAt: '2026-11-22T10:15:00Z', earnedAt: '2026-10-20T10:00:00Z', status: 'EARNED' },
    { id: 'transport-today', source: 'TRANSPORT_CONTROL', code: 'TEST-T-1', eligible: true, amount: .5, creditedAt: '2026-11-22T12:30:00Z', earnedAt: '2026-11-20T10:00:00Z', status: 'RETAINED' },
    { id: 'base-yesterday', source: 'BASE', code: 'TEST-BASE-2', eligible: true, amount: .75, creditedAt: '2026-11-21T10:00:00Z', earnedAt: '2026-11-22T10:00:00Z', status: 'RESERVED' },
    { id: 'ineligible', source: 'BASE', code: 'TEST-VOID', eligible: false, amount: 99, creditedAt: '2026-11-22T10:00:00Z', status: 'VOIDED' },
  ],
  rows: [{ id: 'qualified-only', source: 'BASE', amount: 77, earnedAt: '2026-11-22T10:00:00Z' }],
  pendingControls: [{ id: 'pending', potentialAmount: .5, submittedAt: '2026-11-22T10:00:00Z' }],
  dailyWarnings: [], warnings: [],
};

let dom;
const copy = value => JSON.parse(JSON.stringify(value));
const query = selector => dom.window.document.querySelector(selector);
const text = () => dom.window.document.body.textContent;
const button = label => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
async function wait(predicate, message = 'UI update') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timeout: ${message}\n${text()}`);
}
async function click(label) {
  await wait(() => button(label) && !button(label).disabled, label);
  button(label).click();
  await new Promise(resolve => setTimeout(resolve, 20));
}
function setDate(value) {
  const input = query('[aria-label="Data e bonuseve ditore"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
async function open({ report = fixture, integrated = false } = {}) {
  dom?.window.close();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (!String(error.message).includes('Could not parse CSS')) throw error; });
  dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.local/arka', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  const RealDate = w.Date;
  w.clock = '2026-11-22T12:00:00Z';
  w.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [w.clock])); } static now() { return new RealDate(w.clock).getTime(); } };
  w.actor = actor;
  w.calls = [];
  w.rpcCalls = [];
  w.handoffOpened = 0;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  if (!integrated) w.setInterval = () => { throw new Error('Daily bonus display must not add interval polling'); };
  w.fetchAccount = async args => { w.calls.push(args); return copy(report); };
  w.financeFixture = {
    worker: { id: actor.id, pin: actor.pin, name: 'Punëtori test', role: 'PUNTOR' },
    profile: { cash_mode: 'FULL_CASH', commission_enabled: false, ready_bonus_enabled: true },
    cash: { open_due_to_base: 50, open_gross: 50, today_gross: 50, today_count: 1, rows: [{ id: 'fixture-cash', code: 'TEST-CASH-1', client_name: 'KLIENT TEST', amount: 50, due_to_base: 50, gross_amount: 50, created_at: '2026-11-22T10:00:00Z' }] },
    expenses: {}, payroll: {}, advances: {},
  };
  w.eval(bundle.outputFiles[0].text);
  if (integrated) w.renderAccount(actor, actor.pin); else w.renderDaily(actor, actor.pin);
  await wait(() => w.calls.length > 0);
  if (report.enabled) await wait(() => query('.wdb-total'));
  return w;
}

let w = await open();
assert.equal(w.calls.length, 1);
assert.equal(w.calls[0].month, '2026-11');
assert.equal(query('[aria-label="Data e bonuseve ditore"]').value, '2026-11-22');
assert.match(query('[data-daily-bonus-source="BASE"]').textContent, /3,25\s*€/);
assert.match(query('[data-daily-bonus-source="TRANSPORT_CONTROL"]').textContent, /0,50\s*€/);
assert.match(query('.wdb-total').textContent, /Regjistruar për këtë datë3,75\s*€/);
assert.equal(dom.window.document.querySelectorAll('[data-daily-bonus-id]').length, 2);
assert(query('[data-daily-bonus-id="transport-today"]').textContent.includes('E mbajtur'));
assert(query('[data-daily-bonus-id="base-today"]').textContent.includes('11:15'));
assert(!text().includes('TEST-VOID'));
assert(!text().includes('77,00'));
assert.match(query('[data-daily-bonus-available]').textContent, /12,25\s*€/);
assert(query('.wdb-current').textContent.includes('të gjitha ditët'));
assert.equal(query('a[href="#bonuset"]').textContent, 'Llogaria e plotë e bonuseve →');
console.log('PASS actual daily UI shows posted Base/Transport credits and current balances independently, without fictional or pending credits');

setDate('2026-11-21');
await wait(() => query('[data-daily-bonus-id="base-yesterday"]'));
assert.equal(w.calls.length, 1, 'Changing day in loaded month uses the complete read model');
assert.match(query('.wdb-total').textContent, /0,75\s*€/);
assert.match(query('[data-daily-bonus-available]').textContent, /12,25\s*€/);
assert(!query('[data-daily-bonus-id="base-today"]'));
let resolveMonth;
w.fetchAccount = args => { w.calls.push(args); return new Promise(resolve => { resolveMonth = resolve; }); };
setDate('2026-10-20');
await wait(() => w.calls.at(-1).month === '2026-10');
assert(query('#bonuset-ditore'));
assert(!query('[data-daily-bonus-id]'), 'Previous month amounts disappear while another month loads');
assert(!query('[data-daily-bonus-available]'));
resolveMonth({ ...copy(fixture), month: '2026-10', dailyRows: [] });
await wait(() => query('.wdb-total'));
assert.match(query('.wdb-total').textContent, /0,00\s*€/);
assert.match(query('[data-daily-bonus-available]').textContent, /12,25\s*€/);
w.fetchAccount = async args => { w.calls.push(args); return copy(fixture); };
await click('Sot');
await wait(() => query('[data-daily-bonus-id="base-today"]'));
await click('Rifresko bonuset');
assert.equal(w.calls.at(-1).force, true);
for (const event of ['arka:refresh', 'base-ready-bonus:refresh']) {
  const before = w.calls.length;
  w.dispatchEvent(new w.Event(event));
  await wait(() => w.calls.length === before + 1 && query('.wdb-total'));
  assert.equal(w.calls.at(-1).force, true);
}
const beforeFocus = w.calls.length;
w.dispatchEvent(new w.Event('focus'));
await wait(() => w.calls.length === beforeFocus + 1 && query('.wdb-total'));
assert.equal(w.calls.at(-1).force, false);
console.log('PASS daily/month selection, month isolation, manual refresh and existing refresh/focus events without new polling');

w.fetchAccount = async () => ({ ...copy(fixture), dailyWarnings: [{ code: 'BOOKING_MISSING', bonusId: 'missing', orderCode: 'TEST-MISSING' }], warnings: [{ code: 'RETAINED_MISMATCH', difference: 99 }] });
await click('Rifresko bonuset');
await wait(() => query('.wdb-warning'));
assert(query('.wdb-warning').textContent.includes('mungon data e regjistrimit në Arkë'));
assert(query('.wdb-warning').textContent.includes('TEST-MISSING'));
assert.match(query('.wdb-total').textContent, /3,75\s*€/);
assert(!text().includes('99,00'));
w.fetchAccount = async () => { const report = copy(fixture); delete report.dailyRows; return report; };
await click('Rifresko bonuset');
await wait(() => query('[role="alert"]'));
assert(query('[role="alert"]').textContent.includes('nuk u ngarkuan plotësisht'));
assert(!query('.wdb-total'), 'Missing dailyRows contract must not appear as zero earnings');
assert(!query('[data-daily-bonus-available]'));
for (const [code, httpStatus] of [['WORKER_BONUS_FORBIDDEN', 403], ['AUTH_REQUIRED', 401], ['WORKER_BONUS_SESSION_CHANGED', 403], ['NETWORK', 0]]) {
  w.fetchAccount = async () => copy(fixture);
  await click('Rifresko bonuset');
  await wait(() => query('.wdb-total'));
  w.fetchAccount = async () => { throw Object.assign(new Error('Bonuset nuk mund të verifikohen tani.'), { code, httpStatus }); };
  await click('Rifresko bonuset');
  await wait(() => query('[role="alert"]'));
  assert(!query('.wdb-total'), `${code} must clear the financial snapshot`);
  assert(!query('[data-daily-bonus-id]'));
}
console.log('PASS missing booking notice, incomplete-contract errors and all failed reads clear current financial amounts');

w.fetchAccount = async () => copy(fixture);
await click('Rifresko bonuset');
await wait(() => query('.wdb-total'));
w.actor = null;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => !query('#bonuset-ditore'));
w.actor = { id: 'new-session', pin: 'new-session-pin', role: 'DISPATCH' };
w.dispatchEvent(new w.Event('storage'));
await new Promise(resolve => setTimeout(resolve, 30));
assert(!query('#bonuset-ditore'), 'Stale parent identity cannot expose the old account after another login');
w.actor = actor;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => query('.wdb-total'));
let resolveOld;
w.fetchAccount = args => args.targetPin === 'slow-fixture-worker'
  ? new Promise(resolve => { resolveOld = resolve; })
  : Promise.resolve({ enabled: false });
w.renderDaily(actor, 'slow-fixture-worker');
await wait(() => !!resolveOld);
assert(!query('.wdb-total'));
w.renderDaily(actor, 'disabled-fixture-worker');
await new Promise(resolve => setTimeout(resolve, 30));
resolveOld(copy(fixture));
await new Promise(resolve => setTimeout(resolve, 30));
assert(!query('#bonuset-ditore'));
console.log('PASS session/logout, changed storage, disabled account and late worker response safeguards');

w = await open({ integrated: true });
await wait(() => query('[data-unified-worker-finance]') && query('.wdb-total'));
assert(text().includes('CASH PARA ZBRITJEVE'));
assert(!text().includes('DORËZO TASH'));
assert.equal(button('DORËZO / SHIKO LLOGARITJEN').disabled, false);
const hero = button('DORËZO / SHIKO LLOGARITJEN').closest('section');
assert(hero.textContent.includes('€50,00'));
assert(!hero.textContent.includes('€46,25'));
assert(!hero.textContent.includes('€53,75'));
const metric = label => [...dom.window.document.querySelectorAll('[data-unified-worker-finance] div')].find(element => element.firstElementChild?.textContent === label);
assert(metric('PAGUAR SOT').textContent.includes('€50,00'));
const cashHeading = [...dom.window.document.querySelectorAll('div')].find(element => element.textContent === 'KLIENTËT ME CASH TË HAPUR');
const cashSection = cashHeading.closest('section');
assert(cashSection.textContent.includes('€50,00'));
assert(cashSection.textContent.includes('TEST-CASH-1'));
assert(!cashSection.textContent.includes('TEST-BASE-1'));
assert(!cashSection.textContent.includes('TEST-T-1'));
const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
assert(query('#bonuset-ditore').compareDocumentPosition(cashSection) & following, 'Daily bonus entries are beside the daily workflow');
assert(cashSection.compareDocumentPosition(query('#bonuset')) & following, 'Full monthly report remains available after cash rows');
await click('DORËZO / SHIKO LLOGARITJEN');
assert.equal(w.handoffOpened, 1, 'The button only opens the existing review/calculation flow');
assert.equal(w.rpcCalls.length, 1);
assert.equal(w.rpcCalls[0].name, 'get_worker_finance_snapshot_v1');
console.log('PASS actual unified account keeps €50 customer cash separate from €3.75 daily bonus, labels gross cash honestly and opens the existing handoff review');

dom.window.close();
console.log('Worker daily bonus UI checks passed.');
