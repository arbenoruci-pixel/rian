import fs from 'node:fs';

const homeSearch = fs.readFileSync('lib/homeSearch.js', 'utf8');
const homePage = fs.readFileSync('app/page.jsx', 'utf8');
const globalSearch = fs.readFileSync('components/GlobalHomeSearch.jsx', 'utf8');
const transportItem = fs.readFileSync('app/transport/item/page.jsx', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');
const appEpoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
const indexHtml = fs.readFileSync('index.html', 'utf8');
const vite = fs.readFileSync('vite.config.js', 'utf8');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(homeSearch.includes('HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4'), 'query-authority resolver marker missing');
check(homeSearch.includes('resolveHomeSearchTarget(result, options = {})'), 'resolver options signature missing');
check(homeSearch.includes("const queryBaseCode = queryMode === 'BASE_ONLY'"), 'plain numeric query is not authoritative BASE');
check(homeSearch.includes("const queryTransportCode = queryMode === 'TRANSPORT_ONLY'"), 'explicit T-code query is not authoritative Transport');
check(homeSearch.includes("queryAuthority: queryBaseCode ? 'BASE_CODE'"), 'query authority diagnostics missing');
check(homeSearch.includes(".eq('code', Number(queryBaseCode))"), 'typed BASE code DB lookup missing');
check(homeSearch.includes("kind === 'TRANSPORT' && looksUuid(id)"), 'Transport ID is not constrained to UUID');
check(homeSearch.includes("source: resolvedResult ? 'db-live-query-authority'"), 'query-authoritative DB result source missing');

check(homePage.includes('resolveHomeSearchTarget(result, { query: q })'), 'Home HAP does not pass the exact typed query');
check(globalSearch.includes('resolveHomeSearchTarget(result, { query })'), 'Global HAP does not pass the exact typed query');
check(globalSearch.includes('openingResultKey, query, router'), 'Global HAP callback does not depend on query');

check(transportItem.includes('HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4'), 'Transport destination guard marker missing');
const guardIndex = transportItem.indexOf('isPlainNumericRouteValue(id) || isPlainNumericRouteValue(codeParam)');
const transportFetchIndex = transportItem.indexOf('fetchTransportOrderById(id)');
check(guardIndex >= 0, 'numeric stale-link guard missing');
check(transportFetchIndex >= 0, 'Transport fetch missing');
check(guardIndex >= 0 && transportFetchIndex >= 0 && guardIndex < transportFetchIndex, 'Transport fetch runs before numeric BASE guard');
check(transportItem.includes("supabase.from('orders').select('id,code,client_code,status,updated_at').eq('id', numericId)"), 'BASE order lookup by numeric id missing');
check(transportItem.includes(".eq('code', numericCode)"), 'BASE order lookup by numeric code missing');
check(transportItem.includes('router.replace(href)'), 'destination-side redirect to BASE status missing');
check(transportItem.includes("if (value === 'gati') return '/gati';"), 'GATI destination mapping missing');
check(transportItem.includes("return '/pastrimi';"), 'PASTRIMI destination mapping missing');
check(transportItem.includes('KODI PA T I TAKON BAZËS'), 'plain numeric route is not blocked from Transport');

check(packageJson.includes('apply-home-search-query-authority-transport-guard-v6.mjs'), 'v6 installer is not registered in prebuild');
check(packageJson.includes('verify-home-search-query-authority-transport-guard-v6.mjs'), 'v6 verifier is not registered');
check(packageJson.includes('2.0.115-query-authority-transport-guard-v4'), 'package version is not the guarded version');
check(appEpoch.includes("APP_VERSION = '2.0.115-query-authority-transport-guard-v4'"), 'runtime APP_VERSION was not bumped');
check(indexHtml.includes('2.0.115-query-authority-transport-guard-v4'), 'HTML build ID was not bumped');
check(vite.includes('v44-query-authority-transport-guard'), 'PWA cache generation was not bumped');

function mode(query) {
  const raw = String(query || '').trim().replace(/\s+/g, '');
  if (/^t\d+$/i.test(raw)) return 'TRANSPORT_ONLY';
  if (/^\d+$/.test(raw)) return 'BASE_ONLY';
  return 'GENERAL';
}

function authoritativeKind(query, result = {}) {
  const queryMode = mode(query);
  if (queryMode === 'BASE_ONLY') return 'BASE';
  if (queryMode === 'TRANSPORT_ONLY') return 'TRANSPORT';
  const code = String(result?.code || '').trim();
  const id = String(result?.id || '').trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  return String(result?.kind || '').toUpperCase() === 'TRANSPORT' && (uuid || /^T\d+$/i.test(code))
    ? 'TRANSPORT'
    : 'BASE';
}

check(
  authoritativeKind('915', { kind: 'TRANSPORT', id: '0790f1b1-c732-4356-95e4-6db6c375ce89', code: 'T338' }) === 'BASE',
  'typed 915 can still be overridden by the colliding Transport result',
);
check(
  authoritativeKind('915', { kind: 'BASE', id: '2954', code: '915', status: 'gati' }) === 'BASE',
  '#915 Faruk BASE model failed',
);
check(
  authoritativeKind('T915', { kind: 'BASE', id: '2954', code: '915' }) === 'TRANSPORT',
  'explicit T915 does not remain Transport',
);
check(/^\d+$/.test('2954'), 'numeric stale route id model failed');
check(!/^\d+$/.test('0790f1b1-c732-4356-95e4-6db6c375ce89'), 'UUID was treated as a plain numeric BASE id');

if (failures.length) {
  console.error(`FAIL: ${failures.length} query-authority/destination-guard check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: typed 915 resolves BASE #915, explicit T915 remains Transport, and stale numeric Transport links self-correct at the destination.');
