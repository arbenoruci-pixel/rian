// lib/pranimiCodeAllocator.js
// Single official PRANIMI code lifecycle service.
// One PIN + one draft/session + one DB assignment + one final consume/release.

export const PRANIMI_ALLOCATOR_VERSION = 'oneway-v39.1-pro';
export const PRANIMI_OFFLINE_PROOF_MAX_AGE_MS = 3 * 60 * 60 * 1000;

const ORDER_CODE_LS_PREFIX = 'base_order_code:';
const ORDER_PROOF_LS_PREFIX = 'pranimi_code_assignment_proof_v39_1:';

export function normalizePinForAllocator(value) {
  const pin = String(value == null ? '' : value).trim();
  return /^\d{3,12}$/.test(pin) ? pin : '';
}

export function normalizeCodeForAllocator(value) {
  if (value && typeof value === 'object') {
    return normalizeCodeForAllocator(value.code ?? value.codeRaw ?? value.value ?? null);
  }
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeProof(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const pin = normalizePinForAllocator(value.pin ?? value.reserved_by);
  const oid = String(value.oid ?? value.draft_session_id ?? '').trim();
  const code = normalizeCodeForAllocator(value.code);
  const verifiedAt = normalizeIso(value.verified_at ?? value.verifiedAt);
  const leaseExpiresAt = normalizeIso(value.lease_expires_at ?? value.leaseExpiresAt);
  if (!pin || !oid || code == null || !verifiedAt || !leaseExpiresAt) return null;
  return {
    version: PRANIMI_ALLOCATOR_VERSION,
    pin,
    oid,
    code,
    status: String(value.status || 'reserved').trim().toLowerCase(),
    verified_at: verifiedAt,
    lease_expires_at: leaseExpiresAt,
    source: String(value.source || 'DB_VERIFIED'),
  };
}

function proofMatches(value, { pin, oid, code, now = Date.now() } = {}) {
  const proof = normalizeProof(value);
  if (!proof) return { ok: false, reason: 'NO_VERIFIED_ASSIGNMENT_PROOF' };
  if (proof.pin !== normalizePinForAllocator(pin)) return { ok: false, reason: 'PROOF_PIN_MISMATCH', proof };
  if (proof.oid !== String(oid || '').trim()) return { ok: false, reason: 'PROOF_DRAFT_MISMATCH', proof };
  if (proof.code !== normalizeCodeForAllocator(code)) return { ok: false, reason: 'PROOF_CODE_MISMATCH', proof };
  if (proof.status !== 'reserved') return { ok: false, reason: 'PROOF_STATUS_NOT_RESERVED', proof };
  const verifiedAt = Date.parse(proof.verified_at);
  const leaseExpiresAt = Date.parse(proof.lease_expires_at);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now) return { ok: false, reason: 'PROOF_LEASE_EXPIRED', proof };
  if (!Number.isFinite(verifiedAt) || verifiedAt + PRANIMI_OFFLINE_PROOF_MAX_AGE_MS <= now) return { ok: false, reason: 'PROOF_TOO_OLD', proof };
  return { ok: true, reason: 'OFFLINE_VERIFIED_ASSIGNMENT_PROOF', proof };
}

function normalizeAssignment(value, fallback = {}) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const code = normalizeCodeForAllocator(row.code ?? row.value);
  if (code == null) return null;
  return {
    code,
    status: String(row.status || fallback.status || 'reserved').trim().toLowerCase(),
    reserved_by: normalizePinForAllocator(row.reserved_by ?? row.pin ?? fallback.pin),
    draft_session_id: String(row.draft_session_id ?? row.oid ?? fallback.oid ?? '').trim(),
    lease_expires_at: normalizeIso(row.lease_expires_at ?? row.leaseExpiresAt ?? fallback.lease_expires_at),
    verified: row.verified !== false,
    reason: row.reason || null,
    source: row.source || fallback.source || 'DB_ASSIGNMENT',
  };
}

export function createPranimiCodeAllocatorCore(deps = {}) {
  const storage = deps.storage || {};
  const db = deps.db || {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const inflight = new Map();

  function makeError(message, code, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
  }
  function requirePin(value) {
    const pin = normalizePinForAllocator(value);
    if (!pin) throw makeError('PIN-I REAL I PUNËTORIT MUNGON', 'MISSING_REAL_ACTOR_PIN');
    return pin;
  }
  function requireOid(value) {
    const oid = String(value || '').trim();
    if (!oid) throw makeError('DRAFT-I AKTIV MUNGON', 'MISSING_ACTIVE_DRAFT');
    return oid;
  }
  function assignedCodeForDraft(oidInput) {
    const oid = String(oidInput || '').trim();
    return oid ? normalizeCodeForAllocator(storage.getAssigned?.(oid)) : null;
  }
  function clearLocal(oid) {
    storage.clearAssigned?.(oid);
    storage.clearProof?.(oid);
  }
  function writeProof({ pin, oid, code, verdict = {}, source }) {
    const proof = normalizeProof({
      pin,
      oid,
      code,
      status: verdict.status || 'reserved',
      verified_at: new Date().toISOString(),
      lease_expires_at: verdict.lease_expires_at,
      source: verdict.source || source || 'DB_VERIFIED',
    });
    if (!proof) throw makeError('DB NUK KTHEU PROVË TË PLOTË TË REZERVIMIT', 'ASSIGNMENT_PROOF_INCOMPLETE', { verdict });
    storage.setProof?.(oid, proof);
    return proof;
  }
  async function onlineNow() { return db.isOnline ? !!(await db.isOnline()) : true; }
  function terminalError(verdict = {}, fallbackCode = null) {
    return makeError('KY DRAFT ËSHTË FINALIZUAR TASHMË', 'DRAFT_ALREADY_FINALIZED', {
      terminal: true,
      assignedCode: normalizeCodeForAllocator(verdict.code ?? fallbackCode),
      orderId: String(verdict.order_id ?? verdict.orderId ?? '').trim() || null,
      verdict,
    });
  }

  async function verifyAssignedCode({ pin, oid, code, meaningful = false } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const candidate = normalizeCodeForAllocator(code) ?? assigned;
    if (candidate == null) return { displayable: false, verified: false, reason: 'NO_ASSIGNED_CODE', code: null };
    if (assigned != null && assigned !== candidate) {
      return { displayable: false, verified: false, reason: 'CODE_NOT_EQUAL_TO_DRAFT_ASSIGNMENT', code: candidate, assignedCode: assigned };
    }
    if (!(await onlineNow())) {
      const offline = proofMatches(storage.getProof?.(id), { pin: realPin, oid: id, code: candidate });
      return offline.ok
        ? { displayable: true, verified: true, offline: true, reason: offline.reason, code: candidate, proof: offline.proof }
        : { displayable: false, verified: false, offline: true, reason: offline.reason, code: candidate };
    }
    if (!db.verifyDisplayable) throw makeError('DB VERIFIER MUNGON', 'PRANIMI_ASSIGNMENT_VERIFIER_REQUIRED');
    const verdict = await db.verifyDisplayable({ code: candidate, pin: realPin, oid: id, meaningful });
    if (verdict?.terminal === true || verdict?.reason === 'DRAFT_ALREADY_FINALIZED') {
      return { ...verdict, displayable: false, verified: true, terminal: true, reason: 'DRAFT_ALREADY_FINALIZED', code: candidate };
    }
    if (!verdict || verdict.displayable !== true || verdict.verified === false) {
      clearLocal(id); // only completed DB rejection reaches here; thrown ambiguity retains binding
      return { displayable: false, verified: false, reason: verdict?.reason || 'DB_ASSIGNMENT_REJECTED', code: candidate };
    }
    const assignment = normalizeAssignment(verdict, { pin: realPin, oid: id, status: 'reserved' });
    if (!assignment || assignment.code !== candidate || assignment.reserved_by !== realPin || assignment.draft_session_id !== id || assignment.status !== 'reserved' || !assignment.lease_expires_at) {
      clearLocal(id);
      return { displayable: false, verified: false, reason: 'DB_ASSIGNMENT_IDENTITY_MISMATCH', code: candidate, assignment };
    }
    storage.setAssigned?.(id, candidate);
    const proof = writeProof({ pin: realPin, oid: id, code: candidate, verdict: assignment, source: 'DB_VERIFY' });
    return { displayable: true, verified: true, reason: verdict.reason || 'DB_VERIFIED', code: candidate, assignment, proof };
  }

  async function getOrAllocateInternal({ pin, oid, meaningful = false } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const existing = assignedCodeForDraft(id);
    if (existing != null) {
      const verdict = await verifyAssignedCode({ pin: realPin, oid: id, code: existing, meaningful });
      if (verdict.displayable) return { code: existing, reused: true, source: verdict.offline ? 'OFFLINE_VERIFIED_ASSIGNMENT' : 'DB_VERIFIED_ASSIGNMENT', verdict };
      if (verdict.terminal) throw terminalError(verdict, existing);
    }
    if (!(await onlineNow())) throw makeError("S'KA KOD TË VERIFIKUAR PËR KËTË DRAFT. LIDHU ONLINE.", 'BASE_CODE_OFFLINE_EMPTY');
    if (!db.reserveOne) throw makeError('RPC ZYRTAR I ALLOKIMIT MUNGON', 'PRANIMI_ALLOCATOR_RPC_REQUIRED');
    const assignment = normalizeAssignment(await db.reserveOne({ pin: realPin, oid: id, meaningful }), { pin: realPin, oid: id, status: 'reserved' });
    if (!assignment) throw makeError("S'KA KOD TË LIRË NË DB", 'BASE_CODE_POOL_EMPTY');
    if (assignment.status !== 'reserved' || assignment.reserved_by !== realPin || assignment.draft_session_id !== id || !assignment.lease_expires_at || assignment.verified === false) {
      throw makeError('DB KTHEU REZERVIM TË PAVLEFSHËM', 'DB_ASSIGNMENT_IDENTITY_MISMATCH', { assignment });
    }
    storage.setAssigned?.(id, assignment.code);
    const proof = writeProof({ pin: realPin, oid: id, code: assignment.code, verdict: assignment, source: 'GET_OR_ASSIGN' });
    log('allocator:reserved_one', { pin: realPin, oid: id, code: assignment.code });
    return { code: assignment.code, reused: false, source: 'GET_OR_ASSIGN', assignment, proof };
  }

  async function getOrAllocateForDraft(args = {}) {
    const pin = requirePin(args.pin);
    const oid = requireOid(args.oid);
    const key = `${pin}:${oid}`;
    if (inflight.has(key)) return inflight.get(key);
    const promise = getOrAllocateInternal({ ...args, pin, oid }).finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  }

  async function adoptAndVerifyForDraft({ pin, oid, code, meaningful = false } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const candidate = normalizeCodeForAllocator(code);
    if (candidate == null) return getOrAllocateForDraft({ pin: realPin, oid: id, meaningful });
    const current = assignedCodeForDraft(id);
    if (current != null && current !== candidate) {
      const currentVerdict = await verifyAssignedCode({ pin: realPin, oid: id, code: current, meaningful });
      if (currentVerdict.displayable) return { code: current, reused: true, source: 'EXISTING_ASSIGNMENT_WINS', verdict: currentVerdict };
      if (currentVerdict.terminal) throw terminalError(currentVerdict, current);
    }
    storage.setAssigned?.(id, candidate);
    const verdict = await verifyAssignedCode({ pin: realPin, oid: id, code: candidate, meaningful });
    if (verdict.displayable) return { code: candidate, reused: true, source: verdict.offline ? 'RESTORED_OFFLINE_PROOF' : 'RESTORED_DB_VERIFIED', verdict };
    if (verdict.terminal) throw terminalError(verdict, candidate);
    return getOrAllocateForDraft({ pin: realPin, oid: id, meaningful });
  }

  async function renewForDraft({ pin, oid, code, meaningful = false } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const candidate = normalizeCodeForAllocator(code) ?? assigned;
    if (candidate == null || assigned == null || candidate !== assigned) return { ok: false, reason: 'RENEW_CODE_NOT_ASSIGNED' };
    if (!(await onlineNow())) {
      const proof = proofMatches(storage.getProof?.(id), { pin: realPin, oid: id, code: candidate });
      return { ok: proof.ok, offline: true, reason: proof.reason, code: candidate };
    }
    const verdict = await db.renew?.({ code: candidate, pin: realPin, oid: id, meaningful });
    if (!verdict || verdict.ok !== true) return { ok: false, reason: verdict?.reason || 'RENEW_REFUSED', code: candidate };
    const assignment = normalizeAssignment(verdict, { pin: realPin, oid: id, status: 'reserved' });
    if (!assignment || assignment.code !== candidate || assignment.reserved_by !== realPin || assignment.draft_session_id !== id || !assignment.lease_expires_at) return { ok: false, reason: 'RENEW_IDENTITY_MISMATCH' };
    const proof = writeProof({ pin: realPin, oid: id, code: candidate, verdict: assignment, source: 'DB_RENEW' });
    return { ok: true, code: candidate, assignment, proof };
  }

  async function consumeForDraft({ pin, oid, code, orderId, clientPhone = '' } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const candidate = normalizeCodeForAllocator(code) ?? assigned;
    if (assigned == null) throw makeError('DRAFT-I NUK KA KOD TË CAKTUAR', 'CONSUME_NO_ASSIGNED_CODE');
    if (candidate == null || candidate !== assigned) throw makeError('KODI FINAL NUK ËSHTË KODI I DRAFTIT', 'CONSUME_CODE_MISMATCH', { assignedCode: assigned, requestedCode: candidate });
    const exactOrderId = String(orderId || '').trim();
    if (!exactOrderId) throw makeError('ORDER ID FINAL MUNGON', 'CONSUME_ORDER_ID_REQUIRED');
    if (!(await onlineNow())) return { ok: false, code: candidate, retainBinding: true, reason: 'CONSUME_OFFLINE' };
    const result = await db.markUsed?.({ code: candidate, pin: realPin, oid: id, orderId: exactOrderId, clientPhone });
    if (!(result === true || result?.ok === true)) return { ok: false, code: candidate, retainBinding: true, reason: result?.reason || 'CONSUME_NOT_CONFIRMED', result };
    return { ok: true, code: candidate, orderId: exactOrderId, result, awaitingAcknowledgement: true };
  }

  async function releaseForDraft({ pin, oid, code, reason = 'release_draft' } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const candidate = normalizeCodeForAllocator(code) ?? assigned;
    if (candidate == null || assigned == null) return { ok: true, skipped: true, reason: 'NO_ASSIGNED_CODE' };
    if (candidate !== assigned) return { ok: false, reason: 'RELEASE_CODE_MISMATCH', assignedCode: assigned, requestedCode: candidate };
    if (!(await onlineNow())) return { ok: false, offline: true, reason: 'RELEASE_OFFLINE', retainBinding: true };
    const result = await db.release?.({ code: candidate, pin: realPin, oid: id, reason });
    if (!(result === true || result?.ok === true)) return { ok: false, reason: result?.reason || 'RELEASE_NOT_CONFIRMED', retainBinding: true };
    clearLocal(id);
    return { ok: true, code: candidate, result };
  }

  async function verifyExistingClientCode({ clientId, code, phone = '', name = '' } = {}) {
    const id = String(clientId || '').trim();
    const candidate = normalizeCodeForAllocator(code);
    if (!id || candidate == null) return { ok: false, reason: 'EXISTING_CLIENT_ID_OR_CODE_MISSING' };
    if (!(await onlineNow())) return { ok: false, offline: true, reason: 'EXISTING_CLIENT_VERIFY_REQUIRES_ONLINE' };
    const result = await db.verifyExistingClient?.({ clientId: id, code: candidate, phone, name });
    return result?.ok === true ? { ...result, ok: true, code: candidate, clientId: id } : { ...result, ok: false, reason: result?.reason || 'EXISTING_CLIENT_VERIFY_REFUSED' };
  }

  async function finalizeExistingClientDraft({ pin, oid, finalCode, orderId } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const historical = normalizeCodeForAllocator(finalCode);
    if (assigned == null) return { ok: true, skipped: true, reason: 'NO_TEMP_ASSIGNMENT' };
    const exactOrderId = String(orderId || '').trim();
    if (!exactOrderId) throw makeError('ORDER ID FINAL MUNGON', 'EXISTING_CLIENT_ORDER_ID_REQUIRED');
    if (historical != null && historical === assigned) return consumeForDraft({ pin: realPin, oid: id, code: assigned, orderId: exactOrderId });
    if (!(await onlineNow())) return { ok: false, reason: 'EXISTING_CLIENT_RELEASE_OFFLINE', retainBinding: true, tempCode: assigned };
    const result = await db.releaseAfterExistingClient?.({ tempCode: assigned, finalCode: historical, pin: realPin, oid: id, orderId: exactOrderId });
    if (!(result === true || result?.ok === true)) return { ok: false, reason: result?.reason || 'EXISTING_CLIENT_TEMP_RELEASE_NOT_CONFIRMED', retainBinding: true, tempCode: assigned };
    return { ok: true, tempCode: assigned, finalCode: historical, orderId: exactOrderId, result, awaitingAcknowledgement: true };
  }

  function acknowledgeFinalizedDraft({ pin, oid, code, orderId = '' } = {}) {
    const realPin = requirePin(pin);
    const id = requireOid(oid);
    const assigned = assignedCodeForDraft(id);
    const candidate = normalizeCodeForAllocator(code);
    if (assigned == null) return { ok: true, skipped: true, reason: 'ASSIGNMENT_ALREADY_CLEARED' };
    if (candidate == null || candidate !== assigned) return { ok: false, reason: 'ACK_CODE_MISMATCH', assignedCode: assigned, requestedCode: candidate };
    const proof = normalizeProof(storage.getProof?.(id));
    if (proof && (proof.pin !== realPin || proof.oid !== id || proof.code !== assigned)) return { ok: false, reason: 'ACK_PROOF_IDENTITY_MISMATCH' };
    clearLocal(id);
    log('allocator:finalized_acknowledged', { pin: realPin, oid: id, code: candidate, orderId: String(orderId || '').trim() || null });
    return { ok: true, code: candidate };
  }

  return { version: PRANIMI_ALLOCATOR_VERSION, assignedCodeForDraft, verifyAssignedCode, getOrAllocateForDraft, adoptAndVerifyForDraft, renewForDraft, consumeForDraft, releaseForDraft, verifyExistingClientCode, finalizeExistingClientDraft, acknowledgeFinalizedDraft };
}

function browserStorage() {
  const ls = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
  return {
    getAssigned: (oid) => { try { return ls ? normalizeCodeForAllocator(ls.getItem(`${ORDER_CODE_LS_PREFIX}${oid}`)) : null; } catch { return null; } },
    setAssigned: (oid, code) => { try { ls?.setItem(`${ORDER_CODE_LS_PREFIX}${oid}`, String(normalizeCodeForAllocator(code) || '')); } catch {} },
    clearAssigned: (oid) => { try { ls?.removeItem(`${ORDER_CODE_LS_PREFIX}${oid}`); } catch {} },
    getProof: (oid) => { try { const raw = ls?.getItem(`${ORDER_PROOF_LS_PREFIX}${oid}`); return raw ? JSON.parse(raw) : null; } catch { return null; } },
    setProof: (oid, proof) => { try { ls?.setItem(`${ORDER_PROOF_LS_PREFIX}${oid}`, JSON.stringify(proof)); } catch {} },
    clearProof: (oid) => { try { ls?.removeItem(`${ORDER_PROOF_LS_PREFIX}${oid}`); } catch {} },
  };
}

let browserAllocator = null;
export function getPranimiCodeAllocator() {
  if (browserAllocator) return browserAllocator;
  browserAllocator = createPranimiCodeAllocatorCore({
    storage: browserStorage(),
    db: {
      async isOnline() { try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch { return true; } },
      async reserveOne({ pin, oid }) { const m = await import('./baseCodes.js'); return m.getOrAssignPranimiCodeInDb(oid, pin); },
      async verifyDisplayable({ code, pin, oid, meaningful }) { const m = await import('./baseCodes.js'); return m.verifyPranimiCodeAssignmentInDb(code, { oid, pinOverride: pin, meaningful }); },
      async renew({ code, pin, oid, meaningful }) { const m = await import('./baseCodes.js'); return m.renewPranimiCodeAssignmentInDb(code, oid, { pinOverride: pin, meaningful }); },
      async markUsed({ code, pin, oid, orderId, clientPhone }) { const m = await import('./baseCodes.js'); return m.consumePranimiCodeAssignmentInDb(code, oid, { pinOverride: pin, orderId, clientPhone }); },
      async release({ code, pin, oid, reason }) { const m = await import('./baseCodes.js'); return m.releasePranimiCodeAssignmentInDb(code, oid, { pinOverride: pin, reason }); },
      async releaseAfterExistingClient(args) { const m = await import('./baseCodes.js'); return m.releasePranimiTempCodeAfterExistingClientSaveInDb(args); },
      async verifyExistingClient(args) { const m = await import('./baseCodes.js'); return m.verifyExistingClientCodeForSave(args); },
    },
    log(event, details) { try { window?.__tepihaPranimiDiag?.(event, details); } catch {} },
  });
  return browserAllocator;
}

export default getPranimiCodeAllocator;
