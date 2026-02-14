// lib/offlineSyncClient.js
// Minimal offline ops queue + best-effort sync.
// Uses IndexedDB store from lib/offlineStore.js.

import { getPendingOps, deleteOp, pushOp } from "@/lib/offlineStore";

async function ping() {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  } catch {}

  try {
    const r = await fetch("/api/backup/ping", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    return !!(r.ok && j && j.ok);
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
      const r = await fetch("/api/offline-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.ok) {
        await deleteOp(op.op_id);
        synced += 1;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return { ok: true, synced };
}
