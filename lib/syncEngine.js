import { supabase } from '@/lib/supabaseClient';
import logger from '@/lib/logger';
import { bumpSyncCounter, syncDebugLog } from '@/lib/syncDebug';
import { clearPendingMutationsFromOp } from '@/lib/reconcile/pendingMutations';
import { isBaseScopedOp } from '@/lib/transportCore/scope';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

let offlineStoreModulePromise = null;
let syncRecoveryModulePromise = null;

function loadOfflineStoreModule() {
  if (!offlineStoreModulePromise) {
    offlineStoreModulePromise = import('@/lib/offlineStore').catch((error) => {
      offlineStoreModulePromise = null;
      throw error;
    });
  }
  return offlineStoreModulePromise;
}
function loadSyncRecoveryModule() {
  if (!syncRecoveryModulePromise) {
    syncRecoveryModulePromise = import('@/lib/syncRecovery').catch((error) => {
      syncRecoveryModulePromise = null;
      throw error;
    });
  }
  return syncRecoveryModulePromise;
}

async function deleteOp(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.deleteOp(...args);
}
async function deleteOrderLocal(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.deleteOrderLocal(...args);
}
async function getPendingOps(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.getPendingOps(...args);
}
async function pushOp(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.pushOp(...args);
}
async function saveOrderLocal(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.saveOrderLocal(...args);
}
function clearBaseCreateRecovery(...args) {
  void loadSyncRecoveryModule()
    .then((mod) => {
      if (typeof mod?.clearBaseCreateRecovery === 'function') mod.clearBaseCreateRecovery(...args);
    })
    .catch(() => {});
}
function rememberBaseCreateRecovery(...args) {
  void loadSyncRecoveryModule()
    .then((mod) => {
      if (typeof mod?.rememberBaseCreateRecovery === 'function') mod.rememberBaseCreateRecovery(...args);
    })
    .catch(() => {});
}

const SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
const LOCK_KEY = 'tepiha_sync_lock_v1';
const LOCK_TTL_MS = 45 * 1000;
const TAB_ID = `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const MAX_ATTEMPTS = 4;
const NETWORK_BACKOFF_MS = 60 * 1000;
const SOFT_BACKOFF_MS = 15 * 1000;
const HARD_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_DEBOUNCE_MS = 1200;

let running = null;
let isInitialized = false;
let scheduledTimer = null;
let scheduledPromise = null;
let scheduledResolve = null;
let lastScheduledOpts = null;
let snapshotWriteTimer = null;
let snapshotPayload = [];

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isOnline() {
  try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
}

function nowIso() {
  return new Date().toISOString();
}

function sortOps(ops = []) {
  return [...(Array.isArray(ops) ? ops : [])].sort((a, b) => {
    const aPaused = String(a?.status || '') === 'paused' ? 1 : 0;
    const bPaused = String(b?.status || '') === 'paused' ? 1 : 0;
    if (aPaused !== bPaused) return aPaused - bPaused;
    const aNext = Number(a?.nextRetryAt || 0);
    const bNext = Number(b?.nextRetryAt || 0);
    if (aNext !== bNext) return aNext - bNext;
    const aCreated = Date.parse(a?.created_at || a?.createdAt || 0) || 0;
    const bCreated = Date.parse(b?.created_at || b?.createdAt || 0) || 0;
    return aCreated - bCreated;
  });
}

function emitSyncStatus(syncing, extra = {}) {
  try {
    if (typeof window === 'undefined') return;
    const detail = { syncing: !!syncing, online: isOnline(), at: Date.now(), ...extra };
    window.dispatchEvent(new CustomEvent('tepiha:sync-status', {
      detail,
    }));
    syncDebugLog('probe_sync_status', detail);
  } catch {}
}

function mapOpToSnapshot(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
  const table = String(payload?.table || op?.table || payload?._table || '');
  return {
    id: String(op?.op_id || op?.id || rid()),
    op_id: String(op?.op_id || op?.id || rid()),
    kind: String(op?.type || op?.kind || op?.op || 'op'),
    status: String(op?.status || 'pending'),
    attempts: Number(op?.attempts || 0),
    createdAt: op?.created_at || nowIso(),
    uniqueValue: payload?.localId || payload?.id || payload?.local_oid || payload?.code || op?.id || '',
    lastError: op?.lastError || null,
    nextRetryAt: op?.nextRetryAt || null,
    payload,
    table,
  };
}

function scheduleSnapshotWrite(snapshot = []) {
  try {
    if (typeof window === 'undefined') return;
    snapshotPayload = Array.isArray(snapshot) ? snapshot : [];
    if (snapshotWriteTimer) {
      window.clearTimeout(snapshotWriteTimer);
      snapshotWriteTimer = null;
    }
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotPayload));
      window.dispatchEvent(new Event('tepiha:outbox-changed'));
    } catch {}
  } catch {}
}

async function refreshSnapshot() {
  try {
    const ops = sortOps(await getPendingOps()).filter((op) => isBaseScopedOp(op));
    const snapshot = ops.map(mapOpToSnapshot);
    if (typeof window !== 'undefined') {
      scheduleSnapshotWrite(snapshot);
    }
    return snapshot;
  } catch (error) {
    logger.warn('syncEngine.refreshSnapshot.failed', { error: String(error?.message || error || '') });
    return [];
  }
}

function getPayload(op) {
  return op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
}

function readLock() {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(LOCK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function acquireLock() {
  try {
    if (typeof window === 'undefined') return true;
    const now = Date.now();
    const current = readLock();
    if (
      current?.owner &&
      current.owner !== TAB_ID &&
      Number(current?.ts || 0) > 0 &&
      (now - Number(current.ts)) < LOCK_TTL_MS
    ) {
      return false;
    }
    window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: TAB_ID, ts: now }));
    const verify = readLock();
    return verify?.owner === TAB_ID;
  } catch {
    return true;
  }
}

function refreshLock() {
  try {
    if (typeof window === 'undefined') return;
    const current = readLock();
    if (current?.owner === TAB_ID) {
      window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: TAB_ID, ts: Date.now() }));
    }
  } catch {}
}

function releaseLock() {
  try {
    if (typeof window === 'undefined') return;
    const current = readLock();
    if (!current || current.owner === TAB_ID) {
      window.localStorage.removeItem(LOCK_KEY);
    }
  } catch {}
}

function getErrorText(error) {
  try {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return JSON.stringify({
      message: error?.message || '',
      details: error?.details || '',
      hint: error?.hint || '',
      code: error?.code || '',
      status: error?.status || '',
      name: error?.name || '',
    });
  } catch {
    return String(error || '');
  }
}

function isNetworkLikeError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function isStructuralSchemaError(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes('pgrst') ||
    text.includes('schema cache') ||
    text.includes('column') ||
    text.includes("could not find the 'data_patch' column") ||
    text.includes('does not exist')
  );
}


function validateOpShape(op = {}) {
  const type = String(op?.type || op?.op || '').trim();
  const payload = getPayload(op);
  if (type === 'insert_order') {
    const row = payload?.insertRow || payload || {};
    const table = String(row?.table || payload?.table || '').trim();
    const id = String(payload?.localId || row?.local_oid || row?.id || op?.id || '').trim();
    if (!table) return 'MISSING_TABLE';
    if (!id) return 'MISSING_ID';
  }
  if (type === 'set_status' || type === 'patch_order_data' || type === 'update') {
    const id = String(payload?.id || payload?.order_id || payload?.local_oid || op?.id || '').trim();
    if (!id) return 'MISSING_ID';
  }
  return '';
}

function shouldRetryYet(op = {}) {
  const nextRetryAt = Number(op?.nextRetryAt || 0);
  return !nextRetryAt || Date.now() >= nextRetryAt;
}

function buildRetriedOp(op = {}, error, { networkLike = false } = {}) {
  const attempts = Number(op?.attempts || 0) + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const waitMs = exhausted
    ? HARD_BACKOFF_MS
    : (networkLike ? NETWORK_BACKOFF_MS : SOFT_BACKOFF_MS * attempts);

  return {
    ...op,
    attempts,
    lastError: { message: String(error?.message || error || 'SYNC_FAILED'), at: nowIso() },
    nextRetryAt: Date.now() + waitMs,
    status: exhausted ? 'paused' : 'pending',
  };
}

function markFailedPermanently(op = {}, error) {
  return {
    ...op,
    status: 'failed_permanently',
    attempts: Number(op?.attempts || 0) + 1,
    nextRetryAt: null,
    lastError: {
      message: String(error?.message || error || 'STRUCTURAL_SYNC_ERROR'),
      at: nowIso(),
    },
  };
}

async function discardPermanentOp(op, error) {
  try {
    const failedOp = markFailedPermanently(op, error);
    logger.error('syncEngine.permanent-stop', { type: op?.type || op?.op, lastError: failedOp?.lastError || error });
  } catch {}
  try {
    await deleteOp(op?.op_id);
  } catch {}
}

async function upsertOrdersRow(table, row, onConflict = 'local_oid') {
  const payload = { ...(row || {}) };
  if (!payload.updated_at) payload.updated_at = nowIso();
  const q = supabase.from(table).upsert(payload, { onConflict }).select('id').maybeSingle();
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

function stripNonSchemaCols(row, table = 'orders') {
  if (!row || typeof row !== 'object') return row;
  const out = { ...(row || {}) };

  delete out.table;
  delete out.localOnly;
  delete out.kind;
  delete out.op;
  delete out.op_id;
  delete out.attempts;
  delete out.lastError;
  delete out.nextRetryAt;
  delete out.server_id;

  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });

  if ('client' in out) delete out.client;
  if ('code_n' in out) delete out.code_n;
  if ('data_patch' in out) delete out.data_patch;

  if (table === 'orders') {
    delete out.id;
    return out;
  }

  if (table === 'transport_orders') {
    return sanitizeTransportOrderPayload(out);
  }

  return out;
}

async function updateByIdOrLocalOid(table, id, patch) {
  const clean = stripNonSchemaCols({ ...(patch || {}) }, table);
  if (!clean.updated_at) clean.updated_at = nowIso();

  let res = await supabase.from(table).update(clean).eq('id', id).select('id').maybeSingle();
  if (!res.error && res.data) return res.data;

  if (table === 'orders') {
    res = await supabase.from(table).update(clean).eq('local_oid', id).select('id').maybeSingle();
    if (!res.error && res.data) return res.data;
  }

  if (res.error) throw res.error;
  return null;
}


function firstPresent(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value === false) return value;
    if (value == null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    return value;
  }
  return undefined;
}

function normalizeCode(...values) {
  const picked = firstPresent(...values);
  if (picked == null) return undefined;
  const text = String(picked).trim();
  if (!text) return undefined;
  return /^\d+$/.test(text) ? Number(text) : text;
}

function normalizeNumber(...values) {
  const picked = firstPresent(...values);
  if (picked == null) return undefined;
  const num = Number(picked);
  return Number.isFinite(num) ? num : undefined;
}

function normalizePhoneLoose(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.startsWith('383') ? digits.slice(3) : digits;
}

function normalizeNameLoose(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cloneOrderData(clean = {}, row = {}) {
  const fromClean = clean?.data && typeof clean.data === 'object' ? clean.data : null;
  const fromRow = row?.data && typeof row.data === 'object' ? row.data : null;
  return { ...(fromRow || {}), ...(fromClean || {}) };
}

function getOrderClientId(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  return String(
    row?.client_id ||
    row?.client_master_id ||
    data?.client_id ||
    data?.client_master_id ||
    client?.id ||
    ''
  ).trim();
}

function getOrderClientPhone(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  return normalizePhoneLoose(
    row?.client_phone ||
    row?.phone ||
    data?.client_phone ||
    data?.phone ||
    nestedOrder?.client_phone ||
    nestedOrder?.phone ||
    client?.phone ||
    ''
  );
}

function getOrderClientName(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  return normalizeNameLoose(
    row?.client_name ||
    row?.name ||
    data?.client_name ||
    data?.name ||
    nestedOrder?.client_name ||
    nestedOrder?.name ||
    client?.name ||
    ''
  );
}

function sameClientOwnerLoose(owner = {}, row = {}) {
  const ownerId = String(owner?.id || '').trim();
  const rowId = getOrderClientId(row);
  if (ownerId && rowId && ownerId === rowId) return true;

  const ownerPhone = normalizePhoneLoose(owner?.phone || '');
  const rowPhone = getOrderClientPhone(row);
  if (ownerPhone && rowPhone && ownerPhone === rowPhone) return true;

  const ownerName = normalizeNameLoose(
    owner?.full_name ||
    owner?.name ||
    [owner?.first_name, owner?.last_name].filter(Boolean).join(' ')
  );
  const rowName = getOrderClientName(row);
  if (ownerName && rowName && ownerName === rowName) return true;

  return false;
}

async function fetchClientOwnerByCodeForSync(codeNum) {
  const code = normalizeCode(codeNum);
  if (code == null) return null;

  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id,code,full_name,first_name,last_name,phone')
      .eq('code', code)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  } catch {}

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('client_id,client_name,client_phone,data,updated_at')
      .eq('code', code)
      .order('updated_at', { ascending: false })
      .limit(5);
    if (error) return null;
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const nested = row?.data && typeof row.data === 'object' ? row.data : {};
      const nestedClient = nested?.client && typeof nested.client === 'object' ? nested.client : {};
      const ownerId = String(row?.client_id || nested?.client_master_id || nestedClient?.id || '').trim();
      const ownerName = String(row?.client_name || nested?.client_name || nestedClient?.name || '').trim();
      const ownerPhone = String(row?.client_phone || nested?.client_phone || nestedClient?.phone || '').trim();
      if (!ownerId && !ownerName && !ownerPhone) continue;
      return {
        id: ownerId || null,
        code,
        full_name: ownerName || null,
        phone: ownerPhone || null,
      };
    }
  } catch {}

  return null;
}

function applyCanonicalOwnerToClean(clean = {}, row = {}, owner = {}) {
  const next = { ...(clean || {}) };
  const data = cloneOrderData(next, row);
  const existingClient = data?.client && typeof data.client === 'object' ? data.client : {};
  const ownerId = String(owner?.id || '').trim();
  const ownerName = String(
    owner?.full_name ||
    owner?.name ||
    [owner?.first_name, owner?.last_name].filter(Boolean).join(' ')
  ).trim();
  const ownerPhone = String(owner?.phone || '').trim();
  const code = normalizeCode(next?.code, row?.code, data?.code, existingClient?.code);

  if (ownerId) {
    next.client_id = ownerId;
    data.client_id = ownerId;
    data.client_master_id = ownerId;
  }
  if (ownerName) {
    next.client_name = ownerName;
    data.client_name = ownerName;
  }
  if (ownerPhone) {
    next.client_phone = ownerPhone;
    data.client_phone = ownerPhone;
  }
  if (code !== undefined) {
    next.code = code;
    data.code = code;
    data.client_code = code;
  }

  data.client = {
    ...existingClient,
    ...(ownerId ? { id: ownerId } : {}),
    ...(ownerName ? { name: ownerName } : {}),
    ...(ownerPhone ? { phone: ownerPhone } : {}),
    ...(code !== undefined ? { code } : {}),
  };

  next.data = data;
  return next;
}

async function canonicalizeOrderOwnerForInsert(table = 'orders', row = {}, clean = {}, { force = false } = {}) {
  if (table !== 'orders') return { ...(clean || {}) };

  let next = { ...(clean || {}) };
  const data = cloneOrderData(next, row);
  const rowClientId = getOrderClientId({ ...(row || {}), ...next, data });
  if (rowClientId && !next.client_id) next.client_id = rowClientId;
  next.data = data;

  const code = normalizeCode(next?.code, row?.code, data?.code, data?.client?.code);
  if (code == null) return next;

  const owner = await fetchClientOwnerByCodeForSync(code);
  if (!owner) return next;

  const sameOwner = sameClientOwnerLoose(owner, { ...(row || {}), ...next, data: next.data });
  if (!force && !sameOwner) return next;

  return applyCanonicalOwnerToClean(next, row, owner);
}

function isLikelyCodeOwnerConflict(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    (text.includes('kodi') && text.includes('lidhur me klient')) ||
    text.includes('klient tjetër') ||
    text.includes('duplicate key') ||
    text.includes('23505')
  );
}

function promoteBaseOrderColumns(clean = {}, row = {}) {
  const data = clean?.data && typeof clean.data === 'object'
    ? clean.data
    : (row?.data && typeof row.data === 'object' ? row.data : {});
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};

  const code = normalizeCode(
    clean?.code,
    row?.code,
    data?.code,
    nestedOrder?.code,
    client?.code,
  );
  if (code !== undefined) clean.code = code;

  const status = firstPresent(
    clean?.status,
    row?.status,
    data?.status,
    nestedOrder?.status,
  );
  if (status !== undefined) clean.status = status;

  const clientName = firstPresent(
    clean?.client_name,
    row?.client_name,
    data?.client_name,
    nestedOrder?.client_name,
    client?.name,
    data?.name,
    row?.name,
  );
  if (clientName !== undefined) clean.client_name = clientName;

  const clientPhone = firstPresent(
    clean?.client_phone,
    row?.client_phone,
    data?.client_phone,
    nestedOrder?.client_phone,
    client?.phone,
    data?.phone,
    row?.phone,
  );
  if (clientPhone !== undefined) clean.client_phone = clientPhone;

  const priceTotal = normalizeNumber(
    clean?.price_total,
    row?.price_total,
    data?.price_total,
    nestedOrder?.price_total,
    data?.total,
    nestedOrder?.total,
    data?.pay?.euro,
    nestedOrder?.pay?.euro,
  );
  if (priceTotal !== undefined) clean.price_total = priceTotal;

  return clean;
}

function describeInsertOp(op = {}) {
  const payload = getPayload(op);
  const row = payload?.insertRow || payload || {};
  const table = String(row?.table || payload?.table || 'orders');
  const clean = stripNonSchemaCols({ ...(row || {}) }, table);
  if (table === 'orders') promoteBaseOrderColumns(clean, row);
  const localId = String(payload?.localId || clean?.local_oid || row?.local_oid || row?.id || op?.id || '');
  return { payload, row, table, clean, localId };
}

async function findExistingRemoteOrder(table = 'orders', row = {}, clean = {}, localId = '') {
  if (table !== 'orders') return null;
  const candidates = [];
  const localOid = String(clean?.local_oid || row?.local_oid || localId || '').trim();
  if (localOid) candidates.push({ kind: 'field', field: 'local_oid', value: localOid });

  const rowId = String(row?.id || clean?.id || '').trim();
  if (rowId && /^\d+$/.test(rowId)) candidates.push({ kind: 'field', field: 'id', value: Number(rowId) });

  const idem = String(clean?.data?._idem || row?.data?._idem || row?._idem || '').trim();
  if (idem) candidates.push({ kind: 'json', field: 'data->>_idem', value: idem });

  const selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data';
  for (const candidate of candidates) {
    try {
      let query = supabase.from(table).select(selectCols);
      if (candidate.kind === 'json') query = query.filter(candidate.field, 'eq', candidate.value);
      else query = query.eq(candidate.field, candidate.value);
      const { data, error } = await query.maybeSingle();
      if (error) continue;
      if (data) return data;
    } catch {}
  }
  return null;
}

async function markInsertMirrorState(op = {}, extra = {}) {
  try {
    const type = String(op?.type || op?.op || '').trim();
    if (type !== 'insert_order') return;
    const { row, clean, table, localId } = describeInsertOp(op);
    if (!localId) return;
    await saveOrderLocal({
      ...row,
      ...clean,
      id: localId,
      local_oid: clean?.local_oid || row?.local_oid || localId,
      table,
      status: clean?.status || row?.status || '',
      data: row?.data || clean?.data || row,
      updated_at: nowIso(),
      _local: true,
      _synced: false,
      _syncPending: true,
      _syncing: false,
      _syncFailed: false,
      ...extra,
    });
  } catch {}
}

async function processOp(op) {
  const type = String(op?.type || op?.op || '').trim();
  const payload = getPayload(op);
  const data = op?.data && typeof op.data === 'object' ? op.data : {};

  if (type === 'insert_order') {
    const { row, table, localId } = describeInsertOp(op);
    let clean = stripNonSchemaCols({ ...(row || {}) }, table);
    if (table === 'orders') {
      promoteBaseOrderColumns(clean, row);
      clean = await canonicalizeOrderOwnerForInsert(table, row, clean);
    }

    if (table === 'orders' && localId && !clean.local_oid) {
      clean.local_oid = localId;
    }

    if (localId) {
      await markInsertMirrorState(op, {
        _syncing: true,
        _syncFailed: false,
        _syncError: null,
      });
    }

    const existingRemote = await findExistingRemoteOrder(table, row, clean, localId);
    if (existingRemote) {
      const existingId = String(existingRemote?.id || localId || '');
      await saveOrderLocal({
        ...row,
        ...clean,
        ...existingRemote,
        id: existingId || localId,
        local_oid: existingRemote?.local_oid || clean?.local_oid || row?.local_oid || localId || existingId,
        table,
        _local: false,
        _synced: true,
        _syncPending: false,
        _syncing: false,
        _syncFailed: false,
        _syncError: null,
        server_id: existingId || null,
        updated_at: nowIso(),
      });
      if (localId && existingId && localId !== existingId) {
        await deleteOrderLocal(localId);
      }
      return true;
    }

    let serverRow;
    try {
      serverRow = await upsertOrdersRow(table, clean, table === 'transport_orders' ? 'id' : 'local_oid');
    } catch (error) {
      if (table === 'orders' && isLikelyCodeOwnerConflict(error)) {
        const healedClean = await canonicalizeOrderOwnerForInsert(table, row, clean, { force: true });
        serverRow = await upsertOrdersRow(table, healedClean, 'local_oid');
        clean = healedClean;
        syncDebugLog('sync_insert_code_owner_healed', {
          id: String(localId || row?.local_oid || row?.id || ''),
          code: normalizeCode(healedClean?.code || row?.code || ''),
          client_id: String(healedClean?.client_id || healedClean?.data?.client_master_id || healedClean?.data?.client?.id || ''),
        });
      } else {
        throw error;
      }
    }
    const serverId = String(serverRow?.id || clean?.id || localId || '');

    await saveOrderLocal({
      ...row,
      ...clean,
      ...serverRow,
      id: serverId || localId,
      local_oid: clean?.local_oid || row?.local_oid || localId || serverId,
      table,
      _local: false,
      _synced: true,
      _syncPending: false,
      _syncing: false,
      _syncFailed: false,
      _syncError: null,
      server_id: serverId || null,
      updated_at: nowIso(),
    });

    if (localId && serverId && localId !== serverId) {
      await deleteOrderLocal(localId);
    }
    return true;
  }

  if (type === 'set_status') {
    const table = String(payload?.table || data?.table || 'orders');
    await updateByIdOrLocalOid(
      table,
      String(op?.id || payload?.id || payload?.local_oid || data?.id || data?.local_oid || ''),
      {
        status: payload?.status || op?.data?.status || data?.status,
        ...(payload?.data || {}),
      }
    );
    return true;
  }

  if (type === 'patch_order_data' || type === 'update') {
    const table = String(payload?.table || data?.table || 'orders');
    const id = String(
      payload?.id ||
      payload?.order_id ||
      payload?.local_oid ||
      data?.id ||
      data?.local_oid ||
      op?.id ||
      ''
    );

    const rawPatch =
      payload?.data && typeof payload.data === 'object'
        ? payload.data
        : (Object.keys(payload).length ? payload : data);

    const patch = stripNonSchemaCols({ ...(rawPatch || {}) }, table);
    if ('data_patch' in patch) delete patch.data_patch;

    await updateByIdOrLocalOid(table, id, patch);
    return true;
  }

  if (type === 'upload_storage') {
    const bucket = payload?.bucket;
    const path = payload?.path;
    const dataValue = payload?.data;
    if (bucket && path && dataValue != null) {
      const body = new Blob([String(dataValue)], { type: payload?.contentType || 'application/json' });
      const { error } = await supabase.storage.from(bucket).upload(path, body, { upsert: true });
      if (error) throw error;
    }
    return true;
  }

  return true;
}

function finishScheduledPromise(result) {
  try {
    if (typeof scheduledResolve === 'function') scheduledResolve(result);
  } catch {}
  scheduledResolve = null;
  scheduledPromise = null;
}

export function scheduleRunSync(opts = {}) {
  const delayMs = Number.isFinite(Number(opts?.delayMs)) ? Math.max(0, Number(opts.delayMs)) : AUTO_DEBOUNCE_MS;
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
  lastScheduledOpts = { ...(lastScheduledOpts || {}), ...(opts || {}) };
  if (!scheduledPromise) {
    scheduledPromise = new Promise((resolve) => {
      scheduledResolve = resolve;
    });
  }
  scheduledTimer = setTimeout(async () => {
    scheduledTimer = null;
    const pendingOpts = { ...(lastScheduledOpts || {}), scheduled: true };
    lastScheduledOpts = null;
    try {
      const result = await runSync(pendingOpts);
      finishScheduledPromise(result);
    } catch (error) {
      finishScheduledPromise({ ok: false, error: String(error?.message || error || 'SYNC_FAILED') });
    }
  }, delayMs);
  return scheduledPromise;
}

export async function runSync(_opts = {}) {
  if (running) return running;

  if (!acquireLock()) {
    emitSyncStatus(false, { skipped: 'locked' });
    bumpSyncCounter('lockedRuns', 1);
    const snapshot = await refreshSnapshot();
    syncDebugLog('sync_run_locked', { pending: snapshot.length });
    return { ok: false, locked: true, pending: snapshot.length };
  }

  running = (async () => {
    emitSyncStatus(true, { source: _opts?.source || 'unknown', manual: !!_opts?.manual });

    if (!isOnline()) {
      const snapshot = await refreshSnapshot();
      syncDebugLog('sync_run_skipped_offline', { pending: snapshot.length });
      return { ok: false, offline: true, pending: snapshot.length };
    }

    const ops = sortOps(await getPendingOps()).filter((op) => isBaseScopedOp(op));
    bumpSyncCounter('syncRuns', 1);
    syncDebugLog('sync_run_start', {
      source: String(_opts?.source || 'unknown'),
      manual: !!_opts?.manual,
      pending: ops.length,
      firstIds: ops.slice(0, 3).map((op) => String(op?.op_id || op?.id || '')),
    });
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let networkStop = false;
    let permanentStops = 0;

    for (const op of ops) {
      refreshLock();

      if (!shouldRetryYet(op)) {
        skipped += 1;
        continue;
      }

      const invalidReason = validateOpShape(op);
      if (invalidReason) {
        syncDebugLog('op_rejected_invalid_shape', {
          op_id: String(op?.op_id || ''),
          type: String(op?.type || op?.op || ''),
          reason: invalidReason,
          id: String(op?.id || getPayload(op)?.id || getPayload(op)?.local_oid || ''),
          table: String(getPayload(op)?.table || getPayload(op)?.insertRow?.table || ''),
        });
        await discardPermanentOp(op, new Error(invalidReason));
        permanentStops += 1;
        bumpSyncCounter('permanentStops', 1);
        continue;
      }

      try {
        await processOp(op);
        await deleteOp(op.op_id);
        try { clearPendingMutationsFromOp(op); } catch {}
        done += 1;
        bumpSyncCounter('successOps', 1);
        if (String(op?.type || op?.op || '').trim() === 'insert_order') {
          try { clearBaseCreateRecovery(getPayload(op)); } catch {}
        }
      } catch (e) {
        const networkLike = isNetworkLikeError(e) || !isOnline();
        const structural = isStructuralSchemaError(e);

        logger.error('syncEngine.op-error', {
          type: op?.type || op?.op,
          message: e?.message || String(e || ''),
          code: e?.code || '',
          details: e?.details || '',
          hint: e?.hint || '',
          at: nowIso(),
        });

        failed += 1;
        bumpSyncCounter('failedOps', 1);

        if (structural) {
          await markInsertMirrorState(op, {
            _syncing: false,
            _syncPending: false,
            _syncFailed: true,
            _syncError: String(e?.message || e || 'SYNC_FAILED'),
          });
          await discardPermanentOp(op, e);
          permanentStops += 1;
          bumpSyncCounter('permanentStops', 1);
          if (String(op?.type || op?.op || '').trim() === 'insert_order') {
            try { rememberBaseCreateRecovery(getPayload(op), { status: 'failed_permanently', source: 'syncEngine', note: String(e?.message || e || 'SYNC_FAILED'), terminal: true }); } catch {}
          }
          continue;
        }

        if (networkLike) {
          await markInsertMirrorState(op, {
            _syncing: false,
            _syncFailed: false,
            _syncError: String(e?.message || e || 'NETWORK_ERROR'),
          });
          const nextOp = buildRetriedOp(op, e, { networkLike: true });
          await pushOp(nextOp);
          networkStop = true;
          bumpSyncCounter('networkStops', 1);
          emitSyncStatus(true, { networkError: true, retryAt: nextOp.nextRetryAt });
          if (String(op?.type || op?.op || '').trim() === 'insert_order') {
            try { rememberBaseCreateRecovery(getPayload(op), { status: 'network_wait', source: 'syncEngine', note: String(e?.message || e || 'NETWORK_ERROR') }); } catch {}
          }
          break;
        }

        await markInsertMirrorState(op, {
          _syncing: false,
          _syncPending: false,
          _syncFailed: true,
          _syncError: String(e?.message || e || 'SYNC_FAILED'),
        });
        await discardPermanentOp(op, e);
        permanentStops += 1;
        bumpSyncCounter('permanentStops', 1);
        if (String(op?.type || op?.op || '').trim() === 'insert_order') {
          try { rememberBaseCreateRecovery(getPayload(op), { status: 'failed_permanently', source: 'syncEngine', note: String(e?.message || e || 'SYNC_FAILED') }); } catch {}
        }
      }
    }

    const snapshot = await refreshSnapshot();

    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('tepiha:sync-done'));
        window.dispatchEvent(new Event('tepiha:outbox-changed'));
      }
    } catch {}

    const result = {
      ok: failed === 0,
      done,
      failed,
      skipped,
      networkStop,
      permanentStops,
      pending: snapshot.length,
    };

    syncDebugLog('sync_run_done', result);
    return result;
  })().finally(() => {
    releaseLock();
    emitSyncStatus(false);
    running = null;
  });

  return running;
}

export function initSyncEngine() {
  if (isInitialized) return;
  isInitialized = true;
}

export async function getSyncSnapshot() {
  return await refreshSnapshot();
}
