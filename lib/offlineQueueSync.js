/*
  OFFLINE QUEUE SYNC (Harmonized Version)
  - Synchronizes the localStorage mirror with the Supabase DB.
  - Fixes Key Mismatch with offlineStore.js.
  - Ensures local_oid is used as the primary identifier.
  - Robust error handling: One bad order won't block the whole queue.
*/

import { getActor } from '@/lib/actorSession';
import { saveOrderLocal } from '@/lib/offlineStore'; // 🔥 SHTUAR PËR UNIFIKIM
import { pushGlobalError } from '@/lib/globalErrors';

// 🔥 AUTO-BLACKLIST: Varros fantazmat automatikisht
export function banishGhost(localId) {
  if (typeof window === 'undefined' || !localId) return;
  if (String(localId).match(/^[0-9]+$/)) return; // Nuk bllokon ID-të e vërteta nga DB
  try {
    const bl = JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]');
    if (!bl.includes(String(localId))) {
      bl.push(String(localId));
      window.localStorage.setItem('tepiha_ghost_blacklist', JSON.stringify(bl));
    }
  } catch(e) {}
}

// Çelësi kryesor që përdoret nga offlineStore.js
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
  if (typeof window === 'undefined') return;
  if (!key) return;
  window.localStorage.setItem(key, JSON.stringify(items || []));
}

// 🔥 FUNKSIONI I RI: Kalon gjithçka nga Cache i dobët në IndexedDB të pathyeshme
export async function harmonizeLocalStores() {
  if (typeof window === 'undefined') return;
  
  try {
    const { key, items } = readQueueMirror();
    if (!key || !items || items.length === 0) return;

    let kaNdryshime = false;

    for (const item of items) {
      if (!item.synced) {
        const order = item.order || item.payload || item;
        const localId = item.local_id || order?.local_oid || order?.id;

        if (localId) {
          // E shpëtojmë nga Cache dhe e fusim thellë në IndexedDB
          await saveOrderLocal({
            ...order,
            id: localId,
            local_oid: localId,
            _local: true,
            _synced: false
          });
          kaNdryshime = true;
        }
      }
    }

    // Pasi i kemi futur të gjitha në IndexedDB në mënyrë të sigurt,
    // e fshijmë Cache-in e vjetër që të mos na krijojë fantazma.
    if (kaNdryshime) {
      writeQueueMirror(key, []);
      console.log("✅ Të gjitha porositë nga Cache u kaluan në IndexedDB me sukses!");
    }

  } catch (e) {
    console.error("Gabim gjatë unifikimit të memorieve:", e);
    try { pushGlobalError('offline/harmonizeLocalStores', e); } catch {}
  }
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
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
      _synced_via: 'mirror_sync'
    }
  };
}

export async function syncOfflineNow() {
  if (typeof window === 'undefined') return { ok: true, syncedCount: 0 };

  const { key: mirrorKey, items } = readQueueMirror();
  const pending = (items || []).filter((x) => x && x.synced !== true);

  if (!mirrorKey || pending.length === 0) {
    return { ok: true, syncedCount: 0, mirrorKey };
  }

  const actor = getActor();
  let syncedCount = 0;
  let hasErrors = false;
  let lastError = null;

  const successfulIds = new Set();

  for (const item of pending) {
    const row = buildInsertRowFromMirrorItem(item);
    const localId = item?.local_id || row.local_oid || null;

    try {
      const res = await fetch('/api/offline-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'insert_order', data: row, localId, actor }),
      });
      
      const j = await res.json().catch(() => ({ ok: false, error: 'JSON_ERROR' }));

      if (res.ok && j.ok) {
        syncedCount++;
        successfulIds.add(String(localId));
        banishGhost(localId); // 🔥 Fshihet automatikisht pasi shkon në DB
      } else {
        hasErrors = true;
        lastError = j.error || `HTTP ${res.status}`;
        console.warn(`[MirrorSync] Failed item ${localId}:`, lastError);
        try {
          pushGlobalError('offline/mirror_sync', new Error(String(lastError)), {
            localId,
            status: res.status,
            body: j,
          });
        } catch {}
      }
    } catch (e) {
      hasErrors = true;
      lastError = e.message;
      console.error(`[MirrorSync] Fatal error for item ${localId}:`, e);
      try { pushGlobalError('offline/mirror_sync', e, { localId }); } catch {}
    }
  }

  const nowIso = new Date().toISOString();
  const updatedItems = items.map(it => {
    const kid = String(it?.local_id || it?.id || '');
    if (successfulIds.has(kid)) {
      return { ...it, synced: true, synced_at: nowIso };
    }
    return it;
  });

  writeQueueMirror(mirrorKey, updatedItems);
  
  window.localStorage.setItem(LS_OFFLINE_SYNC_LAST, JSON.stringify({
    ts: Date.now(),
    ok: !hasErrors,
    syncedCount,
    lastError
  }));

  return { ok: !hasErrors, syncedCount, lastError, mirrorKey };
}
