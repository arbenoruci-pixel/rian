import { getDeadLetterOps, getPendingOps, pushOp, saveOrderLocal } from '@/lib/offlineStore';
import { runSync, scheduleRunSync } from '@/lib/syncEngine';
import { runTransportSync, scheduleRunTransportSync } from '@/lib/transportCore/syncEngine';
import logger from '@/lib/logger';
import { patchBaseMasterRow } from '@/lib/baseMasterCache';
import { bumpSyncCounter, syncDebugLog } from '@/lib/syncDebug';
import { rememberBaseCreateRecovery, repairPendingBaseCreateOps } from '@/lib/syncRecovery';
import { getByKey, putValue } from '@/lib/localDb';
import { isTransportPath } from '@/lib/transportCore/scope';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

const SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
let outboxSnapshotCache = [];

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function broadcast() {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tepiha:outbox-changed'));
      window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));
    }
  } catch {}
}

function normalizePayload(payload = {}) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {};
  if (next?.data_patch && typeof next.data_patch === 'object' && !next.data) {
    next.data = { ...next.data_patch };
  }
  delete next.data_patch;
  if (!next.table && next._table) next.table = next._table;
  return next;
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
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

function getCurrentPathname() {
  try {
    if (typeof window === 'undefined') return '';
    return String(window.location?.pathname || '');
  } catch {
    return '';
  }
}

function isTransportSyncRequest(opts = {}) {
  const explicitScope = String(opts?.scope || '').trim().toLowerCase();
  if (explicitScope === 'transport') return true;
  if (explicitScope === 'base') return false;

  const source = String(opts?.source || '').trim().toLowerCase();
  if (source.includes('transport')) return true;

  const includeTables = Array.isArray(opts?.includeTables) ? opts.includeTables.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const excludeTables = Array.isArray(opts?.excludeTables) ? opts.excludeTables.map((v) => String(v || '').trim()).filter(Boolean) : [];
  if (includeTables.length && includeTables.every((v) => v === 'transport_orders' || v === 'transport_clients')) return true;
  if (excludeTables.includes('transport_orders') || excludeTables.includes('transport_clients')) return false;

  return isTransportPath(getCurrentPathname());
}

async function saveTransportOrderLocalOnly(order = {}) {
  const id = String(order?.id ?? order?.local_oid ?? order?.oid ?? '').trim();
  if (!id) return false;

  const existing = (await getByKey('transport_orders', id)) || {};
  const existingData = isPlainObject(existing?.data) ? existing.data : {};
  const incoming = isPlainObject(order) ? order : {};
  const incomingData = isPlainObject(incoming?.data) ? incoming.data : null;
  const localOid = String(incoming?.local_oid || existing?.local_oid || id).trim() || id;

  const next = {
    ...existing,
    ...incoming,
    id,
    local_oid: localOid,
    table: 'transport_orders',
    updated_at: incoming?.updated_at || existing?.updated_at || new Date().toISOString(),
    sync_state: String(incoming?.sync_state || existing?.sync_state || 'pending'),
  };

  if (incomingData) next.data = deepMerge(existingData, incomingData);
  else if (Object.keys(existingData).length) next.data = existingData;

  if (isPlainObject(next.data)) {
    if (!String(next.data?.local_oid || '').trim()) next.data.local_oid = localOid;
    if (!String(next.data?.oid || '').trim()) next.data.oid = localOid;
  }

  const localTransportId = String(next?.transport_id || next?.data?.transport_id || '').trim();
  if (localTransportId) next.transport_id = localTransportId;

  const localTransportPin = String(next?.transport_pin || next?.driver_pin || next?.data?.transport_pin || next?.data?.driver_pin || '').trim();
  if (localTransportPin) next.transport_pin = localTransportPin;

  if (!String(next?.client_tcode || '').trim()) {
    const clientCode = String(next?.code_str || next?.data?.client_tcode || next?.data?.client?.tcode || next?.data?.client?.code || '').trim();
    if (clientCode) next.client_tcode = clientCode;
  }
  if (!String(next?.code_str || '').trim()) {
    const clientCode = String(next?.client_tcode || next?.data?.client?.tcode || next?.data?.client?.code || '').trim();
    if (clientCode) next.code_str = clientCode;
  }
  if (!String(next?.client_name || '').trim()) {
    const clientName = String(next?.data?.client?.name || '').trim();
    if (clientName) next.client_name = clientName;
  }
  if (!String(next?.client_phone || '').trim()) {
    const clientPhone = String(next?.data?.client?.phone || '').trim();
    if (clientPhone) next.client_phone = clientPhone;
  }

  await putValue('transport_orders', next);
  return true;
}


function buildTransportOutboxPayload(payload = {}) {
  return sanitizeTransportOrderPayload({
    ...(payload && typeof payload === 'object' ? payload : {}),
    updated_at: payload?.updated_at || new Date().toISOString(),
  }, { includeTable: true });
}

function validateOutboxItem(item = {}, payload = {}) {
  const type = String(item?.type || item?.op || '').trim() || 'update';
  const table = String(payload?.table || item?.table || payload?._table || '').trim();
  const id = String(item?.id || payload?.id || payload?.local_oid || payload?.order_id || '').trim();
  if (type === 'insert_order') {
    if (!table) return 'MISSING_TABLE';
    if (!id) return 'MISSING_ID';
  }
  if ((type === 'patch_order_data' || type === 'set_status' || type === 'update') && !id) {
    return 'MISSING_ID';
  }
  return '';
}

function mapOpToSnapshot(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object' ? op.payload : (op?.data && typeof op.data === 'object' ? op.data : {});
  const table = String(payload?.table || op?.table || payload?._table || '');
  return {
    id: String(op?.op_id || op?.id || rid()),
    op_id: String(op?.op_id || op?.id || rid()),
    kind: String(op?.type || op?.kind || op?.op || 'update'),
    status: String(op?.status || 'pending'),
    uniqueValue: payload?.localId || payload?.id || payload?.local_oid || payload?.code || op?.id || '',
    createdAt: op?.created_at || new Date().toISOString(),
    attempts: Number(op?.attempts || 0),
    lastError: op?.lastError || null,
    payload,
    table,
  };
}

async function refreshSnapshot() {
  try {
    const [items, dead] = await Promise.all([
      getPendingOps().catch(() => []),
      getDeadLetterOps().catch(() => []),
    ]);
    const snapshot = (Array.isArray(items) ? items : []).map(mapOpToSnapshot);
    outboxSnapshotCache = snapshot;
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch {}
    }
    broadcast();
    syncDebugLog('probe_outbox_changed', {
      pending: snapshot.length,
      firstIds: snapshot.slice(0, 3).map((it) => String(it?.op_id || it?.id || '')),
      dead: Array.isArray(dead) ? dead.length : 0,
    });
    return snapshot;
  } catch (error) {
    logger.warn('syncManager.refreshSnapshot.failed', { error: String(error?.message || error || '') });
    return outboxSnapshotCache || [];
  }
}

export function getOutboxSnapshot() {
  try {
    if (typeof window === 'undefined') return Array.isArray(outboxSnapshotCache) ? outboxSnapshotCache : [];
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    outboxSnapshotCache = Array.isArray(parsed) ? parsed : [];
    return outboxSnapshotCache;
  } catch {
    return Array.isArray(outboxSnapshotCache) ? outboxSnapshotCache : [];
  }
}

export async function enqueueOutboxItem(item = {}) {
  const payload = normalizePayload(item?.payload || item?.data || {});
  const invalidReason = validateOutboxItem(item, payload);
  if (invalidReason) {
    syncDebugLog('op_rejected_invalid_shape', {
      reason: invalidReason,
      type: String(item?.type || item?.op || 'update'),
      id: String(item?.id || payload?.id || payload?.local_oid || payload?.order_id || ''),
      table: String(payload?.table || item?.table || ''),
      code: payload?.code || payload?.code_str || payload?.client?.code || '',
    });
    throw new Error(invalidReason);
  }
  const op = {
    op_id: rid(),
    type: String(item?.type || item?.op || 'update'),
    kind: item?.kind || item?.type || item?.op || 'update',
    id: item?.id || payload?.id || payload?.order_id || null,
    payload,
    uniqueValue: item?.uniqueValue || payload?.code || payload?.local_oid || '',
    created_at: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  const queuedOp = await pushOp(op);
  bumpSyncCounter('enqueue', 1);
  syncDebugLog('offline_enqueue_success', {
    op_id: queuedOp?.op_id || op.op_id,
    type: queuedOp?.type || op.type,
    id: String(queuedOp?.id || op.id || payload?.id || payload?.local_oid || ''),
    code: payload?.code || payload?.code_str || payload?.client?.code || '',
    table: payload?.table || '',
  });
  await refreshSnapshot();
  return queuedOp || op;
}

export async function enqueueBaseOrder(payload = {}) {
  const oid = String(payload?.id || payload?.local_oid || payload?.oid || `local_${Date.now()}`);
  const idem = String(payload?.data?._idem || payload?._idem || `orders:local_oid:${oid}`).trim();
  const order = {
    ...(payload || {}),
    id: oid,
    local_oid: oid,
    table: 'orders',
    data: {
      ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}),
      local_oid: oid,
      _idem: idem,
    },
    _local: true,
    _synced: false,
    updated_at: new Date().toISOString(),
  };
  await saveOrderLocal(order);
  try { patchBaseMasterRow(order); } catch {}
  try { rememberBaseCreateRecovery(order, { status: 'queued', source: 'syncManager.enqueueBaseOrder', note: 'saved_local_before_enqueue' }); } catch {}
  const outboxPayload = {
    ...order,
    table: 'orders',
  };
  delete outboxPayload.id;

  await enqueueOutboxItem({
    op: 'insert_order',
    kind: 'base_order',
    uniqueValue: oid,
    payload: outboxPayload,
  });
  return { ok: true, offline: true, id: oid };
}

export async function enqueueTransportOrder(payload = {}) {
  const oid = String(payload?.id || payload?.local_oid || payload?.oid || `transport_${Date.now()}`);
  const order = {
    ...(payload || {}),
    id: oid,
    local_oid: String(payload?.local_oid || oid),
    table: 'transport_orders',
    _local: true,
    _synced: false,
    sync_state: 'pending',
    updated_at: new Date().toISOString(),
  };

  try {
    await saveTransportOrderLocalOnly(order);
  } catch (error) {
    logger.warn('syncManager.enqueueTransportOrder.localMirrorFallback', { error: String(error?.message || error || '') });
  }

  await enqueueOutboxItem({
    op: 'insert_order',
    kind: 'transport_order',
    uniqueValue: payload?.code || payload?.code_str || oid,
    payload: buildTransportOutboxPayload(order),
  });
  return { ok: true, offline: true, id: oid };
}

export async function syncNow(opts = {}) {
  const transportScoped = isTransportSyncRequest(opts);
  if (!transportScoped) {
    try { await repairPendingBaseCreateOps({ source: String(opts?.source || 'syncNow'), limit: 12 }); } catch {}
  }
  syncDebugLog('sync_now_called', { immediate: !!opts?.immediate, source: String(opts?.source || 'syncManager'), scope: transportScoped ? 'transport' : 'base' });
  const runner = transportScoped
    ? (opts?.immediate
        ? runTransportSync({ manual: true, ...(opts || {}) })
        : scheduleRunTransportSync({ manual: true, source: 'syncManager', delayMs: 250, ...(opts || {}) }))
    : (opts?.immediate
        ? runSync({ manual: true, ...(opts || {}) })
        : scheduleRunSync({ manual: true, source: 'syncManager', delayMs: 250, ...(opts || {}) }));
  const res = await runner;
  syncDebugLog('sync_now_result', {
    ok: !!res?.ok,
    pending: Number(res?.pending || 0),
    done: Number(res?.done || 0),
    failed: Number(res?.failed || 0),
    locked: !!res?.locked,
    offline: !!res?.offline,
    networkStop: !!res?.networkStop,
    scope: transportScoped ? 'transport' : 'base',
  });
  await refreshSnapshot();
  return res;
}
