import fs from 'node:fs';
import { buildPastrimiPaymentDecision, PASTRIMI_PAYMENT_PURPOSE } from '../lib/pastrimiPaymentPurpose.js';

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
const page = fs.readFileSync('app/pastrimi/page.jsx','utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js','utf8');
const migration = fs.readFileSync('supabase/migrations/20260828235006_base_order_cash_payment_atomic_v1.sql','utf8');
check(page.includes('PastrimiPaymentPurposeWizard') && page.includes('paymentOutcome'), 'Pastrimi uses the purpose wizard and outcome');
check(engine.includes("record_base_order_cash_payment_atomic_v1"), 'BASE cash payment uses the atomic RPC');
check(migration.includes('revoke execute') && migration.includes('service_role'), 'RPC execution is service-role only');
check(migration.includes('BASE_PAYMENT_STALE_DEBT') && migration.includes('pg_advisory_xact_lock'), 'RPC protects stale balances and concurrent retries');
if (failures.length) { failures.forEach((x,i)=>console.error(`${i+1}. ${x}`)); process.exit(1); }
console.log('PASS: Pastrimi payment-purpose wizard and atomic BASE payment checks passed.');
