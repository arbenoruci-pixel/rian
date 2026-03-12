// lib/syncBootstrap.js
// Starts a safe foreground sync loop for offline queue + code pools.
// Runs ONLY in the browser.

import { runSync } from "@/lib/syncEngine";
import { getActorPin, refillBasePoolIfNeeded, flushBaseUsedQueue } from "@/lib/baseCodes";
import { refillPoolIfNeeded as refillTransportPoolIfNeeded } from "@/lib/transportCodes";

let started = false;

async function safe(fn){
  try { await fn(); } catch {}
}

export function startSyncLoop(){
  if (started) return;
  if (typeof window === "undefined") return;
  started = true;

  const tick = async () => {
    if (!navigator.onLine) return;
    const pin = (() => { try { return getActorPin(); } catch { return "APP"; } })();

    await safe(() => refillBasePoolIfNeeded(pin));
    await safe(() => flushBaseUsedQueue(pin));

    // transport pool uses same pin/transport_id keying inside transportCodes
    await safe(() => refillTransportPoolIfNeeded(pin));
    

    await safe(() => runSync());
  };

  // run once on start
  tick();

  // online event
  window.addEventListener("online", tick);

  // when app comes back to foreground
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });

  // lightweight interval while app is open
  setInterval(tick, 20 * 1000);
}
