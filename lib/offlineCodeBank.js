import { supabase } from './supabaseClient.js';
import { getByKey, putValue } from './localDb.js';
import { getActorPinStrict } from './actorSession.js';
import { getTransportSession } from './transportAuth.js';

export const OFFLINE_CODE_BANK_VERSION = 'offline-code-bank-v1';
export const OFFLINE_CODE_BANK_TARGET = 10;
export const OFFLINE_CODE_BANK_LEASE_HOURS = 720;

const DEVICE_ID_KEY = 'tepiha_device_id_v1';
const SUMMARY_KEY = 'tepiha_offline_code_bank_summary_v1';
const META_PREFIX = 'offline_code_bank_v1:';
const CACHE_PREFIX = 'tepiha_offline_code_bank_cache_v1:';
const ASSIGNMENT_PREFIX = 'offline_code_assignment_v1:';
const bankLocks = new Map();

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback = null) {
  try {
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function safeIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function randomId(prefix = 'device') {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function normalizeScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  return scope === 'base' || scope === 'transport' ? scope : '';
}

function normalizeOwner(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeDraft(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeUuid(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : '';
}

function normalizeBaseCode(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return '';
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : '';
}

function normalizeTransportCode(value) {
  const digits = String(value == null ? '' : value).replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : '';
}

export function normalizeOfflineCode(scopeInput, value) {
  return normalizeScope(scopeInput) === 'transport'
    ? normalizeTransportCode(value)
    : normalizeBaseCode(value);
}

function isUnexpired(item, now = Date.now()) {
  const expiry = Date.parse(String(item?.lease_expires_at || item?.expires_at || ''));
  return Number.isFinite(expiry) && expiry > now;
}

function codeNumber(scope, code) {
  return Number(normalizeOfflineCode(scope, code).replace(/\D+/g, '')) || Number.MAX_SAFE_INTEGER;
}

function bankKey(scope, owner, deviceId) {
  return `${META_PREFIX}${normalizeScope(scope)}:${normalizeOwner(owner)}:${String(deviceId || '').trim()}`;
}

function cacheKey(scope, owner, deviceId) {
  return `${CACHE_PREFIX}${normalizeScope(scope)}:${normalizeOwner(owner)}:${String(deviceId || '').trim()}`;
}

function assignmentKey(scope, draftId) {
  return `${ASSIGNMENT_PREFIX}${normalizeScope(scope)}:${normalizeDraft(draftId)}`;
}

export function getOfflineDeviceId() {
  if (!isBrowser()) return 'server-device-disabled';
  try {
    const current = String(window.localStorage.getItem(DEVICE_ID_KEY) || '').trim();
    if (/^[A-Za-z0-9._:-]{8,160}$/.test(current)) return current;
  } catch {}
  const created = randomId();
  try { window.localStorage.setItem(DEVICE_ID_KEY, created); } catch {}
  return created;
}

export function resolveOfflineBaseOwner(explicit = '') {
  const direct = normalizeOwner(explicit);
  if (/^\d{3,12}$/.test(direct)) return direct;
  try {
    const pin = String(getActorPinStrict() || '').trim();
    return /^\d{3,12}$/.test(pin) ? pin : '';
  } catch {
    return '';
  }
}

export function resolveOfflineTransportOwner(explicit = '') {
  const direct = normalizeOwner(explicit);
  if (direct) return direct;
  try {
    const session = getTransportSession?.() || null;
    return String(
      session?.transport_pin ||
      session?.pin ||
      session?.driver_pin ||
      session?.transport_id ||
      ''
    ).trim();
  } catch {
    return '';
  }
}

export function normalizeOfflineLeaseRow(scopeInput, row = {}, fallback = {}) {
  const scope = normalizeScope(scopeInput || row?.scope || fallback?.scope);
  const code = normalizeOfflineCode(scope, row?.code ?? fallback?.code);
  const token = normalizeUuid(row?.lease_token ?? row?.token ?? fallback?.lease_token);
  const expiresAt = safeIso(row?.lease_expires_at ?? row?.expires_at ?? fallback?.lease_expires_at);
  if (!scope || !code || !token || !expiresAt) return null;

  const serverStatus = String(row?.lease_status || row?.server_status || row?.status || fallback?.status || 'available')
    .trim()
    .toLowerCase();
  const draftId = normalizeDraft(row?.draft_session_id ?? row?.draft_id ?? fallback?.draft_session_id);
  const localState = String(row?.state || fallback?.state || '').trim().toLowerCase();
  const state = serverStatus === 'assigned' || localState === 'assigned' || draftId
    ? 'assigned'
    : 'available';

  return {
    version: OFFLINE_CODE_BANK_VERSION,
    scope,
    code,
    lease_token: token,
    lease_expires_at: expiresAt,
    owner_id: normalizeOwner(row?.owner_id ?? row?.reserved_by ?? fallback?.owner_id),
    device_id: String(row?.device_id ?? fallback?.device_id ?? '').trim(),
    state,
    server_status: serverStatus,
    draft_session_id: draftId,
    assigned_at: safeIso(row?.assigned_at ?? fallback?.assigned_at),
    source: String(row?.source || fallback?.source || 'SERVER_OFFLINE_BANK'),
    updated_at: nowIso(),
  };
}

function normalizeBank(scopeInput, ownerInput, deviceInput, raw = {}) {
  const scope = normalizeScope(scopeInput || raw?.scope);
  const owner = normalizeOwner(ownerInput || raw?.owner_id);
  const deviceId = String(deviceInput || raw?.device_id || '').trim();
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .map((item) => normalizeOfflineLeaseRow(scope, item, { owner_id: owner, device_id: deviceId }))
    .filter(Boolean)
    .filter((item) => isUnexpired(item))
    .sort((a, b) => codeNumber(scope, a.code) - codeNumber(scope, b.code));

  return {
    key: bankKey(scope, owner, deviceId),
    version: OFFLINE_CODE_BANK_VERSION,
    scope,
    owner_id: owner,
    device_id: deviceId,
    items,
    refreshed_at: safeIso(raw?.refreshed_at),
    updated_at: safeIso(raw?.updated_at) || nowIso(),
  };
}

export function mergeOfflineBankItems(scopeInput, serverRows = [], localItems = [], now = Date.now()) {
  const scope = normalizeScope(scopeInput);
  const localByToken = new Map(
    (Array.isArray(localItems) ? localItems : [])
      .map((item) => normalizeOfflineLeaseRow(scope, item))
      .filter(Boolean)
      .filter((item) => isUnexpired(item, now))
      .map((item) => [item.lease_token, item]),
  );

  const merged = [];
  for (const raw of Array.isArray(serverRows) ? serverRows : []) {
    const server = normalizeOfflineLeaseRow(scope, raw);
    if (!server || !isUnexpired(server, now)) continue;
    const local = localByToken.get(server.lease_token) || null;
    const serverAssigned = server.state === 'assigned' && normalizeDraft(server.draft_session_id);
    const localAssigned = local?.state === 'assigned' && normalizeDraft(local?.draft_session_id);

    merged.push({
      ...server,
      state: serverAssigned || localAssigned ? 'assigned' : 'available',
      draft_session_id: serverAssigned
        ? normalizeDraft(server.draft_session_id)
        : (localAssigned ? normalizeDraft(local.draft_session_id) : ''),
      assigned_at: safeIso(server?.assigned_at) || safeIso(local?.assigned_at),
      source: serverAssigned
        ? 'SERVER_ASSIGNED'
        : (localAssigned ? 'LOCAL_ASSIGNED_PENDING_SYNC' : 'SERVER_AVAILABLE'),
    });
  }

  // The reservation RPC returns every active lease for this owner/device. A local
  // token omitted by the server has been consumed, released or expired and must be
  // removed. This prevents a synced draft from permanently occupying a local slot.
  return merged
    .filter((item, index, all) => all.findIndex((candidate) => candidate.lease_token === item.lease_token) === index)
    .sort((a, b) => codeNumber(scope, a.code) - codeNumber(scope, b.code));
}

async function withBankLock(key, task) {
  const previous = bankLocks.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(task);
  bankLocks.set(key, running);
  try {
    return await running;
  } finally {
    if (bankLocks.get(key) === running) bankLocks.delete(key);
  }
}

async function readBank(scope, owner, deviceId) {
  const key = bankKey(scope, owner, deviceId);
  let raw = null;
  try { raw = await getByKey('meta', key); } catch {}
  if (!raw && isBrowser()) {
    try { raw = safeJson(window.localStorage.getItem(cacheKey(scope, owner, deviceId)), null); } catch {}
  }
  return normalizeBank(scope, owner, deviceId, raw || {});
}

function writeSummary(bank) {
  if (!isBrowser()) return;
  try {
    const previous = safeJson(window.localStorage.getItem(SUMMARY_KEY), {}) || {};
    const next = {
      ...previous,
      version: OFFLINE_CODE_BANK_VERSION,
      device_id: bank.device_id,
      updated_at: nowIso(),
      [bank.scope]: {
        owner_id: bank.owner_id,
        available: bank.items.filter((item) => item.state === 'available').length,
        assigned: bank.items.filter((item) => item.state === 'assigned').length,
        total: bank.items.length,
        target: OFFLINE_CODE_BANK_TARGET,
        refreshed_at: bank.refreshed_at || '',
      },
    };
    window.localStorage.setItem(SUMMARY_KEY, JSON.stringify(next));
  } catch {}
}

function cleanStaleAssignments(bank) {
  if (!isBrowser()) return;
  const activeTokens = new Set(bank.items.map((item) => item.lease_token));
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = String(window.localStorage.key(index) || '');
      if (!key.startsWith(`${ASSIGNMENT_PREFIX}${bank.scope}:`)) continue;
      const assignment = safeJson(window.localStorage.getItem(key), null);
      if (!assignment) continue;
      if (String(assignment?.owner_id || '') !== bank.owner_id) continue;
      if (String(assignment?.device_id || '') !== bank.device_id) continue;
      if (!activeTokens.has(String(assignment?.lease_token || ''))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {}
}

function dispatchBankChanged(bank) {
  if (!isBrowser()) return;
  try {
    window.dispatchEvent(new CustomEvent('tepiha:offline-code-bank-changed', {
      detail: {
        scope: bank.scope,
        owner_id: bank.owner_id,
        device_id: bank.device_id,
        available: bank.items.filter((item) => item.state === 'available').length,
        assigned: bank.items.filter((item) => item.state === 'assigned').length,
        target: OFFLINE_CODE_BANK_TARGET,
        refreshed_at: bank.refreshed_at || '',
      },
    }));
  } catch {}
}

async function writeBank(raw = {}) {
  const bank = normalizeBank(raw?.scope, raw?.owner_id, raw?.device_id, {
    ...raw,
    updated_at: nowIso(),
  });
  try { await putValue('meta', bank); } catch {}
  if (isBrowser()) {
    try { window.localStorage.setItem(cacheKey(bank.scope, bank.owner_id, bank.device_id), JSON.stringify(bank)); } catch {}
  }
  cleanStaleAssignments(bank);
  writeSummary(bank);
  dispatchBankChanged(bank);
  return bank;
}

export function getOfflineCodeBankSummarySync() {
  if (!isBrowser()) return {};
  try { return safeJson(window.localStorage.getItem(SUMMARY_KEY), {}) || {}; }
  catch { return {}; }
}

function reserveRpc(scope) {
  return scope === 'transport' ? 'reserve_transport_offline_codes' : 'reserve_base_offline_codes';
}

function reserveArgs(scope, owner, deviceId, target, leaseHours) {
  if (scope === 'transport') {
    return {
      p_owner_id: owner,
      p_device_id: deviceId,
      p_target: target,
      p_lease_hours: leaseHours,
    };
  }
  return {
    p_pin: owner,
    p_device_id: deviceId,
    p_target: target,
    p_lease_hours: leaseHours,
  };
}

export async function refreshOfflineCodeBank(scopeInput, ownerInput, options = {}) {
  const scope = normalizeScope(scopeInput);
  const owner = normalizeOwner(ownerInput);
  const deviceId = String(options?.deviceId || getOfflineDeviceId()).trim();
  const target = Math.min(Math.max(Number(options?.target || OFFLINE_CODE_BANK_TARGET), 1), OFFLINE_CODE_BANK_TARGET);
  const leaseHours = Math.min(Math.max(Number(options?.leaseHours || OFFLINE_CODE_BANK_LEASE_HOURS), 24), 2160);
  if (!scope || !owner || !deviceId) {
    return { ok: false, reason: 'OFFLINE_BANK_IDENTITY_MISSING', scope, owner_id: owner, device_id: deviceId };
  }

  const key = bankKey(scope, owner, deviceId);
  return withBankLock(key, async () => {
    const local = await readBank(scope, owner, deviceId);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return {
        ok: true,
        offline: true,
        bank: local,
        available: local.items.filter((item) => item.state === 'available').length,
        assigned: local.items.filter((item) => item.state === 'assigned').length,
        target,
      };
    }

    const { data, error } = await supabase.rpc(
      reserveRpc(scope),
      reserveArgs(scope, owner, deviceId, target, leaseHours),
    );
    if (error) throw error;

    const items = mergeOfflineBankItems(scope, Array.isArray(data) ? data : [], local.items);
    const bank = await writeBank({
      ...local,
      scope,
      owner_id: owner,
      device_id: deviceId,
      items,
      refreshed_at: nowIso(),
    });

    return {
      ok: true,
      bank,
      available: bank.items.filter((item) => item.state === 'available').length,
      assigned: bank.items.filter((item) => item.state === 'assigned').length,
      target,
    };
  });
}

export async function refreshOfflineCodeBanks(options = {}) {
  const baseOwner = resolveOfflineBaseOwner(options?.baseOwner || options?.basePin || '');
  const transportOwner = resolveOfflineTransportOwner(options?.transportOwner || '');
  const results = {};

  if (baseOwner) {
    try { results.base = await refreshOfflineCodeBank('base', baseOwner, options); }
    catch (error) { results.base = { ok: false, error: String(error?.message || error || '') }; }
  }
  if (transportOwner) {
    try { results.transport = await refreshOfflineCodeBank('transport', transportOwner, options); }
    catch (error) { results.transport = { ok: false, error: String(error?.message || error || '') }; }
  }

  return {
    ok: Object.values(results).some((result) => result?.ok === true),
    device_id: getOfflineDeviceId(),
    results,
  };
}

function writeAssignment(assignment) {
  if (!isBrowser() || !assignment?.scope || !assignment?.draft_session_id) return;
  try {
    window.localStorage.setItem(
      assignmentKey(assignment.scope, assignment.draft_session_id),
      JSON.stringify(assignment),
    );
  } catch {}
}

function clearAssignment(scope, draftId) {
  if (!isBrowser()) return;
  try { window.localStorage.removeItem(assignmentKey(scope, draftId)); } catch {}
}

export function readOfflineCodeAssignment(scopeInput, draftInput) {
  const scope = normalizeScope(scopeInput);
  const draftId = normalizeDraft(draftInput);
  if (!isBrowser() || !scope || !draftId) return null;
  try {
    const raw = safeJson(window.localStorage.getItem(assignmentKey(scope, draftId)), null);
    const lease = normalizeOfflineLeaseRow(scope, raw || {});
    if (!lease || !isUnexpired(lease)) return null;
    return {
      ...lease,
      state: 'assigned',
      draft_session_id: draftId,
      assigned_at: safeIso(raw?.assigned_at),
      status: 'reserved',
      reserved_by: lease.owner_id,
      verified: true,
      source: 'OFFLINE_BANK',
    };
  } catch {
    return null;
  }
}

export async function findOfflineCodeAssignment(scopeInput, draftInput, ownerInput = '') {
  const scope = normalizeScope(scopeInput);
  const draftId = normalizeDraft(draftInput);
  const owner = normalizeOwner(ownerInput || (scope === 'base' ? resolveOfflineBaseOwner() : resolveOfflineTransportOwner()));
  const deviceId = getOfflineDeviceId();
  if (!scope || !draftId || !owner) return null;

  const mapped = readOfflineCodeAssignment(scope, draftId);
  if (mapped && mapped.owner_id === owner && mapped.device_id === deviceId) return mapped;

  const bank = await readBank(scope, owner, deviceId);
  const item = bank.items.find((candidate) => candidate.state === 'assigned' && candidate.draft_session_id === draftId) || null;
  if (!item) return null;
  const assignment = {
    ...item,
    status: 'reserved',
    reserved_by: owner,
    verified: true,
    source: 'OFFLINE_BANK',
  };
  writeAssignment(assignment);
  return assignment;
}

export async function takeOfflineCode(scopeInput, ownerInput, draftInput, options = {}) {
  const scope = normalizeScope(scopeInput);
  const owner = normalizeOwner(ownerInput);
  const draftId = normalizeDraft(draftInput);
  const deviceId = String(options?.deviceId || getOfflineDeviceId()).trim();
  if (!scope || !owner || !draftId || !deviceId) {
    const error = new Error('OFFLINE_CODE_BANK_IDENTITY_MISSING');
    error.code = 'OFFLINE_CODE_BANK_IDENTITY_MISSING';
    throw error;
  }

  const existing = await findOfflineCodeAssignment(scope, draftId, owner);
  if (existing) return existing;

  const key = bankKey(scope, owner, deviceId);
  return withBankLock(key, async () => {
    const bank = await readBank(scope, owner, deviceId);
    const item = bank.items
      .filter((candidate) => candidate.state === 'available' && isUnexpired(candidate))
      .sort((a, b) => codeNumber(scope, a.code) - codeNumber(scope, b.code))[0] || null;

    if (!item) {
      const error = new Error(
        scope === 'transport'
          ? "S'KA T-KODE TË REZERVUARA OFFLINE. HAPE APP-IN ONLINE QË TË MBUSHEN 10 KODE."
          : "S'KA KODE TË REZERVUARA OFFLINE. HAPE APP-IN ONLINE QË TË MBUSHEN 10 KODE.",
      );
      error.code = scope === 'transport'
        ? 'TRANSPORT_OFFLINE_CODE_BANK_EMPTY'
        : 'BASE_CODE_OFFLINE_EMPTY';
      throw error;
    }

    const assignedAt = nowIso();
    const assignedItem = {
      ...item,
      state: 'assigned',
      draft_session_id: draftId,
      assigned_at: assignedAt,
      source: 'OFFLINE_BANK',
    };
    const items = bank.items.map((candidate) => candidate.lease_token === item.lease_token ? assignedItem : candidate);
    await writeBank({ ...bank, items });

    const assignment = {
      ...assignedItem,
      version: OFFLINE_CODE_BANK_VERSION,
      scope,
      owner_id: owner,
      device_id: deviceId,
      status: 'reserved',
      reserved_by: owner,
      verified: true,
      verified_at: assignedAt,
    };
    writeAssignment(assignment);
    return assignment;
  });
}

export async function takeOfflineBaseCode({ pin = '', draftId = '', deviceId = '' } = {}) {
  return takeOfflineCode('base', resolveOfflineBaseOwner(pin), draftId, { deviceId: deviceId || undefined });
}

export async function takeOfflineTransportCode({ owner = '', draftId = '', deviceId = '' } = {}) {
  return takeOfflineCode('transport', resolveOfflineTransportOwner(owner), draftId, { deviceId: deviceId || undefined });
}

export async function releaseOfflineCodeForDraft(scopeInput, ownerInput, draftInput) {
  const scope = normalizeScope(scopeInput);
  const draftId = normalizeDraft(draftInput);
  const assignment = await findOfflineCodeAssignment(scope, draftId, ownerInput);
  if (!assignment) return { ok: true, skipped: true, reason: 'NO_OFFLINE_ASSIGNMENT' };

  const key = bankKey(scope, assignment.owner_id, assignment.device_id);
  return withBankLock(key, async () => {
    const bank = await readBank(scope, assignment.owner_id, assignment.device_id);
    const items = bank.items.map((item) => item.lease_token === assignment.lease_token
      ? { ...item, state: 'available', draft_session_id: '', assigned_at: '', source: 'LOCAL_RELEASED_BEFORE_SYNC' }
      : item);
    await writeBank({ ...bank, items });
    clearAssignment(scope, draftId);
    return { ok: true, code: assignment.code, lease_token: assignment.lease_token };
  });
}

export function extractOfflineCodeLease(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const lifecycle = data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object'
    ? data.pranimi_code_lifecycle
    : {};
  const raw = payload?.offline_code_lease || data?.offline_code_lease || lifecycle?.offline_code_lease || null;
  if (!raw || typeof raw !== 'object') return null;
  const scope = normalizeScope(raw?.scope || (String(payload?.table || '').includes('transport') ? 'transport' : 'base'));
  const lease = normalizeOfflineLeaseRow(scope, raw);
  if (!lease) return null;
  return {
    ...lease,
    state: 'assigned',
    draft_session_id: normalizeDraft(
      raw?.draft_session_id ||
      payload?.local_oid ||
      payload?.id ||
      data?.local_oid ||
      data?.order_id,
    ),
    source: 'OFFLINE_BANK',
  };
}

export function attachOfflineCodeLeaseToPayload(scopeInput, payload = {}) {
  const scope = normalizeScope(scopeInput);
  const data = payload?.data && typeof payload.data === 'object' ? { ...payload.data } : {};
  const draftId = normalizeDraft(payload?.local_oid || payload?.id || data?.local_oid || data?.order_id);
  if (!scope || !draftId) return payload;
  const assignment = readOfflineCodeAssignment(scope, draftId);
  if (!assignment) return payload;

  const lease = {
    version: OFFLINE_CODE_BANK_VERSION,
    scope,
    code: assignment.code,
    owner_id: assignment.owner_id,
    device_id: assignment.device_id,
    lease_token: assignment.lease_token,
    lease_expires_at: assignment.lease_expires_at,
    draft_session_id: draftId,
    state: 'assigned',
    source: 'OFFLINE_BANK',
  };

  const nextData = { ...data, offline_code_lease: lease };
  if (scope === 'base') {
    nextData.pranimi_code_lifecycle = {
      ...((data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {}),
      offline_code_bank: true,
      offline_code_lease: lease,
    };
  }
  return { ...(payload || {}), data: nextData, offline_code_lease: lease };
}

export function stripOfflineLeaseSecretForDb(payload = {}) {
  const next = { ...(payload || {}) };
  const data = next?.data && typeof next.data === 'object' ? { ...next.data } : null;
  if (data) {
    delete data.offline_code_lease;
    if (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') {
      data.pranimi_code_lifecycle = { ...data.pranimi_code_lifecycle };
      delete data.pranimi_code_lifecycle.offline_code_lease;
      delete data.pranimi_code_lifecycle.offline_code_lease_token;
    }
    next.data = data;
  }
  delete next.offline_code_lease;
  return next;
}

export async function bindOfflineCodeLeaseForSync(leaseInput = {}) {
  const scope = normalizeScope(leaseInput?.scope);
  const lease = normalizeOfflineLeaseRow(scope, leaseInput);
  const draftId = normalizeDraft(leaseInput?.draft_session_id);
  if (!lease || !draftId) return { ok: true, skipped: true, reason: 'NO_OFFLINE_LEASE' };
  const functionName = scope === 'transport'
    ? 'bind_transport_offline_code_to_order'
    : 'bind_base_offline_code_to_draft';
  const args = scope === 'transport'
    ? {
        p_owner_id: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: lease.code,
        p_lease_token: lease.lease_token,
        p_draft_session_id: draftId,
      }
    : {
        p_pin: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: Number(lease.code),
        p_lease_token: lease.lease_token,
        p_draft_session_id: draftId,
      };
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) throw error;
  return data || { ok: false, reason: 'OFFLINE_LEASE_BIND_EMPTY' };
}

export async function finalizeOfflineCodeLeaseForSync(leaseInput = {}, options = {}) {
  const scope = normalizeScope(leaseInput?.scope);
  const lease = normalizeOfflineLeaseRow(scope, leaseInput);
  const draftId = normalizeDraft(leaseInput?.draft_session_id);
  const orderId = String(options?.orderId || options?.order_id || '').trim();
  if (!lease || !draftId) return { ok: true, skipped: true, reason: 'NO_OFFLINE_LEASE' };
  if (!orderId) throw new Error('OFFLINE_LEASE_FINAL_ORDER_ID_MISSING');

  const functionName = scope === 'transport'
    ? 'finalize_transport_offline_code'
    : 'finalize_base_offline_code';
  const args = scope === 'transport'
    ? {
        p_owner_id: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: lease.code,
        p_lease_token: lease.lease_token,
        p_draft_session_id: draftId,
        p_order_id: orderId,
      }
    : {
        p_pin: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: Number(lease.code),
        p_lease_token: lease.lease_token,
        p_draft_session_id: draftId,
        p_order_id: orderId,
        p_client_phone: String(options?.clientPhone || options?.client_phone || ''),
      };
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) throw error;
  const result = data || { ok: false, reason: 'OFFLINE_LEASE_FINALIZE_EMPTY' };
  if (result?.ok === true) await markOfflineCodeLeaseFinishedLocal({ ...lease, draft_session_id: draftId }, result);
  return result;
}

export async function markOfflineCodeLeaseFinishedLocal(leaseInput = {}, result = {}) {
  const scope = normalizeScope(leaseInput?.scope);
  const lease = normalizeOfflineLeaseRow(scope, leaseInput);
  const draftId = normalizeDraft(leaseInput?.draft_session_id);
  if (!lease) return false;

  const key = bankKey(scope, lease.owner_id, lease.device_id);
  await withBankLock(key, async () => {
    const bank = await readBank(scope, lease.owner_id, lease.device_id);
    await writeBank({ ...bank, items: bank.items.filter((item) => item.lease_token !== lease.lease_token) });
  });
  if (draftId) clearAssignment(scope, draftId);
  if (isBrowser()) {
    try {
      window.dispatchEvent(new CustomEvent('tepiha:offline-code-lease-finished', {
        detail: { scope, code: lease.code, draft_session_id: draftId, result },
      }));
    } catch {}
  }
  return true;
}

export default {
  OFFLINE_CODE_BANK_VERSION,
  OFFLINE_CODE_BANK_TARGET,
  OFFLINE_CODE_BANK_LEASE_HOURS,
  getOfflineDeviceId,
  resolveOfflineBaseOwner,
  resolveOfflineTransportOwner,
  normalizeOfflineCode,
  normalizeOfflineLeaseRow,
  mergeOfflineBankItems,
  refreshOfflineCodeBank,
  refreshOfflineCodeBanks,
  getOfflineCodeBankSummarySync,
  takeOfflineCode,
  takeOfflineBaseCode,
  takeOfflineTransportCode,
  readOfflineCodeAssignment,
  findOfflineCodeAssignment,
  releaseOfflineCodeForDraft,
  attachOfflineCodeLeaseToPayload,
  extractOfflineCodeLease,
  stripOfflineLeaseSecretForDb,
  bindOfflineCodeLeaseForSync,
  finalizeOfflineCodeLeaseForSync,
  markOfflineCodeLeaseFinishedLocal,
};
