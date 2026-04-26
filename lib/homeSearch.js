const HOME_SEARCH_MAX_RESULTS = 24;
const HOME_SEARCH_DIAG_KEY = 'tepiha_home_search_last_v1';

function safeString(value) {
  return String(value ?? '').trim();
}

export function normalizeText(value) {
  return safeString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value) {
  return safeString(value).replace(/[\s\-()./]/g, '').replace(/(?!^)\+/g, '');
}

export function onlyDigits(value) {
  return safeString(value).replace(/\D+/g, '');
}

export function normalizeCode(value) {
  const raw = safeString(value).replace(/^#+/, '').replace(/[\s\-_/]+/g, '').toUpperCase();
  const transportDigits = raw.replace(/^T+/, '').replace(/\D+/g, '');
  if (/^T/i.test(raw) && transportDigits) return `T${transportDigits}`;
  return raw.replace(/^#+/, '');
}

function unwrapData(row) {
  let data = row;
  if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;
  if (data && typeof data === 'object' && data.order && typeof data.order === 'object') {
    const nested = data.order;
    data = { ...nested, ...data, client: data.client || nested.client, pay: data.pay || nested.pay };
  }
  return data && typeof data === 'object' ? data : {};
}

function pickFirst(...values) {
  for (const value of values) {
    const raw = safeString(value);
    if (raw) return raw;
  }
  return '';
}

function pickCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_tcode,
    row?.transport_code,
    row?.t_code,
    row?.code_str,
    row?.code,
    row?.code_n,
    row?.client_code,
    data?.client_tcode,
    data?.transport_code,
    data?.t_code,
    data?.code_str,
    data?.code,
    data?.code_n,
    data?.client_code
  );
}

function getKind(row) {
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  const code = normalizeCode(pickCode(row));
  if (table === 'transport_orders' || table.includes('transport')) return 'TRANSPORT';
  if (/^T\d+$/i.test(code)) return 'TRANSPORT';
  return 'BASE';
}

function pickName(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_name,
    row?.customer_name,
    row?.name,
    row?.client?.name,
    data?.client?.name,
    data?.client_name,
    data?.customer_name,
    data?.name,
    'Pa emër'
  );
}

function pickPhone(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_phone,
    row?.customer_phone,
    row?.phone,
    row?.tel,
    row?.client?.phone,
    data?.client?.phone,
    data?.client_phone,
    data?.customer_phone,
    data?.phone,
    data?.tel
  );
}

function pickAddress(row) {
  const data = unwrapData(row);
  return pickFirst(row?.address, row?.pickup_address, data?.address, data?.pickup_address);
}

function pickStatus(row) {
  const data = unwrapData(row);
  return pickFirst(row?.status, data?.status, row?.state, data?.state);
}

function computePieces(row) {
  const data = unwrapData(row);
  const direct = Number(row?.pieces || row?.cope || data?.pieces || data?.cope || 0) || 0;
  if (direct > 0) return direct;
  const tepiha = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  const staza = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  const countRows = (rows) => rows.reduce((sum, item) => sum + (Number(item?.qty ?? item?.pieces ?? item?.cope ?? 1) || 0), 0);
  return countRows(tepiha) + countRows(staza);
}

function normalizeResult(row) {
  const kind = getKind(row);
  const rawCode = pickCode(row);
  const code = kind === 'TRANSPORT' ? normalizeCode(rawCode) : safeString(rawCode).replace(/^#+/, '');
  return {
    kind,
    id: row?.id ?? row?.local_oid ?? row?.transport_id ?? null,
    code,
    status: pickStatus(row),
    name: pickName(row),
    phone: pickPhone(row),
    address: pickAddress(row),
    pieces: computePieces(row),
  };
}

function rowMatches(row, query) {
  const qText = normalizeText(query);
  const qDigits = onlyDigits(query);
  const qCode = normalizeCode(query);
  if (!qText && !qDigits && !qCode) return false;

  const result = normalizeResult(row);
  const name = normalizeText(result.name);
  const phone = normalizePhone(result.phone);
  const phoneDigits = onlyDigits(result.phone);
  const address = normalizeText(result.address);
  const code = normalizeCode(result.code);
  const rawCode = normalizeText(result.code);

  if (qCode && code && code === qCode) return true;
  if (qCode && code && code.includes(qCode)) return true;
  if (qText && rawCode && rawCode.includes(qText)) return true;
  if (qText && name && name.includes(qText)) return true;
  if (qText && address && address.includes(qText)) return true;
  if (qDigits && phoneDigits && phoneDigits.includes(qDigits)) return true;
  if (qDigits && phoneDigits && qDigits.length >= 6 && phoneDigits.endsWith(qDigits.slice(-6))) return true;
  if (qText && phone && normalizeText(phone).includes(qText)) return true;
  return false;
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const key = [item.kind, item.id || '', item.code || '', normalizePhone(item.phone || ''), normalizeText(item.name || '')].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= HOME_SEARCH_MAX_RESULTS) break;
  }
  return out;
}

async function getRowsFromSnapshots() {
  try {
    const { readPageSnapshot } = await import('@/lib/pageSnapshotCache');
    const pages = ['pastrimi', 'gati', 'marrje-sot', 'pranimi'];
    return pages.flatMap((page) => {
      try {
        const snap = readPageSnapshot(page);
        return (Array.isArray(snap?.rows) ? snap.rows : []).map((row) => ({ ...row, _snapshot: page, _table: row?._table || 'orders' }));
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function getRowsFromIndexedDb() {
  try {
    const { getAllFromStore } = await import('@/lib/localDb');
    const [baseRows, transportRows] = await Promise.all([
      getAllFromStore('orders').catch(() => []),
      getAllFromStore('transport_orders').catch(() => []),
    ]);
    return [
      ...(Array.isArray(baseRows) ? baseRows.map((row) => ({ ...row, _table: 'orders' })) : []),
      ...(Array.isArray(transportRows) ? transportRows.map((row) => ({ ...row, _table: 'transport_orders' })) : []),
    ];
  } catch {
    return [];
  }
}

function readLocalStorageRows() {
  if (typeof window === 'undefined') return [];
  const keys = [
    'tepiha_local_orders_v1',
    'orders_v1',
    'tepiha_orders_v1',
    'transport_orders_v1',
    'tepiha_transport_orders_v1',
  ];
  const rows = [];
  for (const key of keys) {
    try {
      const raw = window.localStorage?.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed?.rows) ? parsed.rows : []));
      const isTransport = key.toLowerCase().includes('transport');
      for (const row of arr) rows.push({ ...row, _table: row?._table || (isTransport ? 'transport_orders' : 'orders') });
    } catch {}
  }
  return rows;
}

export function buildHomeSearchHref(result) {
  const kind = safeString(result?.kind).toUpperCase();
  const code = safeString(result?.code);
  const id = result?.id != null ? safeString(result.id) : '';
  const status = normalizeText(result?.status);
  if (kind === 'TRANSPORT') {
    if (id) return `/transport/item?id=${encodeURIComponent(id)}&src=transport&from=home_inline_search`;
    if (code) return `/transport/item?code=${encodeURIComponent(normalizeCode(code))}&from=home_inline_search`;
    return '/transport';
  }
  const route = status === 'gati'
    ? '/gati'
    : (status === 'dorzim' || status === 'dorzuar' || status === 'delivered')
      ? '/marrje-sot'
      : '/pastrimi';
  const params = new URLSearchParams();
  if (code) params.set('q', code);
  if (id) params.set('openId', id);
  if (code || id) params.set('exact', '1');
  params.set('from', 'home_inline_search');
  return `${route}?${params.toString()}`;
}

export async function searchHomeLocalFirst(query) {
  const q = safeString(query);
  if (!q) return { results: [], baseLocalCount: 0, transportLocalCount: 0 };
  const [snapshotRows, idbRows] = await Promise.all([getRowsFromSnapshots(), getRowsFromIndexedDb()]);
  const localRows = [...snapshotRows, ...idbRows, ...readLocalStorageRows()];
  const matches = localRows.filter((row) => rowMatches(row, q)).map(normalizeResult);
  const results = dedupeResults(matches);
  const baseLocalCount = localRows.filter((row) => getKind(row) === 'BASE').length;
  const transportLocalCount = localRows.filter((row) => getKind(row) === 'TRANSPORT').length;
  writeHomeSearchDiagnostics({
    query: q,
    normalizedQuery: normalizeText(q),
    baseLocalCount,
    transportLocalCount,
    resultsCount: results.length,
  });
  return { results, baseLocalCount, transportLocalCount };
}

export function writeHomeSearchDiagnostics(detail = {}) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(HOME_SEARCH_DIAG_KEY, JSON.stringify({
      ...detail,
      timestamp: new Date().toISOString(),
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      appVersion: window.__TEPIHA_BUILD_ID || '',
      epoch: window.__TEPIHA_APP_EPOCH || '',
    }));
  } catch {}
}
