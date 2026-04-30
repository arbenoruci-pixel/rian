// lib/offlineSyncClient.js
// Unified client facade over IndexedDB pending ops + single sync engine.

import { pushOp } from '@/lib/offlineStore';
import { scheduleRunSync } from '@/lib/syncEngine';
import { syncDebugLog } from '@/lib/syncDebug';

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

export async function queueOp(type, payload) {
  const op = {
    op_id: rid(),
    type,
    payload: normalizePayload(payload),
    created_at: new Date().toISOString(),
  };
  await pushOp(op);
  syncDebugLog('enqueue', {
    type,
    table: op?.payload?.table || '',
    id: op?.payload?.id || op?.payload?.local_oid || '',
  });
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tepiha:outbox-changed'));
      window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));
    }
  } catch {}
  try {
    void scheduleRunSync({ source: 'offlineSyncClient:queueOp', delayMs: 250 });
  } catch {}
  return op.op_id;
}

export async function trySyncPendingOps() {
  return await scheduleRunSync({ source: 'offlineSyncClient', delayMs: 300 });
}
