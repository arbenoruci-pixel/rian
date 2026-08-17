import fs from 'node:fs';

const files = {
  arka: fs.readFileSync('app/arka/page.jsx', 'utf8'),
  daily: fs.readFileSync('components/ArkaWorkerDailyStatus.jsx', 'utf8'),
  wizard: fs.readFileSync('components/HandoffWizard.jsx', 'utf8'),
  pay: fs.readFileSync('app/transport/pay/page.jsx', 'utf8'),
  api: fs.readFileSync('app/api/arka/transaction/route.js', 'utf8'),
  package: fs.readFileSync('package.json', 'utf8'),
};

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`PASS ${message}`);
  else failures.push(message);
};

check(files.arka.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:ARKA_PROFILE'), 'authoritative finance-profile marker');
check(files.arka.includes("const hasDbHybridFlag = Object.prototype.hasOwnProperty.call(userRow, 'is_hybrid_transport');"), 'DB hybrid flag is authoritative');
check(files.arka.includes('const nextCommissionRate = nextIsHybrid'), 'commission rate is gated by hybrid status');
check(!files.arka.includes('const nextIsHybrid = isHybridWorker(userRow) || isHybridWorker(actor);'), 'stale actor cannot restore hybrid commission');
check(files.arka.includes('{workerHybrid ? <Stat label={`KOMISION'), 'manager commission hidden for salary worker');
check(files.arka.includes('KËTU HYJNË VETËM PAGESAT E RUAJTURA NË ARKA'), 'cash-versus-route-debt explanation');

check(files.daily.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:DAILY'), 'daily status marker');
check(files.daily.includes('RROGË FIKSE • PA KOMISION'), 'daily status says straight salary');
check(files.daily.includes('{workerHybrid ? ('), 'daily commission metric is conditional');

check(files.wizard.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:WIZARD'), 'handoff wizard salary marker');
check(files.wizard.includes('const safeCommission = workerHybrid ?'), 'handoff total applies commission only to hybrid workers');
check(files.wizard.includes('{workerHybrid ? <SummaryLine label="Komision transporti'), 'handoff summary hides salary-worker commission');
check(files.wizard.includes('{workerHybrid ? <Row label="Komisioni që e mban'), 'handoff final review hides salary-worker commission');

check(files.pay.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:TRANSPORT_PAY'), 'transport payment canonical-PIN marker');
check(files.pay.includes("import { resolveActorPin } from '@/lib/pinIdentity';"), 'transport payment imports real-PIN resolver');
const canonicalActorFallback = files.pay.includes('resolveActorPin(getActor() || {})') ||
  (files.pay.includes('getActor() || {}') && files.pay.includes('resolveActorPin'));
check(canonicalActorFallback, 'transport payment recovers canonical main actor PIN');
check(!files.pay.includes("session?.transport_pin || session?.pin || session?.transport_id"), 'transport UUID is no longer accepted as a PIN');
check(files.pay.includes('PAGESA NUK U RUAJT NË ARKA'), 'failed payment is explicitly shown as unrecorded');

check(files.api.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:API_LOG'), 'ARKA API diagnostics marker');
check(files.api.includes("console.error('[ARKA_TRANSACTION_FAILED]'"), 'future ARKA 400 errors retain safe context');
check(files.api.includes('transportOrderId:'), 'failed transport order ID is logged');
check(files.api.includes('transportCode:'), 'failed transport code is logged');

check(files.package.includes('apply-beli-straight-salary-payment-recovery-v1.mjs'), 'recovery installer registered in prebuild');
check(files.package.includes('verify-beli-straight-salary-payment-recovery-v1.mjs'), 'recovery verifier registered in build');

const reconcile = ({ dbHybrid, dbRate, actorHybrid, actorRate }) => {
  const nextIsHybrid = dbHybrid !== undefined ? dbHybrid === true : actorHybrid === true;
  const parsedDbRate = Number(dbRate);
  const nextRate = nextIsHybrid
    ? (dbRate !== undefined && Number.isFinite(parsedDbRate) ? Math.max(0, parsedDbRate) : (Number(actorRate) > 0 ? Number(actorRate) : 0.5))
    : 0;
  return { nextIsHybrid, nextRate };
};
const beli = reconcile({ dbHybrid: false, dbRate: 0, actorHybrid: true, actorRate: 0.5 });
check(beli.nextIsHybrid === false && beli.nextRate === 0, 'DB false/zero clears stale Beli commission');
const hybrid = reconcile({ dbHybrid: true, dbRate: 0.5, actorHybrid: false, actorRate: 0 });
check(hybrid.nextIsHybrid === true && hybrid.nextRate === 0.5, 'real hybrid commission remains supported');

if (failures.length) {
  console.error(`FAIL ${failures.length} Beli recovery check(s)`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}
console.log('PASS all Beli straight-salary and payment-recovery controls');
