import {
  isValidTransportPhoneDigits,
  normalizeTransportPhoneKey,
} from './transport/phone.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CLIENT_PROFILE_SOURCE = Object.freeze({
  BASE: 'BASE',
  TRANSPORT: 'TRANSPORT',
});

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function cleanClientUuid(value) {
  const text = clean(value);
  return UUID_RE.test(text) ? text : '';
}

export function cleanBaseOrderId(value) {
  const text = clean(value);
  return /^\d+$/.test(text) ? text : '';
}

export function normalizeClientProfilePhone(value) {
  const key = normalizeTransportPhoneKey(value);
  return isValidTransportPhoneDigits(key) ? key : '';
}

export function normalizeClientProfileSource(value, fallback = CLIENT_PROFILE_SOURCE.BASE) {
  const text = clean(value).toUpperCase();
  if (text === CLIENT_PROFILE_SOURCE.TRANSPORT || text === 'TRANSPORT_ORDERS') {
    return CLIENT_PROFILE_SOURCE.TRANSPORT;
  }
  if (text === CLIENT_PROFILE_SOURCE.BASE || text === 'ORDERS' || text === 'DB' || text === 'LOCAL' || text === 'OUTBOX') {
    return CLIENT_PROFILE_SOURCE.BASE;
  }
  return fallback;
}

export function buildClientProfileAnchor(rowLike = {}) {
  const row = asObject(rowLike);
  const order = asObject(row.fullOrder || row.order || row.data);
  const nestedData = asObject(order.data);
  const client = asObject(order.client || nestedData.client);
  const rawCode = clean(
    row.code
      || row.code_str
      || row.client_tcode
      || order.client_tcode
      || order.transport_client_tcode
      || order.code_str
      || order.code
      || client.tcode
      || client.code,
  ).toUpperCase();
  const sourceHint = clean(row.source || row._table || row.table || order._table || order.table).toUpperCase();
  const transport = sourceHint.includes('TRANSPORT') || /^T\d+$/.test(rawCode);
  const source = transport ? CLIENT_PROFILE_SOURCE.TRANSPORT : CLIENT_PROFILE_SOURCE.BASE;
  const clientId = cleanClientUuid(
    row.client_id
      || row.clientId
      || order.client_id
      || order.clientId
      || order.client_master_id
      || nestedData.client_id
      || nestedData.client_master_id
      || client.id,
  );
  const rawOrderId = clean(row.id || order.order_id || order.id || row.local_oid || order.local_oid);
  const orderId = source === CLIENT_PROFILE_SOURCE.TRANSPORT
    ? cleanClientUuid(rawOrderId)
    : cleanBaseOrderId(rawOrderId);

  return {
    source,
    clientId: clientId || null,
    orderId: orderId || null,
    code: rawCode || null,
    name: clean(row.name || row.client_name || order.client_name || client.name || client.full_name) || null,
    phone: clean(row.phone || row.client_phone || order.client_phone || client.phone) || null,
    status: clean(row.status || order.status || order.state).toLowerCase() || null,
  };
}

export function selectUniqueClientByPhone(rows, phoneValue) {
  const wanted = normalizeClientProfilePhone(phoneValue);
  if (!wanted) return { status: 'invalid', client: null, matches: [] };
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = cleanClientUuid(row?.id);
    if (!id) continue;
    const phone = normalizeClientProfilePhone(row?.phone_digits || row?.phone || row?.client_phone);
    if (phone !== wanted) continue;
    if (!byId.has(id)) byId.set(id, row);
  }
  const matches = Array.from(byId.values());
  if (matches.length === 1) return { status: 'unique', client: matches[0], matches };
  if (matches.length > 1) return { status: 'conflict', client: null, matches };
  return { status: 'missing', client: null, matches: [] };
}

export function orderBelongsToClientProfile(rowLike, { clientId = '', phone = '' } = {}) {
  const row = asObject(rowLike);
  const data = asObject(row.data);
  const client = asObject(data.client);
  const expectedId = cleanClientUuid(clientId);
  const rowId = cleanClientUuid(row.client_id || data.client_id || data.client_master_id || client.id);
  if (rowId) return !!expectedId && rowId === expectedId;
  const expectedPhone = normalizeClientProfilePhone(phone);
  const rowPhone = normalizeClientProfilePhone(row.client_phone || data.client_phone || client.phone);
  return !!expectedPhone && rowPhone === expectedPhone;
}

export function clientProfileCacheKey(anchorLike = {}) {
  const anchor = buildClientProfileAnchor(anchorLike);
  const identity = anchor.clientId || normalizeClientProfilePhone(anchor.phone);
  if (!identity) return '';
  return `tepiha_client_profile_v1:${anchor.source}:${identity}`;
}
