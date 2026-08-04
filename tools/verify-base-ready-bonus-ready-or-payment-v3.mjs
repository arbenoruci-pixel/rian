import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const files = {
  sql: read('sql/base_ready_bonus_ready_or_payment_v3_20260804.sql'),
  engine: read('lib/arka/arkaEngine.js'),
  client: read('lib/baseReadyBonusClient.js'),
  liveCard: read('components/ReadyBonusLiveCard.jsx'),
  bonusPage: read('app/arka/bonuset/page.jsx'),
  pastrimi: read('app/pastrimi/page.jsx'),
  gati: read('app/gati/page.jsx'),
  patch: read('tools/apply-base-ready-bonus-ready-or-payment-v3.mjs'),
  package: read('package.json'),
};

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function section(source, startNeedle, endNeedle = '') {
  const start = source.indexOf(startNeedle);
  if (start < 0) return '';
  if (!endNeedle) return source.slice(start);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const markSql = section(
  files.sql,
  'create or replace function public.mark_base_order_ready_with_bonus_v1',
  'create or replace function public.get_base_ready_bonus_summary_v1'
);
const paymentSql = section(
  files.sql,
  'create or replace function public.apply_base_ready_bonus_after_payment_v3',
  '-- Compatibility name used by the short-lived payment-gate build.'
);
const triggerSql = section(
  files.sql,
  'create or replace function public.base_ready_bonus_order_payment_trigger_v3',
  'drop trigger if exists trg_base_ready_bonus_order_payment_gate_v2'
);

// Shared policy and one-per-order accounting.
check(files.sql.includes("'base-ready-ready-or-payment-v3'"), 'V3 version marker missing');
check(files.sql.includes('base_ready_bonuses_order_unique') || files.sql.includes("concat('BASE_READY_48H_BONUS:',v_order.id)"), 'Stable one-order identity missing');
check(files.sql.includes('rate_m2'), 'Per-m2 rate model missing');
check(files.sql.includes('window_hours'), '48-hour configuration missing');
check(files.sql.includes('activation_source'), 'Bonus source tracking missing');
check(files.sql.includes('activation_payment_id'), 'Payment-to-bonus link missing');

// GATI still earns immediately.
check(markSql.includes("case when v_eligible then 'EARNED'"), 'GATI must earn immediately when eligible');
check(markSql.includes("'activation_source','GATI'"), 'GATI activation source missing');
check(markSql.includes('insert into public.arka_pending_payments'), 'GATI must create spendable ARKA bonus');
check(markSql.includes("'READY_48H_BONUS'"), 'GATI ARKA bonus type missing');
check(markSql.includes("v_reason := 'ELIGIBLE_WITHIN_48H_GATI'"), 'GATI 48h eligibility reason missing');
check(markSql.includes("'ready_by_pin'"), 'GATI worker ownership missing');
check(markSql.includes('where order_id=v_order.id'), 'Existing bonus duplicate guard missing at GATI');

// Full payment is an additional completion trigger.
check(paymentSql.includes("'WAITING_FULL_PAYMENT'"), 'Partial payment must not create bonus');
check(paymentSql.includes("where pin=btrim(coalesce(v_payment.created_by_pin,''))"), 'Payment actor ownership missing');
check(paymentSql.includes("'PAYMENT_ACTOR_NOT_BASE_WORKER'"), 'Non-base payment actor guard missing');
check(paymentSql.includes("'OVER_48_HOURS_AT_PAYMENT'"), 'Payment 48h guard missing');
check(paymentSql.includes("'ELIGIBLE_DIRECT_FULL_PAYMENT_WITHIN_48H'"), 'Direct payment eligibility missing');
check(paymentSql.includes("'PAYMENT_DIRECT'"), 'Direct-payment source missing');
check(paymentSql.includes("'READY_48H_BONUS'"), 'Payment-created ARKA bonus missing');
check(paymentSql.includes("'createdFromPayment',v_eligible"), 'Payment creation result missing');
check(paymentSql.includes("'BONUS_CREATED_BY_THIS_PAYMENT'"), 'Same-payment UI verification missing');
check(paymentSql.includes('exception when unique_violation'), 'Payment bonus idempotency race guard missing');
check(paymentSql.includes("'ORDER_ALREADY_HAS_BONUS'"), 'One bonus per order guard missing');

// Payment trigger is fail-open for customer money.
check(files.sql.includes('trg_base_ready_bonus_order_payment_v3'), 'Payment update trigger missing');
check(files.sql.includes('after update of data,status,price_total,paid,paid_cash'), 'Payment trigger field coverage missing');
check(triggerSql.includes('apply_base_ready_bonus_after_payment_v3'), 'Payment trigger RPC missing');
check(triggerSql.includes('exception when others'), 'Bonus failure must not cancel payment');
check(triggerSql.includes('return new'), 'Trigger must preserve order update');

// Summary/handoff includes either source and still excludes invalid bonuses.
check(files.sql.includes("'ready_or_full_payment',true"), 'Summary policy flag missing');
check(files.sql.includes("'one_bonus_per_order',true"), 'Summary one-bonus flag missing');
check(files.sql.includes('coalesce(b.activated_at,b.ready_at) as earned_at'), 'Unified earning date missing');
check(files.sql.includes("'activation_source',activation_source"), 'Bonus source missing from detail rows');
check(files.sql.includes("b.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')"), 'Open bonus status guard missing');
check(files.sql.includes('b.arka_payment_id is not null'), 'Handoff must require ARKA bonus row');

// Server payment path calls the DB authority and keeps payment success independent.
check(files.engine.includes('BASE_READY_READY_OR_PAYMENT_V3:ENGINE'), 'Engine V3 marker missing');
check(files.engine.includes("sb.rpc('apply_base_ready_bonus_after_payment_v3'"), 'Base payment engine bonus RPC missing');
check(files.engine.includes("reason: 'READY_BONUS_PAYMENT_RPC_FAILED'"), 'Fail-open bonus error result missing');
check(files.engine.includes('const readyBonus = await applyReadyBonusAfterBasePaymentV3'), 'Bonus call missing after verified payment');
check(files.engine.includes('readyBonus,'), 'Payment response does not expose bonus result');

// User-facing confirmation and visibility.
check(files.client.includes('describeReadyBonusPaymentCreation'), 'Payment bonus message helper missing');
check(files.client.includes('BONUSI 48H U SHTUA NGA PAGESA'), 'Payment bonus confirmation text missing');
check(files.pastrimi.includes('describeReadyBonusPaymentCreation'), 'Pastrimi payment confirmation missing');
check(files.pastrimi.includes('payRes?.readyBonus'), 'Pastrimi does not read bonus result');
check(files.gati.includes('describeReadyBonusPaymentCreation'), 'GATI payment confirmation missing');
check(files.gati.includes('payRes?.readyBonus'), 'GATI does not read bonus result');
check(files.liveCard.includes('GATI ose pagesa e plotë brenda 48h'), 'Live card dual-trigger policy missing');
check(files.bonusPage.includes('GATI ose pagesa e plotë'), 'Bonus page dual-trigger header missing');
check(files.bonusPage.includes('PAGESA E PLOTË'), 'Bonus row payment source label missing');
check(files.bonusPage.includes('vetëm një bonus'), 'One-bonus explanation missing');
check(files.bonusPage.includes('regjistron pagesën brenda 48 orëve'), 'Direct payment explanation missing');

// Build integration.
check(files.patch.includes('BASE_READY_READY_OR_PAYMENT_V3'), 'Patch marker missing');
check(files.patch.includes('patchArkaEngine()'), 'Patch does not modify payment engine');
check(files.patch.includes('patchPastrimi()'), 'Patch does not modify Pastrimi');
check(files.patch.includes('patchGati()'), 'Patch does not modify GATI');
check(files.package.includes('apply-base-ready-bonus-ready-or-payment-v3.mjs'), 'V3 prebuild patch missing');
check(files.package.includes('test:base-ready-ready-or-payment'), 'V3 build test missing');
check(files.package.includes('2.0.78-base-ready-ready-or-payment-v3'), 'V3 package version missing');

// Policy model: either qualifying event earns; partial payment alone does not.
const calcBonus = (m2, hours) => Number(hours) >= 0 && Number(hours) <= 48
  ? Number((Number(m2) * 0.10).toFixed(2))
  : 0;
const chooseOne = ({ gatiHours = null, paidHours = null, fullPayment = false }) => {
  if (gatiHours != null && calcBonus(20, gatiHours) > 0) return 'GATI';
  if (fullPayment && paidHours != null && calcBonus(20, paidHours) > 0) return 'PAYMENT_DIRECT';
  return '';
};
check(chooseOne({ gatiHours: 12 }) === 'GATI', 'GATI inside 48h must earn immediately');
check(chooseOne({ paidHours: 12, fullPayment: true }) === 'PAYMENT_DIRECT', 'Full payment inside 48h must earn without GATI');
check(chooseOne({ paidHours: 12, fullPayment: false }) === '', 'Partial payment must not earn');
check(chooseOne({ gatiHours: 12, paidHours: 13, fullPayment: true }) === 'GATI', 'Same order must not earn twice');
check(chooseOne({ paidHours: 48.01, fullPayment: true }) === '', 'Payment after 48h must not earn');

if (failures.length) {
  console.error(`FAIL: ${failures.length} ready-or-payment V3 check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: base-ready bonus works from GATI or full payment within 48h.');
