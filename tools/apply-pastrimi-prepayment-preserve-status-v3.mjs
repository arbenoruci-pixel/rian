import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_PREPAYMENT_PRESERVE_STATUS_V3';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[pastrimi-prepayment-preserve-status-v3] already installed');
  process.exit(0);
}
if (!source.includes('PASTRIMI_PAYMENT_BACKGROUND_V2')) {
  throw new Error('PASTRIMI_PAYMENT_BACKGROUND_V2_REQUIRED');
}

function replaceOnce(oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  source = source.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

replaceOnce(
`    const willSettleFull = remaining <= 0.01;
    const fullPaymentTargetStatus = willSettleFull
      ? askPastrimiPaidPickupTarget({ code: rowPayOrder.code, clientName: rowPayOrder.name })
      : '';
    const pickupNow = willSettleFull && fullPaymentTargetStatus === 'dorzim';
    const destinationLine = willSettleFull
      ? (pickupNow
        ? 'VEPRIMI: KLIENTI I MERR — KALO NË DORZIM'
        : 'VEPRIMI: PAGUAR — MBETET NË PASTRIMI')
      : 'VEPRIMI: PAGESË PARTIALE — MBETET STATUSI AKTUAL';`,
`    const willSettleFull = remaining <= 0.01;
    // ${MARKER}
    // A payment entered from PASTRIMI is an incoming/prepayment action.
    // It must never imply that the cleaned rugs were picked up or move the job
    // to DORZIM. Client pickup is a separate operational action from GATI.
    const fullPaymentTargetStatus = '';
    const pickupNow = false;
    const destinationLine = willSettleFull
      ? 'VEPRIMI: PAGUAR PARAPRAKISHT — MBETET NË PASTRIMI'
      : 'VEPRIMI: PAGESË PARTIALE — MBETET NË PASTRIMI';`,
'force Pastrimi payment to remain cleaning'
);

replaceOnce(
`      isPaid: newDebt <= 0,
      updated_at: actionAt,`,
`      isPaid: newDebt <= 0,
      is_paid_upfront: newDebt <= 0 ? true : !!baseOrder?.is_paid_upfront,
      prepaid_at: newDebt <= 0 ? actionAt : (baseOrder?.prepaid_at || null),
      prepaid_by_pin: newDebt <= 0 ? String(pinData.pin || '') : (baseOrder?.prepaid_by_pin || ''),
      prepaid_by_name: newDebt <= 0 ? String(pinData.name || '') : (baseOrder?.prepaid_by_name || ''),
      updated_at: actionAt,`,
'mark full Pastrimi payment as prepayment'
);

// fullPaymentTargetStatus is now always empty, so both existing optional
// statusOnFullPayment spreads are inert. Keeping them makes this patch
// compatible with the two background payment paths without brittle rewrites.

fs.writeFileSync(PATH, source, 'utf8');
const out = fs.readFileSync(PATH, 'utf8');
for (const token of [
  MARKER,
  "const fullPaymentTargetStatus = '';",
  'const pickupNow = false;',
  'PAGUAR PARAPRAKISHT — MBETET NË PASTRIMI',
  'is_paid_upfront: newDebt <= 0 ? true',
]) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING:${token}`);
}
console.log('PASS Pastrimi payments preserve cleaning status and record prepayment');
