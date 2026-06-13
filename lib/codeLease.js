// lib/baseCodes.js
// BASE CODES — PROFI MODE (DB pool only)
// Uses ONLY these RPCs:
//  - reserve_base_codes_batch_simple(p_pin text, p_count int) -> table(code int)
//  - mark_base_code_used_simple(p_pin text, p_code int) -> void
//
// Local mirror:
//  - base_code_pool:<PIN> -> JSON array of ints
//  - base_order_code:<OID> -> string int

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';

const POOL_TARGET = 20;

const LS_POOL_PREFIX = 'base_code_pool:';     // base_code_pool:<PIN>
const LS_ORDER_CODE_PREFIX = 'base_order_code:'; // base_order_code:<OID>

function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

function toIntSafe(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function poolKey(pin) {
  return `${LS_POOL_PREFIX}${String(pin)}`;
}
function orderCodeKey(oid) {
  return `${LS_ORDER_CODE_PREFIX}${String(oid)}`;
}

export function normalizeCode(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = toIntSafe(m[1]);
  return n && n > 0 ? n : null;
}

export function computeM2FromRows(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const r of rows) {
    const v = r?.m2 ?? r?.m ?? r?.area ?? r?.value;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return Math.round(total * 100) / 100;
}

function readPool(pin) {
  const raw = lsGet(poolKey(pin), '[]');
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(toIntSafe).filter((n) => typeof n === 'number' && n > 0);
  } catch {
    return [];
  }
}

function writePool(pin, arr) {
  const clean = Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map(toIntSafe)
        .filter((n) => typeof n === 'number' && n > 0)
    )
  ).sort((a, b) => a - b);

  lsSet(poolKey(pin), JSON.stringify(clean));
  return clean;
}

function popFromPool(pin) {
  const arr = readPool(pin);
  const code = arr.shift();
  writePool(pin, arr);
  return typeof code === 'number' ? code : null;
}

function pushBackToPool(pin, code) {
  const c = toIntSafe(code);
  if (!c || c <= 0) return;
  const arr = readPool(pin);
  arr.push(c);
  writePool(pin, arr);
}

function resolvePin(pinOverride = null) {
  const p =
    pinOverride ??
    getActor?.()?.pin ??
    getActor?.()?.pinCode ??
    getActor?.()?.id ??
    lsGet('actor_pin') ??
    lsGet('pin') ??
    lsGet('tepiha_pin');

  const s = String(p ?? '').trim();
  return s ? s : null;
}

// “online check” real: try reserve with count=0
async function isDbReachable(pin) {
  try {
    const { error } = await supabase.rpc('reserve_base_codes_batch_simple', {
      p_pin: String(pin),
      p_count: 0,
    });
    return !error;
  } catch {
    return false;
  }
}

// Exported: make sure pool has ~20 codes when online
export async function ensureBasePool(pinOverride = null, desired = POOL_TARGET) {
  const pin = resolvePin(pinOverride);
  if (!pin) throw new Error('PIN missing');

  const local = readPool(pin);
  if (local.length >= Math.max(1, desired)) return local;

  const reachable = await isDbReachable(pin);
  if (!reachable) return local; // offline: keep whatever local has

  const { data, error } = await supabase.rpc('reserve_base_codes_batch_simple', {
    p_pin: pin,
    p_count: desired,
  });

  if (error) throw new Error(`reserve_base_codes_batch_simple failed: ${error.message}`);

  const codes = Array.isArray(data)
    ? data.map((x) => toIntSafe(x?.code)).filter((n) => typeof n === 'number' && n > 0)
    : [];

  return writePool(pin, [...local, ...codes]);
}

// Exported: reserve code for an order OID
export async function reserveSharedCode(oid, pinOverride = null) {
  const pin = resolvePin(pinOverride);
  if (!pin) throw new Error('PIN missing');
  if (!oid) throw new Error('OID missing');

  const cached = normalizeCode(lsGet(orderCodeKey(oid)));
  if (cached) return cached;

  let code = popFromPool(pin);

  if (!code) {
    // try refill online
    const reachable = await isDbReachable(pin);
    if (!reachable) {
      throw new Error('NUK KA KODE. LIDHU ONLINE per me marre 20 kode te reja.');
    }
    await ensureBasePool(pin, POOL_TARGET);
    code = popFromPool(pin);
  }

  if (!code) throw new Error('NUK KA KODE NE POOL. PROVO PRAPE ONLINE.');

  lsSet(orderCodeKey(oid), String(code));
  return code;
}

// Exported: mark code USED in DB (online)
// Keep signature compatible with PRANIMI: markCodeUsed(code, oid)
export async function markCodeUsed(code, oid = null, pinOverride = null) {
  const pin = resolvePin(pinOverride);
  if (!pin) throw new Error('PIN missing');

  const c = normalizeCode(code);
  if (!c) throw new Error('Invalid code');

  const reachable = await isDbReachable(pin);
  if (!reachable) throw new Error('DB OFFLINE: cannot mark code used now.');

  const { error } = await supabase.rpc('mark_base_code_used_simple', {
    p_pin: pin,
    p_code: c,
  });

  if (error) throw new Error(`mark_base_code_used_simple failed: ${error.message}`);

  if (oid) lsSet(orderCodeKey(oid), String(c));
  return true;
}

// Exported: local-only release for canceled drafts
export function releaseLocksForCode(oid, pinOverride = null) {
  const pin = resolvePin(pinOverride);
  if (!pin || !oid) return false;

  const cached = normalizeCode(lsGet(orderCodeKey(oid)));
  if (!cached) return false;

  pushBackToPool(pin, cached);
  lsDel(orderCodeKey(oid));
  return true;
}