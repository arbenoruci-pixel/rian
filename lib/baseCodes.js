import { supabase } from "@/lib/supabaseClient";

// Offline-safe BASE codes (numeric): prefetch a pool of REAL codes from Supabase.
//
// STRATEGY
// - Keep a local POOL per actor (PIN)
// - When online and POOL is low, reserve a batch via RPC: reserve_base_codes_batch(p_reserved_by,p_count)
// - When offline, consume from POOL
// - If offline and POOL empty: hard stop (NO fake codes)

const DEFAULT_POOL_SIZE = 50;
const DEFAULT_REFILL_THRESHOLD = 15;

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}

function poolKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `base_code_pool_v1__${a}`;
}
function usedQueueKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `base_code_used_queue_v1__${a}`;
}

function loadPool(reservedBy) {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(poolKey(reservedBy));
  const v = safeJsonParse(raw, []);
  return Array.isArray(v) ? v : [];
}
function savePool(reservedBy, list) {
  if (typeof window === "undefined") return;
  localStorage.setItem(poolKey(reservedBy), JSON.stringify(Array.isArray(list) ? list : []));
}

function pushUsedQueue(reservedBy, codeNum) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  const next = Array.isArray(q) ? q : [];
  next.push({ code: Number(codeNum) || 0, used_by: reservedBy, ts: Date.now() });
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(next.slice(-300)));
}

async function flushUsedQueue(reservedBy) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  if (!Array.isArray(q) || q.length === 0) return;

  const remain = [];
  for (const item of q) {
    const n = Number(item?.code);
    if (!Number.isFinite(n) || n <= 0) continue;
    try {
      const { error } = await supabase.rpc("mark_base_code_used", {
        p_code: n,
        p_used_by: String(reservedBy || "APP"),
      });
      if (error) throw error;
    } catch {
      remain.push(item);
    }
  }
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(remain));
}

async function rpcWithTimeout(promise, ms = 3500) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));
  return Promise.race([promise, timeout]);
}

export async function refillBasePoolIfNeeded(reservedBy, opts = {}) {
  const poolSize = Number(opts.poolSize || DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE;
  const threshold = Number(opts.threshold || DEFAULT_REFILL_THRESHOLD) || DEFAULT_REFILL_THRESHOLD;

  const actor = String(reservedBy || "APP").trim() || "APP";
  const pool = loadPool(actor);
  if (pool.length >= threshold) {
    try { await flushUsedQueue(actor); } catch {}
    return pool;
  }

  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc("reserve_base_codes_batch", {
        p_reserved_by: actor,
        p_count: poolSize,
      }),
      4000
    );
    if (error) throw error;

    // supports [{code: 123}] or [123]
    const codes = (data || [])
      .map((r) => (typeof r === "number" ? r : r?.code))
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    const merged = [...pool, ...codes];
    savePool(actor, merged);
    return merged;
  } catch {
    return pool;
  }
}

export async function takeBaseCodeFromPoolOrOnline(reservedBy) {
  const actor = String(reservedBy || "APP").trim() || "APP";

  const pool = loadPool(actor);
  if (pool.length > 0) {
    const code = Number(pool[0]);
    savePool(actor, pool.slice(1));

    try { await flushUsedQueue(actor); } catch {}
    try { await refillBasePoolIfNeeded(actor); } catch {}

    if (!Number.isFinite(code) || code <= 0) {
      throw new Error("POOL KOD I PAVLEFSHËM");
    }
    return String(code);
  }

  // Pool empty: try online single reserve
  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc("reserve_base_code", { p_reserved_by: actor }),
      3500
    );
    if (error) throw error;

    const n = Number(typeof data === "number" ? data : data?.new_code ?? data?.code);
    if (!Number.isFinite(n) || n <= 0) throw new Error("No code");
    return String(n);
  } catch {
    throw new Error("S'KA RRJET DHE S'KA KODE NË REZERVË. LIDHU NË RRJET DHE BËJ REFILL (POOL).");
  }
}

export async function markBaseCodeUsedOrQueue(reservedBy, codeNum) {
  const actor = String(reservedBy || "APP").trim() || "APP";
  const n = Number(codeNum);
  if (!Number.isFinite(n) || n <= 0) return;

  try {
    const { error } = await rpcWithTimeout(
      supabase.rpc("mark_base_code_used", { p_code: n, p_used_by: actor }),
      3500
    );
    if (error) throw error;
  } catch {
    pushUsedQueue(actor, n);
  }
}

export function getBaseCodePoolCount(reservedBy) {
  return loadPool(reservedBy).length;
}

// helper for local reset
export function resetBaseCodeLocalForAllUsers() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("base_code_pool_v1__") || k.startsWith("base_code_used_queue_v1__"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
}
