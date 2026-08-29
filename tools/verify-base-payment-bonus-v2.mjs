import fs from 'node:fs';
import {
  BUJAR_CANONICAL_USER_ID,
  isBujarBonusViewer,
  readyBonusCacheKeyForUserId,
  resolveReadyBonusViewerUserId,
} from '../lib/readyBonusAttentionIdentity.js';

const client = fs.readFileSync('lib/baseReadyBonusClient.js','utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js','utf8');
const payService = fs.readFileSync('components/payments/payService.js','utf8');
const liveCard = fs.readFileSync('components/ReadyBonusLiveCard.jsx','utf8');
const attention = fs.readFileSync('components/ReadyBonusAttention.jsx','utf8');
const pastrimi = fs.readFileSync('app/pastrimi/page.jsx','utf8');

const failures = [];
let passed = 0;
const check = (ok, label) => {
  if (!ok) failures.push(label);
  else { passed += 1; console.log(`PASS ${label}`); }
};

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
check(attention.includes('isBujarBonusViewer(scopedViewerUserId)'), 'motivational message uses canonical user identity');
check(!attention.includes("viewer.pin === '5555'") && !attention.includes('/\\bBUJAR\\b/i'), 'old PIN and display name are not identity signals');
check(liveCard.includes('<ReadyBonusAttention compact actor={actor} />'), 'live card passes its authenticated actor to attention');
check(attention.includes('readyBonusCacheKeyForUserId'), 'offline opportunity cache is scoped by canonical user');
check(attention.includes('loadedIdentityKey === actorIdentityKey'), 'rendered bonus state is scoped during live user switches');
check(attention.includes('data-bujar-bonus-motivation="1"'), 'Bujar motivational message is rendered');
check(attention.includes('SOT I KI {items.length} MUNDËSI') && attention.includes('possibleMoney.toFixed(2)'), 'Bujar message uses live opportunity count and bonus amount');
check(attention.includes('isBujar && !offline'), 'Bujar live motivation must not be rendered from a stale/offline snapshot');

const currentBujar = {
  user_id: BUJAR_CANONICAL_USER_ID,
  pin: '7311',
  name: 'bujar oruqi',
};
const sameNameImpostor = {
  user_id: '11111111-1111-4111-8111-111111111111',
  pin: '4321',
  name: 'bujar oruqi',
};
const blerim = {
  user_id: 'e0f09793-3539-4242-81fe-c725baa615bc',
  pin: '7422',
  name: 'blerim kosumi',
};

check(isBujarBonusViewer(resolveReadyBonusViewerUserId({}, currentBujar)), 'current Bujar UUID receives motivation');
check(!isBujarBonusViewer(resolveReadyBonusViewerUserId({}, { pin: '5555', name: 'bujar oruqi' })), 'retired PIN 5555 alone cannot receive motivation');
check(!isBujarBonusViewer(resolveReadyBonusViewerUserId({}, sameNameImpostor)), 'same-name user cannot receive Bujar motivation');
check(!isBujarBonusViewer(resolveReadyBonusViewerUserId({}, blerim)), 'Blerim is unaffected by Bujar motivation');
check(
  !isBujarBonusViewer(resolveReadyBonusViewerUserId({ viewer: { user_id: blerim.user_id } }, currentBujar)),
  'trusted RPC viewer identity overrides stale local Bujar identity',
);
check(
  readyBonusCacheKeyForUserId(currentBujar.user_id) !== readyBonusCacheKeyForUserId(blerim.user_id),
  'Bujar and Blerim cannot share an offline attention cache',
);
check(readyBonusCacheKeyForUserId('5555') === '', 'retired PIN cannot address the canonical-user cache');

if (failures.length) {
  console.error(`FAIL: ${failures.length} base-payment bonus live-config check(s) failed.`);
  failures.forEach((message,index)=>console.error(`${index+1}. ${message}`));
  process.exit(1);
}
console.log(`PASS: ${passed} base-payment bonus live-config and canonical-identity checks passed.`);
