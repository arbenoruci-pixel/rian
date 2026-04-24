'use client';

import { supabase } from '@/lib/supabaseClient';
import { getPendingOps, deleteOp } from '@/lib/offlineStore';
import { getByKey, putValue } from '@/lib/localDb';
import { isTransportScopedOp, getSyncOpPayload, getSyncOpTable } from '@/lib/transportCore/scope';
import { sanitizeTransportClientPayload, sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

const LOCK_KEY = 'tepiha_transport_sync_lock_v1';
const LOCK_TTL_MS = 20000;
const AUTO_DEBOUNCE_MS = 450;

let running = null;
let scheduledTimer = null;
let scheduledPromise = null;
let scheduledResolve = null;
let lastScheduledOpts = null;
const TAB_ID = `transport_sync_${Math.random().toString(36).slice(2)}`;

function nowIso() {
  return new Date().toISOString();
}

function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function sortOps(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const aCreated = Date.parse(a?.created_at || 0) || 0;
    const bCreated = Date.parse(b?.created_at || 0) || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.op_id || '').localeCompare(String(b?.op_id || ''));
  });
}

function getTransportOps(items = []) {
  return sortOps(items).filter((op) => isTransportScopedOp(op) && shouldRetryTransportOp(op));
}

function getErrorText(error) {
  try {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return JSON.stringify({
      name: error?.name || '',
      message: error?.message || '',
      code: error?.code || '',
      status: error?.status || '',
      details: error?.details || '',
      hint: error?.hint || '',
    });
  } catch {
    return String(error || '');
  }
}

function isNetworkLikeError(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('aborted') ||
    text.includes('load failed')
  );
}

function classifyTransportPermanentError(error) {
  const text = getErrorText(error).toLowerCase();
  const code = String(error?.code || '').toUpperCase();

  if (
    code === '428C9' ||
    text.includes('generated column') ||
    text.includes('cannot insert a non-default value into column')
  ) {
    return { permanent: true, category: 'schema_mismatch', reason: 'generated_column_write' };
  }

  if (
    code === 'PGRST204' ||
    text.includes('pgrst204') ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    text.includes('column') && text.includes('transport_orders')
  ) {
    return { permanent: true, category: 'schema_mismatch', reason: 'unknown_column' };
  }

  if (
    code === '22P02' ||
    text.includes('invalid input syntax for type bigint') ||
    text.includes('invalid input syntax')
  ) {
    return { permanent: true, category: 'payload_invalid', reason: 'invalid_numeric_mapping' };
  }

  if (
    code == '23502' ||
    text.includes('null value in column') ||
    text.includes('violates not-null constraint')
  ) {
    return { permanent: true, category: 'payload_invalid', reason: 'not_null_violation' };
  }

  return { permanent: false, category: '', reason: '' };
}

function shouldRetryTransportOp(op = {}) {
  const status = String(op?.status || '').trim().toLowerCase();
  if (status === 'paused' || status === 'failed_permanently') return false;
  const nextRetryAt = Number(op?.nextRetryAt || 0);
  return !nextRetryAt || Date.now() >= nextRetryAt;
}

async function pauseTransportOp(op = {}, error, info = {}) {
  const current = (await getByKey('ops', op?.op_id)) || op;
  const next = {
    ...current,
    attempts: Number(current?.attempts || 0) + 1,
    status: 'paused',
    nextRetryAt: null,
    errorCategory: String(info?.category || ''),
    stopReason: String(info?.reason || ''),
    lastError: {
      message: String(error?.message || error || 'TRANSPORT_SYNC_PAUSED'),
      code: String(error?.code || ''),
      at: nowIso(),
    },
  };
  await putValue('ops', next);
  return next;
}

async function markTransportMirrorState(op = {}, extra = {}) {
  const payload = getSyncOpPayload(op);
  const raw = payload?.insertRow && typeof payload.insertRow === 'object' ? payload.insertRow : payload;
  const id = String(raw?.id || raw?.local_oid || raw?.oid || op?.id || '').trim();
  if (!id) return;
  const existing = (await getByKey('transport_orders', id)) || {};
  const mergedData = {
    ...((existing?.data && typeof existing.data === 'object') ? existing.data : {}),
    ...((raw?.data && typeof raw.data === 'object') ? raw.data : {}),
  };
  const next = {
    ...existing,
    ...(raw || {}),
    id,
    local_oid: String(raw?.local_oid || existing?.local_oid || id),
    table: 'transport_orders',
    data: mergedData,
    updated_at: raw?.updated_at || existing?.updated_at || nowIso(),
    ...extra,
  };
  if (extra?.sync_state) next.sync_state = extra.sync_state;
  const localTransportId = String(next?.transport_id || next?.data?.transport_id || '').trim();
  if (localTransportId) next.transport_id = localTransportId;
  await putValue('transport_orders', next);
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

async function saveLocalTransportOrder(row, syncState = 'synced') {
  const id = String(row?.id || '').trim();
  if (!id) return false;
  const existing = (await getByKey('transport_orders', id)) || {};
  const nextData = {
    ...(existing?.data && typeof existing.data === 'object' ? existing.data : {}),
    ...(row?.data && typeof row.data === 'object' ? row.data : {}),
  };
  const next = {
    ...existing,
    ...(row || {}),
    id,
    data: nextData,
    sync_state: syncState,
    updated_at: row?.updated_at || nowIso(),
  };

  const localTransportId = String(next?.transport_id || nextData?.transport_id || '').trim();
  if (localTransportId) next.transport_id = localTransportId;

  const localTransportPin = String(next?.transport_pin || next?.driver_pin || nextData?.transport_pin || nextData?.driver_pin || '').trim();
  if (localTransportPin) next.transport_pin = localTransportPin;

  if (!String(next?.client_tcode || '').trim()) {
    const clientCode = normalizeTCodeLoose(next?.code_str || nextData?.client_tcode || nextData?.client?.tcode || nextData?.client?.code || '');
    if (clientCode) next.client_tcode = clientCode;
  }
  if (!String(next?.code_str || '').trim()) {
    const clientCode = normalizeTCodeLoose(next?.client_tcode || nextData?.client?.tcode || nextData?.client?.code || '');
    if (clientCode) next.code_str = clientCode;
  }
  if (!String(next?.client_name || '').trim()) {
    const clientName = String(nextData?.client?.name || '').trim();
    if (clientName) next.client_name = clientName;
  }
  if (!String(next?.client_phone || '').trim()) {
    const clientPhone = String(nextData?.client?.phone || '').trim();
    if (clientPhone) next.client_phone = clientPhone;
  }

  await putValue('transport_orders', next);
  return true;
}

function cleanPatch(patch = {}) {
  const next = { ...(patch || {}) };
  delete next.table;
  delete next.insertRow;
  delete next.data_patch;
  return next;
}

function normalizeTCodeLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : raw.toUpperCase();
}

function stripUndefinedShallow(obj) {
  const out = { ...(obj || {}) };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

function sanitizeTransportOrderSyncPayload(input) {
  return sanitizeTransportOrderPayload(input);
}

function sanitizeTransportClientPatch(input = {}, forcedTcode = '') {
  return sanitizeTransportClientPayload(input, { mode: 'patch', tcode: forcedTcode });
}

async function processTransportOrderInsert(op = {}) {
  const payload = getSyncOpPayload(op);
  const raw = payload?.insertRow && typeof payload.insertRow === 'object' ? payload.insertRow : payload;
  const row = sanitizeTransportOrderSyncPayload(raw);
  if (!row?.id) throw new Error('MISSING_TRANSPORT_ID');
  const { data, error } = await supabase
    .from('transport_orders')
    .upsert(row, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  await saveLocalTransportOrder(data || row, 'synced');
}

async function processTransportOrderPatch(op = {}) {
  const payload = getSyncOpPayload(op);
  const id = String(payload?.id || payload?.order_id || payload?.local_oid || op?.id || '').trim();
  if (!id) throw new Error('MISSING_TRANSPORT_ID');
  const patch = sanitizeTransportOrderSyncPayload(
    payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload
  );
  patch.updated_at = patch.updated_at || nowIso();
  const { data, error } = await supabase
    .from('transport_orders')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) return true;
  await saveLocalTransportOrder(data || { id, ...patch }, 'synced');
}

async function processTransportClientPatch(op = {}) {
  const payload = getSyncOpPayload(op);
  const tcode = String(payload?.id || op?.id || '').trim().toUpperCase();
  if (!tcode) throw new Error('MISSING_TRANSPORT_CLIENT_TCODE');
  const patch = sanitizeTransportClientPatch(
    payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload,
    tcode,
  );
  const { error } = await supabase
    .from('transport_clients')
    .update(patch)
    .eq('tcode', tcode);
  if (error) throw error;
}

async function processTransportOp(op = {}) {
  const table = getSyncOpTable(op);
  const type = String(op?.type || op?.op || '').trim();
  if (table === 'transport_orders') {
    if (type === 'insert_order') return processTransportOrderInsert(op);
    if (type === 'patch_order_data' || type === 'update' || type === 'set_status') return processTransportOrderPatch(op);
  }
  if (table === 'transport_clients') {
    if (type === 'patch_order_data' || type === 'update') return processTransportClientPatch(op);
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

export function scheduleRunTransportSync(opts = {}) {
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
      const result = await runTransportSync(pendingOpts);
      finishScheduledPromise(result);
    } catch (error) {
      finishScheduledPromise({ ok: false, error: String(error?.message || error || 'TRANSPORT_SYNC_FAILED') });
    }
  }, delayMs);
  return scheduledPromise;
}

export async function runTransportSync(_opts = {}) {
  if (running) return running;

  if (!acquireLock()) {
    return { ok: false, locked: true };
  }

  running = (async () => {
    try {
      if (!isOnline()) {
        return { ok: false, offline: true };
      }

      const ops = getTransportOps(await getPendingOps());
      if (!ops.length) return { ok: true, pending: 0, done: 0 };

      let done = 0;
      let failed = 0;
      let paused = 0;
      let networkStop = false;
      for (const op of ops) {
        refreshLock();
        try {
          await processTransportOp(op);
          await deleteOp(op.op_id);
          done += 1;
        } catch (error) {
          const networkLike = isNetworkLikeError(error) || !isOnline();
          const permanent = classifyTransportPermanentError(error);

          if (networkLike) {
            return { ok: false, networkStop: true, done, failed, paused, pending: Math.max(0, ops.length - done - paused), error: String(error?.message || error || 'NETWORK_STOP') };
          }

          if (permanent.permanent) {
            failed += 1;
            paused += 1;
            await pauseTransportOp(op, error, permanent);
            await markTransportMirrorState(op, {
              _syncing: false,
              _syncPending: false,
              _syncFailed: true,
              _syncError: String(error?.message || error || 'TRANSPORT_SYNC_PAUSED'),
              sync_state: 'paused',
              _syncStopReason: String(permanent.reason || ''),
              _syncErrorCategory: String(permanent.category || ''),
            });
            continue;
          }

          failed += 1;
          await markTransportMirrorState(op, {
            _syncing: false,
            _syncPending: false,
            _syncFailed: true,
            _syncError: String(error?.message || error || 'TRANSPORT_SYNC_FAILED'),
            sync_state: 'failed',
          });
          return { ok: false, done, failed, paused, pending: Math.max(0, ops.length - done - paused), error: String(error?.message || error || 'TRANSPORT_SYNC_FAILED') };
        }
      }

      return { ok: failed === 0, pending: 0, done, failed, paused, networkStop };
    } finally {
      releaseLock();
      running = null;
    }
  })();

  return running;
}
