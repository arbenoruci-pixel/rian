import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createHandoffReceiptIntentStorage } from '../lib/handoffReceiptIntentStorage.js';

// Synthetic durable storage and HTTP ledger only. This suite never contacts a
// hosted app, database, or a real worker's financial records.
const actorId = '10000000-0000-4000-8000-000000000001';
const otherActorId = '10000000-0000-4000-8000-000000000002';
const prefix = 'tepiha_handoff_receipt_intent_v1:';
const uuid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scopeKey = (id = 41, actor = actorId) => `${prefix}${actor}:${id}`;
const intent = (n = 1, overrides = {}) => ({ actorId, handoffId: 41,
  requestKey: `HR1:${uuid(n)}`, action: 'receive', amount: 40,
  expectedOutstanding: 100, note: 'Synthetic counted cash', confirmNoCash: false, ...overrides });

function local(options = {}) {
  const map = new Map();
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem(key) {
      if (options.readError) throw new DOMException('Synthetic storage restriction', 'SecurityError');
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.full) throw new DOMException('Synthetic quota exhausted', 'QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (options.removeError) throw new DOMException('Synthetic removal restriction', 'SecurityError');
      map.delete(key);
    },
  };
}

function fixture(options = {}) {
  const localStorage = options.localStorage ?? local({ full: true });
  const indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : new IDBFactory();
  return { localStorage, indexedDB,
    store: () => createHandoffReceiptIntentStorage({ localStorage, indexedDB, timeoutMs: options.timeoutMs ?? 100 }),
  };
}

const storageError = error => /^HANDOFF_RECEIPT_(STORAGE_|PENDING_INTENT)/.test(error?.code || error?.message || '');
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${error.stack}`); }
}

await test('local quota fallback persists the complete receipt across a new storage instance', async () => {
  const f = fixture();
  for (const key of ['CURRENT_USER_DATA', 'customer-draft', 'unsent-payment']) f.localStorage.map.set(key, 'KEEP');
  const value = intent();
  const saved = await f.store().persist(value);
  assert.equal(saved.requestKey, value.requestKey);
  assert.deepEqual(await f.store().read(actorId, 41), value);
  for (const key of ['CURRENT_USER_DATA', 'customer-draft', 'unsent-payment']) assert.equal(f.localStorage.getItem(key), 'KEEP');
});

await test('legacy local intent is recovered and cannot be replaced by another request', async () => {
  const f = fixture({ localStorage: local() });
  const value = intent(); f.localStorage.setItem(scopeKey(), JSON.stringify(value));
  assert.deepEqual(await f.store().read(actorId, 41), value);
  await assert.rejects(f.store().persist(intent(2)), storageError);
  assert.deepEqual(await f.store().read(actorId, 41), value);
  assert.equal(await f.store().read(otherActorId, 41), null);
  assert.equal(await f.store().read(actorId, 42), null);
});

await test('partial, zero-cash and explicitly confirmed noncash intents retain their exact values', async () => {
  const f = fixture();
  for (const value of [intent(1), intent(2, { handoffId: 42, amount: 0, note: 'No physical cash arrived' }),
    intent(3, { handoffId: 43, action: 'resolve', amount: 5, expectedOutstanding: 5, note: 'Documented noncash adjustment', confirmNoCash: true })]) {
    await f.store().persist(value);
    assert.deepEqual(await f.store().read(actorId, value.handoffId), value);
  }
});

await test('corrupt local intent fails closed and preserves the original evidence', async () => {
  const f = fixture(); const raw = '{incomplete'; f.localStorage.map.set(scopeKey(), raw);
  await assert.rejects(f.store().read(actorId, 41), storageError);
  await assert.rejects(f.store().persist(intent()), storageError);
  assert.equal(f.localStorage.getItem(scopeKey()), raw);
});

await test('unreadable local storage does not authorize a new pending request', async () => {
  const f = fixture({ localStorage: local({ readError: true }) });
  await assert.rejects(f.store().read(actorId, 41), storageError);
  await assert.rejects(f.store().persist(intent()), storageError);
});

await test('contradictory local and IndexedDB copies are not silently selected or overwritten', async () => {
  const f = fixture(); await f.store().persist(intent());
  const newer = intent(2); f.localStorage.map.set(scopeKey(), JSON.stringify(newer));
  await assert.rejects(f.store().read(actorId, 41), storageError);
  await assert.rejects(f.store().persist(intent(3)), storageError);
  assert.equal(f.localStorage.getItem(scopeKey()), JSON.stringify(newer));
});

await test('same request key with altered amount cannot overwrite a pending financial snapshot', async () => {
  const f = fixture(); const value = intent(); await f.store().persist(value);
  await assert.rejects(f.store().persist({ ...value, amount: 41 }), storageError);
  assert.deepEqual(await f.store().read(actorId, 41), value);
});

await test('competing fallback writes preserve one durable request instead of overwriting it', async () => {
  const f = fixture();
  const values = [intent(1), intent(2)];
  const results = await Promise.allSettled(values.map(value => f.store().persist(value)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const index = results.findIndex(result => result.status === 'fulfilled');
  assert.deepEqual(await f.store().read(actorId, 41), values[index]);
});

await test('cleanup of an old request leaves a newer local or IndexedDB intent intact', async () => {
  for (const full of [false, true]) {
    const f = fixture({ localStorage: local({ full }) });
    const old = intent(1), newer = intent(2);
    await f.store().persist(old); await f.store().remove(old);
    await f.store().persist(newer); await f.store().remove(old);
    assert.deepEqual(await f.store().read(actorId, 41), newer);
  }
});

await test('IndexedDB transaction abort after put success does not claim durable persistence', async () => {
  const f = fixture(); const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(f.store().persist(intent()), storageError); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await f.store().read(actorId, 41), null);
});

await test('a hung IndexedDB open is bounded and the same storage instance can recover', async () => {
  const backing = new IDBFactory(); let stuck = true;
  const f = fixture({ timeoutMs: 25, indexedDB: { open(...args) { return stuck ? {} : backing.open(...args); } } });
  const store = f.store(); const started = Date.now();
  await assert.rejects(store.persist(intent()), storageError);
  assert.ok(Date.now() - started < 1500, 'A blocked browser database must not leave acceptance waiting indefinitely.');
  stuck = false; await store.persist(intent());
  assert.deepEqual(await store.read(actorId, 41), intent());
});

await test('a hung IndexedDB transaction times out and is aborted before any send can occur', async () => {
  let aborted = 0;
  const db = { objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const tx = { objectStore: () => ({ get: () => ({}), put: () => ({}), delete: () => ({}) }),
        abort() { aborted++; tx.onabort?.(); } };
      return tx;
    },
  };
  const indexedDB = { open() { const open = {}; queueMicrotask(() => { open.result = db; open.onsuccess?.(); }); return open; } };
  const f = fixture({ indexedDB, timeoutMs: 25 }); const started = Date.now();
  await assert.rejects(f.store().persist(intent()), storageError);
  assert.ok(Date.now() - started < 1500, 'A stalled transaction must have a deadline.');
  assert.ok(aborted > 0, 'Timed-out transactions must be aborted so a late put cannot commit untracked.');
});

const bundle = await build({ stdin: { contents: `import * as client from './lib/handoffReceiptClient.js'; window.receiptClient = client;`,
  resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', alias: { '@': process.cwd() },
  plugins: [{ name: 'synthetic-receipt-actor', setup(builder) {
    builder.onResolve({ filter: /lib\/actorSession$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getActor=()=>window.actor;', loader: 'js' }));
  } }],
});

function ledger({ loseReply = false } = {}) {
  const state = { requests: [], responses: new Map(), cash: 0, outstanding: 100, loseReply };
  state.fetch = async (url, options) => {
    assert.equal(url, '/api/handoff-receipts'); assert.equal(options.credentials, 'same-origin');
    const body = JSON.parse(options.body); state.requests.push(body);
    assert.equal(body.expectedActorId, actorId); assert.equal('actorId' in body, false);
    if (body.action === 'list') return { ok: true, status: 200, json: async () => ({ ok: true, manager: true, actorId,
      handoffs: [{ id: 41, worker_id: otherActorId, worker_pin: '8001', worker_name: 'Synthetic Worker',
        amount: 100, submitted_at: '2026-11-22T10:00:00Z', can_receive: true,
        status: state.outstanding ? 'PENDING_DISPATCH_APPROVAL' : 'ACCEPTED',
        receipt_tracking: state.responses.size > 0, receipt_received_amount: state.cash,
        receipt_resolved_amount: 100 - state.outstanding - state.cash,
        receipt_outstanding_amount: state.outstanding }],
      events: [...state.responses.values()].map(reply => ({ ...reply.event, handoff_id: 41,
        actor_name: 'Synthetic Dispatch', created_at: '2026-11-22T10:01:00Z' })),
      summary: { outstandingTotal: state.outstanding, receivedToday: state.cash },
    }) };
    let result = state.responses.get(body.requestKey);
    if (result) return { ok: true, status: 200, json: async () => ({ ...structuredClone(result), replayed: true }) };
    assert.equal(body.expectedOutstanding, state.outstanding);
    assert.ok(['receive', 'resolve'].includes(body.action));
    if (body.action === 'receive') state.cash += body.amount;
    state.outstanding -= body.amount;
    result = { ok: true, handoff: { id: body.handoffId, outstanding: state.outstanding },
      event: { id: state.responses.size + 1, event_kind: body.action === 'receive' ? 'RECEIPT' : 'RESOLUTION', amount: body.amount }, replayed: false };
    state.responses.set(body.requestKey, result);
    if (state.loseReply) { state.loseReply = false; throw new Error('Synthetic response lost after server commit'); }
    return { ok: true, status: 200, json: async () => structuredClone(result) };
  };
  return state;
}

function clientPage(f, server = ledger()) {
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => { throw error; });
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://receipt-fixture.test/arka', runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  w.actor = { id: actorId, role: 'DISPATCH' };
  Object.defineProperty(w, 'localStorage', { configurable: true, value: f.localStorage });
  Object.defineProperty(w, 'indexedDB', { configurable: true, value: f.indexedDB });
  w.structuredClone = structuredClone;
  w.fetch = server.fetch; w.eval(bundle.outputFiles[0].text);
  return { dom, w, api: w.receiptClient, server };
}

const request = (overrides = {}) => ({ handoffId: 41, action: 'receive', amount: 40,
  expectedOutstanding: 100, note: 'Synthetic counted cash', confirmNoCash: false, ...overrides });

await test('real client accepts with full localStorage and persists before its only financial POST', async () => {
  const f = fixture(); const server = ledger(); const send = server.fetch;
  server.fetch = async (...args) => {
    const pending = await f.store().read(actorId, 41);
    assert.ok(pending?.requestKey, 'The request must already survive a new storage instance before transmission.');
    assert.equal(JSON.parse(args[1].body).requestKey, pending.requestKey);
    return send(...args);
  };
  const page = clientPage(f, server);
  try {
    const result = await page.api.saveHandoffReceipt(request());
    assert.equal(result.ok, true); assert.equal(server.requests.length, 1); assert.equal(server.cash, 40);
    assert.equal(await f.store().read(actorId, 41), null);
  } finally { page.dom.window.close(); }
});

await test('lost receipt response survives a complete client reload and replays the identical key once', async () => {
  const f = fixture(); const server = ledger({ loseReply: true });
  let page = clientPage(f, server);
  try {
    await assert.rejects(page.api.saveHandoffReceipt(request()), /Synthetic response lost/);
    assert.equal(server.cash, 40); assert.equal(server.responses.size, 1);
    const original = await page.api.readHandoffReceiptIntent(actorId, 41);
    assert.ok(original?.requestKey);
    page.dom.window.close(); page = clientPage(f, server);
    const restored = await page.api.readHandoffReceiptIntent(actorId, 41);
    assert.equal(restored.requestKey, original.requestKey);
    await assert.rejects(page.api.saveHandoffReceipt(request({ amount: 5, expectedOutstanding: 60 })), /./);
    assert.equal(server.requests.length, 1, 'An unresolved request blocks a newly entered amount.');
    const result = await page.api.saveHandoffReceipt(request({ amount: 5, expectedOutstanding: 60, note: 'Changed input must not replace the saved retry' }), { retry: true });
    assert.equal(result.replayed, true); assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[1], server.requests[0]);
    assert.equal(server.cash, 40); assert.equal(server.responses.size, 1);
    assert.equal(await page.api.readHandoffReceiptIntent(actorId, 41), null);
  } finally { page.dom.window.close(); }
});

await test('real client makes zero POSTs when neither storage can retain the request', async () => {
  const page = clientPage(fixture({ indexedDB: undefined }));
  try {
    await assert.rejects(page.api.saveHandoffReceipt(request()));
    assert.equal(page.server.requests.length, 0); assert.equal(page.server.cash, 0);
  } finally { page.dom.window.close(); }
});

await test('corrupt or unreadable pending storage never becomes a fresh financial POST', async () => {
  for (const brokenRead of [false, true]) {
    const localStorage = local({ readError: brokenRead });
    if (!brokenRead) localStorage.map.set(scopeKey(), '{corrupt');
    const page = clientPage(fixture({ localStorage }));
    try {
      await assert.rejects(page.api.saveHandoffReceipt(request()));
      assert.equal(page.server.requests.length, 0);
      if (!brokenRead) assert.equal(localStorage.getItem(scopeKey()), '{corrupt');
    } finally { page.dom.window.close(); }
  }
});

await test('session change during durable persistence cannot send the old actor intent as the new actor', async () => {
  const f = fixture(); const page = clientPage(f); const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const result = put.apply(this, args);
    result.addEventListener('success', () => { page.w.actor = { id: otherActorId, role: 'DISPATCH' }; });
    return result;
  };
  try {
    await assert.rejects(page.api.saveHandoffReceipt(request()));
    assert.equal(page.server.requests.length, 0); assert.equal(page.server.cash, 0);
  } finally { IDBObjectStore.prototype.put = put; page.dom.window.close(); }
});

await test('failed cleanup after confirmed success retains a safe replay without a second credit', async () => {
  const f = fixture({ localStorage: local({ removeError: true }), indexedDB: undefined });
  const server = ledger(); const page = clientPage(f, server);
  try {
    assert.equal((await page.api.saveHandoffReceipt(request())).ok, true);
    assert.equal(server.cash, 40); assert.ok(await page.api.readHandoffReceiptIntent(actorId, 41));
    const result = await page.api.saveHandoffReceipt(request(), { retry: true });
    assert.equal(result.replayed, true); assert.equal(server.responses.size, 1); assert.equal(server.cash, 40);
  } finally { page.dom.window.close(); }
});

await test('actual receipt dialog recovers a fallback intent after reload before offering another amount', async () => {
  const ui = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/HandoffReceiptsPanel.jsx';createRoot(document.getElementById('root')).render(<Panel actor={window.actor}/>);`,
    resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'synthetic-receipt-ui-identity', setup(builder) {
      builder.onResolve({ filter: /(?:lib\/(actorSession|routerCompat\.jsx)|WorkerBonusHandoffSummary\.jsx)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path.endsWith('actorSession') ? 'export const getActor=()=>window.actor;'
          : args.path.endsWith('routerCompat.jsx') ? 'import React from "react";export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}'
            : 'export const shouldShowWorkerBonusHandoff=()=>false;export default function Bonus(){return null}',
        loader: 'jsx', resolveDir: process.cwd(),
      }));
    } }],
  });
  const f = fixture(); const server = ledger({ loseReply: true }); let page = clientPage(f, server);
  const q = selector => page.w.document.querySelector(selector);
  const button = label => [...page.w.document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  const wait = async (predicate, label) => {
    const until = Date.now() + 4000;
    while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`Timed out: ${label}\n${page.w.document.body.textContent}`);
  };
  const click = async label => { await wait(() => button(label) && !button(label).disabled, label); button(label).click(); };
  const input = (selector, value) => {
    const node = q(selector), proto = node.tagName === 'TEXTAREA' ? page.w.HTMLTextAreaElement.prototype : page.w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  };
  try {
    page.w.eval(ui.outputFiles[0].text);
    await wait(() => q('#handoff-receipt-41'), 'initial receipt card');
    await click('Prano paratë');
    await wait(() => q('[role="dialog"] input[inputmode="decimal"]') && !q('[role="dialog"] input[inputmode="decimal"]').disabled, 'intent hydration');
    input('[role="dialog"] input[inputmode="decimal"]', '40');
    input('[role="dialog"] textarea', 'Synthetic counted cash');
    await click('Prano 40,00 €');
    await wait(() => button('Riprovo të njëjtin veprim'), 'ambiguous receipt retry');
    assert.equal(server.cash, 40); assert.equal(server.responses.size, 1);
    page.dom.window.close(); page = clientPage(f, server); page.w.eval(ui.outputFiles[0].text);
    await wait(() => q('#handoff-receipt-41'), 'reloaded receipt card');
    await click('Prano paratë');
    await wait(() => button('Riprovo të njëjtin veprim') && !button('Riprovo të njëjtin veprim').disabled, 'recovered IndexedDB intent');
    assert.equal(q('[role="dialog"] input[inputmode="decimal"]'), null, 'A saved uncertain receipt must not become an editable new amount after reopening.');
    await click('Riprovo të njëjtin veprim');
    await wait(() => !q('[role="dialog"]'), 'verified replay closes dialog');
    const mutations = server.requests.filter(row => row.action === 'receive');
    assert.equal(mutations.length, 2); assert.deepEqual(mutations[1], mutations[0]);
    assert.equal(server.cash, 40); assert.equal(server.responses.size, 1);
    assert.match(q('#handoff-receipt-41').textContent, /60,00/);
  } finally { page.dom.window.close(); }
});

if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
console.log(`${passed} passed; ${failures.length} failed: handoff receipt durable storage`);
