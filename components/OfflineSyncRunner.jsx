"use client";

import { useEffect } from "react";
import { trySyncPendingOps } from "@/lib/offlineSyncClient";
import { getActorPin, refillBasePoolIfNeeded } from "@/lib/baseCodes";

// Background sync runner (safe to include globally).
// - does nothing if offline
// - when online, flushes pending ops to /api/offline-sync
export default function OfflineSyncRunner() {
  useEffect(() => {
    let alive = true;
    let t = null;

    async function tick() {
      if (!alive) return;
      try {
        // Keep CODE POOL filled so PRANIMI works offline (Safari/Chrome have separate storage).
        try {
          const pin = getActorPin();
          await refillBasePoolIfNeeded(pin);
        } catch {}
        await trySyncPendingOps();
      } catch {}
      if (!alive) return;
      t = setTimeout(tick, 12_000);
    }

    const onOnline = () => {
      void trySyncPendingOps();
    };

    window.addEventListener("online", onOnline);
    void tick();

    return () => {
      alive = false;
      window.removeEventListener("online", onOnline);
      if (t) clearTimeout(t);
    };
  }, []);

  return null;
}
