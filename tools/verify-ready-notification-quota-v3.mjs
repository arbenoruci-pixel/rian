import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { JSDOM, VirtualConsole } from 'jsdom';
import { transformSync } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as storageApi from '../lib/readyNotificationStorage.js';
import * as model from '../lib/readyNotificationModel.js';
import { canTrackReadyNotifications } from '../lib/roles.js';
import { buildSmartSmsLinks } from '../lib/smartSms.js';

let count = 0;
const test = async (name, run) => { await run(); console.log('PASS', name); count++; };
const worker = { id: '11111111-1111-4111-8111-111111111111', role: 'PUNTOR', name: 'Synthetic worker' };
const event = () => ({ id: randomUUID(), attempt_id: randomUUID(), viewer_id: worker.id, actor_id: worker.id, order_id: '101', channel: 'sms', kind: 'opened', pending: true });
function fullLocal() {
  const map = new Map([['session', 'KEEP'], ['payment-intent', 'KEEP'], ['offline-order', 'KEEP']]);
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) || null, removeItem: k => map.delete(k),
    setItem() { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); } };
}
await test('legacy v1/v2 pending and acknowledged rows migrate under full localStorage', async () => {
  const local = fullLocal(), db = new IDBFactory(), a = event(), b = event();
  local.map.set(storageApi.READY_NOTIFICATION_LEGACY_KEY, JSON.stringify([a]));
  const ackKey = storageApi.READY_NOTIFICATION_ITEM_PREFIX + 'ack:' + worker.id + ':' + b.id;
  local.map.set(ackKey, JSON.stringify({ ...b, pending: false }));
  const store = storageApi.createReadyNotificationStorage({ indexedDB: db, localStorage: local });
  const rows = await store.read();
  assert.equal(rows.length, 2); assert.equal(rows.find(e => e.id === b.id).pending, false);
  assert.equal(local.map.size, 3); assert([...local.map.values()].every(value => value === 'KEEP'));
  const restarted = storageApi.createReadyNotificationStorage({ indexedDB: db, localStorage: local });
  assert.equal((await restarted.read()).length, 2);
});
await test('request success followed by transaction abort never reports a saved event', async () => {
  const store = storageApi.createReadyNotificationStorage({ indexedDB: new IDBFactory(), localStorage: fullLocal() });
  const put = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args), tx = this.transaction;
      request.addEventListener('success', () => tx.abort()); return request;
    };
    await assert.rejects(store.write([event()]));
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await store.read()).length, 0);
});
await test('a blocked or suspended database releases the action and can retry', async () => {
  const real = new IDBFactory(); let stuck = true;
  const store = storageApi.createReadyNotificationStorage({ indexedDB: { open(...args) { return stuck ? {} : real.open(...args); } }, localStorage: fullLocal(), timeoutMs: 25 });
  await assert.rejects(store.write([event()]), /STORAGE_TIMEOUT/);
  stuck = false; await store.write([event()]); assert.equal((await store.read()).length, 1);
});
await test('an old tab changing a legacy row during migration keeps its newer copy', async () => {
  const local = fullLocal(), first = event(), second = event();
  const key = storageApi.READY_NOTIFICATION_LEGACY_KEY;
  local.map.set(key, JSON.stringify([first]));
  const put = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function (...args) { local.map.set(key, JSON.stringify([first, second])); return put.apply(this, args); };
    const store = storageApi.createReadyNotificationStorage({ indexedDB: new IDBFactory(), localStorage: local });
    await store.read(); assert.equal(JSON.parse(local.getItem(key)).length, 2);
    IDBObjectStore.prototype.put = put;
    assert.equal((await store.read()).length, 2); assert.equal(local.getItem(key), null);
  } finally { IDBObjectStore.prototype.put = put; }
});

// Actual React modal + actual notification queue + IndexedDB. Native deep links
// are captured locally, so no customer app is opened and no message is sent.
const require = createRequire(import.meta.url);
const errors = [], virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<div id="root"></div>', { url: 'https://test.local/', pretendToBeVisual: true, virtualConsole });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.scrollTo = () => {};
const root = createRoot(document.getElementById('root'));
const opened = [], copied = [], db = new IDBFactory(), local = fullLocal();
let activation = true, trackingCalls = 0, delay = null, failStorage = false;
const browserNavigator = { onLine: false, get userActivation() { return { isActive: activation }; }, clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } } };
const fakeWindow = new Proxy(dom.window, { get(target, name) {
  if (name === 'location') return { set href(value) { opened.push(value); } };
  const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
} });
const context = vm.createContext({ ...storageApi, ...model, canTrackReadyNotifications,
  readBestActor: () => worker, getDeviceId() {}, indexedDB: db, localStorage: local,
  crypto: { randomUUID }, navigator: browserNavigator, window: fakeWindow, document, Event: dom.window.Event,
  approvedApiRequest: () => assert.fail('offline fixture made a server request'), setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('lib/readyNotifications.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, ''), context);
function component(file, overrides) {
  const module = { exports: {} };
  const compiled = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  vm.runInNewContext(compiled, { module, exports: module.exports, window: fakeWindow, navigator: browserNavigator, document, AbortController, setTimeout, clearTimeout, clearInterval: dom.window.clearInterval.bind(dom.window),
    require: name => overrides[name] || require(name) });
  return module.exports;
}
const Smart = component('components/SmartSmsModal.jsx', {
  '../lib/clientFamilyClient.js': { prepareFamilySmartMessage: async text => text },
  '../lib/smartSms': { buildSmartSmsLinks },
});
const notificationApi = Object.fromEntries(['currentNotificationActorId', 'canUseReadyNotifications', 'localNotifications', 'fetchReadyNotifications'].map(key => [key, vm.runInContext(key, context)]));
notificationApi.NOTIFICATION_CHANGE = 'tepiha:ready-notifications';
notificationApi.recordReadyNotification = async args => {
  trackingCalls++;
  if (delay) await delay;
  if (failStorage) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  return context.recordReadyNotification(args);
};
const Ready = component('components/ReadyNotification.jsx', {
  './SmartSmsModal': Smart,
  '../lib/readyNotificationModel.js': model,
  '../lib/readyNotificationStorage.js': storageApi,
  '../lib/readyNotifications.js': notificationApi,
}).TrackedReadySmsModal;
const props = { isOpen: true, orderId: '101', phone: '044123456', messageText: 'Synthetic test message', onClose() {} };
const render = value => act(async () => { root.render(React.createElement(Ready, value)); });
const pause = () => new Promise(resolve => setTimeout(resolve, 15));
async function readLocal() { let rows; await act(async () => { rows = await context.localNotifications(); }); return rows; }
const text = () => document.body.textContent;
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await act(pause); }
  throw new Error('UI condition timed out: ' + text());
}
function button(label) { return [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label); }
async function click(label) { await until(() => button(label) && !button(label).disabled); await act(async () => { button(label).click(); }); }
async function reset(extra = {}) { await render({ ...props, isOpen: false }); await render({ ...props, ...extra }); await until(() => button('SMS NORMAL') && !button('SMS NORMAL').disabled); }

await test('full localStorage permits SMS only after durable commit and confirms after return', async () => {
  await reset(); await click('SMS NORMAL'); await until(() => opened.length === 1);
  assert(opened[0].startsWith('sms:'));
  assert.equal((await readLocal()).filter(e => e.kind === 'opened').length, 1);
  await click('E DËRGOVA'); await until(() => text().includes('Konfirmoi dërgimin'));
  const rows = await readLocal();
  assert.equal(rows.length, 2); assert.equal(rows.find(e => e.kind === 'confirmed').attempt_id, rows.find(e => e.kind === 'opened').attempt_id);
  assert.equal(local.map.size, 3);
});
await test('slow save and rapid double tap produce one attempt and one external handoff', async () => {
  await reset({ orderId: '102' }); let release; delay = new Promise(resolve => { release = resolve; });
  const before = trackingCalls, launches = opened.length;
  await act(async () => { button('SMS NORMAL').click(); button('SMS NORMAL').click(); });
  assert.equal(trackingCalls, before + 1); assert.equal(opened.length, launches);
  await act(async () => { release(); delay = null; }); await until(() => opened.length === launches + 1);
});
await test('expired Safari activation offers a fresh tap without duplicating the saved attempt', async () => {
  activation = false; await reset({ orderId: '103' });
  const before = trackingCalls, launches = opened.length;
  await click('SMS NORMAL'); await until(() => !!button('HAPE SMS'));
  assert.equal(opened.length, launches); assert.equal(trackingCalls, before + 1);
  activation = true; await click('HAPE SMS'); assert.equal(opened.length, launches + 1); assert.equal(trackingCalls, before + 1);
});
await test('storage rejection displays Albanian guidance and never opens or confirms a message', async () => {
  await reset({ orderId: '104' }); failStorage = true;
  const before = (await readLocal()).length, launches = opened.length;
  await click('SMS NORMAL'); await until(() => text().includes('Telefoni s’ka hapësirë'));
  assert(!text().includes('The quota')); assert.equal(opened.length, launches);
  assert.equal((await readLocal()).length, before);
  failStorage = false; await click('SMS NORMAL'); await until(() => opened.length === launches + 1);
  failStorage = true; await click('E DËRGOVA'); await until(() => text().includes('Telefoni s’ka hapësirë'));
  assert.equal((await readLocal()).filter(e => e.order_id === '104' && e.kind === 'confirmed').length, 0);
  failStorage = false; await click('E DËRGOVA'); await until(() => text().includes('Konfirmoi dërgimin'));
});
await test('closing or changing the order during a save prevents a stale external handoff', async () => {
  for (const next of [{ ...props, isOpen: false }, { ...props, orderId: '106' }]) {
    await reset({ orderId: '105' }); let release; delay = new Promise(resolve => { release = resolve; });
    const launches = opened.length; await click('SMS NORMAL'); await render(next);
    await act(async () => { release(); delay = null; }); await act(pause); await act(pause);
    assert.equal(opened.length, launches);
  }
});
await test('Viber keeps clipboard access in the tap and untracked Transport opens synchronously', async () => {
  await reset({ orderId: '107' }); const copies = copied.length, launches = opened.length;
  await click('VIBER'); await until(() => opened.length === launches + 1);
  assert.equal(copied.length, copies + 1); assert(opened.at(-1).startsWith('viber:'));
  await reset({ orderId: randomUUID() }); const before = trackingCalls;
  await click('SMS NORMAL'); assert.equal(opened.length, launches + 2); assert.equal(trackingCalls, before);
});
await test('WhatsApp waits for its saved attempt and cancels web fallback when the app takes focus', async () => {
  await reset({ orderId: '108' }); const before = trackingCalls, launches = opened.length;
  await click('WHATSAPP'); await until(() => opened.length === launches + 1);
  assert(opened.at(-1).startsWith('whatsapp:')); assert.equal(trackingCalls, before + 1);
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('blur')); });
  assert.equal((await readLocal()).filter(e => e.order_id === '108' && e.channel === 'whatsapp').length, 1);
});
await act(async () => root.unmount()); dom.window.close();
assert.deepEqual(errors, []);
console.log(`PASS ${count} quota, migration and actual modal interaction scenarios`);
