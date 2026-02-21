// lib/syncEngine.js
// Offline-first sync runner.
// IMPORTANT: We sync via /api/offline-sync (server) so it works even when
// the device has no Supabase auth session, and to ensure multi-user consistency.

import { getPendingOps, deleteOp, setMeta } from "./offlineStore";
import { syncOfflineNow } from "@/lib/offlineQueueSync";
import { syncTransportDraftsNow } from "@/lib/transportOfflineSync";

let syncing = false;

async function execOpRemote(op) {
  // Backward-compat: older builds queued different op type names.
  const normalizedType = (op?.type === 'insert_order' || op?.type === 'upsert_order')
    ? 'UPSERT_ORDER'
    : op?.type;

  const payload = op?.payload;
  const op_id = op?.op_id;

  // The API expects { ops: [...] }.
  const r = await fetch("/api/offline-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ type: normalizedType, payload, op_id }] }),
  });

  const j = await r.json().catch(() => ({}));
  if (r.ok && j && j.ok) return { ok: true, body: j };

  const msg = j?.error || j?.message || `HTTP ${r.status}`;
  const err = new Error(msg);
  err._sync = { status: r.status, body: j, op_type: normalizedType };
  throw err;
}

export async function runSync(){
  if(syncing) return;
  if(typeof navigator !== "undefined" && !navigator.onLine) return;

  syncing = true;
  try{
    try {
      localStorage.setItem('tepiha_last_sync', JSON.stringify({ ts: Date.now(), state: 'START' }));
    } catch {}

    const ops = await getPendingOps();
    ops.sort((a,b)=>(a.created_at||0)-(b.created_at||0));

    for(const op of ops){
      try{
        await execOpRemote(op);
        await deleteOp(op.op_id);
      }catch(e){
        // keep op, retry later
        console.warn("[SYNC] op failed, will retry", op?.type, e?.message || e);
        try {
          localStorage.setItem(
            'tepiha_last_sync_error',
            JSON.stringify({ ts: Date.now(), op_id: op?.op_id, type: op?.type, message: String(e?.message || e), meta: e?._sync || null })
          );
        } catch {}
        break;
      }
    }

    // Legacy + cross-module: ensure older offline queues get flushed too.
    try { await syncOfflineNow(); } catch {}
    try { await syncTransportDraftsNow(); } catch {}

    await setMeta("last_sync_at", Date.now());

    try {
      localStorage.setItem('tepiha_last_sync', JSON.stringify({ ts: Date.now(), state: 'DONE' }));
    } catch {}
  } finally{
    syncing = false;
  }
}
