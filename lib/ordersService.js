import { supabase } from '@/lib/supabaseClient';
import { normalizeOrderTable } from '@/lib/orderSource';
import { assertTransitionStatus, normalizeStatusForTable } from '@/lib/statusEngine';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';
import { normalizePranimiFinalOrderRow, isPranimiFinalOrderStatus } from './pranimiOrderLifecycle.js';

function resolveTable(input) {
  const table = normalizeOrderTable(input);
  if (!table) throw new Error('ORDER_TABLE_REQUIRED');
  return table;
}

function cleanPayload(payload) {
  const out = { ...(payload || {}) };
  delete out._table;
  delete out.table;
  delete out.source;
  delete out.__src;
  delete out.order_table;
  delete out.client;
  delete out.code_n;
  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });
  return out;
}

function isNumericDbId(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  const raw = String(value ?? '').trim();
  return /^\d+$/.test(raw);
}

function normalizeQueryId(table, value) {
  if (table === 'orders') {
    if (!isNumericDbId(value)) return null;
    return Number(String(value).trim());
  }
  const raw = String(value ?? '').trim();
  return raw || null;
}


function sanitizeTransportOrdersPayload(table, payload) {
  if (table !== 'transport_orders') return cleanPayload(payload);
  return sanitizeTransportOrderPayload(payload);
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function getDbTruthStatus(row = {}) {
  const top = String(row?.status ?? '').trim();
  if (top) return top;
  const data = isPlainObject(row?.data) ? row.data : {};
  return String(data?.status ?? '').trim();
}

async function fetchBaseOrderWriteContext(id) {
  try {
    const queryId = normalizeQueryId('orders', id);
    if (queryId === null) return null;
    const { data, error } = await supabase
      .from('orders')
      .select('id,status,data')
      .eq('id', queryId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (error) {
    throw error;
  }
}

async function normalizeBaseOrderWritePayload(table, id, patch = {}, { insert = false } = {}) {
  if (table !== 'orders') return patch;
  let out = { ...(patch || {}) };
  const hasStatus = hasOwn(out, 'status') && String(out?.status ?? '').trim() !== '';
  const hasData = isPlainObject(out?.data);

  if (insert) {
    const data = hasData ? { ...out.data } : {};
    const nextStatus = String(out?.status || data?.status || 'pastrim').trim();
    if (nextStatus) {
      out.status = nextStatus;
      out.data = { ...data, status: nextStatus };
    } else if (hasData) {
      out.data = data;
    }
    if (isPranimiFinalOrderStatus(out?.status || out?.data?.status)) {
      out = normalizePranimiFinalOrderRow(out, {
        status: out.status || out?.data?.status,
        localOid: out.local_oid || out?.data?.local_oid || '',
        saveAttemptId: out?.data?.pranimi_code_lifecycle?.save_attempt_id || out?.data?.save_attempt_id || '',
        verifyState: /LOCAL.*NOT.*SYNC|DB_VERIFY_FAILED/i.test(String(out?.data?.local_sync_status || out?.data?.pranimi_code_lifecycle?.db_verify_state || '')) ? (out?.data?.pranimi_code_lifecycle?.db_verify_state || out?.data?.local_sync_status) : 'DB_VERIFIED',
        source: out?.data?.source && String(out.data.source).startsWith('DB_FINAL') ? out.data.source : 'DB_FINAL',
        draftSource: out?.data?.pranimi_draft_source || 'FINAL / ORDERS SERVICE',
      });
    }
    return out;
  }

  if (!hasStatus && !hasData) return out;

  const current = await fetchBaseOrderWriteContext(id);
  const currentData = isPlainObject(current?.data) ? current.data : {};
  const dbStatus = getDbTruthStatus(current);
  const nextStatus = hasStatus ? String(out.status).trim() : dbStatus;
  const nextData = { ...currentData, ...(hasData ? out.data : {}) };

  if (nextStatus) nextData.status = nextStatus;
  if (hasStatus) out.status = nextStatus;
  if (hasData || hasStatus || dbStatus) out.data = nextData;
  if (isPranimiFinalOrderStatus(out?.status || out?.data?.status)) {
    out = normalizePranimiFinalOrderRow(out, {
      status: out.status || out?.data?.status,
      localOid: out?.local_oid || out?.data?.local_oid || current?.local_oid || '',
      saveAttemptId: out?.data?.pranimi_code_lifecycle?.save_attempt_id || out?.data?.save_attempt_id || '',
      verifyState: /LOCAL.*NOT.*SYNC|DB_VERIFY_FAILED/i.test(String(out?.data?.local_sync_status || out?.data?.pranimi_code_lifecycle?.db_verify_state || '')) ? (out?.data?.pranimi_code_lifecycle?.db_verify_state || out?.data?.local_sync_status) : 'DB_VERIFIED',
      source: out?.data?.source && String(out.data.source).startsWith('DB_FINAL') ? out.data.source : 'DB_FINAL',
      draftSource: out?.data?.pranimi_draft_source || 'FINAL / ORDERS SERVICE',
    });
  }
  return out;
}


const TRANSPORT_ASSIGN_WRITE_STATUSES = new Set(['assigned', 'inbox']);
const TRANSPORT_PRE_PICKUP_STATUSES = new Set(['', 'new', 'inbox', 'pending', 'scheduled', 'draft', 'pranim', 'dispatched', 'assigned']);
const TRANSPORT_PROTECTED_LIFECYCLE_STATUSES = new Set(['pickup', 'loaded', 'ngarkim', 'ngarkuar', 'at_base', 'in_base', 'base', 'pastrim', 'pastrimi', 'gati', 'depo', 'ne_depo', 'delivery', 'dorzim', 'dorëzim', 'done']);

function normalizeTransportLifecycleStatus(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'pastrimi') return 'pastrim';
  if (raw === 'pranimi') return 'pranim';
  if (raw === 'ngarkuar') return 'loaded';
  if (raw === 'dorezim' || raw === 'dorëzim') return 'dorzim';
  return raw;
}

async function protectTransportAssignStatusOverwrite(table, id, patch) {
  if (table !== 'transport_orders') return patch;
  const wanted = normalizeTransportLifecycleStatus(patch?.status);
  if (!TRANSPORT_ASSIGN_WRITE_STATUSES.has(wanted)) return patch;

  let currentStatus = '';
  try {
    const queryId = normalizeQueryId(table, id);
    if (queryId !== null) {
      const { data } = await supabase.from(table).select('status').eq('id', queryId).maybeSingle();
      currentStatus = normalizeTransportLifecycleStatus(data?.status || '');
    }
  } catch {}

  if (TRANSPORT_PROTECTED_LIFECYCLE_STATUSES.has(currentStatus) && !TRANSPORT_PRE_PICKUP_STATUSES.has(currentStatus)) {
    const safePatch = { ...(patch || {}) };
    delete safePatch.status;
    return safePatch;
  }
  return patch;
}

export async function fetchOrderById(tableInput, id, select = '*') {
  const table = resolveTable(tableInput);
  const queryId = normalizeQueryId(table, id);
  if (queryId === null) return null;
  const { data, error } = await supabase.from(table).select(select).eq('id', queryId).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function fetchOrderDataById(tableInput, id) {
  const row = await fetchOrderById(tableInput, id, 'data');
  return row?.data || null;
}

export async function listOrderRecords(tableInput, options = {}) {
  const table = resolveTable(tableInput);
  const select = options?.select || '*';
  let q = supabase.from(table).select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  const inFilters = options?.in || {};
  for (const [key, values] of Object.entries(inFilters)) q = q.in(key, Array.isArray(values) ? values : [values]);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.limit) q = q.limit(options.limit);
  if (options?.signal && typeof q?.abortSignal === 'function') {
    q = q.abortSignal(options.signal);
  }
  if (Number(options?.timeoutMs) > 0 && typeof q?.timeout === 'function') {
    q = q.timeout(Number(options.timeoutMs), String(options?.timeoutLabel || 'SUPABASE_TIMEOUT'));
  }
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updateOrderRecord(tableInput, id, patch = {}) {
  const table = resolveTable(tableInput);
  const guardedPatch = await protectTransportAssignStatusOverwrite(table, id, patch || {});
  const normalizedPatch = await normalizeBaseOrderWritePayload(table, id, { ...(guardedPatch || {}) }, { insert: false });
  const row = sanitizeTransportOrdersPayload(table, { ...(normalizedPatch || {}), updated_at: normalizedPatch?.updated_at || new Date().toISOString() });
  const { error } = await supabase.from(table).update(row).eq('id', id);
  if (error) throw error;
  return { ok: true, table, id };
}

export async function createOrderRecord(tableInput, row = {}) {
  const table = resolveTable(tableInput);
  const normalizedRow = await normalizeBaseOrderWritePayload(table, null, row, { insert: true });
  const payload = sanitizeTransportOrdersPayload(table, normalizedRow);
  const { data, error } = await supabase.from(table).insert(payload).select('id').maybeSingle();
  if (error) throw error;
  return { ok: true, table, id: data?.id ?? payload?.id ?? null };
}

export async function upsertOrderRecord(tableInput, row = {}, options = {}) {
  const table = resolveTable(tableInput);
  const normalizedRow = await normalizeBaseOrderWritePayload(table, null, row, { insert: true });
  const payload = sanitizeTransportOrdersPayload(table, normalizedRow);
  const { data, error } = await supabase.from(table).upsert(payload, options).select('id').maybeSingle();
  if (error) throw error;
  return { ok: true, table, id: data?.id ?? payload?.id ?? null };
}

export async function updateOrderData(tableInput, id, updater, extraPatch = {}) {
  const current = await fetchOrderById(tableInput, id, 'id,data,status');
  const currentData = (current?.data && typeof current.data === 'object') ? current.data : {};
  const nextData = typeof updater === 'function' ? (updater(currentData, current) || currentData) : { ...currentData, ...(updater || {}) };
  return updateOrderRecord(tableInput, id, { ...(extraPatch || {}), data: nextData });
}

export async function setOrderStatus(tableInput, id, status, extraPatch = {}) {
  const normalizedStatus = normalizeStatusForTable(tableInput, status) || status;
  return updateOrderRecord(tableInput, id, { ...(extraPatch || {}), status: normalizedStatus });
}

export async function transitionOrderStatus(tableInput, id, status, extraPatch = {}) {
  const table = resolveTable(tableInput);
  const current = await fetchOrderById(table, id, 'id,status,data,ready_at,updated_at');
  const normalizedStatus = normalizeStatusForTable(table, status) || status;
  assertTransitionStatus(table, current?.status, normalizedStatus);
  const patch = { ...(extraPatch || {}), status: normalizedStatus };
  if (normalizedStatus === 'gati' && patch.ready_at === undefined && !current?.ready_at) {
    patch.ready_at = new Date().toISOString();
  }
  return updateOrderRecord(table, id, patch);
}


export async function fetchOrderByIdSafe(tableInput, id, select = '*', options = {}) {
  const table = resolveTable(tableInput);
  const queryId = normalizeQueryId(table, id);
  if (queryId === null) return null;
  let q = supabase.from(table).select(select).eq('id', queryId).maybeSingle();
  if (Number(options?.timeoutMs) > 0 && typeof q?.timeout === 'function') {
    q = q.timeout(Number(options.timeoutMs), String(options?.timeoutLabel || 'SUPABASE_TIMEOUT'));
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || null;
}

export async function findLatestOrderByCode(tableInput, code, select = '*') {
  const table = resolveTable(tableInput);
  const raw = String(code || '').trim();
  if (!raw) return null;

  if (table === 'transport_orders') {
    const transportCode = String(raw).toUpperCase();
    let row = await fetchFirstMatch(table, { client_tcode: transportCode }, select);
    if (row) return row;
    row = await fetchFirstMatch(table, { code_str: transportCode }, select);
    return row || null;
  }

  const n = Number(String(raw).replace(/\D+/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return fetchFirstMatch(table, { code: n }, select);
}

async function fetchFirstMatch(table, eq, select = '*') {
  const rows = await listOrderRecords(table, {
    select,
    eq,
    orderBy: 'updated_at',
    ascending: false,
    limit: 1,
  });
  return rows?.[0] || null;
}


export async function updateOrderGps(tableInput, id, lat, lng) {
  const table = resolveTable(tableInput);
  const current = await fetchOrderById(table, id, 'id,data');
  const currentData = (current?.data && typeof current.data === 'object' && !Array.isArray(current.data)) ? current.data : {};
  const nextData = { ...currentData, gps_lat: lat, gps_lng: lng };
  const updatePayload = { gps_lat: lat, gps_lng: lng, data: nextData };
  try {
    return await updateOrderRecord(table, id, updatePayload);
  } catch (error) {
    const message = String(error?.message || '');
    if (/gps_lat|gps_lng|column/i.test(message)) {
      return updateOrderRecord(table, id, { data: nextData });
    }
    throw error;
  }
}

export async function resolveOrderById(id, sourceHint = '', select = '*') {
  const rawId = String(id || '').trim();
  const hint = String(sourceHint || '').trim().toLowerCase();
  if (!rawId) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
  const isNumericId = /^\d+$/.test(rawId);

  const tryTransport = async () => {
    try {
      const row = await fetchOrderByIdSafe('transport_orders', rawId, select);
      return row ? { table: 'transport_orders', row } : null;
    } catch {
      return null;
    }
  };
  const tryBase = async () => {
    try {
      const row = await fetchOrderByIdSafe('orders', rawId, select);
      return row ? { table: 'orders', row } : null;
    } catch {
      return null;
    }
  };
  const tryBaseByCode = async () => {
    try {
      const row = await findLatestOrderByCode('orders', rawId, select);
      return row ? { table: 'orders', row } : null;
    } catch {
      return null;
    }
  };
  const tryTransportByCode = async () => {
    try {
      const row = await findLatestOrderByCode('transport_orders', rawId, select);
      return row ? { table: 'transport_orders', row } : null;
    } catch {
      return null;
    }
  };

  if (hint === 'transport' || hint === 'transport_orders') {
    if (isNumericId) return (await tryTransportByCode()) || (await tryTransport());
    return tryTransport();
  }
  if (hint === 'base' || hint === 'orders') {
    if (isNumericId) return (await tryBase()) || (await tryBaseByCode());
    return null;
  }
  if (isUuid) return await tryTransport();
  if (isNumericId) return (await tryBaseByCode()) || (await tryBase()) || (await tryTransportByCode()) || (await tryTransport());
  return await tryTransport();
}


export async function listMixedOrderRecords(config = {}) {
  const tables = Array.isArray(config?.tables) && config.tables.length
    ? config.tables.map((t) => resolveTable(t))
    : ['orders', 'transport_orders'];
  const byTable = config?.byTable || {};
  const tasks = tables.map(async (table) => {
    const tableOptions = {
      ...(config || {}),
      ...(byTable[table] || {}),
    };
    const rows = await listOrderRecords(table, tableOptions);
    return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, _table: table }));
  });
  const groups = await Promise.all(tasks);
  return groups.flat();
}
