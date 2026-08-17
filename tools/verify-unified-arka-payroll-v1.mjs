import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const unified = fs.readFileSync('components/ArkaUnifiedWorkerAccount.jsx', 'utf8');
const compensation = fs.readFileSync('components/WorkerCompensationEditor.jsx', 'utf8');
const arka = fs.readFileSync('app/arka/page.jsx', 'utf8');
const detail = fs.readFileSync('app/arka/puntor/[pin]/page.jsx', 'utf8');
const staff = fs.readFileSync('app/arka/stafi/page.jsx', 'utf8');
const payroll = fs.readFileSync('app/arka/payroll/page.jsx', 'utf8');
const payrollLib = fs.readFileSync('lib/payrollMonthClose.js', 'utf8');
const transportPay = fs.readFileSync('app/transport/pay/page.jsx', 'utf8');
const beliInstaller = fs.readFileSync('tools/apply-beli-straight-salary-payment-recovery-v1.mjs', 'utf8');
const beliVerifier = fs.readFileSync('tools/verify-beli-straight-salary-payment-recovery-v1.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const installer = fs.readFileSync('tools/apply-unified-arka-payroll-v1.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(unified.includes('UNIFIED_WORKER_FINANCE_UI_V1'), 'canonical worker-finance component marker missing');
check(unified.includes("supabase.rpc('get_worker_finance_snapshot_v1'"), 'canonical snapshot RPC missing');
check(unified.includes('PAGUAR SOT'), 'today cash metric missing');
check(unified.includes('MBETUR NGA MË HERËT'), 'carryover metric missing');
check(unified.includes('i njëjti listim për punëtorin dhe adminin'), 'shared-view explanation missing');
check(unified.includes('PAYROLL I LIDHUR ME STAFIN'), 'linked payroll block missing');
check(unified.includes('MBYLLJA DITORE'), 'manager daily-close link missing from shared account');

check(compensation.includes('WORKER_COMPENSATION_EDITOR_V1'), 'compensation editor marker missing');
check(compensation.includes("supabase.rpc('get_worker_compensation_profile_v1'"), 'compensation profile read missing');
check(compensation.includes("supabase.rpc('save_worker_compensation_profile_v1'"), 'compensation profile save missing');
check(compensation.includes('RROGË FIKSE'), 'salary checkbox missing');
check(compensation.includes('USHQIM / SHTESË MUJORE'), 'meal checkbox missing');
check(compensation.includes('BONUS TRANSPORTI'), 'transport bonus checkbox missing');
check(compensation.includes('KOMISION PËR m²'), 'commission checkbox missing');
check(compensation.includes('BONUSI I BAZËS 72H'), 'base bonus checkbox missing');
check(compensation.includes('RUAJ DHE SINKRONIZO KUDO'), 'single save action missing');

check(arka.includes("import ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';"), 'ARKA main canonical import missing');
check(arka.includes('onSnapshot={setUnifiedWorkerFinance}'), 'ARKA main does not receive canonical snapshot');
check(arka.includes('unifiedWorkerFinance?.cash?.open_due_to_base'), 'ARKA handoff amount is not canonical');
check(arka.includes('unifiedWorkerFinance?.profile?.ready_bonus_enabled === true'), 'ARKA ready bonus is not profile-gated');
check(arka.includes('href="/arka/ditore"'), 'ARKA daily close route missing');

check(detail.includes("import ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';"), 'admin detail canonical import missing');
check(detail.includes('<ArkaUnifiedWorkerAccount actor={actor} targetPin={pin}'), 'admin detail canonical render missing');
check(detail.includes("style={{ display:'none' }} aria-hidden=\"true\">"), 'admin duplicate finance view is not hidden');
check(!detail.includes("n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5"), 'unsafe admin commission fallback remains');
check(detail.includes('href="/arka/ditore"'), 'admin detail daily close link missing');

check(staff.includes("import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';"), 'staff compensation editor import missing');
check(staff.includes('<WorkerCompensationEditor'), 'staff compensation editor render missing');
check(staff.includes('PUNTORI U KRIJUA. TASH DEFINO OPSIONET E PAGESËS'), 'new-worker guided compensation step missing');
check(staff.includes("pay_cash_mode: ['PUNTOR','TRANSPORT']"), 'new-worker safe cash mode missing');
check(staff.includes('Mënyra e cash-it:'), 'staff card compensation summary missing');
check(staff.includes('href="/arka/ditore"'), 'staff daily close link missing');

check(payrollLib.includes('UNIFIED_ARKA_PAYROLL_V1:PROFILE_FORMULA'), 'payroll explicit-profile formula missing');
check(payrollLib.includes('const gross = baseSalary + bonusTransport + bonusUshqim;'), 'payroll fixed bonuses are not included in gross');
check(payrollLib.includes("worker?.pay_commission_enabled === true && up(worker?.pay_cash_mode) === 'HYBRID_COMMISSION'"), 'payroll commission is not explicit/hybrid-only');
check(!payrollLib.includes("n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5"), 'payroll unsafe commission fallback remains');

check(payroll.includes("import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';"), 'payroll compensation editor import missing');
check(payroll.includes('<WorkerCompensationEditor'), 'payroll compensation editor render missing');
check(payroll.includes('const grossFixed = baseSalary + mealBonus + transportBonus;'), 'salary modal does not use fixed compensation components');
check(payroll.includes('salaryModal.grossFixed'), 'salary payment does not use linked gross fixed amount');
check(payroll.includes('href="/arka/ditore"'), 'payroll daily close link missing');

check(transportPay.includes('TRANSPORT_PAYMENT_FAST_BACKGROUND_V1'), 'fast transport payment marker missing');
check(transportPay.includes('timeoutMs: 1400'), 'fast bounded payment timeout missing');
check(transportPay.includes('maxAttempts: 1'), 'payment fast path still waits through retries');
check(transportPay.includes('queueOnNetworkFailure: true'), 'durable background queue missing');
check(transportPay.includes("window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'))"), 'background sync trigger missing');
check(transportPay.includes("router.push('/transport/board?paymentSync=1')"), 'immediate queued-payment navigation missing');
check(transportPay.includes('resolveActorPin(getActor() || {})'), 'canonical worker PIN recovery missing');
check(!transportPay.includes('session?.transport_pin || session?.pin || session?.transport_id'), 'transport UUID is still accepted as PIN');

check(beliInstaller.includes('UNIFIED_ARKA_PAYROLL_COMPAT_V1'), 'legacy Beli installer compatibility missing');
check(beliVerifier.includes("files.daily.includes('{isFixedRouteTransport ? (')"), 'legacy Beli verifier compatibility missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';
const gatiInstallerCmd = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(unifiedInstaller), 'unified installer missing from prebuild');
check(prebuild.lastIndexOf(arkaInstaller) < prebuild.lastIndexOf(unifiedInstaller), 'unified installer must run after ARKA installer');
check(prebuild.lastIndexOf(unifiedInstaller) < prebuild.lastIndexOf(gatiInstallerCmd), 'unified installer must run before final GATI version owner');
check(prebuild.trim().endsWith(gatiInstallerCmd), 'GATI final owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:unified-arka-payroll-v1'), 'unified verifier missing from full build');
check(String(pkg.version || '').includes('unified-arka-payroll-v1'), 'package build version missing unified suffix');
check(gatiInstaller.includes('unified-arka-payroll-v1'), 'GATI final owner can overwrite unified build identity');
check(gatiInstaller.includes('unifiedInstaller'), 'GATI installer does not preserve final installer order');
check(vite.includes('unified-arka-payroll-v1'), 'PWA cache generation missing unified suffix');
check(index.includes('unified-arka-payroll-v1'), 'HTML build identity missing unified suffix');
check(installer.includes('UNIFIED_ARKA_PAYROLL_V1'), 'installer marker missing');

const today = [13.32, 9.00, 6.66, 33.30, 28.44, 16.74].reduce((a,b) => a+b,0);
const carryover = [18.72,14.76].reduce((a,b) => a+b,0);
check(Math.abs(today - 107.46) < 0.001, 'Blerim today fixture does not equal 107.46');
check(Math.abs(carryover - 33.48) < 0.001, 'Blerim carryover fixture does not equal 33.48');
check(Math.abs(today + carryover - 140.94) < 0.001, 'Blerim canonical handoff fixture does not equal 140.94');

if (failures.length) {
  console.error(`FAIL unified ARKA + payroll V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS unified ARKA + payroll V1: one DB snapshot, shared worker/admin view, explicit compensation flags, linked payroll and fast durable transport payment are wired.');
