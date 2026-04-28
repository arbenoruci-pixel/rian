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

function safeObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function unwrapData(row) {
  try {
    const root = safeObject(row);
    const data = safeObject(root?.data);
    const order = safeObject(root?.order || data?.order);
    const orderData = safeObject(order?.data);
    const fullOrder = safeObject(root?.fullOrder || data?.fullOrder);
    const fullOrderData = safeObject(fullOrder?.data);
    return {
      ...root,
      ...fullOrderData,
      ...orderData,
      ...fullOrder,
      ...order,
      ...data,
      client: data?.client || order?.client || fullOrder?.client || orderData?.client || fullOrderData?.client || root?.client,
      pay: data?.pay || order?.pay || fullOrder?.pay || orderData?.pay || fullOrderData?.pay || root?.pay,
      transport: data?.transport || order?.transport || fullOrder?.transport || orderData?.transport || fullOrderData?.transport || root?.transport,
      _audit: data?._audit || order?._audit || fullOrder?._audit || orderData?._audit || fullOrderData?._audit || root?._audit,
    };
  } catch {
    return {};
  }
}

function pickFirst(...values) {
  for (const value of values) {
    const raw = safeString(value);
    if (raw) return raw;
  }
  return '';
}

export function looksUuid(value) {
  const raw = safeString(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
}

export function isOpaquePersonRef(value) {
  const raw = safeString(value);
  if (!raw) return false;
  const upper = raw.toUpperCase();

  if (looksUuid(raw)) return true;
  if (/^\d+$/.test(raw)) return true;
  if (/^ADMIN[_-]/i.test(raw)) return true;
  if (/^USER[_-]/i.test(raw)) return true;
  if (/^TRANSPORT[_-][A-Z0-9_-]+$/i.test(raw)) return true;
  if (/^[a-f0-9]{16,}$/i.test(raw)) return true;
  if (/^[a-z0-9_-]{20,}$/i.test(raw) && !/[\s.]/.test(raw)) return true;
  if (upper === 'NULL' || upper === 'UNDEFINED' || upper === 'N/A') return true;

  return false;
}

export function cleanVisiblePersonName(value) {
  const raw = safeString(value);
  if (!raw) return '';
  if (isOpaquePersonRef(raw)) return '';
  return raw;
}

function pickVisiblePersonName(...values) {
  for (const value of values) {
    const name = cleanVisiblePersonName(value);
    if (name) return name;
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


function pickCreatedBy(row) {
  const data = unwrapData(row);
  const audit = safeObject(data?._audit);
  return pickVisiblePersonName(
    row?.created_by_name,
    row?.createdBy,
    data?.created_by_name,
    data?.createdBy,
    audit?.created_by_name
  );
}

function pickTransporter(row, includeTransportDisplayFields = false) {
  const data = unwrapData(row);
  const transport = safeObject(data?.transport);
  const audit = safeObject(data?._audit);

  return pickVisiblePersonName(
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    row?.created_by_name,
    row?.brought_by,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.created_by_name,
    data?.brought_by,
    transport?.name,
    transport?.driver_name,
    transport?.driverName,
    transport?.assigned_driver_name,
    transport?.assignedDriverName,
    audit?.created_by_name,
    includeTransportDisplayFields ? row?.actor : '',
    includeTransportDisplayFields ? data?.actor : ''
  );
}

function computePieces(row) {
  const data = unwrapData(row);
  const direct = Number(
    row?.pieces
    || row?.cope
    || data?.pieces
    || data?.cope
    || data?.totals?.pieces
    || data?.pay?.pieces
    || 0
  ) || 0;
  if (direct > 0) return direct;
  const tepiha = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  const staza = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  const countRows = (rows) => rows.reduce((sum, item) => sum + (Number(item?.qty ?? item?.pieces ?? item?.cope ?? 1) || 0), 0);
  const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
  return countRows(tepiha) + countRows(staza) + stairsQty;
}

function formatMeasureValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(Math.round(num * 100) / 100).replace(/\.0+$/, '').trim();
}

function extractMeasurementChips(row) {
  const chips = [];
  const pushValue = (value, qty = 1) => {
    const label = formatMeasureValue(value);
    if (!label) return;
    const count = Math.max(1, Math.min(Number(qty) || 1, 80));
    for (let index = 0; index < count; index += 1) chips.push(label);
  };
  const pushRows = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const item of rows) {
      if (item && typeof item === 'object') {
        pushValue(item?.m2 ?? item?.meter ?? item?.measurement ?? item?.value, item?.qty ?? item?.pieces ?? item?.cope ?? 1);
      } else {
        pushValue(item, 1);
      }
    }
  };

  try {
    const data = unwrapData(row);
    pushRows(data?.tepiha);
    pushRows(data?.tepihaRows);
    pushRows(data?.staza);
    pushRows(data?.stazaRows);
    pushRows(data?.m2_list);
    pushRows(data?.m2s);
    pushRows(data?.measurements);
    const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
    const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
    if (stairsQty > 0 && stairsPer > 0) pushValue(stairsPer, stairsQty);
  } catch {}

  return chips.filter(Boolean);
}

function normalizeResult(row) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const rawCode = pickCode(row);
  const code = kind === 'TRANSPORT' ? normalizeCode(rawCode) : safeString(rawCode).replace(/^#+/, '');
  const transporter = cleanVisiblePersonName(pickTransporter(row, kind === 'TRANSPORT'));
  const broughtBy = kind === 'TRANSPORT' ? (transporter || 'PA EMËR NË CACHE') : transporter;
  return {
    kind,
    id: row?.id ?? row?.local_oid ?? row?.transport_id ?? null,
    clientId: row?.client_id ?? row?.clientId ?? data?.client_id ?? data?.clientId ?? null,
    code,
    status: pickStatus(row),
    name: pickName(row),
    phone: pickPhone(row),
    address: pickAddress(row),
    pieces: computePieces(row),
    createdBy: pickCreatedBy(row),
    transporter,
    broughtBy,
    measurements: extractMeasurementChips(row),
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
