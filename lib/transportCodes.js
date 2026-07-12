// FILE: lib/transportCodes.js
// TRANSPORT T-CODES — ONLINE allocator + exclusive OFFLINE bank.
// Online behavior stays on the smallest safe DB code. A new offline draft may use
// only one of the 10 server-leased codes belonging to this user/device.

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';

const DEFAULT_POOL_SIZE = 1;
const DEFAULT_REFILL_THRESHOLD = 1;
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
  return `transport_order_code_v3_permanent__${String(oid || '').trim()}`;
}

function mirrorKey(pin) {
  return `transport_pool_mirror_v3_single_smallest_${String(pin || '').trim()}`;
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
  const out = Array.from(new Set((arr || []).map(normalizeT).filter(Boolean).filter((c) => c !== 'T0'));
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
  try { localStorage.setItem(mirrorKey(pin), JSON.stringify(uniqSortedCodes(arr))); } catch {}
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
  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('id')
      .or([
        `code_str.eq.${c}`,
        `code_n.eq.${n}`,
        `client_tcode.eq.${c}`,
        `data->>legacy_order_code.eq.${c}`,
        `data->>legacy_client_tcode.eq.${c}`,
      ].join(','))
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

async function queryCodeExistsInClients(code) {
  const c = normalizeT(code);
  const n = codeNum(c);
  if (!c || c === 'T0') return true;
  try {
    const byTcode = await supabase
      .from('transport_clients')
      .select('id')
      .eq('tcode', c)
      .limit(1);
    if (byTcode?.error) throw byTcode.error;
    if (Array.isArray(byTcode?.data) && byTcode.data.length > 0) return true;

    if (Number.isFinite(n) && n > 0) {
      const byLegacyNumeric = await supabase
        .from('transport_clients')
        .select('id')
        .eq('client_code', n)
        .limit(1);
      if (byLegacyNumeric?.error) throw byLegacyNumeric.error;
      if (Array.isArray(byLegacyNumeric?.data) && byLegacyNumeric.data.length > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function queryCodeExistsInTransportPayments(code) {
  const c = normalizeT(code);
  const n = String(codeNum(c));
  if (!c || c === 'T0') return true;
  try {
    const { data, error } = await supabase
      .from('arka_pending_payments')
      .select('id,type,source_module')
      .or(`transport_code_str.eq.${c},order_code.eq.${n}`)
      .limit(20);
    if (error) throw error;
    return (Array.isArray(data) ? data : []).some((row) => {
      const type = String(row?.type || '').trim().toUpperCase();
      const source = String(row?.source_module || '').trim().toUpperCase();
      return type === 'TRANSPORT' || source === 'TRANSPORT';
    });
  } catch {
    return true;
  }
}

async function isTransportCodeKnownUsed(code) {
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

async function cachedReservationBelongsToOwner(code, owner) {
  const c = normalizeT(code);
  const wantedOwner = String(owner || '').trim();
  if (!c || c === 'T0' || !wantedOwner) return false;
  try {
    const { data, error } = await supabase
      .from('transport_code_pool')
      .select('code,status,owner_id')
      .eq('code', c)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    const status = String(data?.status || '').trim().toLowerCase();
    const ownerId = String(data?.owner_id || '').trim();
    return status === CLAIMED_POOL_STATUS && ownerId === wantedOwner;
  } catch {
    return false;
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
    const used = await isTransportCodeKnownUsed(item.code);
    if (used) continue;
    const ok = await claimTransportPoolCode(owner, item.code);
    if (!ok) continue;
    claimed.push(item.code);
  }
  return uniqSortedCodes(claimed);
}

async function reserveViaRpc(owner, n = DEFAULT_POOL_SIZE) {
  const safeN = Math.min(Math.max(Number(n) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);
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
  let clean = await reserveViaRpc(owner, safeN);
  if (!clean.length) clean = await reserveSmallestAvailableTransportCodes(owner, safeN);
  clean = uniqSortedCodes(clean);
  if (clean.length) saveMirror(owner, clean);
  return clean;
}

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
  return pin ? loadMirror(pin).length : 0;
}

async function popVerifiedOnlineCode(pin) {
  const owner = getOwnerPin(pin);
  if (!owner) return null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let code = popMirror(owner);
    if (!code) {
      await refreshMirrorFromDb(owner, 1);
      code = popMirror(owner);
    }
    if (!code) return null;
    const [knownUsed, owned] = await Promise.all([
      isTransportCodeKnownUsed(code),
      cachedReservationBelongsToOwner(code, owner),
    ]);
    if (!knownUsed && owned) return code;
  }
  return null;
}

export async function getOrReserveTransportCode(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  const oid = opts?.oid ? String(opts.oid) : '';
  if (!pin) throw new Error('MISSING_TRANSPORT_PIN');

  if (oid && isBrowser()) {
    try {
      const cached = localStorage.getItem(orderCodeKey(oid));
      if (cached && String(cached).trim()) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return normalizeT(cached);
        const used = await isTransportCodeKnownUsed(cached);
        const owned = !used && await cachedReservationBelongsToOwner(cached, pin);
        if (owned) return normalizeT(cached);
        try { localStorage.removeItem(orderCodeKey(oid)); } catch {}
      }
    } catch {}
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!oid) throw new Error('MISSING_TRANSPORT_OFFLINE_DRAFT_ID');
    const bank = await import('./offlineCodeBank.js');
    const assignment = await bank.takeOfflineTransportCode({ owner: pin, draftId: oid });
    const code = normalizeT(assignment?.code);
    if (!code || code === 'T0') throw new Error('TRANSPORT_OFFLINE_CODE_BANK_EMPTY');
    if (isBrowser()) {
      try { localStorage.setItem(orderCodeKey(oid), code); } catch {}
    }
    return code;
  }

  const code = await popVerifiedOnlineCode(pin);
  if (!code) throw new Error("S'KA T-KOD TË LIRË. POOL-I KA KODE TË PËRDORURA OSE NUK U VERIFIKUA. PROVO PRAP ONLINE.");
  if (oid && isBrowser()) {
    try { localStorage.setItem(orderCodeKey(oid), String(code)); } catch {}
  }
  return String(code);
}

export async function reserveTransportCode(reservedBy, opts = {}) {
  return getOrReserveTransportCode(reservedBy, opts);
}

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

export async function markTransportCodeUsed(codeStr, usedBy) {
  return markCodeUsedOrQueue(usedBy, codeStr);
}

export async function releaseTransportCodeIfUnused(code, ownerId = '') {
  const c = normalizeT(code);
  if (!c || c === 'T0') return false;
  try {
    const { data, error } = await supabase.rpc('release_transport_code_if_unused', {
      p_code: c,
      p_owner_id: String(ownerId || '').trim() || null,
    });
    if (error) throw error;
    if (isBrowser()) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
          const key = String(localStorage.key(i) || '');
          if (key.startsWith('transport_order_code_')) {
            if (normalizeT(localStorage.getItem(key)) === c) localStorage.removeItem(key);
            continue;
          }
          if (key.startsWith('transport_pool_mirror_')) {
            const cached = safeJsonParse(localStorage.getItem(key), []);
            if (!Array.isArray(cached)) continue;
            const next = cached.filter((item) => normalizeT(item) !== c);
            if (next.length !== cached.length) localStorage.setItem(key, JSON.stringify(next));
          }
        }
      } catch {}
    }
    return data === true;
  } catch {
    return false;
  }
}

export function getTransportCodeReservationForOrder(oid) {
  if (!isBrowser() || !oid) return '';
  try { return normalizeT(localStorage.getItem(orderCodeKey(oid)) || ''); } catch { return ''; }
}

export function clearTransportCodeReservationForOrder(oid) {
  if (!isBrowser() || !oid) return;
  try { localStorage.removeItem(orderCodeKey(oid)); } catch {}
}

export async function releaseTransportCodeReservationForOrder(oid, ownerId = '') {
  const draftId = String(oid || '').trim();
  if (!draftId) return false;
  try {
    const bank = await import('./offlineCodeBank.js');
    const offlineAssignment = bank.readOfflineCodeAssignment('transport', draftId);
    if (offlineAssignment) {
      const released = await bank.releaseOfflineCodeForDraft('transport', offlineAssignment.owner_id || ownerId, draftId);
      if (released?.ok) clearTransportCodeReservationForOrder(draftId);
      return released?.ok === true;
    }
  } catch {}

  const code = getTransportCodeReservationForOrder(draftId);
  if (!code || code === 'T0') {
    clearTransportCodeReservationForOrder(draftId);
    return false;
  }
  const released = await releaseTransportCodeIfUnused(code, ownerId);
  if (released) clearTransportCodeReservationForOrder(draftId);
  return released;
}

export function getTransportCodePoolCount(reservedBy) {
  return peekPoolCount(reservedBy);
}

export function getTransportPoolMirror(pin) {
  const p = getOwnerPin(pin);
  return p ? loadMirror(p) : [];
}

export function setTransportPoolMirror(pin, codes) {
  const p = getOwnerPin(pin);
  if (!p) return;
  saveMirror(p, codes || []);
}
