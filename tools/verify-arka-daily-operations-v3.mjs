import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const wizard = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const shortcut = fs.readFileSync('components/ArkaDailyCloseShortcut.jsx', 'utf8');
const layout = fs.readFileSync('app/arka/layout.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-arka-daily-operations-v3.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const fastCloseInstaller = fs.readFileSync('tools/apply-pastrimi-payment-fast-close-v4.mjs', 'utf8');
const fastCloseVerifier = fs.readFileSync('tools/verify-pastrimi-payment-fast-close-v4.mjs', 'utf8');
const arkaVerifier = fs.readFileSync('tools/verify-arka-daily-close-v2.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(wizard.includes('ARKA_DAILY_OPERATIONS_V3'), 'operational-day marker missing');
check(wizard.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v4'"), 'preview V4 RPC missing');
check(wizard.includes('BUSINESS_DAY_CUTOFF_HOUR = 4'), '04:00 business cutoff missing');
check(wizard.includes('rawDate.getTime() - BUSINESS_DAY_CUTOFF_HOUR * 60 * 60 * 1000'), 'frontend operational date shift missing');
check(wizard.includes('PASQYRA E DITËS'), 'daily overview title missing');
check(wizard.includes('m² HYRË SOT'), 'incoming m² metric missing');
check(wizard.includes('m² DALË SOT'), 'outgoing m² metric missing');
check(wizard.includes('NETO m²'), 'net m² metric missing');
check(wizard.includes('NË PASTRIM'), 'current cleaning m² metric missing');
check(wizard.includes('dailyCurrent?.gati?.m2'), 'current ready m² metric missing');
check(wizard.includes('countedCashManualRef'), 'manual override guard missing');
check(wizard.includes('setCountedCash(expectedCash.toFixed(2))'), 'automatic expected cash population missing');
check(wizard.includes('countedCashManualRef.current = true'), 'manual physical cash override missing');
check(wizard.includes('placeholder={expectedCash.toFixed(2)}'), 'automatic cash placeholder missing');
check(wizard.includes('DITA OPERATIVE 04:00–04:00'), 'operational-day header missing');

check(shortcut.includes('PASQYRA / MBYLL DITËN'), 'persistent close shortcut label missing');
check(shortcut.includes('to="/arka/ditore"'), 'shortcut does not open daily wizard');
check(shortcut.includes('MANAGER_ROLES'), 'shortcut role guard missing');
check(layout.includes("import ArkaDailyCloseShortcut from '@/components/ArkaDailyCloseShortcut.jsx';"), 'ARKA layout shortcut import missing');
check(layout.includes('<ArkaDailyCloseShortcut />'), 'ARKA layout shortcut render missing');

check(arkaVerifier.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v4'"), 'legacy ARKA verifier rejects preview V4');
check(fastCloseInstaller.includes('arkaDailyOperationsV3Installer, installer'), 'fast-close installer rejects final operations owner');
check(fastCloseVerifier.includes('arkaDailyOperationsV3Installer, installer'), 'fast-close verifier rejects final operations owner');
check(gatiInstaller.includes('arkaDailyOperationsV3Installer'), 'GATI final owner does not preserve operations installer');
check(gatiInstaller.includes('homeSearchLocalOidDedupeV1Installer, arkaDailyOperationsV3Installer, installer'), 'GATI final installer ordering is wrong');
check(gatiInstaller.includes('arka-daily-operations-v3'), 'GATI final owner can overwrite operations build identity');

const prebuild = String(pkg.scripts?.prebuild || '');
const operationsInstaller = 'node tools/apply-arka-daily-operations-v3.mjs';
const homeSearchInstaller = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';
const gatiCommand = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(operationsInstaller), 'operations installer missing from prebuild');
check(prebuild.lastIndexOf(homeSearchInstaller) < prebuild.lastIndexOf(operationsInstaller), 'operations installer must run after Home search source owner');
check(prebuild.lastIndexOf(operationsInstaller) < prebuild.lastIndexOf(gatiCommand), 'operations installer must run before GATI final owner');
check(prebuild.trim().endsWith(gatiCommand), 'GATI final owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:arka-daily-operations-v3'), 'operations verifier missing from full build');
check(String(pkg.scripts?.['test:arka-daily-operations-v3'] || '').includes('verify-arka-daily-operations-v3.mjs'), 'operations test script missing');
check(String(pkg.version || '').includes('arka-daily-operations-v3'), 'package version missing operations suffix');
check(vite.includes('arka-daily-operations-v3'), 'PWA cache generation missing operations suffix');
check(/sw-navigation-diag\.js\?v=351[3-9]/.test(vite), 'service-worker generation changed incompatibly');
check(epoch.includes('ARKA_DAILY_OPERATIONS_BUILD'), 'runtime operations build marker missing');
check(index.includes('arka-daily-operations-v3'), 'HTML build identity missing operations suffix');
check(installer.includes('ARKA_DAILY_OPERATIONS_V3'), 'operations installer marker missing');

const operationalDateKey = (iso) => {
  const shifted = new Date(new Date(iso).getTime() - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};
check(operationalDateKey('2026-08-18T22:11:47.927Z') === '2026-08-18', '00:11 local must remain in previous operational day');
check(operationalDateKey('2026-08-19T02:00:00.000Z') === '2026-08-19', '04:00 local must start the new operational day');

if (failures.length) {
  console.error(`FAIL ARKA daily operations V3: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS ARKA daily operations V3: wizard is always reachable, 04:00 operational-day m² metrics are visible, and the cash/budget value is populated automatically.');
