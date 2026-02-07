// FILE: lib/codeLease.js
// TEPIHA — Base code engine (BAZA)
// Uses POOL per PIN for offline-safe code allocation.

import { getActor } from "@/lib/actorSession";
import { ensureBasePool, flushBaseUsedQueue, takeBaseCode, markBaseCodeUsed } from "@/lib/baseCodes";

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

function pinOrApp() {
  const a = getActor();
  const pin = String(a?.pin || "").trim();
  return pin || "APP";
}

// Auto-maintain pool when online (quietly)
function attachAutoRefill() {
  if (typeof window === "undefined") return;
  if (window.__TEPIHA_BASE_POOL_WIRED__) return;
  window.__TEPIHA_BASE_POOL_WIRED__ = true;

  const pin = pinOrApp();

  // On load: flush used queue + refill if needed
  setTimeout(() => {
    flushBaseUsedQueue(pin).catch(() => {});
    ensureBasePool(pin).catch(() => {});
  }, 50);

  // When internet returns
  window.addEventListener("online", () => {
    flushBaseUsedQueue(pin).catch(() => {});
    ensureBasePool(pin).catch(() => {});
  });
}

// --- CODE RESERVE / FINALIZE ---
export async function reserveSharedCode(_oid, _minutes = 30) {
  attachAutoRefill();
  const pin = pinOrApp();
  // NOTE: oid/minutes kept for compatibility; pool is per PIN.
  const code = await takeBaseCode(pin);
  return String(code);
}

export async function markCodeUsed(codeNum, _oid) {
  attachAutoRefill();
  const pin = pinOrApp();
  const n = Number(codeNum);
  if (!Number.isFinite(n) || n <= 0) return;
  await markBaseCodeUsed(pin, n);
}

// In pool-based approach there is nothing to release; kept for compatibility.
export async function releaseLocksForCode(_code) {
  return;
}
