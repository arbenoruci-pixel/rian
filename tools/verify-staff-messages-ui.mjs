import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const bundle = await build({
  stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Dock from './components/StaffMessagesDock.jsx';import * as client from './lib/staffMessagesClient.js';window.messageClient=client;const root=createRoot(document.getElementById('root'));window.renderDock=()=>root.render(<MemoryRouter initialEntries={[window.location.pathname+window.location.search]}><Dock/></MemoryRouter>);`, loader: 'jsx', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'synthetic-message-session', setup(builder) {
    builder.onResolve({ filter: /sessionStore\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const readBestActor=()=>window.actor;', loader: 'js' }));
  } }],
});

const ids = { manager: '10000000-0000-4000-8000-000000000001', first: '20000000-0000-4000-8000-000000000001', second: '20000000-0000-4000-8000-000000000002' };
const actors = { manager: { id: ids.manager, name: 'Test dispatch', role: 'DISPATCH' }, first: { id: ids.first, name: 'Test first', role: 'PUNTOR' }, second: { id: ids.second, name: 'Test second', role: 'TRANSPORT' } };
const message = { id: '30000000-0000-4000-8000-000000000001', title: 'Njoftim test', body: '<img src=x onerror="window.bad=true">\nRreshti i dytë.', senderName: 'Test dispatch', senderRole: 'DISPATCH', createdAt: '2026-11-20T09:00:00Z', readAt: null, acknowledgedAt: null };
const clone = value => JSON.parse(JSON.stringify(value));
let dom;
const document = () => dom.window.document;
const query = selector => document().querySelector(selector);
const text = () => document().body.textContent;
const button = label => [...document().querySelectorAll('button')].find(node => node.textContent.trim() === label);
async function wait(predicate, label = 'UI update') {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out: ' + label + '\n' + text());
}
async function click(label) { await wait(() => button(label) && !button(label).disabled, label); button(label).click(); await new Promise(resolve => setTimeout(resolve, 20)); }
function field(selector, value) {
  const node = query(selector);
  const proto = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
async function open(actor = actors.first, path = '/arka') {
  dom?.window.close();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { throw error; });
  dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.test' + path, pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  w.actor = clone(actor); w.calls = []; w.sent = []; w.received = clone(message); w.visible = true; w.pollSchedules = []; w.failSend = false;
  Object.defineProperty(w.document, 'visibilityState', { get: () => w.visible ? 'visible' : 'hidden', configurable: true });
  w.setInterval = (callback, milliseconds) => { w.pollSchedules.push({ callback, milliseconds }); return w.pollSchedules.length; };
  w.clearInterval = () => {};
  w.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 44 }] : []; };
  w.fetch = async (url, options) => {
    assert.equal(url, '/api/staff-messages');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    const input = JSON.parse(options.body); w.calls.push(input);
    assert.equal(input.expectedActorId, w.actor.id);
    const capability = { id: w.actor.id, name: w.actor.name, canSend: w.actor.role === 'DISPATCH' };
    const ownReceived = w.actor.id === ids.first;
    let data = { ok: true, actor: capability, unreadCount: ownReceived && !w.received.readAt ? 1 : 0 };
    if (input.action === 'recipients') data.recipients = [actors.first, actors.second];
    if (input.action === 'list') {
      if (w.deferList) return new Promise(resolve => { w.resolveList = resolve; });
      data.items = input.mode === 'sent' ? clone(w.sent) : ownReceived ? [clone(w.received)] : [];
      data.nextCursor = null;
    }
    if (input.action === 'read' || input.action === 'acknowledge') {
      w.received.readAt ||= '2026-11-20T10:00:00Z';
      if (input.action === 'acknowledge') w.received.acknowledgedAt ||= '2026-11-20T10:01:00Z';
      data = { ...data, messageId: input.messageId, readAt: w.received.readAt, acknowledgedAt: w.received.acknowledgedAt, unreadCount: 0 };
    }
    if (input.action === 'send') {
      if (w.failSend) { w.failSend = false; throw new TypeError('fixture lost response'); }
      const recipients = input.allWorkers ? [actors.first, actors.second] : [actors.first, actors.second].filter(user => input.recipientIds.includes(user.id));
      const saved = { id: input.requestKey, title: input.title, body: input.body, senderName: capability.name, createdAt: '2026-11-20T12:00:00Z', recipients: recipients.map(user => ({ ...user, readAt: null, acknowledgedAt: null })) };
      if (!w.sent.some(item => item.id === saved.id)) w.sent.unshift(saved);
      data = { ...data, messageId: saved.id, recipientCount: recipients.length, alreadySent: false };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  w.eval(bundle.outputFiles[0].text); w.renderDock();
  await new Promise(resolve => setTimeout(resolve, 35));
  return w;
}

let w = await open();
await wait(() => query('.staffMessageDock strong')?.textContent === '1');
assert.equal(query('[role=dialog]'), null, 'Ordinary messages never interrupt work with an automatic modal');
assert.ok(w.pollSchedules.every(item => item.milliseconds >= 300000));
assert.equal(w.calls.length, 1);
assert.equal(w.calls[0].action, 'badge');
w.visible = false; w.messageClient.clearStaffMessagesCache(); w.pollSchedules[0].callback();
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(w.calls.length, 1, 'No hidden-tab polling');
w.visible = true;
query('.staffMessageDock').click();
await wait(() => query('.staffMessageCard'));
assert.equal(document().activeElement.getAttribute('aria-label'), 'Mbyll mesazhet');
assert.equal(button('+ Shkruaj'), undefined);
assert.equal(button('Të dërguara'), undefined);
query('.staffMessageCard').click();
await wait(() => query('.staffMessageBody'));
assert.equal(query('.staffMessageBody').textContent, message.body);
assert.equal(query('.staffMessageBody img'), null, 'Message markup is rendered as text');
await wait(() => w.calls.some(call => call.action === 'read'));
await click('E lexova');
await wait(() => text().includes('Leximi u konfirmua.'));
assert.ok(w.calls.some(call => call.action === 'acknowledge'));
assert.equal(query('.staffMessageDock strong'), null);
query('[role=dialog]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(() => !query('[role=dialog]'));
assert.equal(document().body.style.overflow, '');
console.log('PASS worker inbox, escaped text, explicit acknowledgment, focus/ESC, unread badge and bounded foreground-only polling');

w = await open(actors.manager);
query('.staffMessageDock').click();
await wait(() => button('+ Shkruaj'));
await click('+ Shkruaj');
await wait(() => document().querySelectorAll('.staffMessageRecipient').length === 3);
assert.ok(button('Dërgo mesazhin').disabled);
document().querySelectorAll('.staffMessageRecipient input')[1].click();
field('input[name=title]', 'Orari i punës'); field('textarea[name=body]', 'Mesazh provë për punëtorin.');
await wait(() => !button('Dërgo mesazhin').disabled);
w.failSend = true;
await click('Dërgo mesazhin');
await wait(() => query('[role=alert]'));
assert.equal(query('textarea').value, 'Mesazh provë për punëtorin.');
await click('Dërgo mesazhin');
await wait(() => text().includes('Mesazhi u dërgua te 1 punëtorë.'));
const sends = w.calls.filter(call => call.action === 'send');
assert.equal(sends.length, 2);
assert.equal(sends[0].requestKey, sends[1].requestKey, 'Uncertain retry uses one idempotency key');
assert.deepEqual(sends[0].recipientIds, [ids.first]);
assert.equal(w.sent.length, 1);
await wait(() => query('.staffMessageCard'));
query('.staffMessageCard').click();
await wait(() => text().includes('Gjendja te punëtorët'));
assert.match(text(), /Test firstPa lexuar/);
console.log('PASS manager compose, selected recipients, retained draft and same-key retry, sent delivery status');

await click('+ Shkruaj');
await wait(() => query('textarea'));
document().querySelector('.staffMessageRecipient input').click();
field('input[name=title]', 'Njoftim për ekipin'); field('textarea[name=body]', 'Mesazh për të gjithë.');
await wait(() => !button('Dërgo mesazhin').disabled);
await click('Dërgo mesazhin');
await wait(() => text().includes('Mesazhi u dërgua te 2 punëtorë.'));
assert.equal(w.calls.filter(call => call.action === 'send').at(-1).allWorkers, true);
assert.equal(w.calls.filter(call => call.action === 'send').at(-1).recipientIds, undefined);
console.log('PASS all-workers compose delegates the recipient snapshot to the server');

await click('+ Shkruaj');
await wait(() => query('textarea'));
field('input[name=title]', 'Draft retained'); field('textarea[name=body]', 'Private unsent draft');
w.dispatchEvent(new w.Event('tepiha:meal-policy-open'));
await wait(() => !query('[role=dialog]'));
const policy = document().createElement('div'); policy.dataset.mealPolicyNotice = 'open'; document().body.appendChild(policy);
query('.staffMessageDock').click();
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(query('[role=dialog]'), null);
policy.remove();
query('.staffMessageDock').click();
await wait(() => button('+ Shkruaj'));
await click('+ Shkruaj');
await wait(() => query('textarea')?.value === 'Private unsent draft');
w.actor = clone(actors.second); w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => !query('[role=dialog]'));
query('.staffMessageDock').click();
await wait(() => text().includes('Nuk ke mesazhe.'));
assert.ok(!text().includes('Private unsent draft'));
assert.equal(button('+ Shkruaj'), undefined);
console.log('PASS automatic food notice has priority, draft survives temporary close, account switch clears content and privileges');

w = await open(actors.first);
w.deferList = true;
query('.staffMessageDock').click();
await wait(() => w.resolveList);
w.actor = clone(actors.second); w.dispatchEvent(new w.Event('tepiha:session-changed'));
await wait(() => !query('[role=dialog]'));
w.resolveList({ ok: true, status: 200, json: async () => ({ ok: true, actor: { ...actors.first, canSend: false }, items: [{ ...message, title: 'PRIVATE OLD ACCOUNT' }], unreadCount: 1, nextCursor: null }) });
await new Promise(resolve => setTimeout(resolve, 35));
assert.ok(!text().includes('PRIVATE OLD ACCOUNT'));
console.log('PASS late response from a previous account cannot repopulate the next account');

for (const path of ['/login', '/transport/login', '/porosit', '/k/example', '/debug-lite', '/arka?public=1']) {
  w = await open(actors.manager, path);
  assert.equal(query('.staffMessageDock'), null, path);
  assert.equal(w.calls.length, 0, path);
}
dom.window.close();
console.log('PASS public/login/debug screens make no message requests or show the staff inbox');
console.log('Staff messages UI: 6 scenario groups passed.');
