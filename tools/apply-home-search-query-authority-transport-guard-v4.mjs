import fs from 'node:fs';

const HOME_SEARCH = 'lib/homeSearch.js';
const HOME_PAGE = 'app/page.jsx';
const GLOBAL_SEARCH = 'components/GlobalHomeSearch.jsx';
const TRANSPORT_ITEM = 'app/transport/item/page.jsx';
const EPOCH = 'lib/appEpoch.js';
const INDEX = 'index.html';
const VITE = 'vite.config.js';
const MARKER = 'HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4';
const VERSION = '2.0.115-query-authority-transport-guard-v4';
const CACHE = 'v44-query-authority-transport-guard';

function replaceOnce(source, from, to, label) {
  if (source.includes(to)) return source;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(from, to);
}

function replaceBlock(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: start marker missing`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`${label}: end marker missing`);
  return `${source.slice(0, start)}${replacement.trimEnd()}${source.slice(end)}`;
}

let homeSearch = fs.readFileSync(HOME_SEARCH, 'utf8');
if (!homeSearch.includes(MARKER)) {
  const resolverReplacement = String.raw`export async function resolveHomeSearchTarget(result, options = {}) {
  // HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4
  // The exact text typed by the worker is the identity boundary. Plain digits
  // always mean BASE; only an explicit T-code means Transport. Result/cache
  // metadata cannot override that boundary.
  const searchQuery = safeString(options?.query || '');
  const queryMode = getHomeSearchQueryMode(searchQuery);
  const queryBaseCode = queryMode === 'BASE_ONLY' ? normalizeNumericCode(searchQuery) : '';
  const queryTransportCode = queryMode === 'TRANSPORT_ONLY'
    ? normalizeTransportCodeStrict(searchQuery)
    : '';

  const authoritativeResult = queryBaseCode
    ? { ...(result || {}), kind: 'BASE', code: queryBaseCode, clientCode: queryBaseCode }
    : queryTransportCode
      ? { ...(result || {}), kind: 'TRANSPORT', code: queryTransportCode }
      : (result || {});

  const fallbackHref = buildHomeSearchHref(authoritativeResult);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!online) return { href: fallbackHref, result: authoritativeResult, resolved: false, source: 'offline-fallback' };

  const claimedKind = safeString(authoritativeResult?.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const id = safeString(authoritativeResult?.orderId || authoritativeResult?.id);
  const localOid = safeString(authoritativeResult?.localOid || authoritativeResult?.local_oid);
  const resultCode = safeString(authoritativeResult?.code);
  const code = queryBaseCode || queryTransportCode || resultCode;
  const normalizedCode = normalizeCode(code);
  const strictTransportCode = normalizeTransportCodeStrict(normalizedCode);
  const numericBaseCode = /^\d+$/.test(code.replace(/^#+/, '').trim());
  const kind = queryBaseCode
    ? 'BASE'
    : queryTransportCode
      ? 'TRANSPORT'
      : numericBaseCode
        ? 'BASE'
        : (claimedKind === 'TRANSPORT' && (looksUuid(id) || strictTransportCode) ? 'TRANSPORT' : 'BASE');
  const table = kind === 'TRANSPORT' ? 'transport_orders' : 'orders';

  try {
    const { supabase } = await import('@/lib/supabaseClient');
    let row = null;

    // For a typed BASE code, a numeric BASE id is safe and exact. A UUID/id from
    // contaminated Transport cache is ignored and the BASE code is resolved.
    if (kind === 'BASE' && id && /^\d+$/.test(id)) {
      const byId = await supabase.from('orders').select('*').eq('id', Number(id)).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }

    if (!row && kind === 'BASE' && queryBaseCode) {
      const byTypedCode = await supabase
        .from('orders')
        .select('*')
        .eq('code', Number(queryBaseCode))
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!byTypedCode?.error && byTypedCode?.data) row = byTypedCode.data;
    }

    if (!row && kind === 'TRANSPORT' && looksUuid(id)) {
      const byId = await supabase.from('transport_orders').select('*').eq('id', id).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }

    if (!row && kind === 'BASE' && localOid) {
      const byLocal = await supabase.from('orders').select('*').eq('local_oid', localOid).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (!byLocal?.error && byLocal?.data) row = byLocal.data;
    }

    if (!row && code) {
      if (kind === 'BASE' && /^\d+$/.test(code)) {
        const byCode = await supabase.from('orders').select('*').eq('code', Number(code)).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (!byCode?.error && byCode?.data) row = byCode.data;
      } else if (kind === 'TRANSPORT' && strictTransportCode) {
        const codeNumber = Number(strictTransportCode.replace(/\D+/g, ''));
        if (Number.isFinite(codeNumber)) {
          const byCode = await supabase.from('transport_orders').select('*').eq('code_n', codeNumber).order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (!byCode?.error && byCode?.data) row = byCode.data;
        }
      }
    }

    const resolvedResult = normalizeResolvedDbRow(row, table);
    const finalResult = resolvedResult || authoritativeResult;
    const href = buildHomeSearchHref(finalResult);
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve',
      query: searchQuery,
      queryMode,
      queryAuthority: queryBaseCode ? 'BASE_CODE' : queryTransportCode ? 'TRANSPORT_TCODE' : 'RESULT_METADATA',
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: authoritativeResult?.status || '',
      resolved: !!resolvedResult,
      resolvedId: resolvedResult?.orderId || resolvedResult?.id || '',
      resolvedStatus: resolvedResult?.status || '',
      href,
    });
    return { href, result: finalResult, resolved: !!resolvedResult, source: resolvedResult ? 'db-live-query-authority' : 'fallback-query-authority' };
  } catch (error) {
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve_failed',
      query: searchQuery,
      queryMode,
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: authoritativeResult?.status || '',
      error: String(error?.message || error || ''),
      href: fallbackHref,
    });
    return { href: fallbackHref, result: authoritativeResult, resolved: false, source: 'error-fallback-query-authority', error };
  }
}`;

  homeSearch = replaceBlock(
    homeSearch,
    'export async function resolveHomeSearchTarget(',
    '\n\nexport async function searchHomeLocalFirst',
    resolverReplacement,
    'Home search live resolver',
  );
  fs.writeFileSync(HOME_SEARCH, homeSearch, 'utf8');
}

let homePage = fs.readFileSync(HOME_PAGE, 'utf8');
homePage = replaceOnce(
  homePage,
  'const resolved = await resolveHomeSearchTarget(result);',
  'const resolved = await resolveHomeSearchTarget(result, { query: q });',
  'Home HAP passes exact typed query',
);
fs.writeFileSync(HOME_PAGE, homePage, 'utf8');

let globalSearch = fs.readFileSync(GLOBAL_SEARCH, 'utf8');
if (globalSearch.includes('resolveHomeSearchTarget(result);')) {
  globalSearch = replaceOnce(
    globalSearch,
    'const resolved = await resolveHomeSearchTarget(result);',
    'const resolved = await resolveHomeSearchTarget(result, { query });',
    'Global HAP passes exact typed query',
  );
}
if (globalSearch.includes('}, [closeModal, openingResultKey, router]);')) {
  globalSearch = globalSearch.replace(
    '}, [closeModal, openingResultKey, router]);',
    '}, [closeModal, openingResultKey, query, router]);',
  );
}
fs.writeFileSync(GLOBAL_SEARCH, globalSearch, 'utf8');

let transportItem = fs.readFileSync(TRANSPORT_ITEM, 'utf8');
if (!transportItem.includes(MARKER)) {
  transportItem = replaceOnce(
    transportItem,
    'import { fetchTransportOrderById, fetchTransportOrderByCode, updateTransportOrderById } from "@/lib/transportOrdersDb";',
    'import { fetchTransportOrderById, fetchTransportOrderByCode, updateTransportOrderById } from "@/lib/transportOrdersDb";\nimport { supabase } from "@/lib/supabaseClient";',
    'Transport item BASE guard import',
  );

  const guardHelpers = String.raw`
// HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4
function isPlainNumericRouteValue(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function baseStatusRoute(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'gati') return '/gati';
  if (['dorzim', 'dorezim', 'dorëzim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(value)) return '/marrje-sot';
  return '/pastrimi';
}

function buildBaseGuardHref(order) {
  const id = String(order?.id || '').trim();
  const code = String(order?.code ?? order?.client_code ?? '').replace(/^#+/, '').trim();
  const params = new URLSearchParams();
  if (code) params.set('q', code);
  if (code) params.set('openCode', code);
  if (id) params.set('openId', id);
  params.set('exact', '1');
  params.set('from', 'transport_numeric_guard');
  return `${baseStatusRoute(order?.status)}?${params.toString()}`;
}

async function findBaseOrderForNumericTransportLink({ id, code }) {
  let row = null;
  const numericId = isPlainNumericRouteValue(id) ? Number(id) : null;
  const numericCode = isPlainNumericRouteValue(code) ? Number(code) : null;

  if (Number.isFinite(numericId) && numericId > 0) {
    const byId = await supabase.from('orders').select('id,code,client_code,status,updated_at').eq('id', numericId).limit(1).maybeSingle();
    if (byId?.error) throw byId.error;
    if (byId?.data) row = byId.data;
  }

  if (!row && Number.isFinite(numericCode) && numericCode > 0) {
    const byCode = await supabase
      .from('orders')
      .select('id,code,client_code,status,updated_at')
      .eq('code', numericCode)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byCode?.error) throw byCode.error;
    if (byCode?.data) row = byCode.data;
  }

  return row;
}
`;

  transportItem = replaceOnce(
    transportItem,
    'function nextForStatus(st) {',
    `${guardHelpers}\nfunction nextForStatus(st) {`,
    'Transport numeric route guard helpers',
  );

  const guardedLoad = String.raw`  async function load() {
    if (!id && !codeParam) {
      setErr("MUNGON ID / KODI");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      // A Transport order is identified by a UUID or an explicit T-code. Plain
      // numbers belong to BASE. This destination-side guard protects users even
      // when an older cached Home bundle sends a stale /transport/item link.
      if (isPlainNumericRouteValue(id) || isPlainNumericRouteValue(codeParam)) {
        const baseOrder = await findBaseOrderForNumericTransportLink({ id, code: codeParam });
        if (baseOrder) {
          const href = buildBaseGuardHref(baseOrder);
          try {
            localStorage.setItem('tepiha_transport_numeric_guard_last_v1', JSON.stringify({
              at: new Date().toISOString(),
              id,
              codeParam,
              baseOrderId: baseOrder.id,
              baseCode: baseOrder.code,
              baseStatus: baseOrder.status,
              href,
            }));
          } catch {}
          router.replace(href);
          return;
        }
        setRow(null);
        setErr("KODI PA T I TAKON BAZËS. KËRKOJE NGA HOME ME NUMËR; TRANSPORTI KËRKON T-CODE.");
        return;
      }

      const t = id ? await fetchTransportOrderById(id) : await fetchTransportOrderByCode(codeParam);
      if (t) {
        setRow({ ...t, __src: "transport_orders" });
        return;
      }
      setRow(null);
      setErr("NUK U GJET NË TRANSPORT");
    } catch (e) {
      setRow(null);
      setErr(e?.message || "GABIM");
    } finally {
      setLoading(false);
    }
  }`;

  transportItem = replaceBlock(
    transportItem,
    '  async function load() {',
    '\n\n  useEffect(() => {',
    guardedLoad,
    'Transport item load guard',
  );
  fs.writeFileSync(TRANSPORT_ITEM, transportItem, 'utf8');
}

let epoch = fs.readFileSync(EPOCH, 'utf8');
epoch = epoch.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${VERSION}';`);
fs.writeFileSync(EPOCH, epoch, 'utf8');

let index = fs.readFileSync(INDEX, 'utf8');
index = index
  .replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${VERSION}$2`)
  .replace(/window\.__TEPIHA_BUILD_ID\s*=\s*'[^']+';/, `window.__TEPIHA_BUILD_ID = '${VERSION}';`);
fs.writeFileSync(INDEX, index, 'utf8');

let vite = fs.readFileSync(VITE, 'utf8');
vite = vite
  .replace(/sw-navigation-diag\.js\?v=\d+/, 'sw-navigation-diag.js?v=3508')
  .replace(/tepiha-vite-business-routes-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-business-routes-${CACHE}`)
  .replace(/tepiha-vite-static-assets-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-static-assets-${CACHE}`)
  .replace(/tepiha-vite-media-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-media-${CACHE}`);
fs.writeFileSync(VITE, vite, 'utf8');

const finalHome = fs.readFileSync(HOME_SEARCH, 'utf8');
const finalPage = fs.readFileSync(HOME_PAGE, 'utf8');
const finalGlobal = fs.readFileSync(GLOBAL_SEARCH, 'utf8');
const finalTransport = fs.readFileSync(TRANSPORT_ITEM, 'utf8');
for (const [label, source, tokens] of [
  ['homeSearch', finalHome, [MARKER, 'queryMode', "queryAuthority: queryBaseCode ? 'BASE_CODE'", "source: 'db-live-query-authority'"]],
  ['homePage', finalPage, ["resolveHomeSearchTarget(result, { query: q })"]],
  ['globalSearch', finalGlobal, ["resolveHomeSearchTarget(result, { query })"]],
  ['transportItem', finalTransport, [MARKER, 'findBaseOrderForNumericTransportLink', 'router.replace(href)', 'KODI PA T I TAKON BAZËS']],
]) {
  for (const token of tokens) {
    if (!source.includes(token)) throw new Error(`${label}: missing ${token}`);
  }
}

console.log('PASS Home query is authoritative and stale numeric Transport links redirect to BASE safely');
