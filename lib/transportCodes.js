// FILE: rian-main/lib/transportCodes.js
// TRANSPORT T-CODES — OFFLINE-FIRST
//
// V2 small-code rule:
// - Online reservation always tries the smallest safe AVAILABLE T-code first.
// - DB pool is sorted client-side by numeric code, so released low codes (T22/T23/etc)
//   are reused before high codes.
// - A code is considered unsafe only if it already exists in transport_orders,
//   transport_clients, or TRANSPORT arka payments.
// - Pool status alone is not treated as "used" for an OID cached draft, because
//   the app may have just claimed that code for the current draft.

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';

const DEFAULT_POOL_SIZE = 5;
const DEFAULT_REFILL_THRESHOLD = 2;
const AVAILABLE_POOL_STATUSES = ['available', 'free', 'released'];
const CLAIMED_POOL_STATUS = 'used';

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
  return `transport_pool_mirror_v2_smallest_${String(pin || '').trim()}`;
}

function codeNum(code) {
  const n = parseInt(String(code || '').replace(/\D+/g, '') || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizeT(code) {
  if (!code) return '';
  const s = String(code).trim();
  if (/^t\d+$/i.test(s)) return `T${s.replace(/\D+/g, '').replace(/^0+/, '') || '0'}`;
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return `T${n || '0'}`;
}

function rawCodeVariants(code) {
  const c = normalizeT(code);
  const n = String(codeNum(c) || '').trim();
  return Array.from(new Set([c, n].filter(Boolean)));
}

function codeFromPoolRow(row = {}) {
  return normalizeT(row?.code_str || row?.code || row?.code_n || row?.transport_code || '');
}

function uniqSortedCodes(arr) {
  const out = Array.from(new Set((arr || []).map(normalizeT).filter(Boolean).filter((c) => c !== 'T0')));
  out.sort((a, b) => codeNum(a) - codeNum(b));
  return out;
}

function normalizeRpcCodes(data) {
  if (!Array.isArray(data)) return [];
  return uniqSortedCodes(data.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return item;
    if (item && typeof item === 'object') return item.code_str || item.code || item.code_n || item.transport_code;
    return '';
  }));
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
  } catch {}
}

function popMirror(pin) {
  const cur = loadMirror(pin);
  if (!cur.length) return null;
  const code = cur.shift();
  saveMirror(pin, cur);
  return code;
}

async function queryCodeExistsInOrders(code) {
  const c = normalizeT(code);
  const n = String(codeNum(c));
  if (!c || c === 'T0') return true;

  const orFilter = [
    `code_str.eq.${c}`,
    `code.eq.${c}`,
    `code.eq.${n}`,
    `code_n.eq.${n}`,
    `client_tcode.eq.${c}`,
    `data->>code_str.eq.${c}`,
    `data->>code.eq.${c}`,
    `data->>code.eq.${n}`,
    `data->>code_n.eq.${n}`,
  ].join(',');

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('id')
      .or(orFilter)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch {
    // Conservative fallback with the common canonical fields.
    try {
      const { data } = await supabase
        .from('transport_orders')
        .select('id')
        .or(`code_str.eq.${c},code_n.eq.${n}`)
        .limit(1);
      return Array.isArray(data) && data.length > 0;
    } catch {
      return true;
    }
  }
}

async function queryCodeExistsInClients(code) {
  const c = normalizeT(code);
  const n = String(codeNum(c));
  if (!c || c === 'T0') return true;

  try {
    const { data, error } = await supabase
      .from('transport_clients')
      .select('id')
      .or(`tcode.eq.${c},code.eq.${c},code.eq.${n},client_code.eq.${c},client_code.eq.${n}`)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch {
    // Older installs may not have all fields. Fail open here; transport_orders and
    // arka payment checks still protect real history. A bad column should not block
    // all low-code reuse forever.
    return false;
  }
}

async function queryCodeExistsInTransportPayments(code) {
  const c = normalizeT(code);
  const n = String(codeNum(c));
  if (!c || c === 'T0') return true;
  try {
    const { data, error } = await supabase
      .from('arka_pending_payments')
      .select('id')
      .eq('type', 'TRANSPORT')
      .or(`transport_code_str.eq.${c},order_code.eq.${n}`)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

async function isTransportCodeKnownUsed(code) {
  // Used by cached draft verification. Do NOT reject merely because pool.status
  // is "used/reserved"; the current draft may have just claimed it.
  const c = normalizeT(code);
  if (!c || c === 'T0') return true;
  try {
    const [hasOrder, hasClient, hasPayment] = await Promise.all([
      queryCodeExistsInOrders(c),
      queryCodeExistsInClients(c),
      queryCodeExistsInTransportPayments(c),
    ]);
    return !!(hasOrder || hasClient || hasPayment);
  } catch {
    return true;
  }
}

async function claimTransportPoolCode(owner, code) {
  const c = normalizeT(code);
  if (!owner || !c || c === 'T0') return false;

  const variants = rawCodeVariants(c);
  const updatePayloads = [
    { status: CLAIMED_POOL_STATUS, owner_id: owner },
    { status: CLAIMED_POOL_STATUS },
  ];

  for (const payload of updatePayloads) {
    for (const raw of variants) {
      try {
        const { data, error } = await supabase
          .from('transport_code_pool')
          .update(payload)
          .in('status', AVAILABLE_POOL_STATUSES)
          .eq('code', raw)
          .select('*')
          .limit(1);
        if (error) throw error;
        if (Array.isArray(data) && data.length > 0) return true;
      } catch (err) {
        // owner_id may not exist in some deployments; retry without it.
        if (payload.owner_id) break;
      }
    }
  }

  return false;
}

async function reserveSmallestAvailableTransportCodes(owner, count = DEFAULT_POOL_SIZE) {
  const safeCount = Math.min(Math.max(Number(count) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);
  const claimed = [];

  let rows = [];
  try {
    const { data, error } = await supabase
      .from('transport_code_pool')
      .select('*')
      .in('status', AVAILABLE_POOL_STATUSES)
      .limit(2000);
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch {
    return [];
  }

  const candidates = rows
    .map((row) => ({ row, code: codeFromPoolRow(row), n: codeNum(codeFromPoolRow(row)) }))
    .filter((x) => x.code && x.code !== 'T0' && x.n > 0)
    .sort((a, b) => a.n - b.n);

  for (const item of candidates) {
    if (claimed.length >= safeCount) break;
    const code = item.code;

    // Never claim a code with real history.
    const used = await isTransportCodeKnownUsed(code);
    if (used) continue;

    const ok = await claimTransportPoolCode(owner, code);
    if (!ok) continue;

    claimed.push(code);
  }

  return uniqSortedCodes(claimed);
}

async function reserveViaRpc(owner, n = DEFAULT_POOL_SIZE) {
  const safeN = Math.min(Math.max(Number(n) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);

  // Support both RPC signatures seen in older deployments.
  const attempts = [
    { fn: 'reserve_transport_codes_batch', args: { p_owner_id: owner, p_n: safeN } },
    { fn: 'reserve_transport_codes_batch', args: { p_reserved_by: owner, p_count: safeN } },
  ];

  for (const attempt of attempts) {
    try {
      const { data, error } = await supabase.rpc(attempt.fn, attempt.args);
      if (error) throw error;
      const codes = normalizeRpcCodes(data);
      if (codes.length) return codes;
    } catch {}
  }

  return [];
}

async function refreshMirrorFromDb(pin, n = DEFAULT_POOL_SIZE) {
  const owner = getOwnerPin(pin);
  if (!owner) return [];

  const safeN = Math.min(Math.max(Number(n) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);

  // Main path: direct DB claim of the smallest safe available codes.
  let clean = await reserveSmallestAvailableTransportCodes(owner, safeN);

  // Fallback: existing RPC, still sorted before mirror save.
  if (!clean.length) {
    clean = await reserveViaRpc(owner, safeN);
  }

  clean = uniqSortedCodes(clean);
  if (clean.length) saveMirror(owner, clean);
  return clean;
}

// ------------------------------------------------------------
// Public API (existing pages already import these names)
// ------------------------------------------------------------

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  if (!pin) return [];

  const threshold = Math.min(Math.max(Number(opts.threshold ?? DEFAULT_REFILL_THRESHOLD) || DEFAULT_REFILL_THRESHOLD, 1), DEFAULT_POOL_SIZE);
  const poolSize = Math.min(Math.max(Number(opts.poolSize ?? DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);
  const force = Boolean(opts.force);

  const mirror = loadMirror(pin);
  if (!force && mirror.length >= threshold) return mirror;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return mirror;

  try {
    const fresh = await refreshMirrorFromDb(pin, poolSize);
    return fresh.length ? fresh : loadMirror(pin);
  } catch {
    return mirror;
  }
}

export function peekPoolCount(reservedBy) {
  const pin = getOwnerPin(reservedBy);
  if (!pin) return 0;
  return loadMirror(pin).length;
}

async function popVerifiedOnlineCode(pin) {
  const owner = getOwnerPin(pin);
  if (!owner) return null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    let code = popMirror(owner);
    if (!code) {
      await refreshMirrorFromDb(owner, DEFAULT_POOL_SIZE);
      code = popMirror(owner);
    }
    if (!code) return null;

    // Only real order/client/payment history blocks the code.
    const knownUsed = await isTransportCodeKnownUsed(code);
    if (!knownUsed) return code;
  }

  return null;
}

// Main function used by /transport/pranimi
export async function getOrReserveTransportCode(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  const oid = opts?.oid ? String(opts.oid) : '';
  if (!pin) throw new Error('MISSING_TRANSPORT_PIN');

  // Stable draft code per OID (so refresh does not change code while drafting).
  if (oid && isBrowser()) {
    try {
      const cached = localStorage.getItem(orderCodeKey(oid));
      if (cached && String(cached).trim()) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return String(cached).trim();
        const used = await isTransportCodeKnownUsed(cached);
        if (!used) return String(cached).trim();
        try { localStorage.removeItem(orderCodeKey(oid)); } catch {}
      }
    } catch {}
  }

  // OFFLINE: consume ONLY from mirror.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const off = popMirror(pin);
    if (!off) throw new Error("S'KA T-KOD NE MIRROR (OFFLINE). LIDHU ONLINE QE ME REZERVU 3-5 T-KODA.");
    if (oid && isBrowser()) {
      try { localStorage.setItem(orderCodeKey(oid), String(off)); } catch {}
    }
    return String(off);
  }

  // ONLINE: smallest safe available T-code wins.
  const code = await popVerifiedOnlineCode(pin);
  if (!code) throw new Error("S'KA T-KOD TË LIRË. POOL-I KA KODE TË PËRDORURA OSE NUK U VERIFIKUA. PROVO PRAP ONLINE.");

  // Background refill when mirror gets low; it will also prefer small codes.
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

// Mark used in DB (best effort). Direct reservation already marks used, so this is idempotent.
export async function markCodeUsedOrQueue(reservedBy, code) {
  const pin = getOwnerPin(reservedBy);
  const c = normalizeT(code);
  if (!pin || !c) return;
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const payloads = [
      { status: CLAIMED_POOL_STATUS, owner_id: pin },
      { status: CLAIMED_POOL_STATUS },
    ];

    for (const payload of payloads) {
      try {
        const { error } = await supabase
          .from('transport_code_pool')
          .update(payload)
          .eq('code', c);
        if (!error) return;
      } catch (err) {
        if (!payload.owner_id) throw err;
      }
    }
  } catch {}
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
