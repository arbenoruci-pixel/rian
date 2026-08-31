// FILE: lib/transportCodes.js
// TRANSPORT T-CODES — ONLINE allocator + exclusive OFFLINE bank.
// Online behavior stays on the smallest safe DB code. A new offline draft may use
// only one of the 10 server-leased codes belonging to this user/device.

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';
import { normalizeTransportCodeRpcResponse } from '@/lib/transportCodeRpcResponse';

const DEFAULT_POOL_SIZE = 1;
const DEFAULT_REFILL_THRESHOLD = 1;
const CLAIMED_POOL_STATUS = 'used';
const inFlightReservationsByOrder = new Map();

function allocatorError(code, message, cause = null) {
  const error = new Error(message || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

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

function uniqSortedCodes(arr) {
  const out = Array.from(new Set((arr || []).map(normalizeT).filter(Boolean).filter((c) => c !== 'T0')));
  out.sort((a, b) => codeNum(a) - codeNum(b));
  return out;
}

function getOwnerPin(explicit) {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  try {
    const session = typeof getTransportSession === 'function' ? getTransportSession() : null;
    const pin = String(
      session?.transport_pin ||
      session?.pin ||
      session?.driver_pin ||
      session?.transport_id ||
      '',
    ).trim();
    if (pin) return pin;
  } catch {}
  try {
    const actor = typeof getActor === 'function' ? getActor() : null;
    const pin = String(actor?.pin || '').trim();
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
  if (!isBrowser()) return false;
  try {
    localStorage.setItem(mirrorKey(pin), JSON.stringify(uniqSortedCodes(arr)));
    return true;
  } catch {
    return false;
  }
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

async function reserveViaRpc(owner, n = DEFAULT_POOL_SIZE) {
  const safeN = Math.min(Math.max(Number(n) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);
  let response;
  try {
    response = await supabase.rpc('reserve_transport_codes_batch', {
      p_owner_id: owner,
      p_n: safeN,
    });
  } catch (error) {
    throw allocatorError(
      'TRANSPORT_CODE_RESERVE_RPC_NETWORK_FAILED',
      `REZERVIMI I T-CODE DËSHTOI NË RRJET. ${error?.message || ''}`.trim(),
      error,
    );
  }

  if (response?.error) {
    throw allocatorError(
      'TRANSPORT_CODE_RESERVE_RPC_FAILED',
      `REZERVIMI I T-CODE U REFUZUA NGA DB. ${response.error?.message || response.error?.code || ''}`.trim(),
      response.error,
    );
  }

  const codes = normalizeTransportCodeRpcResponse(response?.data);
  if (!codes.length) {
    throw allocatorError(
      'TRANSPORT_CODE_RESERVE_RPC_RESPONSE_INVALID',
      'DB E PRANOI REZERVIMIN, POR NUK KTHEU T-CODE VALID. PROVO PRAP ME TË NJEJTËN POROSI.',
    );
  }
  if (codes.length > safeN) {
    const cleanups = [];
    for (const code of codes) {
      cleanups.push(await releaseTransportCodeIfUnusedDetailed(code, owner));
    }
    const allConfirmed = cleanups.every((item) => item.confirmed);
    throw allocatorError(
      allConfirmed
        ? 'TRANSPORT_CODE_RESERVE_RPC_TOO_MANY_RELEASED'
        : 'TRANSPORT_CODE_RESERVE_RPC_TOO_MANY_RELEASE_FAILED',
      allConfirmed
        ? 'DB KTHEU MË SHUMË SE NJË T-CODE; KODET U LIRUAN.'
        : 'DB KTHEU MË SHUMË SE NJË T-CODE DHE LIRIMI NUK U VERIFIKUA.',
    );
  }

  // The canonical RPC is called once. Retrying it with another argument shape
  // after an HTTP 200 can reserve a second code and strand the first one.
  return codes;
}

async function refreshMirrorFromDb(pin, n = DEFAULT_POOL_SIZE) {
  const owner = getOwnerPin(pin);
  if (!owner) return [];
  const safeN = Math.min(Math.max(Number(n) || DEFAULT_POOL_SIZE, 1), DEFAULT_POOL_SIZE);
  const clean = uniqSortedCodes(await reserveViaRpc(owner, safeN));
  if (clean.length && !saveMirror(owner, clean)) {
    const cleanups = [];
    for (const code of clean) cleanups.push(await releaseTransportCodeIfUnusedDetailed(code, owner));
    const allConfirmed = cleanups.every((item) => item.confirmed);
    throw allocatorError(
      allConfirmed
        ? 'TRANSPORT_CODE_MIRROR_WRITE_FAILED_RELEASED'
        : 'TRANSPORT_CODE_MIRROR_WRITE_AND_RELEASE_FAILED',
      allConfirmed
        ? 'T-CODE NUK U RUAJT NË PAJISJE DHE U LIRUA.'
        : 'T-CODE NUK U RUAJT NË PAJISJE DHE LIRIMI NUK U VERIFIKUA.',
    );
  }
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
  const fresh = await refreshMirrorFromDb(pin, poolSize);
  return fresh.length ? fresh : loadMirror(pin);
}

export function peekPoolCount(reservedBy) {
  const pin = getOwnerPin(reservedBy);
  return pin ? loadMirror(pin).length : 0;
}

function holdReservationForRetry(owner, oid, code) {
  const c = normalizeT(code);
  if (!c || c === 'T0' || !isBrowser()) return false;
  if (oid) {
    try {
      localStorage.setItem(orderCodeKey(oid), c);
      return true;
    } catch {
      return false;
    }
  }
  return saveMirror(owner, [c, ...loadMirror(owner)]);
}

async function popVerifiedOnlineCode(pin, oid = '') {
  const owner = getOwnerPin(pin);
  if (!owner) return null;
  let code = popMirror(owner);
  if (!code) {
    const reserved = await reserveViaRpc(owner, 1);
    code = reserved[0] || '';
    if (reserved.length > 1) saveMirror(owner, reserved.slice(1));
  }
  if (!code) return null;

  // Bind the exact server-returned code before the follow-up reads. A reload or
  // transient verification failure can then retry the same order/code pair.
  const boundForRetry = holdReservationForRetry(owner, oid, code);
  if (!boundForRetry) {
    const cleanup = await releaseTransportCodeIfUnusedDetailed(code, owner);
    throw allocatorError(
      cleanup.confirmed
        ? 'TRANSPORT_CODE_LOCAL_BIND_FAILED_RELEASED'
        : 'TRANSPORT_CODE_LOCAL_BIND_AND_RELEASE_FAILED',
      cleanup.confirmed
        ? 'T-CODE NUK U RUAJT NË PAJISJE DHE U LIRUA. HAPE PRAP FORMËN.'
        : 'T-CODE NUK U RUAJT NË PAJISJE DHE LIRIMI NUK U VERIFIKUA. MOS E DËRGO PËRSËRI.',
    );
  }

  const [knownUsed, owned] = await Promise.all([
    isTransportCodeKnownUsed(code),
    cachedReservationBelongsToOwner(code, owner),
  ]);
  if (!knownUsed && owned) return code;

  // Never drop a rejected server reservation. Release it with the guarded RPC;
  // when the release request itself cannot reach DB, keep it bound for retry.
  const cleanup = await releaseTransportCodeIfUnusedDetailed(code, owner);
  if (!cleanup.confirmed) {
    if (!holdReservationForRetry(owner, oid, code)) {
      throw allocatorError(
        'TRANSPORT_CODE_VERIFY_RELEASE_AND_LOCAL_BIND_FAILED',
        'T-CODE NUK U VERIFIKUA DHE NUK U RUAJT PËR RETRY. MOS E DËRGO PËRSËRI.',
      );
    }
    throw allocatorError(
      'TRANSPORT_CODE_VERIFY_FAILED_RETRY_SAME_ORDER',
      'T-CODE U REZERVUA, POR VERIFIKIMI DËSHTOI. KODI U RUAJT PËR KËTË POROSI; PROVO PRAP.',
    );
  }
  throw allocatorError(
    'TRANSPORT_CODE_VERIFY_FAILED_RELEASED',
    'T-CODE U REZERVUA, POR VERIFIKIMI DËSHTOI. KODI U LIRUA; PROVO PRAP ONLINE.',
  );
}

async function getOrReserveTransportCodeOnce(pin, oid) {
  if (oid && isBrowser()) {
    let cached = '';
    try { cached = localStorage.getItem(orderCodeKey(oid)) || ''; } catch {}
    if (cached && String(cached).trim()) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return normalizeT(cached);
      const used = await isTransportCodeKnownUsed(cached);
      const owned = !used && await cachedReservationBelongsToOwner(cached, pin);
      if (owned) return normalizeT(cached);
      const cleanup = await releaseTransportCodeIfUnusedDetailed(cached, pin);
      if (!cleanup.confirmed) {
        throw allocatorError(
          'TRANSPORT_CODE_CACHED_VERIFY_FAILED_RETRY_SAME_ORDER',
          'T-CODE I KËSAJ POROSIE NUK U VERIFIKUA. PROVO PRAP ME TË NJEJTËN POROSI.',
        );
      }
    }
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

  const code = await popVerifiedOnlineCode(pin, oid);
  if (!code) throw new Error("S'KA T-KOD TË LIRË. POOL-I KA KODE TË PËRDORURA OSE NUK U VERIFIKUA. PROVO PRAP ONLINE.");
  if (oid && isBrowser()) {
    try { localStorage.setItem(orderCodeKey(oid), String(code)); } catch {}
  }
  return String(code);
}

export async function getOrReserveTransportCode(reservedBy, opts = {}) {
  const pin = getOwnerPin(reservedBy);
  const oid = opts?.oid ? String(opts.oid).trim() : '';
  if (!pin) throw new Error('MISSING_TRANSPORT_PIN');

  if (!oid) return getOrReserveTransportCodeOnce(pin, '');
  const inFlightKey = `${pin}::${oid}`;
  const existing = inFlightReservationsByOrder.get(inFlightKey);
  if (existing) return existing;

  const reservation = getOrReserveTransportCodeOnce(pin, oid);
  inFlightReservationsByOrder.set(inFlightKey, reservation);
  try {
    return await reservation;
  } finally {
    if (inFlightReservationsByOrder.get(inFlightKey) === reservation) {
      inFlightReservationsByOrder.delete(inFlightKey);
    }
  }
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

function purgeTransportCodeFromBrowserCaches(code) {
  const c = normalizeT(code);
  if (!c || c === 'T0' || !isBrowser()) return;
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
        if (next.length !== cached.length) {
          localStorage.setItem(key, JSON.stringify(next));
        }
      }
    }
  } catch {}
}

async function releaseTransportCodeIfUnusedDetailed(code, ownerId = '') {
  const c = normalizeT(code);
  if (!c || c === 'T0') return { released: false, confirmed: true };
  try {
    const { data, error } = await supabase.rpc('release_transport_code_if_unused', {
      p_code: c,
      p_owner_id: String(ownerId || '').trim() || null,
    });
    if (error) throw error;
    const released = data === true || data?.released === true || data?.ok === true;
    // A server response, including a guarded "false", settles this reservation.
    // A network error keeps local binding intact so a retry cannot burn a new code.
    purgeTransportCodeFromBrowserCaches(c);
    return { released, confirmed: true };
  } catch (error) {
    return { released: false, confirmed: false, error };
  }
}

export async function releaseTransportCodeIfUnused(code, ownerId = '') {
  const result = await releaseTransportCodeIfUnusedDetailed(code, ownerId);
  return result.released;
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
