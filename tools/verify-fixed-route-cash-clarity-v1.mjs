import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const daily = fs.readFileSync('components/ArkaWorkerDailyStatus.jsx', 'utf8');
const bonus = fs.readFileSync('components/ReadyBonusLiveCard.jsx', 'utf8');
const detail = fs.readFileSync('app/arka/puntor/[pin]/page.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-fixed-route-cash-clarity-v1.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(daily.includes('FIXED_ROUTE_CASH_CLARITY_V1'), 'daily fixed-route marker missing');
check(daily.includes("const OPEN_CASH_STATUSES = new Set(['PENDING', 'COLLECTED'])"), 'open-cash status boundary missing');
check(daily.includes("from('arka_pending_payments')"), 'live payment query missing');
check(daily.includes("from('users')"), 'live finance profile query missing');
check(daily.includes("profileRole === 'TRANSPORT' && hybridFlag !== true"), 'fixed-route identity rule missing');
check(daily.includes('MBETUR NGA MË HERËT'), 'carryover metric missing');
check(daily.includes('KREJT CASH-I I PA DORËZUAR'), 'all-open-cash label missing');
check(daily.includes('RRUGË FIKSE • PA KOMISION • PA BONUS'), 'fixed-route no-commission/no-bonus notice missing');
check(daily.includes('TOTALI QË DUHET ME DORËZU'), 'explicit total handoff formula missing');
check(daily.includes('paymentActivityRows'), 'today payment list missing');
check(daily.includes('window.setInterval(load, 15000)'), 'live 15-second refresh missing');

check(bonus.includes('FIXED_ROUTE_CASH_CLARITY_V1'), 'bonus eligibility marker missing');
check(bonus.includes("const eligible = manager || role !== 'TRANSPORT';"), 'transport bonus card is not hidden');
check(bonus.includes('if (!eligible || !pin'), 'ineligible bonus card still renders');

check(detail.includes('FIXED_ROUTE_CASH_CLARITY_V1:DETAIL'), 'worker detail marker missing');
check(detail.includes('commissionRateM2 = 0 } = {})'), 'cash row still defaults to commission');
check(detail.includes('cashWorkerIsHybrid ? Math.max(0, n(worker?.commission_rate_m2)) : 0'), 'cash account does not enforce hybrid-only commission');
check(detail.includes('const commissionRate = isHybrid ? Math.max(0, n(worker?.commission_rate_m2)) : 0;'), 'payroll does not enforce hybrid-only commission');
check(!detail.includes("n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5"), 'unsafe 0.5 commission fallback remains');
check(detail.includes('summary.isHybridTransport ? <Stat label={`KOMISION'), 'fixed-route commission card still visible');
check(detail.includes("row.type === 'TRANSPORT' && summary.isHybridTransport"), 'fixed-route history still presents commission');

const prebuild = String(pkg.scripts?.prebuild || '');
const fixedInstaller = 'node tools/apply-fixed-route-cash-clarity-v1.mjs';
const gatiFinalInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(fixedInstaller), 'fixed-route installer missing from prebuild');
check(prebuild.includes(gatiFinalInstaller), 'GATI final version owner missing');
check(prebuild.lastIndexOf(fixedInstaller) < prebuild.lastIndexOf(gatiFinalInstaller), 'fixed-route installer must run before GATI final owner');
check(prebuild.trim().endsWith(gatiFinalInstaller), 'GATI final owner must remain last for compatibility');
check(String(pkg.scripts?.build || '').includes('npm run test:fixed-route-cash-v1'), 'fixed-route verifier missing from full build');
check(String(pkg.version || '').includes('fixed-route-cash-v1'), 'package version missing fixed-route suffix');
check(gatiInstaller.includes('fixed-route-cash-v1'), 'final GATI version owner can overwrite fixed-route build id');
check(vite.includes('fixed-route-cash-v1'), 'PWA cache generation missing fixed-route suffix');
check(index.includes('fixed-route-cash-v1'), 'HTML build id missing fixed-route suffix');
check(installer.includes('FIXED_ROUTE_CASH_CLARITY_V1:DETAIL'), 'installer detail marker missing');

if (failures.length) {
  console.error(`FAIL fixed-route cash clarity V1: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS fixed-route cash clarity V1: today, carryover and total handoff are separated; transport bonus is hidden; commission is hybrid-only.');
