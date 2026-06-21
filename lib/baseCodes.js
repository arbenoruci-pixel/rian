// lib/baseCodes.js
// Strict DB primitives used only by lib/pranimiCodeAllocator.js.
// Allocation mutation: get_or_assign_pranimi_code(PIN, draft_session_id, lease).
// No local pool, batch reserve, max(code)+1, or component-facing fallback.

import { supabase } from '@/lib/supabaseClient';
import { getActorPinStrict } from '@/lib/actorSession';

const RPC_TIMEOUT_MS = 7000;
const BLANK_DRAFT_LEASE_MINUTES = 30;
const MEANINGFUL_DRAFT_LEASE_MINUTES = 60 * 24 * 7;
const LS_ORDER_CODE_PREFIX = 'base_order_code:';
const LS_USED_QUEUE_PREFIX = 'base_code_used_queue:';
const LS_POOL_PREFIX = 'base_code_pool:';
const LS_EPOCH_KEYS = Object.freeze(['base_code_epoch_v1', 'tepiha_base_epoch_v1']);
const LEGACY_RPC_SIGNATURE_KEYS = Object.freeze(['base_code_reserve_rpc_signature_v5','base_code_reserve_rpc_signature_v4','base_code_reserve_rpc_signature_v3','base_code_reserve_rpc_signature_v2','base_code_reserve_rpc_signature_v1']);
const QUARANTINE_PREFIX = 'base_code_legacy_quarantine_v39_1:';
const EPOCH_TTL_MS = 30_000;
let epochCache = { value: 0, checkedAt: 0 };
let epochInflight = null;
let lastFailure = null;

function browser() { return typeof window !== 'undefined' && !!window.localStorage; }
function strictPin(value) { const raw = String(value == null ? '' : value).trim(); return /^\d{3,12}$/.test(raw) ? raw : ''; }
function currentPin(override = null) {
  const rawOverride = String(override == null ? '' : override).trim();
  if (rawOverride) return strictPin(rawOverride);
  return strictPin(getActorPinStrict());
}
function online() { try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch { return true; } }
function withTimeout(promise, ms = RPC_TIMEOUT_MS, label = 'PRANIMI_RPC_TIMEOUT') {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(label); e.code = label; reject(e); }, ms); });
  return Promise.race([promise, timeout]).finally(() => { try { clearTimeout(timer); } catch {} });
}
function ambiguous(code, cause = null) { const e = new Error(code); e.code = code; e.cause = cause; return e; }
function deterministicRpcFailure(error) {
  const text = `${String(error?.message || '')} ${String(error?.details || '')} ${String(error?.hint || '')}`.toUpperCase();
  const tokens = ['PIN_ACTIVE_DRAFT_EXISTS','PIN_NOT_FOUND_OR_DISABLED','DRAFT_SESSION_REQUIRED','NO_BASE_CODES_AVAILABLE'];
  const token = tokens.find((value) => text.includes(value));
  if (!token) return null;
  const e = new Error(token);
  e.code = token;
  e.dbCode = error?.code || null;
  e.details = error?.details || null;
  e.cause = error;
  return e;
}
function readJson(key, fallback) { try { const raw = browser() ? window.localStorage.getItem(key) : null; return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function writeJson(key, value) { try { if (browser()) window.localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function removeLocal(key) { try { if (browser()) window.localStorage.removeItem(key); } catch {} }
function orderCodeKey(oid) { return `${LS_ORDER_CODE_PREFIX}${String(oid || '').trim()}`; }
function clearOrderCodeCache(oid) { const id = String(oid || '').trim(); if (id) removeLocal(orderCodeKey(id)); }

export function normalizeCode(value) {
  if (value && typeof value === 'object') return normalizeCode(value.code ?? value.code_n ?? value.base_code ?? value.value ?? null);
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function computeM2FromRows(rows = []) {
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) { const n = Number(row?.m2 ?? row?.m ?? row?.area ?? 0); if (Number.isFinite(n)) total += n; }
  return Math.round(total * 100) / 100;
}
export function getActorPin() { return currentPin() || null; }

function readStoredEpochs() {
  if (!browser()) return [];
  const out = [];
  for (const key of LS_EPOCH_KEYS) { const n = Number(window.localStorage.getItem(key) || 0); if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n); }
  return out;
}
function writeEpoch(epoch) { if (!browser()) return; const n = Number(epoch || 0); if (!Number.isFinite(n) || n <= 0) return; for (const key of LS_EPOCH_KEYS) { try { window.localStorage.setItem(key, String(n)); } catch {} } }
function quarantine(pin, key, value, reason) {
  if (!browser()) return;
  const qKey = `${QUARANTINE_PREFIX}${pin}`;
  const rows = readJson(qKey, []);
  writeJson(qKey, [...(Array.isArray(rows) ? rows : []), { sourceKey: key, value, reason, quarantinedAt: new Date().toISOString() }].slice(-500));
}
function quarantineLegacyLocalQueues(pin, reason = 'ONE_WAY_ALLOCATOR_NO_LOCAL_POOL') {
  if (!browser() || !pin) return { quarantined: 0 };
  let quarantined = 0;
  for (const key of [`${LS_POOL_PREFIX}${pin}`, `${LS_USED_QUEUE_PREFIX}${pin}`]) { const raw = window.localStorage.getItem(key); if (raw != null) { quarantine(pin, key, raw, reason); removeLocal(key); quarantined += 1; } }
  for (const key of LEGACY_RPC_SIGNATURE_KEYS) removeLocal(key);
  return { quarantined };
}
function clearAssignmentsForEpochChange(pin) {
  if (!browser()) return;
  quarantineLegacyLocalQueues(pin, 'DB_EPOCH_CHANGED');
  const keys = [];
  for (let i = 0; i < window.localStorage.length; i += 1) { const key = window.localStorage.key(i); if (key?.startsWith(LS_ORDER_CODE_PREFIX) || key?.startsWith('pranimi_code_assignment_proof_v39_1:')) keys.push(key); }
  keys.forEach(removeLocal);
}
async function fetchRemoteEpoch({ force = false } = {}) {
  const now = Date.now();
  if (!force && epochCache.value > 0 && now - epochCache.checkedAt < EPOCH_TTL_MS) return epochCache.value;
  if (epochInflight) return epochInflight;
  const promise = (async () => {
    try {
      const { data, error } = await withTimeout(supabase.from('app_meta').select('db_epoch').eq('key', 'global').maybeSingle(), 2500, 'BASE_EPOCH_TIMEOUT');
      if (error) throw error;
      const value = Number(data?.db_epoch || 0);
      if (Number.isFinite(value) && value > 0) epochCache = { value, checkedAt: Date.now() };
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch { return 0; }
  })().finally(() => { if (epochInflight === promise) epochInflight = null; });
  epochInflight = promise;
  return promise;
}
export async function ensureBaseCodeEpochFresh(pinArg, opts = {}) {
  const pin = currentPin(pinArg);
  if (!pin) return { ok: false, changed: false, reason: 'NO_REAL_PIN' };
  if (!browser()) return { ok: true, changed: false, reason: 'SERVER_NO_LOCAL_STATE' };
  const remoteEpoch = await fetchRemoteEpoch({ force: opts?.force === true });
  if (!remoteEpoch) return { ok: false, changed: false, reason: 'EPOCH_UNAVAILABLE', localEpochs: readStoredEpochs(), remoteEpoch: 0 };
  const localEpochs = readStoredEpochs();
  const hasLegacyState = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).some((key) => key?.startsWith(LS_ORDER_CODE_PREFIX) || key?.startsWith(LS_POOL_PREFIX) || key?.startsWith(LS_USED_QUEUE_PREFIX));
  const changed = (localEpochs.length > 0 && !localEpochs.includes(remoteEpoch)) || (localEpochs.length === 0 && hasLegacyState);
  if (changed) clearAssignmentsForEpochChange(pin);
  writeEpoch(remoteEpoch);
  return { ok: true, changed, localEpochs, remoteEpoch };
}
export function resetBaseCodeReservationCompatibilityCache() { if (browser()) LEGACY_RPC_SIGNATURE_KEYS.forEach(removeLocal); }
export function getLastBaseCodeReserveFailure() { return lastFailure; }
export async function flushBaseUsedQueue(pinArg) { const pin = currentPin(pinArg); if (!pin) return { ok: false, reason: 'NO_REAL_PIN' }; return { ok: true, ...quarantineLegacyLocalQueues(pin, 'ONE_WAY_ALLOCATOR_REQUIRES_EXACT_ORDER_PIN_DRAFT') }; }
export async function warmBasePool({ pin } = {}) { const cleanPin = currentPin(pin); if (!cleanPin) return { ok: false, reason: 'NO_REAL_PIN', reserved: 0 }; await ensureBaseCodeEpochFresh(cleanPin).catch(() => null); const cleaned = await flushBaseUsedQueue(cleanPin); return { ok: true, warmedOnly: true, reserved: 0, have: 0, ...cleaned }; }
export async function refillBasePoolIfNeeded(pinArg) { return warmBasePool({ pin: pinArg }); }
export async function ensureBasePool(pinArg) { return warmBasePool({ pin: pinArg }); }
export async function syncBasePool(pinArg) { return warmBasePool({ pin: pinArg }); }
export function getBaseCodeReservationDiagnostics(pinArg = null) { const pin = currentPin(pinArg); return pin ? { ok: !lastFailure, pin, poolSize: 0, localAllocator: 'DISABLED', officialRpc: 'get_or_assign_pranimi_code', failure: lastFailure } : { ok: false, reason: 'NO_REAL_PIN', pin: null, poolSize: 0 }; }

export async function getOrAssignPranimiCodeInDb(oid, pinOverride = null) {
  const pin = currentPin(pinOverride);
  const draftSessionId = String(oid || '').trim();
  if (!pin) throw ambiguous('MISSING_REAL_ACTOR_PIN');
  if (!draftSessionId) throw ambiguous('MISSING_ACTIVE_DRAFT');
  if (!online()) throw ambiguous('BASE_CODE_OFFLINE_EMPTY');
  let response;
  try { response = await withTimeout(supabase.rpc('get_or_assign_pranimi_code', { p_pin: pin, p_draft_session_id: draftSessionId, p_lease_minutes: BLANK_DRAFT_LEASE_MINUTES }), RPC_TIMEOUT_MS, 'GET_OR_ASSIGN_RPC_TIMEOUT'); }
  catch (cause) { const deterministic = deterministicRpcFailure(cause); lastFailure = { at: new Date().toISOString(), pin, draftSessionId, reason: deterministic?.code || 'PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS' }; if (deterministic) throw deterministic; throw ambiguous('PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS', cause); }
  const { data, error } = response || {};
  if (error) { const deterministic = deterministicRpcFailure(error); lastFailure = { at: new Date().toISOString(), pin, draftSessionId, reason: deterministic?.code || error?.code || error?.message || 'RPC_ERROR' }; if (deterministic) throw deterministic; throw ambiguous('PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS', error); }
  const row = Array.isArray(data) ? data[0] : data;
  const code = normalizeCode(row?.code ?? row);
  const status = String(row?.status || '').trim().toLowerCase();
  const reservedBy = strictPin(row?.reserved_by ?? row?.pin);
  const returnedDraft = String(row?.draft_session_id || '').trim();
  const leaseExpiresAt = String(row?.lease_expires_at || '').trim();
  if (code == null || status !== 'reserved' || reservedBy !== pin || returnedDraft !== draftSessionId || !leaseExpiresAt || row?.verified === false) { const e = ambiguous('DB_ASSIGNMENT_IDENTITY_MISMATCH'); e.assignment = row || null; throw e; }
  try { if (browser()) window.localStorage.setItem(orderCodeKey(draftSessionId), String(code)); } catch {}
  lastFailure = null;
  return { code, status, reserved_by: reservedBy, draft_session_id: returnedDraft, lease_expires_at: leaseExpiresAt, verified: true, source: 'get_or_assign_pranimi_code' };
}

export async function verifyPranimiCodeAssignmentInDb(codeNum, opts = {}) {
  const code = normalizeCode(codeNum); const pin = currentPin(opts?.pinOverride); const oid = String(opts?.oid || opts?.localOid || '').trim();
  if (code == null) return { ok: false, displayable: false, verified: false, reason: 'NO_CODE' };
  if (!pin || !oid) return { ok: false, displayable: false, verified: false, reason: 'PIN_OR_DRAFT_MISSING', code };
  if (!online()) return { ok: false, displayable: false, verified: false, offline: true, reason: 'DB_VERIFY_REQUIRED', code };
  let response;
  try { response = await withTimeout(supabase.rpc('verify_pranimi_code_assignment', { p_code: code, p_pin: pin, p_draft_session_id: oid, p_extend_lease_minutes: opts?.meaningful ? MEANINGFUL_DRAFT_LEASE_MINUTES : 0 }), RPC_TIMEOUT_MS, 'VERIFY_PRANIMI_ASSIGNMENT_TIMEOUT'); }
  catch (cause) { throw ambiguous('PRANIMI_ASSIGNMENT_VERIFY_RESULT_AMBIGUOUS', cause); }
  const { data, error } = response || {};
  if (error) throw ambiguous('PRANIMI_ASSIGNMENT_VERIFY_RESULT_AMBIGUOUS', error);
  if (data?.terminal === true || data?.reason === 'DRAFT_ALREADY_FINALIZED') return { ...data, ok: true, displayable: false, verified: true, terminal: true, reason: 'DRAFT_ALREADY_FINALIZED', code, order_id: String(data?.order_id || '').trim() || null };
  if (!data || data.ok !== true || data.displayable !== true) return { ok: true, displayable: false, verified: true, reason: data?.reason || 'DB_ASSIGNMENT_REJECTED', code };
  return { ...data, ok: true, displayable: true, verified: true, code, status: String(data.status || '').trim().toLowerCase(), reserved_by: strictPin(data.reserved_by), draft_session_id: String(data.draft_session_id || '').trim(), lease_expires_at: data.lease_expires_at || null, source: 'verify_pranimi_code_assignment' };
}

export async function renewPranimiCodeAssignmentInDb(codeNum, oid, opts = {}) {
  const code = normalizeCode(codeNum); const pin = currentPin(opts?.pinOverride); const draftSessionId = String(oid || '').trim();
  if (!pin || code == null || !draftSessionId) return { ok: false, reason: 'PIN_DRAFT_OR_CODE_MISSING' };
  if (!online()) return { ok: false, offline: true, reason: 'RENEW_OFFLINE' };
  const lease = opts?.meaningful === true ? MEANINGFUL_DRAFT_LEASE_MINUTES : BLANK_DRAFT_LEASE_MINUTES;
  try { const { data, error } = await withTimeout(supabase.rpc('renew_pranimi_code_assignment', { p_code: code, p_pin: pin, p_draft_session_id: draftSessionId, p_meaningful: opts?.meaningful === true, p_lease_minutes: lease }), RPC_TIMEOUT_MS, 'RENEW_PRANIMI_ASSIGNMENT_TIMEOUT'); if (error) throw error; return data || { ok: false, reason: 'EMPTY_RENEW_RESULT' }; }
  catch (cause) { throw ambiguous('PRANIMI_ASSIGNMENT_RENEW_RESULT_AMBIGUOUS', cause); }
}

export async function consumePranimiCodeAssignmentInDb(codeNum, oid, opts = {}) {
  const pin = currentPin(opts?.pinOverride); const code = normalizeCode(codeNum); const draftSessionId = String(oid || '').trim(); const orderId = String(opts?.orderId || opts?.order_id || '').trim();
  if (!pin || code == null || !draftSessionId || !orderId) return { ok: false, reason: 'CONSUME_VERIFY_KEYS_MISSING' };
  if (!online()) return { ok: false, reason: 'CONSUME_OFFLINE' };
  try { const { data, error } = await withTimeout(supabase.rpc('mark_base_code_used_after_verify', { p_code: code, p_pin: pin, p_draft_session_id: draftSessionId, p_order_id: orderId, p_client_phone: String(opts?.clientPhone || '').trim() || null }), RPC_TIMEOUT_MS, 'MARK_USED_RPC_TIMEOUT'); if (error) return { ok: false, reason: 'CONSUME_RESULT_AMBIGUOUS', error }; return data?.ok === true ? { ...data, ok: true } : { ok: false, reason: data?.reason || 'CONSUME_VERIFY_REFUSED', data }; }
  catch (error) { return { ok: false, reason: 'CONSUME_RESULT_AMBIGUOUS', error }; }
}

function phoneDigits(value) { let d = String(value || '').replace(/\D+/g, ''); if (d.startsWith('383')) d = d.slice(3); return d.replace(/^0+/, ''); }
export async function verifyExistingClientCodeForSave({ clientId, code, phone = '', name = '' } = {}) {
  const id = String(clientId || '').trim(); const c = normalizeCode(code);
  if (!id || c == null) return { ok: false, reason: 'EXISTING_CLIENT_ID_OR_CODE_MISSING' };
  if (!online()) return { ok: false, offline: true, reason: 'EXISTING_CLIENT_VERIFY_REQUIRES_ONLINE' };
  try {
    const { data, error } = await withTimeout(supabase.from('clients').select('id,code,name,full_name,first_name,last_name,phone').eq('id', id).eq('code', c).limit(1).maybeSingle(), RPC_TIMEOUT_MS, 'EXISTING_CLIENT_CODE_VERIFY_TIMEOUT');
    if (error) throw error; if (!data) return { ok: false, reason: 'EXISTING_CLIENT_NOT_FOUND_WITH_CODE' };
    const a = phoneDigits(phone), b = phoneDigits(data.phone); if (a && b && a !== b) return { ok: false, reason: 'EXISTING_CLIENT_PHONE_MISMATCH' };
    const dbName = String(data.full_name || data.name || [data.first_name, data.last_name].filter(Boolean).join(' ') || '').trim(); if (String(name || '').trim() && !dbName) return { ok: false, reason: 'EXISTING_CLIENT_NAME_MISSING' };
    return { ok: true, verified: true, client: data, code: c };
  } catch (cause) { throw ambiguous('EXISTING_CLIENT_VERIFY_RESULT_AMBIGUOUS', cause); }
}

export async function releasePranimiTempCodeAfterExistingClientSaveInDb({ tempCode, finalCode, pin, oid, orderId } = {}) {
  const cleanPin = currentPin(pin), temp = normalizeCode(tempCode), final = normalizeCode(finalCode), sid = String(oid || '').trim(), exactOrderId = String(orderId || '').trim();
  if (!cleanPin || temp == null || final == null || !sid || !exactOrderId) return { ok: false, reason: 'TEMP_RELEASE_VERIFY_KEYS_MISSING' };
  if (!online()) return { ok: false, reason: 'TEMP_RELEASE_OFFLINE' };
  try { const { data, error } = await withTimeout(supabase.rpc('release_pranimi_temp_code_after_existing_client_save', { p_temp_code: temp, p_final_code: final, p_pin: cleanPin, p_draft_session_id: sid, p_order_id: exactOrderId }), RPC_TIMEOUT_MS, 'TEMP_CODE_RELEASE_AFTER_EXISTING_CLIENT_TIMEOUT'); if (error) return { ok: false, reason: 'TEMP_RELEASE_RESULT_AMBIGUOUS', error }; return data?.ok === true ? { ...data, ok: true } : { ok: false, reason: data?.reason || 'TEMP_RELEASE_NOT_CONFIRMED', data }; }
  catch (error) { return { ok: false, reason: 'TEMP_RELEASE_RESULT_AMBIGUOUS', error }; }
}

export async function releasePranimiCodeAssignmentInDb(codeNum, oid, opts = {}) {
  const pin = currentPin(opts?.pinOverride), draftSessionId = String(oid || '').trim(), code = normalizeCode(codeNum);
  if (!pin || !draftSessionId || code == null || !online()) return { ok: false, reason: 'RELEASE_VERIFY_KEYS_MISSING_OR_OFFLINE' };
  try {
    const { data, error } = await withTimeout(supabase.rpc('release_pranimi_code_assignment', { p_code: code, p_pin: pin, p_draft_session_id: draftSessionId, p_reason: String(opts?.reason || 'release_draft') }), RPC_TIMEOUT_MS, 'RELEASE_PRANIMI_ASSIGNMENT_TIMEOUT');
    if (error || data?.ok !== true) return { ok: false, reason: error ? 'RELEASE_RESULT_AMBIGUOUS' : (data?.reason || 'RELEASE_NOT_CONFIRMED'), error: error || null, data: data || null };
    clearOrderCodeCache(draftSessionId);
    removeLocal(`pranimi_code_assignment_proof_v39_1:${draftSessionId}`);
    return { ...data, ok: true };
  } catch (error) { return { ok: false, reason: 'RELEASE_RESULT_AMBIGUOUS', error }; }
}
