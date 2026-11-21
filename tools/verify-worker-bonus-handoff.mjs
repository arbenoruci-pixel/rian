import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { BUJAR_USER_ID } from '../lib/baseBonusEvidence.js';

// Bundle the actual component and actual cached HTTP client. Only session lookup
// and HTTP responses are fixtures; no database or handoff action is invoked.
const bundle = await build({
  stdin:{ contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import Summary, { shouldShowWorkerBonusHandoff } from './components/WorkerBonusHandoffSummary.jsx';
    const root = createRoot(document.getElementById('root'));
    window.__shouldShow = shouldShowWorkerBonusHandoff;
    window.__render = items => root.render(<MemoryRouter>{items.map(item => <Summary key={item.handoffId} actor={window.__actor} {...item}/>)}</MemoryRouter>);
    window.__unmount = () => root.unmount();
    window.__render(window.__items);
  `, loader:'jsx', resolveDir:process.cwd() },
  bundle:true, write:false, format:'iife', jsx:'automatic', alias:{ '@':process.cwd() },
  define:{ 'process.env.NODE_ENV':'"test"' },
  plugins:[{ name:'fixture-session', setup(build) {
    build.onResolve({ filter:/^@\/lib\/actorSession$/ }, () => ({ path:'actor', namespace:'fixture' }));
    build.onLoad({ filter:/.*/, namespace:'fixture' }, () => ({ contents:'export const getActor = () => window.__actor;', loader:'js' }));
  } }],
});
const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', (error) => errors.push(error));
const dom = new JSDOM('<div id="root"></div>', { url:'https://tepiha.test/arka', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole });
const w = dom.window;
w.__actor = { id:'manager-fixture', pin:'9010', role:'DISPATCH' };
const originalActor = { ...w.__actor };
w.__items = [585, 587].map((handoffId) => ({ targetPin:'9000', handoffId, submittedAt:'2026-11-21T09:44:10Z' }));
const report = { ok:true, generatedAt:'2026-11-21T22:00:00Z', handoffs:[
  { id:'585', status:'PENDING_DISPATCH_APPROVAL', base:5.53, transport:4, total:9.53 },
  { id:'587', status:'PENDING_DISPATCH_APPROVAL', base:5.88, transport:0, total:5.88 },
] };
const calls = [];
let mode = 'deferred';
let resolveRead;
w.fetch = async (url, options) => {
  assert.equal(url, '/api/worker-bonuses');
  assert.equal(options.method, 'POST');
  calls.push(JSON.parse(options.body));
  if (mode === 'error') return { ok:false, status:503, json:async () => ({ ok:false, error:'WORKER_BONUS_READ_FAILED' }) };
  if (mode === 'forbidden') return { ok:false, status:403, json:async () => ({ ok:false, error:'WORKER_BONUS_FORBIDDEN' }) };
  if (mode === 'deferred') await new Promise((resolve) => { resolveRead = resolve; });
  return { ok:true, status:200, json:async () => JSON.parse(JSON.stringify(report)) };
};
const wait = async (condition) => {
  const until = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() >= until) throw new Error('Timed out waiting for handoff summary');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const text = () => w.document.body.textContent;
const summary = (id) => w.document.querySelector(`[data-worker-bonus-handoff="${id}"]`);
w.eval(bundle.outputFiles[0].text);
await wait(() => calls.length === 1 && w.document.querySelectorAll('[data-worker-bonus-handoff]').length === 2);
assert(text().includes('Duke ngarkuar bonuset'));
assert(!text().includes('0,00 €'));
assert.equal(calls[0].targetPin, '9000');
assert.equal(calls[0].month, '2026-11');
assert.equal(calls[0].expectedActorId, 'manager-fixture');
mode = 'ready'; resolveRead();
await wait(() => summary(585)?.textContent.includes('9,53 €') && summary(587)?.textContent.includes('5,88 €'));
assert(summary(585).textContent.includes('Bonus Baze5,53 €'));
assert(summary(585).textContent.includes('Kontroll Transporti4,00 €'));
assert(summary(585).textContent.includes('Gjithsej të mbajtura në këtë dorëzim9,53 €'));
assert(summary(585).textContent.includes('Pret pranimin e Dispatch-it'));
assert(summary(587).textContent.includes('Kontroll Transporti0,00 €'));
assert.equal(calls.length, 1, 'two handoff cards share one actual client request');
w.dispatchEvent(new w.Event('focus'));
await wait(() => summary(585)?.textContent.includes('9,53 €'));
assert.equal(calls.length, 1, 'focus uses the client cache');
console.log('PASS: two pending handoffs render exact Base/Transport deductions through one cached request, with explicit pending status.');

w.__render([{ targetPin:'9000', handoffId:999, submittedAt:'2026-11-21T09:44:10Z' }]);
await wait(() => summary(999)?.textContent.includes('Hape llogarinë'));
assert(!summary(999).textContent.includes('0,00 €'));
assert.equal(summary(999).querySelector('a').getAttribute('href'), '/arka/puntor/9000#bonuset');
mode = 'error';
w.dispatchEvent(new w.Event('arka:refresh'));
await wait(() => summary(999)?.textContent.includes('Nuk u ngarkua ndarja'));
assert(!summary(999).textContent.includes('0,00 €'));
assert(summary(999).querySelector('a'));
console.log('PASS: missing records and HTTP errors show an account link instead of fabricated zero deductions.');

mode = 'ready';
const visibleItem = { targetPin:'9000', handoffId:585, submittedAt:'2026-11-21T09:44:10Z' };
w.__render([visibleItem]);
await wait(() => summary(585)?.textContent.includes('9,53 €'));
let beforeSessionChange = calls.length;
w.__actor = null;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => summary(585) === null);
w.dispatchEvent(new w.Event('focus'));
assert(!text().includes('9,53 €'));
assert.equal(calls.length, beforeSessionChange);
// Keep the parent props stale while a different account logs in.
w.__actor = { id:'other-manager', pin:'9020', role:'DISPATCH' };
w.dispatchEvent(new w.Event('storage'));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(summary(585), null);
assert.equal(calls.length, beforeSessionChange);
// Only a parent update for the matching session can make the card visible.
w.__render([visibleItem]);
await wait(() => summary(585)?.textContent.includes('9,53 €'));
assert.equal(calls.at(-1).expectedActorId, 'other-manager');
beforeSessionChange = calls.length;
w.__actor = { ...w.__actor, role:'PUNTOR' };
w.dispatchEvent(new w.Event('storage'));
await wait(() => summary(585) === null);
w.dispatchEvent(new w.Event('focus'));
assert.equal(calls.length, beforeSessionChange);
assert(!text().includes('9,53 €'));
console.log('PASS: logout, another login and a role change clear deduction amounts even with stale parent props.');

w.__actor = { ...originalActor };
w.__render([visibleItem]);
await wait(() => summary(585)?.textContent.includes('9,53 €'));
mode = 'forbidden';
w.dispatchEvent(new w.Event('arka:refresh'));
await wait(() => summary(585)?.textContent.includes('Nuk u ngarkua ndarja'));
assert(!summary(585).textContent.includes('9,53 €'));
// A successful response arriving after logout cannot restore the old amounts.
mode = 'deferred'; resolveRead = undefined;
w.dispatchEvent(new w.Event('arka:refresh'));
await wait(() => typeof resolveRead === 'function');
w.__actor = null;
w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => summary(585) === null);
mode = 'ready'; resolveRead();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(summary(585), null);
assert(!text().includes('9,53 €'));
console.log('PASS: authorization denial and an earlier response completing after logout cannot retain or restore financial data.');

assert.equal(w.__shouldShow({ id:BUJAR_USER_ID, pay_ready_bonus_enabled:false }), true);
assert.equal(w.__shouldShow({ id:'other', pay_ready_bonus_enabled:true }), true);
assert.equal(w.__shouldShow({ id:'other', name:'Bujar', pay_ready_bonus_enabled:false }), false);
assert.equal(w.__shouldShow(undefined), false);
const page = fs.readFileSync('app/arka/page.jsx', 'utf8');
const pending = page.slice(page.indexOf('function PendingHandoffRow('), page.indexOf('function PendingExpenseRow('));
assert(pending.includes('shouldShowWorkerBonusHandoff(workerSummary?.worker)'));
assert(pending.includes('<WorkerBonusHandoffSummary actor={actor} targetPin={row?.worker_pin} handoffId={row?.id} submittedAt={row?.submitted_at} />'));
assert(!fs.readFileSync('components/WorkerBonusHandoffSummary.jsx', 'utf8').includes('setInterval'));
assert.equal(errors.length, 0);
w.__unmount(); dom.window.close();
console.log('PASS: Dispatch mounts the summary only for eligible workers, based on stable identity/flag, with no polling.');
