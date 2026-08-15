import fs from 'node:fs';

const page = fs.readFileSync('app/arka/ditore/page.jsx', 'utf8');
const arka = fs.readFileSync('app/arka/page.jsx', 'utf8');
const routes = fs.readFileSync('src/generated/routes.generated.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const isCanonicalCloseV2 = page.includes('ArkaDailyCloseWizard');

if (isCanonicalCloseV2) {
  const wizard = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
  check(wizard.includes("get_arka_daily_close_preview_v3"), 'Canonical daily preview RPC missing');
  check(wizard.includes("close_arka_day_v2"), 'Canonical daily close RPC missing');
  check(wizard.includes('p_actor_pin:'), 'Actor PIN not passed to canonical RPC');
  check(wizard.includes('p_date: date'), 'Current business date not passed to canonical RPC');
  check(wizard.includes('MANAGER_ROLES'), 'Dispatch/Admin UI guard missing');
  check(wizard.includes("navigator.onLine === false"), 'Offline close guard missing');
  check(wizard.includes('writeCache'), 'Offline preview cache write missing');
  check(wizard.includes('readCache'), 'Offline preview cache read missing');
  check(wizard.includes('SNAPSHOT LOKAL'), 'Offline snapshot notice missing');
  check(wizard.includes('BUXHETI PARA MBYLLJES'), 'Opening budget metric missing');
  check(wizard.includes('DORËZIME TË ZGJEDHURA'), 'Handoff total metric missing');
  check(wizard.includes('SHPENZIME TË POSTUARA'), 'Expense total metric missing');
  check(wizard.includes('AVANSE TË POSTUARA'), 'Advance total metric missing');
  check(wizard.includes('SA PARA I NUMËROVE FIZIKISHT?'), 'Physical cash metric missing');
  check(wizard.includes('SHPJEGO DIFERENCËN'), 'Discrepancy control missing');
  check(wizard.includes('GJURMA E MBYLLJES'), 'Closed-day audit receipt missing');
  check(wizard.includes('PARA ENDE TE PUNËTORËT'), 'Open worker cash section missing');
  check(wizard.includes('TASHMË TË PRANUARA SOT'), 'Already-received section missing');
  check(wizard.includes('KONTROLLO DORËZIMET'), 'Per-worker handoff control missing');
  check(wizard.includes('KONTROLLO DALJET NGA BOXHI'), 'Daily outflow control missing');
  check(wizard.includes('KONTROLLO NË SERVER'), 'Server dry-run control missing');
  check(wizard.includes('MBYLL DITËN DHE BARAZO BUXHETIN'), 'Final close control missing');
  check(wizard.includes('p_dry_run: true'), 'Dry-run request missing');
  check(wizard.includes('p_dry_run: false'), 'Final atomic request missing');
  check(arka.includes('ARKA_DAILY_CONTROL_V1:ARKA'), 'ARKA daily entry marker missing');
  check(arka.includes('to="/arka/ditore"'), 'ARKA daily entry link missing');
  check(arka.includes('HAPE MBYLLJEN DITORE'), 'Canonical ARKA daily entry label missing');
} else {
  check(page.includes("const RPC_NAME = 'get_dispatch_daily_control_v1'"), 'Daily page RPC missing');
  check(page.includes("supabase.rpc(RPC_NAME"), 'Daily page does not call RPC');
  check(page.includes('p_actor_pin: pin'), 'Actor PIN not passed to RPC');
  check(page.includes('p_date: dateKey'), 'Selected date not passed to RPC');
  check(page.includes("upper(actor?.role) !== 'DISPATCH'"), 'Dispatch-only UI guard missing');
  check(page.includes('DISPATCH_ONLY'), 'Dispatch-only RPC error handling missing');
  check(page.includes('AUTO_REFRESH_MS = 60_000'), 'Automatic 60-second refresh missing');
  check(page.includes("window.addEventListener('online'"), 'Online recovery listener missing');
  check(page.includes("document.addEventListener('visibilitychange'"), 'Visibility refresh missing');
  check(page.includes('writeCachedReport'), 'Offline report cache write missing');
  check(page.includes('readCachedReport'), 'Offline report cache read missing');
  check(page.includes('SNAPSHOT LOKAL'), 'Offline snapshot notice missing');
  check(page.includes('HYRJE TOTAL'), 'Incoming total card missing');
  check(page.includes('DALJE TOTAL'), 'Outgoing total card missing');
  check(page.includes('NETO M²'), 'Net m2 card missing');
  check(page.includes('CASH NGA KLIENTET'), 'Client cash metric missing');
  check(page.includes('HYRI NE BUXHET'), 'Ledger IN metric missing');
  check(page.includes('DOLI NGA BUXHETI'), 'Ledger OUT metric missing');
  check(page.includes('BUXHETI AKTUAL'), 'Current budget metric missing');
  check(page.includes('KOMISIONET E TRANSPORTIT'), 'Commission section missing');
  check(page.includes('GJENDJA AKTUALE E DEPOSE'), 'Current depot section missing');
  check(page.includes('KONTROLLI AUTOMATIK / ALARMET'), 'Automatic alerts section missing');
  check(page.includes('Kjo faqe eshte vetem lexim'), 'Read-only notice missing');
  check(arka.includes('HAPE PAMJEN DITORE'), 'ARKA daily entry label missing');
}

check(routes.includes('ARKA_DAILY_CONTROL_V1:ROUTES'), 'Daily route marker missing');
check(routes.includes("import ArkaDitorePageEager from '@/app/arka/ditore/page.jsx'"), 'Daily eager import missing');
check(routes.includes("{ path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') }"), 'Daily route missing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} ARKA daily control compatibility check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log(isCanonicalCloseV2
  ? 'PASS: ARKA daily-control compatibility verified against canonical one-way close V2.'
  : 'PASS: legacy ARKA daily control checks passed.');
