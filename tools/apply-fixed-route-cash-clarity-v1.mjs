import fs from 'node:fs';

const DETAIL_PATH = 'app/arka/puntor/[pin]/page.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const MARKER = 'FIXED_ROUTE_CASH_CLARITY_V1:DETAIL';
const INSTALLER = 'node tools/apply-fixed-route-cash-clarity-v1.mjs';
const TEST_COMMAND = 'npm run test:fixed-route-cash-v1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-fixed-route-cash-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-fixed-route-cash-v1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function patchWorkerDetail() {
  let source = fs.readFileSync(DETAIL_PATH, 'utf8');
  if (source.includes(MARKER)) return;

  source = replaceOnce(
    source,
    "function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0.5 } = {}) {",
    `// ${MARKER}\nfunction buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0 } = {}) {`,
    'cash-row-default-rate',
  );

  source = replaceOnce(
    source,
    `  const cashAccount = useMemo(() => {\n    const allPayments = Array.isArray(payments) ? payments : [];\n    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;`,
    `  const cashAccount = useMemo(() => {\n    const allPayments = Array.isArray(payments) ? payments : [];\n    const cashWorkerIsHybrid = worker?.is_hybrid_transport === true;\n    const commissionRate = cashWorkerIsHybrid ? Math.max(0, n(worker?.commission_rate_m2)) : 0;`,
    'cash-account-fixed-route-rate',
  );

  source = replaceOnce(
    source,
    `  const payrollAccount = useMemo(() => {\n    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;\n    const isHybrid = worker?.is_hybrid_transport === true;`,
    `  const payrollAccount = useMemo(() => {\n    const isHybrid = worker?.is_hybrid_transport === true;\n    const commissionRate = isHybrid ? Math.max(0, n(worker?.commission_rate_m2)) : 0;`,
    'payroll-fixed-route-rate',
  );

  source = replaceOnce(
    source,
    `            <Stat label={\`KOMISION \${workerFirstName.toUpperCase()}\`} value={euro(cashAccount.visibleCommissionHistoryTotal)} tone="warn" />`,
    `            {summary.isHybridTransport ? <Stat label={\`KOMISION \${workerFirstName.toUpperCase()}\`} value={euro(cashAccount.visibleCommissionHistoryTotal)} tone="warn" /> : null}`,
    'hide-fixed-route-commission-stat',
  );

  source = replaceOnce(
    source,
    `                    {row.type === 'TRANSPORT' ? (`,
    `                    {row.type === 'TRANSPORT' && summary.isHybridTransport ? (`,
    'hide-fixed-route-history-commission',
  );

  if (/commission_rate_m2\) > 0 \? n\(worker\?\.commission_rate_m2\) : 0\.5/.test(source)) {
    throw new Error('unsafe 0.5 commission fallback remains');
  }
  fs.writeFileSync(DETAIL_PATH, source, 'utf8');
}

function patchFinalVersionOwner() {
  let source = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(GATI_INSTALLER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const prebuild = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = prebuild.indexOf(gatiInstaller);
  if (gatiIndex >= 0) prebuild.splice(gatiIndex, 0, INSTALLER);
  else prebuild.push(INSTALLER);
  scripts.prebuild = prebuild.join(' && ');
  scripts['test:fixed-route-cash-v1'] = 'node tools/verify-fixed-route-cash-clarity-v1.mjs';

  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('vite build anchor missing');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

patchWorkerDetail();
patchFinalVersionOwner();
patchPackage();
console.log('PASS fixed-route cash clarity V1 installer');
