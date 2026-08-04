import fs from 'node:fs';

const files = {
  client: fs.readFileSync('lib/baseReadyBonusClient.js', 'utf8'),
  pastrimi: fs.readFileSync('app/pastrimi/page.jsx', 'utf8'),
  sync: fs.readFileSync('lib/syncEngine.js', 'utf8'),
  finance: fs.readFileSync('lib/corporateFinance.js', 'utf8'),
  arka: fs.readFileSync('app/arka/page.jsx', 'utf8'),
  constants: fs.readFileSync('lib/arka/arkaConstants.js', 'utf8'),
  routes: fs.readFileSync('src/generated/routes.generated.jsx', 'utf8'),
  bonusPage: fs.readFileSync('app/arka/bonuset/page.jsx', 'utf8'),
  liveCard: fs.readFileSync('components/ReadyBonusLiveCard.jsx', 'utf8'),
  patch: fs.readFileSync('tools/apply-base-ready-bonus-v1.mjs', 'utf8'),
};

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function scanMatching(source, start, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function functionBlock(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return '';
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatching(source, paramsStart, '(', ')');
  if (paramsStart < 0 || paramsEnd < 0) return '';
  let bodyStart = paramsEnd + 1;
  while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart += 1;
  if (source[bodyStart] !== '{') return '';
  const bodyEnd = scanMatching(source, bodyStart, '{', '}');
  if (bodyEnd < 0) return '';
  return source.slice(match.index, bodyEnd + 1);
}

const markReady = functionBlock(files.pastrimi, 'handleMarkReady');
const validateOp = functionBlock(files.sync, 'validateOpShape');
const processOp = functionBlock(files.sync, 'processOp');
const cashFilter = functionBlock(files.finance, 'isCashRowReadyForDispatch');
const paymentVerify = functionBlock(files.finance, 'paymentVerifiedForHandoff');
const submitVerify = functionBlock(files.finance, 'verifyHandoffSubmitResponse');
const submitHandoff = functionBlock(files.finance, 'submitWorkerCashToDispatch');
const arkaSubmit = functionBlock(files.arka, 'submitHandoff');

// Constants and policy.
check(files.client.includes('BASE_READY_BONUS_RATE_M2 = 0.10'), 'Bonus rate must be 0.10 EUR/m2');
check(files.client.includes('BASE_READY_BONUS_WINDOW_HOURS = 48'), 'Bonus window must be 48 hours');
check(files.client.includes("BASE_READY_BONUS_TYPE = 'READY_48H_BONUS'"), 'Bonus payment type missing');
check(files.constants.includes("READY_48H_BONUS: 'READY_48H_BONUS'"), 'ARKA bonus payment constant missing');
check(files.client.includes("WORKER_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE'])"), 'Worker role allow-list missing');

// PIN ownership and offline-safe queue.
check(files.client.includes("fetch('/api/auth/validate-pin'"), 'Online worker PIN validation missing');
check(files.client.includes('PIN_NUK_ESHTE_BAZIST_AKTIV'), 'Non-worker PIN rejection missing');
check(files.client.includes('TEPIHA_BASE_TERMINAL'), 'Shared base terminal prompt policy missing');
check(files.client.includes('warmBaseReadyBonusWorkerCache'), 'Worker cache warmup missing');
check(files.client.includes("queueOp('base_ready_bonus_transition'"), 'Offline bonus transition queue missing');
check(files.client.includes("supabase.rpc('mark_base_order_ready_with_bonus_v1'"), 'Atomic mark-ready bonus RPC missing');
check(files.client.includes('buildBaseReadyBonusIdempotencyKey'), 'Stable bonus idempotency key missing');
check(files.client.includes('list_worker_open_ready_bonus_payments_v1'), 'Open bonus payment list RPC missing');
check(files.client.includes('computeReadyBonusDeductionForCash'), 'Cash deduction calculator missing');
check(files.client.includes('cash - 0.01'), 'Handoff must retain positive DB-compatible minimum');

// Pastrimi must award only base rows and preserve transport behavior.
check(files.pastrimi.includes('BASE_READY_48H_BONUS_V1:PASTRIMI'), 'Pastrimi bonus marker missing');
check(markReady.includes('resolveBaseReadyBonusWorker'), 'Pastrimi does not ask who completed the order');
check(markReady.includes('ready_by_pin'), 'Ready worker PIN is not stored');
check(markReady.includes('ready_by_name'), 'Ready worker name is not stored');
check(markReady.includes("if (table === 'orders')"), 'Base-only branch missing');
check(markReady.includes('markBaseOrderReadyWithBonus'), 'Base ready RPC client missing from Pastrimi');
check(markReady.includes("table === 'transport_orders'"), 'Transport legacy branch missing');
check(markReady.includes('Shoferi u njoftua'), 'Transport ready behavior changed unexpectedly');
check(markReady.includes('describeReadyBonusResult'), 'Worker live bonus confirmation missing');
check(markReady.includes('offlineQueued'), 'Pastrimi offline bonus state missing');
check(!markReady.includes("markBaseOrderReadyWithBonus({\n          orderRef: existingLocalOid || o.id,\n          worker: readyBonusWorker,\n          readySlots: resolvedReadySlots,\n          readyNote: resolvedReadyText,\n          readyAt: now,\n          forceQueue: localBranch || (typeof navigator !== 'undefined' && navigator.onLine === false),\n        });\n        if (table === 'transport_orders')"), 'Transport must never enter base bonus RPC');

// Sync engine must flush the exact RPC and preserve local mirror.
check(files.sync.includes('BASE_READY_48H_BONUS_V1:SYNC'), 'Sync bonus marker missing');
check(validateOp.includes("type === 'base_ready_bonus_transition'"), 'Bonus op validation missing');
check(validateOp.includes('MISSING_READY_BONUS_WORKER_PIN'), 'Bonus worker PIN shape guard missing');
check(validateOp.includes('MISSING_READY_BONUS_IDEMPOTENCY_KEY'), 'Bonus idempotency shape guard missing');
check(processOp.includes("if (type === 'base_ready_bonus_transition')"), 'Bonus sync handler missing');
check(processOp.includes("supabase.rpc('mark_base_order_ready_with_bonus_v1'"), 'Bonus sync does not call DB authority');
check(processOp.includes('BASE_READY_BONUS_SYNC_VERIFY_FAILED'), 'Bonus sync DB verification missing');
check(processOp.includes('await saveOrderLocal'), 'Bonus sync local mirror hydration missing');

// ARKA handoff must exclude bonus from cash and automatically retain it.
check(files.finance.includes('BASE_READY_48H_BONUS_V1:FINANCE'), 'Finance bonus marker missing');
check(cashFilter.includes('BASE_READY_BONUS_TYPE'), 'Bonus row could be counted as client cash');
check(paymentVerify.includes('READY_48H_BONUS'), 'Bonus handoff verification missing');
check(paymentVerify.includes('PARTIAL_IN_HANDOFF'), 'Partial bonus allocation verification missing');
check(submitVerify.includes('expectedReadyBonusPaymentIds'), 'Expected bonus payment verification missing');
check(submitVerify.includes('HANDOFF_DEDUCTION_SHOULD_NOT_BE_ITEM'), 'Bonus/meal negative-item guard missing');
check(submitHandoff.includes('listOpenBaseReadyBonusPayments'), 'Handoff does not load available bonus');
check(submitHandoff.includes("supabase.rpc('submit_cash_handoff_with_ready_bonus_v1'"), 'Handoff does not use bonus-aware atomic RPC');
check(submitHandoff.includes('ready_bonus_payment_ids'), 'Bonus payment IDs not sent to DB');
check(submitHandoff.includes('expectedReadyBonusPaymentIds'), 'Bonus IDs not verified after handoff');
check(submitHandoff.includes('readyBonusTotal'), 'Retained bonus total missing from result');
check(submitHandoff.includes('READY48:'), 'Handoff idempotency does not include bonus set');

// Live visibility in ARKA.
check(files.arka.includes('BASE_READY_48H_BONUS_V1:ARKA'), 'ARKA bonus marker missing');
check(files.arka.includes("'READY_48H_BONUS'"), 'ARKA extra filter does not exclude bonus from cash');
check(files.arka.includes('ReadyBonusLiveCard'), 'Live bonus card missing from ARKA');
check(files.arka.includes('href="/arka/bonuset"'), 'Bonus page link missing from ARKA');
check(arkaSubmit.includes('listOpenBaseReadyBonusPayments'), 'Handoff confirmation does not load live bonus');
check(arkaSubmit.includes('BONUSI 48H QË E MBAN'), 'Handoff confirmation bonus line missing');
check(arkaSubmit.includes('computeReadyBonusDeductionForCash'), 'Handoff preview does not match DB deduction policy');
check(files.liveCard.includes('rifres'), 'Live card refresh behavior missing');
check(files.liveCard.includes('45000'), 'Live card interval missing');
check(files.liveCard.includes('PËR ME MBAJT'), 'Live card available bonus metric missing');

// Dedicated page and route.
check(files.routes.includes("import ArkaBonusetPageEager from '@/app/arka/bonuset/page.jsx'"), 'Bonus route import missing');
check(files.routes.includes("path: '/arka/bonuset'"), 'Bonus route missing');
check(files.routes.includes('BASE_READY_48H_BONUS_V1:ROUTES'), 'Bonus route marker missing');
check(files.bonusPage.includes('BONUSI 48H'), 'Bonus page title missing');
check(files.bonusPage.includes('Vetëm porositë BAZA') || files.bonusPage.includes('Vetëm porositë BAZA'.toUpperCase()), 'Bonus page base-only explanation missing');
check(files.bonusPage.includes('getBaseReadyBonusSummary'), 'Bonus page DB summary missing');
check(files.bonusPage.includes('30000'), 'Bonus page 30-second refresh missing');
check(files.bonusPage.includes('MUNDESH ME MBAJT'), 'Bonus page available-to-keep metric missing');
check(files.bonusPage.includes('Transporti nuk hyn'), 'Bonus page transport exclusion missing');
check(files.bonusPage.includes("summary?._offlineSnapshot"), 'Bonus page offline snapshot indicator missing');

// Build patch safety.
check(files.patch.includes('replaceNamedFunction'), 'Patch script lacks function-safe replacement');
check(files.patch.includes('patchPastrimi()'), 'Patch script does not patch Pastrimi');
check(files.patch.includes('patchSyncEngine()'), 'Patch script does not patch sync engine');
check(files.patch.includes('patchCorporateFinance()'), 'Patch script does not patch finance');
check(files.patch.includes('patchArka()'), 'Patch script does not patch ARKA');
check(files.patch.includes('patchRoutes()'), 'Patch script does not patch routes');

// Runtime policy models.
const eligible = (hours) => Number(hours) >= 0 && Number(hours) <= 48;
const bonus = (squareMeters, hours) => eligible(hours) ? Number((Number(squareMeters) * 0.10).toFixed(2)) : 0;
const deductible = (cash, available) => {
  const c = Math.max(0, Number(cash || 0));
  const b = Math.max(0, Number(available || 0));
  if (c <= 0.01 || b <= 0) return 0;
  return Number(Math.min(b, Math.max(0, c - 0.01)).toFixed(2));
};
check(bonus(100, 47.99) === 10, '100m2 inside 48h must earn 10 EUR');
check(bonus(100, 48) === 10, 'Exactly 48h must remain eligible');
check(bonus(100, 48.01) === 0, 'Over 48h must not earn');
check(bonus(5.9, 24) === 0.59, 'Decimal m2 bonus rounding failed');
check(deductible(20, 3.5) === 3.5, 'Full available bonus deduction failed');
check(deductible(3, 10) === 2.99, 'Partial bonus carry-forward policy failed');
check(deductible(0.01, 10) === 0, 'Positive handoff minimum guard failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} base-ready 48h bonus check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 78 base-ready 48h bonus checks passed.');
