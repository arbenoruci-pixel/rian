import fs from 'node:fs';

const SEARCH_PATH = 'lib/homeSearch.js';
const HOME_PATH = 'app/page.jsx';
const MARKER = 'HOME_SEARCH_SOLID_V1';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function patchSearch() {
  let source = fs.readFileSync(SEARCH_PATH, 'utf8');
  if (source.includes(`${MARKER}:SEARCH`)) return false;

  const generalBlock = `
// ${MARKER}:SEARCH — online name/phone search must use shared DB truth, not device cache.
async function getRowsFromDbGeneral(query, mode = getHomeSearchQueryMode(query)) {
  if (mode !== 'GENERAL') return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return [];
  const raw = safeString(query);
  const text = normalizeText(raw);
  const digits = onlyDigits(raw);
  if (!text && !digits) return [];

  try {
    const { supabase } = await import('@/lib/supabaseClient');
    const rows = [];
    const clientIds = new Set();
    const clientCodes = new Set();

    const collectClients = (items = []) => {
      for (const client of Array.isArray(items) ? items : []) {
        if (client?.id) clientIds.add(String(client.id));
        const code = Number(client?.code);
        if (Number.isFinite(code) && code > 0) clientCodes.add(code);
      }
    };

    const clientQueries = [];
    if (digits.length >= 5) {
      const suffix = digits.slice(-8);
      clientQueries.push(
        supabase.from('clients').select('id,code,full_name,first_name,last_name,phone,updated_at').ilike('phone', '%' + suffix + '%').limit(30)
      );
    }
    if (text.length >= 2 && !/^\\d+$/.test(raw.replace(/\\s+/g, ''))) {
      clientQueries.push(
        supabase.from('clients').select('id,code,full_name,first_name,last_name,phone,updated_at').ilike('full_name', '%' + raw + '%').limit(30)
      );
    }
    const clientResponses = await Promise.all(clientQueries.map((promise) => promise.catch(() => ({ data: [], error: null }))));
    clientResponses.forEach((res) => { if (!res?.error) collectClients(res?.data); });

    const orderQueries = [];
    if (digits.length >= 5) {
      const suffix = digits.slice(-8);
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').ilike('client_phone', '%' + suffix + '%').order('updated_at', { ascending: false }).limit(40)
      );
      orderQueries.push(
        supabase.from('transport_orders').select('id,code_n,code_str,client_tcode,client_name,client_phone,status,data,created_at,updated_at').ilike('client_phone', '%' + suffix + '%').order('updated_at', { ascending: false }).limit(40)
      );
    }
    if (text.length >= 2 && !/^\\d+$/.test(raw.replace(/\\s+/g, ''))) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').ilike('client_name', '%' + raw + '%').order('updated_at', { ascending: false }).limit(40)
      );
      orderQueries.push(
        supabase.from('transport_orders').select('id,code_n,code_str,client_tcode,client_name,client_phone,status,data,created_at,updated_at').ilike('client_name', '%' + raw + '%').order('updated_at', { ascending: false }).limit(40)
      );
    }
    if (clientIds.size) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').in('client_id', Array.from(clientIds)).order('updated_at', { ascending: false }).limit(60)
      );
    }
    if (clientCodes.size) {
      orderQueries.push(
        supabase.from('orders').select('id,local_oid,code,client_id,client_name,client_phone,status,data,created_at,updated_at').in('code', Array.from(clientCodes)).order('updated_at', { ascending: false }).limit(60)
      );
    }

    const responses = await Promise.all(orderQueries.map((promise) => promise.catch(() => ({ data: [], error: null }))));
    responses.forEach((res) => {
      if (res?.error || !Array.isArray(res?.data)) return;
      for (const row of res.data) {
        const transport = row?.code_str !== undefined || row?.client_tcode !== undefined || row?.code_n !== undefined;
        rows.push({
          ...row,
          _table: transport ? 'transport_orders' : 'orders',
          _homeSearchSource: transport ? 'db-general-transport-orders' : 'db-general-orders',
          _homeSearchSourceRank: 95,
        });
      }
    });
    return rows;
  } catch {
    return [];
  }
}

function normalizeResolvedDbRow(row, table) {
  if (!row || typeof row !== 'object') return null;
  return normalizeResult({
    ...row,
    _table: table,
    _homeSearchSource: 'db-click-resolve:' + table,
    _homeSearchSourceRank: 110,
  });
}

export async function resolveHomeSearchTarget(result) {
  const fallbackHref = buildHomeSearchHref(result);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!online) return { href: fallbackHref, result, resolved: false, source: 'offline-fallback' };

  const kind = safeString(result?.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const table = kind === 'TRANSPORT' ? 'transport_orders' : 'orders';
  const id = safeString(result?.orderId || result?.id);
  const localOid = safeString(result?.localOid || result?.local_oid);
  const code = safeString(result?.code);

  try {
    const { supabase } = await import('@/lib/supabaseClient');
    let row = null;

    if (id) {
      const byId = await supabase.from(table).select('*').eq('id', id).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }
    if (!row && kind === 'BASE' && localOid) {
      const byLocal = await supabase.from('orders').select('*').eq('local_oid', localOid).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (!byLocal?.error && byLocal?.data) row = byLocal.data;
    }
    if (!row && code) {
      if (kind === 'BASE' && /^\\d+$/.test(code)) {
        const byCode = await supabase.from('orders').select('*').eq('code', Number(code)).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (!byCode?.error && byCode?.data) row = byCode.data;
      } else if (kind === 'TRANSPORT') {
        const codeNumber = Number(normalizeCode(code).replace(/\\D+/g, ''));
        if (Number.isFinite(codeNumber)) {
          const byCode = await supabase.from('transport_orders').select('*').eq('code_n', codeNumber).order('updated_at', { ascending: false }).limit(1).maybeSingle();
          if (!byCode?.error && byCode?.data) row = byCode.data;
        }
      }
    }

    const resolvedResult = normalizeResolvedDbRow(row, table);
    const href = resolvedResult ? buildHomeSearchHref(resolvedResult) : fallbackHref;
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve',
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: result?.status || '',
      resolved: !!resolvedResult,
      resolvedId: resolvedResult?.orderId || resolvedResult?.id || '',
      resolvedStatus: resolvedResult?.status || '',
      href,
    });
    return { href, result: resolvedResult || result, resolved: !!resolvedResult, source: resolvedResult ? 'db-live' : 'fallback' };
  } catch (error) {
    writeHomeSearchDiagnostics({
      event: 'result_click_resolve_failed',
      selectedKind: kind,
      selectedId: id,
      selectedCode: code,
      selectedStatus: result?.status || '',
      error: String(error?.message || error || ''),
      href: fallbackHref,
    });
    return { href: fallbackHref, result, resolved: false, source: 'error-fallback', error };
  }
}
`;

  source = replaceRequired(
    source,
    'export async function searchHomeLocalFirst(query) {',
    `${generalBlock}\nexport async function searchHomeLocalFirst(query) {`,
    'GENERAL_DB_SEARCH_INSERT'
  );

  source = replaceRequired(
    source,
    `  const [dbExactRows, snapshotRows, idbRows, baseMasterRows] = await Promise.all([\n    getRowsFromDbExact(q, mode),\n    getRowsFromSnapshots(),\n    getRowsFromIndexedDb(),\n    getRowsFromBaseMasterCache(),\n  ]);\n  const localRows = [...dbExactRows, ...baseMasterRows, ...idbRows, ...readLocalStorageRows(), ...snapshotRows];`,
    `  const [dbExactRows, dbGeneralRows, snapshotRows, idbRows, baseMasterRows] = await Promise.all([\n    getRowsFromDbExact(q, mode),\n    getRowsFromDbGeneral(q, mode),\n    getRowsFromSnapshots(),\n    getRowsFromIndexedDb(),\n    getRowsFromBaseMasterCache(),\n  ]);\n  const localRows = [...dbExactRows, ...dbGeneralRows, ...baseMasterRows, ...idbRows, ...readLocalStorageRows(), ...snapshotRows];`,
    'GENERAL_DB_SEARCH_PROMISE'
  );

  source = replaceRequired(
    source,
    `    dbExactCount: dbExactRows.length,\n    resultsCount: results.length,`,
    `    dbExactCount: dbExactRows.length,\n    dbGeneralCount: dbGeneralRows.length,\n    resultsCount: results.length,\n    policyVersion: '${MARKER}',`,
    'GENERAL_DB_SEARCH_DIAGNOSTIC'
  );

  fs.writeFileSync(SEARCH_PATH, source, 'utf8');
  return true;
}

function patchHome() {
  let source = fs.readFileSync(HOME_PATH, 'utf8');
  if (source.includes(`${MARKER}:HOME`)) return false;

  source = replaceRequired(
    source,
    `import { buildHomeSearchHref, cleanVisiblePersonName, searchHomeLocalFirst } from '@/lib/homeSearch';`,
    `import { buildHomeSearchHref, cleanVisiblePersonName, resolveHomeSearchTarget, searchHomeLocalFirst } from '@/lib/homeSearch';\n// ${MARKER}:HOME`,
    'HOME_IMPORT_RESOLVER'
  );

  source = replaceRequired(
    source,
    `  const [searchMessage, setSearchMessage] = useState('');\n  const [canSeeDispatch, setCanSeeDispatch] = useState(false);`,
    `  const [searchMessage, setSearchMessage] = useState('');\n  const [openingResultKey, setOpeningResultKey] = useState('');\n  const [canSeeDispatch, setCanSeeDispatch] = useState(false);`,
    'HOME_OPENING_STATE'
  );

  source = replaceRequired(
    source,
    `  const openSearchResult = (result) => {\n    const href = buildHomeSearchHref(result);\n    if (!href) return;\n    router.push(href);\n  };`,
    `  const openSearchResult = async (result) => {\n    const resultKey = [result?.kind, result?.orderId || result?.id, result?.code].filter(Boolean).join(':');\n    if (openingResultKey) return;\n    setOpeningResultKey(resultKey || 'opening');\n    setSearchMessage('Duke verifikuar statusin aktual në DB...');\n    try {\n      const resolved = await resolveHomeSearchTarget(result);\n      const href = resolved?.href || buildHomeSearchHref(result);\n      if (!href) throw new Error('NUK U GJET FAQJA E POROSISË.');\n      router.push(href);\n    } catch (error) {\n      setSearchMessage(String(error?.message || error || 'Porosia nuk u hap. Provo përsëri.'));\n      setOpeningResultKey('');\n    }\n  };`,
    'HOME_ASYNC_OPEN_HANDLER'
  );

  source = source.replaceAll('openSearchResult(result);', 'void openSearchResult(result);');
  source = replaceRequired(
    source,
    `<button className="go-btn" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openSearchResult(result); }}>\n                            HAP ➔\n                          </button>`,
    `<button className="go-btn" type="button" disabled={!!openingResultKey} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openSearchResult(result); }}>\n                            {openingResultKey === [result?.kind, result?.orderId || result?.id, result?.code].filter(Boolean).join(':') ? 'DUKE HAPUR...' : 'HAP ➔'}\n                          </button>`,
    'HOME_OPEN_BUTTON_BUSY'
  );

  fs.writeFileSync(HOME_PATH, source, 'utf8');
  return true;
}

const changed = [patchSearch(), patchHome()].some(Boolean);
console.log(`[home-search-solid-v1] ${changed ? 'installed' : 'already installed'}`);
