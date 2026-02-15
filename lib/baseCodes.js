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

// Settings: 50 codes per user, refill when <= 5
const REFILL_COUNT = 50;

// AUTO-HEAL: if device has stale local pool (Safari/HomeScreen) after DB reset,
// discard huge local codes when server appears "fresh".
async function autoHealStalePool(pin) {
  try {
    if (typeof window === "undefined") return;
    if (!navigator.onLine) return;
    const pool = getBasePool(pin);
    if (!pool.length) return;

    const maxLocal = Math.max(...pool.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
    if (!Number.isFinite(maxLocal)) return;

    // Only consider "huge" pools as suspicious
    if (maxLocal < 500) return;

    // Check server freshness (cheap HEAD+count)
    const { count, error } = await supabase
      .from("orders")
      .select("id", { count: "exact", head: true });
    if (error) return;

    // If server is basically empty/new, local huge pool is stale -> nuke
    if ((count ?? 0) < 5) {
      resetBasePoolLocal(pin);

      // Also remove legacy/global keys that used to affect codes
      const legacyKeys = [
        "base_code_pool",
        "base_code_pool_v1",
        "code_counter",
        "client_code_counter",
        "tepiha_code_counter",
        "base_code_pool_v0",
      ];
      for (const k of legacyKeys) {
        try { localStorage.removeItem(k); } catch {}
      }
    }
  } catch {
    // ignore
  }
}

const REFILL_THRESHOLD = 5;

// Fallback reserving codes without RPCs.
// Uses INSERT so Postgres/sequence generates the next code safely.
async function reserveCodesViaInsert(pin, count = 1) {
  const want = Math.max(1, Math.min(50, Number(count) || 1));
  const out = [];
  for (let i = 0; i < want; i++) {
    let lastErr = null;
    for (let k = 0; k < 5; k++) {
      try {
        // Prefer tagging reserved_by when possible.
        const r1 = await supabase
          .from("base_code_pool")
          .insert([{ reserved_by: String(pin) }])
          .select("code")
          .single();
        if (r1.error) {
          // If schema doesn't accept reserved_by (column mismatch / RLS), try blank insert.
          const msg = String(r1.error?.message || "");
          const code = String(r1.error?.code || "");
          if (code === "42703" || /reserved_by/i.test(msg)) {
            const r2 = await supabase
              .from("base_code_pool")
              .insert([{}])
              .select("code")
              .single();
            if (r2.error) throw r2.error;
            out.push(Number(r2.data?.code));
            lastErr = null;
            break;
          }
          throw r1.error;
        }
        out.push(Number(r1.data?.code));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
  }
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

export async function refillBasePoolIfNeeded(pin) {
  await autoHealStalePool(pin);
  if (!navigator.onLine) return;
  const cur = getBasePool(pin);
  if (cur.length > REFILL_THRESHOLD) return;

  let codes = [];
  try {
    const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
      p_reserved_by: String(pin),
      p_count: REFILL_COUNT,
    });
    if (error) throw error;

    codes = (data || [])
      .map((r) => Number(r?.code))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // RPC can fail (constraints / function mismatch). Fallback to INSERT-based generator.
    // Keep it smaller to avoid rate limits.
    codes = await reserveCodesViaInsert(pin, 15);
  }

  // Merge + de-dup
  const merged = [...cur, ...codes];
  const uniq = Array.from(new Set(merged));
  uniq.sort((a, b) => a - b);
  setBasePool(pin, uniq);
}

export async function takeBaseCode(pin) {
  await autoHealStalePool(pin);
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
  try {
    const { data, error } = await supabase.rpc("reserve_base_code", {
      p_reserved_by: String(pin),
    });
    if (error) throw error;
    return Number(data);
  } catch {
    const codes = await reserveCodesViaInsert(pin, 1);
    return Number(codes[0] || 0);
  }
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
