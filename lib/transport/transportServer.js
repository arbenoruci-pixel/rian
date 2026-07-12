import { randomUUID } from 'node:crypto';
import {
  isValidTransportPhoneDigits,
  normalizeTransportPhoneKey,
  transportPhoneDigitVariants,
} from './phone.js';

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

export const normalizeTransportPhoneKeyServer = normalizeTransportPhoneKey;
export const isValidTransportPhoneServer = isValidTransportPhoneDigits;

export function normalizeTransportTCodeServer(value) {
  const digits = onlyDigits(value).replace(/^0+/, '');
  return digits ? `T${digits}` : '';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function phoneVariants(value) {
  return transportPhoneDigitVariants(value);
}

function normalizeRpcCodeList(data) {
  let raw = data;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = [raw]; }
  }
  if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
  return Array.from(new Set(raw.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return normalizeTransportTCodeServer(item);
    if (item && typeof item === 'object') {
      return normalizeTransportTCodeServer(item.code || item.code_str || item.code_n || item.transport_code);
    }
    return '';
  }).filter(Boolean))).sort((a, b) => Number(onlyDigits(a)) - Number(onlyDigits(b)));
}

function errorText(error, fallback = 'TRANSPORT_SERVER_ERROR') {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(' | ');
  return text || String(error || fallback);
}

export async function findTransportClientByPhoneServer(supabase, phone) {
  if (!supabase) throw new Error('TRANSPORT_SUPABASE_CLIENT_REQUIRED');
  const key = normalizeTransportPhoneKeyServer(phone);
  if (!isValidTransportPhoneServer(key)) throw new Error('TRANSPORT_PHONE_INVALID');

  const clientRows = [];
  const seenClientIds = new Set();
  const addClient = (row) => {
    if (!row?.id) return;
    const rowKey = normalizeTransportPhoneKeyServer(row?.phone_digits || row?.phone || '');
    if (rowKey !== key) return;
    const tcode = normalizeTransportTCodeServer(row?.tcode);
    if (!tcode) throw new Error(`TRANSPORT_CLIENT_TCODE_MISSING:${row.id}`);
    const id = String(row.id);
    if (seenClientIds.has(id)) return;
    seenClientIds.add(id);
    clientRows.push({ ...row, tcode, source: 'transport_clients' });
  };

  const variants = phoneVariants(phone);
  const direct = await supabase
    .from('transport_clients')
    .select('id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,created_at,updated_at')
    .in('phone_digits', variants)
    .limit(20);
  if (direct?.error) throw new Error(`TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED: ${errorText(direct.error)}`);
  (Array.isArray(direct?.data) ? direct.data : []).forEach(addClient);

  // Exact normalized fallback for historical formatting variants. The table is small and
  // the comparison is strict after normalization, so this cannot match another phone.
  if (!clientRows.length) {
    const fallback = await supabase
      .from('transport_clients')
      .select('id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,created_at,updated_at')
      .limit(5000);
    if (fallback?.error) throw new Error(`TRANSPORT_CLIENT_PHONE_FALLBACK_FAILED: ${errorText(fallback.error)}`);
    (Array.isArray(fallback?.data) ? fallback.data : []).forEach(addClient);
  }

  const clientTcodes = new Set(clientRows.map((row) => row.tcode).filter(Boolean));
  if (clientRows.length > 1 || clientTcodes.size > 1) {
    throw new Error(`TRANSPORT_DUPLICATE_PHONE_IDENTITY:${key}:${clientRows.map((row) => row.id).join(',')}:${Array.from(clientTcodes).join(',')}`);
  }
  if (clientRows[0]) return clientRows[0];

  // A small number of historical orders may predate transport_clients. Reuse their
  // T-code only when every row for the normalized phone agrees on exactly one code.
  const orderRows = [];
  const seenOrderIds = new Set();
  const addOrder = (row) => {
    if (!row?.id) return;
    const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    const client = data?.client && typeof data.client === 'object' && !Array.isArray(data.client) ? data.client : {};
    const rowPhone = row?.client_phone || data?.client_phone || client?.phone || '';
    if (normalizeTransportPhoneKeyServer(rowPhone) !== key) return;
    const tcode = normalizeTransportTCodeServer(
      data?.transport_client_tcode ||
      client?.transport_client_tcode ||
      data?.client_tcode ||
      client?.client_tcode ||
      client?.tcode ||
      client?.code ||
      row?.client_tcode ||
      row?.code_str ||
      '',
    );
    if (!tcode) throw new Error(`TRANSPORT_HISTORICAL_TCODE_MISSING:${row.id}`);
    const id = String(row.id);
    if (seenOrderIds.has(id)) return;
    seenOrderIds.add(id);
    orderRows.push({
      id: row?.client_id || data?.client_id || client?.id || null,
      row_id: row.id,
      tcode,
      name: row?.client_name || data?.client_name || client?.name || '',
      phone: rowPhone,
      phone_digits: onlyDigits(rowPhone),
      address: data?.address || client?.address || '',
      gps_lat: data?.gps_lat ?? client?.gps_lat ?? client?.gps?.lat ?? null,
      gps_lng: data?.gps_lng ?? client?.gps_lng ?? client?.gps?.lng ?? null,
      created_at: row?.created_at || '',
      updated_at: row?.updated_at || row?.created_at || '',
      source: 'transport_orders',
      historical_order_only: true,
    });
  };

  const exactOrders = await supabase
    .from('transport_orders')
    .select('id,client_id,client_tcode,code_str,client_name,client_phone,data,created_at,updated_at')
    .in('client_phone', variants)
    .limit(100);
  if (exactOrders?.error) throw new Error(`TRANSPORT_ORDER_PHONE_LOOKUP_FAILED: ${errorText(exactOrders.error)}`);
  (Array.isArray(exactOrders?.data) ? exactOrders.data : []).forEach(addOrder);

  // Always inspect the complete small historical order set. A matching exact-format
  // row cannot prove uniqueness when another formatting variant may carry another T-code.
  const historical = await supabase
    .from('transport_orders')
    .select('id,client_id,client_tcode,code_str,client_name,client_phone,data,created_at,updated_at')
    .limit(5000);
  if (historical?.error) throw new Error(`TRANSPORT_ORDER_PHONE_HISTORY_LOOKUP_FAILED: ${errorText(historical.error)}`);
  (Array.isArray(historical?.data) ? historical.data : []).forEach(addOrder);

  if (!orderRows.length) return null;
  const orderTcodes = new Set(orderRows.map((row) => row.tcode).filter(Boolean));
  const historicalClientIds = new Set(orderRows.map((row) => String(row.id || '').trim()).filter(Boolean));
  if (orderTcodes.size !== 1 || historicalClientIds.size > 1) {
    throw new Error(`TRANSPORT_HISTORICAL_PHONE_TCODE_CONFLICT:${key}:clients=${Array.from(historicalClientIds).join(',') || '-'}:tcodes=${Array.from(orderTcodes).join(',') || '-'}`);
  }

  orderRows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return orderRows[0];
}

export async function reserveSmallestTransportTCodeServer(supabase, owner = 'ONLINE_BOOKING') {
  const cleanOwner = String(owner || '').trim() || 'ONLINE_BOOKING';
  const { data, error } = await supabase.rpc('reserve_transport_codes_batch', {
    p_owner_id: cleanOwner,
    p_n: 1,
  });
  if (error) throw new Error(`TRANSPORT_CODE_RESERVE_FAILED: ${errorText(error)}`);
  const code = normalizeRpcCodeList(data)[0] || '';
  if (!code) throw new Error('TRANSPORT_CODE_RESERVE_EMPTY');
  return code;
}

export async function releaseTransportTCodeServer(supabase, code, owner = '') {
  const normalized = normalizeTransportTCodeServer(code);
  if (!normalized) return false;
  try {
    const { data, error } = await supabase.rpc('release_transport_code_if_unused', {
      p_code: normalized,
      p_owner_id: String(owner || '').trim() || null,
    });
    if (error) throw error;
    return data === true;
  } catch {
    return false;
  }
}

async function fetchExactTransportOrderServer(supabase, orderId) {
  const { data, error } = await supabase
    .from('transport_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw new Error(`TRANSPORT_ORDER_VERIFY_FAILED: ${errorText(error)}`);
  return data || null;
}

function assertServerTransportOrder(row, { orderId, phone, permanentTcode }) {
  if (!row || String(row.id || '') !== String(orderId || '')) throw new Error('TRANSPORT_ORDER_ID_MISMATCH');
  if (!row.client_id) throw new Error('TRANSPORT_ORDER_CLIENT_ID_MISSING');
  const rowPhone = normalizeTransportPhoneKeyServer(row.client_phone || row?.data?.client_phone || row?.data?.client?.phone || '');
  const wantedPhone = normalizeTransportPhoneKeyServer(phone);
  if (!rowPhone || rowPhone !== wantedPhone) throw new Error('TRANSPORT_ORDER_PHONE_MISMATCH');
  const rowTcode = normalizeTransportTCodeServer(row.client_tcode || row?.data?.transport_client_tcode || row?.data?.client?.tcode || '');
  const rowCode = normalizeTransportTCodeServer(row.code_str || row?.data?.code_str || '');
  const wantedTcode = normalizeTransportTCodeServer(permanentTcode);
  if (!rowTcode || rowTcode !== wantedTcode) throw new Error(`TRANSPORT_ORDER_CLIENT_TCODE_MISMATCH:${rowTcode}:${wantedTcode}`);
  if (!rowCode || rowCode !== wantedTcode) throw new Error(`TRANSPORT_ORDER_CODE_MISMATCH:${rowCode}:${wantedTcode}`);
  if (!(Number(row.visit_nr) > 0)) throw new Error('TRANSPORT_ORDER_VISIT_NR_MISSING');
  const dataOrderId = String(row?.data?.order_id || row?.data?.public_order_id || '').trim();
  if (dataOrderId && dataOrderId !== String(orderId)) throw new Error('TRANSPORT_ORDER_DATA_UUID_MISMATCH');
  return row;
}

/**
 * Creates one Transport order with the production DB transaction.
 * - Existing phone: reuse transport_clients.tcode and consume no code.
 * - New phone: reserve exactly one smallest available T-code.
 * - Race-safe: if another request creates the phone first, reconcile code_str to the
 *   permanent client T-code and release the now-unused temporary code.
 */
export async function createTransportOrderAtomicServer(supabase, input = {}) {
  if (!supabase) throw new Error('TRANSPORT_SUPABASE_CLIENT_REQUIRED');
  const orderId = isUuid(input?.id) ? String(input.id) : randomUUID();
  const name = String(input?.client_name || input?.name || '').trim();
  const phone = String(input?.client_phone || input?.phone || '').trim();
  const address = String(input?.address || input?.data?.address || input?.data?.client?.address || '').trim();
  const owner = String(input?.owner || input?.created_by || 'ONLINE_BOOKING').trim() || 'ONLINE_BOOKING';
  const status = String(input?.status || 'inbox').trim() || 'inbox';
  const gpsLat = input?.gps_lat ?? input?.data?.gps_lat ?? input?.data?.client?.gps_lat ?? null;
  const gpsLng = input?.gps_lng ?? input?.data?.gps_lng ?? input?.data?.client?.gps_lng ?? null;

  if (!name) throw new Error('TRANSPORT_CLIENT_NAME_REQUIRED');
  if (!isValidTransportPhoneServer(phone)) throw new Error('TRANSPORT_PHONE_INVALID');

  const already = await fetchExactTransportOrderServer(supabase, orderId);
  if (already) {
    const existingPermanent = normalizeTransportTCodeServer(already.client_tcode || already?.data?.transport_client_tcode || already?.data?.client?.tcode);
    return { ok: true, data: assertServerTransportOrder(already, { orderId, phone, permanentTcode: existingPermanent }), idempotent: true, reservedCode: '' };
  }

  const existingClient = await findTransportClientByPhoneServer(supabase, phone);
  const suppliedCode = normalizeTransportTCodeServer(
    input?.code_str ||
    input?.client_tcode ||
    input?.transport_client_tcode ||
    input?.data?.code_str ||
    input?.data?.order_code ||
    input?.data?.official_order_code ||
    input?.data?.transport_client_tcode ||
    input?.data?.client?.transport_client_tcode ||
    input?.data?.client?.tcode ||
    input?.data?.client?.code ||
    '',
  );
  let reservedCode = '';
  let permanentTcode = normalizeTransportTCodeServer(existingClient?.tcode);
  if (!permanentTcode) {
    // Offline Self Entry may already own one temporary code. Reuse that exact code
    // instead of consuming a second one. Public booking sends no supplied code and
    // therefore receives the smallest available code from the allocator.
    reservedCode = suppliedCode || await reserveSmallestTransportTCodeServer(supabase, owner);
    permanentTcode = reservedCode;
  }

  const baseData = input?.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {};
  const clientData = baseData?.client && typeof baseData.client === 'object' && !Array.isArray(baseData.client) ? baseData.client : {};
  const payloadData = {
    ...baseData,
    order_id: orderId,
    public_order_id: orderId,
    code_str: permanentTcode,
    code: permanentTcode,
    order_code: permanentTcode,
    official_order_code: permanentTcode,
    order_tcode: permanentTcode,
    client_tcode: permanentTcode,
    transport_client_tcode: permanentTcode,
    client_id: existingClient?.id || baseData?.client_id || null,
    client: {
      ...clientData,
      id: existingClient?.id || clientData?.id || null,
      name,
      phone,
      address,
      tcode: permanentTcode,
      code: permanentTcode,
      client_tcode: permanentTcode,
      transport_client_tcode: permanentTcode,
      order_code: permanentTcode,
      official_order_code: permanentTcode,
    },
  };

  const rpcPhone = existingClient?.source === 'transport_clients' && existingClient?.phone
    ? String(existingClient.phone)
    : phone;
  const rpc = await supabase.rpc('create_transport_order', {
    p_id: orderId,
    p_code_n: Number(onlyDigits(permanentTcode)) || null,
    p_code_str: permanentTcode,
    p_client_name: name,
    p_client_phone: rpcPhone,
    p_address: address,
    p_gps_lat: gpsLat == null ? null : String(gpsLat),
    p_gps_lng: gpsLng == null ? null : String(gpsLng),
    p_data: payloadData,
    p_status: status,
  });

  if (rpc?.error) {
    if (reservedCode || suppliedCode) await releaseTransportTCodeServer(supabase, reservedCode || suppliedCode, owner);
    throw new Error(`TRANSPORT_ORDER_CREATE_FAILED: ${errorText(rpc.error)}`);
  }

  let row = await fetchExactTransportOrderServer(supabase, orderId);
  if (!row) {
    if (reservedCode || suppliedCode) await releaseTransportTCodeServer(supabase, reservedCode || suppliedCode, owner);
    throw new Error('TRANSPORT_ORDER_MISSING_AFTER_CREATE');
  }

  const dbPermanentTcode = normalizeTransportTCodeServer(
    row.client_tcode || rpc?.data?.client_tcode || row?.data?.transport_client_tcode || row?.data?.client?.tcode,
  );
  if (!dbPermanentTcode) throw new Error('TRANSPORT_DB_PERMANENT_TCODE_MISSING');

  // Phone-level race: another request may have created this client after our lookup.
  // Keep the exact order UUID, rewrite its public code to the canonical client T-code,
  // then return the temporary reservation to the pool.
  if (normalizeTransportTCodeServer(row.code_str) !== dbPermanentTcode) {
    const patched = await supabase
      .from('transport_orders')
      .update({ code_str: dbPermanentTcode, client_tcode: dbPermanentTcode })
      .eq('id', orderId)
      .select('*')
      .maybeSingle();
    if (patched?.error) throw new Error(`TRANSPORT_ORDER_CODE_RECONCILE_FAILED: ${errorText(patched.error)}`);
    row = patched?.data || await fetchExactTransportOrderServer(supabase, orderId);
  }

  const supersededCode = reservedCode || suppliedCode;
  if (supersededCode && supersededCode !== dbPermanentTcode) {
    await releaseTransportTCodeServer(supabase, supersededCode, owner);
  }

  return {
    ok: true,
    data: assertServerTransportOrder(row, { orderId, phone, permanentTcode: dbPermanentTcode }),
    idempotent: false,
    reservedCode: reservedCode && reservedCode === dbPermanentTcode ? reservedCode : '',
  };
}
