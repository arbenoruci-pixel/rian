import fs from 'node:fs';
import { buildPastrimiPaymentDecision, buildPastrimiPaymentPinLabel, PASTRIMI_PAYMENT_PURPOSE } from '../lib/pastrimiPaymentPurpose.js';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`PASS ${label}`); };
const prepay = buildPastrimiPaymentDecision({ due: 40, cashGiven: 20, purpose: PASTRIMI_PAYMENT_PURPOSE.PREPAY });
const fullPrepay = buildPastrimiPaymentDecision({ due: 40, cashGiven: 50, purpose: PASTRIMI_PAYMENT_PURPOSE.PREPAY });
const pickup = buildPastrimiPaymentDecision({ due: 40, cashGiven: 40, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW });
const partialPickup = buildPastrimiPaymentDecision({ due: 40, cashGiven: 39.99, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW });
const decimal = buildPastrimiPaymentDecision({ due: 0.3, cashGiven: 0.1 + 0.2, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW });
check(prepay.ok && prepay.remaining === 20 && prepay.statusOnFullPayment === 'pastrim', 'partial prepayment stays in Pastrimi');
check(fullPrepay.ok && fullPrepay.applied === 40 && fullPrepay.change === 10, 'full prepayment handles change and stays in Pastrimi');
check(pickup.ok && pickup.pickupNow && pickup.statusOnFullPayment === 'dorzim', 'full pickup moves to Dorzim');
check(!partialPickup.ok && partialPickup.error === 'PICKUP_REQUIRES_FULL_PAYMENT', 'pickup blocks even one cent of debt');
check(decimal.ok && decimal.remaining === 0, 'payment math is cent-safe');
check(buildPastrimiPaymentDecision({due:40,cashGiven:40}).error === 'PAYMENT_PURPOSE_REQUIRED', 'purpose is mandatory');
const pinLabel = buildPastrimiPaymentPinLabel({
  code: '913',
  decision: buildPastrimiPaymentDecision({ due: 20.67, cashGiven: 20.67, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW }),
  destinationLine: 'VEPRIMI: KLIENTI I MERR — KALO NË DORZIM',
});
check(pinLabel.includes('KODI: 913') && pinLabel.includes('KLIENTI DHA: 20.67€') && pinLabel.includes('BORXHI I KLIENTIT PAS: 0.00€'), 'purpose choice builds the PIN prompt without an undefined cash amount');
const prepayPinLabel = buildPastrimiPaymentPinLabel({
  code: '913',
  decision: buildPastrimiPaymentDecision({ due: 20.67, cashGiven: 10, purpose: PASTRIMI_PAYMENT_PURPOSE.PREPAY }),
  destinationLine: 'VEPRIMI: PAGESË PARTIALE — MBETET NË PASTRIMI',
});
check(prepayPinLabel.includes('KLIENTI DHA: 10.00€') && prepayPinLabel.includes('BORXHI I KLIENTIT PAS: 10.67€'), 'prepay choice also builds the PIN prompt and keeps the remaining debt');
const page = fs.readFileSync('app/pastrimi/page.jsx','utf8');
const wizard = fs.readFileSync('components/PastrimiPaymentPurposeWizard.jsx','utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js','utf8');
const migration = fs.readFileSync('supabase/migrations/20260828235006_base_order_cash_payment_atomic_v1.sql','utf8');
check(page.includes('PastrimiPaymentPurposeWizard') && page.includes('paymentOutcome'), 'Pastrimi uses the purpose wizard and outcome');
check(page.includes('buildPastrimiPaymentPinLabel({') && page.includes('[PASTRIMI_PAYMENT_PURPOSE_CHOICE_FAILED]'), 'wizard choice uses the tested PIN label and exposes handler failures');
check(wizard.includes('zIndex:100600') && wizard.includes("touchAction:'manipulation'"), 'purpose wizard stays above global controls and has an iPhone-safe touch target');
check(wizard.includes('onPointerUp:') && wizard.includes('onTouchEnd:') && wizard.includes('activationRef'), 'pointer, touch and click activation are deduplicated');
check(page.includes('paymentPurposeBusyRef.current = false;') && page.includes('setPaymentPurposeBusy(false);'), 'each wizard opening can recover from stale busy state');
check(engine.includes("record_base_order_cash_payment_atomic_v1"), 'BASE cash payment uses the atomic RPC');
check(migration.includes('revoke execute') && migration.includes('service_role'), 'RPC execution is service-role only');
check(migration.includes('BASE_PAYMENT_STALE_DEBT') && migration.includes('pg_advisory_xact_lock'), 'RPC protects stale balances and concurrent retries');
if (failures.length) { failures.forEach((x,i)=>console.error(`${i+1}. ${x}`)); process.exit(1); }
console.log('PASS: Pastrimi payment-purpose wizard and atomic BASE payment checks passed.');
