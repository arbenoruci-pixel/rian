import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['components/ArkaCashHandoffAction.jsx'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic', alias: { '@': process.cwd() } });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const Action = mod.exports.default;
const render = (props) => renderToStaticMarkup(React.createElement(StaticRouter, { location: '/arka/puntor/9000' }, React.createElement(Action, props)));
// Screenshot regression: two older PENDING receipts, 18.33 + 7.15, still need a visible action.
const amount = +(18.33 + 7.15).toFixed(2);
for (const role of ['DISPATCH', 'MASTER', 'ADMIN_MASTER', 'PUNTOR', 'TRANSPORT']) {
  const self = { actorPin: '9000', targetPin: '9000', amount, role };
  const detail = render(self);
  assert.match(detail, /href="\/arka\?personal=1"/);
  assert.match(detail, /DORËZO TE DISPATCH — €25,48/);
  assert(!detail.includes('display:none') && !detail.includes('aria-hidden="true"'));
  let taps = 0;
  const onHandoff = () => { taps++; };
  const personal = render({ ...self, onHandoff });
  assert.match(personal, /<button/); assert(!personal.includes('disabled=""'));
  assert.equal(taps, 0, 'rendering or navigating must not submit cash');
  Action({ ...self, onHandoff }).props.onClick();
  assert.equal(taps, 1, 'the personal button opens the existing handoff flow');
  assert.equal(render({ ...self, targetPin: '9001' }), '', 'viewing another staff account cannot hand over their cash');
  for (const override of [{ amount: 0 }, { busy: true }, { blocked: true }]) {
    assert.match(render({ ...self, onHandoff, ...override }), /disabled=""/);
  }
}
assert.equal(render({ actorPin: '', targetPin: '', amount }), '');

// Catch the actual defect: the action cannot live below a hidden legacy section.
const traverse = traverseModule.default || traverseModule;
const source = fs.readFileSync('components/ArkaUnifiedWorkerAccount.jsx', 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
let visibleAction = 0;
traverse(ast, { JSXElement(nodePath) {
  if (nodePath.node.openingElement.name.name !== 'ArkaCashHandoffAction') return;
  visibleAction++;
  for (const parent of nodePath.getAncestry()) {
    if (parent.node.type !== 'JSXElement') continue;
    const opening = parent.node.openingElement;
    assert.notEqual(opening.name.name, 'details', 'primary action must not require expanding details');
    for (const attr of opening.attributes) {
      if (attr.type !== 'JSXAttribute') continue;
      if (attr.name.name === 'aria-hidden') assert.notEqual(attr.value?.value, 'true');
      if (attr.name.name === 'style') assert(!/display\s*:\s*['"]none['"]/.test(source.slice(attr.start, attr.end)));
    }
  }
} });
assert.equal(visibleAction, 1);
const main = fs.readFileSync('app/arka/page.jsx', 'utf8');
assert.match(main, /onSnapshot=\{setUnifiedWorkerFinance\}\s+onHandoff=\{openHandoffWizard\}/);
assert(main.includes('handoffBlocked={n(workerSnapshot?.cashDuplicateTransportCount) > 0}'));
const detail = fs.readFileSync('app/arka/puntor/[pin]/page.jsx', 'utf8');
assert(detail.includes('<ArkaUnifiedWorkerAccount actor={actor} targetPin={pin}'), 'staff details must include the shared visible action');
console.log('PASS visible Arka handoff: €25.48 carryover, own-account navigation, existing wizard callback, manager/worker access, zero/busy/duplicate guards, and no hidden ancestor.');
