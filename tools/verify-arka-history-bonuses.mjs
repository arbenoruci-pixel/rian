import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { JSDOM } from 'jsdom';
import { arkaHistoryBonusStatusLabel, groupArkaHistoryBonuses } from '../lib/arkaHistoryBonuses.js';

// Compile the actual page's history functions and component, without mounting
// its network-loading page or using a rewritten copy of the grouping logic.
const source = fs.readFileSync('app/arka/page.jsx', 'utf8');
const ast = parse(source, { sourceType:'module', plugins:['jsx'] });
const functions = new Map(ast.program.body.filter((node) => node.type === 'FunctionDeclaration').map((node) => [node.id.name, source.slice(node.start, node.end)]));
const names = [
  'n', 'euro', 'safeUpper', 'amountOf', 'statusOf', 'typeOf', 'byDateDesc',
  'isAcceptedHandoffStatus', 'isPendingHandoffStatus', 'isHybridWorker', 'workerCommissionRateM2',
  'firstPositiveNumber', 'cashOrderCode', 'cashClientName', 'cashSourceModule', 'parseM2FromNote',
  'historyTransportM2', 'historyPaymentWorkerPin', 'historyWorkerNameFromMap', 'isMealLikeRow',
  'isHistoryClientPayment', 'isHistoryExpenseRow', 'isHistoryMealRow', 'buildHistoryPaymentLine',
  'buildArkaHistoryGroups', 'historyStatusLabel', 'fmtPaymentStamp', 'fmtDate',
  'HistoryRow', 'HistoryMetricLine', 'ArkaHistoryGroup',
];
for (const name of names) assert(functions.has(name), `Missing actual history function ${name}`);
const imports = ast.program.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === '@/lib/arkaHistoryBonuses');
assert.equal(imports.length, 1, 'page must use the tested bonus classification module');
const compiled = await build({
  stdin: { contents:`
    import React from 'react';
    import Link from './lib/routerCompat.jsx';
    import { isArkaHistoryBonus, groupArkaHistoryBonuses, arkaHistoryBonusStatusLabel } from './lib/arkaHistoryBonuses.js';
    const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits:2, maximumFractionDigits:2 });
    const PAYMENT_TIME_ZONE = 'Europe/Belgrade';
    ${names.map((name) => functions.get(name)).join('\n')}
    export { buildArkaHistoryGroups, ArkaHistoryGroup };
  `, loader:'jsx', resolveDir:process.cwd() },
  bundle:true, write:false, format:'cjs', platform:'node', packages:'external', jsx:'automatic',
});
const mod = { exports:{} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { buildArkaHistoryGroups, ArkaHistoryGroup } = mod.exports;

const pin = '9000';
const at = '2026-11-21T09:03:00.000Z';
const worker = { pin, name:'PUNËTOR TEST', is_hybrid_transport:false };
const baseBonuses = [1.25, 1.10, 0.94, 2, 2].map((amount, i) => ({
  id:100 + i, type:'READY_48H_BONUS', source_module:'ARKA', status:'ACCEPTED_BY_DISPATCH',
  created_by_pin:pin, order_code:100 + i, amount, created_at:at, note:'BONUS BAZE',
}));
const transportBonuses = Array.from({ length:8 }, (_, i) => ({
  id:200 + i, type:'READY_48H_BONUS', source_module:'TRANSPORT_CONTROL', status:'ACCEPTED_BY_DISPATCH',
  created_by_pin:pin, transport_order_id:`order-${i}`, transport_code_str:`T${200 + i}`,
  amount:0.50, created_at:at, note:`KONTROLL TRANSPORTI • T${200 + i} • 0.50 €`,
}));
const receipt = { id:1, type:'IN', source_module:'BASE', status:'COLLECTED', amount:101.92, created_by_pin:pin, created_at:at, order_code:20, client_name:'KLIENT REAL' };
const payments = [receipt, ...baseBonuses, ...transportBonuses];
payments.forEach(Object.freeze); Object.freeze(payments);
const before = JSON.stringify(payments);
const groupFor = (rows, extra = {}) => buildArkaHistoryGroups({ payments:rows, workersByPin:{ [pin]:worker }, targetPin:pin, ...extra }).find((group) => group.pin === pin);
const group = groupFor(payments);
assert.equal(group.clientPayments.length, 1);
assert.equal(group.totals.grossTotal, 101.92);
assert.equal(group.totals.baseTotal, 101.92);
assert.equal(group.totals.openCashTotal, 101.92);
assert.equal(group.bonusGroups.find((value) => value.source === 'BASE').amount, 7.29);
assert.equal(group.bonusGroups.find((value) => value.source === 'TRANSPORT_CONTROL').amount, 4);
assert.equal(group.bonusGroups.reduce((sum, value) => sum + value.amount, 0), 11.29);
assert.equal(JSON.stringify(payments), before);
console.log('PASS: actual daily history keeps €101.92 customer cash separate from €7.29 Base and €4.00 Transport bonuses.');

const hybridReceipt = { id:2, type:'TRANSPORT', source_module:'TRANSPORT', status:'COLLECTED', amount:36, transport_m2:20, created_by_pin:pin, created_at:at, transport_code_str:'T900' };
const extraRows = [
  { id:3, type:'MEAL_PAYMENT', amount:3, status:'ACCEPTED_BY_DISPATCH' },
  { id:4, type:'EXPENSE', amount:2, status:'PENDING' },
  { id:5, type:'ADVANCE', amount:8, status:'ACCEPTED_BY_DISPATCH' },
  { id:6, type:'TIMA', amount:99, status:'ACCEPTED_BY_DISPATCH' },
].map((row) => ({ ...row, created_by_pin:pin, created_at:at }));
const handoffs = [{ id:585, worker_pin:pin, amount:74.70, status:'PENDING_DISPATCH_APPROVAL', submitted_at:at }];
const hybrid = groupFor([...payments, hybridReceipt, ...extraRows], { handoffs, workersByPin:{ [pin]:{ ...worker, is_hybrid_transport:true, commission_rate_m2:0.5 } } });
assert.equal(hybrid.totals.grossTotal, 137.92);
assert.equal(hybrid.totals.commissionTotal, 10);
assert.equal(hybrid.totals.baseTotal, 127.92);
assert.equal(hybrid.totals.mealTotal, 3);
assert.equal(hybrid.totals.expenseTotal, 13);
assert.equal(hybrid.totals.handoffTotal, 74.70);
assert.equal(hybrid.totals.dayStatus, 'DËRGUAR TE DISPATCH');
assert.equal(hybrid.handoffs[0], handoffs[0]);
console.log('PASS: ordinary Transport commission, meals, expenses and unchanged cash-handoff amount remain correct.');

const pendingBonus = { ...transportBonuses[0], status:'PENDING', note:'Kontroll me shënim ushqim' };
const onlyBonus = groupFor([pendingBonus]);
assert.equal(onlyBonus.totals.pendingCount, 0);
assert.equal(onlyBonus.totals.openCashTotal, 0);
assert.equal(onlyBonus.totals.mealTotal, 0);
assert.equal(onlyBonus.totals.dayStatus, 'BONUSE TË REGJISTRUARA');
const foreign = { ...transportBonuses[1], created_by_pin:'9001', amount:100 };
const separated = buildArkaHistoryGroups({ payments:[...payments, foreign], workersByPin:{ [pin]:worker, 9001:{ pin:'9001', name:'OTHER' } } });
assert.equal(separated.find((row) => row.pin === pin).bonusGroups.find((row) => row.source === 'TRANSPORT_CONTROL').amount, 4);
assert.equal(separated.find((row) => row.pin === '9001').bonusGroups[0].amount, 100);
const cancelledGroups = groupArkaHistoryBonuses([{ ...transportBonuses[0], status:'VOIDED' }]);
assert.equal(cancelledGroups[0].amount, 0);
assert.equal(cancelledGroups[0].rows.length, 1);
assert.equal(arkaHistoryBonusStatusLabel(transportBonuses[0]), 'BONUS I APROVUAR');
assert.equal(arkaHistoryBonusStatusLabel(cancelledGroups[0].rows[0]), 'BONUS I ANULUAR');
console.log('PASS: worker histories stay separate; bonus rows do not become cash debt, meal charges or payroll blockers.');

const html = renderToStaticMarkup(React.createElement(StaticRouter, { location:'/arka' }, React.createElement(ArkaHistoryGroup, { group })));
const dom = new JSDOM(html);
const doc = dom.window.document;
const bonusSection = doc.querySelector('[data-arka-history-bonuses="1"]');
assert(bonusSection);
assert.match(bonusSection.textContent, /BONUSE TË REGJISTRUARA/);
assert.match(bonusSection.querySelector('[data-bonus-source="BASE"]').textContent, /7,29/);
assert.match(bonusSection.querySelector('[data-bonus-source="TRANSPORT_CONTROL"]').textContent, /4,00/);
assert.match(bonusSection.textContent, /KONTROLL TRANSPORTI • T200/);
assert.match(bonusSection.textContent, /BONUS I APROVUAR/);
assert(!bonusSection.textContent.includes('PRANUAR'));
assert(!bonusSection.textContent.includes('PAGUAR'));
assert.equal(bonusSection.querySelector('a').getAttribute('href'), '/arka/puntor/9000#bonuset');
const clientTitle = [...doc.querySelectorAll('.arkaSectionTitle')].find((element) => element.textContent === 'KLIENTËT / PAGESAT');
assert(clientTitle.parentElement.textContent.includes('KLIENT REAL'));
assert(!clientTitle.parentElement.textContent.includes('T200'));
assert(!clientTitle.parentElement.textContent.includes('BONUS'));
assert(functions.get('PendingHandoffRow')?.includes('SHIH LLOGARINË / BONUSET'));
dom.window.close();
console.log('PASS: rendered history labels both sources and approval honestly, retains source notes and links Dispatch to the bonus account.');
