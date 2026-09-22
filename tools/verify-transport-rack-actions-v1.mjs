import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Render the shipping components and click their actual deferred action handlers.
// Every row is synthetic; all network and business mutations are forbidden.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.invalid/transport/board' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = () => { throw new Error('Unexpected network request'); };
const require = createRequire(import.meta.url);
const realTimeout = globalThis.setTimeout;
const deferredErrors = [];
globalThis.setTimeout = (callback, ms, ...args) => realTimeout(() => {
  try { callback(...args); } catch (error) { deferredErrors.push(error); }
}, ms);
const pause = () => new Promise(resolve => realTimeout(resolve, 340));
const container = document.getElementById('root');
const board = parse(fs.readFileSync('app/transport/board/page.jsx', 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
function visit(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) { const found = visit(child, predicate); if (found) return found; } }
    else if (value && typeof value === 'object') { const found = visit(value, predicate); if (found) return found; }
  }
  return null;
}
const row = { id: '11111111-1111-4111-8111-111111111111', code_str: 'T101', client_name: 'SYNTHETIC RACK TEST',
  client_phone: '12025550123', status: 'assigned', created_at: '2026-09-22T09:00:00Z',
  data: { address: 'Synthetic address', ready_slots: ['A1'], ready_note: 'Synthetic shelf', totals: { pieces: 1, m2: 2 } } };
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failures.push(name + ': ' + error.message); }
}
async function loadComponent(file, name) {
  const output = await build({ entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node',
    packages: 'external', alias: { '@': process.cwd() }, jsx: 'automatic', logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
  return module.exports[name];
}

for (const [name, file, inbox] of [
  ['InboxModule', 'app/transport/board/modules/inbox.jsx', true],
  ['NgarkimModule', 'app/transport/board/modules/ngarkim.jsx', false],
]) {
  await test(name + ' receives the real parent rack picker', () => {
    const slot = visit(board, node => node.type === 'JSXOpeningElement' && node.name?.name === 'BoardModuleSlot'
      && node.attributes.some(attr => attr.name?.name === 'Component' && attr.value?.expression?.name === name));
    const props = slot?.attributes.find(attr => attr.name?.name === 'props')?.value?.expression;
    assert.equal(props?.properties.find(prop => prop.key?.name === 'onOpenRack')?.value?.name, 'openRackPicker');
  });
  const Component = await loadComponent(file, name);
  for (const mode of ['connected', 'missing callback', 'missing order id']) {
    await test(name + ': ' + mode, async () => {
      const selected = structuredClone(row);
      if (mode === 'missing order id') selected.id = '';
      const before = JSON.stringify(selected), opened = [], mutations = [];
      const root = createRoot(container);
      const noMutation = () => mutations.push('unexpected business mutation');
      deferredErrors.length = 0;
      const rackButton = () => [...container.querySelectorAll('button')].find(button => /RAFTI/.test(button.textContent));
      try {
        await act(async () => root.render(React.createElement(Component, {
          items: [selected], loading: false, selectedIds: new Set(), setSelectedIds() {},
          actorRole: 'TRANSPORT', transportUsers: [], onBulkStatus: noMutation, onAssign: noMutation,
          onCancel: noMutation, onSaveGps: noMutation, onOpenSms: noMutation, onOpenModal: noMutation,
          ...(mode === 'missing callback' ? {} : { onOpenRack: order => {
            assert.equal(rackButton(), undefined, 'tools sheet closes before opening rack picker');
            opened.push(order);
          } }),
        })));
        const card = inbox ? container.querySelector('[data-transport-inbox-card]')
          : [...container.querySelectorAll('span')].find(el => el.getAttribute('aria-label')?.startsWith('Hap kartelën'))?.closest('div[style*="cursor: pointer"]');
        assert(card, 'synthetic order card is rendered');
        await act(async () => card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
        await act(pause);
        const button = rackButton();
        assert(button, 'RAFTI action is rendered');
        assert.equal(button.disabled, mode !== 'connected');
        await act(async () => button.click());
        await act(pause);
        assert.deepEqual(deferredErrors, []);
        assert.equal(opened.length, mode === 'connected' ? 1 : 0);
        if (opened.length) assert.equal(opened[0], selected, 'same selected order reaches rack picker');
        assert.equal(JSON.stringify(selected), before, 'opening picker cannot mutate the order');
        assert.deepEqual(mutations, [], 'no SMS, status change, payment or navigation');
      } finally { await act(async () => root.unmount()); }
    });
  }
}
globalThis.setTimeout = realTimeout;
dom.window.close();
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
console.log(`${passed} passed; ${failures.length} failed: Transport rack actions v1`);
