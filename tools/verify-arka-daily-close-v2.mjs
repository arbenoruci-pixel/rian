import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const component = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const dailyPage = fs.readFileSync('app/arka/ditore/page.jsx', 'utf8');
const mainPage = fs.readFileSync('app/arka/page.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-arka-daily-close-v2.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(component.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v3'"), 'daily preview RPC missing');
check(component.includes("const CLOSE_RPC = 'close_arka_day_v2'"), 'daily close RPC missing');
check(component.includes('p_dry_run: true'), 'server dry-run gate missing');
check(component.includes('p_dry_run: false'), 'final atomic close call missing');
check(component.includes('I MORA PARATË'), 'per-worker cash confirmation missing');
check(component.includes('SA PARA I NUMËROVE FIZIKISHT?'), 'physical cash count input missing');
check(component.includes('SHPJEGO DIFERENCËN'), 'daily discrepancy explanation missing');
check(component.includes('MBYLL DITËN DHE BARAZO BUXHETIN'), 'final close action missing');
check(component.includes("navigator.onLine === false"), 'offline close guard missing');
check(component.includes('activeReceiptCycle?.is_closed'), 'closed receipt mode missing');

check(dailyPage.includes("import ArkaDailyCloseWizard from '@/components/ArkaDailyCloseWizard.jsx';"), 'daily route is not canonical wizard wrapper');
check(dailyPage.includes('<ArkaDailyCloseWizard />'), 'daily wizard is not mounted');

check(mainPage.includes('ARKA_DAILY_CLOSE_V2_ONE_WAY'), 'main one-way marker missing');
check(!mainPage.includes('await acceptDispatchHandoff({'), 'direct handoff acceptance call remains in ARKA page');
check(mainPage.includes("window.location.assign('/arka/ditore')"), 'manager acceptance entry points do not route to daily close');
check(mainPage.includes("supabase.rpc('create_arka_advance_atomic_v2'"), 'advance creation does not use canonical atomic RPC');
check(mainPage.includes('HAPE MBYLLJEN DITORE'), 'manager daily-close call to action missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const arkaFinalInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
const rackFinalInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
const hasRackFinalOwner = prebuild.includes(rackFinalInstaller);

check(installer.includes('ARKA_DAILY_CLOSE_V2_ONE_WAY'), 'final installer marker missing');
check(
  hasRackFinalOwner ? prebuild.trim().endsWith(rackFinalInstaller) : prebuild.trim().endsWith(arkaFinalInstaller),
  'neither ARKA nor the compatible GATI rack version owner is last in prebuild',
);
check(prebuild.includes(arkaFinalInstaller), 'ARKA daily-close installer is missing from prebuild');
if (hasRackFinalOwner) {
  check(
    prebuild.lastIndexOf(arkaFinalInstaller) < prebuild.lastIndexOf(rackFinalInstaller),
    'GATI rack version owner does not run after ARKA daily close',
  );
}
check(String(pkg.scripts?.build || '').includes('npm run test:arka-daily-close-v2'), 'daily close verifier is not in full build');
check(String(pkg.scripts?.['test:arka-daily-close-v2'] || '').includes('verify-arka-daily-close-v2.mjs'), 'daily close test script missing');
check(String(pkg.version || '').includes('arka-daily-close-v2'), 'package version not bumped');
// Version-owner installers may extend the cache suffix repeatedly over time. Verify the
// required generations independently so a later compatible suffix cannot make this check self-mutate.
check(
  vite.includes('arka-daily-close-v2') &&
  vite.includes('home-search-base-role-v1') &&
  vite.includes('gati-rack-save-v1') &&
  vite.includes('pastrimi-payment-touch-v3') &&
  vite.includes('unified-arka-payroll-v1'),
  'PWA cache generation not bumped compatibly',
);
if (hasRackFinalOwner) {
  check(vite.includes('gati-rack-save-v1'), 'GATI rack cache generation missing after ARKA');
  check(/sw-navigation-diag\.js\?v=351[2-9]/.test(vite), 'service worker import generation not bumped for rack save');
} else {
  check(vite.includes('sw-navigation-diag.js?v=3510'), 'service worker import generation not bumped');
}
check(epoch.includes('arka-daily-close-v2'), 'runtime app version not bumped');
check(index.includes('arka-daily-close-v2'), 'HTML build identity not bumped');

if (failures.length) {
  console.error(`FAIL ARKA daily close V2: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS ARKA daily close V2: one-way handoff acceptance, automatic advance OUT, server dry-run, physical cash reconciliation, audited discrepancy, and compatible final version owners are wired.');
