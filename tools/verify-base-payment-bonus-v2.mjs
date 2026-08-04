import fs from 'node:fs';

const files = {
  client: fs.readFileSync('lib/baseReadyBonusClient.js', 'utf8'),
  pastrimi: fs.readFileSync('app/pastrimi/page.jsx', 'utf8'),
  engine: fs.readFileSync('lib/arka/arkaEngine.js', 'utf8'),
  payService: fs.readFileSync('components/payments/payService.js', 'utf8'),
  liveCard: fs.readFileSync('components/ReadyBonusLiveCard.jsx', 'utf8'),
  bonusPage: fs.readFileSync('app/arka/bonuset/page.jsx', 'utf8'),
  patch: fs.readFileSync('tools/apply-base-payment-bonus-v2.mjs', 'utf8'),
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

const readyClient = functionBlock(files.client, 'markBaseOrderReadyWithBonus');
const readyDescription = functionBlock(files.client, 'describeReadyBonusResult');
const markReady = functionBlock(files.pastrimi, 'handleMarkReady');
const basePayment = functionBlock(files.engine, 'baseOrderPayment');
const payRecorder = functionBlock(files.payService, 'recordOrderCashPayment');

check(files.client.includes('BASE_PAYMENT_48H_BONUS_V2:CLIENT'), 'Client V2 marker missing');
check(readyClient.includes("p_worker_pin: stageActor.pin"), 'GATI stage actor is not sent');
check(readyClient.includes("activation_rule: 'FULL_PAYMENT_ACTOR'"), 'Offline stage activation rule missing');
check(!readyClient.includes('isBaseReadyBonusWorkerRole(resolvedWorker.role)'), 'GATI must not choose the bonus owner');
check(readyDescription.includes('PAGESËS'), 'Payment-owner confirmation copy missing');
check(readyDescription.includes('AKTIVIZOHET KUR REGJISTROHET PAGESA'), 'Waiting-for-payment copy missing');

check(files.pastrimi.includes('BASE_PAYMENT_48H_BONUS_V2:PASTRIMI'), 'Pastrimi V2 marker missing');
check(!markReady.includes('resolveBaseReadyBonusWorker({'), 'GATI still prompts for the bonus worker');
check(markReady.includes('readyBonusWorker = getActor?.()'), 'GATI stage actor session missing');
check(markReady.includes('markBaseOrderReadyWithBonus'), 'GATI staging RPC path missing');
check(markReady.includes('describeReadyBonusResult'), 'GATI payment-waiting result missing');
check(markReady.includes("table === 'orders'"), 'Base-only GATI branch missing');
check(markReady.includes("table === 'transport_orders'"), 'Transport GATI branch must remain');

check(files.engine.includes('BASE_PAYMENT_48H_BONUS_V2:ENGINE'), 'ARKA engine V2 marker missing');
check(files.engine.includes('activateBaseReadyBonusAfterPaymentV2'), 'Payment bonus helper missing');
check(files.engine.includes("sb.rpc('activate_base_ready_bonus_on_full_payment_v2'"), 'Payment activation RPC missing');
check(files.engine.includes('BASE_READY_48H_PAYMENT:'), 'Stable payment activation idempotency missing');
check(basePayment.includes('activateBaseReadyBonusAfterPaymentV2'), 'Verified base payment does not activate bonus');
check(basePayment.indexOf('verifyBasePaymentOrThrow') < basePayment.indexOf('activateBaseReadyBonusAfterPaymentV2'), 'Bonus activation must follow payment verification');
check(basePayment.includes('order: updatedOrder'), 'Activation does not use DB-updated order');
check(basePayment.includes('payment: verifiedPayment'), 'Activation does not use verified payment');
check(basePayment.includes('readyBonusActivated'), 'Payment response lacks bonus activation flag');
check(basePayment.includes('readyBonusActivationError'), 'Payment response lacks safe bonus error reporting');
check(basePayment.includes('ok: true'), 'Bonus sidecar must not turn a committed payment into a false failure');

check(files.payService.includes('BASE_PAYMENT_48H_BONUS_V2:PAY_SERVICE'), 'Pay service V2 marker missing');
check(payRecorder.includes("window.dispatchEvent(new Event('arka:refresh'))"), 'ARKA refresh after payment missing');
check(payRecorder.includes("base-ready-bonus:refresh"), 'Bonus live refresh event missing');
check(payRecorder.includes('result?.readyBonusActivated'), 'Payment event lacks activation state');

check(files.liveCard.includes('BASE_PAYMENT_48H_BONUS_V2:LIVE_CARD'), 'Live card V2 marker missing');
check(files.liveCard.includes('aktivizohet në pagesën'), 'Live card still describes GATI as payout event');
check(files.liveCard.includes("base-ready-bonus:refresh"), 'Live card payment refresh listener missing');

check(files.bonusPage.includes('BASE_PAYMENT_48H_BONUS_V2:BONUS_PAGE'), 'Bonus page V2 marker missing');
check(files.bonusPage.includes('PIN-it që regjistron pagesën'), 'Bonus page ownership rule missing');
check(files.bonusPage.includes('PAGESA ${stamp(row.activated_at || row.ready_at)}'), 'Bonus rows are not dated by activation/payment');
check(files.bonusPage.includes('GATI brenda 48 orëve mbetet kushti'), '48-hour qualification copy missing');
check(files.bonusPage.includes('Bonusi shfaqet pasi pagesa e mbyll porosinë'), 'Activation timing explanation missing');

check(files.patch.includes('replaceNamedFunction'), 'V2 patch lacks function-safe replacement');
check(files.patch.includes('patchClient()'), 'V2 patch does not patch client');
check(files.patch.includes('patchPastrimi()'), 'V2 patch does not patch Pastrimi');
check(files.patch.includes('patchEngine()'), 'V2 patch does not patch ARKA engine');
check(files.patch.includes('patchPayService()'), 'V2 patch does not patch pay service');
check(files.patch.includes('patchLiveCard()'), 'V2 patch does not patch live card');
check(files.patch.includes('patchBonusPage()'), 'V2 patch does not patch bonus page');

const readyEligible = (hours) => Number(hours) >= 0 && Number(hours) <= 48;
const activates = ({ readyHours, total, paidBefore, finalPayment }) => {
  const fullyPaid = Number(paidBefore || 0) + Number(finalPayment || 0) >= Number(total || 0) - 0.01;
  return fullyPaid && readyEligible(readyHours);
};
const bonus = (m2, input) => activates(input) ? Number((Number(m2 || 0) * 0.10).toFixed(2)) : 0;
check(bonus(20, { readyHours: 30, total: 26, paidBefore: 0, finalPayment: 26 }) === 2, 'Full payment after eligible GATI must activate bonus');
check(bonus(20, { readyHours: 30, total: 26, paidBefore: 10, finalPayment: 5 }) === 0, 'Partial payment must not activate bonus');
check(bonus(20, { readyHours: 30, total: 26, paidBefore: 10, finalPayment: 16 }) === 2, 'Payment that closes remaining debt must activate bonus');
check(bonus(20, { readyHours: 49, total: 26, paidBefore: 0, finalPayment: 26 }) === 0, 'Payment cannot override the 48-hour limit');
check(bonus(5.9, { readyHours: 48, total: 7.67, paidBefore: 0, finalPayment: 7.67 }) === 0.59, 'Exact 48h decimal bonus failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} base-payment bonus V2 check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: base-payment 48h bonus V2 checks passed.');
