import { supabase, storageWithTimeout } from '@/lib/supabaseClient';
import {
  clearStore,
  createSecureId,
  deleteByKey,
  getAllFromStore,
  getByKey,
  getEarliestFromIndex,
  openAppDb,
  putValue,
} from '@/lib/localDb';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';
import { insertTransportOrder } from '@/lib/transport/transportDb';

const BASE_MASTER_CACHE_KEY = 'tepiha_base_master_cache_v1';

function getBaseMasterCacheKeyLocal() {
  return BASE_MASTER_CACHE_KEY;
}

function dispatchBaseMasterCachePatch(row) {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('tepiha:base-master-cache:patch', {
      detail: { row },
    }));
  } catch {}
}

function dispatchBaseMasterCacheRemove(identity) {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('tepiha:base-master-cache:remove', {
      detail: { identity },
    }));
  } catch {}
}

const LEGACY_QUEUE_KEYS = [
  'tepiha_offline_queue_v1',
  'tepiha_offline_queue_mirror_v1',
  'offline_queue_mirror_v1',
];

let queueProcessing = false;
let legacyOnlineKickTimer = null;

function isBigintLikeId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function normalizeCreatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (raw) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
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

async function fetchBaseRowForWrite(id) {
  const rawId = String(id || '').trim();
  if (!rawId) return null;
  let q = supabase.from('orders').select('id,status,data');
  q = isBigintLikeId(rawId) ? q.eq('id', Number(rawId)) : q.eq('local_oid', rawId);
  const { data, error } = await q.maybeSingle();
  if (error) throw makeSupabaseError(error, error?.status);
  return data || null;
}

function normalizeBaseInsertPayload(row = {}) {
  const out = { ...(row || {}) };
  const data = isPlainObject(out?.data) ? { ...out.data } : {};
  const nextStatus = String(out?.status || data?.status || 'pastrim').trim();
  if (nextStatus) {
    out.status = nextStatus;
    out.data = { ...data, status: nextStatus };
  }
  return out;
}

async function normalizeBasePatchForWrite(id, patch = {}) {
  const out = { ...(patch || {}) };
  const hasStatus = hasOwn(out, 'status') && String(out?.status ?? '').trim() !== '';
  const hasData = isPlainObject(out?.data);
  if (!hasStatus && !hasData) return out;

  const current = await fetchBaseRowForWrite(id);
  const currentData = isPlainObject(current?.data) ? current.data : {};
  const dbStatus = getDbTruthStatus(current);
  const nextStatus = hasStatus ? String(out.status).trim() : dbStatus;
  const nextData = { ...currentData, ...(hasData ? out.data : {}) };
  if (nextStatus) nextData.status = nextStatus;
  if (hasStatus) out.status = nextStatus;
  if (hasData || hasStatus || dbStatus) out.data = nextData;
  return out;
}

function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (!isPlainObject(a) || !isPlainObject(b)) return b;
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (Array.isArray(value)) out[key] = value.slice();
    else if (isPlainObject(value) && isPlainObject(prev)) out[key] = deepMerge(prev, value);
    else if (isPlainObject(value)) out[key] = deepMerge({}, value);
    else out[key] = value;
  }
  return out;
}

function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function normalizeOp(op = {}) {
  const payload = isPlainObject(op?.payload) ? { ...op.payload } : {};
  const legacyData = isPlainObject(op?.data) ? { ...op.data } : null;
  if (legacyData && !Object.keys(payload).length) Object.assign(payload, legacyData);

  return {
    ...op,
    op_id: String(op?.op_id || createSecureId('op')),
    type: String(op?.type || op?.op || 'update'),
    kind: String(op?.kind || op?.type || op?.op || 'update'),
    created_at: normalizeCreatedAt(op?.created_at),
    attempts: Number(op?.attempts || 0),
    status: String(op?.status || 'pending'),
    id: op?.id ?? payload?.id ?? null,
    payload,
  };
}

function sortOps(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const aCreated = Date.parse(a?.created_at || 0) || 0;
    const bCreated = Date.parse(b?.created_at || 0) || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.op_id || '').localeCompare(String(b?.op_id || ''));
  });
}

async function moveOpToDeadLetter(op, err) {
  const dead = {
    dead_id: createSecureId('dead'),
    original_op_id: String(op?.op_id || ''),
    created_at: Date.now(),
    op,
    error: serializeError(err),
  };
  await putValue('offline_ops_dead_letter', dead);
  await deleteByKey('ops', op.op_id);
  return dead;
}

function buildOpSafetySummary(op = {}) {
  const payload = isPlainObject(op?.payload) ? op.payload : {};
  const data = isPlainObject(payload?.data) ? payload.data : {};
  const life = isPlainObject(data?.pranimi_code_lifecycle) ? data.pranimi_code_lifecycle : {};
  const client = isPlainObject(data?.client) ? data.client : {};
  return {
    local_oid: String(payload?.local_oid || data?.local_oid || life?.local_oid || op?.id || ''),
    save_attempt_id: String(life?.save_attempt_id || data?.save_attempt_id || payload?.save_attempt_id || ''),
    op_id: String(op?.op_id || ''),
    worker_pin: String(life?.pin || payload?.worker_pin || data?.worker_pin || ''),
    code: payload?.code ?? data?.code ?? client?.code ?? '',
    client_name: String(payload?.client_name || data?.client_name || client?.name || ''),
    client_phone: String(payload?.client_phone || data?.client_phone || client?.phone || ''),
    pieces: payload?.pieces ?? data?.pieces ?? data?.totals?.pieces ?? '',
    m2_total: payload?.m2_total ?? data?.m2_total ?? data?.totals?.m2 ?? data?.pay?.m2 ?? '',
    amount: payload?.price_total ?? data?.price_total ?? data?.totals?.euro ?? data?.pay?.euro ?? '',
  };
}

export async function markOpFailedPermanently(op = {}, err, opts = {}) {
  const normalized = normalizeOp(op);
  const now = new Date().toISOString();
  const error = serializeError(err);
  const attempts = Number(normalized?.attempts || 0) + (opts?.incrementAttempts === false ? 0 : 1);
  const summary = buildOpSafetySummary(normalized);
  const failed = {
    ...normalized,
    status: String(opts?.status || 'failed_permanently'),
    attempts,
    retry_count: attempts,
    nextRetryAt: null,
    failed_at: now,
    lastError: { ...error, at: now },
    last_error: { ...error, at: now },
    sync_safety: {
      ...(isPlainObject(normalized?.sync_safety) ? normalized.sync_safety : {}),
      preserve_payload: true,
      failed_at: now,
      reason: String(error?.message || err || 'SYNC_FAILED'),
      summary,
    },
    payload: isPlainObject(normalized?.payload) ? normalized.payload : {},
  };

  await putValue('ops', failed);

  // Keep an audit copy too, but DO NOT remove the main op from `ops`.
  try {
    await putValue('offline_ops_dead_letter', {
      dead_id: `dead_${String(failed.op_id || createSecureId('op'))}`,
      original_op_id: String(failed?.op_id || ''),
      created_at: Date.now(),
      status: failed.status,
      failed_at: now,
      op: failed,
      payload: failed.payload,
      error,
      summary,
    });
  } catch {}

  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tepiha:outbox-changed'));
      window.dispatchEvent(new CustomEvent('tepiha:sync-dead-letter-created', { detail: { op_id: failed.op_id, summary } }));
    }
  } catch {}

  return failed;
}

function makeSupabaseError(error, status) {
  const e = new Error(error?.message || 'Supabase request failed');
  e.status = Number(status || error?.status || 500);
  e.code = error?.code;
  e.details = error?.details;
  e.hint = error?.hint;
  return e;
}

function classifyQueueError(err) {
  const status = Number(err?.status || 0);
  const msg = String(err?.message || '').toLowerCase();

  if (
    err?.name === 'AbortError' ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    status === 0
  ) {
    return 'network';
  }

  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'client';
  }

  return 'server';
}

function serializeError(err) {
  return {
    name: err?.name || 'Error',
    message: err?.message || 'Unknown error',
    status: err?.status || null,
    code: err?.code || null,
    details: err?.details || null,
    at: Date.now(),
  };
}

function orderIdentityCandidates(row = {}) {
  const data = isPlainObject(row?.data) ? row.data : {};
  const set = new Set();
  const id = String(row?.id || '').trim();
  const localOid = String(row?.local_oid || row?.oid || data?.local_oid || '').trim();
  const idem = String(row?._idem || data?._idem || '').trim();
  if (localOid) set.add(`local:${localOid}`);
  if (id) set.add(`id:${id}`);
  if (idem) set.add(`idem:${idem}`);
  return set;
}

function insertOpTable(op = {}, fallbackRow = null) {
  const payload = isPlainObject(op?.payload) ? op.payload : {};
  const insertRow = isPlainObject(payload?.insertRow) ? payload.insertRow : payload;
  return String(insertRow?.table || payload?.table || fallbackRow?.table || op?.table || 'orders').trim();
}

function insertOpRow(op = {}) {
  const payload = isPlainObject(op?.payload) ? op.payload : {};
  return isPlainObject(payload?.insertRow) ? payload.insertRow : payload;
}

function stripSyncMetaFields(obj = {}, table = '') {
  if (!isPlainObject(obj)) return obj;
  const out = { ...(obj || {}) };
  const tableName = String(table || out?.table || out?._table || '').trim();
  delete out.table;
  delete out._table;
  delete out.localOnly;
  delete out.kind;
  delete out.op;
  delete out.op_id;
  delete out.attempts;
  delete out.lastError;
  delete out.nextRetryAt;
  delete out.server_id;
  delete out.client;
  delete out.code_n;
  delete out.data_patch;
  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });
  if (tableName === 'orders') delete out.id;
  if (tableName === 'transport_orders') return sanitizeTransportOrderPayload(out);
  return out;
}

function sameInsertTarget(a = {}, b = {}) {
  if (String(a?.type || a?.op || '').trim() !== 'insert_order') return false;
  if (String(b?.type || b?.op || '').trim() !== 'insert_order') return false;
  if (insertOpTable(a) !== insertOpTable(b)) return false;
  const aKeys = orderIdentityCandidates(insertOpRow(a));
  const bKeys = orderIdentityCandidates(insertOpRow(b));
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
}

function opMatchesOrder(op, row) {
  if (String(op?.type || op?.op || '').trim() !== 'insert_order') return false;
  const table = insertOpTable(op, row);
  if (table !== 'orders') return false;
  const a = orderIdentityCandidates(insertOpRow(op));
  const b = orderIdentityCandidates(row);
  for (const key of a) {
    if (b.has(key)) return true;
  }
  return false;
}

export async function patchPendingCreateOpsForOrder(order) {
  const row = isPlainObject(order) ? order : null;
  if (!row) return false;

  const items = await getAllFromStore('ops');
  const updates = [];

  for (const raw of Array.isArray(items) ? items : []) {
    const op = normalizeOp(raw);
    if (!opMatchesOrder(op, row)) continue;

    const payload = isPlainObject(op?.payload) ? { ...op.payload } : {};
    const insertRow = isPlainObject(payload?.insertRow) ? { ...payload.insertRow } : { ...payload };
    const merged = {
      ...insertRow,
      ...row,
      table: 'orders',
      id: String(row?.id || insertRow?.id || row?.local_oid || insertRow?.local_oid || ''),
      local_oid: String(row?.local_oid || insertRow?.local_oid || row?.id || insertRow?.id || ''),
      updated_at: row?.updated_at || new Date().toISOString(),
    };

    updates.push({
      ...op,
      id: merged.local_oid || merged.id || op?.id || null,
      payload: { ...payload, ...merged, table: 'orders' },
    });
  }

  await Promise.all(updates.map((nextOp) => putValue('ops', nextOp)));
  return updates.length > 0;
}

export async function resetOfflineDerivedState(opts = {}) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const exactKeys = [];
      if (opts.clearBaseMasterCache !== false) exactKeys.push(getBaseMasterCacheKeyLocal());
      if (opts.clearSyncSnapshot !== false) exactKeys.push('tepiha_sync_snapshot_v1', 'tepiha_sync_lock_v1');
      if (opts.clearLegacyQueueMirrors !== false) exactKeys.push(...LEGACY_QUEUE_KEYS, 'tepiha_local_orders_v1');
      for (const key of exactKeys) {
        try { window.localStorage.removeItem(key); } catch {}
      }

      if (opts.clearLegacyOrderMirrors !== false) {
        const toRemove = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (!key) continue;
          if (key.startsWith('order_') || key.startsWith('tepiha_delivered_')) toRemove.push(key);
        }
        for (const key of toRemove) {
          try { window.localStorage.removeItem(key); } catch {}
        }
      }
    }
  } catch {}

  if (opts.clearDeadLetter === true) {
    try { await clearStore('offline_ops_dead_letter'); } catch {}
  }

  return true;
}

async function uploadStoragePayload(payload = {}) {
  const bucket = String(payload?.bucket || '').trim();
  const path = String(payload?.path || '').trim();
  const data = payload?.data;
  const contentType = String(payload?.contentType || 'application/octet-stream');
  if (!bucket || !path || data == null) {
    const e = new Error('INVALID_UPLOAD_STORAGE_PAYLOAD');
    e.status = 400;
    throw e;
  }

  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const { error } = await storageWithTimeout(supabase.storage.from(bucket).upload(path, body, {
    upsert: true,
    contentType,
  }), 10000, 'OFFLINE_STORE_UPLOAD_STORAGE_TIMEOUT', { bucket, path });
  if (error) throw makeSupabaseError(error, error?.status);
  return { ok: true };
}

async function sendOpToSupabase(op) {
  const type = String(op?.type || '').trim();
  const payload = isPlainObject(op?.payload) ? op.payload : {};

  if (type === 'insert_order') {
    const row = payload?.insertRow || payload;
    const table = String(row?.table || payload?.table || 'orders').trim() || 'orders';
    let clean = stripSyncMetaFields({ ...(row || {}) }, table);
    if (table === 'orders' && !clean.local_oid) {
      clean.local_oid = String(row?.local_oid || row?.id || '').trim() || null;
    }
    if (table === 'orders') clean = normalizeBaseInsertPayload(clean);
    if (table === 'transport_orders') {
      const result = await insertTransportOrder(clean);
      if (!result?.ok) {
        const error = new Error(result?.error || 'TRANSPORT_ORDER_OFFLINE_SYNC_FAILED');
        error.code = result?.code || '';
        throw error;
      }
      return { ok: true, data: result.data || null };
    }
    const { error } = await supabase.from(table).upsert(clean, { onConflict: 'local_oid' });
    if (error) throw makeSupabaseError(error, error?.status);
    return { ok: true };
  }

  if (type === 'patch_order_data') {
    const table = String(payload?.table || op?.data?.table || 'orders').trim() || 'orders';
    const id = String(op?.id || payload?.id || payload?.local_oid || '').trim();
    let patch = stripSyncMetaFields({ ...(payload || {}) }, table);
    delete patch.table;
    delete patch.id;
    delete patch.local_oid;
    if (table === 'orders') patch = await normalizeBasePatchForWrite(id, patch);
    if (!id) {
      const e = new Error('MISSING_ID');
      e.status = 400;
      throw e;
    }
    let res = null;
    if (table === 'orders' && !isBigintLikeId(id)) {
      res = await supabase.from(table).update(patch).eq('local_oid', id);
    } else {
      res = await supabase.from(table).update(patch).eq('id', id);
      if (res?.error && table === 'orders') {
        res = await supabase.from(table).update(patch).eq('local_oid', id);
      }
    }
    if (res?.error) throw makeSupabaseError(res.error, res.error?.status);
    return { ok: true };
  }

  if (type === 'set_status') {
    const id = String(op?.id || payload?.id || payload?.local_oid || '').trim();
    const status = String(payload?.status || op?.data?.status || '').trim();
    const table = String(payload?.table || 'orders').trim() || 'orders';
    if (!id || !status) {
      const e = new Error('INVALID_SET_STATUS_PAYLOAD');
      e.status = 400;
      throw e;
    }
    let patch = { status, updated_at: new Date().toISOString() };
    if (table === 'orders') patch = await normalizeBasePatchForWrite(id, patch);
    let res = null;
    if (table === 'orders' && !isBigintLikeId(id)) {
      res = await supabase.from(table).update(patch).eq('local_oid', id);
    } else {
      res = await supabase
        .from(table)
        .update(patch)
        .eq('id', id);
      if (res?.error && table === 'orders') {
        res = await supabase.from(table).update(patch).eq('local_oid', id);
      }
    }
    if (res?.error) throw makeSupabaseError(res.error, res.error?.status);
    return { ok: true };
  }

  if (type === 'upload_storage') {
    return uploadStoragePayload(payload);
  }

  const e = new Error(`UNKNOWN_QUEUE_OP:${type}`);
  e.status = 400;
  throw e;
}

function isNumericStoreId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function derivePreferredLocalOid(order = {}, existing = {}, fallbackId = '') {
  const candidates = [
    order?.local_oid,
    order?.data?.local_oid,
    order?.oid,
    order?.data?.oid,
    existing?.local_oid,
    existing?.data?.local_oid,
    existing?.oid,
    existing?.data?.oid,
    fallbackId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const preferred = candidates.find((value) => value && !isNumericStoreId(value));
  return preferred || candidates[0] || '';
}

export async function saveOrderLocal(order, skipMasterCache = false) {
  const id = String(order?.id ?? order?.local_oid ?? order?.oid ?? '').trim();
  if (!id) return false;

  const existing = (await getByKey('orders', id)) || {};
  const existingData = isPlainObject(existing?.data) ? existing.data : {};
  const incoming = isPlainObject(order) ? order : {};
  const incomingData = isPlainObject(incoming?.data) ? incoming.data : null;
  const nextLocalOid = derivePreferredLocalOid(incoming, existing, id);

  const next = {
    ...existing,
    ...incoming,
    id,
    local_oid: nextLocalOid || id,
    table: incoming?.table || incoming?._table || existing?.table || 'orders',
    updated_at: incoming?.updated_at || existing?.updated_at || new Date().toISOString(),
  };

  if (incomingData) next.data = deepMerge(existingData, incomingData);
  else if (Object.keys(existingData).length) next.data = existingData;

  if (String(next?.table || 'orders').trim() === 'orders') {
    const effectiveStatus = getDbTruthStatus(next);
    if (effectiveStatus) {
      next.status = String(next?.status || effectiveStatus).trim() || effectiveStatus;
      next.data = { ...(isPlainObject(next.data) ? next.data : {}), status: effectiveStatus };
    }
  }

  if (isPlainObject(next.data)) {
    if (!String(next.data?.local_oid || '').trim() && nextLocalOid) next.data.local_oid = nextLocalOid;
    if (!String(next.data?.oid || '').trim() && nextLocalOid) next.data.oid = nextLocalOid;
  }

  await putValue('orders', next);
  try { await patchPendingCreateOpsForOrder(next); } catch {}
  if (!skipMasterCache) {
    try { dispatchBaseMasterCachePatch(next); } catch {}
  }
  return true;
}

export async function deleteOrderLocal(id) {
  const key = String(id || '').trim();
  if (!key) return false;
  await deleteByKey('orders', key);
  try { dispatchBaseMasterCacheRemove(`id:${key}`); } catch {}
  try { dispatchBaseMasterCacheRemove(`local:${key}`); } catch {}
  return true;
}

export async function removeOrderLocal(id) {
  return deleteOrderLocal(id);
}

export async function getAllOrdersLocal() {
  const rows = await getAllFromStore('orders');
  const blacklist = safeReadLocalStorageJson('tepiha_ghost_blacklist', []);
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const id = String(row?.id || row?.local_oid || row?.oid || '');
    if (!id || blacklist.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

export async function saveOrdersLocal(rows = [], options = {}) {
  const items = Array.isArray(rows) ? rows : [];
  const skipMasterCache = options?.skipMasterCache !== false;
  let saved = 0;
  for (const row of items) {
    try {
      const ok = await saveOrderLocal(row, skipMasterCache);
      if (ok) saved += 1;
    } catch {}
  }
  return saved;
}

export async function pushOp(op) {
  const normalized = normalizeOp(op);

  if (String(normalized?.type || normalized?.op || '').trim() === 'insert_order') {
    const existingItems = await getAllFromStore('ops');
    const existing = (Array.isArray(existingItems) ? existingItems : [])
      .map(normalizeOp)
      .find((item) => String(item?.op_id || '') !== String(normalized?.op_id || '') && sameInsertTarget(item, normalized));

    if (existing) {
      const merged = {
        ...existing,
        ...normalized,
        op_id: String(existing?.op_id || normalized?.op_id || createSecureId('op')),
        id: existing?.id || normalized?.id || null,
        created_at: existing?.created_at || normalized?.created_at || new Date().toISOString(),
        attempts: Number(existing?.attempts || 0),
        status: 'pending',
        lastError: null,
        nextRetryAt: null,
        payload: deepMerge(existing?.payload || {}, normalized?.payload || {}),
      };
      await putValue('ops', merged);
      return merged;
    }
  }

  await putValue('ops', normalized);
  return normalized;
}

export async function deleteOp(op_id) {
  const key = String(op_id || '').trim();
  if (!key) return false;
  await deleteByKey('ops', key);
  return true;
}

export async function getPendingOps() {
  const rows = await getAllFromStore('ops');
  return sortOps(rows.map(normalizeOp));
}

export async function getDeadLetterOps() {
  const rows = await getAllFromStore('offline_ops_dead_letter');
  return sortOps(rows);
}

export async function processOfflineQueue() {
  // V14.1 safety: this legacy sender must not drain the IndexedDB outbox.
  // syncEngine / OfflineSyncRunner is the only owner allowed to send ops to Supabase.
  // Keep this export for old imports/debug screens, but wake the real sync owner instead.
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));
    }
  } catch {}
  return { ok: false, reason: 'legacy_processor_disabled_sync_engine_owner' };
}

export async function saveClientLocal(client) {
  await putValue('clients', client);
  return true;
}

export async function getAllClientsLocal() {
  return getAllFromStore('clients');
}

export async function setMeta(key, value) {
  await putValue('meta', { key: String(key), value });
  return true;
}

export async function getMeta(key) {
  const row = await getByKey('meta', String(key));
  return row?.value ?? null;
}

function safeReadLocalStorageJson(key, fallback, { purgeOnError = true } = {}) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (e) {
    try {
      if (purgeOnError && typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch {}
    return fallback;
  }
}

export function readQueueMirror() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const all = [];
    for (const key of LEGACY_QUEUE_KEYS) {
      const list = safeReadLocalStorageJson(key, []);
      if (Array.isArray(list) && list.length) all.push(...list);
    }
    return all;
  } catch {
    return [];
  }
}

export async function clearAllOfflineData() {
  try { clearLegacyQueueMirrors(); } catch {}
  await Promise.all([
    clearStore('ops'),
    clearStore('offline_ops_dead_letter'),
    clearStore('orders'),
    clearStore('transport_orders'),
    clearStore('clients'),
    clearStore('meta'),
  ]);
  return true;
}

export function clearLegacyQueueMirrors() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    for (const key of LEGACY_QUEUE_KEYS) window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    try {
      if (legacyOnlineKickTimer) window.clearTimeout(legacyOnlineKickTimer);
    } catch {}
    legacyOnlineKickTimer = window.setTimeout(() => {
      legacyOnlineKickTimer = null;
      try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}
      // DO NOT call the legacy queue processor here.
      // syncEngine / OfflineSyncRunner is the only outbox sender.
    }, 900);
  });
}
