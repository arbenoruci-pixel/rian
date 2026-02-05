// FILE: lib/tepihaCode.js
// Centralized helpers for code handling + shared utilities used by PRANIMI and other stages.
// Keep this file small and stable so we don't have to touch big pages when code logic changes.

import { supabase } from "@/lib/supabaseClient";

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

// --- CODE RESERVE / FINALIZE (Supabase RPC) ---
// NOTE: Your DB must have these RPCs:
// - reserve_tepiha_code(p_oid uuid/text, p_minutes int) -> returns code
// - mark_tepiha_code_used(p_code int, p_oid uuid/text)

export async function reserveSharedCode(oid, minutes = 30) {
  if (!oid) throw new Error("MUNGON OID");
  const { data, error } = await supabase.rpc("reserve_tepiha_code", {
    p_oid: oid,
    p_minutes: Number(minutes) || 30,
  });
  if (error) throw error;
  return String(data);
}

export async function markCodeUsed(codeNum, oid) {
  const n = Number(codeNum);
  if (!Number.isFinite(n) || n <= 0) return;
  await supabase.rpc("mark_tepiha_code_used", {
    p_code: n,
    p_oid: oid,
  });
}

// In the lease-based approach there is nothing to release; kept for compatibility.
export async function releaseLocksForCode(_code) {
  return;
}