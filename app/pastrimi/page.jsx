'use client';

import React, { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import Link from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout } from '@/lib/supabaseClient';
import { fetchOrderDataById, fetchOrderByIdSafe, listMixedOrderRecords, transitionOrderStatus } from '@/lib/ordersService';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getOutboxSnapshot } from '@/lib/syncManager';
import PosModal from '@/components/PosModal'; // SHTUAR: Për leximin e porosive Offline
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildSmartSmsText } from '@/lib/smartSms';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { clearPageSnapshot, readPageSnapshot, writePageSnapshot } from '@/lib/pageSnapshotCache';
import { fetchRackMapFromDb, normalizeRackSlots } from '@/lib/rackLocations';
import { isTransportBridgeReadyForBase } from '@/lib/transport/bridgeMeta';
import { trackRender } from '@/lib/sensor';
import { clearBaseMasterCacheScope, ensureFreshBaseMasterCache, getBaseRowsByStatus, patchBaseMasterRow, patchBaseMasterRows, reconcileBaseMasterCacheScope, readBaseMasterCache, writeBaseMasterCache } from '@/lib/baseMasterCache';
import { claimResume } from '@/lib/resumeGate';
import useRouteAlive from '@/lib/routeAlive';
import { markRealUiReady } from '@/lib/markRealUiReady';
import { isDiagEnabled } from '@/lib/diagMode';
import { listBaseCreateRecovery } from '@/lib/syncRecovery';
import { listUsers } from '@/lib/usersDb';

const RackLocationModal = React.lazy(() => import('@/components/RackLocationModal'));

function RouteLoadingFallback({ title = 'DUKE HAPUR...' }) {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' }}>
      <div style={{ width: 'min(520px, 100%)', border: '1px solid rgba(96,165,250,.30)', background: 'linear-gradient(180deg,#111827,#070b12)', borderRadius: 22, padding: 18, boxShadow: '0 22px 70px rgba(0,0,0,.55)' }}>
        <div style={{ fontSize: 12, letterSpacing: '.14em', color: '#93c5fd', fontWeight: 1000, marginBottom: 8 }}>TEPIHA</div>
        <div style={{ fontSize: 24, lineHeight: 1.1, fontWeight: 1000 }}>{title}</div>
        <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.45, color: '#cbd5e1' }}>Faqja po hapet. Nuk po bëhet refresh dhe nuk po preken të dhënat.</div>
      </div>
    </div>
  );
}

function fallbackReconciledRows({ baseRows = [], localRows = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (row) => {
    if (!row) return;
    const key = String(row?.id || row?.local_oid || row?.oid || row?.code || JSON.stringify(row)).trim();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(row);
  };
  (Array.isArray(baseRows) ? baseRows : []).forEach(push);
  (Array.isArray(localRows) ? localRows : []).forEach(push);
  return out;
}

async function safeBuildReconciledRows(args = {}) {
  try {
    const mod = await import('@/lib/reconcile/reconcile');
    if (typeof mod?.buildReconciledRows === 'function') return mod.buildReconciledRows(args);
  } catch (err) {
    try { console.warn('[PASTRIMI] reconcile lazy load failed; using fallback merge', err); } catch {}
  }
  return fallbackReconciledRows(args);
}

async function safeRecordReconcileTombstone(payload, options) {
  try {
    const mod = await import('@/lib/reconcile/tombstones');
    if (typeof mod?.recordReconcileTombstone === 'function') return mod.recordReconcileTombstone(payload, options);
  } catch (err) {
    try { console.warn('[PASTRIMI] tombstone lazy load failed; continuing', err); } catch {}
  }
  return null;
}

async function recordCashMoveSafe(payload) {
  const mod = await import('@/lib/arkaCashSync');
  return mod.recordCashMove(payload);
}

function unwrapPayload(p){return p?.data || p || {};}

function readReadyMeta(source, row = {}) {
  const data = unwrapOrderData(source || {});
  const readyNote = String(
    data?.ready_note || row?.ready_note || data?.ready_location || row?.ready_location || data?.ready_note_text || row?.ready_note_text || ''
  ).trim();
  const readyText = String(data?.ready_note_text || row?.ready_note_text || '').trim();
  const readyLocation = String(
    data?.ready_location
      || row?.ready_location
      || ((Array.isArray(data?.ready_slots) ? data.ready_slots : Array.isArray(row?.ready_slots) ? row.ready_slots : []).join(', '))
      || ''
  ).trim();
  const readySlots = normalizeRackSlots(
    Array.isArray(data?.ready_slots)
      ? data.ready_slots
      : Array.isArray(row?.ready_slots)
        ? row.ready_slots
        : (readyLocation || readyNote)
  );
  return {
    readyNote,
    readyText,
    readyLocation,
    readySlots,
    readyNoteAt: data?.ready_note_at || row?.ready_note_at || null,
    readyNoteBy: data?.ready_note_by || row?.ready_note_by || null,
  };
}

function mergeReadyMetaIntoOrder(source, row = {}) {
  const data = unwrapOrderData(source || {});
  const meta = readReadyMeta(data, row);
  const hasReadyMeta = Boolean(
    meta.readyNote || meta.readyText || meta.readyLocation || (Array.isArray(meta.readySlots) && meta.readySlots.length) || meta.readyNoteAt || meta.readyNoteBy
  );
  if (!hasReadyMeta) return data;
  return {
    ...data,
    ready_note: meta.readyNote,
    ready_note_text: meta.readyText,
    ready_location: meta.readyLocation,
    ready_slots: meta.readySlots,
    ready_note_at: meta.readyNoteAt,
    ready_note_by: meta.readyNoteBy,
  };
}

function mapBaseCacheRowToPastrim(row) {
  const data = mergeReadyMetaIntoOrder(row?.data || {}, row || {});
  const total = Number(row?.total_price || data?.price_total || data?.pay?.euro || 0);
  const paid = Number(row?.paid_amount || data?.paid_cash || data?.pay?.paid || 0);
  const computedM2 = computeM2(data);
  const computedPieces = computePieces(data);
  return {
    id: String(row?.id || row?.local_oid || ''),
    local_oid: row?.local_oid || null,
    status: normalizeStatus(row?.status || data?.status || 'pastrim') || 'pastrim',
    source: 'BASE_CACHE',
    ts: Number(Date.parse(row?.updated_at || row?.created_at || 0) || Date.now()),
    name: row?.client_name || data?.client_name || data?.client?.name || 'Pa Emër',
    phone: row?.client_phone || data?.client_phone || data?.client?.phone || '',
    code: normalizeCode(row?.code || data?.code || data?.client?.code || ''),
    m2: Number((computedM2 > 0 ? computedM2 : (row?.total_m2 || 0)) || 0),
    cope: Number((computedPieces > 0 ? computedPieces : (row?.pieces || 0)) || 0),
    total,
    paid,
    isPaid: paid >= total && total > 0,
    isReturn: !!data?.returnInfo?.active,
    fullOrder: data,
    _masterCache: true,
  };
}

function readPastrimRowsFromBaseMasterCache(cache = null) {
  try {
    return [
      ...(getBaseRowsByStatus('pastrim', cache) || []),
      ...(getBaseRowsByStatus('pastrimi', cache) || []),
    ].map(mapBaseCacheRowToPastrim);
  } catch {
    return [];
  }
}


function readPastrimRowsFromPageSnapshot() {
  try {
    const snapshot = readPageSnapshot('pastrimi');
    return (Array.isArray(snapshot?.rows) ? snapshot.rows : [])
      .map((row) => normalizeRenderableOrderRow({
        ...(row && typeof row === 'object' ? row : {}),
        source: String(row?.source || 'PAGE_SNAPSHOT'),
        _pageSnapshot: true,
      }))
      .filter((row) => shouldShowTransportBridgeInPastrim(row));
  } catch {
    return [];
  }
}

function persistPastrimPageSnapshot(rows = [], meta = {}) {
  try {
    const cleanRows = dedupePastrimRows((Array.isArray(rows) ? rows : []).map((row) => normalizeRenderableOrderRow(row)))
      .filter((row) => shouldShowTransportBridgeInPastrim(row))
      .map((row) => {
        const next = row && typeof row === 'object' ? { ...row } : row;
        if (next && typeof next === 'object') {
          delete next._pageSnapshot;
          delete next._masterCache;
        }
        return next;
      });
    if (cleanRows.length > 0) writePageSnapshot('pastrimi', cleanRows, meta);
    else clearPageSnapshot('pastrimi');
  } catch {}
}

// --- CONFIG ---
const BUCKET = 'tepiha-photos';
const LOCAL_ORDERS_KEY = 'tepiha_local_orders_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DAILY_CAPACITY_M2 = 400;
const STREAM_MAX_M2 = 450;
const PASRTRIMI_EDIT_TO_PRANIMI_KEY = 'tepiha_pastrim_edit_to_pranimi_v1';
const PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_pastrim_edit_to_pranimi_backup_v1';
const PRANIMI_ACTIVE_EDIT_BRIDGE_KEY = 'tepiha_pranimi_active_edit_bridge_v1';
const PRANIMI_RESET_ON_SHOW_KEY = 'tepiha_pranimi_reset_on_show_v1';
const PASRTRIMI_FETCH_LIMIT = 48;
const PASRTRIMI_INITIAL_LOCAL_TIMEOUT_MS = 2200;
const PASRTRIMI_REMOTE_REFRESH_TIMEOUT_MS = 3500;
const PASTRIMI_LOADING_TIMEOUT_MARKER_KEY = 'tepiha_pastrimi_loading_timeout_v1';
const PASTRIMI_TRANSPORT_EXIT_TOMBSTONES_KEY = 'tepiha_pastrimi_transport_exit_tombstones_v1';
const PASTRIMI_TRANSPORT_EXIT_TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 48;
const PASRTRIMI_REFRESH_MIN_GAP_MS = 2200;
const PASRTRIMI_LOCAL_PERSIST_LIMIT = 36;
const PASRTRIMI_LOCAL_PERSIST_MIN_GAP_MS = 10000;
const PASRTRIMI_SUCCESS_REFRESH_COOLDOWN_MS = 45000;
const PASRTRIMI_RESUME_REFRESH_MIN_GAP_MS = 18000;
const PASRTRIMI_REALTIME_FULL_REFRESH_DELAY_MS = 22000;
const PASRTRIMI_REALTIME_FULL_REFRESH_MIN_GAP_MS = 45000;
const PASRTRIMI_REALTIME_EVENT_DEDUPE_MS = 1200;

// FIX: Timeout 7s për mbrojtjen e Safari
function withTimeout(promise, ms = 7000) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      try { clearTimeout(t); } catch (e) {}
    }),
    timeout,
  ]);
}

// ---------------- HELPERS ----------------

function getGhostBlacklist() {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]'); } catch { return []; }
}

function isDocumentVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible';
}

function normalizeCode(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}


function sanitizeBridgePhotoUrl(value) {
  return typeof value === 'string' ? value : '';
}

function sanitizeBridgeItemRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    m2: String(row?.m2 ?? row?.m ?? row?.area ?? ''),
    qty: String(row?.qty ?? row?.pieces ?? ''),
    photoUrl: sanitizeBridgePhotoUrl(row?.photoUrl || row?.photo || ''),
  }));
}

function buildCompactPranimiEditPayload({
  source = 'orders',
  safeDbId = null,
  localOid = '',
  code = '',
  ts = Date.now(),
  order = {},
}) {
  const ord = order && typeof order === 'object' ? order : {};
  const ordData = ord?.data && typeof ord.data === 'object' ? ord.data : {};
  const client = ord?.client && typeof ord.client === 'object' ? ord.client : (ordData?.client && typeof ordData.client === 'object' ? ordData.client : {});
  const tepiha = sanitizeBridgeItemRows(Array.isArray(ord?.tepiha) ? ord.tepiha : ordData?.tepiha);
  const staza = sanitizeBridgeItemRows(Array.isArray(ord?.staza) ? ord.staza : ordData?.staza);
  const shkallore = ord?.shkallore && typeof ord.shkallore === 'object'
    ? ord.shkallore
    : (ordData?.shkallore && typeof ordData.shkallore === 'object' ? ordData.shkallore : {});
  const pay = ord?.pay && typeof ord.pay === 'object' ? ord.pay : (ordData?.pay && typeof ordData.pay === 'object' ? ordData.pay : {});
  const stableCode = String(normalizeCode(code || ord?.code || ord?.code_n || client?.code || '') || '').trim();
  const stableLocalOid = String(localOid || ord?.local_oid || ordData?.local_oid || ord?.oid || '').trim();
  const clientName = String(client?.name || ord?.client_name || ordData?.client_name || '').trim();
  const clientPhone = String(client?.phone || ord?.client_phone || ordData?.client_phone || '').trim();
  const clientPhoto = sanitizeBridgePhotoUrl(client?.photoUrl || client?.photo || ord?.client_photo_url || ordData?.client_photo_url || '');
  const compactOrder = {
    id: safeDbId !== null ? String(safeDbId) : String(ord?.id || ''),
    db_id: safeDbId,
    oid: stableLocalOid || String(ord?.oid || ''),
    local_oid: stableLocalOid,
    code: stableCode,
    code_n: stableCode,
    client_name: clientName,
    client_phone: clientPhone,
    client_photo_url: clientPhoto,
    client: {
      name: clientName,
      phone: clientPhone,
      code: stableCode,
      photoUrl: clientPhoto,
      photo: clientPhoto,
    },
    tepiha,
    staza,
    shkallore: {
      qty: Number(shkallore?.qty ?? ord?.stairsQty ?? ordData?.stairsQty ?? 0) || 0,
      per: Number(shkallore?.per ?? ord?.stairsPer ?? ordData?.stairsPer ?? SHKALLORE_M2_PER_STEP_DEFAULT) || SHKALLORE_M2_PER_STEP_DEFAULT,
      photoUrl: sanitizeBridgePhotoUrl(shkallore?.photoUrl || ord?.stairsPhotoUrl || ordData?.stairsPhotoUrl || ''),
    },
    stairsQty: Number(shkallore?.qty ?? ord?.stairsQty ?? ordData?.stairsQty ?? 0) || 0,
    stairsPer: Number(shkallore?.per ?? ord?.stairsPer ?? ordData?.stairsPer ?? SHKALLORE_M2_PER_STEP_DEFAULT) || SHKALLORE_M2_PER_STEP_DEFAULT,
    stairsPhotoUrl: sanitizeBridgePhotoUrl(shkallore?.photoUrl || ord?.stairsPhotoUrl || ordData?.stairsPhotoUrl || ''),
    pay: {
      rate: Number(pay?.rate ?? pay?.price ?? ord?.pricePerM2 ?? ordData?.pricePerM2 ?? PRICE_DEFAULT) || PRICE_DEFAULT,
      price: Number(pay?.price ?? pay?.rate ?? ord?.pricePerM2 ?? ordData?.pricePerM2 ?? PRICE_DEFAULT) || PRICE_DEFAULT,
      paid: Number(pay?.paid ?? ord?.clientPaid ?? ordData?.clientPaid ?? 0) || 0,
      arkaRecordedPaid: Number(pay?.arkaRecordedPaid ?? ord?.arkaRecordedPaid ?? ordData?.arkaRecordedPaid ?? 0) || 0,
      method: String(pay?.method || ord?.payMethod || ordData?.payMethod || 'CASH'),
    },
    pricePerM2: Number(pay?.rate ?? pay?.price ?? ord?.pricePerM2 ?? ordData?.pricePerM2 ?? PRICE_DEFAULT) || PRICE_DEFAULT,
    clientPaid: Number(pay?.paid ?? ord?.clientPaid ?? ordData?.clientPaid ?? 0) || 0,
    arkaRecordedPaid: Number(pay?.arkaRecordedPaid ?? ord?.arkaRecordedPaid ?? ordData?.arkaRecordedPaid ?? 0) || 0,
    payMethod: String(pay?.method || ord?.payMethod || ordData?.payMethod || 'CASH'),
    notes: String(ord?.notes || ordData?.notes || ''),
    status: String(ord?.status || ordData?.status || ''),
  };
  compactOrder.data = {
    local_oid: stableLocalOid,
    oid: stableLocalOid || compactOrder.oid,
    client_name: compactOrder.client_name,
    client_phone: compactOrder.client_phone,
    client_photo_url: compactOrder.client_photo_url,
    client: { ...compactOrder.client },
    tepiha: compactOrder.tepiha,
    staza: compactOrder.staza,
    shkallore: { ...compactOrder.shkallore },
    stairsQty: compactOrder.stairsQty,
    stairsPer: compactOrder.stairsPer,
    stairsPhotoUrl: compactOrder.stairsPhotoUrl,
    pay: { ...compactOrder.pay },
    pricePerM2: compactOrder.pricePerM2,
    clientPaid: compactOrder.clientPaid,
    arkaRecordedPaid: compactOrder.arkaRecordedPaid,
    payMethod: compactOrder.payMethod,
    notes: compactOrder.notes,
    status: compactOrder.status,
  };
  return {
    source,
    edit_mode: 'update_same_order',
    db_id: safeDbId,
    local_oid: stableLocalOid,
    id: safeDbId !== null ? String(safeDbId) : '',
    ts: Number(ts || Date.now()),
    code: stableCode,
    order: compactOrder,
  };
}



function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function firstNumberValue(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function firstNonEmptyBridgeRows(...groups) {
  for (const group of groups) {
    const rows = sanitizeBridgeItemRows(Array.isArray(group) ? group : []);
    const clean = rows.filter((row) => String(row?.m2 || row?.qty || row?.photoUrl || '').trim());
    if (clean.length > 0) return clean;
  }
  return [];
}

function mergePastrimEditOrderForBridge(item = {}, fetchedRow = null) {
  const itemOrder = unwrapOrderData(item?.fullOrder || item?.data || {});
  const fetchedData = unwrapOrderData(fetchedRow?.data || {});
  const merged = {
    ...(itemOrder && typeof itemOrder === 'object' ? itemOrder : {}),
    ...(fetchedData && typeof fetchedData === 'object' ? fetchedData : {}),
  };

  const fetchedClient = (fetchedData?.client && typeof fetchedData.client === 'object') ? fetchedData.client : {};
  const itemClient = (itemOrder?.client && typeof itemOrder.client === 'object') ? itemOrder.client : {};
  const codeValue = normalizeCode(
    firstNonEmptyString(
      fetchedData?.client?.code,
      fetchedData?.code,
      fetchedRow?.code,
      itemClient?.code,
      itemOrder?.code,
      itemOrder?.code_n,
      item?.code
    )
  );
  const codeText = codeValue != null ? String(codeValue) : firstNonEmptyString(item?.code, itemOrder?.code, fetchedData?.code);
  const clientName = firstNonEmptyString(
    fetchedClient?.name,
    fetchedData?.client_name,
    fetchedRow?.client_name,
    itemClient?.name,
    itemOrder?.client_name,
    item?.name
  );
  const clientPhone = firstNonEmptyString(
    fetchedClient?.phone,
    fetchedData?.client_phone,
    fetchedRow?.client_phone,
    itemClient?.phone,
    itemOrder?.client_phone,
    item?.phone
  );
  const clientPhoto = firstNonEmptyString(
    fetchedClient?.photoUrl,
    fetchedClient?.photo,
    fetchedData?.client_photo_url,
    itemClient?.photoUrl,
    itemClient?.photo,
    itemOrder?.client_photo_url,
    item?.clientPhotoUrl,
    item?.client_photo_url
  );

  const tepiha = firstNonEmptyBridgeRows(
    fetchedData?.tepiha,
    fetchedData?.tepihaRows,
    itemOrder?.tepiha,
    itemOrder?.tepihaRows,
    item?.tepiha,
    item?.tepihaRows
  );
  const staza = firstNonEmptyBridgeRows(
    fetchedData?.staza,
    fetchedData?.stazaRows,
    itemOrder?.staza,
    itemOrder?.stazaRows,
    item?.staza,
    item?.stazaRows
  );

  const fetchedStairs = (fetchedData?.shkallore && typeof fetchedData.shkallore === 'object') ? fetchedData.shkallore : {};
  const itemStairs = (itemOrder?.shkallore && typeof itemOrder.shkallore === 'object') ? itemOrder.shkallore : {};
  const stairsQty = firstNumberValue(fetchedStairs?.qty, fetchedData?.stairsQty, itemStairs?.qty, itemOrder?.stairsQty);
  const stairsPer = firstNumberValue(fetchedStairs?.per, fetchedData?.stairsPer, itemStairs?.per, itemOrder?.stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT;
  const stairsPhotoUrl = firstNonEmptyString(fetchedStairs?.photoUrl, fetchedData?.stairsPhotoUrl, itemStairs?.photoUrl, itemOrder?.stairsPhotoUrl);

  const fetchedPay = (fetchedData?.pay && typeof fetchedData.pay === 'object') ? fetchedData.pay : {};
  const itemPay = (itemOrder?.pay && typeof itemOrder.pay === 'object') ? itemOrder.pay : {};
  const rate = firstNumberValue(fetchedPay?.rate, fetchedPay?.price, fetchedData?.pricePerM2, itemPay?.rate, itemPay?.price, itemOrder?.pricePerM2, PRICE_DEFAULT) || PRICE_DEFAULT;
  const totalEuro = firstNumberValue(fetchedPay?.euro, fetchedPay?.total, fetchedData?.price_total, itemPay?.euro, itemPay?.total, itemOrder?.price_total, item?.total);
  const paid = firstNumberValue(fetchedPay?.paid, fetchedData?.clientPaid, itemPay?.paid, itemOrder?.clientPaid, item?.paid);
  const arkaPaid = firstNumberValue(fetchedPay?.arkaRecordedPaid, fetchedData?.arkaRecordedPaid, itemPay?.arkaRecordedPaid, itemOrder?.arkaRecordedPaid);
  const localOid = normalizeLocalOidValue(
    fetchedRow?.local_oid,
    fetchedData?.local_oid,
    fetchedData?.oid,
    item?.local_oid,
    itemOrder?.local_oid,
    itemOrder?.oid
  );

  return {
    ...merged,
    id: fetchedRow?.id != null ? String(fetchedRow.id) : String(itemOrder?.id || item?.id || ''),
    db_id: fetchedRow?.id != null ? String(fetchedRow.id) : String(item?.db_id || itemOrder?.db_id || ''),
    local_oid: localOid,
    oid: localOid || String(itemOrder?.oid || item?.id || ''),
    status: firstNonEmptyString(fetchedRow?.status, fetchedData?.status, itemOrder?.status, item?.status, 'pastrim'),
    code: codeText,
    code_n: codeText,
    client_name: clientName,
    client_phone: clientPhone,
    client_photo_url: clientPhoto,
    client: {
      ...(itemClient || {}),
      ...(fetchedClient || {}),
      name: clientName,
      phone: clientPhone,
      code: codeText,
      photoUrl: clientPhoto,
      photo: clientPhoto,
    },
    tepiha,
    staza,
    shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
    tepihaRows: tepiha,
    stazaRows: staza,
    stairsQty,
    stairsPer,
    stairsPhotoUrl,
    pay: {
      ...(itemPay || {}),
      ...(fetchedPay || {}),
      rate,
      price: rate,
      euro: totalEuro || fetchedPay?.euro || itemPay?.euro || 0,
      paid: paid || 0,
      arkaRecordedPaid: arkaPaid || 0,
      method: firstNonEmptyString(fetchedPay?.method, fetchedData?.payMethod, itemPay?.method, itemOrder?.payMethod, 'CASH'),
    },
    pricePerM2: rate,
    clientPaid: paid || 0,
    arkaRecordedPaid: arkaPaid || 0,
    payMethod: firstNonEmptyString(fetchedPay?.method, fetchedData?.payMethod, itemPay?.method, itemOrder?.payMethod, 'CASH'),
    notes: firstNonEmptyString(fetchedData?.notes, itemOrder?.notes, item?.notes),
  };
}

function normalizeLocalOidValue(...values) {
  const candidates = values.map((value) => String(value || '').trim()).filter(Boolean);
  const preferred = candidates.find((value) => value && !/^\d+$/.test(value));
  return preferred || candidates[0] || '';
}

function normalizeRenderableOrderRow(row) {
  if (!row || typeof row !== 'object') return row;
  const order = mergeReadyMetaIntoOrder(row?.fullOrder || row?.data || {}, row || {});
  const localOid = normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid);
  const next = { ...row };
  if (localOid) next.local_oid = localOid;
  if (Object.prototype.hasOwnProperty.call(next, 'fullOrder')) {
    next.fullOrder = localOid && !String(order?.local_oid || '').trim() ? { ...order, local_oid: localOid } : order;
  }
  if (next?.data && typeof next.data === 'object' && !Array.isArray(next.data)) {
    next.data = localOid && !String(order?.local_oid || '').trim() ? { ...order, local_oid: localOid } : order;
  }
  return next;
}

function getRowLocalOid(row) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  return normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid);
}

function getRowPrimaryKey(row) {
  const localOid = getRowLocalOid(row);
  if (localOid) return `local:${localOid}`;
  const id = String(row?.id || '').trim();
  if (id && isPersistedDbLikeId(id)) return `id:${id}`;
  return id ? `id:${id}` : '';
}

function getRowMatchTokens(row) {
  const tokens = new Set();
  const localOid = getRowLocalOid(row);
  const id = String(row?.id || '').trim();
  if (localOid) tokens.add(`local:${localOid}`);
  if (id && isPersistedDbLikeId(id)) tokens.add(`id:${id}`);
  return Array.from(tokens);
}

function rowsOverlap(a, b) {
  const aTokens = getRowMatchTokens(a);
  if (!aTokens.length) return false;
  const bSet = new Set(getRowMatchTokens(b));
  return aTokens.some((t) => bSet.has(t));
}

function getPastrimTransportCode(row) {
  if (!row || typeof row !== 'object') return '';
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const markerValues = [
    row?.source, row?.table, row?._table, row?._source,
    order?.source, order?.table, order?._table, order?._source,
  ].map((x) => String(x || '').trim().toLowerCase());
  const hasTransportMarker = markerValues.includes('transport_orders') || Boolean(
    row?.transport_id || row?.transportId || row?.transport || row?.transport_meta || row?.transportOrder ||
    order?.transport_id || order?.transportId || order?.transport || order?.transport_meta || order?.transportOrder
  );
  const candidates = [
    row?.code, row?.code_str, row?.client_tcode, row?.client_code, row?.order_code, row?.transport_code,
    row?.client?.tcode, row?.client?.code,
    order?.code, order?.code_str, order?.client_tcode, order?.client_code, order?.order_code, order?.transport_code,
    order?.client?.tcode, order?.client?.code, order?.transport?.code, order?.transport?.tcode,
  ];
  for (const raw of candidates) {
    const text = String(raw || '').trim();
    if (!text || text === '—') continue;
    const explicitT = /^T\s*0*\d+$/i.test(text);
    const numericTransportCode = hasTransportMarker && /^\d+$/.test(text);
    if (!explicitT && !numericTransportCode) continue;
    const digits = text.replace(/\D+/g, '').replace(/^0+/, '');
    if (!digits) continue;
    return `T${digits}`;
  }
  return '';
}

function isPastrimTransportScopedRow(row) {
  if (!row || typeof row !== 'object') return false;
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const markerValues = [
    row?.source, row?.table, row?._table, row?._source,
    order?.source, order?.table, order?._table, order?._source,
  ].map((x) => String(x || '').trim().toLowerCase());
  if (markerValues.includes('transport_orders')) return true;
  if (getPastrimTransportCode(row)) return true;
  if (
    row?.transport_id || row?.transportId || row?.transport || row?.transport_meta || row?.transportOrder ||
    order?.transport_id || order?.transportId || order?.transport || order?.transport_meta || order?.transportOrder
  ) return true;
  return false;
}

function getPastrimRowScope(row) {
  if (isPastrimTransportScopedRow(row)) return 'transport_orders';
  const raw = String(row?.table || row?._table || row?.source || '').trim();
  if (raw === 'orders' || raw === 'BASE_CACHE' || raw === 'LOCAL' || raw === 'PAGE_SNAPSHOT' || raw === 'OUTBOX') return 'orders';
  return raw || 'row';
}

function getPastrimCanonicalTokens(row) {
  const tokens = new Set(getRowMatchTokens(row));
  if (!row || typeof row !== 'object') return Array.from(tokens);
  const scope = getPastrimRowScope(row);
  const id = String(row?.id || row?.db_id || row?.order_id || '').trim();
  const localOid = getRowLocalOid(row);
  const transportCode = getPastrimTransportCode(row);
  if (transportCode) tokens.add(`transport:code:${transportCode}`);
  if (id) tokens.add(`${scope}:id:${id}`);
  if (localOid) tokens.add(`${scope}:local:${localOid}`);
  return Array.from(tokens).filter(Boolean);
}

function rowsOverlapPastrimCanonical(a, b) {
  const aTokens = getPastrimCanonicalTokens(a);
  if (!aTokens.length) return false;
  const bSet = new Set(getPastrimCanonicalTokens(b));
  return aTokens.some((t) => bSet.has(t));
}

function isSamePastrimTransportRow(a, b) {
  if (!isPastrimTransportScopedRow(a) && !isPastrimTransportScopedRow(b)) return false;
  if (rowsOverlapPastrimCanonical(a, b)) return true;
  const aCode = getPastrimTransportCode(a);
  const bCode = getPastrimTransportCode(b);
  return !!aCode && !!bCode && aCode === bCode;
}

function removePastrimTransportRowsFromPageSnapshot(target, reason = 'transport_pastrim_cleanup') {
  try {
    if (!isPastrimTransportScopedRow(target)) return;
    const snapshot = readPageSnapshot('pastrimi');
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    if (!rows.length) return;
    const normalizedTarget = normalizeRenderableOrderRow({
      ...(target && typeof target === 'object' ? target : {}),
      source: target?.source || 'transport_orders',
      _table: target?._table || target?.table || 'transport_orders',
    });
    const filteredRows = rows.filter((row) => !isSamePastrimTransportRow(normalizeRenderableOrderRow(row), normalizedTarget));
    if (filteredRows.length === rows.length) return;
    if (filteredRows.length > 0) {
      writePageSnapshot('pastrimi', filteredRows, {
        ...(snapshot?.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {}),
        source: reason,
        count: filteredRows.length,
      });
    } else {
      clearPageSnapshot('pastrimi');
    }
  } catch {}
}


function getPastrimTransportExitIdentity(row) {
  const base = row && typeof row === 'object' ? row : {};
  const order = unwrapOrderData(base?.fullOrder || base?.data || base || {});
  const fullOrderData = asPastrimObj(base?.fullOrder?.data);
  const id = String(base?.id || base?.db_id || base?.order_id || order?.id || '').trim();
  const localOid = normalizeLocalOidValue(
    base?.local_oid,
    base?.oid,
    base?.fullOrder?.local_oid,
    base?.fullOrder?.oid,
    base?.data?.local_oid,
    base?.data?.oid,
    order?.local_oid,
    order?.oid,
    fullOrderData?.local_oid,
    fullOrderData?.oid
  );
  const transportCode = getPastrimTransportCode(base);
  return { id, localOid: String(localOid || '').trim(), transportCode };
}

function readPastrimTransportExitTombstones() {
  if (typeof window === 'undefined') return [];
  try {
    const now = Date.now();
    const raw = JSON.parse(window.localStorage?.getItem?.(PASTRIMI_TRANSPORT_EXIT_TOMBSTONES_KEY) || '[]');
    const rows = (Array.isArray(raw) ? raw : []).filter((item) => {
      const at = Number(item?.at || 0);
      return at > 0 && now - at < PASTRIMI_TRANSPORT_EXIT_TOMBSTONE_TTL_MS;
    });
    if (rows.length !== (Array.isArray(raw) ? raw.length : 0)) {
      window.localStorage?.setItem?.(PASTRIMI_TRANSPORT_EXIT_TOMBSTONES_KEY, JSON.stringify(rows));
    }
    return rows;
  } catch {
    return [];
  }
}

function markPastrimTransportExitTombstone(target, reason = 'transport_left_pastrim') {
  try {
    if (typeof window === 'undefined') return;
    const normalized = normalizeRenderableOrderRow({
      ...(target && typeof target === 'object' ? target : {}),
      source: target?.source || 'transport_orders',
      table: target?.table || target?._table || 'transport_orders',
      _table: target?._table || target?.table || 'transport_orders',
    });
    const identity = getPastrimTransportExitIdentity(normalized);
    if (!identity.id && !identity.localOid && !identity.transportCode) return;
    const now = Date.now();
    const rows = readPastrimTransportExitTombstones();
    const next = rows.filter((item) => !(
      (!!identity.id && String(item?.id || '') === identity.id) ||
      (!!identity.localOid && String(item?.localOid || '') === identity.localOid) ||
      (!!identity.transportCode && String(item?.transportCode || '') === identity.transportCode)
    ));
    next.unshift({ ...identity, at: now, reason });
    window.localStorage?.setItem?.(PASTRIMI_TRANSPORT_EXIT_TOMBSTONES_KEY, JSON.stringify(next.slice(0, 80)));
  } catch {}
}

function isPastrimTransportExitTombstoned(row) {
  try {
    const identity = getPastrimTransportExitIdentity(row);
    if (!identity.id && !identity.localOid && !identity.transportCode) return false;
    const tombstones = readPastrimTransportExitTombstones();
    return tombstones.some((item) => (
      (!!identity.id && !!item?.id && String(item.id) === identity.id) ||
      (!!identity.localOid && !!item?.localOid && String(item.localOid) === identity.localOid) ||
      (!!identity.transportCode && !!item?.transportCode && String(item.transportCode) === identity.transportCode)
    ));
  } catch {
    return false;
  }
}

function pastrimRowMatchesCleanupTarget(row, target) {
  try {
    const a = getPastrimTransportExitIdentity(row);
    const b = getPastrimTransportExitIdentity(target);
    if (!!a.id && !!b.id && a.id === b.id) return true;
    if (!!a.localOid && !!b.localOid && a.localOid === b.localOid) return true;
    if (!!a.transportCode && !!b.transportCode && a.transportCode === b.transportCode) return true;
    return isSamePastrimTransportRow(row, target);
  } catch {
    return false;
  }
}

function removePastrimTransportRowsFromLocalCaches(target, reason = 'transport_pastrim_cleanup') {
  try {
    if (!isPastrimTransportScopedRow(target) && !getPastrimTransportExitIdentity(target).id) return;
    const normalizedTarget = normalizeRenderableOrderRow({
      ...(target && typeof target === 'object' ? target : {}),
      source: target?.source || 'transport_orders',
      table: target?.table || target?._table || 'transport_orders',
      _table: target?._table || target?.table || 'transport_orders',
    });
    markPastrimTransportExitTombstone(normalizedTarget, reason);
    removePastrimTransportRowsFromPageSnapshot(normalizedTarget, reason);

    try {
      const cache = readBaseMasterCache();
      const rows = Array.isArray(cache?.rows) ? cache.rows : [];
      const filtered = rows.filter((item) => !pastrimRowMatchesCleanupTarget(normalizeRenderableOrderRow(item), normalizedTarget));
      if (filtered.length !== rows.length) writeBaseMasterCache({ ...cache, rows: filtered });
    } catch {}

    try {
      const raw = window.localStorage?.getItem?.(LOCAL_ORDERS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((item) => !pastrimRowMatchesCleanupTarget(normalizeRenderableOrderRow(item), normalizedTarget));
          if (filtered.length !== parsed.length) window.localStorage?.setItem?.(LOCAL_ORDERS_KEY, JSON.stringify(filtered));
        } else if (parsed && typeof parsed === 'object') {
          let changed = false;
          const next = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (pastrimRowMatchesCleanupTarget(normalizeRenderableOrderRow({ ...(value && typeof value === 'object' ? value : {}), id: value?.id || key }), normalizedTarget)) {
              changed = true;
            } else {
              next[key] = value;
            }
          }
          if (changed) window.localStorage?.setItem?.(LOCAL_ORDERS_KEY, JSON.stringify(next));
        }
      }
    } catch {}
  } catch {}
}

function choosePastrimWinner(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const priorityOf = (row) => {
    const source = String(row?.source || '').trim();
    if (source === 'transport_orders') return 600;
    if (source === 'orders') return 500;
    if (source === 'OUTBOX') return 400;
    if (source === 'PAGE_SNAPSHOT') return 300;
    if (source === 'LOCAL') return 200;
    if (source === 'BASE_CACHE') return 100;
    return 0;
  };
  const incomingPriority = priorityOf(incoming);
  const existingPriority = priorityOf(existing);
  if (incomingPriority > existingPriority) return incoming;
  if (incomingPriority < existingPriority) return existing;
  return Number(incoming?.ts || 0) >= Number(existing?.ts || 0) ? incoming : existing;
}

function describePastrimRow(row) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  const status = normalizeStatus(row?.status || order?.status || '');
  const info = {
    id: String(row?.id || '').trim(),
    code: String(row?.code || order?.client?.code || order?.code || '').trim(),
    status,
    local_oid: getRowLocalOid(row),
    source: String(row?.source || '').trim(),
    _local: row?._local === true,
    _synced: row?._synced === false ? false : row?._synced === true ? true : null,
    _syncPending: row?._syncPending === true || row?._outboxPending === true,
  };
  info.pendingLike = rowLooksPendingOrLocal(row);
  info.localReadyLike = isLocalReadyTransitionRow(row);
  return info;
}

function pushPastrimTrace(trace, stage, row, action, reason = '') {
  if (!Array.isArray(trace)) return;
  try {
    trace.push({ stage, action, reason, ...describePastrimRow(row) });
  } catch {}
}

function rowLooksPendingOrLocal(row) {
  const source = String(row?.source || '').trim();
  if (source === 'orders' || source === 'transport_orders' || source === 'BASE_CACHE') return false;
  return !!(row?._outboxPending || row?._local || row?._synced === false || source === 'LOCAL' || source === 'OUTBOX');
}

function isTransportScopedRow(row) {
  return isPastrimTransportScopedRow(row);
}

function asPastrimObj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function collectTransportStatusSourcesForPastrim(row) {
  const base = asPastrimObj(row);
  const data = asPastrimObj(base?.data);
  const fullOrder = asPastrimObj(base?.fullOrder);
  const fullOrderData = asPastrimObj(fullOrder?.data);
  const unwrappedData = unwrapOrderData(data);
  const unwrappedFullOrder = unwrapOrderData(fullOrder);
  const transportNodes = [
    base?.transport, base?.transport_meta, base?.transportOrder,
    data?.transport, data?.transport_meta, data?.transportOrder,
    fullOrder?.transport, fullOrder?.transport_meta, fullOrder?.transportOrder,
    fullOrderData?.transport, fullOrderData?.transport_meta, fullOrderData?.transportOrder,
    unwrappedData?.transport, unwrappedData?.transport_meta, unwrappedData?.transportOrder,
    unwrappedFullOrder?.transport, unwrappedFullOrder?.transport_meta, unwrappedFullOrder?.transportOrder,
  ].map(asPastrimObj);

  const rawStatuses = [
    base?.status,
    base?.state,
    data?.status,
    data?.state,
    fullOrder?.status,
    fullOrder?.state,
    fullOrderData?.status,
    fullOrderData?.state,
    unwrappedData?.status,
    unwrappedData?.state,
    unwrappedFullOrder?.status,
    unwrappedFullOrder?.state,
    ...transportNodes.flatMap((node) => [node?.status, node?.state]),
  ];

  return Array.from(new Set(rawStatuses
    .map((status) => normalizeTransportPastrimStatus(status))
    .filter(Boolean)));
}

function getTransportEffectiveStatusForPastrim(row) {
  const statuses = collectTransportStatusSourcesForPastrim(row);
  return statuses.find((status) => TRANSPORT_PASTRIMI_BLOCKED_STATUS_SET.has(status))
    || statuses.find((status) => TRANSPORT_PASTRIMI_STATUS_SET.has(status))
    || statuses[0]
    || '';
}

function transportRowAllowedInPastrim(row) {
  if (!isTransportScopedRow(row)) return true;
  const statuses = collectTransportStatusSourcesForPastrim(row);
  if (statuses.some((status) => TRANSPORT_PASTRIMI_BLOCKED_STATUS_SET.has(status))) return false;
  return statuses.some((status) => TRANSPORT_PASTRIMI_STATUS_SET.has(status));
}

function shouldShowTransportBridgeInPastrim(row) {
  if (isPastrimTransportExitTombstoned(row)) return false;
  if (!isTransportScopedRow(row)) return true;
  if (!transportRowAllowedInPastrim(row)) return false;
  const effectiveStatus = getTransportEffectiveStatusForPastrim(row);
  return isTransportBridgeReadyForBase({
    ...(row && typeof row === 'object' ? row : {}),
    status: effectiveStatus,
    data: row?.fullOrder || row?.data || row,
  });
}

function isLocalReadyTransitionRow(o) {
  const id = String(o?.id || '').trim();
  const source = String(o?.source || '').trim();
  if (source === 'orders' || source === 'transport_orders' || source === 'BASE_CACHE') return false;
  if (id && isPersistedDbLikeId(id)) return false;
  return (
    source === 'LOCAL' ||
    source === 'OUTBOX' ||
    !!o?._local ||
    o?._synced === false ||
    /^order_/i.test(id) ||
    /^ord_/i.test(id)
  );
}

function getReadyTargetTable(o) {
  if (isPastrimTransportScopedRow(o)) return 'transport_orders';
  return 'orders';
}

function normalizeOrder(input){
  const raw = input && typeof input === 'object' && 'data' in input ? input.data : input;
  return unwrapOrderData(raw);
}

function normalizeStatus(s){
  const st = String(s || '').toLowerCase().trim();
  if (!st) return '';
  if (st === 'pastrimi') return 'pastrim';
  if (st === 'pranimi') return 'pranim';
  if (st === 'gati') return 'gati';
  if (st === 'marrje_sot' || st === 'marrje') return 'marrje';
  return st;
}

const TRANSPORT_PASTRIMI_STATUSES = ['pastrim', 'pastrimi', 'at_base', 'in_base', 'base'];
const TRANSPORT_PASTRIMI_STATUS_SET = new Set(TRANSPORT_PASTRIMI_STATUSES.map((x) => normalizeStatus(x)));
const TRANSPORT_PASTRIMI_BLOCKED_STATUSES = ['gati', 'ready', 'done', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar', 'canceled', 'cancelled', 'failed'];
const TRANSPORT_PASTRIMI_BLOCKED_STATUS_SET = new Set(TRANSPORT_PASTRIMI_BLOCKED_STATUSES.map((x) => normalizeStatus(x)));

function normalizeTransportPastrimStatus(status = '') {
  const st = normalizeStatus(status);
  if (st === 'ngarkuar') return 'loaded';
  return st;
}

function isTransportVisibleInPastrimStatus(status = '') {
  return TRANSPORT_PASTRIMI_STATUS_SET.has(normalizeTransportPastrimStatus(status));
}

function computeOrderDisplayTotal(order = {}) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const candidates = [
    order?.pay?.euro,
    data?.pay?.euro,
    order?.totals?.grandTotal,
    order?.totals?.grand_total,
    data?.totals?.grandTotal,
    data?.totals?.grand_total,
    order?.totals?.total,
    data?.totals?.total,
    order?.total,
    data?.total,
    order?.price_total,
    data?.price_total,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function unwrapOrderData(raw) {
  let o = raw;
  if (!o) return {};
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  if (o && o.data) {
    let d = o.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (d && (d.client || d.tepiha || d.pay || d.transport)) { o = d; }
  }
  return (o && typeof o === 'object') ? o : {};
}

function matchesTransportSearch(summary, searchText = '') {
  const q = String(searchText || '').trim().toLowerCase();
  if (!q) return true;
  const hay = String(summary?.searchBlob || '').toLowerCase();
  return hay.includes(q);
}

function cleanTransportDisplayName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[0-9]+$/.test(raw)) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return '';
  if (/^ADMIN_?\d+$/i.test(raw)) return '';
  if (raw.length > 64) return '';
  return raw;
}

function buildTransportUserLookup(users = []) {
  const byPin = {};
  const byId = {};
  (Array.isArray(users) ? users : []).forEach((user) => {
    const name = cleanTransportDisplayName(user?.name || user?.full_name || user?.label || '');
    if (!name) return;
    const pin = String(user?.pin || user?.user_pin || '').trim();
    const id = String(user?.id || user?.user_id || user?.transport_id || '').trim();
    if (pin) byPin[pin] = name;
    if (id) byId[id] = name;
  });
  return { byPin, byId };
}

function resolveTransportBroughtBy(raw, userLookup = null) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const transport = unwrapPayload(order?.transport || order?.transport_meta || order?.transportOrder || {});
  const directName = cleanTransportDisplayName(
    order?.driver_name
      || order?.transport_name
      || transport?.driver_name
      || transport?.transport_name
      || transport?.brought_by
      || transport?.broughtBy
      || transport?.driverName
      || transport?.assigned_driver_name
      || transport?.assignedDriverName
      || order?.brought_by
      || order?.broughtBy
      || order?.driverName
      || row?.driver_name
      || row?.transport_name
      || row?.actor
      || order?.actor
      || ''
  );
  if (directName) return directName;

  const lookup = userLookup && typeof userLookup === 'object' ? userLookup : {};
  const pinCandidates = [
    order?.driver_pin,
    order?.transport_pin,
    transport?.driver_pin,
    transport?.transport_pin,
    row?.driver_pin,
    row?.transport_pin,
  ].map((x) => String(x || '').trim()).filter(Boolean);
  for (const pin of pinCandidates) {
    const name = cleanTransportDisplayName(lookup?.byPin?.[pin]);
    if (name) return name;
  }

  const idCandidates = [
    order?.assigned_driver_id,
    transport?.assigned_driver_id,
    row?.assigned_driver_id,
    order?.transport_id,
    transport?.transport_id,
    row?.transport_id,
  ].map((x) => String(x || '').trim()).filter(Boolean);
  for (const id of idCandidates) {
    const name = cleanTransportDisplayName(lookup?.byId?.[id]);
    if (name) return name;
  }

  return 'TRANSPORT';
}

function mergeTransportIdentityIntoOrder(row = {}, order = {}) {
  const next = { ...(order && typeof order === 'object' ? order : {}) };
  ['transport_id', 'assigned_driver_id', 'driver_pin', 'transport_pin', 'driver_name', 'transport_name', 'actor'].forEach((key) => {
    if ((next[key] === undefined || next[key] === null || String(next[key] || '').trim() === '') && row?.[key] !== undefined && row?.[key] !== null) {
      next[key] = row[key];
    }
  });
  return next;
}

function getTransportBaseSummary(raw, userLookup = null) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const transport = unwrapPayload(order?.transport || order?.transport_meta || order?.transportOrder || {});
  const broughtBy = resolveTransportBroughtBy(row, userLookup);
  const rackText = String(
    order?.ready_location
      || order?.ready_note
      || transport?.rack
      || transport?.rack_text
      || transport?.rackText
      || ''
  ).trim();
  const searchBlob = [
    broughtBy,
    rackText,
    transport?.note,
    transport?.driver_note,
    transport?.driverNote,
    order?.client_name,
    order?.client?.name,
    order?.code,
  ].filter(Boolean).join(' ');
  return {
    broughtBy,
    rackText,
    searchBlob,
    matchesSearch: (searchText) => matchesTransportSearch({ searchBlob }, searchText),
  };
}

async function readLocalOrdersByStatus(status) {
  const out = [];
  const blacklist = getGhostBlacklist();

  const pushRow = (id, fullOrder, ts, source, synced, tableName = '') => {
    if (!id || !fullOrder) return;
    if (blacklist.includes(String(id))) return;
    const st = String(fullOrder.status || '').toLowerCase();
    if (normalizeStatus(st) !== normalizeStatus(status)) return;
    out.push({ id, source, ts: Number(ts || fullOrder.ts || Date.now()), fullOrder, synced: !!synced, table: tableName || '', _table: tableName || '' });
  };

  try {
    const list = await getAllOrdersLocal();
    (Array.isArray(list) ? list : []).forEach((x) => {
      const raw = x?.data ?? x;
      const full = normalizeOrder(raw);
      const tableName = x?.table || x?._table || full?.table || full?._table || '';
      full.status = String(full?.status || x?.data?.status || x?.status || '').toLowerCase() || 'pastrim';
      if (tableName && !full._table) full._table = tableName;
      if (tableName && !full.table) full.table = tableName;
      const id = x?.id || full.id || full.oid || '';
      const ts = x?.updated_at || x?.created_at || full.created_at || full.updated_at || Date.now();
      pushRow(id, full, ts, 'idb', !!x?._synced, tableName);
    });
  } catch {}

  const byIdentity = new Map();

  const scoreRow = (row) => {
    const metrics = computeOrderMetrics(row.fullOrder);
    const m2 = metrics.m2 || 0;
    const pcs = metrics.pieces || 0;
    return (row.synced ? 1000000 : 0) + (row.source === 'idb' ? 10000 : 0) + (m2 * 100) + (pcs * 10);
  };

  for (const row of out) {
    const order = row.fullOrder;
    const localOid = String(order?.local_oid || order?.oid || row?.local_oid || row?.id || '').trim();
    const identityKey = localOid ? `local:${localOid}` : `id:${String(row?.id || '').trim()}`;
    if (!identityKey || /^(local:|id:)\s*$/.test(identityKey)) continue;
    const prev = byIdentity.get(identityKey);
    if (!prev) { byIdentity.set(identityKey, row); continue; }
    const s1 = scoreRow(row);
    const s0 = scoreRow(prev);
    if (s1 > s0) byIdentity.set(identityKey, row);
    else if (s1 === s0 && Number(row.ts) >= Number(prev.ts)) byIdentity.set(identityKey, row);
  }

  return Array.from(byIdentity.values());
}

function buildPendingOutboxPastrimRows() {
  const outboxSnap = typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [];
  return Array.isArray(outboxSnap)
    ? outboxSnap.filter((it) => it?.status === 'pending' && (it?.table === 'orders' || it?.table === 'transport_orders')).map((it) => {
        const rawPayload = it?.payload && typeof it.payload === 'object' ? it.payload : {};
        const table = String(it?.table || rawPayload?.table || rawPayload?._table || '').trim();
        const p = table === 'transport_orders' ? rawPayload : unwrapPayload(rawPayload);
        if (table === 'transport_orders' && !shouldShowTransportBridgeInPastrim({
          ...(p && typeof p === 'object' ? p : {}),
          status: p?.status || rawPayload?.status || p?.data?.status || '',
          data: p?.data || p,
          fullOrder: p?.data || p,
          table,
          _table: table,
          source: 'OUTBOX',
        })) return null;
        const view = p?.data && typeof p.data === 'object' ? p.data : p;
        const codeKey = view?.client?.code ?? view?.client?.tcode ?? p.code ?? p.code_str ?? p.code_n ?? p.order_code ?? p.client?.code ?? p.client_tcode ?? p.client_code ?? null;
        const m2 = computeM2(view);
        const cope = computePieces(view);
        return normalizeRenderableOrderRow({
          id: p.local_oid || p.id || rawPayload?.local_oid || rawPayload?.id || null,
          local_oid: p.local_oid || rawPayload?.local_oid || null,
          status: normalizeStatus(p.status || rawPayload?.status || 'pastrim') || 'pastrim',
          source: 'OUTBOX',
          table,
          _table: table,
          ts: Number(it.createdAt ? Date.parse(it.createdAt) : Date.now()),
          name: view.client?.name || p.client?.name || p.client_name || 'Pa Emër',
          phone: view.client?.phone || p.client?.phone || p.client_phone || '',
          code: normalizeCode(codeKey),
          m2,
          cope,
          total: Number(view.pay?.euro || p.pay?.euro || p.total || 0),
          paid: Number(view.pay?.paid || p.pay?.paid || p.paid || 0),
          isPaid: Number(view.pay?.paid || p.pay?.paid || p.paid || 0) >= Number(view.pay?.euro || p.pay?.euro || p.total || 0) && Number(view.pay?.euro || p.pay?.euro || p.total || 0) > 0,
          isReturn: false,
          fullOrder: view,
          _outboxPending: true,
        });
      }).filter(Boolean)
    : [];
}

function dedupePastrimRows(rows = []) {
  const entries = [];
  const tokenToIndex = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const tokens = getPastrimCanonicalTokens(row);
    if (!tokens.length) continue;

    const matchedIndices = Array.from(new Set(tokens
      .map((token) => tokenToIndex.get(token))
      .filter((idx) => Number.isInteger(idx) && entries[idx])));

    if (!matchedIndices.length) {
      const idx = entries.length;
      const tokenSet = new Set(tokens);
      entries.push({ row, tokens: tokenSet });
      tokenSet.forEach((token) => tokenToIndex.set(token, idx));
      continue;
    }

    const targetIndex = matchedIndices[0];
    const mergedTokens = new Set([...(entries[targetIndex]?.tokens || []), ...tokens]);
    let winner = choosePastrimWinner(entries[targetIndex]?.row, row);

    for (const idx of matchedIndices.slice(1)) {
      const entry = entries[idx];
      if (!entry) continue;
      winner = choosePastrimWinner(entry.row, winner);
      entry.tokens.forEach((token) => mergedTokens.add(token));
      entries[idx] = null;
    }

    entries[targetIndex] = { row: winner, tokens: mergedTokens };
    mergedTokens.forEach((token) => tokenToIndex.set(token, targetIndex));
  }

  return entries.filter(Boolean).map((entry) => entry.row);
}

function swControllerScriptURL() {
  try { return String(navigator?.serviceWorker?.controller?.scriptURL || ''); } catch { return ''; }
}

function writePastrimiLoadingTimeoutMarker(payload = {}) {
  try {
    if (typeof window === 'undefined') return null;
    const entry = {
      at: new Date().toISOString(),
      ts: Date.now(),
      route: '/pastrimi',
      online: typeof navigator !== 'undefined' ? navigator.onLine !== false : null,
      appVersion: String(window.__TEPIHA_BUILD_ID || ''),
      epoch: String(window.__TEPIHA_APP_EPOCH || ''),
      swControllerScriptURL: swControllerScriptURL(),
      ...payload,
    };
    window.localStorage?.setItem?.(PASTRIMI_LOADING_TIMEOUT_MARKER_KEY, JSON.stringify(entry));
    try { window.dispatchEvent(new CustomEvent('tepiha:pastrimi-loading-timeout', { detail: entry })); } catch {}
    return entry;
  } catch {
    return null;
  }
}

function enablePastrimiSafeOfflineMode(reason = 'pastrimi_continue_offline') {
  try {
    if (typeof window === 'undefined') return null;
    const now = Date.now();
    const entry = {
      at: new Date().toISOString(),
      ts: now,
      source: 'pastrimi_local_first_status',
      reason,
      disableSyncUntil: now + 90000,
      disableUpdateChecksUntil: now + 90000,
      disableWarmupUntil: now + 90000,
      disableRuntimeUploadsUntil: now + 90000,
      expiresAt: now + 90000,
      path: '/pastrimi',
      appVersion: String(window.__TEPIHA_BUILD_ID || ''),
      epoch: String(window.__TEPIHA_APP_EPOCH || ''),
    };
    try { window.sessionStorage?.setItem?.('tepiha_safe_mode_v1', JSON.stringify(entry)); } catch {}
    try { window.localStorage?.setItem?.('tepiha_safe_mode_v1', JSON.stringify(entry)); } catch {}
    try { window.__TEPIHA_HOME_SAFE_MODE__ = true; } catch {}
    return entry;
  } catch {
    return null;
  }
}
function buildImmediatePastrimLocalRows() {
  try {
    const snapshotRows = readPastrimRowsFromPageSnapshot();
    const masterRows = (readPastrimRowsFromBaseMasterCache() || []).map((row) => normalizeRenderableOrderRow(row));
    const pendingRows = buildPendingOutboxPastrimRows().map((row) => normalizeRenderableOrderRow(row));
    const rows = dedupePastrimRows([
      ...(Array.isArray(snapshotRows) ? snapshotRows : []),
      ...(Array.isArray(masterRows) ? masterRows : []),
      ...(Array.isArray(pendingRows) ? pendingRows : []),
    ])
      .filter((row) => shouldShowTransportBridgeInPastrim(row))
      .filter((row) => Number(row?.cope || 0) > 0 || Number(row?.m2 || 0) > 0 || String(row?.name || '').trim() !== '')
      .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    return rows;
  } catch {
    return [];
  }
}

async function buildPastrimFallbackRows(trace = null, diagEnabled = false) {
  const pageSnapshotRows = readPastrimRowsFromPageSnapshot();
  const masterCacheRows = dedupePastrimRows([...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []), ...(readPastrimRowsFromBaseMasterCache() || []).map((row) => normalizeRenderableOrderRow(row))]);
  const pendingOutbox = buildPendingOutboxPastrimRows();
  const locals = (await readLocalOrdersByStatus('pastrim')).map((x) => {
    const order = unwrapOrderData(x.fullOrder);
    const total = computeOrderDisplayTotal(order);
    const paid = Number(order.pay?.paid || 0);
    return normalizeRenderableOrderRow({
      id: x.id,
      local_oid: normalizeLocalOidValue(x?.local_oid, order?.local_oid, order?.oid),
      status: normalizeStatus(order.status || x.status || 'pastrim') || 'pastrim',
      source: 'LOCAL',
      table: x?.table || x?._table || order?.table || order?._table || '',
      _table: x?.table || x?._table || order?.table || order?._table || '',
      ts: Number(order.ts || x.ts || Date.now()),
      name: order.client?.name || order.client_name || 'Pa Emër',
      phone: order.client?.phone || order.client_phone || '',
      code: normalizeCode(order.client?.code || order.code || x.id),
      m2: computeM2(order),
      cope: computePieces(order),
      total,
      paid,
      isPaid: paid >= total && total > 0,
      isReturn: !!order?.returnInfo?.active,
      fullOrder: order,
      localOnly: true,
    });
  });

  const cleanLocals = locals.filter((o) => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== ''));
  const masterTokenSet = new Set((Array.isArray(masterCacheRows) ? masterCacheRows : []).flatMap((row) => getPastrimCanonicalTokens(row)));
  const visibleLocals = cleanLocals.filter((row) => !getPastrimCanonicalTokens(row).some((token) => masterTokenSet.has(token)));
  const visiblePendingOutbox = (Array.isArray(pendingOutbox) ? pendingOutbox : []).filter((row) => !getPastrimCanonicalTokens(row).some((token) => masterTokenSet.has(token)));
  const dedupedLocals = dedupePastrimRows([...masterCacheRows, ...visibleLocals, ...visiblePendingOutbox]).filter((row) => shouldShowTransportBridgeInPastrim(row));

  dedupedLocals.sort((a, b) => b.ts - a.ts);
  dedupedLocals.forEach((row) => pushPastrimTrace(trace, 'offline_final', row, 'keep', 'offline_visible_row'));
  if (diagEnabled) {
    try {
      if (typeof window !== 'undefined') window.__tepihaPastrimTrace = trace;
    } catch {}
    try { console.debug('[PASTRIM fallback trace]', trace); } catch {}
  }
  return dedupedLocals;
}


function mapExactDbRowToPastrim(row, source = 'orders') {
  if (!row || typeof row !== 'object') return null;
  const order = mergeReadyMetaIntoOrder(row?.data || {}, row || {});
  const status = normalizeStatus(row?.status || order?.status || 'pastrim') || 'pastrim';
  if (source === 'transport_orders') {
    if (!isTransportVisibleInPastrimStatus(status)) return null;
  } else if (status !== 'pastrim' && status !== 'pastrimi') {
    return null;
  }
  const metrics = computeOrderMetrics(order);
  const total = computeOrderDisplayTotal(order);
  const paid = Number(order?.pay?.paid || 0);
  const fullOrder = source === 'transport_orders' ? mergeTransportIdentityIntoOrder(row, order) : order;
  return normalizeRenderableOrderRow({
    id: String(row?.id || order?.id || ''),
    local_oid: normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid),
    status,
    source,
    ts: Number(order?.ts || Date.parse(row?.updated_at || row?.created_at || 0) || Date.now()),
    updated_at: String(row?.updated_at || order?.updated_at || row?.created_at || ''),
    name: row?.client_name || order?.client_name || order?.client?.name || 'Pa Emër',
    phone: row?.client_phone || order?.client_phone || order?.client?.phone || '',
    code: normalizeCode(order?.client?.code || order?.code || row?.code || row?.code_str || ''),
    m2: Number(metrics?.m2 || 0),
    cope: Number(metrics?.pieces || 0),
    total,
    paid,
    isPaid: paid >= total && total > 0,
    isReturn: !!order?.returnInfo?.active,
    fullOrder,
  });
}

async function recoverExactPastrimRow(openId, options = {}) {
  const exactId = String(openId || '').trim();
  if (!/^\d+$/.test(exactId)) return null;
  const skipNetwork = !!options?.skipNetwork;

  const readCaches = async () => {
    try {
      const cacheRows = dedupePastrimRows([...(readPastrimRowsFromPageSnapshot() || []), ...(readPastrimRowsFromBaseMasterCache() || []).map((row) => normalizeRenderableOrderRow(row))]);
      const pendingRows = buildPendingOutboxPastrimRows().map((row) => normalizeRenderableOrderRow(row));
      const localRows = (await readLocalOrdersByStatus('pastrim').catch(() => [])).map((x) => {
        const order = unwrapOrderData(x.fullOrder);
        const total = computeOrderDisplayTotal(order);
        const paid = Number(order?.pay?.paid || 0);
        return normalizeRenderableOrderRow({
          id: String(x?.id || order?.id || ''),
          local_oid: normalizeLocalOidValue(x?.local_oid, order?.local_oid, order?.oid, x?.id),
          status: normalizeStatus(order?.status || x?.status || 'pastrim') || 'pastrim',
          source: 'LOCAL',
          table: x?.table || x?._table || order?.table || order?._table || '',
          _table: x?.table || x?._table || order?.table || order?._table || '',
          ts: Number(order?.ts || x?.ts || Date.now()),
          name: order?.client?.name || order?.client_name || 'Pa Emër',
          phone: order?.client?.phone || order?.client_phone || '',
          code: normalizeCode(order?.client?.code || order?.code || x?.id),
          m2: computeM2(order),
          cope: computePieces(order),
          total,
          paid,
          isPaid: paid >= total && total > 0,
          isReturn: !!order?.returnInfo?.active,
          fullOrder: order,
        });
      });
      const merged = dedupePastrimRows([...(Array.isArray(cacheRows) ? cacheRows : []), ...(Array.isArray(pendingRows) ? pendingRows : []), ...(Array.isArray(localRows) ? localRows : [])]);
      return merged.find((row) => String(row?.id || row?.dbId || '').trim() == exactId && shouldShowTransportBridgeInPastrim(row)) || null;
    } catch {
      return null;
    }
  };

  const cached = await readCaches();
  if (cached) return cached;
  if (skipNetwork) return null;

  try {
    const exactRow = await fetchOrderByIdSafe(
      'orders',
      Number(exactId),
      'id,status,created_at,updated_at,data,code,client_name,client_phone,local_oid',
      { timeoutMs: 9000 }
    );
    return mapExactDbRowToPastrim(exactRow, 'orders');
  } catch {
    return null;
  }
}

function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function formatDayMonth(ts) {
  if (!ts) return '--/--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--/--';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function rowQty(r) { return Number(r?.qty ?? r?.pieces ?? 0) || 0; }
function rowM2(r) { return Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0; }
function extractArray(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) return obj[k];
    if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[k]) && obj.data[k].length > 0) return obj.data[k];
    if (typeof obj.data === 'string') {
      try { const p = JSON.parse(obj.data); if (Array.isArray(p[k]) && p[k].length > 0) return p[k]; } catch(e) {}
    }
  }
  return [];
}
function getTepihaRows(order) { return extractArray(order, 'tepiha', 'tepihaRows'); }
function getStazaRows(order) { return extractArray(order, 'staza', 'stazaRows'); }
function getStairsQty(order) {
  if (!order || typeof order !== 'object') return 0;
  let q = Number(order?.shkallore?.qty) || Number(order?.data?.shkallore?.qty) || Number(order?.stairsQty) || Number(order?.data?.stairsQty) || 0;
  if (q === 0 && typeof order.data === 'string') { try { const p = JSON.parse(order.data); q = Number(p?.shkallore?.qty) || Number(p?.stairsQty) || 0; } catch(e){} }
  return q;
}
function getStairsPer(order) {
  if (!order || typeof order !== 'object') return 0.3;
  let p = Number(order?.shkallore?.per) || Number(order?.data?.shkallore?.per) || Number(order?.stairsPer) || Number(order?.data?.stairsPer) || 0.3;
  if (p === 0.3 && typeof order.data === 'string') { try { const parsed = JSON.parse(order.data); p = Number(parsed?.shkallore?.per) || Number(parsed?.stairsPer) || 0.3; } catch(e){} }
  return p;
}
function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  for (const r of getTepihaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}
function computePieces(order) {
  if (!order) return 0;
  let p = 0;
  for (const r of getTepihaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  p += getStairsQty(order);
  return p;
}

function computeOrderMetrics(order) {
  if (!order) return { m2: 0, pieces: 0 };

  let total = 0;
  let pieces = 0;

  for (const r of getTepihaRows(order)) {
    const qty = Number(r?.qty ?? r?.pieces ?? 0) || 0;
    const m2 = Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0;
    pieces += qty;
    total += m2 * qty;
  }

  for (const r of getStazaRows(order)) {
    const qty = Number(r?.qty ?? r?.pieces ?? 0) || 0;
    const m2 = Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0;
    pieces += qty;
    total += m2 * qty;
  }

  const stairsQty = getStairsQty(order);
  const stairsPer = getStairsPer(order);
  pieces += stairsQty;
  total += stairsQty * stairsPer;

  return {
    m2: Number(total.toFixed(2)),
    pieces,
  };
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function triggerFatalCacheHeal(error = null) {
  try {
    console.warn('PATCH L V24: Pastrimi cache heal is diagnostic-only; preserving local orders/outbox and using local fallback.', error || '');
    if (typeof window !== 'undefined') {
      window.localStorage?.setItem?.('tepiha_pastrimi_refresh_preserved_local_v1', JSON.stringify({
        at: new Date().toISOString(),
        ts: Date.now(),
        message: String(error?.message || error || ''),
      }));
    }
  } catch {}
}

function isPersistedDbLikeId(raw) {
  const id = String(raw || '').trim();
  if (!id) return false;
  if (/^\d+$/.test(id)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return true;
  if (/^[0-9a-f-]{32,}$/i.test(id) && id.includes('-')) return true;
  return false;
}

function purgeZombieLocalArtifacts(ids = []) {
  const uniq = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!uniq.length || typeof window === 'undefined') return;
  try {
    uniq.forEach((id) => {
      try { window.localStorage.removeItem(`order_${id}`); } catch {}
      try { window.localStorage.removeItem(`tepiha_delivered_${id}`); } catch {}
    });
  } catch {}

  try {
    const raw = window.localStorage.getItem('tepiha_local_orders_v1');
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) {
      const filtered = list.filter((row) => {
        const rid = String(row?.id || row?.local_oid || row?.oid || row?.data?.id || row?.data?.local_oid || row?.data?.oid || '').trim();
        return !uniq.includes(rid);
      });
      window.localStorage.setItem('tepiha_local_orders_v1', JSON.stringify(filtered));
    }
  } catch {}
}


function buildTerminalRecoveryIndex() {
  try {
    const entries = Array.isArray(listBaseCreateRecovery?.()) ? listBaseCreateRecovery() : [];
    const index = {
      ids: new Set(),
      localOids: new Set(),
      codes: new Set(),
    };
    for (const entry of entries) {
      const status = String(entry?.status || '').trim().toLowerCase();
      const terminal = !!entry?.terminal || status === 'failed_permanently' || status === 'abandoned_missing_local' || status === 'synced';
      if (!terminal) continue;
      const id = String(entry?.id || '').trim();
      const localOid = String(entry?.local_oid || '').trim();
      const code = normalizeCode(entry?.code || '');
      if (id) index.ids.add(id);
      if (localOid) index.localOids.add(localOid);
      if (code && code !== '0') index.codes.add(code);
    }
    return index;
  } catch {
    return { ids: new Set(), localOids: new Set(), codes: new Set() };
  }
}

function isTerminalRecoveryGhostRow(row, recoveryIndex) {
  try {
    const index = recoveryIndex || { ids: new Set(), localOids: new Set(), codes: new Set() };
    const id = String(row?.id || '').trim();
    const localOid = String(
      row?.local_oid ||
      row?.fullOrder?.local_oid ||
      row?.fullOrder?.oid ||
      row?.data?.local_oid ||
      ''
    ).trim();
    const code = normalizeCode(
      row?.code ||
      row?.fullOrder?.code ||
      row?.fullOrder?.client?.code ||
      row?.data?.code ||
      row?.data?.client?.code ||
      ''
    );
    const source = String(row?.source || '').trim().toUpperCase();
    const persisted = isPersistedDbLikeId(id);
    const localLike = !persisted || source === 'LOCAL' || source === 'OUTBOX' || !!row?._masterCache || row?._synced === false;
    if (!localLike) return false;
    return (
      (!!localOid && index.localOids.has(localOid)) ||
      (!!id && !persisted && index.ids.has(id)) ||
      (!!code && code !== '0' && index.codes.has(code))
    );
  } catch {
    return false;
  }
}

function purgeGhostPastrimArtifacts(row, reason = 'ghost_pastrim_cleanup') {
  const ids = Array.from(new Set([
    String(row?.id || '').trim(),
    String(row?.db_id || '').trim(),
    String(row?.local_oid || row?.oid || row?.fullOrder?.local_oid || row?.fullOrder?.oid || '').trim(),
  ].filter(Boolean)));

  const code = normalizeCode(row?.code || row?.fullOrder?.code || row?.fullOrder?.client?.code || '');
  purgeZombieLocalArtifacts(ids);

  try {
    const cache = readBaseMasterCache();
    const rows = Array.isArray(cache?.rows) ? cache.rows : [];
    const filteredRows = rows.filter((item) => {
      const itemId = String(item?.id || '').trim();
      const itemLocalOid = String(item?.local_oid || item?.data?.local_oid || item?.data?.oid || '').trim();
      const itemCode = normalizeCode(item?.code || item?.data?.code || item?.data?.client?.code || '');
      const sameId = ids.includes(itemId) || ids.includes(itemLocalOid);
      const sameCode = !!code && code === itemCode;
      const scopedStatus = ['pastrim', 'pastrimi'].includes(String(item?.status || '').trim().toLowerCase());
      return !(scopedStatus && (sameId || sameCode));
    });
    if (filteredRows.length !== rows.length) writeBaseMasterCache({ ...cache, rows: filteredRows });
  } catch {}

  try { console.warn('[PASTRIM ghost purged]', { reason, ids, code }); } catch {}
}

function reconcileZombieBaseCache(validDbIds, statuses = []) {
  const wanted = new Set((Array.isArray(statuses) ? statuses : []).map((s) => String(s || '').trim().toLowerCase()));
  const valid = validDbIds instanceof Set ? validDbIds : new Set();
  const zombieIds = new Set();
  try {
    const cache = readBaseMasterCache();
    const rows = Array.isArray(cache?.rows) ? cache.rows : [];
    const filteredRows = rows.filter((row) => {
      const status = String(row?.status || '').trim().toLowerCase();
      const id = String(row?.id || row?.local_oid || '').trim();
      const isZombie = wanted.has(status) && isPersistedDbLikeId(id) && !valid.has(id);
      if (isZombie) zombieIds.add(id);
      return !isZombie;
    });
    if (filteredRows.length !== rows.length) writeBaseMasterCache({ ...cache, rows: filteredRows });
  } catch {}
  purgeZombieLocalArtifacts(Array.from(zombieIds));
  return zombieIds;
}


function dayKey(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysSince(ts) {
  const a = new Date(ts || Date.now());
  const b = new Date();
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.floor((startB - startA) / (24 * 60 * 60 * 1000));
}

function badgeColorByAge(ts) {
  const d = daysSince(ts);
  if (d <= 0) return '#16a34a'; 
  if (d === 1) return '#f59e0b'; 
  return '#dc2626'; 
}

async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' }), 9000, 'PASTRIMI_PHOTO_UPLOAD_TIMEOUT', { bucket: BUCKET, path });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

// ---------------- COMPONENT ----------------
function PastrimiPageInner() {
  useRouteAlive('pastrimi_page');
  useEffect(() => {
    markRealUiReady('pastrimi_page_visible');
  }, []);
  const router = useRouter();
  const sp = useSearchParams();
  const exactMode = String(sp?.get('exact') || '') === '1';
  const openId = String(sp?.get('openId') || '').trim();
  const fromSearch = String(sp?.get('from') || '').trim() === 'search';
  const exactSearchMode = !!openId && (exactMode || fromSearch);
  const phonePrefix = '+383';
  const longPressTimer = useRef(null);
  const isRefreshing = useRef(false);
  const refreshTimeout = useRef(null);
  const rackRefreshTimer = useRef(null);
  const readyPlaceWarmTimer = useRef(null);
  const readyPlaceOpenRef = useRef(false);
  const readyPlaceWarmTokenRef = useRef(0);
  const realtimeRefreshTimer = useRef(null);
  const lastRefreshStartedAt = useRef(0);
  const lastRefreshFinishedAt = useRef(0);
  const lastRefreshSource = useRef('init');
  const lastPersistSig = useRef('');
  const lastPersistAt = useRef(0);
  const didBootLoadRef = useRef(false);
  const uiReadyMarkedRef = useRef(false);
  const refreshAbortRef = useRef(null);
  const lastSuccessfulRefreshAt = useRef(0);
  const lastResumeRefreshAt = useRef(0);
  const lastRealtimeRefreshAt = useRef(0);
  const lastRealtimeEventSigRef = useRef('');
  const lastRealtimeEventAtRef = useRef(0);
  const hiddenSearchBootRef = useRef(false);
  const visibleSearchRecoveryRef = useRef(false);

  const [orders, setOrders] = useState(() => buildImmediatePastrimLocalRows());
  const [exactRecoveredRow, setExactRecoveredRow] = useState(null);
  const [exactSearchTimedOut, setExactSearchTimedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localModeNotice, setLocalModeNotice] = useState('LOCAL_INIT');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [, startListTransition] = useTransition();

  const [debugInfo, setDebugInfo] = useState({
    source: 'INIT', dbCount: 0, localCount: 0,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    lastError: null, ts: 0,
  });
  const [readyCountHint, setReadyCountHint] = useState(null);
  const [transportUserLookup, setTransportUserLookup] = useState(() => buildTransportUserLookup([]));

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const res = await listUsers({ includeInactive: true });
          if (!alive) return;
          setTransportUserLookup(buildTransportUserLookup(res?.ok ? (res.items || []) : []));
        } catch {
          if (alive) setTransportUserLookup(buildTransportUserLookup([]));
        }
      })();
    }, 250);
    return () => {
      alive = false;
      try { window.clearTimeout(timer); } catch {}
    };
  }, []);

  function markPastrimiFailOpenReady(reason = 'local_first_ready', count = 0) {
    const detail = { source: 'pastrimi_fail_open_local_first', path: '/pastrimi', page: 'pastrimi', reason: String(reason || ''), count: Number(count || 0) };
    try { markRealUiReady('pastrimi_fail_open_local_first'); } catch {}
    try { window.__TEPIHA_BLACKBOX__?.log?.('pastrimi_fail_open_ready', detail); } catch {}
    try {
      window.dispatchEvent(new CustomEvent('tepiha:route-ui-alive', { detail }));
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('tepiha:force-route-settled', { detail }));
    } catch {}
  }

  useEffect(() => {
    if (loading) return;
    if (!isDocumentVisible()) return;
    const visibleCount = Array.isArray(orders) ? orders.length : 0;
    const exactRecoveredCount = exactRecoveredRow ? 1 : 0;
    const hintCount = Number.isFinite(Number(readyCountHint)) ? Number(readyCountHint) : 0;
    const readyCount = Math.max(visibleCount, exactRecoveredCount, hintCount);
    if (exactSearchMode && readyCount <= 0) return;
    try {
      bootLog('ui_ready', {
        page: 'pastrimi',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
        count: readyCount,
        source: uiReadyMarkedRef.current ? 'state_repeat' : 'state_first',
        exactSearchMode,
      });
    } catch {}
    if (uiReadyMarkedRef.current) return;
    uiReadyMarkedRef.current = true;
    try {
      bootMarkReady({
        source: 'pastrimi_page',
        page: 'pastrimi',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
        count: readyCount,
        exactSearchMode,
      });
    } catch {}
  }, [loading, orders.length, exactRecoveredRow, exactSearchMode, readyCountHint]);

  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
  }, [sp]);

  useEffect(() => {
    let alive = true;
    if (!exactSearchMode) {
      hiddenSearchBootRef.current = false;
      visibleSearchRecoveryRef.current = false;
      setExactRecoveredRow(null);
      setExactSearchTimedOut(false);
      return () => { alive = false; };
    }

    setExactSearchTimedOut(false);

    const recoverNow = async (reason, opts = {}) => {
      const row = await recoverExactPastrimRow(openId, opts);
      if (!alive) return;
      if (row) {
        setExactRecoveredRow(row);
        try {
          bootLog('pastrimi_exact_recovered', {
            page: 'pastrimi',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
            openId,
            reason,
            source: String(row?.source || ''),
          });
        } catch {}
      }
    };

    const hiddenBoot = !isDocumentVisible();
    hiddenSearchBootRef.current = hiddenBoot;
    visibleSearchRecoveryRef.current = false;
    if (hiddenBoot) {
      setLoading(false);
      markPastrimiFailOpenReady('search_hidden_boot_cache_no_block', 0);
      void recoverNow('search_hidden_boot_cache', { skipNetwork: true });
    } else {
      void recoverNow('search_visible_boot_cache', { skipNetwork: true });
    }

    const onVisible = () => {
      if (!isDocumentVisible()) return;
      if (visibleSearchRecoveryRef.current) return;
      visibleSearchRecoveryRef.current = true;
      scheduleRefreshOrders(80, { source: hiddenSearchBootRef.current ? 'search_first_visible' : 'search_visible_refresh', force: true });
      void recoverNow(hiddenSearchBootRef.current ? 'search_first_visible' : 'search_visible_refresh');
    };

    try { document.addEventListener('visibilitychange', onVisible, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', onVisible, { passive: true }); } catch {}
    try { window.addEventListener('focus', onVisible, { passive: true }); } catch {}

    if (!hiddenBoot) onVisible();

    const exactSearchFailOpenTimer = window.setTimeout(() => {
      if (!alive) return;
      try {
        const localRows = buildImmediatePastrimLocalRows();
        const hasExact = localRows.some((row) => String(row?.id || '').trim() === openId || String(row?.dbId || '').trim() === openId);
        if (!hasExact && !exactRecoveredRow) {
          setExactSearchTimedOut(true);
          setLoading(false);
          if (localRows.length > 0) {
            applyPastrimiRowsLocalFirst(localRows, 'EXACT_SEARCH_TIMEOUT_LOCAL_LIST', { exactSearchTimeout: true, openId });
          }
          markPastrimiFailOpenReady('exact_search_timeout_local_fail_open', localRows.length);
          try {
            window.localStorage?.setItem?.('tepiha_pastrimi_exact_search_timeout_v25', JSON.stringify({
              at: new Date().toISOString(),
              ts: Date.now(),
              openId,
              localRowCount: localRows.length,
              noGlobalBlock: true,
            }));
          } catch {}
        }
      } catch {
        try { setExactSearchTimedOut(true); setLoading(false); } catch {}
      }
    }, 2600);

    return () => {
      alive = false;
      try { window.clearTimeout(exactSearchFailOpenTimer); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
      try { window.removeEventListener('pageshow', onVisible); } catch {}
      try { window.removeEventListener('focus', onVisible); } catch {}
    };
  }, [exactSearchMode, openId]);

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  const [oid, setOid] = useState('');
  const [orderSource, setOrderSource] = useState('orders'); 
  const [origTs, setOrigTs] = useState(null);
  const [codeRaw, setCodeRaw] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  const [tepihaRows, setTepihaRows] = useState([{ id: 't1', m2: '', qty: '', photoUrl: '' }]);
  const [stazaRows, setStazaRows] = useState([{ id: 's1', m2: '', qty: '', photoUrl: '' }]);

  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [paidUpfront, setPaidUpfront] = useState(false);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [notes, setNotes] = useState('');

  const [returnActive, setReturnActive] = useState(false);
  const [returnAt, setReturnAt] = useState(0);
  const [returnReason, setReturnReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [returnPhoto, setReturnPhoto] = useState('');

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [readyPlaceSheet, setReadyPlaceSheet] = useState(false);
  const [readyPlaceOrder, setReadyPlaceOrder] = useState(null);
  const [readyPlaceText, setReadyPlaceText] = useState('');
  const [readyPlaceBusy, setReadyPlaceBusy] = useState(false);
  const [readySlots, setReadySlots] = useState([]);
  const [smsModal, setSmsModal] = useState({ open: false, phone: '', text: '' });
  const [slotMap, setSlotMap] = useState({});
  const [payAdd, setPayAdd] = useState(0);

  const [streamPastrimM2, setStreamPastrimM2] = useState(0);
  const deferredPersistTimer = useRef(null);
  const deferredPersistToken = useRef(0);

  function applyPastrimiRowsLocalFirst(rows = [], source = 'LOCAL_FIRST', extra = {}) {
    const cleanRows = dedupePastrimRows((Array.isArray(rows) ? rows : []).map((row) => normalizeRenderableOrderRow(row)))
      .filter((row) => shouldShowTransportBridgeInPastrim(row))
      .filter((row) => Number(row?.cope || 0) > 0 || Number(row?.m2 || 0) > 0 || String(row?.name || '').trim() !== '')
      .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const streamTotal = cleanRows.reduce((sum, row) => sum + (Number(row?.m2) || 0), 0);
    setReadyCountHint(cleanRows.length);
    startListTransition(() => {
      setOrders(cleanRows);
      setStreamPastrimM2(Number(streamTotal.toFixed(2)));
    });
    setLocalModeNotice(source);
    setDebugInfo({
      source,
      dbCount: Number(extra?.dbCount || 0),
      localCount: cleanRows.length,
      online: typeof navigator !== 'undefined' ? navigator.onLine !== false : null,
      lastError: extra?.lastError || null,
      ts: Date.now(),
    });
    setLoading(false);
    return cleanRows;
  }


  useEffect(() => {
    readyPlaceOpenRef.current = !!readyPlaceSheet;
  }, [readyPlaceSheet]);

  function scheduleDeferredLocalPersist(rows = [], delay = 2200) {
    try {
      deferredPersistToken.current += 1;
      const token = deferredPersistToken.current;
      const safeRows = Array.isArray(rows) ? rows.slice(0, PASRTRIMI_LOCAL_PERSIST_LIMIT).map((row) => ({ ...row })) : [];
      const signature = safeRows.map((row) => `${row._table || 'orders'}:${row.id || ''}:${row.updated_at || ''}:${normalizeStatus(row.status)}`).join('|');
      const now = Date.now();
      if (signature && signature === lastPersistSig.current && (now - Number(lastPersistAt.current || 0)) < PASRTRIMI_LOCAL_PERSIST_MIN_GAP_MS) return;
      if (deferredPersistTimer.current) clearTimeout(deferredPersistTimer.current);
      deferredPersistTimer.current = window.setTimeout(async () => {
        deferredPersistTimer.current = null;
        if (token !== deferredPersistToken.current) return;
        lastPersistSig.current = signature;
        lastPersistAt.current = Date.now();
        for (const row of safeRows) {
          try {
            await saveOrderLocal({
              id: row.id,
              status: normalizeStatus(row.status),
              data: row.data ?? null,
              updated_at: row.updated_at || new Date().toISOString(),
              _synced: true,
              _table: row._table || 'orders',
            });
          } catch {}
        }
      }, delay);
    } catch {}
  }

  function scheduleRackMapRefresh(delay = 1200) {
    try {
      if (rackRefreshTimer.current) clearTimeout(rackRefreshTimer.current);
      rackRefreshTimer.current = setTimeout(() => {
        rackRefreshTimer.current = null;
        void refreshRackMap({ force: true });
      }, delay);
    } catch {}
  }

  function cancelReadyPlaceWarmup() {
    try {
      readyPlaceWarmTokenRef.current += 1;
      if (readyPlaceWarmTimer.current) clearTimeout(readyPlaceWarmTimer.current);
      readyPlaceWarmTimer.current = null;
    } catch {}
  }

  function scheduleReadyPlaceWarmup(options = {}) {
    try {
      cancelReadyPlaceWarmup();
      const token = readyPlaceWarmTokenRef.current;
      const delay = Math.max(0, Number(options?.delay ?? 180) || 0);
      const force = !!options?.force;
      readyPlaceWarmTimer.current = setTimeout(async () => {
        readyPlaceWarmTimer.current = null;
        if (token !== readyPlaceWarmTokenRef.current) return;
        if (!readyPlaceOpenRef.current) return;
        try { await yieldToMainThread(); } catch {}
        try { await yieldToMainThread(); } catch {}
        if (token !== readyPlaceWarmTokenRef.current) return;
        if (!readyPlaceOpenRef.current) return;
        void refreshRackMap({ force });
      }, delay);
    } catch {}
  }

  useEffect(() => {
    trackRender('PastrimiPage');
  }, []);

  useEffect(() => {
    const localRows = buildImmediatePastrimLocalRows();
    applyPastrimiRowsLocalFirst(localRows, localRows.length ? 'LOCAL_FIRST_BOOT' : 'LOCAL_FIRST_EMPTY');
    markPastrimiFailOpenReady(localRows.length ? 'LOCAL_FIRST_BOOT' : 'LOCAL_FIRST_EMPTY', localRows.length);
    setLoading(false);

    const loadingGuard = window.setTimeout(() => {
      setLoading(false);
      const currentRows = buildImmediatePastrimLocalRows();
      if (currentRows.length > 0) {
        applyPastrimiRowsLocalFirst(currentRows, 'LOCAL_TIMEOUT_FALLBACK', { remoteTimeout: true });
      }
      writePastrimiLoadingTimeoutMarker({
        source: 'mount_loading_guard',
        cacheSourceUsed: currentRows.length > 0 ? 'local_cache' : 'empty_local',
        localRowCount: currentRows.length,
        remoteTimeout: true,
      });
    }, PASRTRIMI_INITIAL_LOCAL_TIMEOUT_MS);

    const bootIfNeeded = () => {
      if (didBootLoadRef.current) return;
      if (exactSearchMode && !isDocumentVisible()) {
        hiddenSearchBootRef.current = true;
        return;
      }
      scheduleRefreshOrders(120, { source: 'mount_boot', force: true, allowHidden: !exactSearchMode });
    };

    const onVisibilityBoot = () => {
      if (didBootLoadRef.current) return;
      if (!isDocumentVisible()) return;
      scheduleRefreshOrders(120, { source: hiddenSearchBootRef.current ? 'search_first_visible' : 'first_visible', force: true, allowHidden: false });
    };

    bootIfNeeded();
    try { document.addEventListener('visibilitychange', onVisibilityBoot, { passive: true }); } catch {}

    return () => {
      try { document.removeEventListener('visibilitychange', onVisibilityBoot); } catch {}
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      try { window.clearTimeout(loadingGuard); } catch {}
      if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      if (rackRefreshTimer.current) clearTimeout(rackRefreshTimer.current);
      if (readyPlaceWarmTimer.current) clearTimeout(readyPlaceWarmTimer.current);
      if (realtimeRefreshTimer.current) clearTimeout(realtimeRefreshTimer.current);
      if (deferredPersistTimer.current) clearTimeout(deferredPersistTimer.current);
      try { refreshAbortRef.current?.abort(); } catch {}
      refreshAbortRef.current = null;
      deferredPersistToken.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setTimeout(() => {
      try {
        const currentRows = buildImmediatePastrimLocalRows();
        if (currentRows.length > 0) {
          applyPastrimiRowsLocalFirst(currentRows, 'VISIBLE_STUCK_LOCAL_FALLBACK', { visibleStuck: true });
          setReadyCountHint(currentRows.length);
        }
        setLoading(false);
        markPastrimiFailOpenReady('visible_stuck_loading_timeout', currentRows.length);
        writePastrimiLoadingTimeoutMarker({
          source: 'visible_stuck_loading_watchdog',
          cacheSourceUsed: currentRows.length > 0 ? 'local_cache' : 'empty_local',
          localRowCount: currentRows.length,
          remoteTimeout: true,
          noGlobalBlock: true,
        });
      } catch {
        try { setLoading(false); } catch {}
      }
    }, 2800);
    return () => { try { window.clearTimeout(timer); } catch {} };
  }, [loading]);

  // FIX: Realtime me mbrojtje nga crash
  useEffect(() => {
    if (!supabase || typeof supabase.channel !== 'function') return;

    let ch1, ch2;
    try {
      ch1 = supabase.channel('pastrim-live-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async (payload) => {
            if (!isPastrimRealtimePayload(payload) || shouldSkipRealtimeEvent(payload, 'orders')) return;
            const row = payload?.new || payload?.old;
            if (row?.id) {
              setTimeout(() => {
                saveOrderLocal({ id: row.id, status: normalizeStatus(row.status), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, _table: 'orders' }).catch(() => {});
                patchPastrimRealtimeRow(row, 'orders');
              }, 0);
            }
            const nextStatus = normalizeStatus(payload?.new?.status || payload?.new?.data?.status || '');
            const prevStatus = normalizeStatus(payload?.old?.status || payload?.old?.data?.status || '');
            const needsFullRefresh = String(payload?.eventType || '').toUpperCase() === 'DELETE' || prevStatus !== nextStatus;
            if (needsFullRefresh) scheduleRealtimeFullRefresh(PASTRTRIMI_REALTIME_FULL_REFRESH_DELAY_MS, 'realtime_orders_transition');
        }).subscribe();

      ch2 = supabase.channel('pastrim-live-transport')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transport_orders' }, async (payload) => {
            if (!isPastrimRealtimePayload(payload) || shouldSkipRealtimeEvent(payload, 'transport_orders')) return;
            const row = payload?.new || payload?.old;
            if (row?.id) {
              setTimeout(() => {
                const realtimeTransportRow = { id: row.id, status: normalizeStatus(row.status), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, table: 'transport_orders', _table: 'transport_orders' };
                saveOrderLocal(realtimeTransportRow).catch(() => {});
                if (!shouldShowTransportBridgeInPastrim(normalizeRenderableOrderRow({ ...realtimeTransportRow, source: 'transport_orders', fullOrder: row.data ?? {} }))) {
                  removePastrimTransportRowsFromLocalCaches({ ...row, source: 'transport_orders', table: 'transport_orders', _table: 'transport_orders' }, 'realtime_transport_left_pastrim');
                  setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => !pastrimRowMatchesCleanupTarget(item, { ...row, source: 'transport_orders', table: 'transport_orders', _table: 'transport_orders' })));
                } else {
                  patchPastrimRealtimeRow(row, 'transport_orders');
                }
              }, 0);
            }
            const nextStatus = normalizeStatus(payload?.new?.status || payload?.new?.data?.status || '');
            const prevStatus = normalizeStatus(payload?.old?.status || payload?.old?.data?.status || '');
            const needsFullRefresh = String(payload?.eventType || '').toUpperCase() === 'DELETE' || prevStatus !== nextStatus;
            if (needsFullRefresh) scheduleRealtimeFullRefresh(PASTRTRIMI_REALTIME_FULL_REFRESH_DELAY_MS, 'realtime_transport_transition');
        }).subscribe();
    } catch(e) {}

    const onVisible = () => {
      if (!isDocumentVisible()) return;
      if (readyPlaceOpenRef.current) return;
      if (!didBootLoadRef.current) {
        scheduleResumeRefresh(120, { source: 'first_visible', force: true });
        return;
      }
      const claim = claimResume('pastrimi_visibility_refresh', 'visibility_visible', { minGapMs: PASRTRIMI_REFRESH_MIN_GAP_MS, minHiddenMs: 900 });
      if (!claim.accepted) return;
      scheduleResumeRefresh(1200, { source: 'visibility_visible' });
    };

    try { document.addEventListener('visibilitychange', onVisible, { passive: true }); } catch {}

    return () => {
      try { if (ch1) supabase.removeChannel(ch1); } catch {}
      try { if (ch2) supabase.removeChannel(ch2); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
    };
  }, []);


  function isPastrimStatusValue(value) {
    const status = normalizeStatus(value || '');
    return status === 'pastrim' || status === 'pastrimi';
  }

  function isPastrimRealtimePayload(payload) {
    const nextStatus = normalizeStatus(payload?.new?.status || payload?.new?.data?.status || '');
    const prevStatus = normalizeStatus(payload?.old?.status || payload?.old?.data?.status || '');
    return isPastrimStatusValue(nextStatus) || isPastrimStatusValue(prevStatus);
  }

  function shouldSkipRealtimeEvent(payload, sourceTable = 'orders') {
    try {
      const row = payload?.new || payload?.old || {};
      const sig = [sourceTable, String(payload?.eventType || ''), String(row?.id || ''), String(row?.updated_at || row?.created_at || ''), String(normalizeStatus(row?.status || row?.data?.status || ''))].join('|');
      const now = Date.now();
      if (sig && sig === String(lastRealtimeEventSigRef.current || '') && now - Number(lastRealtimeEventAtRef.current || 0) < PASRTRIMI_REALTIME_EVENT_DEDUPE_MS) {
        return true;
      }
      lastRealtimeEventSigRef.current = sig;
      lastRealtimeEventAtRef.current = now;
      return false;
    } catch {
      return false;
    }
  }

  function scheduleResumeRefresh(delay = 150, meta = {}) {
    try {
      if (!isDocumentVisible()) return;
      if (readyPlaceOpenRef.current && !meta?.force) return;
      const source = String(meta?.source || 'resume');
      const force = !!meta?.force;
      const now = Date.now();
      if (!force) {
        const sinceLast = now - Number(lastResumeRefreshAt.current || 0);
        if (sinceLast >= 0 && sinceLast < PASRTRIMI_RESUME_REFRESH_MIN_GAP_MS) return;
      }
      lastResumeRefreshAt.current = now;
      scheduleRefreshOrders(delay, { ...meta, source, force });
    } catch {}
  }

  function scheduleRefreshOrders(delay = 150, meta = {}) {
    try {
      const source = String(meta?.source || 'timer');
      const force = !!meta?.force;
      const allowHidden = !!meta?.allowHidden;
      if (readyPlaceOpenRef.current && !force) return;
      if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      refreshTimeout.current = setTimeout(() => {
        refreshTimeout.current = null;
        if (!allowHidden && !force && !isDocumentVisible()) return;
        void refreshOrders({ source, force, allowHidden });
      }, delay);
    } catch {}
  }

  function scheduleRealtimeFullRefresh(delay = PASRTRIMI_REALTIME_FULL_REFRESH_DELAY_MS, source = 'realtime') {
    try {
      if (!isDocumentVisible()) return;
      if (readyPlaceOpenRef.current) return;
      const now = Date.now();
      const sinceLast = now - Number(lastRealtimeRefreshAt.current || 0);
      if (sinceLast >= 0 && sinceLast < PASRTRIMI_REALTIME_FULL_REFRESH_MIN_GAP_MS) return;
      if (realtimeRefreshTimer.current) clearTimeout(realtimeRefreshTimer.current);
      realtimeRefreshTimer.current = setTimeout(() => {
        realtimeRefreshTimer.current = null;
        lastRealtimeRefreshAt.current = Date.now();
        scheduleRefreshOrders(450, { source });
      }, delay);
    } catch {}
  }

  function patchPastrimRealtimeRow(row, sourceTable = 'orders') {
    if (!row || typeof row !== 'object') return;
    const order = unwrapOrderData(row?.data);
    const total = computeOrderDisplayTotal(order);
    const paid = Number(order?.pay?.paid || 0);
    const metrics = computeOrderMetrics(order);

    const nextRow = {
      id: row?.id,
      source: sourceTable === 'transport_orders' ? 'transport_orders' : 'orders',
      ts: Number(order?.ts || Date.parse(row?.updated_at || row?.created_at || 0) || Date.now()),
      name: row?.client_name || order?.client?.name || order?.client_name || 'Pa Emër',
      phone: row?.client_phone || order?.client?.phone || order?.client_phone || '',
      code: normalizeCode(order?.client?.code || order?.code || row?.code || row?.code_str || ''),
      m2: metrics.m2,
      cope: metrics.pieces,
      total,
      paid,
      isPaid: paid >= total && total > 0,
      isReturn: !!order?.returnInfo?.active,
      fullOrder: order,
    };

    startListTransition(() => {
      setOrders((prev) => {
        const nextKey = getRowPrimaryKey(nextRow);
        const base = Array.isArray(prev)
          ? prev.filter((item) => {
              const sameId = String(item?.id || '') === String(row?.id || '');
              const sameKey = !!nextKey && getRowPrimaryKey(item) === nextKey;
              const overlap = rowsOverlapPastrimCanonical(item, nextRow);
              return !(sameId || sameKey || overlap);
            })
          : [];
        const status = normalizeStatus(row?.status);
        if (sourceTable === 'transport_orders') {
          if (!shouldShowTransportBridgeInPastrim(nextRow)) return base;
        } else if (status !== 'pastrim' && status !== 'pastrimi') {
          return base;
        }
        const merged = [nextRow, ...base]
          .filter((item) => Number(item?.cope || 0) > 0 || Number(item?.m2 || 0) > 0 || String(item?.name || '').trim() !== '')
          .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
        return merged.slice(0, 120);
      });
    });

    if (sourceTable === 'orders') {
      try { patchBaseMasterRow({ id: row.id, status: normalizeStatus(row.status), data: row.data ?? null, updated_at: row.updated_at || row.created_at || new Date().toISOString(), _table: 'orders', _synced: true }); } catch {}
    }
  }

  async function refreshOrders(meta = {}) {
    const source = String(meta?.source || 'direct');
    const force = !!meta?.force;
    const allowHidden = !!meta?.allowHidden;
    const startedAt = Date.now();

    if (!allowHidden && !force && !isDocumentVisible()) return;
    if (isRefreshing.current) return;

    const isResumeRefresh =
      source === 'focus_visible' ||
      source === 'visibility_visible';

    if (!force) {
      const sinceStart = startedAt - Number(lastRefreshStartedAt.current || 0);
      const sinceEnd = startedAt - Number(lastRefreshFinishedAt.current || 0);
      const sinceSuccess = startedAt - Number(lastSuccessfulRefreshAt.current || 0);

      if (sinceStart < PASRTRIMI_REFRESH_MIN_GAP_MS || sinceEnd < PASRTRIMI_REFRESH_MIN_GAP_MS) return;
      if (isResumeRefresh && sinceSuccess >= 0 && sinceSuccess < PASRTRIMI_SUCCESS_REFRESH_COOLDOWN_MS) return;
    }

    try { refreshAbortRef.current?.abort(); } catch {}
    const refreshCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    refreshAbortRef.current = refreshCtrl;
    const refreshSignal = refreshCtrl?.signal;

    isRefreshing.current = true;
    didBootLoadRef.current = true;
    lastRefreshStartedAt.current = startedAt;
    lastRefreshSource.current = source;
    if (!Array.isArray(orders) || orders.length === 0) setLoading(false);
    try {
      const diagEnabled = isDiagEnabled();
      const trace = diagEnabled ? [] : null;
      try {
        bootLog('before_local_read', {
          page: 'pastrimi',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
          source,
        });
      } catch {}
      // 1. Lexojmë Outbox-in për porositë që janë ruajtur offline por s'kanë shkuar në DB
      let masterCacheRows = (readPastrimRowsFromBaseMasterCache() || []).map((row) => normalizeRenderableOrderRow(row));
      if (!Array.isArray(masterCacheRows) || masterCacheRows.length === 0) {
        try {
          const hydratedCache = await withTimeout(ensureFreshBaseMasterCache(), 1200);
          masterCacheRows = (readPastrimRowsFromBaseMasterCache(hydratedCache) || []).map((row) => normalizeRenderableOrderRow(row));
        } catch {}
      }
      const pendingOutbox = buildPendingOutboxPastrimRows();
      try {
        bootLog('after_local_read', {
          page: 'pastrimi',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
          source,
          masterCacheCount: Array.isArray(masterCacheRows) ? masterCacheRows.length : 0,
          pendingOutboxCount: Array.isArray(pendingOutbox) ? pendingOutbox.length : 0,
        });
      } catch {}

      // OFFLINE MODE
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const offlineRows = await buildPastrimFallbackRows(trace, diagEnabled).catch(() => []);
        const fallbackRows = dedupePastrimRows([
          ...(Array.isArray(readPastrimRowsFromPageSnapshot()) ? readPastrimRowsFromPageSnapshot() : []),
          ...(Array.isArray(offlineRows) ? offlineRows : []),
        ])
          .filter((row) => shouldShowTransportBridgeInPastrim(row))
          .filter((row) => row?.cope > 0 || row?.m2 > 0 || (row?.name && String(row.name).trim() !== ''));
        fallbackRows.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));

        setReadyCountHint(fallbackRows.length);
        startListTransition(() => {
          setOrders(fallbackRows);
        });
        if (fallbackRows.length > 0) {
          persistPastrimPageSnapshot(fallbackRows, { source: 'offline_snapshot', count: fallbackRows.length });
        }
        setDebugInfo({ source: 'LOCAL_OFFLINE_SNAPSHOT', dbCount: 0, localCount: fallbackRows.length, online: false, lastError: null, ts: Date.now() });
        setLoading(false);
        return;
      }

      // ONLINE MODE
      const [normalData, transportData] = await withTimeout(Promise.all([
        listMixedOrderRecords({
          signal: refreshSignal,
          tables: ['orders'],
          byTable: {
            orders: {
              select: 'id,local_oid,status,created_at,data,code,client_name,client_phone',
              in: { status: ['pastrim','pastrimi'] },
              orderBy: 'created_at',
              ascending: false,
              limit: PASRTRIMI_FETCH_LIMIT,
              timeoutMs: 9000,
            },
          },
        }).then((rows) => rows.map((x) => ({ ...x, _table: undefined }))),
        listMixedOrderRecords({
          signal: refreshSignal,
          tables: ['transport_orders'],
          byTable: {
            transport_orders: {
              select: '*',
              in: { status: TRANSPORT_PASTRIMI_STATUSES },
              orderBy: 'created_at',
              ascending: false,
              limit: PASRTRIMI_FETCH_LIMIT,
              timeoutMs: 9000,
            },
          },
        }).then((rows) => rows.map((x) => ({ ...x, _table: undefined }))),
      ]), PASRTRIMI_REMOTE_REFRESH_TIMEOUT_MS);

      const localRows = await getAllOrdersLocal().catch(() => []);
      const cacheCleanup = reconcileBaseMasterCacheScope({
        statusScope: ['pastrim', 'pastrimi'],
        dbRows: normalData || [],
        localRows,
        outboxItems: typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [],
      });
      masterCacheRows = (readPastrimRowsFromBaseMasterCache(cacheCleanup?.cache) || []).map((row) => normalizeRenderableOrderRow(row));
      purgeZombieLocalArtifacts(cacheCleanup?.removedIds || []);

      const validDbIds = new Set([...(normalData || []), ...(transportData || [])].map((r) => String(r?.id || '').trim()).filter(Boolean));
      const recoveryIndex = buildTerminalRecoveryIndex();
      const zombieIds = new Set(cacheCleanup?.removedIds || []);

      const allOrders = [];
      const dbMirrorRows = [];
      (normalData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        const total = computeOrderDisplayTotal(order);
        const paid = Number(order.pay?.paid || 0);
        const metrics = computeOrderMetrics(order);
        const cope = metrics.pieces;
        const localOid = normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid);
        dbMirrorRows.push({ id: row.id, local_oid: localOid || null, status: row.status, data: row.data ?? null, updated_at: row.updated_at || row.created_at || new Date().toISOString(), _table: 'orders' });
        allOrders.push(normalizeRenderableOrderRow({
          id: row.id, local_oid: localOid || null, status: normalizeStatus(row?.status || order?.status || 'pastrim') || 'pastrim', source: 'orders', ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
          name: row.client_name || order.client?.name || order.client_name || 'Pa Emër', phone: row.client_phone || order.client?.phone || order.client_phone || '',
          code: normalizeCode(order.client?.code || order.code || row.code), m2: metrics.m2,
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: !!order?.returnInfo?.active, fullOrder: localOid && !String(order?.local_oid || '').trim() ? { ...order, local_oid: localOid } : order
        }));
      });

      (transportData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        const total = computeOrderDisplayTotal(order);
        const paid = Number(order.pay?.paid || 0);
        const metrics = computeOrderMetrics(order);
        const cope = metrics.pieces;
        const localOid = normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid);
        dbMirrorRows.push({ id: row.id, local_oid: localOid || null, status: row.status, data: row.data ?? null, updated_at: row.updated_at || row.created_at || new Date().toISOString(), _table: 'transport_orders' });
        const fullOrder = mergeTransportIdentityIntoOrder(row, localOid && !String(order?.local_oid || '').trim() ? { ...order, local_oid: localOid } : order);
        allOrders.push(normalizeRenderableOrderRow({
          id: row.id, local_oid: localOid || null, status: normalizeStatus(row?.status || order?.status || 'pastrim') || 'pastrim', source: 'transport_orders', ts: Number(order.created_at ? Date.parse(order.created_at) : (Date.parse(row.created_at) || 0)),
          name: order.client?.name || '', phone: order.client?.phone || '',
          code: normalizeCode(row.code_str || order.client?.code), m2: metrics.m2,
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: false, fullOrder
        }));
      });

      if (dbMirrorRows.length > 0) {
        try { patchBaseMasterRows(dbMirrorRows); } catch {}
      }

      await yieldToMainThread();

      const normalizedAllOrders = (Array.isArray(allOrders) ? allOrders : []).map((row) => normalizeRenderableOrderRow(row));
      const normalizedMasterCacheRows = (Array.isArray(masterCacheRows) ? masterCacheRows : []).map((row) => normalizeRenderableOrderRow(row));
      const normalizedPendingOutbox = (Array.isArray(pendingOutbox) ? pendingOutbox : []).map((row) => normalizeRenderableOrderRow(row));

      const localPastrimRows = (await readLocalOrdersByStatus('pastrim').catch(() => [])).map((row) => normalizeRenderableOrderRow({
        ...row,
        source: 'LOCAL',
        _synced: row?.synced === true,
        _local: row?.synced !== true,
        local_oid: normalizeLocalOidValue(row?.local_oid, row?.fullOrder?.local_oid, row?.fullOrder?.oid),
      }));
      const reconciledRows = (await safeBuildReconciledRows({
        page: 'pastrimi',
        baseRows: [...normalizedMasterCacheRows, ...normalizedAllOrders],
        localRows: [...localPastrimRows, ...normalizedPendingOutbox],
        outboxSnapshot: typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [],
      })).filter((row) => row?.cope > 0 || row?.m2 > 0 || (row?.name && String(row.name).trim() !== ''));
      reconciledRows.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
      reconciledRows.forEach((row) => pushPastrimTrace(trace, 'preclean_reconciled_rows', row, 'seen', 'generic_reconciler_output_before_pastrim_cleanup'));

      normalizedAllOrders.forEach((row) => pushPastrimTrace(trace, 'normalized_db', row, 'seen', 'db_row_after_mapping'));
      normalizedMasterCacheRows.forEach((row) => pushPastrimTrace(trace, 'normalized_master_cache', row, 'seen', 'master_cache_row_after_mapping'));
      normalizedPendingOutbox.forEach((row) => pushPastrimTrace(trace, 'normalized_outbox', row, 'seen', 'outbox_row_after_mapping'));

      const dbTokenSet = new Set(normalizedAllOrders.flatMap((row) => getPastrimCanonicalTokens(row)));
      const dbTransportCodeSet = new Set((Array.isArray(transportData) ? transportData : []).map((row) => getPastrimTransportCode(row)).filter(Boolean));
      const matchedMirrorIds = [];
      const cleanMasterCacheRows = normalizedMasterCacheRows.filter((row) => {
        const id = String(row?.id || row?.local_oid || '').trim();
        const matchedByDb = getPastrimCanonicalTokens(row).some((token) => dbTokenSet.has(token));
        const transportCode = getPastrimTransportCode(row);
        const matchedByTransportCode = isPastrimTransportScopedRow(row) && transportCode && dbTransportCodeSet.has(transportCode);
        if (matchedByDb || matchedByTransportCode) {
          pushPastrimTrace(trace, 'clean_master_cache', row, 'drop', matchedByTransportCode ? 'matched_by_db_transport_code' : 'matched_by_db_token');
          if (id) matchedMirrorIds.push(id);
          return false;
        }
        if (isTerminalRecoveryGhostRow(row, recoveryIndex)) {
          pushPastrimTrace(trace, 'clean_master_cache', row, 'drop', 'terminal_recovery_ghost_row');
          if (id) matchedMirrorIds.push(id);
          zombieIds.add(id);
          return false;
        }
        if (!rowLooksPendingOrLocal(row) && isPersistedDbLikeId(id) && !validDbIds.has(id)) {
          pushPastrimTrace(trace, 'clean_master_cache', row, 'drop', 'persisted_id_missing_from_valid_db_ids');
          zombieIds.add(id);
          return false;
        }
        pushPastrimTrace(trace, 'clean_master_cache', row, 'keep', 'survived_master_cache_filter');
        return true;
      });
      const cleanPendingOutbox = normalizedPendingOutbox.filter((row) => {
        const id = String(row?.id || row?.local_oid || '').trim();
        const matchedByDb = getPastrimCanonicalTokens(row).some((token) => dbTokenSet.has(token));
        const transportCode = getPastrimTransportCode(row);
        const matchedByTransportCode = isPastrimTransportScopedRow(row) && transportCode && dbTransportCodeSet.has(transportCode);
        if (matchedByDb || matchedByTransportCode) {
          pushPastrimTrace(trace, 'clean_pending_outbox', row, 'drop', matchedByTransportCode ? 'matched_by_db_transport_code' : 'matched_by_db_token');
          if (id) matchedMirrorIds.push(id);
          return false;
        }
        if (isTerminalRecoveryGhostRow(row, recoveryIndex)) {
          pushPastrimTrace(trace, 'clean_pending_outbox', row, 'drop', 'terminal_recovery_ghost_row');
          if (id) matchedMirrorIds.push(id);
          zombieIds.add(id);
          return false;
        }
        pushPastrimTrace(trace, 'clean_pending_outbox', row, 'keep', 'survived_outbox_filter');
        return true;
      });
      if (matchedMirrorIds.length) purgeZombieLocalArtifacts(matchedMirrorIds);

      const dedupedOrders = dedupePastrimRows([...cleanMasterCacheRows, ...normalizedAllOrders, ...cleanPendingOutbox]).filter((row) => {
        const id = String(row?.id || row?.local_oid || '').trim();
        if (isTerminalRecoveryGhostRow(row, recoveryIndex)) {
          pushPastrimTrace(trace, 'final_visibility_filter', row, 'drop', 'terminal_recovery_ghost_row');
          return false;
        }
        if (!shouldShowTransportBridgeInPastrim(row)) {
          pushPastrimTrace(trace, 'final_visibility_filter', row, 'drop', 'transport_bridge_not_ready_for_base');
          return false;
        }
        const rowStatus = normalizeStatus(row?.status || row?.fullOrder?.status || row?.data?.status || '');
        const forceShowPastrim = (row?.source === 'orders' || row?.source === 'BASE_CACHE') && (rowStatus === 'pastrim' || rowStatus === 'pastrimi');
        if (forceShowPastrim) {
          pushPastrimTrace(trace, 'final_visibility_filter', row, 'keep', 'db_or_base_cache_pastrim_row');
          return true;
        }
        if (rowLooksPendingOrLocal(row)) {
          pushPastrimTrace(trace, 'final_visibility_filter', row, 'keep', 'pending_or_local_row');
          return true;
        }
        const drop = isPersistedDbLikeId(id) && !validDbIds.has(id);
        pushPastrimTrace(trace, 'final_visibility_filter', row, drop ? 'drop' : 'keep', drop ? 'persisted_id_missing_from_valid_db_ids' : 'valid_persisted_row');
        return !drop;
      });

      dedupedOrders.sort((a, b) => b.ts - a.ts);

      let cleanOrders = dedupedOrders.filter((o) => {
        const keep = o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== '');
        pushPastrimTrace(trace, 'final_nonempty_filter', o, keep ? 'keep' : 'drop', keep ? 'row_has_display_content' : 'row_empty_after_mapping');
        return keep;
      });

      if (exactSearchMode && /^\d+$/.test(String(openId || '').trim()) && !cleanOrders.some((row) => String(row?.id || row?.dbId || '').trim() === String(openId || '').trim())) {
        const recoveredExactRow = await recoverExactPastrimRow(openId, { skipNetwork: !isDocumentVisible() && hiddenSearchBootRef.current });
        if (recoveredExactRow && shouldShowTransportBridgeInPastrim(recoveredExactRow)) {
          cleanOrders = dedupePastrimRows([recoveredExactRow, ...cleanOrders]).sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
          setExactRecoveredRow(recoveredExactRow);
          try {
            bootLog('pastrimi_exact_injected', {
              page: 'pastrimi',
              path: typeof window !== 'undefined' ? (window.location.pathname || '/pastrimi') : '/pastrimi',
              source,
              openId,
              recoveredSource: String(recoveredExactRow?.source || ''),
            });
          } catch {}
        }
      }
      if (diagEnabled) {
        try {
          if (typeof window !== 'undefined') window.__tepihaPastrimTrace = trace;
        } catch {}
        try { console.debug('[PASTRIM refreshOrders trace]', trace); } catch {}
      }
      const streamTotal = cleanOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);

      setReadyCountHint(cleanOrders.length);
      startListTransition(() => {
        setOrders(cleanOrders);
        setStreamPastrimM2(Number(streamTotal.toFixed(2)));
      });
      persistPastrimPageSnapshot(cleanOrders, { source, count: cleanOrders.length, streamTotal: Number(streamTotal.toFixed(2)) });

      scheduleDeferredLocalPersist(dbMirrorRows.slice(0, 120), 2000);
      lastSuccessfulRefreshAt.current = Date.now();

    } catch (e) {
      if (refreshSignal?.aborted) return;
      console.error('refreshOrders failed:', e);
      triggerFatalCacheHeal(e);
      const immediateRows = buildImmediatePastrimLocalRows();
      const isTimeout = /TIMEOUT|AbortError|timeout/i.test(String(e?.message || e || ''));
      writePastrimiLoadingTimeoutMarker({
        source,
        cacheSourceUsed: immediateRows.length > 0 ? 'local_cache' : 'empty_local',
        localRowCount: immediateRows.length,
        remoteTimeout: isTimeout,
        error: String(e?.message || e || ''),
      });
      const diagEnabled = isDiagEnabled();
      const trace = diagEnabled ? [] : null;
      const fallbackRows = dedupePastrimRows([
        ...immediateRows,
        ...((await buildPastrimFallbackRows(trace, diagEnabled).catch(() => [])) || []),
      ]).filter((row) => shouldShowTransportBridgeInPastrim(row));
      const fallbackTotal = (Array.isArray(fallbackRows) ? fallbackRows : []).reduce((sum, row) => sum + (Number(row?.m2) || 0), 0);
      if (fallbackRows.length > 0) {
        setReadyCountHint(fallbackRows.length);
        startListTransition(() => {
          setOrders(fallbackRows);
          setStreamPastrimM2(Number(fallbackTotal.toFixed(2)));
        });
        setDebugInfo({ source: 'LOCAL_FALLBACK', dbCount: 0, localCount: fallbackRows.length, online: navigator?.onLine !== false, lastError: String(e?.message || e), ts: Date.now() });
      } else {
        setReadyCountHint(0);
        startListTransition(() => {
          setOrders([]);
          setStreamPastrimM2(0);
        });
        setDebugInfo({ source: 'ERROR', dbCount: 0, localCount: 0, online: navigator?.onLine !== false, lastError: String(e?.message || e), ts: Date.now() });
      }
    } finally {
      if (refreshAbortRef.current === refreshCtrl) {
        refreshAbortRef.current = null;
      }
      isRefreshing.current = false;
      lastRefreshFinishedAt.current = Date.now();
      setLoading(false);
    }
  }

  async function refreshRackMap(options = {}) {
    const preserveOnError = options?.preserveOnError !== false;
    try {
      const map = await withTimeout(fetchRackMapFromDb(options), Number(options?.timeoutMs || 4500) || 4500);
      const safeMap = map || {};
      setSlotMap(safeMap);
      return safeMap;
    } catch {
      if (!preserveOnError) setSlotMap({});
      return preserveOnError ? (slotMap || {}) : {};
    }
  }

  async function openEdit(item) {
    if (item._outboxPending) {
       alert("⏳ Kjo porosi është në pritje për internet. Nuk mund ta editosh derisa të dërgohet në server.");
       return;
    }
    try {
      const rawDbId = item?.db_id ?? item?.id ?? item?.fullOrder?.db_id ?? item?.fullOrder?.id ?? null;
      const safeDbId =
        typeof rawDbId === 'number' ? rawDbId :
        (typeof rawDbId === 'string' && /^\d+$/.test(rawDbId.trim()) ? Number(rawDbId.trim()) : null);

      let fetchedRow = null;
      if (safeDbId !== null && !isPastrimTransportScopedRow(item)) {
        try {
          fetchedRow = await withTimeout(
            fetchOrderByIdSafe('orders', safeDbId, 'id,local_oid,status,created_at,updated_at,data,code,client_name,client_phone'),
            2600
          );
        } catch {}
      }

      let localShadow = null;
      try {
        const shadowKeys = [
          `order_${safeDbId || ''}`,
          `order_${item?.id || ''}`,
          `order_${item?.local_oid || ''}`,
        ].filter(Boolean);
        for (const key of shadowKeys) {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          localShadow = JSON.parse(raw);
          if (localShadow && typeof localShadow === 'object') break;
        }
      } catch {}

      const ord = mergePastrimEditOrderForBridge(
        { ...(item || {}), fullOrder: localShadow || item?.fullOrder || item?.data || {} },
        fetchedRow
      );

      const bridgeSource = isPastrimTransportScopedRow(item)
        ? 'transport_orders'
        : (['orders', 'BASE_CACHE', 'LOCAL', 'OUTBOX'].includes(String(item?.source || '').trim()) ? String(item?.source || '').trim() : 'orders');

      const editCodeProbe = String(
        item?.code || item?.code_str || item?.client_tcode || item?.order_code ||
        ord?.code || ord?.code_str || ord?.client_tcode || ord?.client?.tcode || ord?.client?.code ||
        ''
      ).trim();
      const isTransportEdit = bridgeSource === 'transport_orders' || /^T\d+$/i.test(editCodeProbe);
      if (isTransportEdit) {
        const transportEditId = String(rawDbId || item?.transport_order_id || item?.fullOrder?.id || ord?.id || '').trim();
        if (!transportEditId) {
          alert('❌ Nuk u gjet ID e transport order për editim.');
          return;
        }
        try { sessionStorage.removeItem(PRANIMI_RESET_ON_SHOW_KEY); } catch {}
        try { sessionStorage.removeItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY); } catch {}
        try { sessionStorage.removeItem(PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY); } catch {}
        try { localStorage.removeItem(PASRTRIMI_EDIT_TO_PRANIMI_KEY); } catch {}
        router.push(`/transport/pranimi?edit=${encodeURIComponent(transportEditId)}&from=pastrimi-edit`);
        return;
      }

      const payload = buildCompactPranimiEditPayload({
        source: bridgeSource,
        safeDbId,
        localOid: normalizeLocalOidValue(item?.local_oid, fetchedRow?.local_oid, ord?.local_oid, ord?.data?.local_oid, ord?.oid, safeDbId, item?.id),
        ts: Number(ord?.ts || item?.ts || Date.parse(fetchedRow?.updated_at || fetchedRow?.created_at || 0) || Date.now()),
        code: normalizeCode(item?.code || ord?.code || ord?.code_n || ord?.client?.code || fetchedRow?.code || ''),
        order: ord,
      });
      try {
        const rawPayload = JSON.stringify(payload);
        try { sessionStorage.removeItem(PRANIMI_RESET_ON_SHOW_KEY); } catch {}
        try { window.__TEPIHA_ACTIVE_EDIT_BRIDGE__ = payload; } catch {}
        try { sessionStorage.setItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY, rawPayload); } catch {}
        localStorage.setItem(PASRTRIMI_EDIT_TO_PRANIMI_KEY, rawPayload);
        try { sessionStorage.setItem(PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY, rawPayload); } catch {}
      } catch {}
      const baseEditId = String(rawDbId || safeDbId || item?.id || '').trim();
      const baseEditQuery = baseEditId ? `edit=${encodeURIComponent(baseEditId)}&` : '';
      router.push(`/pranimi?${baseEditQuery}from=pastrimi-edit`);
    } catch (e) {
      alert('❌ Gabim gjatë hapjes!');
    }
  }

  function startLongPress(item) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => openEdit(item), 600);
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const currentPaidAmount = Number((Number(clientPaid) || 0).toFixed(2));
      let finalArka = Number(arkaRecordedPaid) || 0;
      const existingRow = (Array.isArray(orders) ? orders : []).find((row) => String(row?.id || '').trim() === String(oid || '').trim());
      const existingOrder = mergeReadyMetaIntoOrder(existingRow?.fullOrder || {}, existingRow || {});
      const existingReadyMeta = readReadyMeta(existingOrder, existingRow || {});
      const existingLocalOid = normalizeLocalOidValue(existingOrder?.local_oid, existingRow?.local_oid);

      const order = {
        id: oid, ts: origTs, status: 'pastrim',
        client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: normalizeCode(codeRaw), photoUrl: clientPhotoUrl || '' },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: { m2: totalM2, rate: Number(pricePerM2) || PRICE_DEFAULT, euro: totalEuro, paid: currentPaidAmount, debt: currentDebt, paidUpfront: paidUpfront, method: payMethod, arkaRecordedPaid: finalArka },
        notes: notes || '',
        returnInfo: returnActive ? { active: true, at: returnAt, reason: returnReason, note: returnNote, photoUrl: returnPhoto } : undefined,
        ...(existingLocalOid ? { local_oid: existingLocalOid } : {}),
        ready_note: existingReadyMeta.readyNote,
        ready_note_text: existingReadyMeta.readyText,
        ready_location: existingReadyMeta.readyLocation,
        ready_slots: existingReadyMeta.readySlots,
        ready_note_at: existingReadyMeta.readyNoteAt,
        ready_note_by: existingReadyMeta.readyNoteBy,
      };

      const { error: dbErr } = await supabase.from(orderSource).update({ status: 'pastrim', data: order, updated_at: new Date().toISOString() }).eq('id', oid);
      if (dbErr) throw dbErr;

      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function openReadyPlaceSheet(o) {
    if (o?._outboxPending) {
      alert("⏳ Kjo porosi është në pritje për internet. Prit sa të sinkronizohet lart.");
      return;
    }
    setReadyPlaceOrder(o);
    setReadyPlaceText(String(o?.fullOrder?.ready_note_text || o?.fullOrder?.ready_note || o?.fullOrder?.ready_location || ''));
    setReadySlots(normalizeRackSlots(o?.fullOrder?.ready_slots || o?.fullOrder?.ready_location || o?.fullOrder?.ready_note || ''));
    setReadyPlaceSheet(true);
    scheduleReadyPlaceWarmup({
      delay: 180,
      force: !slotMap || Object.keys(slotMap).length === 0,
    });
  }

  async function confirmReadyPlaceAndSend(selectedSpot) {
    if (!readyPlaceOrder || readyPlaceBusy) return;
    cancelReadyPlaceWarmup();
    const picked = String(selectedSpot || '').trim().toUpperCase();
    if (!picked) return;
    const nextSlots = [picked];
    const txt = String(readyPlaceText || '').trim();
    setReadyPlaceBusy(true);
    try {
      setReadyPlaceSheet(false);
      await handleMarkReady(readyPlaceOrder, { readyNote: txt, readySlots: nextSlots });
      scheduleRackMapRefresh(1600);
      setReadyPlaceOrder(null);
      setReadyPlaceText('');
      setReadySlots([]);
    } finally {
      setReadyPlaceBusy(false);
    }
  }

  async function handleMarkReady(o, opts = {}) {
    if (o._outboxPending) {
       alert("⏳ Kjo porosi është në pritje për internet. Prit sa të sinkronizohet lart.");
       return;
    }
    const btnId = `btn-${o.id}`;
    const btn = document.getElementById(btnId);
    if(btn) { btn.disabled = true; btn.innerText = "⏳..."; }

    const now = new Date().toISOString();
    const resolvedReadySlots = Array.isArray(opts?.readySlots)
      ? opts.readySlots.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const resolvedReadyText = String(opts?.readyNote || '').trim();
    const resolvedReadyNote = resolvedReadySlots.length
      ? `📍 [${resolvedReadySlots.join(', ')}] ${resolvedReadyText}`.trim()
      : resolvedReadyText;
    const existingOrder = mergeReadyMetaIntoOrder(o?.fullOrder || {}, o || {});
    const existingLocalOid = normalizeLocalOidValue(o?.local_oid, existingOrder?.local_oid, existingOrder?.oid);
    const readyDataPatch = {
      ...(resolvedReadyNote ? { ready_note: resolvedReadyNote } : {}),
      ready_note_text: resolvedReadyText,
      ready_location: String(resolvedReadySlots.length ? resolvedReadySlots.join(', ') : resolvedReadyText).trim(),
      ready_slots: resolvedReadySlots,
      ready_at: now,
      ...(existingLocalOid ? { local_oid: existingLocalOid } : {}),
    };
    const baseDriverNotifyPatch = (() => {
      if (!isPastrimTransportScopedRow(o)) return {};
      let actor = null;
      try { actor = getActor?.(); } catch {}
      const by = String(actor?.pin || actor?.name || actor?.id || 'BAZA').trim() || 'BAZA';
      return {
        base_driver_notified_at: now,
        base_driver_notified_by: by,
        base_driver_notified_by_pin: actor?.pin || null,
        base_driver_notified_by_name: actor?.name || null,
        base_driver_notified_by_role: actor?.role || null,
        base_driver_notified_from: 'pastrimi',
      };
    })();
    var updatedJson = null;

    try {
      const localBranch = isLocalReadyTransitionRow(o);
      const table = localBranch ? 'orders' : getReadyTargetTable(o);
      let currentData = null;
      let currentDataSource = 'fetch';

      if (!localBranch && /^\d+$/.test(String(o?.id || '').trim())) {
        const rowCheck = await fetchOrderByIdSafe(table, Number(o.id), 'id,status', { timeoutMs: 9000 }).catch(() => null);
        if (!rowCheck) {
          purgeGhostPastrimArtifacts(o, 'mark_ready_missing_db_row');
          setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => String(item?.id || item?.db_id || '') !== String(o?.id || o?.db_id || '')));
          alert('Kjo porosi nuk ekziston më në DB. U hoq nga lista.');
          await refreshOrders({ force: true, source: 'mark_ready_missing_db_row' });
          return;
        }
      }

      try {
        currentData = await withTimeout(fetchOrderDataById(table, o.id));
      } catch (fetchErr) {
        currentData = existingOrder;
        currentDataSource = 'row_fallback';
        try {
          console.warn('[PASTRIM mark_ready] fetchOrderDataById fallback', {
            orderId: o?.id,
            table,
            source: o?.source,
            message: String(fetchErr?.message || fetchErr || ''),
            code: fetchErr?.code || null,
            details: fetchErr?.details || null,
            hint: fetchErr?.hint || null,
          });
        } catch {}
      }

      updatedJson = {
        ...((currentData && typeof currentData === 'object' && !Array.isArray(currentData)) ? currentData : {}),
        status: 'gati',
        state: 'gati',
        ...readyDataPatch,
        ...baseDriverNotifyPatch,
      };
      const transitionPatch = { data: updatedJson, ready_at: now, updated_at: now };
      try {
        await safeRecordReconcileTombstone({
          id: o?.id,
          local_oid: existingLocalOid || o?.local_oid || '',
          code: o?.code || updatedJson?.code || updatedJson?.client?.code || '',
          table: table,
          status: 'gati',
        }, { reason: 'pastrimi_mark_ready', ttlMs: 1000 * 60 * 60 * 8 });
      } catch {}

      if (localBranch) {
        const { updateOrderStatus } = await import('@/lib/ordersDb');
        await updateOrderStatus(o.id, 'gati', transitionPatch);
      } else {
        await transitionOrderStatus(table, o.id, 'gati', transitionPatch);
        if (table === 'transport_orders') {
          alert(`✅ U bë GATI!
Shoferi u njoftua në listën e tij.`);
        }
      }

      const optimisticReadyRow = {
        id: o?.id,
        status: 'gati',
        data: updatedJson,
        ready_at: now,
        updated_at: now,
        _table: table,
        _synced: !localBranch,
      };
      try {
        await saveOrderLocal(optimisticReadyRow);
      } catch {}
      if (table === 'orders') {
        try { patchBaseMasterRow(optimisticReadyRow); } catch {}
      }
      if (table === 'transport_orders') {
        const readyTransportTarget = normalizeRenderableOrderRow({
          ...(o && typeof o === 'object' ? o : {}),
          status: 'gati',
          data: updatedJson,
          fullOrder: updatedJson,
          source: 'transport_orders',
          table: 'transport_orders',
          _table: 'transport_orders',
        });
        removePastrimTransportRowsFromLocalCaches(readyTransportTarget, 'mark_ready_transport_cleanup');
        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => !pastrimRowMatchesCleanupTarget(item, readyTransportTarget)));
      }

      await refreshOrders({ force: true, source: 'mark_ready_success' });
      scheduleRackMapRefresh(1800);

      if (!isPastrimTransportScopedRow(o)) {
        let smsOrder = { ...(o || {}), fullOrder: updatedJson };
        try {
          const fresh = await import('@/lib/ordersService').then((m) => m.fetchOrderByIdSafe('orders', o.id, '*'));
          if (fresh) smsOrder = fresh;
        } catch {}
        const resolvedPhone = String(
          smsOrder?.client_phone ||
          smsOrder?.data?.client_phone ||
          smsOrder?.client?.phone ||
          smsOrder?.data?.client?.phone ||
          smsOrder?.phone ||
          o?.phone ||
          ''
        ).trim();
        const text = buildSmartSmsText(smsOrder || o, 'gati_baze');
        if (resolvedPhone) setSmsModal({ open: true, phone: resolvedPhone, text });
      }
    } catch (e) {
      const safeUpdatedJson = updatedJson && typeof updatedJson === 'object' ? updatedJson : {};
      const diag = {
        orderId: String(o?.id || ''),
        source: o?.source || '',
        status: o?.status || '',
        local_oid: normalizeLocalOidValue(o?.local_oid, o?.fullOrder?.local_oid, o?.fullOrder?.oid),
        branch: isLocalReadyTransitionRow(o) ? 'local' : 'db',
        table: isLocalReadyTransitionRow(o) ? 'orders' : getReadyTargetTable(o),
        message: String(e?.message || e || ''),
        stack: String(e?.stack || ''),
        code: e?.code || null,
        details: e?.details || null,
        hint: e?.hint || null,
        name: e?.name || null,
        payload: {
          status: 'gati',
          ready_note: readyDataPatch.ready_note || '',
          ready_note_text: readyDataPatch.ready_note_text || '',
          ready_location: readyDataPatch.ready_location || '',
          ready_slots: Array.isArray(readyDataPatch.ready_slots) ? readyDataPatch.ready_slots : [],
          ready_at: readyDataPatch.ready_at || now,
          local_oid: readyDataPatch.local_oid || '',
          data_ready: {
            ready_note: safeUpdatedJson?.ready_note || '',
            ready_note_text: safeUpdatedJson?.ready_note_text || '',
            ready_location: safeUpdatedJson?.ready_location || '',
            ready_slots: Array.isArray(safeUpdatedJson?.ready_slots) ? safeUpdatedJson.ready_slots : [],
            ready_at: safeUpdatedJson?.ready_at || now,
            local_oid: safeUpdatedJson?.local_oid || '',
          },
        },
      };
      try {
        if (typeof window !== 'undefined') window.__tepihaMarkReadyError = diag;
      } catch {}
      try { console.error('[PASTRIM mark_ready] failed', diag); } catch {}
      if (/ORDER_NOT_FOUND|not found|PGRST116/i.test(diag.message || '')) {
        purgeGhostPastrimArtifacts(o, 'mark_ready_error_missing_row');
        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => String(item?.id || item?.db_id || '') !== String(o?.id || o?.db_id || '')));
        alert('Kjo porosi nuk ekziston më në DB. U hoq nga lista.');
      } else {
        alert(`❌ Diçka shkoi keq: ${diag.message || 'UNKNOWN_ERROR'}`);
      }
      await refreshOrders({ force: true, source: 'mark_ready_error' });
    }
  }

  const totalM2 = useMemo(() => {
    const t = tepihaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const s = stazaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((t + s + sh).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);

  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - clientPaid).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    setter(rows => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '', photoUrl: '' }]);
  }
  function removeRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter(rows => (rows.length > 1 ? rows.slice(0, -1) : rows));
  }
  function handleRowChange(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter(rows => rows.map(r => (r.id === id ? { ...r, [field]: value } : r)));
  }

  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (url) handleRowChange(kind, id, 'photoUrl', url);
    } catch (e) {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod("CASH");
    setShowPaySheet(true);
  }

  async function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    if (due <= 0) {
      alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.');
      return;
    }
    if (cashGiven <= 0) {
      alert('SHKRUANI SHUMËN!');
      return;
    }

    const applied = Math.min(cashGiven, due);
    const remaining = Math.max(0, Number((due - applied).toFixed(2)));
    const kusuri = Math.max(0, cashGiven - due);
    const pinLabel = `PAGESË: ${applied.toFixed(2)}€
KLIENTI DHA: ${cashGiven.toFixed(2)}€
KUSURI (RESTO): ${kusuri.toFixed(2)}€
BORXHI PAS: ${remaining.toFixed(2)}€

👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;

    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI: përditëso menjëherë UI dhe mbyll modalin
    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    if (payMethod === 'CASH') {
      setArkaRecordedPaid(Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2)));
    }

    setShowPaySheet(false);

    // Background network work (mos blloko UI)
    void (async () => {
      try {
        if (payMethod === 'CASH') {
          const extId = `pay_${oid}_${Date.now()}`;
          await recordCashMoveSafe({
            externalId: extId,
            orderId: oid,
            code: normalizeCode(codeRaw),
            name: name.trim(),
            amount: applied,
            note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`,
            source: 'ORDER_PAY',
            method: 'cash_pay',
            type: 'IN',
            actor: { pin: pinData.pin, name: pinData.name, role: pinData.role },
            created_by_pin: pinData.pin,
            created_by_name: pinData.name,
          });
        }
      } catch (e) {}
    })();
  }

  // ==== UI EDIT MODE ====
  if (editMode) {
    return (
      <div className="wrap">
        <header className="header-row" style={{ alignItems: 'flex-start' }}>
          <div><h1 className="title">PASTRIMI</h1><div className="subtitle">EDITIMI ({normalizeCode(codeRaw)})</div></div>
          <div className="code-badge"><span className="badge">{normalizeCode(codeRaw)}</span></div>
        </header>

        <section className="card">
          <h2 className="card-title">Klienti</h2>
          <div className="field-group">
            <label className="label">EMRI</label>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <input className="input" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
            </div>
          </div>
          <div className="field-group"><label className="label">TELEFONI</label><div className="row"><input className="input small" value={phonePrefix} readOnly /><input className="input" value={phone} onChange={e => setPhone(e.target.value)} /></div></div>
        </section>

        {['tepiha', 'staza'].map(kind => (
          <section className="card" key={kind}>
            <h2 className="card-title">{kind.toUpperCase()}</h2>
            <div className="chip-row">
              {(kind === 'tepiha' ? TEPIHA_CHIPS : STAZA_CHIPS).map(val => (
                <button key={val} className="chip" onClick={() => {
                    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
                    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
                    const emptyIdx = rows.findIndex(r => !r.m2);
                    if (emptyIdx !== -1) { const nr = [...rows]; nr[emptyIdx].m2 = String(val); setter(nr); } 
                    else { setter([...rows, { id: `${kind[0]}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
                  }}>{val}</button>
              ))}
            </div>
            {(kind === 'tepiha' ? tepihaRows : stazaRows).map(row => (
              <div className="piece-row" key={row.id}>
                <div className="row">
                  <input className="input small" type="number" value={row.m2} onChange={e => handleRowChange(kind, row.id, 'm2', e.target.value)} placeholder="m²" />
                  <input className="input small" type="number" value={row.qty} onChange={e => handleRowChange(kind, row.id, 'qty', e.target.value)} placeholder="copë" />
                  <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleRowPhotoChange(kind, row.id, e.target.files?.[0])} /></label>
                </div>
                {row.photoUrl && (<div style={{ marginTop: 8 }}><img src={row.photoUrl} className="photo-thumb" alt="" /><button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange(kind, row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button></div>)}
              </div>
            ))}
            <div className="row btn-row"><button className="btn secondary" onClick={() => addRow(kind)}>+ RRESHT</button><button className="btn secondary" onClick={() => removeRow(kind)}>− RRESHT</button></div>
          </section>
        ))}

        <section className="card">
          <div className="row util-row" style={{ gap: '10px' }}><button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button></div>
          <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
          <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
          {currentDebt > 0 && (<div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>)}
        </section>

        <footer className="footer-bar"><button className="btn secondary" onClick={() => setEditMode(false)}>← ANULO</button><button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? 'RUHET...' : 'RUAJ'}</button></footer>

        {/* MODALI I ARKËS POS */}
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="PAGESA (ARKË)"
          subtitle={`KODI: ${normalizeCode(codeRaw)} • ${name}`}
          total={totalEuro}
          alreadyPaid={Number(clientPaid || 0)}
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={saving}
          onConfirm={applyPayAndClose}
          allowPartial
          footerNote="MUNDESH ME PRANU PAGESË TË PJESSHME. BORXHI I MBETUR RUHET AUTOMATIKISHT."
        />

        <style jsx>{`
          .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); }
          .photo-thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 8px; }
          .camera-btn { background: rgba(255,255,255,0.1); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 12px; }
        `}</style>
      </div>
    );
  }

  // ==== UI LIST (MAIN) ====
  const visibleOrders = useMemo(() => {
    const list = (Array.isArray(orders) ? orders : []).filter((row) => shouldShowTransportBridgeInPastrim(row));

    if (exactSearchMode && openId && !exactSearchTimedOut) {
      const exactList = list.filter((o) => {
        return String(o?.id || '').trim() === openId || String(o?.dbId || '').trim() === openId;
      });
      if (exactList.length > 0) return exactList;
      if (exactRecoveredRow && shouldShowTransportBridgeInPastrim(exactRecoveredRow) && (String(exactRecoveredRow?.id || '').trim() === openId || String(exactRecoveredRow?.dbId || '').trim() === openId)) {
        return [exactRecoveredRow];
      }
      return [];
    }

    if (exactSearchMode && exactSearchTimedOut) {
      return list;
    }

    const rawSearch = String(deferredSearch || '');
    const s = rawSearch.toLowerCase();
    const scode = normalizeCode(rawSearch);

    return list.filter((o) => {
      const name = String(o?.name || '').toLowerCase();
      const code = normalizeCode(o?.code || '');
      return name.includes(s) || code.includes(scode);
    });
  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, deferredSearch]);

  const streamPct = Math.min(100, (Number(streamPastrimM2 || 0) / STREAM_MAX_M2) * 100);
  const pastrimiSourceBadge = /SYNC|REMOTE|DB|SUPABASE/i.test(String(localModeNotice || '')) ? 'SYNC' : 'LOCAL';

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 className="title" style={{ margin: 0 }}>PASTRIMI</h1>
          <span
            aria-label={`Burimi i të dhënave: ${pastrimiSourceBadge}`}
            title={pastrimiSourceBadge === 'LOCAL' ? 'TË DHËNA LOKALE' : 'SYNC'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 20,
              padding: '2px 7px',
              borderRadius: 999,
              border: pastrimiSourceBadge === 'LOCAL' ? '1px solid rgba(59,130,246,.35)' : '1px solid rgba(34,197,94,.35)',
              background: pastrimiSourceBadge === 'LOCAL' ? 'rgba(59,130,246,.12)' : 'rgba(34,197,94,.12)',
              color: pastrimiSourceBadge === 'LOCAL' ? '#bfdbfe' : '#bbf7d0',
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: '.04em',
              lineHeight: 1,
            }}
          >{pastrimiSourceBadge}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
          <button
            onClick={async () => {
              if (!window.confirm('A jeni të sigurt që doni të pastroni ghost cache për PASTRIMI?')) return;
              try {
                const cleared = clearBaseMasterCacheScope(['pastrim', 'pastrimi']);
                clearPageSnapshot('pastrimi');
                purgeZombieLocalArtifacts(cleared?.removedIds || []);
                setLoading(false);
                await refreshOrders({ force: true, source: 'manual_clear_scope_pastrim' });
              } catch (e) {
                console.error('[pastrimi] scoped clear cache failed', e);
                alert('Gabim gjatë pastrimit të cache për PASTRIMI.');
              }
            }}
            style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', color: '#fca5a5', padding: '6px 10px', borderRadius: '8px', fontWeight: '900', fontSize: '11px' }}>🧹 FSHI CACHE</button>
        </div>
      </header>

      <section className="cap-card">
        <div className="cap-title">TOTAL M² NË PROCES</div>
        <div className="cap-value">{Number(streamPastrimM2 || 0).toFixed(1)}</div>
        <div className="cap-bar"><div className="cap-fill" style={{ width: `${streamPct}%` }} /></div>
        <div className="cap-row"><span>0 m²</span><span>MAX: {STREAM_MAX_M2} m²</span></div>
      </section>

      <input className="input" placeholder="🔎 Kërko emrin ose kodin..." value={search} onChange={e => setSearch(e.target.value)} />

      <section className="card" style={{ padding: '10px' }}>
        {!loading && exactSearchMode && !exactSearchTimedOut && visibleOrders.length === 0 ? <p data-visible-stuck-candidate="1" style={{ textAlign: 'center' }}>DUKE HAPUR NGA KËRKIMI... Nëse nuk gjendet shpejt, lista lokale hapet vetë.</p> : null}
        {loading && visibleOrders.length === 0 ? <p style={{ textAlign: 'center' }}>Duke u ngarkuar nga cache...</p> : (visibleOrders.length === 0 ? <p style={{ textAlign: 'center', color: 'rgba(255,255,255,.72)' }}>Nuk ka porosi në PASTRIMI.</p> : 
          visibleOrders.map(o => {
              if (!o || !o.id) return null;
              // SHTUAR: Përmirësimi i Kodit
              const codeLabel = o?.code != null ? String(o.code).trim() : '—';
              const cope = Number(o?.cope || 0);
              const m2 = Number(o?.m2 || 0);
              const total = Number(o?.total || 0);
              const paid = Number(o?.paid || 0);

              const isTransportDisplay = isPastrimTransportScopedRow(o);
              const transportMeta = isTransportDisplay ? getTransportBaseSummary(o, transportUserLookup) : null;

              return (
              <div key={o.id + o.source} className="list-item-compact" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', opacity: o.isReturn ? 0.92 : 1 }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1 }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, flexShrink:0 }}>
                    <div
                      onMouseDown={() => startLongPress(o)}
                      onTouchStart={() => startLongPress(o)}
                      onMouseUp={cancelLongPress}
                      onTouchEnd={cancelLongPress}
                      style={{
                        background: isTransportDisplay ? '#dc2626' : badgeColorByAge(o.ts),
                        border: isTransportDisplay ? '2px solid rgba(255,255,255,0.18)' : 'none',
                        color: '#fff', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, fontWeight: 800, fontSize: 14, flexShrink: 0
                      }}>
                      {codeLabel}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>{formatDayMonth(o.ts)}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {o.name} 
                      {/* SHTUAR: Etiketa NË PRITJE për Offline */}
                      {o._outboxPending && <span style={{ color: '#f59e0b', fontWeight: 800, marginLeft: 6 }}>⏳ PRITJE</span>}
                      {o.isReturn && <span style={{color:'#f59e0b'}}>• KTHIM</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{cope} copë • {m2.toFixed(2)} m²</div>
                    {transportMeta?.broughtBy ? <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 800 }}>🚚 E SOLLI: {String(transportMeta.broughtBy).toUpperCase()}</div> : null}
                    {transportMeta?.rackText ? <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.68)', fontWeight: 700 }}>📍 {String(transportMeta.rackText).toUpperCase()}</div> : null}
                    {total > paid && <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 'bold' }}>Borxh: {(total - paid).toFixed(2)}€</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {o.isPaid && <span>✅</span>}
                  <button id={`btn-${o.id}`} className="btn primary" style={{ padding: '6px 10px', fontSize: 12, backgroundColor: isTransportDisplay ? '#dc2626' : '#16a34a' }} onClick={() => openReadyPlaceSheet(o)}>
                    {isTransportDisplay ? 'NJOFTO 🚚' : 'SMS KLIENTIT'}
                  </button>
                </div>
              </div>
            )}))}
      </section>


      <LocalErrorBoundary boundaryKind="panel" routePath="/pastrimi" routeName="PASTRIMI" moduleName="PastrimiRackLocationModal" componentName="RackLocationModal" sourceLayer="pastrimi_panel" showHome={false} repairHref="/pwa-repair.html?from=rack_modal_import_failure" repairLabel="RIPARO APP">
        <Suspense fallback={readyPlaceSheet ? <div className="card" style={{ marginTop: 12, color: '#fff', fontWeight: 900 }}>DUKE HAPUR LOKACIONIN…</div> : null}>
          {readyPlaceSheet ? (
            <RackLocationModal
              open={readyPlaceSheet}
              busy={readyPlaceBusy}
              orderCode={normalizeCode(readyPlaceOrder?.fullOrder?.client_tcode || readyPlaceOrder?.code || readyPlaceOrder?.fullOrder?.code || readyPlaceOrder?.fullOrder?.client?.code)}
              currentOrderId={readyPlaceOrder?.id}
              subtitle="Zgjidh një ose më shumë vende"
              slotMap={slotMap}
              selectedSlots={readySlots}
              placeText={readyPlaceText}
              onTextChange={setReadyPlaceText}
              onToggleSlot={(slot) => confirmReadyPlaceAndSend(slot)}
              onClose={() => { if (!readyPlaceBusy) { cancelReadyPlaceWarmup(); setReadyPlaceSheet(false); setReadyPlaceOrder(null); setReadyPlaceText(''); setReadySlots([]); } }}
              onClear={() => { setReadyPlaceText(''); setReadySlots([]); }}
              error=""
              autoSaveOnSlot
            />
          ) : null}
        </Suspense>
      </LocalErrorBoundary>

      <footer className="dock">
        <button
          type="button"
          className="btn secondary"
          style={{ width: '100%', touchAction: 'manipulation' }}
          onClick={(e) => {
            e.preventDefault();
            router.push('/');
          }}
        >
          🏠 HOME
        </button>
      </footer>

      <SmartSmsModal
        isOpen={smsModal.open}
        onClose={() => setSmsModal((s) => ({ ...s, open: false }))}
        phone={smsModal.phone}
        messageText={smsModal.text}
      />

      <style jsx>{`
        .list-item-compact:last-child { border-bottom: none; }
        .cap-card { margin-top: 8px; padding: 8px; border-radius: 14px; background: #0b0b0b; border: 1px solid rgba(255, 255, 255, 0.1); }
        .cap-title { text-align: center; font-size: 10px; color: rgba(255, 255, 255, 0.65); font-weight: 800; }
        .cap-value { text-align: center; font-size: 26px; font-weight: 900; margin-top: 4px; color: #16a34a; }
        .cap-bar { height: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.12); overflow: hidden; margin-top: 6px; }
        .cap-fill { height: 100%; background: #16a34a; }
        .cap-row { display: flex; justifyContent: space-between; font-size: 10px; color: rgba(255, 255, 255, 0.65); margin-top: 5px; }
        .dock { position: sticky; bottom: 0; padding: 10px 0 6px 0; background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0)); margin-top: 10px; }
      `}</style>
    </div>
  );
}
export default function PastrimiPage() {
  return (
    <Suspense fallback={<RouteLoadingFallback title="DUKE HAPUR PASTRIMI..." />}>
      <PastrimiPageInner />
    </Suspense>
  );
}
