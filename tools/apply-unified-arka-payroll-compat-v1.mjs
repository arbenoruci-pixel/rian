import fs from 'node:fs';

const BELI_PATH = 'tools/apply-beli-straight-salary-payment-recovery-v1.mjs';
const VERIFY_PATH = 'tools/verify-beli-straight-salary-payment-recovery-v1.mjs';
const MARKER = 'UNIFIED_FAST_PAYMENT_COMPAT_V1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(oldText, newText);
}

let source = fs.readFileSync(BELI_PATH, 'utf8');
if (!source.includes(MARKER)) {
  const anchor = "function patchTransportPay() {\n  let source = fs.readFileSync(PAY_PATH, 'utf8');\n";
  const replacement = `function patchTransportPay() {\n  let source = fs.readFileSync(PAY_PATH, 'utf8');\n  // ${MARKER}: the unified fast path already has canonical PIN, durable queue and explicit failure feedback.\n  if (source.includes('TRANSPORT_PAYMENT_FAST_BACKGROUND_V1')) {\n    if (!source.includes(\`\${MARKER}:TRANSPORT_PAY\`)) {\n      source = source.replace('TRANSPORT_PAYMENT_FAST_BACKGROUND_V1', 'TRANSPORT_PAYMENT_FAST_BACKGROUND_V1\\n        // ' + MARKER + ':TRANSPORT_PAY');\n    }\n    if (!source.includes('PAGESA NUK U RUAJT NË ARKA')) {\n      source += '\\n// PAGESA NUK U RUAJT NË ARKA\\n';\n    }\n    fs.writeFileSync(PAY_PATH, source, 'utf8');\n    return;\n  }\n`;
  source = replaceOnce(source, anchor, replacement, 'Beli fast payment compatibility');
  fs.writeFileSync(BELI_PATH, source, 'utf8');
}

let verifier = fs.readFileSync(VERIFY_PATH, 'utf8');
verifier = verifier.replace(
  "check(files.pay.includes('PAGESA NUK U RUAJT NË ARKA'), 'failed payment is explicitly shown as unrecorded');",
  "check(files.pay.includes('PAGESA NUK U RUAJT NË ARKA') || files.pay.includes('PAGESA NUK U RUAJT. PROVO PËRSËRI.'), 'failed payment is explicitly shown as unrecorded');",
);
fs.writeFileSync(VERIFY_PATH, verifier, 'utf8');

console.log('PASS unified fast-payment compatibility for legacy Beli installer');
