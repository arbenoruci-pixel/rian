import fs from 'node:fs';

const client = fs.readFileSync('lib/baseReadyBonusClient.js','utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js','utf8');
const payService = fs.readFileSync('components/payments/payService.js','utf8');
const liveCard = fs.readFileSync('components/ReadyBonusLiveCard.jsx','utf8');
const attention = fs.readFileSync('components/ReadyBonusAttention.jsx','utf8');
const pastrimi = fs.readFileSync('app/pastrimi/page.jsx','utf8');

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`PASS ${label}`); };

check(client.includes('mark_base_order_ready_with_bonus_v1'), 'GATI uses bonus staging RPC');
check(client.includes("activation_rule: 'FULL_PAYMENT_ACTOR'"), 'offline bonus ownership stays payment-actor based');
check(engine.includes('activateBaseReadyBonusAfterPaymentV2'), 'ARKA engine activates bonus after verified payment');
check(engine.includes("activate_base_ready_bonus_on_full_payment_v2"), 'ARKA engine uses DB activation RPC');
check(payService.includes('base-ready-bonus:refresh'), 'payment refreshes live bonus UI');
check(pastrimi.includes('markBaseOrderReadyWithBonus'), 'Pastrimi stages GATI for bonus evaluation');

// Live UI must follow the DB config. The current production window is 72h, but
// future config changes must not require another frontend patch.
check(liveCard.includes('summary?.config'), 'live card reads DB summary config');
check(liveCard.includes('windowHours'), 'live card renders dynamic window');
check(attention.includes("get_base_bonus_opportunities_v1"), 'attention list uses server opportunity RPC');
check(attention.includes('window_hours'), 'attention list reads live window_hours');
check(!attention.includes('48 * 60 * 60 * 1000'), 'attention list has no hardcoded 48h timer');
check(attention.includes('hours_left'), 'attention countdown uses server-calculated hours_left');
check(attention.includes('potential_bonus'), 'attention amount uses server-calculated potential bonus');
check(attention.includes("viewer.pin === '5555'") && attention.includes('/\\bBUJAR\\b/i'), 'motivational message is restricted to Bujar');
check(attention.includes('data-bujar-bonus-motivation="1"'), 'Bujar motivational message is rendered');
check(attention.includes('SOT I KI {items.length} MUNDËSI') && attention.includes('possibleMoney.toFixed(2)'), 'Bujar message uses live opportunity count and bonus amount');

if (failures.length) {
  console.error(`FAIL: ${failures.length} base-payment bonus live-config check(s) failed.`);
  failures.forEach((message,index)=>console.error(`${index+1}. ${message}`));
  process.exit(1);
}
console.log(`PASS: ${16} base-payment bonus live-config and motivation checks passed.`);
