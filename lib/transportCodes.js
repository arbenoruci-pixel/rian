// FILE: rian-main/lib/transportCodes.js
// TRANSPORT T-CODES — OFFLINE-FIRST (Option 1)
//
// Permanent design:
// - Pool per OWNER (PIN) in DB table transport_code_pool
// - One atomic RPC:
//     reserve_transport_codes_batch(p_owner_id text, p_n integer)
//   which returns JSON array like ["T1000","T1001",...]
//   and auto-mints if available < p_n.
// - Local "Mirror Cache" per owner:
//     localStorage key: transport_pool_mirror_<PIN>
// - Offline consumes ONLY from mirror cache (pop).
// - Online refreshes mirror via RPC and then consumes.
//
// NOTE: This file intentionally removes ALL legacy RPCs (_simple/_pool) and any lease logic.

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_REFILL_THRESHOLD = 5;

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function safeJsonParse(s, fallback = null) {
  try {
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function orderCodeKey(oid) {
  return `transport_order_code_v1__${String(oid || '').trim()}`;
}

function mirrorKey(pin) {
  return `transport_pool_mirror_${String(pin || '').trim()}`;
}

function normalizeT(code) {
  if (!code) return '';
  const s = String(code).trim();
  if (/^t\d+$/i.test(s)) return `T${s.replace(/\D+/g, '').replace(/^0+/, '') || '0'}`;
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return `T${n || '0'}`;
}

function uniqSortedCodes(arr) {
  const out = Array.from(new Set((arr || []).map(normalizeT).filter(Boolean)));
  out.sort((a, b) => {
    const na = parseInt(String(a).replace(/\D+/g, '') || '0', 10);
    const nb = parseInt(String(b).replace(/\D+/g, '') || '0', 10);
    return na - nb;
  });
  return out;
}

function getOwnerPin(explicit) {
  const x = String(explicit || '').trim();
  if (x) return x;
  try {
    const ts = typeof getTransportSession === 'function' ? getTransportSession() : null;
    const tid = String(ts?.transport_id || '').trim();
    if (tid) return tid;
  } catch {}
  try {
    const a = typeof getActor === 'function' ? getActor() : null;
    const pin = String(a?.pin || '').trim();
    if (pin) return pin;
  } catch {}
  return '';
}

function loadMirror(pin) {
  if (!isBrowser()) return [];
  try {
    const arr = safeJsonParse(localStorage.getItem(mirrorKey(pin)), []);
    return Array.isArray(arr) ? uniqSortedCodes(arr) : [];
  } catch {
    return [];
  }
}

function saveMirror(pin, arr) {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(mirrorKey(pin), JSON.stringify(uniqSortedCodes(arr)));
  } catch {
    // ignore
  }
}

function popMirror(pin) {
  const cur = loadMirror(pin);
  if (!cur.length) return null;
  const code = cur.shift();
  saveMirror(pin, cur);
  return code;
}

async function refreshMirrorFromDb(pin, n = DEFAULT_POOL_SIZE) {
  const owner = getOwnerPin(pin);
  if (!owner) return [];

  const { data, error } = await supabase.rpc('reserve_transport_codes_batch', {
    p_owner_id: owner,
    p_n: Number(n) || DEFAULT_POOL_SIZE,
  });
  if (error) throw error;

  // RPC returns JSON array (jsonb) like ["T1000", ...]
  const codes = Array.isArray(data) ? data : [];
  const clean = uniqSortedCodes(codes);
  saveMirror(owner, clean);
  return clean;
}

// ------------------------------------------------------------
// Public API (existing pages already import these names)
// ------------------------------------------------------------

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  if (!pin) return [];

  const threshold = Number(opts.threshold ?? DEFAULT_REFILL_THRESHOLD);
  const poolSize = Number(opts.poolSize ?? DEFAULT_POOL_SIZE);

  const mirror = loadMirror(pin);
  if (mirror.length >= threshold) return mirror;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return mirror;

  try {
    return await refreshMirrorFromDb(pin, poolSize);
  } catch {
    return mirror;
  }
}

export function peekPoolCount(reservedBy) {
  const pin = getOwnerPin(reservedBy);
  if (!pin) return 0;
  return loadMirror(pin).length;
}

// New main function used by /transport/pranimi
export async function getOrReserveTransportCode(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  const oid = opts?.oid ? String(opts.oid) : '';
  if (!pin) throw new Error('MISSING_TRANSPORT_PIN');

  // Stable draft code per OID (so refresh does not change code while drafting)
  if (oid && isBrowser()) {
    try {
      const cached = localStorage.getItem(orderCodeKey(oid));
      if (cached && String(cached).trim()) return String(cached).trim();
    } catch {}
  }

  // OFFLINE: consume ONLY from mirror
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const off = popMirror(pin);
    if (!off) throw new Error("S'KA T-KOD NE MIRROR (OFFLINE). LIDHU ONLINE QE ME REZERVU 20 T-KODA.");
    if (oid && isBrowser()) {
      try { localStorage.setItem(orderCodeKey(oid), String(off)); } catch {}
    }
    return String(off);
  }

  // ONLINE:
  // 1) prefer existing mirror
  let code = popMirror(pin);
  if (!code) {
    // 2) mirror empty -> fetch from DB
    const mirror = await refreshMirrorFromDb(pin, DEFAULT_POOL_SIZE);
    code = mirror?.[0] ? popMirror(pin) : null;
  }
  if (!code) throw new Error("S'KA T-KOD NE POOL. PROVO PRAP ONLINE.");

  // background refill when mirror gets low
  try {
    void refillPoolIfNeeded(pin, { threshold: DEFAULT_REFILL_THRESHOLD, poolSize: DEFAULT_POOL_SIZE });
  } catch {}

  if (oid && isBrowser()) {
    try { localStorage.setItem(orderCodeKey(oid), String(code)); } catch {}
  }
  return String(code);
}

// Backwards compatible alias (existing imports)
export async function reserveTransportCode(reservedBy, opts = {}) {
  return getOrReserveTransportCode(reservedBy, opts);
}

// Mark used in DB (best effort). If you have a trigger on transport_orders, this is idempotent.
export async function markCodeUsedOrQueue(reservedBy, code) {
  const pin = getOwnerPin(reservedBy);
  const c = normalizeT(code);
  if (!pin || !c) return;
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    await supabase.from('transport_code_pool').update({ status: 'used' }).eq('code', c);
  } catch {
    // ignore
  }
}

// Backwards-compatible export (existing pages import this name)
export async function markTransportCodeUsed(codeStr, usedBy) {
  return markCodeUsedOrQueue(usedBy, codeStr);
}

export function getTransportCodePoolCount(reservedBy) {
  return peekPoolCount(reservedBy);
}

// Optional helpers
export function getTransportPoolMirror(pin) {
  const p = getOwnerPin(pin);
  return p ? loadMirror(p) : [];
}

export function setTransportPoolMirror(pin, codes) {
  const p = getOwnerPin(pin);
  if (!p) return;
  saveMirror(p, codes || []);
}
