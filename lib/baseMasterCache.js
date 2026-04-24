import { APP_DATA_EPOCH } from '@/lib/versionGuard';

const BASE_MASTER_CACHE_KEY = 'tepiha_base_master_cache_v1';
const BASE_MASTER_CACHE_VERSION = 1;
const ACTIVE_BASE_STATUSES = new Set(['pranim', 'pranimi', 'pastrim', 'pastrimi', 'gati', 'dorzim', 'marrje']);

let pendingCacheWrite = null;
let pendingCacheWriteTimer = null;
let pendingCacheWriteIdle = null;
let flushListenersInstalled = false;

function cancelPendingBaseCacheIdle() {
  if (!hasWindow()) return;
  try {
    if (pendingCacheWriteIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(pendingCacheWriteIdle);
    }
  } catch {}
  pendingCacheWriteIdle = null;
}

function flushPendingBaseCacheWrite() {
  if (!pendingCacheWrite) return null;
  const next = pendingCacheWrite;
  pendingCacheWrite = null;
  cancelPendingBaseCacheIdle();
  if (!hasWindow()) return next;
  try {
    window.localStorage.setItem(BASE_MASTER_CACHE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

function hasWindow() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function installFlushOnLeaveListeners() {
  if (flushListenersInstalled || !hasWindow()) return;
  flushListenersInstalled = true;
  const flush = () => {
    try { flushPendingBaseCacheWrite(); } catch {}
  };
  try { window.addEventListener('pagehide', flush, { capture: true }); } catch {}
  try { window.addEventListener('beforeunload', flush, { capture: true }); } catch {}
  try { window.addEventListener('offline', flush, { passive: true }); } catch {}
  try {
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.visibilityState === 'hidden') flush();
      } catch {}
    }, { passive: true });
  } catch {}
}

function emptyCache() {
  return {
    version: BASE_MASTER_CACHE_VERSION,
    epoch: APP_DATA_EPOCH,
    built_at: null,
    rows: [],
  };
}

export function getBaseMasterCacheKey() {
  return BASE_MASTER_CACHE_KEY;
}

export function safeParseBaseMasterCache(raw) {
  if (!raw) return emptyCache();
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const epoch = String(parsed?.epoch || '');
    if (epoch && epoch !== APP_DATA_EPOCH) return emptyCache();
    return {
      version: Number(parsed?.version || BASE_MASTER_CACHE_VERSION) || BASE_MASTER_CACHE_VERSION,
      epoch: APP_DATA_EPOCH,
      built_at: parsed?.built_at || null,
      rows,
    };
  } catch {
    return emptyCache();
  }
}

export function readBaseMasterCache() {
  if (pendingCacheWrite && Array.isArray(pendingCacheWrite?.rows)) return pendingCacheWrite;
  if (!hasWindow()) return emptyCache();
  try {
    const parsed = safeParseBaseMasterCache(window.localStorage.getItem(BASE_MASTER_CACHE_KEY));
    if (String(parsed?.epoch || '') !== APP_DATA_EPOCH) return emptyCache();
    return parsed;
  } catch {
    return emptyCache();
  }
}

export function clearBaseMasterCache() {
  pendingCacheWrite = null;
  if (pendingCacheWriteTimer) {
    try { clearTimeout(pendingCacheWriteTimer); } catch {}
    pendingCacheWriteTimer = null;
  }
  cancelPendingBaseCacheIdle();
  if (!hasWindow()) return emptyCache();
  try { window.localStorage.removeItem(BASE_MASTER_CACHE_KEY); } catch {}
  return emptyCache();
}

export function writeBaseMasterCache(cache) {
  installFlushOnLeaveListeners();
  const next = {
    version: BASE_MASTER_CACHE_VERSION,
    epoch: APP_DATA_EPOCH,
    built_at: new Date().toISOString(),
    rows: Array.isArray(cache?.rows) ? cache.rows : [],
  };
  if (!hasWindow()) return next;
  pendingCacheWrite = next;
  try {
    if (pendingCacheWriteTimer) clearTimeout(pendingCacheWriteTimer);
    cancelPendingBaseCacheIdle();
    pendingCacheWriteTimer = setTimeout(() => {
      pendingCacheWriteTimer = null;
      const commit = () => flushPendingBaseCacheWrite();
      try {
        if (typeof window.requestIdleCallback === 'function') {
          pendingCacheWriteIdle = window.requestIdleCallback(() => {
            pendingCacheWriteIdle = null;
            commit();
          }, { timeout: 1800 });
        } else {
          pendingCacheWriteIdle = window.setTimeout(() => {
            pendingCacheWriteIdle = null;
            commit();
          }, 250);
        }
      } catch {
        pendingCacheWriteIdle = null;
        commit();
      }
    }, 700);
  } catch {
    pendingCacheWriteTimer = null;
    cancelPendingBaseCacheIdle();
    flushPendingBaseCacheWrite();
  }
  return next;
}

export async function ensureFreshBaseMasterCache({ forceRebuild = false } = {}) {
  const current = readBaseMasterCache();
  const needsRebuild =
    forceRebuild ||
    String(current?.epoch || '') !== APP_DATA_EPOCH ||
    !Array.isArray(current?.rows) ||
    !current?.built_at;

  if (!needsRebuild) return current;

  clearBaseMasterCache();

  try {
    const { getAllOrdersLocal } = await import('@/lib/offlineStore');
    const orders = await getAllOrdersLocal();
    return rebuildBaseMasterCacheFromOrders(orders || []);
  } catch {
    return emptyCache();
  }
}

export function shouldIncludeBaseStatus(status) {
  return ACTIVE_BASE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCode(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  return digits || '';
}

function extractArray(obj, ...keys) {
  for (const key of keys) {
    if (Array.isArray(obj?.[key])) return obj[key];
  }
  return [];
}

function rowQty(row) {
  return toNumber(row?.qty ?? row?.pieces ?? 0);
}

function rowM2(row) {
  return toNumber(row?.m2 ?? row?.size ?? 0);
}

function computeM2(data = {}) {
  const tepiha = extractArray(data, 'tepiha', 'tepihaRows');
  const staza = extractArray(data, 'staza', 'stazaRows');
  const t = tepiha.reduce((sum, row) => sum + (rowM2(row) * Math.max(1, rowQty(row))), 0);
  const s = staza.reduce((sum, row) => sum + (rowM2(row) * Math.max(1, rowQty(row))), 0);
  const stairsQty = toNumber(data?.stairsQty ?? data?.shkallore?.qty ?? 0);
  const stairsPer = toNumber(data?.stairsPer ?? data?.shkallore?.per ?? 0);
  return Number((t + s + (stairsQty * stairsPer)).toFixed(2));
}

function computePieces(data = {}) {
  const tepiha = extractArray(data, 'tepiha', 'tepihaRows');
  const staza = extractArray(data, 'staza', 'stazaRows');
  const t = tepiha.reduce((sum, row) => sum + rowQty(row), 0);
  const s = staza.reduce((sum, row) => sum + rowQty(row), 0);
  const stairsQty = toNumber(data?.stairsQty ?? data?.shkallore?.qty ?? 0);
  return t + s + stairsQty;
}

export function getBaseRowIdentity(row) {
  const localOid = String(row?.local_oid || '').trim();
  if (localOid) return `local:${localOid}`;
  const id = String(row?.id || '').trim();
  if (id) return `id:${id}`;
  return '';
}

export function getBaseRowRank(row) {
  const status = String(row?.status || '').trim().toLowerCase();
  if (status === 'dorzim' || status === 'marrje') return 4;
  if (status === 'gati') return 3;
  if (status === 'pastrim' || status === 'pastrimi') return 2;
  if (status === 'pranim' || status === 'pranimi') return 1;
  return 0;
}

export function compareBaseRows(a, b) {
  const aDirty = !!a?.dirty;
  const bDirty = !!b?.dirty;
  if (aDirty !== bDirty) return aDirty ? 1 : -1;

  const aRank = getBaseRowRank(a);
  const bRank = getBaseRowRank(b);
  if (aRank !== bRank) return aRank > bRank ? 1 : -1;

  const aUpdated = Date.parse(a?.updated_at || a?.created_at || 0) || 0;
  const bUpdated = Date.parse(b?.updated_at || b?.created_at || 0) || 0;
  if (aUpdated !== bUpdated) return aUpdated > bUpdated ? 1 : -1;

  const aDb = !!a?.source?.db;
  const bDb = !!b?.source?.db;
  if (aDb !== bDb) return aDb ? 1 : -1;

  return 0;
}

export function normalizeBaseOrderRow(order) {
  const row = order && typeof order === 'object' ? { ...order } : null;
  if (!row) return null;

  const table = String(row?.table || row?._table || 'orders').trim() || 'orders';
  if (table !== 'orders') return null;

  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : row;
  const status = String(row?.status || data?.status || '').trim().toLowerCase();
  if (!shouldIncludeBaseStatus(status)) return null;

  const id = String(row?.id || data?.id || '').trim();
  const localOid = String(row?.local_oid || data?.local_oid || data?.oid || '').trim();
  const code = normalizeCode(row?.code || row?.code_n || data?.code || data?.client?.code || data?.client_code);
  const pieces = toNumber(row?.pieces, NaN);
  const totalM2 = toNumber(row?.m2_total, NaN);
  const totalPrice = toNumber(row?.price_total, NaN);
  const paidAmount = toNumber(row?.paid_cash, NaN);
  const structuredPieces = computePieces(data);
  const structuredM2 = computeM2(data);
  const hasStructuredMeasures = structuredPieces > 0 || structuredM2 > 0;

  const m2 = hasStructuredMeasures ? structuredM2 : (Number.isFinite(totalM2) ? totalM2 : computeM2(data));
  const cope = hasStructuredMeasures ? structuredPieces : (Number.isFinite(pieces) ? pieces : computePieces(data));
  const total = Number.isFinite(totalPrice) ? totalPrice : toNumber(row?.total ?? row?.price_total ?? data?.price_total ?? data?.pay?.euro ?? data?.total ?? 0);
  const paid = Number.isFinite(paidAmount) ? paidAmount : toNumber(row?.paid ?? data?.paid_cash ?? data?.pay?.paid ?? 0);
  const updatedAt = row?.updated_at || data?.updated_at || row?.ready_at || data?.ready_at || row?.delivered_at || data?.delivered_at || row?.created_at || data?.created_at || new Date().toISOString();
  const createdAt = row?.created_at || data?.created_at || updatedAt;
  const dirty = row?._synced === false || row?._local === true;

  return {
    id: id || localOid || '',
    local_oid: localOid || null,
    code: code || '',
    code_n: toNumber(code || 0, 0),
    table: 'orders',
    entity: 'base_order',
    status,
    updated_at: updatedAt,
    created_at: createdAt,
    synced: row?._synced !== false,
    pending_ops: toNumber(row?.pending_ops || 0, 0),
    dirty,
    client_name: row?.client_name || data?.client_name || data?.client?.name || '',
    client_phone: row?.client_phone || data?.client_phone || data?.client?.phone || '',
    client_photo_url: row?.client_photo_url || data?.client_photo_url || data?.client?.photoUrl || data?.client?.photo_url || '',
    pieces: cope,
    total_m2: Number(m2.toFixed(2)),
    total_price: Number(total.toFixed(2)),
    paid_amount: Number(paid.toFixed(2)),
    due_amount: Number(Math.max(0, total - paid).toFixed(2)),
    ready_note: String(data?.ready_note || data?.ready_location || data?.ready_note_text || row?.ready_note || ''),
    location_note: String(data?.ready_location || row?.ready_location || ''),
    delivered_at: row?.delivered_at || data?.delivered_at || null,
    source: {
      db: row?._synced !== false,
      idb: true,
      cache: true,
      outbox: false,
      local_shadow: false,
    },
    data,
  };
}

export function mergeBaseMasterRows(rows = []) {
  const byIdentity = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeBaseOrderRow(item) || (item && item.id ? item : null);
    if (!normalized) continue;
    const identity = getBaseRowIdentity(normalized);
    if (!identity) continue;
    const prev = byIdentity.get(identity);
    if (!prev || compareBaseRows(normalized, prev) >= 0) byIdentity.set(identity, normalized);
  }
  return Array.from(byIdentity.values()).sort((a, b) => {
    const bt = Date.parse(b?.updated_at || b?.created_at || 0) || 0;
    const at = Date.parse(a?.updated_at || a?.created_at || 0) || 0;
    return bt - at;
  });
}

export function patchBaseMasterRow(nextRow) {
  const normalized = normalizeBaseOrderRow(nextRow);
  if (!normalized) return readBaseMasterCache();
  const current = readBaseMasterCache();
  const rows = mergeBaseMasterRows([...(Array.isArray(current?.rows) ? current.rows : []), normalized]);
  return writeBaseMasterCache({ ...current, rows });
}

export function patchBaseMasterRows(nextRows = []) {
  const current = readBaseMasterCache();
  const rows = mergeBaseMasterRows([...(Array.isArray(current?.rows) ? current.rows : []), ...(Array.isArray(nextRows) ? nextRows : [])]);
  return writeBaseMasterCache({ ...current, rows });
}

export function removeBaseMasterRow(identityOrRow) {
  const identity = String(identityOrRow?.id ? getBaseRowIdentity(identityOrRow) : identityOrRow || '').trim();
  if (!identity) return readBaseMasterCache();
  const current = readBaseMasterCache();
  const rows = (Array.isArray(current?.rows) ? current.rows : []).filter((row) => getBaseRowIdentity(row) !== identity);
  return writeBaseMasterCache({ ...current, rows });
}

export function rebuildBaseMasterCacheFromOrders(orders = []) {
  const rows = mergeBaseMasterRows(Array.isArray(orders) ? orders : []);
  return writeBaseMasterCache({ version: BASE_MASTER_CACHE_VERSION, epoch: APP_DATA_EPOCH, rows });
}

export function getBaseRowsByStatus(status, cache = null) {
  const wanted = String(status || '').trim().toLowerCase();
  const source = cache && Array.isArray(cache?.rows) ? cache : readBaseMasterCache();
  return (Array.isArray(source?.rows) ? source.rows : []).filter((row) => String(row?.status || '').trim().toLowerCase() === wanted);
}

export function getBaseActiveRows(cache = null) {
  const source = cache && Array.isArray(cache?.rows) ? cache : readBaseMasterCache();
  return Array.isArray(source?.rows) ? source.rows : [];
}

function normalizeStatusScope(statusScope = []) {
  return new Set((Array.isArray(statusScope) ? statusScope : [statusScope]).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));
}

function isPersistedBaseId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function getBaseRowMatchTokens(row) {
  const normalized = normalizeBaseOrderRow(row) || row || {};
  const tokens = new Set();
  const localOid = String(normalized?.local_oid || normalized?.data?.local_oid || normalized?.data?.oid || '').trim();
  const id = String(normalized?.id || normalized?.data?.id || '').trim();
  if (localOid) tokens.add(`local:${localOid}`);
  if (id && isPersistedBaseId(id)) tokens.add(`id:${id}`);
  return Array.from(tokens);
}

function collectBasePresenceTokens(rows = []) {
  const tokens = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const token of getBaseRowMatchTokens(row)) tokens.add(token);
  }
  return tokens;
}

function collectBasePresenceState(rows = []) {
  const state = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pending = rowLooksPending(row);
    for (const token of getBaseRowMatchTokens(row)) {
      const prev = state.get(token) || { any: false, pending: false };
      prev.any = true;
      if (pending) prev.pending = true;
      state.set(token, prev);
    }
  }
  return state;
}

function collectOutboxPresenceTokens(items = []) {
  const tokens = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const payload = item?.payload && typeof item.payload === 'object' ? item.payload : item?.data && typeof item.data === 'object' ? item.data : {};
    const table = String(payload?.table || item?.table || payload?._table || '').trim() || 'orders';
    if (table !== 'orders') continue;
    const localOid = String(payload?.local_oid || payload?.data?.local_oid || payload?.oid || item?.id || '').trim();
    const id = String(payload?.id || payload?.data?.id || item?.id || '').trim();
    if (localOid) tokens.add(`local:${localOid}`);
    if (id && isPersistedBaseId(id)) tokens.add(`id:${id}`);
  }
  return tokens;
}

function rowLooksPending(row) {
  return !!(
    row?.dirty ||
    row?._local === true ||
    row?._synced === false ||
    row?._syncPending === true ||
    Number(row?.pending_ops || 0) > 0
  );
}

export function clearBaseMasterCacheScope(statusScope = []) {
  const wanted = normalizeStatusScope(statusScope);
  if (!wanted.size) return { cache: readBaseMasterCache(), removedRows: [], removedIds: [] };
  const current = readBaseMasterCache();
  const rows = Array.isArray(current?.rows) ? current.rows : [];
  const removedRows = [];
  const nextRows = rows.filter((row) => {
    const status = String(row?.status || '').trim().toLowerCase();
    const shouldRemove = wanted.has(status);
    if (shouldRemove) removedRows.push(row);
    return !shouldRemove;
  });
  const cache = nextRows.length === rows.length ? current : writeBaseMasterCache({ ...current, rows: nextRows });
  const removedIds = Array.from(new Set(removedRows.flatMap((row) => {
    const id = String(row?.id || '').trim();
    const localOid = String(row?.local_oid || '').trim();
    return [id, localOid].filter(Boolean);
  })));
  return { cache, removedRows, removedIds };
}

export function reconcileBaseMasterCacheScope({ statusScope = [], dbRows = [], localRows = [], outboxItems = [] } = {}) {
  const wanted = normalizeStatusScope(statusScope);
  const current = readBaseMasterCache();
  const rows = Array.isArray(current?.rows) ? current.rows : [];
  if (!wanted.size || !rows.length) return { cache: current, removedRows: [], removedIds: [] };

  const dbTokens = collectBasePresenceTokens(dbRows);
  const localState = collectBasePresenceState(localRows);
  const outboxTokens = collectOutboxPresenceTokens(outboxItems);
  const removedRows = [];

  const nextRows = rows.filter((row) => {
    const status = String(row?.status || '').trim().toLowerCase();
    if (!wanted.has(status)) return true;

    if (rowLooksPending(row)) return true;

    const matchTokens = getBaseRowMatchTokens(row);
    if (!matchTokens.length) return true;

    const existsInDb = matchTokens.some((token) => dbTokens.has(token));
    if (existsInDb) return true;

    const existsInOutbox = matchTokens.some((token) => outboxTokens.has(token));
    if (existsInOutbox) return true;

    const localHasPendingMatch = matchTokens.some((token) => localState.get(token)?.pending);
    if (localHasPendingMatch) return true;

    const persistedId = String(row?.id || row?.data?.id || '').trim();
    const isPersistedRow = isPersistedBaseId(persistedId);
    const existsLocally = matchTokens.some((token) => localState.get(token)?.any);

    if (!isPersistedRow && existsLocally) return true;

    removedRows.push(row);
    return false;
  });

  const cache = nextRows.length === rows.length ? current : writeBaseMasterCache({ ...current, rows: nextRows });
  const removedIds = Array.from(new Set(removedRows.flatMap((row) => {
    const id = String(row?.id || '').trim();
    const localOid = String(row?.local_oid || '').trim();
    return [id, localOid].filter(Boolean);
  })));
  return { cache, removedRows, removedIds };
}
