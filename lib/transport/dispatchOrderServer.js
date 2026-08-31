import { createHash } from 'node:crypto';
import { ADMIN_ROLES } from '../roles.js';
import {
  isValidTransportPhoneServer,
  normalizeTransportPhoneKeyServer,
  normalizeTransportTCodeServer,
} from './transportServer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN_RE = /^\d{3,12}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const DISPATCH_ORDER_ROLES = new Set(ADMIN_ROLES.map((role) => String(role || '').trim().toUpperCase()));
const ALLOWED_STATUSES = new Set(['INBOX', 'ASSIGNED']);
const BUSINESS_DATA_KEYS = Object.freeze([
  'note',
  'pickup_plan',
  'planned_tepiha',
  'planned_pieces',
  'planned_m2_total',
  'pickup_measurements_text',
  'pickup_date',
  'pickup_slot',
  'pickup_window',
  'planning_bucket',
  'location_gps_explicit',
  'pieces',
  'm2_total',
]);

export class DispatchOrderServerError extends Error {
  constructor(code, httpStatus = 400, extra = {}) {
    super(String(code || 'DISPATCH_ORDER_SERVER_FAILED'));
    this.name = 'DispatchOrderServerError';
    this.code = String(code || 'DISPATCH_ORDER_SERVER_FAILED');
    this.httpStatus = Number(httpStatus) || 400;
    this.extra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  }
}

function fail(code, httpStatus = 400, extra = {}) {
  throw new DispatchOrderServerError(code, httpStatus, extra);
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 4000) {
  return String(value || '').trim().replace(/\r\n?/g, '\n').slice(0, maxLength);
}

function cleanUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean.toLowerCase() : '';
}

function boundedJsonValue(value, depth = 0) {
  if (depth > 8) fail('DISPATCH_ORDER_DATA_TOO_DEEP', 400);
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 8000);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DISPATCH_ORDER_DATA_INVALID', 400);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) fail('DISPATCH_ORDER_DATA_TOO_LARGE', 413);
    return value.map((item) => boundedJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) fail('DISPATCH_ORDER_DATA_INVALID', 400);
  const entries = Object.entries(value);
  if (entries.length > 200) fail('DISPATCH_ORDER_DATA_TOO_LARGE', 413);
  const output = {};
  for (const [keyLike, nested] of entries) {
    const key = String(keyLike || '').trim();
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key.slice(0, 160)] = boundedJsonValue(nested, depth + 1);
  }
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cleanCoordinate(value, kind) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  const valid = Number.isFinite(number)
    && (kind === 'lat' ? number >= -90 && number <= 90 : number >= -180 && number <= 180);
  if (!valid) fail(kind === 'lat' ? 'DISPATCH_GPS_LAT_INVALID' : 'DISPATCH_GPS_LNG_INVALID', 400);
  return String(number);
}

function normalizeRpcResult(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current) && current.length === 1) {
      [current] = current;
      continue;
    }
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
        continue;
      } catch {
        return null;
      }
    }
    break;
  }
  return isPlainObject(current) ? current : null;
}

function rpcErrorCode(error) {
  const text = [error?.message, error?.details, error?.hint, error?.code]
    .map((value) => String(value || '').toUpperCase())
    .join(' ');
  const known = [
    'TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
    'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT',
    'TRANSPORT_PHONE_IDENTITY_CONFLICT',
    'TRANSPORT_ATOMIC_TCODE_SERVICE_ROLE_REQUIRED',
    'TRANSPORT_TCODE_REQUIRED_FOR_NEW_CLIENT',
    'TRANSPORT_CODE_PAIR_MISMATCH',
    'TRANSPORT_PHONE_INVALID',
  ];
  return known.find((code) => text.includes(code)) || '';
}

function businessDataFromRequest(data) {
  const raw = isPlainObject(data) ? data : {};
  const output = {};
  for (const key of BUSINESS_DATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    output[key] = boundedJsonValue(raw[key]);
  }
  if (Object.prototype.hasOwnProperty.call(output, 'note')) {
    output.note = cleanMultiline(output.note, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(output, 'pickup_measurements_text')) {
    output.pickup_measurements_text = cleanMultiline(output.pickup_measurements_text, 12000);
  }
  const size = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (size > 64 * 1024) fail('DISPATCH_ORDER_DATA_TOO_LARGE', 413);
  return output;
}

async function readTransportDriver(supabase, driverId) {
  if (!driverId) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,is_hybrid_transport')
    .eq('id', driverId)
    .maybeSingle();
  if (error) fail('DISPATCH_DRIVER_LOOKUP_FAILED', 503);
  const role = String(data?.role || '').trim().toUpperCase();
  const hybrid = data?.is_hybrid_transport === true || String(data?.is_hybrid_transport || '').toLowerCase() === 'true';
  if (!data || data.is_active === false || (role !== 'TRANSPORT' && !hybrid)) {
    fail('DISPATCH_DRIVER_NOT_AVAILABLE', 409);
  }
  const pin = String(data.pin || '').trim();
  if (!PIN_RE.test(pin)) fail('DISPATCH_DRIVER_IDENTITY_INVALID', 409);
  return {
    id: String(data.id),
    pin,
    name: cleanText(data.name || role || 'TRANSPORT', 160),
    role,
  };
}

async function fetchExactOrder(supabase, orderId) {
  const { data, error } = await supabase
    .from('transport_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (error) fail('DISPATCH_ORDER_VERIFY_FAILED', 503);
  return data || null;
}

function verifyDispatchOrder(row, expected) {
  if (!row || String(row.id || '').toLowerCase() !== expected.orderId) {
    fail('DISPATCH_ORDER_NOT_FOUND_AFTER_RPC', 503);
  }
  const data = isPlainObject(row.data) ? row.data : {};
  const rowPhone = normalizeTransportPhoneKeyServer(
    row.client_phone || data.client_phone || data?.client?.phone || '',
  );
  if (!rowPhone || rowPhone !== expected.phoneKey) fail('TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT', 409);
  if (!String(row.client_id || '').trim()) fail('DISPATCH_ORDER_VERIFY_CLIENT_ID_MISSING', 503);
  if (!(Number(row.visit_nr) > 0)) fail('DISPATCH_ORDER_VERIFY_VISIT_NR_MISSING', 503);

  const clientTcode = normalizeTransportTCodeServer(
    row.client_tcode || data.transport_client_tcode || data.client_tcode || data?.client?.transport_client_tcode || data?.client?.tcode || '',
  );
  const publicCode = normalizeTransportTCodeServer(row.code_str || data.code_str || data.order_code || '');
  if (!clientTcode || !publicCode || clientTcode !== publicCode) {
    fail('DISPATCH_ORDER_VERIFY_TCODE_MISMATCH', 503);
  }
  const columnFingerprint = String(row.transport_create_fingerprint_v1 || '').trim().toLowerCase();
  const dataFingerprint = String(data.transport_create_fingerprint_v1 || '').trim().toLowerCase();
  if (!FINGERPRINT_RE.test(columnFingerprint)
    || !FINGERPRINT_RE.test(dataFingerprint)
    || columnFingerprint !== expected.fingerprint
    || dataFingerprint !== expected.fingerprint) {
    fail('DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT', 409);
  }
  if (String(data.transport_create_actor_id || '') !== expected.actorId
    || String(data.created_by_role || '').toUpperCase() !== 'DISPATCH'
    || String(data.transport_tcode_allocation_mode || '').toUpperCase() !== 'ATOMIC_DB') {
    fail('DISPATCH_ORDER_VERIFY_ACTOR_MISMATCH', 409);
  }
  return { row, clientTcode };
}

export async function authenticateDispatchOrderActor(supabase, deviceIdLike) {
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
    .select('id,pin,name,role,is_active')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) fail('AUTH_USER_LOOKUP_FAILED', 503);
  const role = String(user?.role || '').trim().toUpperCase();
  const pin = String(user?.pin || '').trim();
  if (!user || user.is_active === false || !PIN_RE.test(pin)) fail('AUTH_USER_DISABLED', 403);
  if (!DISPATCH_ORDER_ROLES.has(role)) fail('DISPATCH_ORDER_ACTOR_NOT_ALLOWED', 403);
  return {
    id: String(user.id),
    pin,
    name: cleanText(user.name || role, 160),
    role,
    deviceId,
  };
}

export function buildDispatchOrderFingerprint(canonicalInput) {
  const json = stableJson(boundedJsonValue(canonicalInput));
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export async function createDispatchTransportOrderServer(bodyLike, { supabase, authUser } = {}) {
  if (!supabase || !authUser?.id || !authUser?.pin) fail('AUTH_REQUIRED', 401);
  const actorRole = String(authUser.role || '').trim().toUpperCase();
  if (!DISPATCH_ORDER_ROLES.has(actorRole)) fail('DISPATCH_ORDER_ACTOR_NOT_ALLOWED', 403);

  const body = isPlainObject(bodyLike) ? bodyLike : {};
  const orderId = cleanUuid(body.id || body.order_id || body.orderId);
  if (!orderId) fail('DISPATCH_ORDER_UUID_INVALID', 400);
  const requestData = isPlainObject(body.data) ? body.data : {};
  const requestClient = isPlainObject(requestData.client) ? requestData.client : {};
  const name = cleanText(body.client_name || body.clientName || requestClient.name || requestData.client_name, 160);
  const phone = cleanText(body.client_phone || body.clientPhone || requestClient.phone || requestData.client_phone, 80);
  const phoneKey = normalizeTransportPhoneKeyServer(phone);
  const address = cleanText(body.address || requestClient.address || requestData.address, 1000);
  const gpsLat = cleanCoordinate(body.gps_lat ?? requestData.gps_lat ?? requestClient.gps_lat ?? requestClient?.gps?.lat, 'lat');
  const gpsLng = cleanCoordinate(body.gps_lng ?? requestData.gps_lng ?? requestClient.gps_lng ?? requestClient?.gps?.lng, 'lng');
  const status = String(body.status || requestData.status || 'inbox').trim().toUpperCase();
  const driverIdRaw = body.transport_id ?? body.transportId ?? requestData.transport_id ?? requestData.transport_user_id ?? null;
  const driverId = driverIdRaw == null || String(driverIdRaw).trim() === '' ? '' : cleanUuid(driverIdRaw);

  if (!name) fail('TRANSPORT_CLIENT_NAME_REQUIRED', 400);
  if (!isValidTransportPhoneServer(phoneKey)) fail('TRANSPORT_PHONE_INVALID', 400);
  if (!ALLOWED_STATUSES.has(status)) fail('DISPATCH_ORDER_STATUS_INVALID', 400);
  if (driverIdRaw != null && String(driverIdRaw).trim() && !driverId) fail('DISPATCH_DRIVER_ID_INVALID', 400);
  if (status === 'ASSIGNED' && !driverId) fail('DISPATCH_ASSIGNED_DRIVER_REQUIRED', 400);
  if (status === 'INBOX' && driverId) fail('DISPATCH_INBOX_DRIVER_CONFLICT', 400);

  const businessData = businessDataFromRequest(requestData);
  const canonicalFingerprintInput = {
    version: 1,
    order_id: orderId,
    actor: {
      id: String(authUser.id),
    },
    client: {
      name,
      phone: phoneKey,
      address,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
    },
    status: status.toLowerCase(),
    driver_id: driverId || null,
    business: businessData,
  };
  const fingerprint = buildDispatchOrderFingerprint(canonicalFingerprintInput);

  const existing = await fetchExactOrder(supabase, orderId);
  if (existing) {
    const verified = verifyDispatchOrder(existing, {
      orderId,
      phoneKey,
      fingerprint,
      actorId: String(authUser.id),
    });
    return { ok: true, data: verified.row, idempotent: true, fingerprint };
  }

  // Live driver eligibility applies only to a new write. A committed request
  // must remain retryable with the same UUID/fingerprint even if that driver is
  // disabled, removed or changes role after the original transaction commits.
  const driver = await readTransportDriver(supabase, driverId);

  const nowIso = new Date().toISOString();
  const safeData = {
    ...businessData,
    order_id: orderId,
    public_order_id: orderId,
    client_id: null,
    client_name: name,
    client_phone: phone,
    phone_digits: phoneKey,
    address,
    gps_lat: gpsLat,
    gps_lng: gpsLng,
    status: status.toLowerCase(),
    client: {
      id: null,
      name,
      phone,
      phone_digits: phoneKey,
      address,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      gps: gpsLat != null && gpsLng != null ? { lat: Number(gpsLat), lng: Number(gpsLng) } : null,
    },
    created_by: 'DISPATCH',
    created_by_role: 'DISPATCH',
    created_by_pin: String(authUser.pin),
    created_by_name: cleanText(authUser.name || actorRole, 160),
    transport_create_actor_id: String(authUser.id),
    code_owner: String(authUser.pin),
    transport_tcode_allocation_mode: 'ATOMIC_DB',
    order_origin: 'DISPATCH',
    source: 'phone',
    transport_create_fingerprint_v1: fingerprint,
    transport_id: driver?.id || null,
    transport_user_id: driver?.id || null,
    transport_name: driver?.name || null,
    transport_pin: driver?.pin || null,
    actor: driver?.name || driver?.pin || null,
    driver_name: driver?.name || null,
    driver_pin: driver?.pin || null,
    assigned_driver_id: driver?.id || null,
    assigned_at: driver ? nowIso : null,
  };

  const rpc = await supabase.rpc('create_transport_order', {
    p_id: orderId,
    p_code_n: null,
    p_code_str: null,
    p_client_name: name,
    p_client_phone: phone,
    p_address: address,
    p_gps_lat: gpsLat,
    p_gps_lng: gpsLng,
    p_data: safeData,
    p_status: status.toLowerCase(),
  });
  if (rpc?.error) {
    const code = rpcErrorCode(rpc.error);
    if (code.includes('IDEMPOTENCY') || code === 'TRANSPORT_PHONE_IDENTITY_CONFLICT') fail(code, 409);
    if (code) fail(code, code === 'TRANSPORT_ATOMIC_TCODE_SERVICE_ROLE_REQUIRED' ? 403 : 400);
    fail('DISPATCH_ORDER_RPC_FAILED', 503);
  }

  const rpcResult = normalizeRpcResult(rpc?.data);
  if (!rpcResult || rpcResult.success !== true) {
    const code = cleanText(rpcResult?.error || rpcResult?.code || 'DISPATCH_ORDER_RPC_NOT_VERIFIED', 160).toUpperCase();
    if (code.includes('IDEMPOTENCY') || code === 'TRANSPORT_PHONE_IDENTITY_CONFLICT') fail(code, 409);
    fail(code || 'DISPATCH_ORDER_RPC_NOT_VERIFIED', 503);
  }

  const row = await fetchExactOrder(supabase, orderId);
  const verified = verifyDispatchOrder(row, {
    orderId,
    phoneKey,
    fingerprint,
    actorId: String(authUser.id),
  });
  const rpcOrderId = cleanUuid(rpcResult.order_id);
  const rpcClientId = cleanUuid(rpcResult.client_id);
  const rpcCode = normalizeTransportTCodeServer(rpcResult.client_tcode || rpcResult.code_str || '');
  if (rpcOrderId !== orderId
    || !rpcClientId
    || rpcClientId !== String(verified.row.client_id || '').toLowerCase()
    || !rpcCode
    || rpcCode !== verified.clientTcode
    || !(Number(rpcResult.visit_nr) > 0)) {
    fail('DISPATCH_ORDER_RPC_RESPONSE_MISMATCH', 503);
  }

  return {
    ok: true,
    data: verified.row,
    idempotent: rpcResult.idempotent === true,
    fingerprint,
  };
}
