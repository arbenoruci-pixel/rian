import { createHash } from 'node:crypto';
import {
  isValidTransportPhoneServer,
  normalizeTransportPhoneKeyServer,
  normalizeTransportTCodeServer,
} from './transportServer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN_RE = /^\d{3,12}$/;
const MAX_ROWS = 250;
const MAX_M2 = 1000;
const MAX_QTY = 1000;
const MAX_RATE = 100;
const DEFAULT_RATE = 1.8;

export class TransportSelfEntryError extends Error {
  constructor(code, httpStatus = 400, extra = {}) {
    super(String(code || 'TRANSPORT_SELF_ENTRY_FAILED'));
    this.name = 'TransportSelfEntryError';
    this.code = String(code || 'TRANSPORT_SELF_ENTRY_FAILED');
    this.httpStatus = Number(httpStatus) || 400;
    this.extra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  }
}

function fail(code, httpStatus = 400, extra = {}) {
  throw new TransportSelfEntryError(code, httpStatus, extra);
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 8000) {
  return String(value || '').trim().replace(/\r\n?/g, '\n').slice(0, maxLength);
}

function cleanUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean.toLowerCase() : '';
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedJsonValue(value, depth = 0) {
  if (depth > 8) fail('TRANSPORT_SELF_ENTRY_DATA_TOO_DEEP', 400);
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 12000);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('TRANSPORT_SELF_ENTRY_DATA_INVALID', 400);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ROWS) fail('TRANSPORT_SELF_ENTRY_DATA_TOO_LARGE', 413);
    return value.map((item) => boundedJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) fail('TRANSPORT_SELF_ENTRY_DATA_INVALID', 400);
  const entries = Object.entries(value);
  if (entries.length > 250) fail('TRANSPORT_SELF_ENTRY_DATA_TOO_LARGE', 413);
  const output = {};
  for (const [keyLike, nested] of entries) {
    const key = String(keyLike || '').trim();
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key.slice(0, 160)] = boundedJsonValue(nested, depth + 1);
  }
  return output;
}

function cleanCoordinate(value, kind) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  const valid = Number.isFinite(number)
    && (kind === 'lat' ? number >= -90 && number <= 90 : number >= -180 && number <= 180);
  if (!valid) fail(kind === 'lat' ? 'TRANSPORT_SELF_ENTRY_GPS_LAT_INVALID' : 'TRANSPORT_SELF_ENTRY_GPS_LNG_INVALID', 400);
  return String(number);
}

function normalizeRows(value, kind) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) {
    fail(`TRANSPORT_SELF_ENTRY_${kind.toUpperCase()}_INVALID`, 400);
  }
  const output = [];
  for (const [index, rowLike] of value.entries()) {
    if (!isPlainObject(rowLike)) fail(`TRANSPORT_SELF_ENTRY_${kind.toUpperCase()}_ROW_INVALID`, 400);
    const m2Raw = rowLike.m2 ?? rowLike.m2_total ?? rowLike.area ?? rowLike.size;
    const qtyRaw = rowLike.qty ?? rowLike.pieces ?? rowLike.cope;
    const m2Blank = m2Raw == null || String(m2Raw).trim() === '';
    const qtyBlank = qtyRaw == null || String(qtyRaw).trim() === '';
    if (m2Blank && (qtyBlank || Number(qtyRaw) === 0)) continue;
    const m2 = Number(m2Raw);
    const qty = qtyBlank ? 1 : Number(qtyRaw);
    if (!Number.isFinite(m2) || m2 <= 0 || m2 > MAX_M2) {
      fail(`TRANSPORT_SELF_ENTRY_${kind.toUpperCase()}_M2_INVALID`, 400);
    }
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
      fail(`TRANSPORT_SELF_ENTRY_${kind.toUpperCase()}_QTY_INVALID`, 400);
    }
    const photoUrl = cleanText(rowLike.photoUrl || rowLike.photo_url || '', 4000);
    output.push({
      id: cleanText(rowLike.id || `${kind}-${index + 1}`, 160) || `${kind}-${index + 1}`,
      m2,
      qty,
      ...(photoUrl ? { photoUrl } : {}),
      ...(rowLike.planned === true ? { planned: true } : {}),
    });
  }
  return output;
}

function normalizeStairs(value) {
  const raw = value == null ? {} : value;
  if (!isPlainObject(raw)) fail('TRANSPORT_SELF_ENTRY_SHKALLORE_INVALID', 400);
  const qtyRaw = raw.qty ?? raw.pieces ?? raw.cope ?? 0;
  const qty = Number(qtyRaw || 0);
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
    fail('TRANSPORT_SELF_ENTRY_SHKALLORE_QTY_INVALID', 400);
  }
  const perRaw = raw.per ?? raw.m2_per_step ?? 0.3;
  const per = Number(perRaw || 0.3);
  if (!Number.isFinite(per) || per <= 0 || per > 10) {
    fail('TRANSPORT_SELF_ENTRY_SHKALLORE_PER_INVALID', 400);
  }
  const photoUrl = cleanText(raw.photoUrl || raw.photo_url || '', 4000);
  return { qty, per, ...(photoUrl ? { photoUrl } : {}) };
}

export function normalizeTransportPranimiBusinessData(data) {
  const raw = isPlainObject(data) ? data : {};
  const tepihaSource = Array.isArray(raw.tepiha) ? raw.tepiha : raw.tepihaRows;
  const stazaSource = Array.isArray(raw.staza) ? raw.staza : raw.stazaRows;
  const tepiha = normalizeRows(tepihaSource, 'tepiha');
  const staza = normalizeRows(stazaSource, 'staza');
  const shkallore = normalizeStairs(raw.shkallore);
  const m2 = round2(
    tepiha.reduce((sum, row) => sum + (row.m2 * row.qty), 0)
    + staza.reduce((sum, row) => sum + (row.m2 * row.qty), 0)
    + (shkallore.qty * shkallore.per),
  );
  const pieces = tepiha.reduce((sum, row) => sum + row.qty, 0)
    + staza.reduce((sum, row) => sum + row.qty, 0)
    + shkallore.qty;
  const rate = Number(raw?.pay?.rate ?? raw?.price_per_m2 ?? DEFAULT_RATE);
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE) {
    fail('TRANSPORT_SELF_ENTRY_PRICE_RATE_INVALID', 400);
  }
  const total = round2(m2 * rate);
  const paid = round2(finiteNonNegative(raw?.pay?.paid ?? raw?.clientPaid ?? raw?.paid));
  const arkaRecordedPaid = round2(finiteNonNegative(raw?.pay?.arkaRecordedPaid));
  const debt = round2(Math.max(0, total - paid));
  const output = {
    tepiha,
    staza,
    shkallore,
    pay: {
      m2,
      euro: total,
      total,
      paid,
      rate,
      pieces,
      arkaRecordedPaid,
      debt,
    },
    totals: { m2, total, euro: total, pieces },
    price_per_m2: rate,
    clientPaid: paid,
    paid,
    debt,
    isPaid: total > 0 && debt <= 0,
    notes: cleanMultiline(raw.notes, 8000),
  };
  for (const key of ['pickup_date', 'pickup_slot', 'pickup_window', 'planning_bucket']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) output[key] = cleanText(raw[key], 500);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'location_gps_explicit')) {
    output.location_gps_explicit = raw.location_gps_explicit === true;
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 80 * 1024) {
    fail('TRANSPORT_SELF_ENTRY_DATA_TOO_LARGE', 413);
  }
  return output;
}

function normalizeRpcResult(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current) && current.length === 1) {
      [current] = current;
      continue;
    }
    if (typeof current === 'string') {
      try { current = JSON.parse(current); continue; } catch { return null; }
    }
    break;
  }
  return isPlainObject(current) ? current : null;
}

function rpcErrorCode(error) {
  const text = [error?.message, error?.details, error?.hint, error?.code]
    .map((value) => String(value || '').toUpperCase())
    .join(' ');
  return [
    'TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
    'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT',
    'TRANSPORT_PHONE_IDENTITY_CONFLICT',
    'TRANSPORT_ATOMIC_TCODE_SERVICE_ROLE_REQUIRED',
    'TRANSPORT_TCODE_REQUIRED_FOR_NEW_CLIENT',
    'TRANSPORT_SUPPLIED_TCODE_CLAIM_INVALID',
    'TRANSPORT_CODE_PAIR_MISMATCH',
    'TRANSPORT_PHONE_INVALID',
  ].find((code) => text.includes(code)) || '';
}

function actorAliases(authUser) {
  return Array.from(new Set([
    authUser?.id,
    authUser?.pin,
    authUser?.transportId,
    authUser?.tid,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function requireActorBinding(body, data, authUser) {
  const requested = String(
    body?.queued_actor_id
    || data?.queued_actor_id
    || data?.transport_id
    || data?.transport_user_id
    || '',
  ).trim();
  if (!requested) fail('TRANSPORT_SELF_ENTRY_ACTOR_BINDING_REQUIRED', 403);
  const aliases = actorAliases(authUser);
  const requestedUuid = cleanUuid(requested);
  if (requestedUuid) {
    if (requestedUuid !== authUser.id) fail('TRANSPORT_SELF_ENTRY_ACTOR_BINDING_MISMATCH', 403);
  } else if (!aliases.includes(requested)) {
    fail('TRANSPORT_SELF_ENTRY_ACTOR_BINDING_MISMATCH', 403);
  }
}

function orderAssignedToActor(row, authUser) {
  const data = isPlainObject(row?.data) ? row.data : {};
  const aliases = new Set(actorAliases(authUser).map((value) => String(value).toLowerCase()));
  return [
    data.transport_create_actor_id,
    data.queued_actor_id,
    data.transport_id,
    data.transport_user_id,
    data.assigned_driver_id,
    data.transport_pin,
    data.driver_pin,
  ].some((value) => aliases.has(String(value || '').trim().toLowerCase()));
}

function requestCode(body, data) {
  return normalizeTransportTCodeServer(
    body?.code_str
    || body?.client_tcode
    || body?.order_code
    || data?.code_str
    || data?.order_code
    || data?.order_tcode
    || data?.client_tcode
    || '',
  );
}

function requestOfflineLeaseCandidates(body, data) {
  const lifecycle = isPlainObject(data?.pranimi_code_lifecycle) ? data.pranimi_code_lifecycle : {};
  const values = [
    body?.offline_code_lease,
    data?.offline_code_lease,
    lifecycle?.offline_code_lease,
  ].filter((value) => value != null);
  if (values.some((value) => !isPlainObject(value))) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_INVALID', 400);
  }
  return values;
}

function normalizeRequestedOfflineLease(raw, { orderId, requestedCode, authUser }) {
  const scope = String(raw?.scope || '').trim().toLowerCase();
  const code = normalizeTransportTCodeServer(raw?.code || '');
  const leaseToken = cleanUuid(raw?.lease_token || raw?.token);
  const ownerId = cleanText(raw?.owner_id || raw?.reserved_by, 160);
  const deviceId = cleanText(raw?.device_id, 160);
  const draftSessionId = cleanUuid(raw?.draft_session_id || raw?.draft_id);
  if (scope !== 'transport' || !code || !leaseToken || !ownerId || !deviceId || !draftSessionId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_INVALID', 400);
  }
  if (!requestedCode || code !== requestedCode) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_CODE_MISMATCH', 409);
  }
  if (!actorAliases(authUser).includes(ownerId)) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_OWNER_MISMATCH', 403);
  }
  if (!authUser?.deviceId || deviceId !== authUser.deviceId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DEVICE_MISMATCH', 403);
  }
  if (draftSessionId !== orderId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DRAFT_MISMATCH', 409);
  }
  return {
    scope: 'transport',
    code,
    leaseToken,
    ownerId,
    deviceId,
    draftSessionId,
  };
}

async function fetchOfflineLeaseRow(supabase, leaseToken) {
  const { data, error } = await supabase
    .from('offline_code_leases')
    .select('lease_token,scope,code,owner_id,device_id,draft_session_id,status,expires_at,order_id')
    .eq('lease_token', leaseToken)
    .maybeSingle();
  if (error) fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_LOOKUP_FAILED', 503);
  return data || null;
}

function verifyOfflineLeaseRow(row, expected, { allowFinalized = false } = {}) {
  if (!row || cleanUuid(row.lease_token) !== expected.leaseToken) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_NOT_FOUND', 409);
  }
  const rowScope = String(row.scope || '').trim().toLowerCase();
  const rowCode = normalizeTransportTCodeServer(row.code || '');
  const rowOwner = String(row.owner_id || '').trim();
  const rowDevice = String(row.device_id || '').trim();
  const rowDraft = cleanUuid(row.draft_session_id || '');
  const rowOrder = cleanUuid(row.order_id || '');
  const status = String(row.status || '').trim().toLowerCase();
  if (rowScope !== 'transport' || rowCode !== expected.code) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_CODE_MISMATCH', 409);
  }
  if (rowOwner !== expected.ownerId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_OWNER_MISMATCH', 403);
  }
  if (rowDevice !== expected.deviceId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DEVICE_MISMATCH', 403);
  }
  if (rowDraft && rowDraft !== expected.draftSessionId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DRAFT_MISMATCH', 409);
  }

  const active = status === 'available' || status === 'assigned';
  const finalized = status === 'consumed' || status === 'released';
  if (active) {
    const expiresAtMs = Date.parse(String(row.expires_at || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_EXPIRED', 409);
    }
  } else if (!allowFinalized || !finalized || rowOrder !== expected.draftSessionId || rowDraft !== expected.draftSessionId) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_NOT_ACTIVE', 409, { leaseStatus: status || 'missing' });
  }

  return {
    ...expected,
    status,
    expiresAt: String(row.expires_at || ''),
    orderId: rowOrder,
    sanitized: {
      scope: 'transport',
      code: expected.code,
      owner_id: expected.ownerId,
      device_id: expected.deviceId,
      lease_token: expected.leaseToken,
      draft_session_id: expected.draftSessionId,
    },
  };
}

async function resolveValidatedOfflineLease(
  supabase,
  candidates,
  expected,
  { allowFinalized = false } = {},
) {
  if (!candidates.length) return null;
  const normalized = candidates.map((raw) => normalizeRequestedOfflineLease(raw, expected));
  const first = normalized[0];
  const identity = stableJson(first);
  if (normalized.some((candidate) => stableJson(candidate) !== identity)) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_DUPLICATE_CONFLICT', 409);
  }
  const row = await fetchOfflineLeaseRow(supabase, first.leaseToken);
  return verifyOfflineLeaseRow(row, first, { allowFinalized });
}

function offlineLeaseResultFromRow(row, expected, finalCode) {
  const verified = verifyOfflineLeaseRow(row, expected, { allowFinalized: true });
  const finalTcode = normalizeTransportTCodeServer(finalCode || '');
  if (verified.status === 'consumed' && finalTcode !== verified.code) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_FINAL_CODE_MISMATCH', 503);
  }
  if (verified.status === 'released' && (!finalTcode || finalTcode === verified.code)) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_RELEASE_NOT_VERIFIED', 503);
  }
  if (!['consumed', 'released'].includes(verified.status)) {
    fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_NOT_FINALIZED', 503);
  }
  return {
    ok: true,
    finalized: true,
    status: verified.status,
    code: verified.code,
    final_code: finalTcode,
    lease_token: verified.leaseToken,
    draft_session_id: verified.draftSessionId,
    order_id: verified.draftSessionId,
    released: verified.status === 'released',
    consumed: verified.status === 'consumed',
  };
}

async function finalizeOfflineLeaseForExistingOrder(supabase, lease, finalCode) {
  if (!lease) return null;
  if (!['consumed', 'released'].includes(lease.status)) {
    const { data, error } = await supabase.rpc('finalize_transport_offline_code', {
      p_owner_id: lease.ownerId,
      p_device_id: lease.deviceId,
      p_code: lease.code,
      p_lease_token: lease.leaseToken,
      p_draft_session_id: lease.draftSessionId,
      p_order_id: lease.draftSessionId,
    });
    if (error) fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_FINALIZE_FAILED', 503);
    const result = normalizeRpcResult(data);
    if (!result || result.ok !== true) {
      fail('TRANSPORT_SELF_ENTRY_OFFLINE_LEASE_FINALIZE_REJECTED', 409, {
        leaseReason: cleanText(result?.reason || result?.error || '', 160),
      });
    }
  }
  const row = await fetchOfflineLeaseRow(supabase, lease.leaseToken);
  return offlineLeaseResultFromRow(row, lease, finalCode);
}

async function resolveOwnedPoolClaim(supabase, code, authUser) {
  if (!code) return null;
  const { data, error } = await supabase
    .from('transport_code_pool')
    .select('code,status,owner_id')
    .eq('code', code)
    .maybeSingle();
  if (error) fail('TRANSPORT_SELF_ENTRY_CODE_CLAIM_LOOKUP_FAILED', 503);
  const owner = String(data?.owner_id || '').trim();
  if (String(data?.status || '').toLowerCase() !== 'used' || !actorAliases(authUser).includes(owner)) return null;
  return { code, owner };
}

async function fetchExactOrder(supabase, orderId) {
  const { data, error } = await supabase
    .from('transport_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (error) fail('TRANSPORT_SELF_ENTRY_ORDER_LOOKUP_FAILED', 503);
  return data || null;
}

function verifyOrder(row, expected, { allowLegacyFingerprint = false, verifyBusiness = true } = {}) {
  if (!row || String(row.id || '').toLowerCase() !== expected.orderId) {
    fail('TRANSPORT_SELF_ENTRY_ORDER_NOT_FOUND_AFTER_RPC', 503);
  }
  const data = isPlainObject(row.data) ? row.data : {};
  const phone = normalizeTransportPhoneKeyServer(row.client_phone || data.client_phone || data?.client?.phone || '');
  if (phone !== expected.phoneKey) fail('TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT', 409);
  if (!orderAssignedToActor(row, expected.authUser)) fail('TRANSPORT_SELF_ENTRY_ACTOR_MISMATCH', 403);
  if (!String(row.client_id || '').trim() || !(Number(row.visit_nr) > 0)) {
    fail('TRANSPORT_SELF_ENTRY_VERIFY_CLIENT_LINK_MISSING', 503);
  }
  const clientTcode = normalizeTransportTCodeServer(
    row.client_tcode || data.transport_client_tcode || data.client_tcode || data?.client?.tcode || '',
  );
  const publicCode = normalizeTransportTCodeServer(row.code_str || data.code_str || data.order_code || '');
  if (!clientTcode || publicCode !== clientTcode) fail('TRANSPORT_SELF_ENTRY_VERIFY_TCODE_MISMATCH', 503);
  if (String(row.status || '').toLowerCase() !== 'pickup' || String(data.status || '').toLowerCase() !== 'pickup') {
    fail('TRANSPORT_SELF_ENTRY_VERIFY_STATUS_MISMATCH', 503);
  }
  const fingerprint = String(row.transport_create_fingerprint_v1 || data.transport_create_fingerprint_v1 || '').toLowerCase();
  if (!allowLegacyFingerprint && fingerprint !== expected.fingerprint) {
    fail('TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT', 409);
  }
  if (!allowLegacyFingerprint && verifyBusiness) {
    for (const [key, value] of Object.entries(expected.business)) {
      if (key === 'location_gps_explicit') continue;
      if (stableJson(data[key]) !== stableJson(value)) {
        fail(`TRANSPORT_SELF_ENTRY_VERIFY_${key.toUpperCase()}_MISMATCH`, 503);
      }
    }
  }
  return { row, clientTcode };
}

export async function authenticateTransportSelfEntryActor(supabase, deviceIdLike) {
  if (!supabase) fail('SERVER_NOT_CONFIGURED', 500);
  const deviceId = String(deviceIdLike || '').trim().slice(0, 120);
  if (!deviceId) fail('AUTH_REQUIRED', 401);
  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) fail('AUTH_DEVICE_LOOKUP_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,is_hybrid_transport,transport_id,tid')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) fail('AUTH_USER_LOOKUP_FAILED', 503);
  const actualRole = String(user?.role || '').trim().toUpperCase();
  const hybrid = user?.is_hybrid_transport === true;
  const id = cleanUuid(user?.id);
  const pin = String(user?.pin || '').trim();
  if (!user || user.is_active === false || !id || !PIN_RE.test(pin)) fail('AUTH_USER_DISABLED', 403);
  if (actualRole !== 'TRANSPORT' && !(actualRole === 'PUNTOR' && hybrid)) {
    fail('TRANSPORT_SELF_ENTRY_ACTOR_NOT_ALLOWED', 403);
  }
  return {
    id,
    pin,
    name: cleanText(user.name || actualRole, 160),
    role: 'TRANSPORT',
    actualRole,
    isHybridTransport: hybrid,
    deviceId,
    transportId: String(user.transport_id || '').trim(),
    tid: String(user.tid || '').trim(),
  };
}

export async function createTransportSelfEntryOrderServer(bodyLike, { supabase, authUser } = {}) {
  if (!supabase || !authUser?.id || !authUser?.pin || authUser?.role !== 'TRANSPORT') fail('AUTH_REQUIRED', 401);
  const body = isPlainObject(bodyLike) ? bodyLike : {};
  const orderId = cleanUuid(body.id || body.order_id || body.orderId);
  if (!orderId) fail('TRANSPORT_SELF_ENTRY_UUID_INVALID', 400);
  const requestData = isPlainObject(body.data) ? body.data : {};
  requireActorBinding(body, requestData, authUser);
  const requestClient = isPlainObject(requestData.client) ? requestData.client : {};
  const name = cleanText(body.client_name || body.clientName || requestClient.name || requestData.client_name, 160);
  const phone = cleanText(body.client_phone || body.clientPhone || requestClient.phone || requestData.client_phone, 80);
  const phoneKey = normalizeTransportPhoneKeyServer(phone);
  const address = cleanText(body.address || requestClient.address || requestData.address, 1000);
  const gpsLat = cleanCoordinate(body.gps_lat ?? requestData.gps_lat ?? requestClient.gps_lat ?? requestClient?.gps?.lat, 'lat');
  const gpsLng = cleanCoordinate(body.gps_lng ?? requestData.gps_lng ?? requestClient.gps_lng ?? requestClient?.gps?.lng, 'lng');
  if (!name) fail('TRANSPORT_CLIENT_NAME_REQUIRED', 400);
  if (!isValidTransportPhoneServer(phoneKey)) fail('TRANSPORT_PHONE_INVALID', 400);

  const business = normalizeTransportPranimiBusinessData(requestData);
  const requestedCode = requestCode(body, requestData);
  const offlineLeaseCandidates = requestOfflineLeaseCandidates(body, requestData);
  const fingerprintInput = {
    version: 1,
    action: 'create',
    order_id: orderId,
    actor_id: authUser.id,
    client: { name, phone: phoneKey, address, gps_lat: gpsLat, gps_lng: gpsLng },
    status: 'pickup',
    business,
  };
  // T-code reservations and offline lease tokens are delivery metadata. They
  // may legitimately change between a timed-out create and its retry, while the
  // canonical client + measurements + payment payload remains the same.
  const fingerprint = createHash('sha256')
    .update(stableJson(boundedJsonValue(fingerprintInput)), 'utf8')
    .digest('hex');

  const existing = await fetchExactOrder(supabase, orderId);
  if (existing) {
    const verified = verifyOrder(existing, {
      orderId,
      phoneKey,
      authUser,
      fingerprint,
      business,
    });
    const offlineLease = await resolveValidatedOfflineLease(
      supabase,
      offlineLeaseCandidates,
      { orderId, requestedCode, authUser },
      { allowFinalized: true },
    );
    const offlineLeaseResult = await finalizeOfflineLeaseForExistingOrder(
      supabase,
      offlineLease,
      verified.clientTcode,
    );
    return {
      ok: true,
      data: verified.row,
      idempotent: true,
      fingerprint,
      ...(offlineLeaseResult ? { offlineLeaseResult } : {}),
    };
  }

  let offlineLease = await resolveValidatedOfflineLease(
    supabase,
    offlineLeaseCandidates,
    { orderId, requestedCode, authUser },
  );
  const suppliedClaim = await resolveOwnedPoolClaim(supabase, requestedCode, authUser);
  if (offlineLease && (!suppliedClaim
    || suppliedClaim.code !== offlineLease.code
    || suppliedClaim.owner !== offlineLease.ownerId)) {
    fail('TRANSPORT_SUPPLIED_TCODE_CLAIM_INVALID', 409);
  }
  const nowIso = new Date().toISOString();
  const photoUrl = cleanText(requestClient.photoUrl || requestClient.photo_url || '', 4000);
  const safeData = {
    ...business,
    order_id: orderId,
    public_order_id: orderId,
    client_id: null,
    client_name: name,
    client_phone: phone,
    phone_digits: phoneKey,
    address,
    gps_lat: gpsLat,
    gps_lng: gpsLng,
    status: 'pickup',
    client: {
      ...(photoUrl ? { photoUrl } : {}),
      id: null,
      name,
      phone,
      phone_digits: phoneKey,
      address,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      gps: gpsLat != null && gpsLng != null ? { lat: Number(gpsLat), lng: Number(gpsLng) } : null,
    },
    created_by: 'TRANSPORT',
    created_by_role: 'TRANSPORT',
    created_by_pin: authUser.pin,
    created_by_name: authUser.name,
    brought_by_pin: authUser.pin,
    brought_by_name: authUser.name,
    transport_create_actor_id: authUser.id,
    queued_actor_id: authUser.id,
    code_owner: suppliedClaim?.owner || authUser.pin,
    transport_tcode_allocation_mode: 'ATOMIC_DB',
    order_origin: 'TRANSPORT_SELF_ENTRY',
    source: 'transport_self_entry',
    transport_create_fingerprint_v1: fingerprint,
    transport_id: authUser.id,
    transport_user_id: authUser.id,
    assigned_driver_id: authUser.id,
    transport_name: authUser.name,
    transport_pin: authUser.pin,
    actor: authUser.name || authUser.pin,
    driver_name: authUser.name,
    driver_pin: authUser.pin,
    assigned_at: nowIso,
    ...(offlineLease ? { offline_code_lease: offlineLease.sanitized } : {}),
  };

  const rpc = await supabase.rpc('create_transport_order', {
    p_id: orderId,
    p_code_n: suppliedClaim ? Number(suppliedClaim.code.replace(/\D+/g, '')) : null,
    p_code_str: suppliedClaim?.code || null,
    p_client_name: name,
    p_client_phone: phone,
    p_address: address,
    p_gps_lat: gpsLat,
    p_gps_lng: gpsLng,
    p_data: safeData,
    p_status: 'pickup',
  });
  if (rpc?.error) {
    const code = rpcErrorCode(rpc.error);
    if (code.includes('IDEMPOTENCY') || code === 'TRANSPORT_PHONE_IDENTITY_CONFLICT') fail(code, 409);
    if (code) fail(code, code.includes('SERVICE_ROLE') ? 403 : 400);
    fail('TRANSPORT_SELF_ENTRY_RPC_FAILED', 503);
  }
  const rpcResult = normalizeRpcResult(rpc?.data);
  if (!rpcResult || rpcResult.success !== true) {
    const code = cleanText(rpcResult?.error || rpcResult?.code || 'TRANSPORT_SELF_ENTRY_RPC_NOT_VERIFIED', 160).toUpperCase();
    if (code.includes('IDEMPOTENCY') || code === 'TRANSPORT_PHONE_IDENTITY_CONFLICT') fail(code, 409);
    fail(code || 'TRANSPORT_SELF_ENTRY_RPC_NOT_VERIFIED', 503);
  }

  const row = await fetchExactOrder(supabase, orderId);
  const verified = verifyOrder(row, { orderId, phoneKey, authUser, fingerprint, business });
  if (cleanUuid(rpcResult.order_id) !== orderId
    || cleanUuid(rpcResult.client_id) !== String(row?.client_id || '').toLowerCase()
    || normalizeTransportTCodeServer(rpcResult.client_tcode || rpcResult.code_str || '') !== verified.clientTcode
    || !(Number(rpcResult.visit_nr) > 0)) {
    fail('TRANSPORT_SELF_ENTRY_RPC_RESPONSE_MISMATCH', 503);
  }
  let offlineLeaseResult = null;
  if (offlineLease) {
    offlineLeaseResult = await finalizeOfflineLeaseForExistingOrder(
      supabase,
      offlineLease,
      verified.clientTcode,
    );
  }
  return {
    ok: true,
    data: verified.row,
    idempotent: rpcResult.idempotent === true,
    fingerprint,
    ...(offlineLeaseResult ? { offlineLeaseResult } : {}),
  };
}
