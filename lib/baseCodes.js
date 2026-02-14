import { supabase } from "@/lib/supabaseClient";

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function poolKey(pin) {
  return `base_code_pool_v1__${pin || "APP"}`;
}
function usedKey(pin) {
  return `base_code_used_queue_v1__${pin || "APP"}`;
}

// ---- AUTO-HEAL (SERVER IS SOURCE OF TRUTH) ----
// iOS Safari / PWA can keep stale localStorage. If a device has an old pool
// (e.g., codes jumping to 700) but the DB has been reset, we MUST ignore
// local pool and rebuild from Supabase.
//
// Strategy:
// - When online, occasionally check if DB is "brand new" (no orders and no base_code_pool rows).
// - If DB is brand new and local pool has ANY codes, wipe local pool/queues + legacy counters.
// - Also wipe if local pool looks suspiciously high while DB has few orders.

function healStampKey(pin) {
  return `base_code_pool_healed_v1__${pin || "APP"}`;
}

function nukeLegacyLocalCounters() {
  try {
    // legacy counters that caused cross-browser jumps
    localStorage.removeItem('code_counter');
    localStorage.removeItem('client_code_counter');
    localStorage.removeItem('tepiha_code_counter');
    localStorage.removeItem('transport_client_code_counter');
  } catch {}
}

async function maybeAutoHealBasePool(pin) {
  if (typeof window === 'undefined') return;
  if (!navigator.onLine) return;

  const actor = String(pin || 'APP');

  // Don’t spam DB checks
  const now = Date.now();
  const last = Number(localStorage.getItem(healStampKey(actor)) || '0') || 0;
  if (now - last < 60_000) return; // at most once per minute
  localStorage.setItem(healStampKey(actor), String(now));

  const localPool = getBasePool(actor);
  if (!localPool.length) {
    // still wipe legacy counters (safe)
    nukeLegacyLocalCounters();
    return;
  }

  const localMax = Math.max(...localPool.map((x) => Number(x) || 0));
  const localMin = Math.min(...localPool.map((x) => Number(x) || 0));

  try {
    // DB "fresh" signals
    const [{ count: ordersCount, error: e1 }, { count: poolCountDb, error: e2 }] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true }),
      supabase.from('base_code_pool').select('code', { count: 'exact', head: true }),
    ]);
    if (!e1 && !e2) {
      const oc = Number(ordersCount || 0);
      const pc = Number(poolCountDb || 0);
      const dbBrandNew = oc === 0 && pc === 0;

      // If DB is brand new but local has codes -> nuke local.
      if (dbBrandNew) {
        resetBasePoolLocal(actor);
        nukeLegacyLocalCounters();
        return;
      }

      // If DB has very few orders but local pool is absurdly high, treat as stale.
      if (oc <= 5 && localMin >= 200) {
        resetBasePoolLocal(actor);
        nukeLegacyLocalCounters();
        return;
      }
    }
  } catch {
    // Heuristic fallback when DB isn't reachable or RLS blocks.
    // If local pool is obviously stale, wipe it.
    if (localMax >= 500) {
      resetBasePoolLocal(actor);
      nukeLegacyLocalCounters();
    }
  }
}

// Try hard to find the current actor PIN (same idea as transport).
export function getActorPin() {
  const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
  if (a?.pin) return String(a.pin);
  if (a?.PIN) return String(a.PIN);

  const s1 = jparse(localStorage.getItem("tepiha_session_v1"), null);
  if (s1?.pin) return String(s1.pin);
  if (s1?.PIN) return String(s1.PIN);

  const s2 = jparse(localStorage.getItem("tepiha_transport_session_v1"), null);
  if (s2?.transport_id) return String(s2.transport_id);

  // fallback: last known pin
  const last = localStorage.getItem("last_pin") || localStorage.getItem("admin_pin");
  if (last) return String(last);

  return "APP";
}

export function getBasePool(pin) {
  const arr = jparse(localStorage.getItem(poolKey(pin)), []);
  return Array.isArray(arr) ? arr : [];
}

export function setBasePool(pin, arr) {
  localStorage.setItem(poolKey(pin), JSON.stringify(Array.isArray(arr) ? arr : []));
}

export function poolCount(pin) {
  return getBasePool(pin).length;
}

// Settings: 50 codes per user, refill when <= 5
const REFILL_COUNT = 50;
const REFILL_THRESHOLD = 5;

export async function refillBasePoolIfNeeded(pin) {
  if (!navigator.onLine) return;
  await maybeAutoHealBasePool(pin);
  const cur = getBasePool(pin);
  if (cur.length > REFILL_THRESHOLD) return;

  const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
    p_reserved_by: String(pin),
    p_count: REFILL_COUNT,
  });
  if (error) throw error;

  const codes = (data || [])
    .map((r) => Number(r?.code))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Merge + de-dup
  const merged = [...cur, ...codes];
  const uniq = Array.from(new Set(merged));
  uniq.sort((a, b) => a - b);
  setBasePool(pin, uniq);
}

export async function takeBaseCode(pin) {
  await maybeAutoHealBasePool(pin);
  // Try local pool first
  const cur = getBasePool(pin);
  if (cur.length > 0) {
    const code = cur.shift();
    setBasePool(pin, cur);
    return Number(code);
  }

  // If offline and pool empty => can't safely create a new global code
  if (!navigator.onLine) {
    throw new Error("NO_POOL_OFFLINE");
  }

  // Online: refill then take
  await refillBasePoolIfNeeded(pin);
  const again = getBasePool(pin);
  if (again.length > 0) {
    const code = again.shift();
    setBasePool(pin, again);
    return Number(code);
  }

  // Last resort: reserve one (should be rare)
  const { data, error } = await supabase.rpc("reserve_base_code", {
    p_reserved_by: String(pin),
  });
  if (error) throw error;
  return Number(data);
}

export async function markBaseCodeUsedOrQueue(pin, code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return;

  // Offline => queue
  if (!navigator.onLine) {
    const q = jparse(localStorage.getItem(usedKey(pin)), []);
    q.push({ code: n, used_by: String(pin), t: Date.now() });
    localStorage.setItem(usedKey(pin), JSON.stringify(q));
    return;
  }

  const { error } = await supabase.rpc("mark_base_code_used", {
    p_code: n,
    p_used_by: String(pin),
  });
  if (error) throw error;
}

export async function flushBaseUsedQueue(pin) {
  if (!navigator.onLine) return;
  const key = usedKey(pin);
  const q = jparse(localStorage.getItem(key), []);
  if (!Array.isArray(q) || q.length === 0) return;

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
  localStorage.setItem(key, JSON.stringify(keep));
}

// Optional helper for manual resets (local only)
export function resetBasePoolLocal(pin) {
  // remove for this pin only
  localStorage.removeItem(poolKey(pin));
  localStorage.removeItem(usedKey(pin));
}
