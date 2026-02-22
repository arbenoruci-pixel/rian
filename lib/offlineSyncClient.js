// lib/offlineSyncClient.js
// Minimal offline ops queue + best-effort sync.
// Uses IndexedDB store from lib/offlineStore.js.

import { getPendingOps, deleteOp, pushOp, removeOrderLocal } from "@/lib/offlineStore";
import { supabase } from "@/lib/supabaseClient";

async function ping() {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  } catch {}

  try {
    await supabase.auth.getSession(); // ping i lehtë (pa RLS)
    return true;
  } catch {
    return false;
  }
}

export async function queueOp(type, payload) {
  const op = {
    op_id:
      (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type,
    payload,
    created_at: new Date().toISOString(),
  };
  await pushOp(op);
  return op.op_id;
}

export async function trySyncPendingOps() {
  const ok = await ping();
  if (!ok) return { ok: false, reason: "OFFLINE" };

  let ops = [];
  try {
    ops = await getPendingOps();
  } catch {
    ops = [];
  }

  if (!Array.isArray(ops) || ops.length === 0) return { ok: true, synced: 0 };

  // Oldest-first
  ops.sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));

  let synced = 0;
  for (const op of ops) {
    try {
      const normalized = {
  ...op,
  type: op?.type || op?.op_type || op?.opType,
};
const r = await fetch("/api/offline-sync", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(normalized),
});
      const j = await r.json().catch(() => ({}));
      
      if (j && j.ok) {
        // If server synced an offline-created order (identified by data.id),
        // remove local copy so UI will show the DB row on next fetch.
        if (j.localId) {
          try {
            await removeOrderLocal(j.localId);
          } catch {}
        }
        await deleteOp(op.op_id);
        synced += 1;
      } else {
        // RREGULLIMI: Fshijmë operacionin me gabim logjik për të mos bllokuar radhën.
        // Nuk bëjmë "break" këtu, kështu që loop vazhdon me operacionin tjetër.
        console.error("Sync logjik dështoi për op:", op.op_id, j?.error);
        await deleteOp(op.op_id);
      }
    } catch {
      // RREGULLIMI: Bëjmë "break" vetëm kur bie rrjeti (Network Error),
      // në mënyrë që të provojmë përsëri më vonë kur të vijë interneti.
      break;
    }
  }

  return { ok: true, synced };
}
