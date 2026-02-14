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

function minPoolValue(arr) {
  const a = Array.isArray(arr) ? arr : [];
  let m = Infinity;
  for (const x of a) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) m = Math.min(m, n);
  }
  return m === Infinity ? null : m;
}

async function getServerMaxBaseCode() {
  // We don't want to call nextval()/reserve just to "peek".
  // Safe query: read the biggest code already created in orders.
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("code_n")
      .order("code_n", { ascending: false })
      .limit(1);
    if (error) return null;
    const n = Number(data?.[0]?.code_n ?? 0) || 0;
    return n;
  } catch {
    return null;
  }
}

/**
 * AUTO-HEAL (PRO):
 * If DB was reset but the device still has an old local pool (e.g. 700),
 * we must ignore local pool and rebuild it from Supabase.
 *
 * Condition:
 * - online + Supabase reachable
 * - server max code is small (fresh system) OR no orders yet
 * - local pool min is suspiciously large (e.g. > 200)
 */
export async function autoHealBasePoolIfNeeded(pin) {
  if (typeof window === "undefined") return;
  if (!navigator.onLine) return;

  const localPool = getBasePool(pin);
  const localMin = minPoolValue(localPool);

  // If there's no local pool, nothing to heal.
  if (!localMin) return;

  // Only heal when local looks clearly stale.
  if (localMin < 200) return;

  const serverMax = await getServerMaxBaseCode();
  if (serverMax === null) return; // can't reach Supabase, keep local

  const freshSystem = serverMax <= 0 || serverMax < 50;
  const mismatch = freshSystem && localMin >= 200;

  if (!mismatch) return;

  // Nuke only the code-related keys for THIS pin (no manual cache clearing needed).
  try {
    localStorage.removeItem(poolKey(pin));
    localStorage.removeItem(usedKey(pin));
  } catch {}

  // Refill immediately so UX stays smooth.
  try {
    await refillBasePoolIfNeeded(pin, { force: true });
  } catch {}
}

// Settings: 50 codes per user, refill when <= 5
const REFILL_COUNT = 50;
const REFILL_THRESHOLD = 5;

export async function refillBasePoolIfNeeded(pin, opts = {}) {
  if (typeof window === "undefined") return;
  if (!navigator.onLine) return;

  // Heal stale pools first (prevents 700-jump after DB reset).
  try { await autoHealBasePoolIfNeeded(pin); } catch {}

  const force = Boolean(opts?.force);
  const cur = getBasePool(pin);
  if (!force && cur.length > REFILL_THRESHOLD) return;

  const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
    p_reserved_by: String(pin),
    p_count: REFILL_COUNT,
  });
  if (error) throw error;

  const codes = (data || [])
    .map((r) => Number(r?.code))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Merge + de-dup (normal case)
  const merged = [...cur, ...codes];
  const uniq = Array.from(new Set(merged));
  uniq.sort((a, b) => a - b);
  setBasePool(pin, uniq);
}

export async function takeBaseCode(pin) {
  if (typeof window === "undefined") throw new Error("SSR_NO_CODE");

  // Online: heal stale pools BEFORE consuming from local
  if (navigator.onLine) {
    try { await autoHealBasePoolIfNeeded(pin); } catch {}
  }

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
  await refillBasePoolIfNeeded(pin, { force: true });
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
  if (typeof window === "undefined") return;
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
