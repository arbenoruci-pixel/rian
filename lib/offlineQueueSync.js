// lib/offlineQueueSync.js
// PURPOSE: When internet returns, push PRANIMI offline queue into Supabase automatically.
// Also flush queued "code used" marks for the per-user code pool.

import { saveOrderToDb } from "@/lib/ordersDb";
import { getActorPin, flushBaseUsedQueue } from "@/lib/baseCodes";

const OFFLINE_QUEUE_KEY = "tepiha_offline_queue_v1";
const OFFLINE_MODE_KEY = "tepiha_offline_mode_v1";

let _running = false;

function readQueue() {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    const q = raw ? JSON.parse(raw) : [];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function writeQueue(list) {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch {}
}

function normalizeOrderForDb(order) {
  // ordersDb expects: { client:{name,phone,code}, status, tepiha, staza, shkallore, pay, notes }
  const o = order && typeof order === "object" ? order : {};
  const client = o.client || {};
  return {
    ...o,
    client: {
      name: String(client.name || o.client_name || "").trim(),
      phone: String(client.phone || o.client_phone || "").trim(),
      code: client.code ?? o.code ?? o.code_n,
      photoUrl: client.photoUrl || "",
    },
    status: String(o.status || "pastrim").toLowerCase(),
  };
}

export async function syncOfflineNow() {
  if (_running) return { ok: false, reason: "RUNNING" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "OFFLINE" };

  _running = true;
  try {
    // 1) Flush queued base-code USED marks (codes taken offline)
    try {
      const pin = getActorPin();
      await flushBaseUsedQueue(pin);
    } catch (e) {
      // Don’t block order sync if this fails
      console.warn("flushBaseUsedQueue failed", e);
    }

    // 2) Sync offline PRANIMI queue (orders + clients)
    const q = readQueue();
    if (!q.length) {
      try { localStorage.setItem(OFFLINE_MODE_KEY, "0"); } catch {}
      return { ok: true, synced: 0 };
    }

    let synced = 0;
    const keep = [];

    for (const item of q) {
      try {
        const order = normalizeOrderForDb(item?.order || item);

        // Prefer server route (can use service role to bypass RLS + auth issues)
        let ok = false;
        try {
          const res = await fetch("/api/offline-sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "offline_pranimi", payload: { order } }),
          });
          const j = await res.json().catch(() => null);
          ok = !!j?.ok;
          if (!ok) {
            console.warn("offline-sync route failed", j);
          }
        } catch (e) {
          ok = false;
        }

        // Fallback: client-side insert (requires RLS allowing it)
        if (!ok) {
          await saveOrderToDb(order, "OFFLINE_SYNC");
        }

        synced += 1;
      } catch (e) {
        // Keep it for later retry (network/RLS errors etc.)
        console.warn("offline order sync failed", e);
        keep.push(item);
      }
    }

    writeQueue(keep);

    // turn off offline mode if we drained the queue
    if (!keep.length) {
      try { localStorage.setItem(OFFLINE_MODE_KEY, "0"); } catch {}
    }

    return { ok: true, synced, remaining: keep.length };
  } finally {
    _running = false;
  }
}
