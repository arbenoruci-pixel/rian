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
const ASSIGNMENT_PREFIX = 'offline_code_assignment_v1:';
const BANK_CACHE_PREFIX = 'tepiha_offline_code_bank_cache_v1:';
const locks = new Map();

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeJsonParse(raw, fallback = null) {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function randomId(prefix = 'dev') {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function normalizeScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  if (scope === 'base' || scope === 'transport') return scope;
  return '';
}

function normalizeBaseCode(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return '';
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : '';
}

function normalizeTransportCode(value) {
  const raw = String(value == null ? '' : value).trim();
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : '';
}

export function normalizeOfflineCode(scope, value) {
  return normalizeScope(scope) === 'transport'
    ? normalizeTransportCode(value)
    : normalizeBaseCode(value);
}

function normalizeOwner(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeDraftId(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeLeaseToken(value) {
  const token = String(value == null ? '' : value).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
    ? token
    : '';
}

function bankKey(scope, owner, deviceId) {
  return `${META_PREFIX}${normalizeScope(scope)}:${normalizeOwner(owner)}:${String(deviceId || '').trim()}`;
}

function cacheKey(scope, owner, deviceId) {
  return `${BANK_CACHE_PREFIX}${normalizeScope(scope)}:${normalizeOwner(owner)}:${String(deviceId || '').trim()}`;
}

function assignmentKey(scope, draftId) {
  return `${ASSIGNMENT_PREFIX}${normalizeScope(scope)}:${normalizeDraftId(draftId)}`;
}

function codeSortValue(scope, code) {
  const normalized = normalizeOfflineCode(scope, code);
  return Number(normalized.replace(/\D+/g, '')) || Number.MAX_SAFE_INTEGER;
}

function nowIso() {
  return new Date().toISOString();
}

function isUnexpired(item, now = Date.now()) {
  const expiry = Date.parse(String(item?.lease_expires_at || item?.expires_at || ''));
  return Number.isFinite(expiry) && expiry > now;
}

export function getOfflineDeviceId() {
  if (!isBrowser()) return 'server-device-disabled';
  try {
    const current = String(window.localStorage.getItem(DEVICE_ID_KEY) || '').trim();
    if (/^[A-Za-z0-9._:-]{8,160}$/.test(current)) return current;
  } catch {}

  const created = randomId('device');
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
    const owner = String(session?.transport_id || session?.transport_pin || session?.pin || '').trim();
    if (owner) return owner;
  } catch {}
  try {
    return String(getActorPinStrict() || '').trim();
  } catch {
    return '';
  }
}

export function normalizeOfflineLeaseRow(scopeInput, row = {}) {
  const scope = normalizeScope(scopeInput || row?.scope);
  const code = normalizeOfflineCode(scope, row?.code);
  const leaseToken = normalizeLeaseToken(row?.lease_token || row?.token);
  const leaseExpiresAt = safeIso(row?.lease_expires_at || row?.expires_at);
  if (!scope || !code || !leaseToken || !leaseExpiresAt) return null;

  const serverStatus = String(row?.lease_status || row?.status || 'available').trim().toLowerCase();
  const draftId = normalizeDraftId(row?.draft_session_id || row?.draft_id);
  return {
    version: OFFLINE_CODE_BANK_VERSION,
    scope,
    code,
    lease_token: leaseToken,
    lease_expires_at: leaseExpiresAt,
    owner_id: normalizeOwner(row?.owner_id || row?.reserved_by),
    device_id: String(row?.device_id || '').trim(),
    state: serverStatus === 'assigned' || draftId ? 'assigned' : 'available',
    draft_session_id: draftId,
    server_status: serverStatus,
    source: 'SERVER_OFFLINE_BANK',
    updated_at: nowIso(),
  };
}

function normalizeLocalBank(scope, owner, deviceId, value = {}) {
  const items = (Array.isArray(value?.items) ? value.items : [])
    .map((item) => normalizeOfflineLeaseRow(scope, {
      ...item,
      lease_status: item?.state || item?.server_status || 'available',
      owner_id: item?.owner_id || owner,
      device_id: item?.device_id || deviceId,
    }))
    .filter(Boolean)
    .map((item) => ({
      ...item,
      state: String(value?.items?.find?.((x) => String(x?.lease_token || '') === item.lease_token)?.state || item.state || 'available'),
      draft_session_id: normalizeDraftId(value?.items?.find?.((x) => String(x?.lease_token || '') === item.lease_token)?.draft_session_id || item.draft_session_id),
    }))
    .filter((item) => isUnexpired(item));

  return {
    key: bankKey(scope, owner, deviceId),
    version: OFFLINE_CODE_BANK_VERSION,
    scope: normalizeScope(scope),
    owner_id: normalizeOwner(owner),
    device_id: String(deviceId || '').trim(),
    items,
    refreshed_at: safeIso(value?.refreshed_at) || '',
    updated_at: safeIso(value?.updated_at) || nowIso(),
  };
}

export function mergeOfflineBankItems(scopeInput, serverRows = [], localItems = [], now = Date.now()) {
  const scope = normalizeScope(scopeInput);
  const localByToken = new Map(
    (Array.isArray(localItems) ? localItems : [])
      .filter((item) => isUnexpired(item, now))
      .map((item) => [String(item?.lease_token || ''), item]),
  );

  const merged = [];
  for (const raw of Array.isArray(serverRows) ? serverRows : []) {
    const server = normalizeOfflineLeaseRow(scope, raw);
    if (!server || !isUnexpired(server, now)) continue;
    const local = localByToken.get(server.lease_token) || null;
    const localAssigned = local?.state === 'assigned' && normalizeDraftId(local?.draft_session_id);
    const serverAssigned = server?.state === 'assigned' && normalizeDraftId(server?.draft_session_id);

    merged.push({
      ...server,
      state: serverAssigned || localAssigned ? 'assigned' : 'available',
      draft_session_id: serverAssigned
        ? normalizeDraftId(server.draft_session_id)
        : (localAssigned ? normalizeDraftId(local.draft_session_id) : ''),
      assigned_at: safeIso(local?.assigned_at) || '',
      source: serverAssigned ? 'SERVER_ASSIGNED' : (localAssigned ? 'LOCAL_ASSIGNED_PENDING_SYNC' : 'SERVER_AVAILABLE'),
    });
    localByToken.delete(server.lease_token);
  }

  // Retain an unexpired local assignment even if a transient server response omitted it.
  // It remains unavailable for another draft until sync/finalize decides its outcome.
  for (const local of localByToken.values()) {
    if (local?.state !== 'assigned' || !normalizeDraftId(local?.draft_session_id)) continue;
    merged.push({ ...local, state: 'assigned', source: 'LOCAL_ASSIGNED_SERVER_OMITTED' });
  }

  return merged
    .filter((item, index, arr) => arr.findIndex((x) => x.lease_token === item.lease_token) === index)
    .sort((a, b) => codeSortValue(scope, a.code) - codeSortValue(scope, b.code));
}

async function withBankLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

async function readBank(scope, owner, deviceId) {
  const key = bankKey(scope, owner, deviceId);
  let value = null;
  try { value = await getByKey('meta', key); } catch {}
  if (!value && isBrowser()) {
    try { value = safeJsonParse(window.localStorage.getItem(cacheKey(scope, owner, deviceId)), null); } catch {}
  }
  return normalizeLocalBank(scope, owner, deviceId, value || {});
}

async function writeBank(bank = {}) {
  const normalized = normalizeLocalBank(bank?.scope, bank?.owner_id, bank?.device_id, {
    ...bank,
    updated_at: nowIso(),
  });
  normalized.key = bankKey(normalized.scope, normalized.owner_id, normalized.device_id);
  try { await putValue('meta', normalized); } catch {}
  if (isBrowser()) {
    try { window.localStorage.setItem(cacheKey(normalized.scope, normalized.owner_id, normalized.device_id), JSON.stringify(normalized)); } catch {}
  }
  writeSummarySnapshot(normalized);
  dispatchBankChanged(normalized);
  return normalized;
}

function dispatchBankChanged(bank) {
  try {
    if (!isBrowser()) return;
    window.dispatchEvent(new CustomEvent('tepiha:offline-code-bank-changed', {
      detail: {
        scope: bank?.scope || '',
        owner_id: bank?.owner_id || '',
        device_id: bank?.device_id || '',
        available: (bank?.items || []).filter((item) => item?.state === 'available').length,
        assigned: (bank?.items || []).filter((item) => item?.state === 'assigned').length,
        target: OFFLINE_CODE_BANK_TARGET,
        refreshed_at: bank?.refreshed_at || '',
      },
    }));
  } catch {}
}

function writeSummarySnapshot(bank) {
  if (!isBrowser()) return;
  try {
    const current = safeJsonParse(window.localStorage.getItem(SUMMARY_KEY), {}) || {};
    const next = {
      ...current,
      version: OFFLINE_CODE_BANK_VERSION,
      updated_at: nowIso(),
      device_id: bank?.device_id || current?.device_id || getOfflineDeviceId(),
      [bank?.scope]: {
        owner_id: bank?.owner_id || '',
        available: (bank?.items || []).filter((item) => item?.state === 'available').length,
        assigned: (bank?.items || []).filter((item) => item?.state === 'assigned').length,
        total: (bank?.items || []).length,
        target: OFFLINE_CODE_BANK_TARGET,
        refreshed_at: bank?.refreshed_at || '',
      },
    };
    window.localStorage.setItem(SUMMARY_KEY, JSON.stringify(next));
  } catch {}
}

export function getOfflineCodeBankSummarySync() {
  if (!isBrowser()) return {};
  try { return safeJsonParse(window.localStorage.getItem(SUMMARY_KEY), {}) || {}; } catch { return {}; }
}

function rpcForScope(scope) {
  return normalizeScope(scope) === 'transport'
    ? 'reserve_transport_offline_codes'
    : 'reserve_base_offline_codes';
}

function rpcArgsForScope(scope, owner, deviceId, target, leaseHours) {
  if (normalizeScope(scope) === 'transport') {
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
  if (!scope || !owner || !deviceId) return { ok: false, reason: 'BANK_IDENTITY_MISSING', scope, owner, deviceId };

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
      };
    }

    const { data, error } = await supabase.rpc(
      rpcForScope(scope),
      rpcArgsForScope(scope, owner, deviceId, target, leaseHours),
    );
    if (error) throw error;

    const items = mergeOfflineBankItems(scope, Array.isArray(data) ? data : [], local.items);
    const bank = await writeBank({
      ...local,
      key,
      scope,
      owner_id: owner,
      device_id: deviceId,
      items,
      refreshed_at: nowIso(),
      updated_at: nowIso(),
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
    ok: Object.values(results).some((item) => item?.ok === true),
    device_id: getOfflineDeviceId(),
    results,
  };
}

function writeAssignment(assignment) {
  if (!isBrowser() || !assignment?.scope || !assignment?.draft_session_id) return;
  try { window.localStorage.setItem(assignmentKey(assignment.scope, assignment.draft_session_id), JSON.stringify(assignment)); } catch {}
}

function clearAssignment(scope, draftId) {
  if (!isBrowser()) return;
  try { window.localStorage.removeItem(assignmentKey(scope, draftId)); } catch {}
}

export function readOfflineCodeAssignment(scopeInput, draftIdInput) {
  const scope = normalizeScope(scopeInput);
  const draftId = normalizeDraftId(draftIdInput);
  if (!isBrowser() || !scope || !draftId) return null;
  try {
    const value = safeJsonParse(window.localStorage.getItem(assignmentKey(scope, draftId)), null);
    const normalized = normalizeOfflineLeaseRow(scope, value || {});
    if (!normalized || !isUnexpired(normalized)) return null;
    return {
      ...normalized,
      state: 'assigned',
      draft_session_id: draftId,
      assigned_at: safeIso(value?.assigned_at) || '',
      source: 'OFFLINE_BANK',
    };
  } catch {
    return null;
  }
}

export async function takeOfflineCode(scopeInput, ownerInput, draftIdInput, options = {}) {
  const scope = normalizeScope(scopeInput);
  const owner = normalizeOwner(ownerInput);
  const draftId = normalizeDraftId(draftIdInput);
  const deviceId = String(options?.deviceId || getOfflineDeviceId()).trim();
  if (!scope || !owner || !draftId) throw new Error('OFFLINE_CODE_BANK_IDENTITY_MISSING');

  const existingAssignment = readOfflineCodeAssignment(scope, draftId);
  if (existingAssignment && existingAssignment.owner_id === owner) return existingAssignment;

  const key = bankKey(scope, owner, deviceId);
  return withBankLock(key, async () => {
    const bank = await readBank(scope, owner, deviceId);
    let item = bank.items.find((entry) => entry.state === 'assigned' && entry.draft_session_id === draftId) || null;
    if (!item) {
      item = bank.items
        .filter((entry) => entry.state === 'available' && isUnexpired(entry))
        .sort((a, b) => codeSortValue(scope, a.code) - codeSortValue(scope, b.code))[0] || null;
    }
    if (!item) {
      const error = new Error(scope === 'transport'
        ? "S'KA T-KODE TË REZERVUARA OFFLINE. HAPE APP-IN ONLINE QË TË MBUSHEN 10 KODE."
        : "S'KA KODE TË REZERVUARA OFFLINE. HAPE APP-IN ONLINE QË TË MBUSHEN 10 KODE.");
      error.code = scope === 'transport' ? 'TRANSPORT_OFFLINE_CODE_BANK_EMPTY' : 'BASE_OFFLINE_CODE_BANK_EMPTY';
      throw error;
    }

    const assignedAt = nowIso();
    const nextItem = {
      ...item,
      state: 'assigned',
      draft_session_id: draftId,
      assigned_at: assignedAt,
      source: 'OFFLINE_BANK',
    };
    const items = bank.items.map((entry) => entry.lease_token === item.lease_token ? nextItem : entry);
    await writeBank({ ...bank, items, updated_at: assignedAt });

    const assignment = {
      ...nextItem,
      version: OFFLINE_CODE_BANK_VERSION,
      scope,
      owner_id: owner,
      device_id: deviceId,
      draft_session_id: draftId,
      status: 'reserved',
      reserved_by: owner,
      verified: true,
      verified_at: assignedAt,
      source: 'OFFLINE_BANK',
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

export async function releaseOfflineCodeForDraft(scopeInput, ownerInput, draftIdInput) {
  const scope = normalizeScope(scopeInput);
  const owner = normalizeOwner(ownerInput);
  const draftId = normalizeDraftId(draftIdInput);
  const assignment = readOfflineCodeAssignment(scope, draftId);
  if (!assignment) return { ok: true, skipped: true, reason: 'NO_OFFLINE_ASSIGNMENT' };
  if (owner && assignment.owner_id !== owner) return { ok: false, reason: 'OFFLINE_ASSIGNMENT_OWNER_MISMATCH' };

  const key = bankKey(scope, assignment.owner_id, assignment.device_id);
  return withBankLock(key, async () => {
    const bank = await readBank(scope, assignment.owner_id, assignment.device_id);
    const items = bank.items.map((item) => {
      if (item.lease_token !== assignment.lease_token) return item;
      return { ...item, state: 'available', draft_session_id: '', assigned_at: '', source: 'LOCAL_RELEASED_BEFORE_SYNC' };
    });
    await writeBank({ ...bank, items, updated_at: nowIso() });
    clearAssignment(scope, draftId);
    return { ok: true, code: assignment.code, lease_token: assignment.lease_token };
  });
}

export function extractOfflineCodeLease(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const lifecycle = data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object'
    ? data.pranimi_code_lifecycle
    : {};
  const raw = data?.offline_code_lease || lifecycle?.offline_code_lease || payload?.offline_code_lease || null;
  if (!raw || typeof raw !== 'object') return null;
  const scope = normalizeScope(raw?.scope || (String(payload?.table || '').includes('transport') ? 'transport' : 'base'));
  const normalized = normalizeOfflineLeaseRow(scope, {
    ...raw,
    lease_status: raw?.state || raw?.status || 'assigned',
    lease_expires_at: raw?.lease_expires_at || raw?.expires_at,
  });
  if (!normalized) return null;
  return {
    ...normalized,
    draft_session_id: normalizeDraftId(raw?.draft_session_id || payload?.local_oid || payload?.id || data?.local_oid),
    state: 'assigned',
    source: 'OFFLINE_BANK',
  };
}

export function attachOfflineCodeLeaseToPayload(scopeInput, payload = {}) {
  const scope = normalizeScope(scopeInput);
  const data = payload?.data && typeof payload.data === 'object' ? { ...payload.data } : {};
  const draftId = normalizeDraftId(payload?.local_oid || payload?.id || payload?.oid || data?.local_oid);
  if (!scope || !draftId) return payload;
  const assignment = readOfflineCodeAssignment(scope, draftId);
  if (!assignment) return payload;

  const payloadCode = normalizeOfflineCode(scope,
    scope === 'transport'
      ? (payload?.code_str || payload?.client_tcode || data?.code_str || data?.client_tcode)
      : (payload?.code || data?.code || data?.client?.code),
  );
  if (payloadCode && payloadCode !== assignment.code) return payload;

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
      offline_code_lease: lease,
      offline_code_bank: true,
      offline_code_lease_token: assignment.lease_token,
      offline_code_device_id: assignment.device_id,
    };
  }

  return {
    ...(payload || {}),
    data: nextData,
    offline_code_lease: lease,
  };
}

export function stripOfflineLeaseSecretForDb(payload = {}) {
  const next = { ...(payload || {}) };
  const data = next?.data && typeof next.data === 'object' ? { ...next.data } : null;
  const lease = extractOfflineCodeLease(next);
  if (data) {
    delete data.offline_code_lease;
    if (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') {
      data.pranimi_code_lifecycle = { ...data.pranimi_code_lifecycle };
      delete data.pranimi_code_lifecycle.offline_code_lease;
      delete data.pranimi_code_lifecycle.offline_code_lease_token;
      delete data.pranimi_code_lifecycle.offline_code_device_id;
      if (lease) {
        data.pranimi_code_lifecycle.offline_code_bank = true;
        data.pranimi_code_lifecycle.offline_code_scope = lease.scope;
      }
    }
    next.data = data;
  }
  delete next.offline_code_lease;
  return next;
}

export async function bindOfflineCodeLeaseForSync(leaseInput = {}) {
  const lease = extractOfflineCodeLease({ offline_code_lease: leaseInput, table: leaseInput?.scope === 'transport' ? 'transport_orders' : 'orders', local_oid: leaseInput?.draft_session_id });
  if (!lease) return { ok: true, skipped: true, reason: 'NO_OFFLINE_LEASE' };

  const fn = lease.scope === 'transport'
    ? 'bind_transport_offline_code_to_order'
    : 'bind_base_offline_code_to_draft';
  const args = lease.scope === 'transport'
    ? {
        p_owner_id: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: lease.code,
        p_lease_token: lease.lease_token,
        p_draft_session_id: lease.draft_session_id,
      }
    : {
        p_pin: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: Number(lease.code),
        p_lease_token: lease.lease_token,
        p_draft_session_id: lease.draft_session_id,
      };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data || { ok: false, reason: 'OFFLINE_LEASE_BIND_EMPTY' };
}

export async function finalizeOfflineCodeLeaseForSync(leaseInput = {}, options = {}) {
  const lease = extractOfflineCodeLease({ offline_code_lease: leaseInput, table: leaseInput?.scope === 'transport' ? 'transport_orders' : 'orders', local_oid: leaseInput?.draft_session_id });
  if (!lease) return { ok: true, skipped: true, reason: 'NO_OFFLINE_LEASE' };
  const orderId = String(options?.orderId || options?.order_id || '').trim();
  if (!orderId) throw new Error('OFFLINE_LEASE_FINAL_ORDER_ID_MISSING');

  const fn = lease.scope === 'transport'
    ? 'finalize_transport_offline_code'
    : 'finalize_base_offline_code';
  const args = lease.scope === 'transport'
    ? {
        p_owner_id: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: lease.code,
        p_lease_token: lease.lease_token,
        p_draft_session_id: lease.draft_session_id,
        p_order_id: orderId,
      }
    : {
        p_pin: lease.owner_id,
        p_device_id: lease.device_id,
        p_code: Number(lease.code),
        p_lease_token: lease.lease_token,
        p_draft_session_id: lease.draft_session_id,
        p_order_id: orderId,
        p_client_phone: String(options?.clientPhone || options?.client_phone || ''),
      };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  const result = data || { ok: false, reason: 'OFFLINE_LEASE_FINALIZE_EMPTY' };
  if (result?.ok === true) {
    await markOfflineCodeLeaseFinishedLocal(lease, result);
  }
  return result;
}

export async function markOfflineCodeLeaseFinishedLocal(leaseInput = {}, result = {}) {
  const lease = extractOfflineCodeLease({ offline_code_lease: leaseInput, table: leaseInput?.scope === 'transport' ? 'transport_orders' : 'orders', local_oid: leaseInput?.draft_session_id });
  if (!lease) return false;
  const key = bankKey(lease.scope, lease.owner_id, lease.device_id);
  await withBankLock(key, async () => {
    const bank = await readBank(lease.scope, lease.owner_id, lease.device_id);
    const items = bank.items.filter((item) => item.lease_token !== lease.lease_token);
    await writeBank({ ...bank, items, updated_at: nowIso() });
    clearAssignment(lease.scope, lease.draft_session_id);
  });
  try {
    if (isBrowser()) {
      window.dispatchEvent(new CustomEvent('tepiha:offline-code-lease-finished', {
        detail: { scope: lease.scope, code: lease.code, draft_session_id: lease.draft_session_id, result },
      }));
    }
  } catch {}
  return true;
}

export default {
  OFFLINE_CODE_BANK_VERSION,
  OFFLINE_CODE_BANK_TARGET,
  getOfflineDeviceId,
  refreshOfflineCodeBank,
  refreshOfflineCodeBanks,
  takeOfflineCode,
  takeOfflineBaseCode,
  takeOfflineTransportCode,
  releaseOfflineCodeForDraft,
  readOfflineCodeAssignment,
  attachOfflineCodeLeaseToPayload,
  extractOfflineCodeLease,
  stripOfflineLeaseSecretForDb,
  bindOfflineCodeLeaseForSync,
  finalizeOfflineCodeLeaseForSync,
  getOfflineCodeBankSummarySync,
};
