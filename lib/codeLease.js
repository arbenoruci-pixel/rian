// FILE: rian-main/lib/codeLease.js
// Centralized helpers for code handling + shared utilities.
// Updated: BASE now uses a per-user CODE POOL (like TRANSPORT) and marks codes USED in base_code_pool.

import {
  getActorPin,
  ensureBasePool,
  takeBaseCode,
  markBaseCodeUsedOrQueue,
  flushBaseUsedQueue,
} from "@/lib/baseCodes";


// iOS PWA NOTE:
// Cookie-based lease in baseCodes.js is used to reduce Safari vs HomeScreen differences.

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

// --- BASE CODE RESERVE / FINALIZE (POOL) ---
// IMPORTANT:
// - Codes are RESERVED in Supabase via reserve_base_codes_batch / reserve_base_code
// - Codes are MARKED USED via mark_base_code_used
// - Offline: code can be taken only if pool already has reserved codes.

export async function reserveSharedCode(_oid, _minutes = 30) {
  const pin = getActorPin();

  // keep last pin for safety
  try { localStorage.setItem("last_pin", String(pin)); } catch {}

  // ALWAYS prefer local pool (cookie-based lease makes Safari + PWA consistent enough).
  // Behavior:
  // - Online: ensure the pool is topped to 20 for this user.
  // - Offline: can take only from the already-reserved pool.
  void flushBaseUsedQueue(pin);
  void ensureBasePool(pin, 20);
  const codeNum = await takeBaseCode(pin);
  return String(codeNum);
}

export async function markCodeUsed(codeNum, _oid) {
  const pin = getActorPin();
  try { localStorage.setItem("last_pin", String(pin)); } catch {}

  // mark used in base_code_pool (or queue if offline)
  await markBaseCodeUsedOrQueue(pin, codeNum);
}

// In pool-based approach we don't have per-oid leases; kept for compatibility.
export async function releaseLocksForCode(_code) {
  return;
}

// --- Optional legacy helpers (if some page still calls old RPC) ---
export async function legacyMarkTepihaCodeUsedIfNeeded(codeNum, oid) {
  const n = Number(codeNum);
  if (!Number.isFinite(n) || n <= 0) return;
  await supabase.rpc("mark_tepiha_code_used", { p_code: n, p_oid: oid });
}
