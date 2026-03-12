"use client";

// lib/syncEngine.js — CORE I PASTRUAR DHE I SHPEJTË
import { getPendingOps, deleteOp, setMeta, saveOrderLocal } from "./offlineStore";
import { syncOfflineNow } from "@/lib/offlineQueueSync";
import { syncTransportDraftsNow } from "@/lib/transportOfflineSync";
import { pushGlobalError } from "@/lib/globalErrors";

let syncing = false;

function isDeliveredAtSchemaError(errorLike) {
  const txt = String(
    errorLike?.message || errorLike?.error || errorLike?.details || errorLike || ""
  ).toLowerCase();
  return txt.includes("delivered_at");
}

function stripDeliveredAtDeep(value) {
  if (Array.isArray(value)) {
    return value.map(stripDeliveredAtDeep);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "delivered_at") continue;
    out[k] = stripDeliveredAtDeep(v);
  }
  return out;
}

async function postOfflineSync(body) {
  const r = await fetch("/api/offline-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (r.ok && j && j.ok) return { ok: true, body: j };

  const msg = j?.error || j?.message || `HTTP ${r.status}`;
  const e = new Error(msg);
  e.status = r.status;
  e.responseBody = j;
  throw e;
}

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

  try {
    return await postOfflineSync(body);
  } catch (e) {
    if (!isDeliveredAtSchemaError(e) && !isDeliveredAtSchemaError(e?.responseBody)) {
      try {
        pushGlobalError("sync/execOpRemote", e, {
          status: e?.status,
          type: op?.type,
          body: e?.responseBody,
        });
      } catch {}
      throw e;
    }

    const fallbackBody = stripDeliveredAtDeep(body);

    try {
      return await postOfflineSync(fallbackBody);
    } catch (retryErr) {
      try {
        pushGlobalError("sync/execOpRemote_retry_without_delivered_at", retryErr, {
          status: retryErr?.status,
          type: op?.type,
          originalBody: body,
          retriedBody: fallbackBody,
          body: retryErr?.responseBody,
        });
      } catch {}
      throw retryErr;
    }
  }
}

export async function runSync(opts = {}) {
  if (syncing) return { ok: true, skipped: true };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { ok: false, offline: true };
  }

  syncing = true;
  let sent = 0;
  let failed = 0;

  try {
    const ops = await getPendingOps();
    ops.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    for (const op of ops) {
      try {
        const res = await execOpRemote(op);

        if (res && res.ok) {
          const locId =
            res.body?.localId ||
            op.payload?.localId ||
            op.payload?.local_oid ||
            op.payload?.id;
          if (locId) {
            try {
              await saveOrderLocal({
                id: locId,
                _synced: true,
                updated_at: new Date().toISOString(),
              });
            } catch {}
          }
        }

        await deleteOp(op.op_id);
        sent++;
      } catch (e) {
        console.warn("[SYNC FAIL]", op?.type, e?.message);
        try {
          pushGlobalError("sync/runSync", e, { op });
        } catch {}
        failed++;
        break;
      }
    }

    try {
      await syncOfflineNow();
    } catch (e) {
      try {
        pushGlobalError("sync/syncOfflineNow", e);
      } catch {}
    }
    try {
      await syncTransportDraftsNow();
    } catch (e) {
      try {
        pushGlobalError("sync/syncTransportDraftsNow", e);
      } catch {}
    }

    await setMeta("last_sync_at", Date.now());
    return { ok: failed === 0, sent, failed };
  } catch (err) {
    try {
      pushGlobalError("sync/runSync_outer", err, { sent, failed, opts });
    } catch {}
    return { ok: false, error: err.message };
  } finally {
    syncing = false;
  }
}

export function attachAutoSync() {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => runSync({ auto: true }));
}

export default { runSync, attachAutoSync };
