// FILE: lib/tepihaCode.js
// Centralized helpers for code handling + shared utilities used by PRANIMI and other stages.
// Keep this file small and stable so we don't have to touch big pages when code logic changes.

import { supabase } from "@/lib/supabaseClient";
import {
  ensureBasePool,
  getActorPin,
  markBaseCodeUsed,
  takeBaseCode,
} from "@/lib/baseCodes";
// Auto-refill BASE pool in the background whenever the module is loaded in the browser.
// This prevents the pool from drifting to 0 while the device is online.
if (typeof window !== "undefined") {
  if (!window.__TEPIHA_BASE_POOL_AUTOFILL__) {
    window.__TEPIHA_BASE_POOL_AUTOFILL__ = true;
    const run = () => {
      try {
        const pin0 = getActorPin();
        ensureBasePool(pin0, 5, 50);
      } catch {}
    };
    // run now (async) and whenever connectivity returns
    setTimeout(run, 0);
    window.addEventListener("online", run);
  }
}


// --- CODE NORMALIZATION ---
// Accepts formats like: "7", "#007", "X7", "T7", "t007".
// Returns "7" for normal order codes, and "T<n>" for transport-like codes.
export function normalizeCode(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, "").replace(/^0+/, "");
    return `T${n || "0"}`;
  }
  const n = s.replace(/\D+/g, "").replace(/^0+/, "");
  return n || "0";
}

export function codeToNumber(raw) {
  const n = Number(String(raw ?? "").replace(/\D+/g, "") || "0");
  return Number.isFinite(n) ? n : 0;
}

// --- m² helper (used across pages) ---
export function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce(
    (sum, r) => sum + (Number(r?.m2) || 0) * (Number(r?.qty) || 0),
    0
  );
  const s = (stazaRows || []).reduce(
    (sum, r) => sum + (Number(r?.m2) || 0) * (Number(r?.qty) || 0),
    0
  );
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}

export async function reserveSharedCode(oid, minutes = 30) {
  // Keep signature for compatibility with existing pages.
  // New approach: BASE uses a per-user numeric pool (same concept as TRANSPORT).
  // oid/minutes are no longer required.
  const pin = getActorPin();
  await ensureBasePool(pin, 5, 50);
  const code = await takeBaseCode(pin);
  return String(code);
}

export async function markCodeUsed(codeNum, oid) {
  const n = Number(codeNum);
  if (!Number.isFinite(n) || n <= 0) return;
  // Keep signature for compatibility; oid is ignored in pool mode.
  const pin = getActorPin();
  await markBaseCodeUsed(pin, n);
}

// In the lease-based approach there is nothing to release; kept for compatibility.
export async function releaseLocksForCode(_code) {
  return;
}