// FILE: lib/baseCodes.js
// Base (non-transport) numeric code pool helpers.
// Goal: Make BASE code generation work like TRANSPORT: per-user pool + offline-safe.

import { supabase } from "@/lib/supabaseClient";

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function isBrowser() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function poolKey(pin) {
  return `base_code_pool_v1__${pin || "APP"}`;
}

function usedKey(pin) {
  return `base_code_used_queue_v1__${pin || "APP"}`;
}

export function getActorPin() {
  if (!isBrowser()) return "APP";
  const u = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
  return String(u?.pin || u?.PIN || u?.id || "APP");
}

export function getBasePoolCount(pin) {
  if (!isBrowser()) return 0;
  const arr = jparse(localStorage.getItem(poolKey(pin)), []);
  return Array.isArray(arr) ? arr.length : 0;
}

function readArr(key) {
  if (!isBrowser()) return [];
  const arr = jparse(localStorage.getItem(key), []);
  return Array.isArray(arr) ? arr : [];
}

function writeArr(key, arr) {
  if (!isBrowser()) return;
  localStorage.setItem(key, JSON.stringify(Array.isArray(arr) ? arr : []));
}

export async function refillBasePool(pin, count = 50) {
  const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
    p_reserved_by: String(pin),
    p_count: Number(count),
  });
  if (error) throw error;
  const codes = (data || [])
    .map((r) => Number(r?.code))
    .filter((n) => Number.isFinite(n) && n > 0);

  const key = poolKey(pin);
  const cur = readArr(key);
  writeArr(key, [...cur, ...codes]);
  return codes.length;
}

export async function flushBaseUsedQueue(pin) {
  if (!isBrowser() || !navigator.onLine) return;
  const key = usedKey(pin);
  const q = readArr(key);
  if (!q.length) return;

  const keep = [];
  for (const it of q) {
    try {
      const { error } = await supabase.rpc("mark_base_code_used", {
        p_code: Number(it?.code),
        p_used_by: String(pin),
      });
      if (error) throw error;
    } catch {
      keep.push(it);
    }
  }
  writeArr(key, keep);
}

export async function markBaseCodeUsed(pin, code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };

  if (!isBrowser() || !navigator.onLine) {
    const key = usedKey(pin);
    const q = readArr(key);
    q.push({ code: n, used_by: String(pin), t: Date.now() });
    writeArr(key, q);
    return { queued: true };
  }

  const { error } = await supabase.rpc("mark_base_code_used", {
    p_code: n,
    p_used_by: String(pin),
  });
  if (error) throw error;
  return { ok: true };
}

export async function takeBaseCode(pin) {
  const pKey = poolKey(pin);
  const cur = readArr(pKey);
  if (cur.length) {
    const code = cur.shift();
    writeArr(pKey, cur);
    return Number(code);
  }

  // Offline and no pool => don't invent codes (would cause conflicts later)
  if (!isBrowser() || !navigator.onLine) {
    throw new Error("NO_POOL_OFFLINE");
  }

  // Online fallback: reserve a single code
  const { data, error } = await supabase.rpc("reserve_base_code", {
    p_reserved_by: String(pin),
  });
  if (error) throw error;
  const n = Number(data);
  if (!Number.isFinite(n) || n <= 0) throw new Error("BAD_CODE");
  return n;
}

// Convenience helper: keep pool topped up without blocking the UX
export async function ensureBasePool(pin, minLeft = 10, refillCount = 50) {
  try {
    await flushBaseUsedQueue(pin);
  } catch {
    // ignore
  }
  if (!isBrowser() || !navigator.onLine) return;
  const left = getBasePoolCount(pin);
  if (left >= minLeft) return;
  try {
    await refillBasePool(pin, refillCount);
  } catch {
    // ignore
  }
}

export function resetBaseLocalCodes() {
  if (!isBrowser()) return;
  Object.keys(localStorage)
    .filter(
      (k) =>
        k.startsWith("base_code_pool_v1__") ||
        k.startsWith("base_code_used_queue_v1__")
    )
    .forEach((k) => localStorage.removeItem(k));
}
