import { getAllFromStore } from '@/lib/localDb';

const HOME_SEARCH_DIAG_KEY = 'tepiha_home_search_last_v1';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripDiacritics(value) {
  try {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    return String(value || '');
  }
}

export function normalizeText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let out = raw.replace(/[\s\-().]/g, '');
  if (out.startsWith('00')) out = `+${out.slice(2)}`;
  out = out.replace(/(?!^\+)\D+/g, '');
  return out;
}

function phoneDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

export function normalizeCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/^#+/, '').replace(/[\s\-_.]+/g, '').toUpperCase();
  if (/^T\d+$/i.test(compact)) {
    const digits = compact.replace(/\D+/g, '').replace(/^0+/, '');
    return digits ? `T${digits}` : 'T';
  }
  const digits = compact.replace(/\D+/g, '').replace(/^0+/, '');
  return digits || compact;
}

function isTransportCode(value) {
  return /^T\d+$/i.test(normalizeCode(value));
}

function readNested(obj, path) {
  try {
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
  } catch {
    return undefined;
  }
}

function firstValue(row, paths = []) {
  for (const path of paths) {
    const value = path.includes('.') ? readNested(row, path) : row?.[path];
    const str = String(value ?? '').trim();
    if (str) return str;
  }
  return '';
}

function numberValue(row, paths = []) {
  for (const path of paths) {
    const value = path.includes('.') ? readNested(row, path) : row?.[path];
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function updatedTime(row) {
  const raw = row?.updated_at || row?.created_at || row?.data?.updated_at || row?.data?.created_at || 0;
  const t = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
  return Number.isFinite(t) ? t : 0;
}

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readLocalStorageRows(keys = []) {
  if (typeof window === 'undefined') return [];
  const out = [];
  for (const key of keys) {
    try {
      const parsed = safeJsonParse(window.localStorage.getItem(key) || '', null);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (isObject(parsed)) {
        if (Array.isArray(parsed.items)) out.push(...parsed.items);
        else if (Array.isArray(parsed.rows)) out.push(...parsed.rows);
        else if (Array.isArray(parsed.orders)) out.push(...parsed.orders);
        else out.push(...Object.values(parsed).filter(isObject));
      }
    } catch {}
  }
  return out;
}

function dedupeRows(rows = [], kind = 'base') {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row)) continue;
    const data = isObject(row.data) ? row.data : {};
    const key = [
      kind,
      row.id,
      row.local_oid,
      row.oid,
      row.code,
      row.code_n,
      row.code_str,
      row.client_tcode,
      data.local_oid,
      data.oid,
    ].map((v) => String(v || '').trim()).filter(Boolean).join('|');
    const fallback = `${kind}|${out.length}|${updatedTime(row)}`;
    const id = key || fallback;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function isTransportRow(row) {
  const table = String(row?.table || row?._table || row?.source_table || row?.data?.table || '').trim();
  if (table === 'transport_orders' || table === 'transport') return true;
  const code = normalizeCode(row?.code || row?.code_str || row?.transport_code || row?.t_code || row?.client_tcode || row?.data?.client?.tcode || row?.data?.client?.code || '');
  return /^T\d+$/i.test(code);
}

function baseCode(row) {
  const direct = firstValue(row, [
    'code',
    'code_n',
    'client_code',
    'order_code',
    'data.code',
    'data.code_n',
    'data.client_code',
    'data.client.code',
  ]);
  const code = normalizeCode(direct);
  return /^T\d+$/i.test(code) ? '' : code;
}

function transportCode(row) {
  const direct = firstValue(row, [
    'code_str',
    'transport_code',
    'transportCode',
    't_code',
    'tcode',
    'client_tcode',
    'code',
    'data.code_str',
    'data.transport_code',
    'data.t_code',
    'data.tcode',
    'data.client_tcode',
    'data.client.tcode',
    'data.client.code',
  ]);
  const code = normalizeCode(direct);
  if (/^T\d+$/i.test(code)) return code;
  const visitNr = numberValue(row, ['visit_nr', 'visit_no', 'data.visit_nr', 'data.visit_no']);
  return visitNr ? `T${visitNr}` : '';
}

function getBaseName(row) {
  return firstValue(row, [
    'name',
    'client_name',
    'customer_name',
    'full_name',
    'client.name',
    'data.name',
    'data.client_name',
    'data.customer_name',
    'data.client.name',
  ]) || 'PA EMËR';
}

function getBasePhone(row) {
  return firstValue(row, [
    'phone',
    'client_phone',
    'customer_phone',
    'client.phone',
    'data.phone',
    'data.client_phone',
    'data.customer_phone',
    'data.client.phone',
  ]);
}

function getTransportName(row) {
  return firstValue(row, [
    'name',
    'client_name',
    'customer_name',
    'data.name',
    'data.client_name',
    'data.client.name',
  ]) || 'PA EMËR';
}

function getTransportPhone(row) {
  return firstValue(row, [
    'phone',
    'client_phone',
    'data.phone',
    'data.client_phone',
    'data.client.phone',
  ]);
}

function getTransportAddress(row) {
  return firstValue(row, [
    'address',
    'adresa',
    'pickup_address',
    'data.address',
    'data.adresa',
    'data.pickup_address',
    'data.client.address',
  ]);
}

function stageHref(status, code, id = '') {
  const s = normalizeText(status);
  const c = encodeURIComponent(String(code || id || '').trim());
  if (s === 'pranim' || s === 'pranimi') return `/pranimi?q=${c}&from=home_search_local`;
  if (s === 'pastrim' || s === 'pastrimi' || s === 'cleaning') return `/pastrimi?q=${c}&from=home_search_local`;
  if (s === 'gati' || s === 'ready') return `/gati?q=${c}&from=home_search_local`;
  if (s === 'marrje' || s === 'marrje sot' || s === 'marrje_sot' || s === 'dorzim' || s === 'dorzuar' || s === 'delivered') return `/marrje-sot?q=${c}&from=home_search_local`;
  return `/pastrimi?q=${c}&from=home_search_local`;
}

function makeBaseResult(row) {
  const code = baseCode(row);
  const name = getBaseName(row);
  const phone = getBasePhone(row);
  const status = firstValue(row, ['status', 'data.status']) || 'pastrim';
  const id = String(row?.id || row?.local_oid || row?.oid || row?.data?.local_oid || '').trim();
  return {
    kind: 'BASE',
    id,
    code,
    name,
    phone,
    status,
    address: firstValue(row, ['address', 'data.address', 'data.client.address']),
    href: stageHref(status, code || id, id),
    updatedAt: updatedTime(row),
    raw: row,
  };
}

function makeTransportResult(row) {
  const code = transportCode(row);
  const name = getTransportName(row);
  const phone = getTransportPhone(row);
  const status = firstValue(row, ['status', 'data.status']) || 'transport';
  const id = String(row?.id || row?.local_oid || row?.oid || '').trim();
  const query = code ? `code=${encodeURIComponent(code)}` : `id=${encodeURIComponent(id)}`;
  return {
    kind: 'TRANSPORT',
    id,
    code,
    name,
    phone,
    status,
    address: getTransportAddress(row),
    href: `/transport/item?${query}&from=home_search_local`,
    updatedAt: updatedTime(row),
    raw: row,
  };
}

function matchScore(result, query) {
  const qText = normalizeText(query);
  const qPhone = normalizePhone(query);
  const qDigits = phoneDigits(query);
  const qCode = normalizeCode(query);
  const qIsTransport = isTransportCode(query);

  const code = normalizeCode(result.code);
  const name = normalizeText(result.name);
  const phone = normalizePhone(result.phone);
  const pDigits = phoneDigits(phone);
  const address = normalizeText(result.address);
  const status = normalizeText(result.status);

  let score = 0;

  if (qCode && code) {
    if (code === qCode) score += 120;
    else if (String(code).includes(String(qCode))) score += 45;
  }

  if (qIsTransport && result.kind === 'TRANSPORT') score += 12;
  if (!qIsTransport && /^\d+$/.test(qCode) && result.kind === 'BASE' && code === qCode) score += 15;

  if (qText && name) {
    if (name === qText) score += 80;
    else if (name.includes(qText)) score += 55;
    else if (qText.split(' ').filter(Boolean).every((part) => name.includes(part))) score += 42;
  }

  if (qText && address && address.includes(qText)) score += 18;
  if (qText && status && status.includes(qText)) score += 8;

  if (qPhone && phone) {
    if (phone === qPhone) score += 90;
    else if (phone.includes(qPhone) || qPhone.includes(phone)) score += 60;
  }
  if (qDigits.length >= 3 && pDigits) {
    if (pDigits.includes(qDigits) || qDigits.includes(pDigits)) score += 55;
    const tail = qDigits.slice(-8);
    if (tail.length >= 6 && pDigits.endsWith(tail)) score += 70;
    const tail6 = qDigits.slice(-6);
    if (tail6.length >= 6 && pDigits.endsWith(tail6)) score += 50;
  }

  return score;
}


function readGhostBlacklist() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]');
    return Array.isArray(parsed) ? parsed.map((x) => String(x || '')) : [];
  } catch {
    return [];
  }
}

function filterGhostRows(rows = []) {
  const blacklist = readGhostBlacklist();
  if (!blacklist.length) return rows;
  return rows.filter((row) => {
    const id = String(row?.id || row?.local_oid || row?.oid || row?.data?.local_oid || '').trim();
    return !id || !blacklist.includes(id);
  });
}

async function readBaseRows() {
  const rows = [];
  try {
    rows.push(...filterGhostRows(await getAllFromStore('orders')).filter((row) => !isTransportRow(row)));
  } catch {}
  rows.push(...readLocalStorageRows([
    'tepiha_base_master_cache_v1',
    'tepiha_local_orders_v1',
    'orders_v1',
    'order_list_v1',
  ]).filter((row) => !isTransportRow(row)));
  return dedupeRows(rows, 'base');
}

async function readTransportRows() {
  const rows = [];
  try { rows.push(...(await getAllFromStore('transport_orders'))); } catch {}
  try { rows.push(...filterGhostRows(await getAllFromStore('orders')).filter(isTransportRow)); } catch {}
  rows.push(...readLocalStorageRows([
    'transport_orders_offline_v1',
    'tepiha_transport_orders_v1',
    'transport_orders_v1',
  ]));
  return dedupeRows(rows, 'transport');
}

function writeSearchDiag(payload) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(HOME_SEARCH_DIAG_KEY, JSON.stringify(payload));
  } catch {}
}

export async function searchHomeLocal(query, { appVersion = '', epoch = '', limit = 12 } = {}) {
  const rawQuery = String(query || '').trim();
  const normalizedQuery = {
    text: normalizeText(rawQuery),
    phone: normalizePhone(rawQuery),
    code: normalizeCode(rawQuery),
  };

  const [baseRows, transportRows] = await Promise.all([readBaseRows(), readTransportRows()]);
  const baseResults = baseRows.map(makeBaseResult);
  const transportResults = transportRows.map(makeTransportResult);
  const all = [...baseResults, ...transportResults]
    .map((result) => ({ ...result, _score: matchScore(result, rawQuery) }))
    .filter((result) => result._score > 0)
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, Math.max(1, Number(limit) || 12));

  const diag = {
    query: rawQuery,
    normalizedQuery,
    timestamp: new Date().toISOString(),
    baseLocalCount: baseRows.length,
    transportLocalCount: transportRows.length,
    resultsCount: all.length,
    online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    appVersion,
    epoch,
  };
  writeSearchDiag(diag);

  return {
    query: rawQuery,
    normalizedQuery,
    baseLocalCount: baseRows.length,
    transportLocalCount: transportRows.length,
    results: all,
    diag,
  };
}
