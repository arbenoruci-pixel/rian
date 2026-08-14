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

check(homeSearch.includes('HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4'), 'query-authority marker missing');
check(homeSearch.includes('resolveHomeSearchTarget(result, options = {})'), 'resolver options signature missing');
check(homeSearch.includes("queryMode === 'BASE_ONLY'"), 'plain-digit BASE authority missing');
check(homeSearch.includes("queryMode === 'TRANSPORT_ONLY'"), 'explicit T-code authority missing');
check(homeSearch.includes("queryAuthority: queryBaseCode ? 'BASE_CODE'"), 'query authority diagnostics missing');
check(homeSearch.includes(".from('orders')\n        .select('*')\n        .eq('code', Number(queryBaseCode))"), 'typed BASE code DB resolution missing');
check(homeSearch.includes("kind === 'TRANSPORT' && looksUuid(id)"), 'Transport UUID boundary missing');
check(homePage.includes('resolveHomeSearchTarget(result, { query: q })'), 'Home HAP does not pass typed query');
check(globalSearch.includes('resolveHomeSearchTarget(result, { query })'), 'Global HAP does not pass typed query');
check(globalSearch.includes('[closeModal, openingResultKey, query, router]'), 'Global callback query dependency missing');

check(transportItem.includes('HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4'), 'Transport destination guard marker missing');
check(transportItem.includes('isPlainNumericRouteValue(id) || isPlainNumericRouteValue(codeParam)'), 'numeric stale-link detection missing');
check(transportItem.includes("supabase.from('orders').select('id,code,client_code,status,updated_at').eq('id', numericId)"), 'numeric BASE id lookup missing');
check(transportItem.includes(".eq('code', numericCode)"), 'numeric BASE code lookup missing');
check(transportItem.includes('router.replace(href)'), 'destination redirect missing');
check(transportItem.includes('KODI PA T I TAKON BAZËS'), 'plain numeric Transport block missing');
check(transportItem.indexOf('isPlainNumericRouteValue(id) || isPlainNumericRouteValue(codeParam)') < transportItem.indexOf('fetchTransportOrderById(id)'), 'guard runs after Transport fetch');

check(packageJson.includes('apply-home-search-query-authority-transport-guard-v4.mjs'), 'installer not registered in prebuild');
check(packageJson.includes('test:home-search-query-authority-transport-guard-v4'), 'test script missing');
check(packageJson.includes('2.0.115-query-authority-transport-guard-v4'), 'package version missing');
check(appEpoch.includes("APP_VERSION = '2.0.115-query-authority-transport-guard-v4'"), 'runtime app version not bumped');
check(indexHtml.includes('2.0.115-query-authority-transport-guard-v4'), 'HTML build id not bumped');
check(vite.includes('v44-query-authority-transport-guard'), 'PWA cache generation not bumped');

function mode(query) {
  const raw = String(query || '').trim().replace(/\s+/g, '');
  if (/^t\d+$/i.test(raw)) return 'TRANSPORT_ONLY';
  if (/^\d+$/.test(raw)) return 'BASE_ONLY';
  return 'GENERAL';
}

function classify(query, result = {}) {
  const queryMode = mode(query);
  if (queryMode === 'BASE_ONLY') return 'BASE';
  if (queryMode === 'TRANSPORT_ONLY') return 'TRANSPORT';
  const code = String(result.code || '').trim();
  const id = String(result.id || '').trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  return String(result.kind || '').toUpperCase() === 'TRANSPORT' && (uuid || /^T\d+$/i.test(code)) ? 'TRANSPORT' : 'BASE';
}

function baseRoute(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'gati') return '/gati';
  if (['dorzim', 'dorezim', 'dorëzim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(value)) return '/marrje-sot';
  return '/pastrimi';
}

check(classify('915', { kind: 'TRANSPORT', id: '0790f1b1-c732-4356-95e4-6db6c375ce89', code: '915' }) === 'BASE', 'typed 915 can still be overridden by Transport metadata');
check(classify('915', { kind: 'BASE', id: '2954', code: '915' }) === 'BASE', '#915 BASE model failed');
check(classify('T915', { kind: 'BASE', id: '2954', code: '915' }) === 'TRANSPORT', 'explicit T915 model failed');
check(classify('faruk', { kind: 'BASE', id: '2954', code: '915' }) === 'BASE', 'general BASE result model failed');
check(baseRoute('gati') === '/gati', 'GATI route model failed');
check(baseRoute('pastrim') === '/pastrimi', 'PASTRIMI route model failed');
check(baseRoute('dorzim') === '/marrje-sot', 'DORËZIM route model failed');
check(/^\d+$/.test('2954'), 'numeric stale id model failed');
check(!/^\d+$/.test('0790f1b1-c732-4356-95e4-6db6c375ce89'), 'UUID treated as numeric');
check(!/^\d+$/.test('T915'), 'explicit T-code treated as numeric');

if (failures.length) {
  console.error(`FAIL: ${failures.length} query-authority/Transport-guard check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: typed 915 stays BASE, explicit T915 stays Transport, and stale numeric Transport links self-correct at the destination.');
