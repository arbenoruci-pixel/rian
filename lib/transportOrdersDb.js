// lib/transportOrdersDb.js
// Transport DB helpers (Supabase + offline mirror)
// NOTE: This module is used by multiple pages. Keep exports stable.

import { supabase } from '@/lib/supabaseClient';
import {
  createOfflineTransportId,
  getAllFromStore,
  getAllFromIndex,
  getByKey,
  iterateIndex,
  putValue,
} from '@/lib/localDb';
import { pushOp } from '@/lib/offlineStore';
import { getTransportBaseSummary, matchesTransportSearch } from '@/lib/transport/bridgeMeta';
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


function shadowTransportLocalFields(input) {
  const next = { ...(input || {}) };
  const data = next.data && typeof next.data === 'object' && !Array.isArray(next.data) ? next.data : {};
  const client = data.client && typeof data.client === 'object' && !Array.isArray(data.client) ? data.client : {};

  const transportId = String(next.transport_id || data.transport_id || '').trim();
  if (transportId) next.transport_id = transportId;

  const transportPin = String(next.transport_pin || next.driver_pin || data.transport_pin || data.driver_pin || '').trim();
  if (transportPin) next.transport_pin = transportPin;

  if (!next.client_tcode) {
    const clientCode = normalizeTCodeLoose(client.tcode || client.code || data.client_tcode || next.code_str || '');
    if (clientCode) next.client_tcode = clientCode;
  }
  if (!next.code_str) {
    const code = normalizeTCodeLoose(next.client_tcode || client.tcode || client.code || '');
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
  const id = String(row?.id || '').trim() || createOfflineTransportId();
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
    id: createOfflineTransportId(),
    client_tcode: tcode,
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

  const { data, error } = await supabase
    .from('transport_orders')
    .insert(order)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  const savedRow = data || order;
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

  const findLocal = async () => {
    const rows = await listTransportOrdersLocal({ orderBy: 'updated_at', ascending: false, limit: 120 });
    return (Array.isArray(rows) ? rows : []).find((row) => {
      const a = String(row?.code_str || '').trim().toUpperCase();
      const b = String(row?.client_tcode || '').trim().toUpperCase();
      return a === normalized || b === normalized;
    }) || null;
  };

  if (!isOnline()) {
    const local = await findLocal();
    if (!local) throw new Error('OFFLINE_NOT_FOUND');
    return local;
  }

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .or(`code_str.eq.${normalized},client_tcode.eq.${normalized}`)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (row) {
      await saveLocalTransportOrder(row, { sync_state: 'synced' });
      return row;
    }
  } catch (error) {
    const local = await findLocal();
    if (local) return local;
    throw error;
  }

  const local = await findLocal();
  if (local) return local;
  return null;
}

export async function updateTransportOrderById(id, patch) {
  const oid = String(id || '').trim();
  if (!oid) throw new Error('MISSING_ID');

  const localCurrent = await getByKey('transport_orders', oid);
  const localPatch = { ...(patch || {}), updated_at: patch?.updated_at || nowIso() };
  const remotePatch = sanitizeTransportOrderPayload(localPatch);
  const localUpdated = await saveLocalTransportOrder({
    ...(localCurrent || { id: oid }),
    ...localPatch,
  }, { sync_state: isOnline() ? 'synced' : 'pending' });

  if (!isOnline()) {
    await enqueueTransportPatch(oid, remotePatch);
    return localUpdated;
  }

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .update(remotePatch)
      .eq('id', oid)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return localUpdated;
    await saveLocalTransportOrder(data, { sync_state: 'synced' });
    return data;
  } catch (error) {
    await enqueueTransportPatch(oid, remotePatch);
    throw error;
  }
}

// OPTIONAL: update client coords when GPS captured
export async function updateClientCoords(tcode, coords) {
  if (!coords) return { ok: true };
  const tc = String(tcode || '').toUpperCase().trim();
  if (!tc) throw new Error('MISSING_TCODE');

  const patch = sanitizeSharedTransportClientPayload({
    gps_lat: coords?.lat ?? null,
    gps_lng: coords?.lng ?? null,
  }, { mode: 'patch', tcode: tc });

  if (!isOnline()) {
    await pushOp({
      type: 'patch_order_data',
      payload: { table: 'transport_clients', ...patch },
      id: tc,
      created_at: Date.now(),
    });
    return { ok: true, offline: true };
  }

  const { error } = await supabase
    .from('transport_clients')
    .update(patch)
    .eq('tcode', tc);

  if (error) throw error;
  return { ok: true };
}

export async function listTransportOrders(options = {}) {
  const select = options?.select || '*';

  if (!isOnline()) {
    return listTransportOrdersLocal(options);
  }

  let q = supabase.from('transport_orders').select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  const inFilters = options?.in || options?.inFilters || {};
  for (const [key, values] of Object.entries(inFilters)) q = q.in(key, Array.isArray(values) ? values : [values]);
  const ilike = options?.ilike || {};
  for (const [key, value] of Object.entries(ilike)) q = q.ilike(key, value);
  const orFilters = Array.isArray(options?.or) ? options.or : [];
  for (const clause of orFilters) if (clause) q = q.or(clause);
  const gte = options?.gte || {};
  for (const [key, value] of Object.entries(gte)) q = q.gte(key, value);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.secondaryOrderBy) q = q.order(options.secondaryOrderBy, { ascending: !!options?.secondaryAscending });
  if (options?.limit) q = q.limit(options.limit);
  if (typeof q?.timeout === 'function' && (options?.timeoutMs || options?.timeoutLabel)) {
    q = q.timeout(Number(options?.timeoutMs) || 0, String(options?.timeoutLabel || 'SUPABASE_TIMEOUT'));
  }
  if (options?.signal && typeof q?.abortSignal === 'function') {
    q = q.abortSignal(options.signal);
  }

  try {
    const { data, error } = await q;
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    await Promise.all(rows.map((row) => saveLocalTransportOrder(row, { sync_state: 'synced' })));
    return rows;
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '');
    const isAbort =
      error?.name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      /abort/i.test(message);
    const isSoftTimeout = code === 'SUPABASE_TIMEOUT' || /SUPABASE_TIMEOUT/i.test(message);

    if (isAbort && !isSoftTimeout) throw error;
    return listTransportOrdersLocal(options);
  }
}

export async function updateTransportOrdersByIds(ids, patch = {}) {
  const uniq = Array.from(new Set(Array.isArray(ids) ? ids : [])).filter(Boolean);
  if (!uniq.length) return { ok: true, count: 0 };

  const localPayload = { ...(patch || {}), updated_at: patch?.updated_at || nowIso() };
  const remotePayload = sanitizeTransportOrderPayload(localPayload);

  await Promise.all(uniq.map(async (id) => {
    const existing = await getByKey('transport_orders', id);
    await saveLocalTransportOrder({ ...(existing || { id }), ...localPayload }, { sync_state: isOnline() ? 'synced' : 'pending' });
  }));

  if (!isOnline()) {
    await Promise.all(uniq.map((id) => enqueueTransportPatch(id, remotePayload)));
    return { ok: true, count: uniq.length, offline: true };
  }

  try {
    const { error } = await supabase.from('transport_orders').update(remotePayload).in('id', uniq);
    if (error) throw error;
    return { ok: true, count: uniq.length };
  } catch (error) {
    await Promise.all(uniq.map((id) => enqueueTransportPatch(id, remotePayload)));
    return { ok: true, count: uniq.length, offline: true };
  }
}

export async function patchTransportOrderData(id, updater, extraPatch = {}) {
  const current = await fetchTransportOrderById(id);
  const currentData = (current?.data && typeof current.data === 'object') ? current.data : {};
  const nextData = typeof updater === 'function'
    ? (updater(currentData, current) || currentData)
    : { ...currentData, ...(updater || {}) };
  return updateTransportOrderById(id, { ...(extraPatch || {}), data: nextData });
}


export async function searchTransportClientCandidatesByOrders({ transportId = '', query = '', limit = 20, signal = null, timeoutMs = 7000, timeoutLabel = 'TRANSPORT_CLIENT_ORDER_SEARCH_TIMEOUT' } = {}) {
  const tid = String(transportId || '').trim();
  const q = String(query || '').trim();
  if (!q) return [];

  const rows = await listTransportOrders({
    select: 'id, transport_id, client_tcode, client_name, client_phone, code_str, data, created_at, updated_at',
    ...(tid ? { eq: { transport_id: tid } } : {}),
    orderBy: 'created_at',
    ascending: false,
    limit: Math.max(Number(limit || 20) * 3, 60),
    signal,
    timeoutMs,
    timeoutLabel,
  });

  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!matchesTransportSearch(row, q)) continue;
    const meta = getTransportBaseSummary(row);
    const key = [String(meta.code || ''), String(meta.clientPhone || '').replace(/\D+/g, ''), String(meta.clientName || '').trim().toLowerCase()].join('|');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row?.id || null,
      kind: 'order_cache',
      source: 'transport_orders',
      tcode: meta.code || '',
      name: meta.clientName || '',
      phone: meta.clientPhone || '',
      phone_digits: String(meta.clientPhone || '').replace(/\D+/g, ''),
      brought_by: meta.broughtBy || '',
      pieces: Number(meta.pieces || 0),
      address: String(row?.data?.client?.address || row?.data?.address || ''),
      gps_lat: row?.data?.client?.gps?.lat || row?.data?.gps_lat || '',
      gps_lng: row?.data?.client?.gps?.lng || row?.data?.gps_lng || '',
      row,
    });
    if (out.length >= Number(limit || 20)) break;
  }
  return out;
}
