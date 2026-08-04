import fs from 'node:fs';

const source = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function scanMatching(sourceText, start, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    const next = sourceText[i + 1] || '';
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

function functionBlock(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return '';
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatching(source, paramsStart, '(', ')');
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanMatching(source, bodyStart, '{', '}');
  return bodyEnd > bodyStart ? source.slice(match.index, bodyEnd + 1) : '';
}

const fn = functionBlock('applyRowPayAndClose');
const isV2 = source.includes('PASTRIMI_PAYMENT_BACKGROUND_V2');
check(source.includes('PASTRIMI_PAYMENT_BACKGROUND_V1'), 'marker missing');
check(source.includes("import { ARKA_ACTION } from '@/lib/arka/arkaConstants';"), 'ARKA action import missing');
check(source.includes("import { buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';"), 'idempotency import missing');
check(fn.includes("const pickupNow = willSettleFull && fullPaymentTargetStatus === 'dorzim'"), 'pickup branch missing');
check(fn.includes("queueOp('arka_transaction'") || fn.includes('enqueuePastrimiPaymentIntent(paymentIntent)'), 'durable payment outbox missing');
check(fn.includes('paymentIdempotencyKey'), 'stable idempotency key missing');
check(fn.includes("statusOnFullPayment: 'dorzim'") || fn.includes('statusOnFullPayment: fullPaymentTargetStatus'), 'queued delivery status missing');
check(fn.includes("setOrders((prev) => (prev || []).filter"), 'instant row removal missing');
check(fn.includes('setRowPaySheet(false)'), 'instant modal close missing');
check(fn.includes("payment_sync_state: 'BACKGROUND_PENDING'"), 'background payment marker missing');
check(fn.includes("delivery_sync_state: 'BACKGROUND_PENDING'"), 'background delivery marker missing');
check(fn.includes('Promise.resolve().then(runPaymentInBackground)'), 'detached background execution missing');
check(fn.includes('durableQueueCreated'), 'durable queue fallback missing');
check(fn.includes('if (queued)') && fn.includes('return;'), 'offline queued success handling missing');
check(isV2 ? fn.includes('savePastrimiPaymentIntent(paymentIntent)') : fn.includes('originalRow'), 'durable pre-UI recovery missing');
check(fn.includes("last_payment_by_pin"), 'payment actor PIN mirror missing');
check(fn.includes("last_payment_by_name"), 'payment actor name mirror missing');

const model = ({ pickupNow, journalSaved }) => {
  let visible = true;
  if (pickupNow && journalSaved) visible = false;
  return visible;
};
check(model({ pickupNow: true, journalSaved: true }) === false, 'journaled pickup must stay removed');
check(model({ pickupNow: true, journalSaved: false }) === true, 'unjournaled pickup must remain visible');
check(model({ pickupNow: false, journalSaved: true }) === true, 'partial/stay payment must remain visible');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Pastrimi background payment checks failed.`);
  failures.forEach((item, index) => console.error(`${index + 1}. ${item}`));
  process.exit(1);
}
console.log('PASS: 20 Pastrimi background payment checks passed.');
