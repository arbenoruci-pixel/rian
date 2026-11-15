import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// Run the production bridge against DOM rows. Use the actual page expression
// so removing/breaking the React-to-bridge search signal also fails this test.
const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const signal = page.match(/data-pastrimi-search-active=\{([^}]+)\}/)?.[1];
assert(signal, 'Pastrimi must expose its current search/exact-open state');
const bridge = fs.readFileSync('lib/pastrimiWorkerGroupingBridge.js', 'utf8')
  .replace('export function installPastrimiWorkerGroupingBridge', 'function installPastrimiWorkerGroupingBridge');
const filterKey = 'tepiha_pastrimi_worker_filter_v1';
const toolbarId = 'tepiha-pastrimi-worker-toolbar-v1';
const baseCard = '<div class="list-item-compact" data-order-id="3870">978 Klient Test 3 copë • 10.50 m² BORXH €13.65 PAKETO</div>';
const wait = async (check, message) => {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert(check(), message);
};

function open(savedFilter, state = {}) {
  const dom = new JSDOM('<div id="root"><div class="wrap"><input class="input"><section class="card">' + baseCard + '</section></div></div>', {
    url: 'https://test.local/pastrimi', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const document = window.document;
  const root = document.querySelector('.wrap');
  const setSearch = (next = {}) => {
    const values = { search: '', openCode: '', exactSearchMode: false, ...next };
    document.querySelector('input').value = values.search;
    root.setAttribute('data-pastrimi-search-active', vm.runInNewContext(signal, values));
  };
  setSearch(state);
  window.localStorage.setItem(filterKey, savedFilter);
  window.fetch = () => { throw new Error('Worker search must not make a network request'); };
  // No 900ms fallback: attribute updates and newly rendered rows must work
  // through the observer, including when the same card node is reused.
  window.setInterval = () => 0;
  window.eval(bridge + '\ninstallPastrimiWorkerGroupingBridge();');
  const card = () => document.querySelector('[data-order-id="3870"]');
  const button = key => document.querySelector(`#${toolbarId} button[data-filter="${key}"]`);
  const visible = () => card().style.getPropertyValue('display') === 'flex' && card().getAttribute('aria-hidden') === 'false';
  const hidden = () => card().style.getPropertyValue('display') === 'none' && card().getAttribute('aria-hidden') === 'true';
  return { dom, window, document, setSearch, card, button, visible, hidden };
}

let scenarios = 0;
for (const savedFilter of ['fitim', 'blerim', 'tapin']) {
  const app = open(savedFilter);
  try {
    await wait(app.hidden, `${savedFilter}: ordinary list must keep the worker filter`);
    for (const state of [
      { search: '978' },
      { search: 'Klient Test' },
      { search: '044000000' },
      { openCode: '978' },
      { exactSearchMode: true },
    ]) {
      app.setSearch(state);
      await wait(app.visible, `${savedFilter}: search/exact-open result was hidden`);
      assert.equal(app.button('all').getAttribute('aria-pressed'), 'true');
      assert.equal(app.button('all').textContent, 'TE GJITHA1 POROSI');
      assert(app.button(savedFilter).disabled, 'worker filters must not override search');
      app.button(savedFilter).click();
      assert(app.visible());
      assert.equal(app.window.localStorage.getItem(filterKey), savedFilter, 'search must preserve the list preference');

      // Simulate DB refresh replacing a result, without a query/state change.
      app.document.querySelector('section').innerHTML = baseCard;
      await wait(app.visible, 'refreshed search result must stay visible');
      app.setSearch();
      await wait(app.hidden, 'clearing search must restore the saved worker filter');
      assert(!app.button(savedFilter).disabled);
      scenarios++;
    }
    app.button('all').click();
    await wait(app.visible, 'manual TE GJITHA must still work');
    assert.equal(app.window.localStorage.getItem(filterKey), 'all');
  } finally { app.dom.window.close(); }
}

for (const savedFilter of ['all', 'baza', 'fitim', 'blerim', 'tapin']) {
  const app = open(savedFilter, { openCode: '978', exactSearchMode: true });
  try {
    await wait(app.visible, `${savedFilter}: a fresh direct-open must show the order`);
    app.window.history.pushState({}, '', '/dispatch');
    app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
    await wait(() => !app.document.getElementById(toolbarId), 'leaving Pastrimi must remove the worker toolbar');
    assert.equal(app.card().getAttribute('aria-hidden'), null);
    assert.equal(app.card().style.getPropertyValue('display'), '');
    app.window.history.pushState({}, '', '/pastrimi?openId=3870&exact=1');
    app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
    await wait(app.visible, 'returning to exact-open must remain visible');
    scenarios++;
  } finally { app.dom.window.close(); }
}

console.log(`PASS: ${scenarios} Pastrimi worker-filter/search scenarios, DB refresh, toolbar actions and route return.`);
