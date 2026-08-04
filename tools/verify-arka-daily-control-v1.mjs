import fs from 'node:fs';

const page = fs.readFileSync('app/arka/ditore/page.jsx', 'utf8');
const arka = fs.readFileSync('app/arka/page.jsx', 'utf8');
const routes = fs.readFileSync('src/generated/routes.generated.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

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
check(page.includes('LISTA BAZA'), 'Base incoming detail missing');
check(page.includes('LISTA TRANSPORT'), 'Transport incoming detail missing');
check(page.includes('DALJET BAZA'), 'Base outgoing detail missing');
check(page.includes('DALJET TRANSPORT'), 'Transport outgoing detail missing');
check(page.includes('PAGESAT E KLIENTEVE'), 'Client payment detail missing');
check(page.includes('LEVIZJET E LEDGER-IT'), 'Ledger detail missing');
check(page.includes('type="date"'), 'Date picker missing');
check(page.includes('setDateKey((d) => addDays(d, -1))'), 'Previous-day navigation missing');
check(page.includes('setDateKey((d) => addDays(d, 1))'), 'Next-day navigation missing');
check(page.includes('setDateKey(todayKey)'), 'Today shortcut missing');
check(page.includes('Kjo faqe eshte vetem lexim'), 'Read-only notice missing');

check(arka.includes('ARKA_DAILY_CONTROL_V1:ARKA'), 'ARKA daily entry marker missing');
check(arka.includes('to="/arka/ditore"'), 'ARKA daily entry link missing');
check(arka.includes('HAPE PAMJEN DITORE'), 'ARKA daily entry label missing');
check(routes.includes('ARKA_DAILY_CONTROL_V1:ROUTES'), 'Daily route marker missing');
check(routes.includes("import ArkaDitorePageEager from '@/app/arka/ditore/page.jsx'"), 'Daily eager import missing');
check(routes.includes("{ path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') }"), 'Daily route missing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} ARKA daily control check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 39 ARKA daily control checks passed.');
