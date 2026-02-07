// lib/baseCodes.js
// TEPIHA — BASE (BAZA) code pool
// Per-user (PIN) reservation with offline-safe behavior.
// Pool size: 50 codes per PIN, refill when remaining <= 5.

import { supabase } from "@/lib/supabaseClient";
import { getActor } from "@/lib/actorSession";

const LOW_WATER = 5;
const REFILL_COUNT = 50;

function jparse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}

function poolKey(pin) { return `base_code_pool_v1__${pin || "APP"}`; }
function usedKey(pin) { return `base_code_used_queue_v1__${pin || "APP"}`; }

export function getActorPin() {
  const a = getActor();
  const pin = String(a?.pin || "").trim();
  return pin || "APP";
}

function getPool(pin) {
  const arr = jparse(localStorage.getItem(poolKey(pin)), []);
  return Array.isArray(arr) ? arr : [];
}

function setPool(pin, arr) {
  localStorage.setItem(poolKey(pin), JSON.stringify(arr || []));
}

function getUsedQueue(pin) {
  const arr = jparse(localStorage.getItem(usedKey(pin)), []);
  return Array.isArray(arr) ? arr : [];
}

function setUsedQueue(pin, arr) {
  localStorage.setItem(usedKey(pin), JSON.stringify(arr || []));
}

export function getBasePoolCount(pin) {
  return getPool(pin).length;
}

// Refill pool if low and online
export async function ensureBasePool(pin, { lowWater = LOW_WATER, refillCount = REFILL_COUNT } = {}) {
  if (typeof window === "undefined") return;
  if (!navigator.onLine) return;

  const cur = getPool(pin);
  if (cur.length > lowWater) return;

  const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
    p_reserved_by: String(pin),
    p_count: Number(refillCount),
  });
  if (error) throw error;

  const codes = (data || [])
    .map(r => Number(r?.code))
    .filter(n => Number.isFinite(n) && n > 0);

  if (!codes.length) return;

  setPool(pin, [...cur, ...codes]);
}

// Take next code from pool. If pool empty and online, auto-refill then take.
export async function takeBaseCode(pin) {
  if (typeof window === "undefined") throw new Error("NO_BROWSER");

  await flushBaseUsedQueue(pin).catch(() => {});
  await ensureBasePool(pin).catch(() => {});

  const cur = getPool(pin);
  if (cur.length > 0) {
    const code = cur.shift();
    setPool(pin, cur);
    return Number(code);
  }

  // If offline and empty: fail fast (no collisions)
  if (!navigator.onLine) {
    const e = new Error("NO_POOL_OFFLINE");
    e.code = "NO_POOL_OFFLINE";
    throw e;
  }

  // Online but still empty: reserve one code
  const { data, error } = await supabase.rpc("reserve_base_code", {
    p_reserved_by: String(pin),
  });
  if (error) throw error;
  return Number(data);
}

// Mark code as used. If offline, queue; flush later.
export async function markBaseCodeUsed(pin, code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return;

  if (!navigator.onLine) {
    const q = getUsedQueue(pin);
    q.push({ code: n, used_by: String(pin), t: Date.now() });
    setUsedQueue(pin, q);
    return;
  }

  const { error } = await supabase.rpc("mark_base_code_used", {
    p_code: n,
    p_used_by: String(pin),
  });
  if (error) throw error;
}

export async function flushBaseUsedQueue(pin) {
  if (typeof window === "undefined") return;
  if (!navigator.onLine) return;

  const q = getUsedQueue(pin);
  if (!q.length) return;

  const keep = [];
  for (const it of q) {
    try {
      const { error } = await supabase.rpc("mark_base_code_used", {
        p_code: Number(it.code),
        p_used_by: String(it.used_by || pin),
      });
      if (error) throw error;
    } catch {
      keep.push(it);
    }
  }
  setUsedQueue(pin, keep);
}

export function resetBasePoolLocal(pin) {
  try {
    localStorage.removeItem(poolKey(pin));
    localStorage.removeItem(usedKey(pin));
  } catch {}
}
