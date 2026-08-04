import fs from 'node:fs';

const ENGINE_PATH = 'lib/arka/arkaEngine.js';
const PAY_SERVICE_PATH = 'components/payments/payService.js';
const LIVE_CARD_PATH = 'components/ReadyBonusLiveCard.jsx';
const BONUS_PAGE_PATH = 'app/arka/bonuset/page.jsx';
const MARKER = 'BASE_READY_OR_PAYMENT_BONUS_V2_FINAL';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function patchEngine() {
  let source = fs.readFileSync(ENGINE_PATH, 'utf8');
  if (source.includes(`${MARKER}:ENGINE`)) return false;

  if (!source.includes('award_base_ready_bonus_from_payment_v2')) {
    const anchor = `    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });\n\n    return {\n      ok: true,\n      action: ARKA_ACTION.BASE_ORDER_PAYMENT,`;
    const replacement = `    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });\n\n    // ${MARKER}:ENGINE — the verified worker who completes the full BASE payment\n    // can earn the same 48h/m² bonus. DB keeps one bonus per order, so GATI\n    // and PAYMENT can never pay the order twice.\n    let readyBonusResult = null;\n    try {\n      const { data: bonusData, error: bonusError } = await sb.rpc('award_base_ready_bonus_from_payment_v2', {\n        p_payment_id: normalizeDbId(verifiedPayment?.id),\n        p_actor_pin: actor.pin,\n      });\n      if (bonusError) throw bonusError;\n      readyBonusResult = bonusData || null;\n    } catch (bonusError) {\n      // Payment remains authoritative even if the incentive side-channel needs repair.\n      // The DB full-payment trigger retries the same idempotent award automatically.\n      readyBonusResult = {\n        ok: false,\n        awarded: false,\n        reason: 'READY_BONUS_PAYMENT_HOOK_FAILED',\n        error: String(bonusError?.message || bonusError || 'READY_BONUS_PAYMENT_HOOK_FAILED'),\n      };\n    }\n\n    return {\n      ok: true,\n      action: ARKA_ACTION.BASE_ORDER_PAYMENT,`;
    source = replaceRequired(source, anchor, replacement, 'ENGINE_PAYMENT_BONUS_HOOK');

    source = replaceRequired(
      source,
      `      order: updatedOrder,\n      idempotencyKey,\n    };`,
      `      order: updatedOrder,\n      idempotencyKey,\n      readyBonusResult,\n      readyBonus: readyBonusResult?.bonus || null,\n      readyBonusSummary: readyBonusResult?.summary || null,\n      readyBonusAwarded: readyBonusResult?.awarded === true,\n      readyBonusAlreadyApplied: readyBonusResult?.alreadyApplied === true,\n      readyBonusReason: readyBonusResult?.reason || null,\n    };`,
      'ENGINE_PAYMENT_BONUS_RESULT'
    );
  } else {
    source = source.replace(
      `async function baseOrderPayment(sb, payload = {}) {`,
      `// ${MARKER}:ENGINE\nasync function baseOrderPayment(sb, payload = {}) {`
    );
  }

  if (!source.includes(`${MARKER}:ENGINE`)) {
    source = source.replace(
      `async function baseOrderPayment(sb, payload = {}) {`,
      `// ${MARKER}:ENGINE\nasync function baseOrderPayment(sb, payload = {}) {`
    );
  }
  fs.writeFileSync(ENGINE_PATH, source, 'utf8');
  return true;
}

function patchPayService() {
  let source = fs.readFileSync(PAY_SERVICE_PATH, 'utf8');
  if (source.includes(`${MARKER}:PAY_SERVICE`)) return false;

  const helper = `\nexport function describeBasePaymentReadyBonus(result = {}) {\n  const bonus = result?.readyBonus || result?.readyBonusResult?.bonus || null;\n  const amount = Number(bonus?.amount || 0);\n  if (result?.readyBonusAwarded === true && amount > 0) {\n    return \`BONUSI 48H +\${amount.toFixed(2)}€ U REGJISTRUA NGA PAGESA.\`;\n  }\n  if (result?.readyBonusAlreadyApplied === true) return 'BONUSI I KËSAJ POROSIE ËSHTË REGJISTRUAR MË HERËT.';\n  return '';\n}\n`;
  source = replaceRequired(
    source,
    `function normalizeFullPaymentStatus(input = {}) {`,
    `${helper}\n// ${MARKER}:PAY_SERVICE\nfunction normalizeFullPaymentStatus(input = {}) {`,
    'PAY_SERVICE_HELPER'
  );

  source = replaceRequired(
    source,
    `  return {\n    ok: true,\n    ...(result || {}),\n    pending: true,`,
    `  try {\n    if (typeof window !== 'undefined' && (result?.readyBonusAwarded || result?.readyBonusAlreadyApplied)) {\n      window.dispatchEvent(new CustomEvent('arka:ready-bonus-payment', {\n        detail: {\n          orderId,\n          actorPin: String(actor.pin),\n          awarded: result?.readyBonusAwarded === true,\n          alreadyApplied: result?.readyBonusAlreadyApplied === true,\n          bonus: result?.readyBonus || result?.readyBonusResult?.bonus || null,\n          summary: result?.readyBonusSummary || result?.readyBonusResult?.summary || null,\n          message: describeBasePaymentReadyBonus(result),\n        },\n      }));\n    }\n  } catch {}\n\n  return {\n    ok: true,\n    ...(result || {}),\n    bonusMessage: describeBasePaymentReadyBonus(result),\n    pending: true,`,
    'PAY_SERVICE_RESULT_EVENT'
  );

  fs.writeFileSync(PAY_SERVICE_PATH, source, 'utf8');
  return true;
}

function patchLiveCard() {
  let source = fs.readFileSync(LIVE_CARD_PATH, 'utf8');
  if (source.includes(`${MARKER}:LIVE_CARD`)) return false;
  source = source
    .replace(/0\.10€ \/ m² • GATI brenda 48 orëve(?: • rifreskohet automatikisht)?/g, '0.10€ / m² • GATI ose PAGESË E PLOTË brenda 48 orëve • rifreskohet automatikisht')
    .replace(`'use client';`, `'use client';\n// ${MARKER}:LIVE_CARD`);
  fs.writeFileSync(LIVE_CARD_PATH, source, 'utf8');
  return true;
}

function patchBonusPage() {
  let source = fs.readFileSync(BONUS_PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:BONUS_PAGE`)) return false;
  source = source
    .replace('porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve', 'porosia BAZA • GATI ose PAGESË E PLOTË brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve')
    .replace('Bonusi i takon PIN-it që e bën porosinë GATI pas paketimit dhe raftit final.', 'Bonusi i takon PIN-it të veprimit të parë kualifikues: GATI pas paketimit ose pagesa e plotë e verifikuar.')
    .replace('Një porosi paguhet vetëm një herë. PIN-i i fundit që e bën GATI merr 0.10€ për m² kur koha është brenda 48 orëve.', 'Një porosi paguhet vetëm një herë. PIN-i që e bën i pari GATI ose e përfundon pagesën e plotë merr 0.10€ për m² kur koha është brenda 48 orëve.')
    .replace(`'use client';`, `'use client';\n// ${MARKER}:BONUS_PAGE`);
  fs.writeFileSync(BONUS_PAGE_PATH, source, 'utf8');
  return true;
}

const changed = [patchEngine(), patchPayService(), patchLiveCard(), patchBonusPage()].some(Boolean);
console.log(`[base-ready-or-payment-bonus-v2-final] ${changed ? 'installed' : 'already installed'}`);
