import {
  CLIENT_PROFILE_SOURCE,
  cleanBaseOrderId,
  cleanClientUuid,
  normalizeClientProfilePhone,
  normalizeClientProfileSource,
  orderBelongsToClientProfile,
  selectUniqueClientByPhone,
} from './clientProfileIdentity.js';
import { transportPhoneDigitVariants } from './transport/phone.js';

const ACTIVE_STATUSES = new Set([
  'draft', 'pranim', 'pranimi', 'pending', 'pickup', 'marrje', 'caktuar', 'assigned',
  'ne_baze', 'në_bazë', 'at_base', 'pastrim', 'pastrimi', 'gati', 'ready', 'dorzim', 'dorëzim',
]);
const TERMINAL_STATUSES = new Set([
  'done', 'completed', 'complete', 'delivered', 'dorezuar', 'dorëzuar', 'cancelled', 'canceled', 'anuluar', 'archived',
]);
const PROFILE_ACTIONS = new Set(['GET_PROFILE']);
const MAX_HISTORY_ROWS = 160;

export class ClientProfileError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(String(code || 'CLIENT_PROFILE_FAILED'));
    this.name = 'ClientProfileError';
    this.code = String(code || 'CLIENT_PROFILE_FAILED');
    this.httpStatus = Number(status) || 400;
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }
}

function fail(code, status = 400, extra = {}) {
  throw new ClientProfileError(code, status, extra);
}

function clean(value) {
  return String(value ?? '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function orderData(row) {
  const first = asObject(row?.data);
  const nested = asObject(first?.data);
  return Object.keys(nested).length ? { ...first, ...nested, data: nested } : first;
}

function number(...values) {
  for (const value of values) {
    if (value === '' || value == null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function money(value) {
  return Math.max(0, Number((number(value) + Number.EPSILON).toFixed(2)));
}

function safeIso(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '_');
}

function isActiveStatus(status) {
  const cleanStatus = normalizeStatus(status);
  if (!cleanStatus) return true;
  if (TERMINAL_STATUSES.has(cleanStatus)) return false;
  return ACTIVE_STATUSES.has(cleanStatus) || !TERMINAL_STATUSES.has(cleanStatus);
}

function normalizeBaseCode(value) {
  const digits = clean(value).replace(/\D+/g, '').replace(/^0+/, '');
  return digits || '';
}

function normalizeTransportCode(value) {
  const digits = clean(value).replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : '';
}

function rowClientId(row) {
  const data = orderData(row);
  const client = asObject(data.client);
  return cleanClientUuid(row?.client_id || data.client_id || data.client_master_id || client.id);
}

function rowClientPhone(row) {
  const data = orderData(row);
  const client = asObject(data.client);
  return clean(row?.client_phone || data.client_phone || client.phone);
}

function rowClientName(row) {
  const data = orderData(row);
  const client = asObject(data.client);
  return clean(row?.client_name || data.client_name || client.name || client.full_name || data.name);
}

function readItems(dataLike) {
  const data = asObject(dataLike);
  const rows = [];
  const add = (kind, source) => {
    for (const item of Array.isArray(source) ? source : []) {
      const m2 = Math.max(0, number(item?.m2, item?.size, item?.area));
      const qty = Math.max(0, Math.round(number(item?.qty, item?.pieces, item?.cope, 1))) || 1;
      if (m2 <= 0 && qty <= 0) continue;
      rows.push({
        kind,
        m2: Number(m2.toFixed(2)),
        qty,
        photoUrl: clean(item?.photoUrl || item?.photo_url) || null,
      });
    }
  };
  add('TEPIH', Array.isArray(data.tepiha) ? data.tepiha : data.tepihaRows);
  add('STAZË', Array.isArray(data.staza) ? data.staza : data.stazaRows);
  const stairsQty = Math.max(0, Math.round(number(data.stairsQty, data.shkallore?.qty, data.shkallore?.pieces)));
  const stairsM2 = Math.max(0, number(data.stairsPer, data.shkallore?.m2));
  if (stairsQty > 0 || stairsM2 > 0) {
    rows.push({ kind: 'SHKALLORE', m2: Number(stairsM2.toFixed(2)), qty: stairsQty || 1, photoUrl: clean(data.stairsPhotoUrl || data.shkallore?.photoUrl) || null });
  }
  return rows.slice(0, 80);
}

function itemTotals(items) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const qty = Math.max(1, number(item?.qty, 1));
    acc.pieces += qty;
    acc.m2 += Math.max(0, number(item?.m2)) * qty;
    return acc;
  }, { pieces: 0, m2: 0 });
}

function normalizeVisit(row, source, currentOrderId = '') {
  const data = orderData(row);
  const client = asObject(data.client);
  const pay = asObject(data.pay);
  const totals = asObject(data.totals);
  const items = readItems(data);
  const computed = itemTotals(items);
  const isTransport = source === CLIENT_PROFILE_SOURCE.TRANSPORT;
  const total = money(number(
    row?.price_total,
    row?.total,
    data.price_total,
    data.total,
    pay.euro,
    totals.total,
    totals.euro,
  ));
  const paid = money(number(
    row?.paid_cash,
    row?.paid,
    data.paid_cash,
    data.paid,
    pay.paid,
    data.clientPaid,
  ));
  const explicitDebt = money(number(data.debt_amount, data.debt, data.payment_state?.debt_remaining));
  const debt = money(Math.max(explicitDebt, total - paid));
  const status = normalizeStatus(row?.status || data.status || data.state);
  const id = clean(row?.id || data.order_id || data.id);
  const code = isTransport
    ? normalizeTransportCode(row?.client_tcode || data.transport_client_tcode || data.client_tcode || client.tcode || client.code || row?.code_str || data.code_str || data.code)
    : normalizeBaseCode(row?.code || data.client_code || client.code || data.code);
  const createdAt = safeIso(row?.created_at, data.created_at_iso, data.created_at, data.ts);
  const updatedAt = safeIso(row?.updated_at, data.updated_at, row?.created_at, data.ts);
  const m2 = Math.max(0, number(row?.m2_total, data.m2_total, totals.m2, computed.m2));
  const pieces = Math.max(0, Math.round(number(row?.pieces, data.pieces, totals.pieces, computed.pieces)));

  return {
    id,
    source,
    code: code || '—',
    visitNr: isTransport ? Math.max(0, Math.round(number(row?.visit_nr, data.visit_nr))) : null,
    status: status || 'unknown',
    active: isActiveStatus(status),
    current: !!currentOrderId && id === currentOrderId,
    createdAt,
    updatedAt,
    readyAt: safeIso(row?.ready_at, data.ready_at),
    deliveredAt: safeIso(row?.delivered_at, row?.deliveredAt, data.delivered_at, data.done_at, data.completed_at),
    m2: Number(m2.toFixed(2)),
    pieces,
    total,
    paid,
    debt,
    worker: clean(data.brought_by_name || data.driver_name || data.ready_by_name || data.delivered_by_name || data.created_by_name) || null,
    rack: clean(data.ready_location || data.ready_note_text || data.ready_note) || null,
    note: clean(data.note || data.notes || row?.note || row?.notes) || null,
    items,
  };
}

function cleanClient(row, source) {
  if (!row) return null;
  return {
    id: cleanClientUuid(row.id),
    source,
    code: source === CLIENT_PROFILE_SOURCE.TRANSPORT
      ? normalizeTransportCode(row.tcode || row.client_tcode || row.code)
      : normalizeBaseCode(row.code),
    name: clean(row.name || row.full_name || row.client_name),
    phone: clean(row.phone || row.client_phone),
    phoneKey: normalizeClientProfilePhone(row.phone_digits || row.phone || row.client_phone),
    address: clean(row.address),
    gpsLat: clean(row.gps_lat),
    gpsLng: clean(row.gps_lng),
    notes: clean(row.notes),
  };
}

async function readApprovedViewer(supabase, deviceIdLike) {
  const deviceId = clean(deviceIdLike).slice(0, 120);
  if (!deviceId) fail('AUTH_REQUIRED', 401);
  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) fail('CLIENT_PROFILE_DEVICE_LOOKUP_FAILED', 500);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,name,role,is_active')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) fail('CLIENT_PROFILE_USER_LOOKUP_FAILED', 500);
  if (!user || user.is_active === false) fail('AUTH_USER_DISABLED', 403);
  return { id: clean(user.id), name: clean(user.name), role: upper(user.role) };
}

export const authenticateClientProfileViewer = readApprovedViewer;

async function readAnchorOrder(supabase, source, orderId) {
  if (!orderId) return null;
  if (source === CLIENT_PROFILE_SOURCE.TRANSPORT) {
    const id = cleanClientUuid(orderId);
    if (!id) fail('CLIENT_PROFILE_TRANSPORT_ORDER_ID_INVALID', 400);
    const { data, error } = await supabase
      .from('transport_orders')
      .select('id,client_id,client_tcode,code_str,visit_nr,client_name,client_phone,status,data,created_at,updated_at,ready_at')
      .eq('id', id)
      .maybeSingle();
    if (error) fail('CLIENT_PROFILE_ANCHOR_LOOKUP_FAILED', 500);
    if (!data) fail('CLIENT_PROFILE_ANCHOR_NOT_FOUND', 404);
    return data;
  }
  const id = cleanBaseOrderId(orderId);
  if (!id) fail('CLIENT_PROFILE_BASE_ORDER_ID_INVALID', 400);
  const { data, error } = await supabase
    .from('orders')
    .select('id,code,client_id,client_name,client_phone,status,data,created_at,updated_at,ready_at,picked_up_at,delivered_at,price_total,m2_total,pieces,paid_cash')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('CLIENT_PROFILE_ANCHOR_LOOKUP_FAILED', 500);
  if (!data) fail('CLIENT_PROFILE_ANCHOR_NOT_FOUND', 404);
  return data;
}

async function readClientById(supabase, source, clientId) {
  const id = cleanClientUuid(clientId);
  if (!id) return null;
  const table = source === CLIENT_PROFILE_SOURCE.TRANSPORT ? 'transport_clients' : 'clients';
  const select = source === CLIENT_PROFILE_SOURCE.TRANSPORT
    ? 'id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,notes,created_at,updated_at'
    : 'id,code,name,full_name,phone,phone_digits,created_at,updated_at';
  const { data, error } = await supabase.from(table).select(select).eq('id', id).maybeSingle();
  if (error) fail('CLIENT_PROFILE_CLIENT_LOOKUP_FAILED', 500);
  return data || null;
}

async function readUniqueClientByPhone(supabase, source, phone) {
  const key = normalizeClientProfilePhone(phone);
  if (!key) return { status: 'invalid', client: null };
  const table = source === CLIENT_PROFILE_SOURCE.TRANSPORT ? 'transport_clients' : 'clients';
  const select = source === CLIENT_PROFILE_SOURCE.TRANSPORT
    ? 'id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,notes,created_at,updated_at'
    : 'id,code,name,full_name,phone,phone_digits,created_at,updated_at';
  const variants = transportPhoneDigitVariants(phone);
  let rows = [];
  if (variants.length) {
    const direct = await supabase.from(table).select(select).in('phone_digits', variants).limit(20);
    if (direct?.error) fail('CLIENT_PROFILE_PHONE_LOOKUP_FAILED', 500);
    rows = Array.isArray(direct?.data) ? direct.data : [];
  }
  let selected = selectUniqueClientByPhone(rows, phone);
  if (selected.status === 'missing') {
    const fallback = await supabase.from(table).select(select).limit(5000);
    if (fallback?.error) fail('CLIENT_PROFILE_PHONE_FALLBACK_FAILED', 500);
    selected = selectUniqueClientByPhone(fallback?.data, phone);
  }
  if (selected.status === 'conflict') fail('CLIENT_PROFILE_PHONE_IDENTITY_CONFLICT', 409);
  return selected;
}

async function readOrdersForClient(supabase, source, client, phone, anchor) {
  const table = source === CLIENT_PROFILE_SOURCE.TRANSPORT ? 'transport_orders' : 'orders';
  const select = source === CLIENT_PROFILE_SOURCE.TRANSPORT
    ? 'id,client_id,client_tcode,code_str,visit_nr,client_name,client_phone,status,data,created_at,updated_at,ready_at'
    : 'id,code,client_id,client_name,client_phone,status,data,created_at,updated_at,ready_at,picked_up_at,delivered_at,price_total,m2_total,pieces,paid_cash';
  const rows = [];
  if (client?.id) {
    const linked = await supabase.from(table).select(select).eq('client_id', client.id).order('created_at', { ascending: false }).limit(MAX_HISTORY_ROWS);
    if (linked?.error) fail('CLIENT_PROFILE_HISTORY_LOOKUP_FAILED', 500);
    rows.push(...(Array.isArray(linked?.data) ? linked.data : []));
  }

  const phoneKey = normalizeClientProfilePhone(phone || client?.phone || client?.phoneKey);
  if (phoneKey) {
    const unlinked = await supabase.from(table).select(select).is('client_id', null).order('created_at', { ascending: false }).limit(500);
    if (unlinked?.error) fail('CLIENT_PROFILE_UNLINKED_HISTORY_LOOKUP_FAILED', 500);
    for (const row of Array.isArray(unlinked?.data) ? unlinked.data : []) {
      if (orderBelongsToClientProfile(row, { phone: phoneKey })) rows.push(row);
    }
  }
  if (anchor) rows.push(anchor);
  const byId = new Map();
  for (const row of rows) {
    const id = clean(row?.id);
    if (!id) continue;
    if (rowClientId(row) && client?.id && rowClientId(row) !== client.id) continue;
    if (!byId.has(id)) byId.set(id, row);
  }
  return Array.from(byId.values()).slice(0, MAX_HISTORY_ROWS);
}

async function readCarryDebt(supabase, baseClient, transportClient, phone) {
  let baseDebt = 0;
  let transportDebt = 0;
  const phoneKey = normalizeClientProfilePhone(phone || baseClient?.phone || transportClient?.phone);
  if (phoneKey) {
    const variants = transportPhoneDigitVariants(phone || baseClient?.phone || transportClient?.phone);
    if (variants.length) {
      const balance = await supabase.from('client_balances').select('phone,debt_eur,updated_at').in('phone', variants).limit(20);
      if (!balance?.error) {
        for (const row of Array.isArray(balance?.data) ? balance.data : []) {
          if (normalizeClientProfilePhone(row?.phone) === phoneKey) baseDebt += money(row?.debt_eur);
        }
      }
    }
  }
  if (transportClient?.code) {
    const debt = await supabase.from('transport_client_debts').select('client_tcode,debt_eur,updated_at').eq('client_tcode', transportClient.code).limit(50);
    if (!debt?.error) {
      for (const row of Array.isArray(debt?.data) ? debt.data : []) transportDebt += money(row?.debt_eur);
    }
  }
  return {
    base: money(baseDebt),
    transport: money(transportDebt),
    total: money(baseDebt + transportDebt),
  };
}

async function readPayments(supabase, baseVisits, transportVisits) {
  const baseIds = baseVisits.map((row) => cleanBaseOrderId(row.id)).filter(Boolean);
  const transportIds = transportVisits.map((row) => cleanClientUuid(row.id)).filter(Boolean);
  const tasks = [];
  if (baseIds.length) {
    tasks.push(supabase.from('arka_pending_payments')
      .select('id,order_id,amount,type,status,note,order_code,source_module,created_at,updated_at')
      .in('order_id', baseIds.slice(0, 160)).order('created_at', { ascending: false }).limit(160));
  }
  if (transportIds.length) {
    tasks.push(supabase.from('arka_pending_payments')
      .select('id,transport_order_id,transport_code_str,amount,type,status,note,source_module,created_at,updated_at')
      .in('transport_order_id', transportIds.slice(0, 160)).order('created_at', { ascending: false }).limit(160));
  }
  const results = await Promise.all(tasks);
  const byId = new Map();
  for (const result of results) {
    if (result?.error) continue;
    for (const row of Array.isArray(result?.data) ? result.data : []) {
      const id = clean(row?.id);
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        source: cleanClientUuid(row?.transport_order_id) ? CLIENT_PROFILE_SOURCE.TRANSPORT : CLIENT_PROFILE_SOURCE.BASE,
        orderId: clean(row?.transport_order_id || row?.order_id),
        code: clean(row?.transport_code_str || row?.order_code) || '—',
        amount: money(row?.amount),
        type: upper(row?.type),
        status: upper(row?.status),
        note: clean(row?.note) || null,
        createdAt: safeIso(row?.created_at),
      });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 160);
}

function summarize(visits, carryDebt) {
  const totals = visits.reduce((acc, visit) => {
    acc.total += money(visit.total);
    acc.paid += money(visit.paid);
    acc.orderDebt += money(visit.debt);
    acc.m2 += Math.max(0, number(visit.m2));
    acc.pieces += Math.max(0, number(visit.pieces));
    if (visit.active) acc.active += 1;
    return acc;
  }, { total: 0, paid: 0, orderDebt: 0, m2: 0, pieces: 0, active: 0 });
  return {
    visits: visits.length,
    active: totals.active,
    m2: Number(totals.m2.toFixed(2)),
    pieces: Math.round(totals.pieces),
    billed: money(totals.total),
    paid: money(totals.paid),
    orderDebt: money(totals.orderDebt),
    carryDebt: money(carryDebt?.total),
    totalDebt: money(Math.max(totals.orderDebt, carryDebt?.total || 0)),
  };
}

export async function buildClientProfile(bodyLike, { supabase, authUser } = {}) {
  if (!supabase || !authUser?.id) fail('AUTH_REQUIRED', 401);
  const body = bodyLike && typeof bodyLike === 'object' && !Array.isArray(bodyLike) ? bodyLike : {};
  const action = upper(body.action || 'GET_PROFILE');
  if (!PROFILE_ACTIONS.has(action)) fail('CLIENT_PROFILE_ACTION_INVALID', 400);
  const source = normalizeClientProfileSource(body.source);
  const requestedClientId = cleanClientUuid(body.clientId || body.client_id);
  const orderId = source === CLIENT_PROFILE_SOURCE.TRANSPORT
    ? cleanClientUuid(body.orderId || body.order_id)
    : cleanBaseOrderId(body.orderId || body.order_id);
  const requestedPhone = clean(body.phone);
  if (!requestedClientId && !orderId && !normalizeClientProfilePhone(requestedPhone)) {
    fail('CLIENT_PROFILE_IDENTITY_REQUIRED', 400);
  }

  const anchor = await readAnchorOrder(supabase, source, orderId);
  const anchorClientId = rowClientId(anchor);
  if (requestedClientId && anchorClientId && requestedClientId !== anchorClientId) {
    fail('CLIENT_PROFILE_ANCHOR_IDENTITY_CONFLICT', 409);
  }
  const canonicalClientId = anchorClientId || requestedClientId;
  let sourceClientRaw = canonicalClientId ? await readClientById(supabase, source, canonicalClientId) : null;
  if (canonicalClientId && !sourceClientRaw) fail('CLIENT_PROFILE_CLIENT_NOT_FOUND', 404);
  const anchorPhone = rowClientPhone(anchor);
  const lookupPhone = clean(sourceClientRaw?.phone || sourceClientRaw?.client_phone || anchorPhone || requestedPhone);
  if (!sourceClientRaw && normalizeClientProfilePhone(lookupPhone)) {
    const resolved = await readUniqueClientByPhone(supabase, source, lookupPhone);
    sourceClientRaw = resolved.client || null;
  }

  const sourceClient = cleanClient(sourceClientRaw, source);
  const authoritativePhone = clean(sourceClient?.phone || anchorPhone || requestedPhone);
  const authoritativePhoneKey = normalizeClientProfilePhone(authoritativePhone);
  const warnings = [];
  if (!sourceClient?.id) warnings.push('SOURCE_CLIENT_UNLINKED');
  if (!authoritativePhoneKey) warnings.push('PHONE_MISSING_OR_INVALID');
  if (
    sourceClient?.phoneKey
    && normalizeClientProfilePhone(anchorPhone)
    && sourceClient.phoneKey !== normalizeClientProfilePhone(anchorPhone)
  ) warnings.push('ANCHOR_PHONE_STALE');

  let baseClient = source === CLIENT_PROFILE_SOURCE.BASE ? sourceClient : null;
  let transportClient = source === CLIENT_PROFILE_SOURCE.TRANSPORT ? sourceClient : null;
  if (authoritativePhoneKey) {
    if (!baseClient) {
      const match = await readUniqueClientByPhone(supabase, CLIENT_PROFILE_SOURCE.BASE, authoritativePhone);
      baseClient = cleanClient(match.client, CLIENT_PROFILE_SOURCE.BASE);
    }
    if (!transportClient) {
      const match = await readUniqueClientByPhone(supabase, CLIENT_PROFILE_SOURCE.TRANSPORT, authoritativePhone);
      transportClient = cleanClient(match.client, CLIENT_PROFILE_SOURCE.TRANSPORT);
    }
  }

  const [baseRows, transportRows] = await Promise.all([
    readOrdersForClient(
      supabase,
      CLIENT_PROFILE_SOURCE.BASE,
      baseClient,
      authoritativePhone,
      source === CLIENT_PROFILE_SOURCE.BASE ? anchor : null,
    ),
    readOrdersForClient(
      supabase,
      CLIENT_PROFILE_SOURCE.TRANSPORT,
      transportClient,
      authoritativePhone,
      source === CLIENT_PROFILE_SOURCE.TRANSPORT ? anchor : null,
    ),
  ]);

  const baseVisits = baseRows.map((row) => normalizeVisit(row, CLIENT_PROFILE_SOURCE.BASE, source === CLIENT_PROFILE_SOURCE.BASE ? orderId : ''));
  const transportVisits = transportRows.map((row) => normalizeVisit(row, CLIENT_PROFILE_SOURCE.TRANSPORT, source === CLIENT_PROFILE_SOURCE.TRANSPORT ? orderId : ''));
  const visits = [...baseVisits, ...transportVisits]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, MAX_HISTORY_ROWS);
  const [carryDebt, payments] = await Promise.all([
    readCarryDebt(supabase, baseClient, transportClient, authoritativePhone),
    readPayments(supabase, baseVisits, transportVisits),
  ]);

  const newestVisit = visits[0] || null;
  return {
    profile: {
      identity: {
        source,
        resolution: sourceClient?.id ? (canonicalClientId ? 'CLIENT_ID' : 'UNIQUE_PHONE') : 'ANCHOR_ONLY',
        baseClientId: baseClient?.id || null,
        transportClientId: transportClient?.id || null,
        warnings,
      },
      client: {
        name: clean(sourceClient?.name || baseClient?.name || transportClient?.name || rowClientName(anchor) || body.name) || 'Pa emër',
        phone: authoritativePhone || null,
        address: clean(transportClient?.address) || null,
        gpsLat: clean(transportClient?.gpsLat) || null,
        gpsLng: clean(transportClient?.gpsLng) || null,
        baseCode: baseClient?.code || null,
        transportCode: transportClient?.code || null,
      },
      summary: summarize(visits, carryDebt),
      carryDebt,
      visits,
      payments,
      latestVisitId: newestVisit?.id || null,
      generatedAt: new Date().toISOString(),
    },
  };
}
