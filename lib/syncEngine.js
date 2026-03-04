"use client";

// lib/syncEngine.js — CORE I PASTRUAR DHE I SHPEJTË
import { getPendingOps, deleteOp, setMeta, saveOrderLocal } from "./offlineStore";
import { syncOfflineNow } from "@/lib/offlineQueueSync";
import { syncTransportDraftsNow } from "@/lib/transportOfflineSync";

let syncing = false;

async function execOpRemote(op) {
  const tRaw = op?.type;
  const normalizedType =
    tRaw === "UPSERT_ORDER" || tRaw === "upsert_order" ? "insert_order" : tRaw;

  const payload = op?.payload || {};
  let body = { type: normalizedType };

  if (normalizedType === "insert_order") {
    const rawRow = payload.insertRow || payload.data || payload;
    const row = { ...(rawRow || {}) };

    if (row && row.id && !row.local_oid) row.local_oid = String(row.id);
    if (row && row.id) delete row.id;

    if (row && row.code != null) row.code = Number(row.code);
    if (row && row.code_n != null) row.code = Number(row.code_n);
    if (row && Object.prototype.hasOwnProperty.call(row, "code_n")) delete row.code_n;

    body.data = row;
    body.localId = payload.localId || payload.local_id || row?.local_oid || row?.local_id;
  } else if (normalizedType === "patch_order_data") {
    body.id = payload.id || payload.order_id || op?.id;
    body.data = payload.data || payload.patch || payload;
  } else if (normalizedType === "set_status") {
    body.id = payload.id || payload.order_id || op?.id;
    body.data = { status: payload.status, ...(payload.data || {}) };
  } else {
    body.data = payload.data || payload;
    if (payload.id) body.id = payload.id;
  }

  const r = await fetch("/api/offline-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (r.ok && j && j.ok) return { ok: true, body: j };

  const msg = j?.error || j?.message || `HTTP ${r.status}`;
  throw new Error(msg);
}

export const runSync = async (opts = {}) => {
  if (syncing) return { ok: true, skipped: true };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { ok: false, offline: true };
  }

  syncing = true;
  let sent = 0;
  let failed = 0;

  try {
    const ops = await getPendingOps();
    // I dërgojmë sipas radhës që janë krijuar
    ops.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    for (const op of ops) {
      try {
        const res = await execOpRemote(op);
        
        if (res && res.ok) {
           // Shënoje si të sinkronizuar në memorien lokale
           const locId = res.body?.localId || op.payload?.localId || op.payload?.local_oid || op.payload?.id;
           if (locId) {
              try {
                // Update statusin lokal që sistemi ta dijë që s'është më "Draft"
                await saveOrderLocal({ id: locId, _synced: true, updated_at: new Date().toISOString() });
              } catch(e) {}
           }
        }

        await deleteOp(op.op_id);
        sent++;
      } catch (e) {
        console.warn("[SYNC FAIL]", op?.type, e?.message);
        failed++;
        // Ndalo dërgimin e të tjerave nëse njëra dështon (për siguri renditjeje)
        break; 
      }
    }

    // Pastro urat e vjetra
    try { await syncOfflineNow(); } catch {}
    try { await syncTransportDraftsNow(); } catch {}

    await setMeta("last_sync_at", Date.now());
    return { ok: failed === 0, sent, failed };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    syncing = false;
  }
};

export const attachAutoSync = () => {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => runSync({ auto: true }));
};

export default { runSync, attachAutoSync };
