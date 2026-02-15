// FILE: rian-main/lib/codeLease.js
// Centralized helpers for code handling + shared utilities.
// Updated: BASE now uses a per-user CODE POOL (like TRANSPORT) and marks codes USED in base_code_pool.

import { supabase } from "@/lib/supabaseClient";
import {
  getActorPin,
  refillBasePoolIfNeeded,
  takeBaseCode,
  markBaseCodeUsedOrQueue,
  flushBaseUsedQueue,
} from "@/lib/baseCodes";


// iOS PWA NOTE:
// Safari and "Add to Home Screen" PWA do NOT share storage reliably.
// So ONLINE code must come from the SERVER (Supabase) using a per-user draft lock.
function userKeyFromPin(pin) {
  return `PIN:${String(pin ?? '').trim() || '0'}`;
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

// --- BASE CODE RESERVE / FINALIZE (POOL) ---
// IMPORTANT:
// - Codes are RESERVED in Supabase via reserve_base_codes_batch / reserve_base_code
// - Codes are MARKED USED via mark_base_code_used
// - Offline: code can be taken only if pool already has reserved codes.

export async function reserveSharedCode(_oid, _minutes = 30) {
  const pin = getActorPin();
  const userKey = userKeyFromPin(pin);

  // keep last pin for safety
  try { localStorage.setItem("last_pin", String(pin)); } catch {}

  const isOnline =
    (typeof navigator !== "undefined" && navigator.onLine === true);

  // --- ONLINE (SOURCE OF TRUTH = SERVER) ---
  // Use server-side draft so Safari + HomeScreen show the SAME code while online.
  if (isOnline) {
    try {
      // best-effort: flush queued USED marks + refill pool for offline usage,
      // but NEVER block the UI on these.
      void flushBaseUsedQueue(pin);
      void refillBasePoolIfNeeded(pin);

      const TIMEOUT_MS = 2500;
      const { data, error } = await Promise.race([
        supabase.rpc("get_or_create_draft_code", { p_user_key: userKey }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("RPC_TIMEOUT")), TIMEOUT_MS)),
      ]);

      if (!error && data != null) {
        const n = Number(data);
        if (Number.isFinite(n) && n > 0) {
          // local hint (not relied on for sync across iOS containers)
          try { localStorage.setItem("last_draft_code", String(n)); } catch {}
          return String(n);
        }
      }
      // fallthrough to offline/pool if RPC returns nothing
    } catch (_e) {
      // fallthrough to offline/pool
    }
  }

  // --- OFFLINE / FALLBACK ---
  // Use only the already-reserved local pool (per-container).
  // This keeps the app usable offline. Codes may differ between Safari/PWA offline.
  await flushBaseUsedQueue(pin);
  await refillBasePoolIfNeeded(pin);
  const codeNum = await takeBaseCode(pin);
  return String(codeNum);
}

export async function markCodeUsed(codeNum, _oid) {
  const pin = getActorPin();
  const userKey = userKeyFromPin(pin);
  try { localStorage.setItem("last_pin", String(pin)); } catch {}

  const isOnline =
    (typeof navigator !== "undefined" && navigator.onLine === true);

  // best-effort: clear server-side draft after successful save,
  // so next PRANIMI session gets a NEW code (same for Safari + PWA).
  if (isOnline) {
    try {
      const TIMEOUT_MS = 2000;
      await Promise.race([
        supabase.rpc("clear_draft_code", { p_user_key: userKey }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("CLEAR_TIMEOUT")), TIMEOUT_MS)),
      ]);
    } catch (_e) {}
  }

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
