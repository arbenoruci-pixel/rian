import fs from 'node:fs';

const ENGINE_PATH = 'lib/arka/arkaEngine.js';
const CLIENT_PATH = 'lib/baseReadyBonusClient.js';
const LIVE_CARD_PATH = 'components/ReadyBonusLiveCard.jsx';
const BONUS_PAGE_PATH = 'app/arka/bonuset/page.jsx';
const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const GATI_PATH = 'app/gati/page.jsx';
const MARKER = 'BASE_READY_READY_OR_PAYMENT_V3';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function replaceAllRequired(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count <= 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return { source: source.split(from).join(to), count };
}

function ensureImport(source, line, anchor, label) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(anchor, `${anchor}\n${line}`);
}

function patchArkaEngine() {
  let source = fs.readFileSync(ENGINE_PATH, 'utf8');
  if (source.includes(`${MARKER}:ENGINE`)) return false;

  const functionAnchor = `async function baseOrderPayment(sb, payload = {}) {`;
  const helper = `async function applyReadyBonusAfterBasePaymentV3(sb, { orderId, payment } = {}) {
  // ${MARKER}:ENGINE — full BASE payment may create the same one-per-order bonus when GATI did not.
  const cleanOrderId = normalizeDbId(orderId);
  const cleanPaymentId = normalizeDbId(payment?.id);
  if (!cleanOrderId) return null;
  try {
    const { data, error } = await sb.rpc('apply_base_ready_bonus_after_payment_v3', {
      p_order_id: cleanOrderId,
      p_payment_id: cleanPaymentId || null,
      p_paid_at: payment?.created_at || nowIso(),
    });
    if (error) {
      if (isMissingRpcFunctionError(error, 'apply_base_ready_bonus_after_payment_v3')) return null;
      return {
        ok: false,
        createdFromPayment: false,
        reason: 'READY_BONUS_PAYMENT_RPC_FAILED',
        error: String(error?.message || error?.details || error || ''),
      };
    }
    return data || null;
  } catch (error) {
    return {
      ok: false,
      createdFromPayment: false,
      reason: 'READY_BONUS_PAYMENT_RPC_FAILED',
      error: String(error?.message || error || ''),
    };
  }
}

`;
  source = replaceRequired(source, functionAnchor, `${helper}${functionAnchor}`, 'ENGINE_HELPER');

  const verifyAnchor = `    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });\n\n    return {`;
  source = replaceRequired(
    source,
    verifyAnchor,
    `    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });\n\n    const readyBonus = await applyReadyBonusAfterBasePaymentV3(sb, {\n      orderId,\n      payment: verifiedPayment,\n    });\n\n    return {`,
    'ENGINE_PAYMENT_TRIGGER'
  );

  source = replaceRequired(
    source,
    `      order: updatedOrder,\n      idempotencyKey,`,
    `      order: updatedOrder,\n      readyBonus,\n      idempotencyKey,`,
    'ENGINE_PAYMENT_RESULT'
  );

  fs.writeFileSync(ENGINE_PATH, source, 'utf8');
  return true;
}

function patchClient() {
  let source = fs.readFileSync(CLIENT_PATH, 'utf8');
  if (source.includes(`${MARKER}:CLIENT`)) return false;

  const describeAnchor = `export function describeReadyBonusResult(result = {}) {`;
  const paymentDescribe = [
    'export function describeReadyBonusPaymentCreation(result = {}) {',
    `  // ${MARKER}:CLIENT`,
    '  const outcome = result?.readyBonus || result || {};',
    '  const bonus = outcome?.bonus || {};',
    "  if (!outcome?.createdFromPayment || !bonus?.eligible) return '';",
    '  const amount = number(bonus?.amount, 0);',
    "  if (!(amount > 0)) return '';",
    '  const owner = text(bonus?.worker_name || bonus?.worker_pin);',
    '  return [',
    '    `BONUSI 48H U SHTUA NGA PAGESA: +${amount.toFixed(2)}€`,',
    "    owner ? `PËR ${owner.toUpperCase()}` : '',",
    "    'MUNDESH ME E MBAJT NGA DORËZIMI',",
    "  ].filter(Boolean).join(' • ');",
    '}',
    '',
  ].join('\n');
  source = replaceRequired(source, describeAnchor, `${paymentDescribe}
${describeAnchor}`, 'CLIENT_PAYMENT_DESCRIBE');

  fs.writeFileSync(CLIENT_PATH, source, 'utf8');
  return true;
}

function patchLiveCard() {
  let source = fs.readFileSync(LIVE_CARD_PATH, 'utf8');
  if (source.includes(`${MARKER}:LIVE_CARD`)) return false;

  source = replaceRequired(
    source,
    `0.10€ / m² • GATI brenda 48 orëve`,
    `0.10€ / m² • GATI ose pagesa e plotë brenda 48h`,
    'LIVE_CARD_POLICY'
  );

  source = replaceRequired(
    source,
    `      {summary?._offlineSnapshot ? <div style={{ fontSize: 8, color: '#fde68a', fontWeight: 900 }}>OFFLINE • SNAPSHOT I FUNDIT</div> : null}`,
    `      {/* ${MARKER}:LIVE_CARD */}\n      {summary?._offlineSnapshot ? <div style={{ fontSize: 8, color: '#fde68a', fontWeight: 900 }}>OFFLINE • SNAPSHOT I FUNDIT</div> : null}`,
    'LIVE_CARD_MARKER'
  );

  fs.writeFileSync(LIVE_CARD_PATH, source, 'utf8');
  return true;
}

function patchBonusPage() {
  let source = fs.readFileSync(BONUS_PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:BONUS_PAGE`)) return false;

  source = replaceRequired(
    source,
    `<p>{BASE_READY_BONUS_RATE_M2.toFixed(2)}€ për m² • porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve</p>`,
    `<p>{BASE_READY_BONUS_RATE_M2.toFixed(2)}€ për m² • GATI ose pagesa e plotë brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve</p>`,
    'BONUS_PAGE_HEADER'
  );

  source = replaceRequired(
    source,
    `{stamp(row.ready_at)}</div>`,
    `{stamp(row.activated_at || row.ready_at)}</div>\n                        <div className="bonusSmall">BURIMI: {String(row.activation_source || 'GATI').toUpperCase() === 'PAYMENT_DIRECT' ? 'PAGESA E PLOTË' : 'GATI'}</div>`,
    'BONUS_PAGE_SOURCE'
  );

  source = replaceRequired(
    source,
    `              <span>Një porosi paguhet vetëm një herë. PIN-i i fundit që e bën GATI merr 0.10€ për m² kur koha është brenda 48 orëve.</span>\n              <span>Shuma “MUNDESH ME MBAJT” zbritet automatikisht nga cash-i që i dërgohet Dispatch. Teprica bartet për dorëzimin tjetër.</span>`,
    `              <span>Një porosi krijon vetëm një bonus. PIN-i që e bën GATI brenda 48 orëve e merr bonusin menjëherë.</span>\n              <span>Nëse porosia paguhet plotësisht para se të bëhet GATI, bonusin e merr PIN-i i bazistit që e regjistron pagesën brenda 48 orëve.</span>\n              <span>Shuma “MUNDESH ME MBAJT” zbritet automatikisht nga cash-i që i dërgohet Dispatch. Teprica bartet për dorëzimin tjetër.</span>\n              {/* ${MARKER}:BONUS_PAGE */}`,
    'BONUS_PAGE_INFO'
  );

  fs.writeFileSync(BONUS_PAGE_PATH, source, 'utf8');
  return true;
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');
  if (source.includes(`${MARKER}:PASTRIMI`)) return false;

  source = replaceRequired(
    source,
    `import { describeReadyBonusResult, markBaseOrderReadyWithBonus, resolveBaseReadyBonusWorker } from '@/lib/baseReadyBonusClient';`,
    `import { describeReadyBonusPaymentCreation, describeReadyBonusResult, markBaseOrderReadyWithBonus, resolveBaseReadyBonusWorker } from '@/lib/baseReadyBonusClient';\n// ${MARKER}:PASTRIMI`,
    'PASTRIMI_BONUS_IMPORT'
  );

  const paymentGuard = `if (!payRes?.ok || !payRes?.payment || !payRes?.order) throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');`;
  const paymentGuardWithMessage = `${paymentGuard}\n        (() => {\n          const bonusMessage = describeReadyBonusPaymentCreation(payRes?.readyBonus || payRes);\n          if (bonusMessage) alert(bonusMessage);\n        })();`;
  source = replaceAllRequired(source, paymentGuard, paymentGuardWithMessage, 'PASTRIMI_PAYMENT_MESSAGE').source;

  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
  return true;
}

function patchGati() {
  let source = fs.readFileSync(GATI_PATH, 'utf8');
  if (source.includes(`${MARKER}:GATI`)) return false;

  source = ensureImport(
    source,
    `import { describeReadyBonusPaymentCreation } from '@/lib/baseReadyBonusClient';`,
    `import { recordOrderCashPayment } from '@/components/payments/payService';`,
    'GATI_BONUS_IMPORT'
  );
  source = source.replace(
    `import { describeReadyBonusPaymentCreation } from '@/lib/baseReadyBonusClient';`,
    `import { describeReadyBonusPaymentCreation } from '@/lib/baseReadyBonusClient';\n// ${MARKER}:GATI`
  );

  const guard = `        if (!payRes?.ok || !payRes?.payment?.id || !payRes?.order?.id) {\n          throw new Error(payRes?.error || 'ARKA_PAYMENT_VERIFY_FAILED');\n        }`;
  const guardWithMessage = `${guard}\n        (() => {\n          const bonusMessage = describeReadyBonusPaymentCreation(payRes?.readyBonus || payRes);\n          if (bonusMessage) alert(bonusMessage);\n        })();`;
  source = replaceRequired(source, guard, guardWithMessage, 'GATI_PAYMENT_MESSAGE');

  fs.writeFileSync(GATI_PATH, source, 'utf8');
  return true;
}

const changed = [
  patchArkaEngine(),
  patchClient(),
  patchLiveCard(),
  patchBonusPage(),
  patchPastrimi(),
  patchGati(),
].some(Boolean);

console.log(`[base-ready-ready-or-payment-v3] ${changed ? 'installed' : 'already installed'}`);
