// lib/transportOrdersDb.js
// Transport DB helpers (Supabase + offline mirror)
// NOTE: This module is used by multiple pages. Keep exports stable.

import { supabase } from '@/lib/supabaseClient';
import {
  getAllFromStore,
  getAllFromIndex,
  getByKey,
  iterateIndex,
  putValue,
} from '@/lib/localDb';
import { pushOp } from '@/lib/offlineStore';
import { getTransportBaseSummary, matchesTransportSearch } from '@/lib/transport/bridgeMeta';
import { insertTransportOrder } from '@/lib/transport/transportDb';
import {
  sanitizeTransportClientPayload as sanitizeSharedTransportClientPayload,
  sanitizeTransportOrderPayload as sanitizeSharedTransportOrderPayload,
} from '@/lib/transport/sanitize';

function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function nowIso() {
  return new Date().toISOString();
}


function createTransportUuid() {
  const cryptoApi = globalThis?.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('TRANSPORT_UUID_UNAVAILABLE');
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function mergeOrder(existing, incoming) {
  const a = asObject(existing);
  const b = asObject(incoming);
  const aData = asObject(a.data);
  const bData = asObject(b.data);
  return {
    ...a,
    ...b,
    data: { ...aData, ...bData },
    updated_at: b.updated_at || nowIso(),
    sync_state: b.sync_state || 'synced',
  };
}


function normalizeTCodeLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : raw.toUpperCase();
}

function stripUndefinedShallow(obj) {
  const out = { ...(obj || {}) };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}


const TRANSPORT_ASSIGN_WRITE_STATUSES = new Set(['assigned', 'inbox']);
const TRANSPORT_PRE_PICKUP_STATUSES = new Set(['', 'new', 'inbox', 'pending', 'scheduled', 'draft', 'pranim', 'dispatched', 'assigned']);
const TRANSPORT_PROTECTED_LIFECYCLE_STATUSES = new Set(['pickup', 'loaded', 'ngarkim', 'ngarkuar', 'at_base', 'in_base', 'base', 'pastrim', 'pastrimi', 'gati', 'depo', 'ne_depo', 'delivery', 'dorzim', 'dorëzim', 'done']);

function normalizeTransportLifecycleStatus(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'pastrimi') return 'pastrim';
  if (raw === 'pranimi') return 'pranim';
  if (raw === 'ngarkuar') return 'loaded';
  if (raw === 'dorezim' || raw === 'dorëzim') return 'dorzim';
  return raw;
}

const TRANSPORT_PAYMENT_BLOCKED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'anuluar',
  'annulled',
  'void',
  'deleted',
  'removed',
  'failed',
  'rejected',
]);

// TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:DB — cancelled visits are historical
// records, never valid payment targets or candidates for a reused T-code.
export function isTransportOrderPaymentBlocked(rowOrStatus) {
  const rawStatus = rowOrStatus && typeof rowOrStatus === 'object'
    ? (rowOrStatus.status || rowOrStatus?.data?.status || rowOrStatus?.data?.state)
    : rowOrStatus;
  return TRANSPORT_PAYMENT_BLOCKED_STATUSES.has(normalizeTransportLifecycleStatus(rawStatus));
}

function transportOrderCancelledError() {
  return new Error('TRANSPORT_ORDER_CANCELLED');
}

function guardTransportAssignStatusOverwrite(currentStatus, patch = {}) {
  const wanted = normalizeTransportLifecycleStatus(patch?.status);
  if (!TRANSPORT_ASSIGN_WRITE_STATUSES.has(wanted)) return patch;
  const current = normalizeTransportLifecycleStatus(currentStatus || '');
  if (TRANSPORT_PROTECTED_LIFECYCLE_STATUSES.has(current) && !TRANSPORT_PRE_PICKUP_STATUSES.has(current)) {
    const safePatch = { ...(patch || {}) };
    delete safePatch.status;
    return safePatch;
  }
  return patch;
}


function shadowTransportLocalFields(input) {
  const next = { ...(input || {}) };
  const data = next.data && typeof next.data === 'object' && !Array.isArray(next.data) ? next.data : {};
  const client = data.client && typeof data.client === 'object' && !Array.isArray(data.client) ? data.client : {};

  const transportId = String(next.transport_id || data.transport_id || '').trim();
  if (transportId) next.transport_id = transportId;

  const transportPin = String(next.transport_pin || next.driver_pin || data.transport_pin || data.driver_pin || '').trim();
  if (transportPin) next.transport_pin = transportPin;

  if (!next.client_tcode) {
    const clientCode = normalizeTCodeLoose(next.code_str || data.code_str || data.order_code || data.order_tcode || data.official_order_code || '');
    if (clientCode) next.client_tcode = clientCode;
  }
  if (!next.code_str) {
    const code = normalizeTCodeLoose(data.code_str || data.order_code || data.order_tcode || data.official_order_code || '');
    if (code) next.code_str = code;
  }
  if (!next.client_name && typeof client.name === 'string' && String(client.name || '').trim()) {
    next.client_name = String(client.name || '').trim();
  }
  if (!next.client_phone && typeof client.phone === 'string' && String(client.phone || '').trim()) {
    next.client_phone = String(client.phone || '').trim();
  }

  return next;
}

function sanitizeTransportOrderPayload(input) {
  return sanitizeSharedTransportOrderPayload(input);
}

async function saveLocalTransportOrder(row, { sync_state = 'synced' } = {}) {
  const id = String(row?.id || '').trim() || createTransportUuid();
  const existing = await getByKey('transport_orders', id);
  const normalized = shadowTransportLocalFields(mergeOrder(existing, {
    ...row,
    id,
    sync_state,
  }));
  await putValue('transport_orders', normalized);
  return normalized;
}

async function getClientByTcodeRemote(tcode) {
  const { data, error } = await supabase
    .from('transport_clients')
    .select('*')
    .eq('tcode', tcode)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('TRANSPORT_CLIENT_NOT_FOUND');
  return data;
}

async function getClientByTcodeLocal(tcode) {
  const rows = await getAllFromIndex('transport_orders', 'by_client_tcode', tcode, 25, 'prev');
  const hit = rows.find((row) => {
    const c = row?.data?.client || {};
    return String(c?.tcode || row?.client_tcode || '').toUpperCase() === tcode;
  });
  const c = hit?.data?.client || {};
  if (!hit) return null;
  return {
    id: c?.id || hit?.client_id || null,
    tcode,
    name: c?.name || hit?.client_name || '',
    phone: c?.phone || hit?.client_phone || '',
    coords: c?.coords || (c?.gps ? { lat: c.gps.lat, lng: c.gps.lng } : null) || null,
    address: c?.address || '',
  };
}

async function getClientByTcode(tcode) {
  if (isOnline()) {
    const client = await getClientByTcodeRemote(tcode);
    return client;
  }
  const local = await getClientByTcodeLocal(tcode);
  if (!local) throw new Error('OFFLINE_CLIENT_NOT_AVAILABLE');
  return local;
}

async function getNextVisitNrRemote(tcode) {
  const { data, error } = await supabase
    .from('transport_orders')
    .select('visit_nr')
    .eq('client_tcode', tcode)
    .order('visit_nr', { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = data && data[0] && data[0].visit_nr ? Number(data[0].visit_nr) : 0;
  return max + 1;
}

async function getNextVisitNrLocal(tcode) {
  const rows = await getAllFromIndex('transport_orders', 'by_client_tcode', tcode, 50, 'prev');
  const max = rows.reduce((acc, row) => Math.max(acc, Number(row?.visit_nr || 0)), 0);
  return max + 1;
}

async function getNextVisitNr(tcode) {
  if (isOnline()) return getNextVisitNrRemote(tcode);
  return getNextVisitNrLocal(tcode);
}

async function enqueueTransportPatch(id, patch) {
  await pushOp({
    type: 'patch_order_data',
    id,
    payload: { ...patch, table: 'transport_orders' },
    created_at: Date.now(),
  });
}

function applyEq(row, eq) {
  return Object.entries(eq || {}).every(([key, value]) => row?.[key] === value);
}

function applyIn(row, inFilters) {
  return Object.entries(inFilters || {}).every(([key, values]) => {
    const list = Array.isArray(values) ? values : [values];
    return list.includes(row?.[key]);
  });
}

function applyIlike(row, ilike) {
  return Object.entries(ilike || {}).every(([key, value]) => {
    const needle = String(value || '').replace(/%/g, '').toLowerCase();
    const hay = String(row?.[key] || '').toLowerCase();
    return hay.includes(needle);
  });
}

function applyGte(row, gte) {
  return Object.entries(gte || {}).every(([key, value]) => {
    return row?.[key] >= value;
  });
}

function applyOr(row, clauses) {
  if (!Array.isArray(clauses) || !clauses.length) return true;
  return clauses.some((clause) => {
    if (!clause) return false;
    const parts = String(clause).split(',').map((s) => s.trim()).filter(Boolean);
    return parts.every((part) => {
      const [left, op, raw] = part.split('.');
      const rv = String(raw || '').replace(/%/g, '').toLowerCase();
      const lv = String(row?.[left] || '').toLowerCase();
      if (op === 'ilike') return lv.includes(rv);
      if (op === 'eq') return String(row?.[left] || '') === raw;
      return false;
    });
  });
}

async function listTransportOrdersLocal(options = {}) {
  const eq = options?.eq || {};
  const inFilters = options?.in || options?.inFilters || {};
  const limit = Number(options?.limit || 0);
  const orderBy = String(options?.orderBy || 'updated_at');
  const ascending = !!options?.ascending;

  let rows = [];
  if (eq.status !== undefined) {
    rows = await getAllFromIndex('transport_orders', 'by_status', eq.status, 0, ascending ? 'next' : 'prev');
  } else if (eq.transport_id !== undefined) {
    rows = await getAllFromIndex('transport_orders', 'by_transport_id', eq.transport_id, 0, ascending ? 'next' : 'prev');
  } else if (eq.client_tcode !== undefined) {
    rows = await getAllFromIndex('transport_orders', 'by_client_tcode', eq.client_tcode, 0, ascending ? 'next' : 'prev');
  } else if (orderBy === 'updated_at') {
    rows = await iterateIndex('transport_orders', 'by_updated_at', { direction: ascending ? 'next' : 'prev' });
  } else if (orderBy === 'created_at') {
    rows = await iterateIndex('transport_orders', 'by_created_at', { direction: ascending ? 'next' : 'prev' });
  } else {
    rows = await getAllFromStore('transport_orders');
  }

  rows = rows
    .filter((row) => applyEq(row, eq))
    .filter((row) => applyIn(row, inFilters))
    .filter((row) => applyIlike(row, options?.ilike || {}))
    .filter((row) => applyGte(row, options?.gte || {}))
    .filter((row) => applyOr(row, options?.or));

  if (orderBy && orderBy !== 'updated_at' && orderBy !== 'created_at') {
    rows.sort((a, b) => {
      const av = a?.[orderBy];
      const bv = b?.[orderBy];
      if (av === bv) return 0;
      if (ascending) return av > bv ? 1 : -1;
      return av < bv ? 1 : -1;
    });
  }

  if (options?.secondaryOrderBy) {
    const sKey = options.secondaryOrderBy;
    const sAsc = !!options.secondaryAscending;
    rows.sort((a, b) => {
      const primaryA = a?.[orderBy];
      const primaryB = b?.[orderBy];
      if (primaryA !== primaryB) return 0;
      const av = a?.[sKey];
      const bv = b?.[sKey];
      if (av === bv) return 0;
      if (sAsc) return av > bv ? 1 : -1;
      return av < bv ? 1 : -1;
    });
  }

  return limit > 0 ? rows.slice(0, limit) : rows;
}

// MAIN CREATE ORDER (WITH CLIENT SNAPSHOT)
export async function createNewTransportOrderForClientTcode({
  client_tcode,
  transport_id,
  status = 'pickup',
}) {
  const tcode = String(client_tcode || '').toUpperCase().trim();
  if (!tcode) throw new Error('MISSING_TCODE');

  const client = await getClientByTcode(tcode);
  const visit_nr = await getNextVisitNr(tcode);

  const payload = {
    client: {
      id: client.id,
      tcode: client.tcode,
      name: client.name || '',
      phone: client.phone || '',
      coords: client.coords || null,
      address: client.address || '',
    },
    transport_id: String(transport_id || '').trim(),
  };

  const order = sanitizeTransportOrderPayload({
    id: createTransportUuid(),
    code_str: tcode,
    code_n: Number(tcode.replace(/\D+/g, '')) || null,
    client_tcode: tcode,
    client_id: client.id,
    client_name: client.name || '',
    client_phone: client.phone || '',
    visit_nr,
    status,
    data: payload,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  if (!isOnline()) {
    const saved = await saveLocalTransportOrder(order, { sync_state: 'pending' });
    await pushOp({
      type: 'insert_order',
      payload: { ...saved, table: 'transport_orders' },
      created_at: Date.now(),
    });
    return saved;
  }

  const result = await insertTransportOrder(order);
  if (!result?.ok) throw new Error(result?.error || 'TRANSPORT_ORDER_CREATE_FAILED');
  const savedRow = result.data || order;
  await saveLocalTransportOrder(savedRow, { sync_state: 'synced' });
  return savedRow;
}

// REQUIRED EXPORTS (pages import these)
export async function fetchTransportOrderById(id) {
  const oid = String(id || '').trim();
  if (!oid) throw new Error('MISSING_ID');

  if (!isOnline()) {
    const local = await getByKey('transport_orders', oid);
    if (!local) throw new Error('OFFLINE_NOT_FOUND');
    return local;
  }

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .eq('id', oid)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('TRANSPORT_ORDER_NOT_FOUND');
    await saveLocalTransportOrder(data, { sync_state: 'synced' });
    return data;
  } catch (error) {
    const local = await getByKey('transport_orders', oid);
    if (local) return local;
    throw error;
  }
}

export async function fetchTransportOrderByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) throw new Error('MISSING_CODE');

  const findLocalMatches = async () => {
    const rows = await listTransportOrdersLocal({ orderBy: 'updated_at', ascending: false, limit: 120 });
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      const a = String(row?.code_str || '').trim().toUpperCase();
      const b = String(row?.client_tcode || '').trim().toUpperCase();
      return a === normalized || b === normalized;
    });
  };

  if (!isOnline()) {
    const localMatches = await findLocalMatches();
    const activeLocal = localMatches.find((row) => !isTransportOrderPaymentBlocked(row));
    if (activeLocal) return activeLocal;
    if (localMatches.length) throw transportOrderCancelledError();
    throw new Error('OFFLINE_NOT_FOUND');
  }

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .or(`code_str.eq.${normalized},client_tcode.eq.${normalized}`)
      .order('updated_at', { ascending: false })
      .limit(25);
    if (error) throw error;
    const matches = Array.isArray(data) ? data : [];
    const row = matches.find((candidate) => !isTransportOrderPaymentBlocked(candidate)) || null;
    if (row) {
      await saveLocalTransportOrder(row, { sync_state: 'synced' });
      return row;
    }
    if (matches.length) throw transportOrderCancelledError();
  } catch (error) {
    if (String(error?.message || error) === 'TRANSPORT_ORDER_CANCELLED') throw error;
    const localMatches = await findLocalMatches();
    const activeLocal = localMatches.find((row) => !isTransportOrderPaymentBlocked(row));
    if (activeLocal) return activeLocal;
    if (localMatches.length) throw transportOrderCancelledError();
    throw error;
  }

  const localMatches = await findLocalMatches();
  const activeLocal = localMatches.find((row) => !isTransportOrderPaymentBlocked(row));
  if (activeLocal) return activeLocal;
  if (localMatches.length) throw transportOrderCancelledError();
  return null;
