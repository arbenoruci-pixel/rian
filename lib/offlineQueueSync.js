/*
  OFFLINE QUEUE SYNC (Phase 2)
  - localStorage mirror is retired as a live queue.
  - Any legacy mirror items are migrated one-time into IndexedDB.
  - IndexedDB ops store remains the single source of truth.
*/

import { saveOrderLocal, pushOp, getPendingOps, clearLegacyQueueMirrors } from '@/lib/offlineStore';
import { pushGlobalError } from '@/lib/globalErrors';

const MIRROR_KEYS = [
  'tepiha_offline_queue_v1',
  'tepiha_offline_queue_mirror_v1',
  'offline_queue_mirror_v1'
];

const LS_OFFLINE_SYNC_LAST = 'tepiha_offline_sync_last_v1';

function safeJsonParse(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

export function detectMirrorKey() {
  if (typeof window === 'undefined') return null;
  for (const k of MIRROR_KEYS) {
    const raw = window.localStorage.getItem(k);
    if (raw && raw.trim().length > 2) return k;
  }
  return null;
}

export function readQueueMirror() {
  if (typeof window === 'undefined') return { key: null, items: [] };
  const key = detectMirrorKey();
  if (!key) return { key: null, items: [] };
  const raw = window.localStorage.getItem(key);
  const parsed = safeJsonParse(raw, []);
  const items = Array.isArray(parsed) ? parsed : [];
  return { key, items };
}

export function writeQueueMirror(key, items) {
  if (typeof window === 'undefined' || !key) return;
  window.localStorage.setItem(key, JSON.stringify(items || []));
}

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `legacy_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildInsertRowFromMirrorItem(item) {
  const order = item?.payload || item?.order || item;
  const localOid = item?.local_id || order?.local_oid || order?.local_id || order?.id || null;

  const clientName = order?.client_name || order?.client?.name || order?.name || null;
  const clientPhone = order?.client_phone || order?.client?.phone || order?.phone || '';
  const clientCode = toNumberOrNull(order?.code ?? order?.client_code ?? order?.client?.code);

  return {
    local_oid: String(localOid),
    status: order?.status || 'pastrim',
    client_name: clientName,
    client_phone: clientPhone || '',
    code: clientCode,
    total: toNumberOrNull(order?.total ?? order?.pay?.euro) ?? 0,
    paid: toNumberOrNull(order?.paid ?? order?.pay?.paid) ?? 0,
    updated_at: new Date().toISOString(),
    data: {
      ...order,
      _is_offline: true,
      _synced_via: 'idb_migration'
    }
  };
}

export async function harmonizeLocalStores() {
  if (typeof window === 'undefined') return { ok: true, migrated: 0, cleared: false };

  try {
    const { key, items } = readQueueMirror();
    if (!key || !Array.isArray(items) || items.length === 0) {
      return { ok: true, migrated: 0, cleared: false };
    }

    const existingOps = await getPendingOps().catch(() => []);
    const existingInsertIds = new Set(
      (Array.isArray(existingOps) ? existingOps : []).map((op) => {
        const localId = op?.payload?.localId || op?.payload?.local_id || op?.payload?.insertRow?.local_oid || op?.payload?.insertRow?.id || null;
        const table = op?.payload?.table || op?.payload?.insertRow?.table || 'orders';
        return `${table}:${String(localId || '')}:${String(op?.type || '')}`;
      })
    );

    let migrated = 0;

    for (const item of items) {
      if (item?.synced === true) continue;

      const row = buildInsertRowFromMirrorItem(item);
      const localId = item?.local_id || row.local_oid || null;
      if (!localId) continue;

      await saveOrderLocal({
        ...(item?.payload || item?.order || item || {}),
        id: localId,
        local_oid: localId,
        _local: true,
        _synced: false,
      });

      const dedupeKey = `orders:${String(localId)}:insert_order`;
      if (!existingInsertIds.has(dedupeKey)) {
        await pushOp({
          op_id: item?.op_id || rid(),
          type: 'insert_order',
          payload: {
            insertRow: { ...row, table: 'orders' },
            localId: String(localId),
            table: 'orders',
          },
          created_at: item?.createdAt || item?.created_at || new Date().toISOString(),
        });
        existingInsertIds.add(dedupeKey);
      }

      migrated += 1;
    }

    clearLegacyQueueMirrors();

    window.localStorage.setItem(LS_OFFLINE_SYNC_LAST, JSON.stringify({
      ts: Date.now(),
      ok: true,
      migrated,
      retiredMirror: true,
    }));

    return { ok: true, migrated, cleared: true };
  } catch (e) {
    console.error('Gabim gjatë unifikimit të memorieve:', e);
    try { pushGlobalError('offline/harmonizeLocalStores', e); } catch {}
    return { ok: false, migrated: 0, error: String(e?.message || e) };
  }
}

export async function syncOfflineNow() {
  const res = await harmonizeLocalStores();
  return {
    ok: !!res?.ok,
    syncedCount: Number(res?.migrated || 0),
    retiredMirror: true,
    lastError: res?.error || null,
  };
}

export function readOfflineSyncLast() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LS_OFFLINE_SYNC_LAST);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
