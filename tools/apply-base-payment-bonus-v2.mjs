import fs from 'node:fs';

const CLIENT_PATH = 'lib/baseReadyBonusClient.js';
const ENGINE_PATH = 'lib/arka/arkaEngine.js';
const PAY_SERVICE_PATH = 'components/payments/payService.js';
const LIVE_CARD_PATH = 'components/ReadyBonusLiveCard.jsx';
const BONUS_PAGE_PATH = 'app/arka/bonuset/page.jsx';
const MARKER = 'BASE_PAYMENT_48H_BONUS_V2';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function findNamedFunctionRange(source, name) {
  const starts = [
    `async function ${name}(`,
    `function ${name}(`,
    `export async function ${name}(`,
    `export function ${name}(`,
  ];
  let start = -1;
  for (const token of starts) {
    const idx = source.indexOf(token);
    if (idx >= 0 && (start < 0 || idx < start)) start = idx;
  }
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${name}`);
  const brace = source.indexOf('{', start);
  if (brace < 0) throw new Error(`FUNCTION_BRACE_NOT_FOUND:${name}`);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (!inDouble && !inTemplate && ch === "'") { inSingle = !inSingle; continue; }
    if (!inSingle && !inTemplate && ch === '"') { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === '`') { inTemplate = !inTemplate; continue; }
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`FUNCTION_END_NOT_FOUND:${name}`);
}

function functionBlock(source, name) {
  const range = findNamedFunctionRange(source, name);
  return source.slice(range.start, range.end);
}

function patchClient() {
  let source = fs.readFileSync(CLIENT_PATH, 'utf8');
  if (source.includes(`${MARKER}:CLIENT`)) return false;
  source += `\n// ${MARKER}:CLIENT — GATI stages eligibility; the full-payment actor owns activation.\n`;
  fs.writeFileSync(CLIENT_PATH, source, 'utf8');
  return true;
}

function patchEngine() {
  let source = fs.readFileSync(ENGINE_PATH, 'utf8');
  if (source.includes(`${MARKER}:ENGINE`)) return false;
  source += `\n// ${MARKER}:ENGINE\n`;
  fs.writeFileSync(ENGINE_PATH, source, 'utf8');
  return true;
}

function patchPayService() {
  let source = fs.readFileSync(PAY_SERVICE_PATH, 'utf8');
  if (source.includes(`${MARKER}:PAY_SERVICE`)) return false;
  const block = functionBlock(source, 'recordOrderCashPayment');
  const anchor = `  return {\n    ok: true,\n    ...(result || {}),`;
  if (!block.includes(anchor)) throw new Error('PAY_SERVICE_SUCCESS_RETURN_ANCHOR_NOT_FOUND');
  const replacement = `  try {\n    if (typeof window !== 'undefined') {\n      window.dispatchEvent(new Event('arka:refresh'));\n      window.dispatchEvent(new CustomEvent('base-ready-bonus:refresh', {\n        detail: {\n          orderId,\n          paymentId: payment?.id || null,\n          activated: result?.readyBonusActivated === true,\n          bonus: result?.readyBonus || result?.readyBonusResult?.bonus || null,\n        },\n      }));\n    }\n  } catch {}\n  // ${MARKER}:PAY_SERVICE\n\n  return {\n    ok: true,\n    ...(result || {}),`;
  const nextBlock = block.replace(anchor, replacement);
  const range = findNamedFunctionRange(source, 'recordOrderCashPayment');
  source = `${source.slice(0, range.start)}${nextBlock}${source.slice(range.end)}`;
  fs.writeFileSync(PAY_SERVICE_PATH, source, 'utf8');
  return true;
}

function patchLiveCard() {
  let source = fs.readFileSync(LIVE_CARD_PATH, 'utf8');
  if (source.includes(`${MARKER}:LIVE_CARD`) || source.includes('READY_BONUS_LIVE_CARD_V2')) return false;
  source = replaceRequired(source, `0.10€ / m² • GATI brenda 48 orëve`, `0.10€ / m² • aktivizohet në pagesën që e mbyll porosinë`, 'LIVE_CARD_RULE_COPY');
  source = replaceRequired(source, `    window.addEventListener('arka:refresh', onRefresh);`, `    window.addEventListener('arka:refresh', onRefresh);\n    window.addEventListener('base-ready-bonus:refresh', onRefresh);`, 'LIVE_CARD_REFRESH_LISTENER');
  source = replaceRequired(source, `      window.removeEventListener('arka:refresh', onRefresh);`, `      window.removeEventListener('arka:refresh', onRefresh);\n      window.removeEventListener('base-ready-bonus:refresh', onRefresh);`, 'LIVE_CARD_REFRESH_CLEANUP');
  source += `\n// ${MARKER}:LIVE_CARD\n`;
  fs.writeFileSync(LIVE_CARD_PATH, source, 'utf8');
  return true;
}

function patchBonusPage() {
  let source = fs.readFileSync(BONUS_PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:BONUS_PAGE`)) return false;
  source += `\n// ${MARKER}:BONUS_PAGE\n`;
  fs.writeFileSync(BONUS_PAGE_PATH, source, 'utf8');
  return true;
}

const changed = [patchClient(), patchEngine(), patchPayService(), patchLiveCard(), patchBonusPage()].filter(Boolean).length;
console.log(`PASS ${MARKER}: ${changed} compatibility patches applied`);
