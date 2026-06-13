'use client';

import React, { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import Link from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout } from '@/lib/supabaseClient';
import { fetchOrderDataById, fetchOrderByIdSafe, listMixedOrderRecords, transitionOrderStatus, updateOrderData } from '@/lib/ordersService';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getOutboxSnapshot } from '@/lib/syncManager';
import { queueOp } from '@/lib/offlineSyncClient';
import PosModal from '@/components/PosModal'; // SHTUAR: Për leximin e porosive Offline
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildSmartSmsText } from '@/lib/smartSms';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { clearPageSnapshot, readPageSnapshot, writePageSnapshot } from '@/lib/pageSnapshotCache';
import { fetchRackMapFromDb, formatRackLocationLabel, hasConcreteRackLocation, normalizeRackSlots } from '@/lib/rackLocations';
import { isTransportBridgeReadyForBase } from '@/lib/transport/bridgeMeta';
import { trackRender } from '@/lib/sensor';
import { clearBaseMasterCacheScope, ensureFreshBaseMasterCache, getBaseRowsByStatus, patchBaseMasterRow, patchBaseMasterRows, reconcileBaseMasterCacheScope, readBaseMasterCache, writeBaseMasterCache } from '@/lib/baseMasterCache';
import { claimResume } from '@/lib/resumeGate';
import useRouteAlive from '@/lib/routeAlive';
import { markRealUiReady } from '@/lib/markRealUiReady';
import { isDiagEnabled } from '@/lib/diagMode';
import { listBaseCreateRecovery } from '@/lib/syncRecovery';
import { listUsers } from '@/lib/usersDb';
import { recordOrderCashPayment } from '@/components/payments/payService';
import { createPendingCashPayment } from '@/lib/arkaCashSync';

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


function unwrapPayload(p){return p?.data || p || {};}

function getDbTruthStatus(row = {}) {
  const top = String(row?.status ?? '').trim();
  if (top) return top;
  let data = row?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) return String(data?.status ?? '').trim();
  return '';
}

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
  const readySlotSources = [
    ...(Array.isArray(data?.ready_slots) ? data.ready_slots : []),
    ...(Array.isArray(row?.ready_slots) ? row.ready_slots : []),
    readyLocation,
    readyNote,
  ].filter(Boolean);
  const readySlots = normalizeRackSlots(readySlotSources);
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
    status: normalizeStatus(getDbTruthStatus(row) || data?.status || 'pastrim') || 'pastrim',
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

function isPastrimiDbTruthSnapshot(snapshot) {
  try {
    const meta = snapshot?.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {};
    return String(meta?.pastrimiDbTruthVersion || '') === PASTRIMI_DB_TRUTH_VERSION
      && String(meta?.sourceMode || '').toUpperCase() === 'DB_ONLY';
  } catch {
    return false;
  }
}

function readPastrimRowsFromPageSnapshot() {
  try {
    const snapshot = readPageSnapshot('pastrimi');
    if (!isPastrimiDbTruthSnapshot(snapshot)) return [];
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
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const isDbTruthMeta = String(safeMeta?.sourceMode || safeMeta?.source || '').toUpperCase() === 'DB_ONLY';
    const versionedMeta = isDbTruthMeta
      ? { ...safeMeta, pastrimiDbTruthVersion: PASTRIMI_DB_TRUTH_VERSION, sourceMode: 'DB_ONLY' }
      : safeMeta;
    if (cleanRows.length > 0) writePageSnapshot('pastrimi', cleanRows, versionedMeta);
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
const PASRTRIMI_FETCH_LIMIT = 1000;
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
const PASTRIMI_DB_TRUTH_VERSION = 'pastrimi-db-truth-2026-05-23-v2';
const PASTRIMI_RESOLVED_LOCAL_PROBLEMS_KEY = 'tepiha_resolved_local_problems_v1';
const PASTRIMI_RESOLVED_LOCAL_PROBLEM_TOMBSTONES_KEY = 'tepiha_resolved_local_problem_tombstones_v1';
const PASTRIMI_RESOLVED_LOCAL_PROBLEMS_LIMIT = 250;
const PASTRIMI_PROBLEM_ORDER_SELECT = 'id,local_oid,status,created_at,updated_at,data,code,client_id,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront';
const PASTRIM_DELAY_REVIEW_DAYS = 4;
const PASTRIM_DELAY_REVIEW_MS = PASTRIM_DELAY_REVIEW_DAYS * 24 * 60 * 60 * 1000;
const PASTRIM_DELAY_NEXT_REVIEW_MS = 24 * 60 * 60 * 1000;
const PASTRIM_DELAY_REVIEW_STATUS_LABELS = {
  not_dry: 'Nuk është tharë ende',
  forgot_to_mark_gati: 'E kemi harru me e qit në GATI',
  client_picked_up: 'Klienti e ka marrë / është dorëzuar',
  other: 'Arsye tjetër',
};
const PASTRIMI_PROBLEM_CLIENT_SELECT = 'id,code,full_name,first_name,last_name,phone,photo_url,updated_at';

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
      fetchedRow?.code_str,
      fetchedData?.code_str,
      fetchedData?.order_code,
      fetchedData?.order_tcode,
      fetchedData?.official_order_code,
      itemOrder?.code_str,
      itemOrder?.order_code,
      itemOrder?.order_tcode,
      itemOrder?.official_order_code,
      fetchedData?.client_tcode,
      fetchedRow?.client_tcode,
      fetchedData?.client?.tcode,
      fetchedData?.client?.code,
      fetchedData?.code,
      fetchedRow?.code,
      itemClient?.tcode,
      itemClient?.code,
      itemOrder?.code,
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
  const metrics = computeOrderMetrics(order);
  if (Number(metrics?.m2 || 0) > 0) next.m2 = Number(metrics.m2);
  if (Number(metrics?.pieces || 0) > 0) next.cope = Number(metrics.pieces);
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

function isPlaceholderPastrimName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return text === 'pa emër' || text === 'pa emer' || text === 'pa emer.' || text === 'pa emër.' || text === '—' || text === '-' || text === 'null' || text === 'undefined';
}

function getPastrimSaveAttemptId(row, order = null) {
  const d = order || unwrapOrderData(row?.fullOrder || row?.data || {});
  const lifecycle = d?.pranimi_code_lifecycle && typeof d.pranimi_code_lifecycle === 'object' ? d.pranimi_code_lifecycle : {};
  const nestedData = d?.data && typeof d.data === 'object' ? d.data : {};
  return String(
    row?.save_attempt_id ||
    row?.saveAttemptId ||
    d?.save_attempt_id ||
    d?.saveAttemptId ||
    lifecycle?.save_attempt_id ||
    lifecycle?.saveAttemptId ||
    nestedData?.save_attempt_id ||
    nestedData?.pranimi_code_lifecycle?.save_attempt_id ||
    ''
  ).trim();
}

function getPastrimOutboxOpId(row, order = null) {
  const d = order || unwrapOrderData(row?.fullOrder || row?.data || {});
  const lifecycle = d?.pranimi_code_lifecycle && typeof d.pranimi_code_lifecycle === 'object' ? d.pranimi_code_lifecycle : {};
  const nestedData = d?.data && typeof d.data === 'object' ? d.data : {};
  return String(
    row?.outbox_op_id ||
    row?.op_id ||
    row?.opId ||
    d?.outbox_op_id ||
    d?.op_id ||
    d?.opId ||
    lifecycle?.outbox_op_id ||
    lifecycle?.op_id ||
    nestedData?.outbox_op_id ||
    nestedData?.op_id ||
    nestedData?.pranimi_code_lifecycle?.outbox_op_id ||
    nestedData?.pranimi_code_lifecycle?.op_id ||
    ''
  ).trim();
}

function getPastrimProblemIdentity(row) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  const rawCode = row?.code ?? order?.code ?? order?.client?.code ?? order?.client_code ?? order?.clientCode ?? '';
  const code = normalizeCode(rawCode);
  const codeDigits = String(code || '').replace(/\D+/g, '');
  const hasRealCode = (/^T\d+$/i.test(String(code || '')) || /^\d+$/.test(String(code || ''))) && Number(codeDigits || 0) > 0;

  const name = String(row?.name || row?.client_name || row?.client?.name || order?.client_name || order?.client?.name || '').trim();
  const hasRealName = !isPlaceholderPastrimName(name);

  const localOid = normalizeLocalOidValue(row?.local_oid, row?.oid, order?.local_oid, order?.oid);
  const saveAttemptId = getPastrimSaveAttemptId(row, order);
  const outboxOpId = getPastrimOutboxOpId(row, order);

  const phoneRaw = String(row?.phone || row?.client_phone || row?.client?.phone || order?.client_phone || order?.client?.phone || '').trim();
  const phoneDigits = phoneRaw.replace(/\D+/g, '');
  const hasRealPhone = phoneDigits.length >= 7;

  const m2 = Number(row?.m2 || computeM2(order) || 0);
  const pieces = Number(row?.cope || row?.pieces || computePieces(order) || 0);
  const total = Number(row?.total || order?.total || order?.pay?.euro || 0);
  const hasRealPayload = hasRealPhone || hasRealName || Number(m2) > 0 || Number(pieces) > 0 || Number(total) > 0;

  const source = String(row?.source || '').trim();
  const statusText = String(
    row?.status || order?.status || row?.sync_status || order?.sync_status || row?.local_sync_status || order?.local_sync_status || ''
  ).toLowerCase();
  const errorText = String(row?._syncError || order?._syncError || row?.lastError || order?.lastError || '').trim().toLowerCase();
  const hasProblemStatus = /failed|dead_letter|db_verify_failed|not synced|not_synced|local \/ not synced/i.test(statusText)
    || /failed|dead_letter|db_verify_failed|not synced|not_synced|local \/ not synced/i.test(errorText);
  const hasExplicitSyncFlag = Boolean(
    row?._outboxPending === true ||
    row?._syncPending === true ||
    row?._syncFailed === true ||
    order?._syncPending === true ||
    order?._syncFailed === true ||
    source === 'OUTBOX'
  );
  const hasStrongSyncIdentity = Boolean(saveAttemptId || outboxOpId);
  const hasRecoverableLocalFailure = Boolean(localOid && hasExplicitSyncFlag && hasProblemStatus);

  // Normal workers should not see old local mirrors/search snapshots as problems.
  // A real actionable problem must have V1.2 sync evidence (save_attempt_id/op_id/outbox).
  // local_oid alone is not enough because old mirrors can carry local_oid and stale status text.
  const actionable = Boolean(hasRealPayload && (hasStrongSyncIdentity || source === 'OUTBOX'));
  return {
    actionable,
    hasRealCode,
    hasRealName,
    hasRealPhone,
    hasRealPayload,
    hasStrongSyncIdentity,
    hasRecoverableLocalFailure,
    hasExplicitSyncFlag,
    hasProblemStatus,
    code,
    name,
    localOid,
    saveAttemptId,
    outboxOpId,
    m2,
    pieces,
    total,
    phone: phoneRaw,
  };
}

function isActionablePastrimiLocalProblemRow(row) {
  return getPastrimProblemIdentity(row).actionable === true;
}

function isPastrimiLocalProblemRow(row) {
  if (!row || typeof row !== 'object') return false;
  const source = String(row?.source || '').trim();
  if (source === 'orders' || source === 'transport_orders' || source === 'BASE_CACHE' || source === 'PAGE_SNAPSHOT') return false;
  const info = getPastrimProblemIdentity(row);
  if (!info.actionable) return false;
  return Boolean(info.hasStrongSyncIdentity || source === 'OUTBOX');
}

function countHiddenPastrimGhostRows(rows = [], currentDbTokenSet = new Set(), localProblemTokenSet = new Set()) {
  const hidden = dedupePastrimRows((Array.isArray(rows) ? rows : []).map((row) => normalizeRenderableOrderRow(row))).filter((row) => {
    const tokens = getPastrimCanonicalTokens(row);
    if (tokens.some((token) => currentDbTokenSet.has(token))) return false;
    if (tokens.some((token) => localProblemTokenSet.has(token))) return false;
    if (isPastrimiLocalProblemRow(row)) return false;
    return row?.cope > 0 || row?.m2 > 0 || String(row?.name || '').trim() !== '';
  });
  return hidden.length;
}

function shouldShowPastrimiDebugUi() {
  try { if (isDiagEnabled()) return true; } catch {}
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('pastrimi_debug') === '1' || params.get('debug_pastrimi') === '1') return true;
    const flag = String(window.localStorage?.getItem?.('tepiha_pastrim_debug_ui_v1') || '').trim().toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'yes';
  } catch {
    return false;
  }
}



function isPastrimiUuidLike(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
}

function uniquePastrimiValues(values = [], limit = 120) {
  const out = [];
  const seen = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out.slice(0, limit);
}

function getPastrimProblemDbLookupIdentity(row) {
  const info = getPastrimProblemIdentity(row);
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const id = String(row?.id || row?.db_id || row?.order_id || order?.id || '').trim();
  const localOid = normalizeLocalOidValue(
    row?.local_oid,
    row?.oid,
    order?.local_oid,
    order?.oid,
    info.localOid
  );
  const transportCode = getPastrimTransportCode(row);
  const codeText = String(info.code || row?.code || order?.code || order?.client?.code || '').trim();
  const numericCode = codeText && /^\d+$/.test(codeText) ? codeText.replace(/^0+/, '') || '0' : '';
  const isTransport = Boolean(transportCode || isPastrimTransportScopedRow(row));
  const uuidCandidates = [id, localOid].filter((value) => isPastrimiUuidLike(value));
  const numericId = /^\d+$/.test(id) ? id : '';
  return {
    id,
    localOid,
    isTransport,
    transportCode,
    numericCode,
    numericId,
    uuidCandidates,
  };
}

function getPastrimDbStatusLookupTokens(row) {
  const tokens = new Set(getPastrimCanonicalTokens(row));
  const identity = getPastrimProblemDbLookupIdentity(row);
  if (identity.transportCode) tokens.add(`transport:code:${identity.transportCode}`);
  if (!identity.isTransport && identity.numericCode) tokens.add(`orders:code:${identity.numericCode}`);
  if (identity.numericId) tokens.add(`orders:id:${identity.numericId}`);
  (identity.uuidCandidates || []).forEach((uuid) => {
    if (!uuid) return;
    tokens.add(`id:${uuid}`);
    tokens.add(`local:${uuid}`);
    tokens.add(`transport_orders:id:${uuid}`);
    tokens.add(`transport_orders:local:${uuid}`);
  });
  if (identity.localOid) {
    tokens.add(`local:${identity.localOid}`);
    tokens.add(`orders:local:${identity.localOid}`);
    tokens.add(`transport_orders:local:${identity.localOid}`);
  }
  return Array.from(tokens).filter(Boolean);
}

async function fetchPastrimiRowsByColumn(table, select, column, values = []) {
  const clean = uniquePastrimiValues(values, 120);
  if (!clean.length) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += 40) {
    const chunk = clean.slice(i, i + 40);
    try {
      const { data, error } = await supabase.from(table).select(select).in(column, chunk);
      if (error) {
        try { console.warn('[PASTRIMI] DB status lookup skipped', { table, column, error: error.message || error }); } catch {}
        continue;
      }
      if (Array.isArray(data)) out.push(...data);
    } catch (err) {
      try { console.warn('[PASTRIMI] DB status lookup failed', { table, column, error: err?.message || err }); } catch {}
    }
  }
  return out;
}

async function buildDbResolvedLocalProblemTokenSet(rows = []) {
  const candidates = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!candidates.length) return new Set();

  const identities = candidates.map(getPastrimProblemDbLookupIdentity);
  const orderLocalOids = uniquePastrimiValues(identities.map((x) => x.localOid).filter(Boolean));
  const orderIds = uniquePastrimiValues(identities.map((x) => x.numericId).filter(Boolean));
  const orderCodes = uniquePastrimiValues(identities.filter((x) => !x.isTransport).map((x) => x.numericCode).filter(Boolean));

  const transportIds = uniquePastrimiValues(identities.flatMap((x) => x.uuidCandidates || []));
  const transportCodes = uniquePastrimiValues(identities.map((x) => x.transportCode).filter(Boolean));

  const [orderByLocalOid, orderById, orderByCode, transportById, transportByClientTcode, transportByCodeStr] = await Promise.all([
    fetchPastrimiRowsByColumn('orders', 'id,local_oid,status,created_at,updated_at,data,code,client_name,client_phone', 'local_oid', orderLocalOids),
    fetchPastrimiRowsByColumn('orders', 'id,local_oid,status,created_at,updated_at,data,code,client_name,client_phone', 'id', orderIds),
    fetchPastrimiRowsByColumn('orders', 'id,local_oid,status,created_at,updated_at,data,code,client_name,client_phone', 'code', orderCodes),
    fetchPastrimiRowsByColumn('transport_orders', 'id,status,created_at,updated_at,data,client_tcode,code_str,code_n,client_name,client_phone', 'id', transportIds),
    fetchPastrimiRowsByColumn('transport_orders', 'id,status,created_at,updated_at,data,client_tcode,code_str,code_n,client_name,client_phone', 'client_tcode', transportCodes),
    fetchPastrimiRowsByColumn('transport_orders', 'id,status,created_at,updated_at,data,client_tcode,code_str,code_n,client_name,client_phone', 'code_str', transportCodes),
  ]);

  const tokenSet = new Set();
  const addTokens = (row) => {
    const normalized = normalizeRenderableOrderRow(row);
    getPastrimCanonicalTokens(normalized).forEach((token) => tokenSet.add(token));
    getPastrimDbStatusLookupTokens(normalized).forEach((token) => tokenSet.add(token));
  };

  [...orderByLocalOid, ...orderById, ...orderByCode].forEach((row) => {
    const order = unwrapOrderData(row?.data || {});
    addTokens({
      id: row?.id,
      local_oid: normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid),
      status: row?.status || order?.status || '',
      source: 'orders',
      table: 'orders',
      _table: 'orders',
      code: row?.code || order?.code || order?.client?.code || '',
      name: row?.client_name || order?.client?.name || order?.client_name || '',
      phone: row?.client_phone || order?.client?.phone || order?.client_phone || '',
      fullOrder: order,
    });
  });

  [...transportById, ...transportByClientTcode, ...transportByCodeStr].forEach((row) => {
    const order = unwrapOrderData(row?.data || {});
    addTokens({
      id: row?.id,
      local_oid: normalizeLocalOidValue(row?.local_oid, order?.local_oid, order?.oid, row?.id),
      status: row?.status || order?.status || '',
      source: 'transport_orders',
      table: 'transport_orders',
      _table: 'transport_orders',
      code: row?.client_tcode || row?.code_str || order?.client?.code || '',
      client_tcode: row?.client_tcode || order?.client_tcode || '',
      code_str: row?.code_str || order?.code_str || '',
      name: row?.client_name || order?.client?.name || order?.client_name || '',
      phone: row?.client_phone || order?.client?.phone || order?.client_phone || '',
      fullOrder: mergeTransportIdentityIntoOrder(row, order),
    });
  });

  return tokenSet;
}


function normalizePastrimiResolvedTokenValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function uniquePastrimiResolvedTokens(tokens = []) {
  const out = [];
  const seen = new Set();
  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    const text = String(token || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out;
}

function getPastrimiResolvedProblemTokens(rowOrMarker = {}) {
  const isMarker = Boolean(
    rowOrMarker?.resolved_at
    || rowOrMarker?.local_oid
    || rowOrMarker?.save_attempt_id
    || rowOrMarker?.outbox_op_id
    || rowOrMarker?.client_name
  );
  const info = isMarker ? null : getPastrimProblemIdentity(rowOrMarker);
  const order = isMarker ? {} : unwrapOrderData(rowOrMarker?.fullOrder || rowOrMarker?.data || {});
  const localOid = normalizePastrimiResolvedTokenValue(
    rowOrMarker?.local_oid
    || rowOrMarker?.localOid
    || info?.localOid
    || order?.local_oid
    || order?.oid
  );
  const saveAttemptId = normalizePastrimiResolvedTokenValue(
    rowOrMarker?.save_attempt_id
    || rowOrMarker?.saveAttemptId
    || info?.saveAttemptId
    || order?.save_attempt_id
  );
  const outboxOpId = normalizePastrimiResolvedTokenValue(
    rowOrMarker?.outbox_op_id
    || rowOrMarker?.outboxOpId
    || rowOrMarker?.op_id
    || info?.outboxOpId
    || order?.outbox_op_id
    || order?.op_id
  );
  const code = normalizePastrimiResolvedTokenValue(rowOrMarker?.code || info?.code || order?.code || order?.client?.code);
  const clientName = normalizePastrimiResolvedTokenValue(rowOrMarker?.client_name || rowOrMarker?.name || info?.name || order?.client_name || order?.client?.name);
  const phoneDigits = String(rowOrMarker?.phone || rowOrMarker?.client_phone || info?.phone || order?.client_phone || order?.client?.phone || '').replace(/\D+/g, '');
  const tokens = [];
  if (localOid) tokens.push(`local_oid:${localOid}`);
  if (saveAttemptId) tokens.push(`save_attempt_id:${saveAttemptId}`);
  if (outboxOpId) tokens.push(`outbox_op_id:${outboxOpId}`);
  if (code && clientName) tokens.push(`code_name:${code}::${clientName}`);
  if (code && phoneDigits.length >= 7) tokens.push(`code_phone:${code}::${phoneDigits}`);
  if (Array.isArray(rowOrMarker?.tokens)) tokens.push(...rowOrMarker.tokens.map((token) => String(token || '').trim()).filter(Boolean));
  return uniquePastrimiResolvedTokens(tokens);
}

function readPastrimiResolvedLocalProblems() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage?.getItem?.(PASTRIMI_RESOLVED_LOCAL_PROBLEMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    return items.filter((item) => item && typeof item === 'object');
  } catch {
    return [];
  }
}

function writePastrimiResolvedLocalProblems(items = []) {
  if (typeof window === 'undefined') return;
  try {
    const clean = (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item === 'object')
      .slice(0, PASTRIMI_RESOLVED_LOCAL_PROBLEMS_LIMIT);
    window.localStorage?.setItem?.(PASTRIMI_RESOLVED_LOCAL_PROBLEMS_KEY, JSON.stringify(clean));
  } catch {}
}

function readPastrimiResolvedLocalProblemTombstones() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage?.getItem?.(PASTRIMI_RESOLVED_LOCAL_PROBLEM_TOMBSTONES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writePastrimiResolvedLocalProblemTombstones(map = {}) {
  if (typeof window === 'undefined') return;
  try {
    const clean = {};
    Object.entries(map || {}).forEach(([token, value]) => {
      const key = String(token || '').trim();
      if (!key || !value) return;
      clean[key] = true;
    });
    window.localStorage?.setItem?.(PASTRIMI_RESOLVED_LOCAL_PROBLEM_TOMBSTONES_KEY, JSON.stringify(clean));
  } catch {}
}

function persistPastrimiResolvedLocalProblemTombstones(tokens = []) {
  const safeTokens = uniquePastrimiResolvedTokens(tokens);
  if (!safeTokens.length) return readPastrimiResolvedLocalProblemTombstones();
  const existing = readPastrimiResolvedLocalProblemTombstones();
  const next = { ...(existing || {}) };
  safeTokens.forEach((token) => { next[token] = true; });
  writePastrimiResolvedLocalProblemTombstones(next);
  return next;
}

function getPastrimiResolvedLocalProblemTokenSet() {
  const tokenSet = new Set();
  readPastrimiResolvedLocalProblems().forEach((marker) => {
    getPastrimiResolvedProblemTokens(marker).forEach((token) => tokenSet.add(token));
    getPastrimiResolvedProblemTokensDeep(marker).forEach((token) => tokenSet.add(token));
    if (Array.isArray(marker?.tokens)) marker.tokens.forEach((token) => tokenSet.add(String(token || '').trim()));
  });
  Object.entries(readPastrimiResolvedLocalProblemTombstones()).forEach(([token, value]) => {
    if (value && token) tokenSet.add(String(token).trim());
  });
  return tokenSet;
}

function getPastrimiProblemHardResolvedTokens(row = {}) {
  return uniquePastrimiResolvedTokens([
    ...getPastrimiResolvedProblemTokens(row),
    ...getPastrimiResolvedProblemTokensDeep(row),
  ]);
}

function isPastrimiProblemHardResolved(row) {
  const tokens = getPastrimiProblemHardResolvedTokens(row);
  if (!tokens.length) return false;
  const resolvedTokens = getPastrimiResolvedLocalProblemTokenSet();
  return tokens.some((token) => resolvedTokens.has(token));
}

function isPastrimiLocalProblemResolved(row) {
  return isPastrimiProblemHardResolved(row);
}

function filterResolvedPastrimiLocalProblems(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isPastrimiProblemHardResolved(row));
}

function readPastrimiResolveActor(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  const direct = row?.actor || row?.created_by || order?.actor || order?.created_by || {};
  const directPin = String(row?.resolved_by_pin || row?.created_by_pin || direct?.pin || direct?.user_pin || order?.created_by_pin || '').trim();
  const directName = String(row?.resolved_by_name || row?.created_by_name || direct?.name || direct?.full_name || order?.created_by_name || '').trim();
  if (directPin || directName) return { pin: directPin || null, name: directName || null };
  if (typeof window === 'undefined') return { pin: null, name: null };
  const keys = ['tepiha_current_user_v1', 'tepiha_user_v1', 'tepiha_auth_user_v1', 'tepiha_active_worker_v1', 'tepiha_staff_user_v1'];
  for (const key of keys) {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem?.(key) || 'null');
      const pin = String(parsed?.pin || parsed?.user_pin || parsed?.worker_pin || parsed?.data?.pin || '').trim();
      const name = String(parsed?.name || parsed?.full_name || parsed?.worker_name || parsed?.data?.name || '').trim();
      if (pin || name) return { pin: pin || null, name: name || null };
    } catch {}
  }
  return { pin: null, name: null };
}

function buildPastrimiResolvedProblemMarker(row, note = '', extra = {}) {
  const info = getPastrimProblemIdentity(row);
  const actor = readPastrimiResolveActor(row);
  const originalReason = String(row?._syncError || row?.lastError || row?.status || 'LOCAL / NOT SYNCED').trim();
  const scanResult = extra?.scanResult || null;
  const marker = {
    local_oid: info.localOid || null,
    save_attempt_id: info.saveAttemptId || null,
    outbox_op_id: info.outboxOpId || null,
    code: info.code || null,
    client_name: info.name || null,
    client_phone: info.phone || null,
    pieces: Number(info.pieces || 0) || null,
    m2_total: Number(info.m2 || 0) || null,
    price_total: Number(info.total || 0) || null,
    error: originalReason || 'LOCAL / NOT SYNCED',
    reason: String(extra?.reason || originalReason || 'LOCAL / NOT SYNCED').trim(),
    resolved_at: new Date().toISOString(),
    resolved_by_pin: actor.pin || null,
    resolved_by_name: actor.name || null,
    note: String(note || '').trim(),
    resolver_state: scanResult?.resolver_state || null,
  };
  marker.tokens = getPastrimiResolvedProblemTokens(marker);
  marker.diagnostic = buildPastrimiProblemDiagnostic(row, scanResult);
  return marker;
}

function persistPastrimiResolvedLocalProblem(row, note = '', extra = {}) {
  const marker = buildPastrimiResolvedProblemMarker(row, note, extra);
  const hardTokens = uniquePastrimiResolvedTokens([
    ...(marker.tokens || []),
    ...getPastrimiResolvedProblemTokens(row),
    ...getPastrimiResolvedProblemTokens(marker),
    ...getPastrimiResolvedProblemTokensDeep(row),
    ...getPastrimiResolvedProblemTokensDeep(marker),
  ]);
  marker.tokens = hardTokens;
  persistPastrimiResolvedLocalProblemTombstones(hardTokens);
  const markerTokens = new Set(hardTokens);
  const existing = readPastrimiResolvedLocalProblems().filter((item) => {
    const tokens = uniquePastrimiResolvedTokens([
      ...getPastrimiResolvedProblemTokens(item),
      ...getPastrimiResolvedProblemTokensDeep(item),
      ...(Array.isArray(item?.tokens) ? item.tokens : []),
    ]);
    return !tokens.some((token) => markerTokens.has(token));
  });
  writePastrimiResolvedLocalProblems([marker, ...existing]);
  return marker;
}


function getPastrimiResolvedProblemTokensDeep(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const tokens = [];
  const pushTokens = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    try { tokens.push(...getPastrimiResolvedProblemTokens(obj)); } catch {}
  };

  pushTokens(value);
  const directOutbox = normalizePastrimiResolvedTokenValue(value?.outbox_op_id || value?.op_id || value?.opId || '');
  if (directOutbox) tokens.push(`outbox_op_id:${directOutbox}`);

  const directSaveAttempt = normalizePastrimiResolvedTokenValue(value?.save_attempt_id || value?.saveAttemptId || '');
  if (directSaveAttempt) tokens.push(`save_attempt_id:${directSaveAttempt}`);

  const directLocalOid = normalizePastrimiResolvedTokenValue(value?.local_oid || value?.localOid || value?.oid || '');
  if (directLocalOid) tokens.push(`local_oid:${directLocalOid}`);

  const nestedCandidates = [
    value?.payload,
    value?.payload?.data,
    value?.payload?.data?.data,
    value?.data,
    value?.data?.data,
    value?.fullOrder,
    value?.order,
    value?.item,
    value?.record,
  ];

  nestedCandidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    pushTokens(candidate);
    tokens.push(...getPastrimiResolvedProblemTokensDeep(candidate, depth + 1, seen));
  });

  try {
    const rawPayload = value?.payload && typeof value.payload === 'object' ? value.payload : null;
    if (rawPayload) {
      const unwrapped = unwrapPayload(rawPayload);
      if (unwrapped && unwrapped !== rawPayload && typeof unwrapped === 'object') {
        pushTokens(unwrapped);
        tokens.push(...getPastrimiResolvedProblemTokensDeep(unwrapped, depth + 1, seen));
      }
    }
  } catch {}

  return uniquePastrimiResolvedTokens(tokens);
}

function getPastrimiResolvedProblemTokenSetDeep(value) {
  return new Set(getPastrimiResolvedProblemTokensDeep(value));
}

function pastrimiProblemValueMatchesResolvedTokens(value, markerTokenSet) {
  if (!value || !markerTokenSet || markerTokenSet.size === 0) return false;
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    for (const token of markerTokenSet) {
      const parts = String(token || '').split(':');
      const raw = parts.length > 1 ? parts.slice(1).join(':') : String(token || '');
      if (raw && raw.length >= 8 && text.includes(raw.toLowerCase())) return true;
    }
    return false;
  }
  if (typeof value !== 'object') return false;
  const tokens = getPastrimiResolvedProblemTokenSetDeep(value);
  for (const token of tokens) {
    if (markerTokenSet.has(token)) return true;
  }
  return false;
}

function filterPastrimiResolvedItemsFromContainer(container, markerTokenSet) {
  if (!container || !markerTokenSet || markerTokenSet.size === 0) return { value: container, changed: false, removed: 0 };

  if (Array.isArray(container)) {
    let removed = 0;
    const next = [];
    container.forEach((item) => {
      if (pastrimiProblemValueMatchesResolvedTokens(item, markerTokenSet)) {
        removed += 1;
        return;
      }
      const filtered = filterPastrimiResolvedItemsFromKnownLists(item, markerTokenSet);
      if (filtered.changed) {
        removed += filtered.removed;
        next.push(filtered.value);
      } else {
        next.push(item);
      }
    });
    return { value: next, changed: removed > 0 || next.length !== container.length, removed };
  }

  return filterPastrimiResolvedItemsFromKnownLists(container, markerTokenSet);
}

function filterPastrimiResolvedItemsFromKnownLists(value, markerTokenSet) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, changed: false, removed: 0 };
  let changed = false;
  let removed = 0;
  const next = { ...value };
  ['items', 'queue', 'list', 'rows', 'orders', 'deadLetters', 'dead_letters', 'ops', 'operations', 'entries', 'traces'].forEach((field) => {
    if (!Array.isArray(next[field])) return;
    const filtered = filterPastrimiResolvedItemsFromContainer(next[field], markerTokenSet);
    if (filtered.changed) {
      next[field] = filtered.value;
      changed = true;
      removed += filtered.removed;
    }
  });
  return { value: next, changed, removed };
}

function shouldInspectPastrimiProblemLocalStorageKey(key = '') {
  const text = String(key || '').trim();
  if (!text) return false;
  if (text === PASTRIMI_RESOLVED_LOCAL_PROBLEMS_KEY) return false;
  if (text === PASTRIMI_RESOLVED_LOCAL_PROBLEM_TOMBSTONES_KEY) return false;
  if (/base[_-]?master[_-]?cache/i.test(text)) return false;
  const hasProblemSourceWord = /outbox|queue|dead|failed|problem|sync|order|draft|trace|pranimi|not.?synced|local/i.test(text);
  if (/pastrimi/i.test(text) && /page[_-]?snapshot|db[_-]?truth|db.?cache|cache|persist|main.?list|normal.?list/i.test(text) && !hasProblemSourceWord) return false;
  if (/page[_-]?snapshot/i.test(text) && !hasProblemSourceWord) return false;
  if (/pastrimi[_-]?db[_-]?truth/i.test(text)) return false;

  const exactKeys = new Set([
    'tepiha_offline_queue_v1',
    'tepiha_dead_letter_queue_v1',
    'tepiha_sync_dead_letters_v1',
    'tepiha_order_save_trace_v1',
    'tepiha_local_orders_v1',
    'draft_orders_v1',
  ]);
  if (exactKeys.has(text)) return true;
  if (text.startsWith('order_')) return true;
  if (hasProblemSourceWord) return true;
  return false;
}

function purgeResolvedPastrimiProblemFromLocalSources(row, marker) {
  if (typeof window === 'undefined') return { removed: 0, touched: [] };
  const storage = window.localStorage;
  if (!storage) return { removed: 0, touched: [] };

  const markerTokens = new Set(uniquePastrimiResolvedTokens([
    ...(marker?.tokens || []),
    ...getPastrimiResolvedProblemTokens(row),
    ...getPastrimiResolvedProblemTokens(marker),
    ...getPastrimiResolvedProblemTokensDeep(row),
    ...getPastrimiResolvedProblemTokensDeep(marker),
  ].filter(Boolean)));
  if (!markerTokens.size) return { removed: 0, touched: [] };

  const localOidValues = Array.from(markerTokens)
    .filter((token) => String(token || '').startsWith('local_oid:'))
    .map((token) => String(token).slice('local_oid:'.length))
    .filter(Boolean);
  const touched = [];
  let removed = 0;

  const keys = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (shouldInspectPastrimiProblemLocalStorageKey(key)) keys.push(key);
    }
  } catch {}

  keys.forEach((key) => {
    if (!key) return;
    try {
      if ((key.startsWith('order_') || localOidValues.some((localOid) => key.toLowerCase().includes(localOid.toLowerCase()))) && localOidValues.some((localOid) => key.toLowerCase().includes(localOid.toLowerCase()))) {
        storage.removeItem(key);
        touched.push(key);
        removed += 1;
        return;
      }

      const raw = storage.getItem(key);
      if (!raw) return;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }

      if (parsed === null) {
        if (key.startsWith('order_') && pastrimiProblemValueMatchesResolvedTokens(raw, markerTokens)) {
          storage.removeItem(key);
          touched.push(key);
          removed += 1;
        }
        return;
      }

      if (key.startsWith('order_') && pastrimiProblemValueMatchesResolvedTokens(parsed, markerTokens)) {
        storage.removeItem(key);
        touched.push(key);
        removed += 1;
        return;
      }

      const filtered = filterPastrimiResolvedItemsFromContainer(parsed, markerTokens);
      if (!filtered.changed) return;
      storage.setItem(key, JSON.stringify(filtered.value));
      touched.push(key);
      removed += filtered.removed || 0;
    } catch {}
  });

  return { removed, touched };
}

function stringifyPastrimiScanDbRow(row = {}) {
  if (!row || typeof row !== 'object') return '—';
  const order = unwrapOrderData(row?.data || {});
  const m2 = Number(row?.m2_total || order?.m2_total || order?.pay?.m2 || computeM2(order) || 0);
  const total = Number(row?.price_total || order?.price_total || order?.pay?.euro || 0);
  const pieces = Number(row?.pieces || order?.pieces || computePieces(order) || 0);
  return [
    `ID: ${row?.id || '—'}`,
    `Kodi: ${normalizeCode(row?.code || order?.code || order?.client?.code || '') || '—'}`,
    `Klienti: ${row?.client_name || order?.client_name || order?.client?.name || '—'}`,
    `Telefoni: ${row?.client_phone || order?.client_phone || order?.client?.phone || '—'}`,
    `Statusi: ${row?.status || order?.status || '—'}`,
    `Copë: ${pieces || '—'}`,
    `M2: ${m2 || '—'}`,
    `Shuma: ${total || '—'}`,
  ].join(' • ');
}

function stringifyPastrimiScanClient(row = {}) {
  if (!row || typeof row !== 'object') return '—';
  const name = String(row?.full_name || row?.name || [row?.first_name, row?.last_name].filter(Boolean).join(' ') || '').trim();
  return [
    `ID: ${row?.id || '—'}`,
    `Kodi: ${normalizeCode(row?.code || '') || '—'}`,
    `Klienti: ${name || '—'}`,
    `Telefoni: ${row?.phone || '—'}`,
  ].join(' • ');
}

function buildPastrimiProblemDiagnostic(row, scanResult = null) {
  const info = getPastrimProblemIdentity(row);
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  const createdAt = row?.created_at || row?.createdAt || order?.created_at || order?.createdAt || '';
  const lastRetryAt = row?.lastRetryAt || row?.last_retry_at || order?.lastRetryAt || order?.last_retry_at || '';
  const error = row?._syncError || order?._syncError || row?.lastError || order?.lastError || row?.status || 'LOCAL / NOT SYNCED';
  const scan = scanResult && typeof scanResult === 'object' ? scanResult : null;
  const dbOrder = scan?.existingOrder || scan?.codeOrder || null;
  const dbClient = scan?.codeClient || scan?.phoneClient || null;
  return [
    'RAPORT PËR ADMIN — PROBLEM LOCAL / NOT SYNCED',
    `Rekomandim: ${scan?.recommendation || scan?.resolver_state || 'NEEDS_ADMIN'}`,
    `DB Scan Result: ${scan?.message || scan?.resolver_state || 'NUK ËSHTË KONTROLLUAR ENDE'}`,
    '',
    'PROBLEM:',
    `Kodi problem: ${info.code || '—'}`,
    `Klienti problem: ${info.name || 'Pa Emër'}`,
    `Telefoni problem: ${info.phone || '—'}`,
    `Copë: ${Number(info.pieces || 0) || '—'}`,
    `M2: ${Number(info.m2 || 0) || '—'}`,
    `Shuma: ${Number(info.total || 0) || '—'}`,
    `Status/Error origjinal: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
    `local_oid: ${info.localOid || '—'}`,
    `save_attempt_id: ${info.saveAttemptId || '—'}`,
    `outbox_op_id: ${info.outboxOpId || '—'}`,
    `Created At: ${createdAt || '—'}`,
    `Last Retry At: ${lastRetryAt || '—'}`,
    '',
    'DB:',
    `Order nga safety IDs: ${scan?.existingOrder ? stringifyPastrimiScanDbRow(scan.existingOrder) : '—'}`,
    `Order me të njëjtin kod: ${scan?.codeOrder ? stringifyPastrimiScanDbRow(scan.codeOrder) : '—'}`,
    `Client me të njëjtin kod: ${scan?.codeClient ? stringifyPastrimiScanClient(scan.codeClient) : '—'}`,
    `Client me të njëjtin telefon: ${scan?.phoneClient ? stringifyPastrimiScanClient(scan.phoneClient) : '—'}`,
    `base_code_pool: ${scan?.baseCodePool ? JSON.stringify(scan.baseCodePool) : '—'}`,
    '',
    `Audit generated_at: ${new Date().toISOString()}`,
  ].join('\n');
}

function normalizePastrimiResolverPhoneDigits(value = '') {
  let digits = String(value || '').replace(/\D+/g, '');
  if (digits.startsWith('383')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function normalizePastrimiResolverPhone(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isPastrimiNoPhonePlaceholder(raw)) return '';
  const digits = normalizePastrimiResolverPhoneDigits(raw);
  if (!digits || digits.length < 7) return '';
  if (digits.length >= 7 && digits.length <= 9) return `+383${digits}`;
  if (raw.startsWith('+')) return raw;
  return `+${String(value || '').replace(/\D+/g, '')}`;
}

function isPastrimiNoPhonePlaceholder(value = '') {
  return /^\s*PA\s+NUM[EË]R\s+\d+\s*$/i.test(String(value || '').trim());
}

function buildPastrimiNoPhonePlaceholder(code) {
  const n = String(normalizeCode(code) || code || '').replace(/\D+/g, '');
  return `PA NUMER ${n || String(code || '').trim()}`.trim();
}

function buildPastrimiProblemKey(row = {}) {
  const info = getPastrimProblemIdentity(row);
  return [
    info.localOid ? `local:${info.localOid}` : '',
    info.saveAttemptId ? `save:${info.saveAttemptId}` : '',
    info.outboxOpId ? `op:${info.outboxOpId}` : '',
    info.code ? `code:${info.code}` : '',
    info.name ? `name:${info.name}` : '',
  ].filter(Boolean).join('|') || `row:${String(row?.id || Math.random()).trim()}`;
}

function getPastrimiProblemCompleteness(row = {}) {
  const info = getPastrimProblemIdentity(row);
  const missing = [];
  if (!info.hasRealCode || !String(info.code || '').replace(/\D+/g, '')) missing.push('code');
  if (!info.hasRealName) missing.push('client_name');
  if (!(Number(info.m2 || 0) > 0)) missing.push('m2_total');
  if (!(Number(info.pieces || 0) > 0)) missing.push('pieces');
  if (!(Number(info.total || 0) > 0)) missing.push('price_total');
  if (!info.localOid) missing.push('local_oid');
  return { ok: missing.length === 0, missing, info };
}

function isKnownStalePastrimiProblem(row = {}) {
  const info = getPastrimProblemIdentity(row);
  const name = String(info?.name || '').toLowerCase();
  const code = String(info?.code || '').replace(/\D+/g, '');
  return code === '778' && name.includes('selim') && name.includes('gashi');
}

async function pastrimiMaybeSingle(query) {
  try {
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) return { row: null, error };
    return { row: data || null, error: null };
  } catch (error) {
    return { row: null, error };
  }
}

async function fetchPastrimiProblemOrderByFilter(apply) {
  if (typeof apply !== 'function') return null;
  const res = await pastrimiMaybeSingle(apply(supabase.from('orders').select(PASTRIMI_PROBLEM_ORDER_SELECT)));
  return res.row || null;
}

async function fetchPastrimiProblemClientByCode(code) {
  const codeNum = Number(String(normalizeCode(code) || code || '').replace(/\D+/g, ''));
  if (!Number.isFinite(codeNum) || codeNum <= 0) return null;
  const res = await pastrimiMaybeSingle(supabase.from('clients').select(PASTRIMI_PROBLEM_CLIENT_SELECT).eq('code', codeNum).order('updated_at', { ascending: false }));
  return res.row || null;
}

async function fetchPastrimiProblemClientByPhone(phone) {
  const phoneFull = normalizePastrimiResolverPhone(phone);
  if (!phoneFull) return null;
  const res = await pastrimiMaybeSingle(supabase.from('clients').select(PASTRIMI_PROBLEM_CLIENT_SELECT).eq('phone', phoneFull).order('updated_at', { ascending: false }));
  return res.row || null;
}

async function fetchPastrimiBaseCodePoolInfo(code) {
  const codeNum = Number(String(normalizeCode(code) || code || '').replace(/\D+/g, ''));
  if (!Number.isFinite(codeNum) || codeNum <= 0) return null;
  try {
    const { data, error } = await supabase.from('base_code_pool').select('*').eq('code', codeNum).limit(1).maybeSingle();
    if (error) return { code: codeNum, lookup_error: String(error?.message || error || '') };
    return data || null;
  } catch (error) {
    return { code: codeNum, lookup_error: String(error?.message || error || '') };
  }
}

function getPastrimiBaseCodePoolStatus(pool = {}) {
  return String(pool?.status ?? pool?.state ?? '').trim().toLowerCase();
}

function pastrimiBaseCodePoolBlocksInsert(pool = null) {
  if (!pool || typeof pool !== 'object' || pool.lookup_error) return false;
  if (Object.prototype.hasOwnProperty.call(pool, 'status') || Object.prototype.hasOwnProperty.call(pool, 'state')) {
    return getPastrimiBaseCodePoolStatus(pool) !== 'used';
  }
  if (Object.prototype.hasOwnProperty.call(pool, 'used')) return pool.used !== true;
  if (Object.prototype.hasOwnProperty.call(pool, 'is_used')) return pool.is_used !== true;
  return false;
}

function isPastrimiProblemNoPhone(row = {}) {
  const info = getPastrimProblemIdentity(row);
  const order = unwrapOrderData(row?.fullOrder || row?.data || {});
  const rawPhone = String(info?.phone || order?.client_phone || order?.client?.phone || '').trim();
  return Boolean(order?.no_phone === true || isPastrimiNoPhonePlaceholder(rawPhone) || !normalizePastrimiResolverPhone(rawPhone));
}

function pastrimiClientHasRealPhone(client = {}) {
  const rawPhone = String(client?.phone || '').trim();
  if (!rawPhone || isPastrimiNoPhonePlaceholder(rawPhone)) return false;
  return Boolean(normalizePastrimiResolverPhone(rawPhone));
}

function pastrimiSameProblemClient(client = {}, row = {}) {
  if (!client || typeof client !== 'object') return false;
  const info = getPastrimProblemIdentity(row);
  const clientName = String(client?.full_name || client?.name || [client?.first_name, client?.last_name].filter(Boolean).join(' ') || '').trim().toLowerCase();
  const problemName = String(info.name || '').trim().toLowerCase();
  const clientDigits = normalizePastrimiResolverPhoneDigits(client?.phone || '');
  const problemDigits = normalizePastrimiResolverPhoneDigits(info.phone || '');
  if (clientDigits && problemDigits && clientDigits === problemDigits) return true;
  if (clientName && problemName && clientName === problemName) return true;
  return false;
}

async function scanPastrimiProblemInDb(row = {}) {
  const completeness = getPastrimiProblemCompleteness(row);
  const info = completeness.info;
  const codeNum = Number(String(info.code || '').replace(/\D+/g, ''));
  const localOid = String(info.localOid || '').trim();
  const saveAttemptId = String(info.saveAttemptId || '').trim();
  const outboxOpId = String(info.outboxOpId || '').trim();
  const scan = {
    checked_at: new Date().toISOString(),
    resolver_state: 'NEEDS_ADMIN',
    recommendation: 'NEEDS_ADMIN',
    message: '',
    missing: completeness.missing,
    existingOrder: null,
    codeOrder: null,
    codeClient: null,
    phoneClient: null,
    baseCodePool: null,
  };

  if (isKnownStalePastrimiProblem(row)) {
    scan.resolver_state = 'KNOWN_STALE_LOCAL_PROBLEM';
    scan.recommendation = 'NEEDS_ADMIN';
    scan.message = 'Ky rast është stale local failed order. Mos e fut në DB; përdor ZGJIDH / FSHEH PROBLEMIN.';
    scan.baseCodePool = await fetchPastrimiBaseCodePoolInfo(codeNum).catch(() => null);
    return scan;
  }

  const safetyLookups = [];
  if (localOid) {
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.eq('local_oid', localOid)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->>local_oid', 'eq', localOid)));
  }
  if (saveAttemptId) {
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->>save_attempt_id', 'eq', saveAttemptId)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->pranimi_code_lifecycle->>save_attempt_id', 'eq', saveAttemptId)));
  }
  if (outboxOpId) {
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->>outbox_op_id', 'eq', outboxOpId)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->>op_id', 'eq', outboxOpId)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->sync_safety->>outbox_op_id', 'eq', outboxOpId)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->pranimi_code_lifecycle->>outbox_op_id', 'eq', outboxOpId)));
    safetyLookups.push(() => fetchPastrimiProblemOrderByFilter((q) => q.filter('data->pranimi_code_lifecycle->>op_id', 'eq', outboxOpId)));
  }

  for (const lookup of safetyLookups) {
    const found = await lookup().catch(() => null);
    if (found) {
      scan.existingOrder = found;
      scan.resolver_state = 'ALREADY_IN_DB';
      scan.recommendation = 'ALREADY_IN_DB';
      scan.message = 'Ky problem tashmë ekziston në DB.';
      scan.baseCodePool = await fetchPastrimiBaseCodePoolInfo(codeNum).catch(() => null);
      return scan;
    }
  }

  if (codeNum > 0) {
    scan.codeOrder = await fetchPastrimiProblemOrderByFilter((q) => q.eq('code', codeNum)).catch(() => null);
    scan.codeClient = await fetchPastrimiProblemClientByCode(codeNum).catch(() => null);
    scan.baseCodePool = await fetchPastrimiBaseCodePoolInfo(codeNum).catch(() => null);
  }
  scan.phoneClient = await fetchPastrimiProblemClientByPhone(info.phone).catch(() => null);

  if (pastrimiBaseCodePoolBlocksInsert(scan.baseCodePool)) {
    scan.resolver_state = 'BASE_CODE_POOL_NOT_USED';
    scan.recommendation = 'NEEDS_ADMIN';
    scan.message = 'Kodi nuk është i shënuar si used në base_code_pool. Kërkon admin/manual fix.';
    return scan;
  }

  if (isPastrimiProblemNoPhone(row) && scan.codeClient && pastrimiClientHasRealPhone(scan.codeClient)) {
    scan.resolver_state = 'NO_PHONE_CODE_OWNER_REAL_PHONE_CONFLICT';
    scan.recommendation = 'CODE_CONFLICT';
    scan.message = 'Ky kod i përket një klienti me telefon real. Order pa numër nuk mund të lidhet me këtë client_id.';
    return scan;
  }

  if (scan.codeOrder) {
    scan.resolver_state = 'CODE_CONFLICT';
    scan.recommendation = 'CODE_CONFLICT';
    scan.message = 'Ky kod tash i përket klientit tjetër. Nuk mund të futet ky problem me këtë kod.';
    return scan;
  }

  if (scan.codeClient && !pastrimiSameProblemClient(scan.codeClient, row)) {
    scan.resolver_state = 'CODE_CONFLICT';
    scan.recommendation = 'CODE_CONFLICT';
    scan.message = 'Ky kod tash i përket klientit tjetër. Nuk mund të futet ky problem me këtë kod.';
    return scan;
  }

  if (!completeness.ok) {
    scan.resolver_state = 'INCOMPLETE_PAYLOAD';
    scan.recommendation = 'NEEDS_ADMIN';
    scan.message = 'Ky problem nuk ka të dhëna të mjaftueshme për futje automatike.';
    return scan;
  }

  if (scan.phoneClient) {
    const phoneClientCode = normalizeCode(scan.phoneClient?.code || null);
    if (phoneClientCode != null && String(phoneClientCode) !== String(codeNum)) {
      scan.resolver_state = 'CODE_CONFLICT';
      scan.recommendation = 'CODE_CONFLICT';
      scan.message = 'Ky telefon ekziston me kod permanent tjetër. Nuk mund të futet ky problem me kod të ri.';
      return scan;
    }
  }

  scan.resolver_state = 'SAFE_TO_INSERT';
  scan.recommendation = 'SAFE_TO_INSERT';
  scan.message = 'Ky order nuk ekziston në DB dhe duket i sigurt për futje.';
  return scan;
}

function buildRecoveredPastrimiDataFromProblem(row = {}, client = {}, actor = {}) {
  const info = getPastrimProblemIdentity(row);
  const original = unwrapOrderData(row?.fullOrder || row?.data || {});
  const codeNum = Number(String(info.code || '').replace(/\D+/g, '')) || info.code;
  const phoneFull = normalizePastrimiResolverPhone(info.phone);
  const noPhone = !phoneFull || isPastrimiNoPhonePlaceholder(info.phone || '') || !!original?.no_phone;
  const masterPhone = noPhone ? buildPastrimiNoPhonePlaceholder(codeNum) : phoneFull;
  const clientName = info.name || original?.client_name || original?.client?.name || '';
  const at = new Date().toISOString();
  const pay = original?.pay && typeof original.pay === 'object' ? original.pay : {};
  const data = {
    ...original,
    id: String(info.localOid || row?.id || ''),
    local_oid: info.localOid || String(row?.id || ''),
    status: 'pastrim',
    code: codeNum,
    client_code: codeNum,
    client_id: client?.id || original?.client_id || original?.client_master_id || null,
    client_master_id: client?.id || original?.client_master_id || null,
    client_name: clientName,
    client_phone: noPhone ? '' : phoneFull,
    client_master_phone: noPhone ? masterPhone : null,
    no_phone: !!noPhone,
    pieces: Number(info.pieces || original?.pieces || 0),
    m2_total: Number(info.m2 || original?.m2_total || 0),
    price_total: Number(info.total || original?.price_total || 0),
    pay: {
      ...pay,
      m2: Number(info.m2 || pay?.m2 || 0),
      euro: Number(info.total || pay?.euro || 0),
    },
    totals: {
      ...((original?.totals && typeof original.totals === 'object') ? original.totals : {}),
      pieces: Number(info.pieces || original?.pieces || 0),
      m2: Number(info.m2 || original?.m2_total || 0),
      euro: Number(info.total || original?.price_total || 0),
    },
    client: {
      ...((original?.client && typeof original.client === 'object') ? original.client : {}),
      id: client?.id || original?.client?.id || null,
      code: codeNum,
      name: clientName,
      phone: noPhone ? '' : phoneFull,
    },
    save_attempt_id: info.saveAttemptId || original?.save_attempt_id || null,
    outbox_op_id: info.outboxOpId || original?.outbox_op_id || null,
    recovered_from_problem_resolver: true,
    recovered_at: at,
    recovered_by_pin: actor?.pin || null,
    recovered_by_name: actor?.name || null,
    local_sync_status: 'DB VERIFIED',
    pranimi_code_lifecycle: {
      ...((original?.pranimi_code_lifecycle && typeof original.pranimi_code_lifecycle === 'object') ? original.pranimi_code_lifecycle : {}),
      local_oid: info.localOid || String(row?.id || ''),
      save_attempt_id: info.saveAttemptId || original?.save_attempt_id || '',
      outbox_op_id: info.outboxOpId || original?.outbox_op_id || '',
      op_id: info.outboxOpId || original?.op_id || '',
      db_verify_state: 'DB_VERIFIED_FROM_PROBLEM_RESOLVER',
      db_verified_at: at,
    },
  };
  return data;
}

async function ensurePastrimiProblemClientForInsert(row = {}) {
  const info = getPastrimProblemIdentity(row);
  const codeNum = Number(String(info.code || '').replace(/\D+/g, ''));
  if (!Number.isFinite(codeNum) || codeNum <= 0) throw new Error('MISSING_CODE_FOR_CLIENT');
  const clientName = String(info.name || '').trim();
  const parts = clientName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || clientName || null;
  const lastName = parts.slice(1).join(' ') || null;
  const phoneFull = normalizePastrimiResolverPhone(info.phone);
  const noPhone = !phoneFull || isPastrimiNoPhonePlaceholder(info.phone || '');
  const finalPhone = noPhone ? buildPastrimiNoPhonePlaceholder(codeNum) : phoneFull;

  if (!noPhone && phoneFull) {
    const byPhone = await fetchPastrimiProblemClientByPhone(phoneFull);
    if (byPhone?.id) {
      const permanentCode = normalizeCode(byPhone?.code || null);
      if (permanentCode != null && String(permanentCode) !== String(codeNum)) {
        throw new Error(`PHONE_EXISTING_CLIENT_CODE_CONFLICT:${permanentCode}`);
      }
      return { ...byPhone, phone: phoneFull, no_phone_placeholder: false };
    }
  }

  const byCode = await fetchPastrimiProblemClientByCode(codeNum);
  if (byCode?.id) {
    if (noPhone && pastrimiClientHasRealPhone(byCode)) throw new Error('NO_PHONE_CODE_OWNER_REAL_PHONE_CONFLICT');
    if (!pastrimiSameProblemClient(byCode, row)) throw new Error('CODE_OWNER_DIFFERENT_CLIENT');
    return { ...byCode, no_phone_placeholder: noPhone };
  }

  const insertRow = {
    code: codeNum,
    full_name: clientName || null,
    first_name: firstName,
    last_name: lastName,
    phone: finalPhone,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('clients')
    .insert(insertRow)
    .select(PASTRIMI_PROBLEM_CLIENT_SELECT)
    .maybeSingle();
  if (error) {
    const text = String(error?.message || error?.details || error || '').toLowerCase();
    if (/duplicate|23505|unique/.test(text)) {
      if (!noPhone) {
        const byPhoneAgain = await fetchPastrimiProblemClientByPhone(phoneFull);
        if (byPhoneAgain?.id) return { ...byPhoneAgain, no_phone_placeholder: false };
      }
      const byCodeAgain = await fetchPastrimiProblemClientByCode(codeNum);
      if (byCodeAgain?.id && pastrimiSameProblemClient(byCodeAgain, row)) return { ...byCodeAgain, no_phone_placeholder: noPhone };
    }
    throw error;
  }
  return { ...(data || insertRow), no_phone_placeholder: noPhone };
}

async function insertPastrimiProblemOrder(row = {}, scanResult = null) {
  const info = getPastrimProblemIdentity(row);
  const codeNum = Number(String(info.code || '').replace(/\D+/g, ''));
  if (!codeNum) throw new Error('MISSING_CODE');
  const finalScan = await scanPastrimiProblemInDb(row);
  if (finalScan?.resolver_state !== 'SAFE_TO_INSERT') throw new Error(finalScan?.resolver_state || 'NOT_SAFE_TO_INSERT');
  const actor = readPastrimiResolveActor(row);
  const client = await ensurePastrimiProblemClientForInsert(row);
  const data = buildRecoveredPastrimiDataFromProblem(row, client, actor);
  const noPhone = !!data.no_phone;
  const insertRow = {
    local_oid: info.localOid,
    status: 'pastrim',
    code: codeNum,
    client_id: client?.id || null,
    client_name: data.client_name || info.name || null,
    client_phone: noPhone ? '' : (data.client_phone || ''),
    pieces: Number(info.pieces || 0),
    m2_total: Number(info.m2 || 0),
    price_total: Number(info.total || 0),
    paid_cash: Number(data?.pay?.paid || 0) || 0,
    is_paid_upfront: Number(data?.pay?.paid || 0) >= Number(info.total || 0) && Number(info.total || 0) > 0,
    data,
    updated_at: new Date().toISOString(),
  };
  const { data: inserted, error } = await supabase
    .from('orders')
    .insert(insertRow)
    .select(PASTRIMI_PROBLEM_ORDER_SELECT)
    .maybeSingle();
  if (error) throw error;
  const verified = await fetchPastrimiProblemOrderByFilter((q) => q.eq('local_oid', info.localOid));
  if (!verified?.id) throw new Error('DB_VERIFY_FAILED_AFTER_PROBLEM_RESOLVER_INSERT');
  return { inserted: inserted || verified, verified, client, scan: finalScan };
}

async function copyPastrimiProblemDiagnostic(row, scanResult = null) {
  const text = buildPastrimiProblemDiagnostic(row, scanResult);
  try {
    await navigator?.clipboard?.writeText?.(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      try { window.prompt('COPY RAPORT PËR ADMIN', text); } catch {}
      return false;
    }
  }
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

  const pushRow = (id, fullOrder, ts, source, synced, tableName = '', flags = {}) => {
    if (!id || !fullOrder) return;
    if (blacklist.includes(String(id))) return;
    const st = String(fullOrder.status || '').toLowerCase();
    if (normalizeStatus(st) !== normalizeStatus(status)) return;
    out.push({
      id,
      source,
      ts: Number(ts || fullOrder.ts || Date.now()),
      fullOrder,
      synced: !!synced,
      table: tableName || '',
      _table: tableName || '',
      ...(flags && typeof flags === 'object' ? flags : {}),
    });
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
      pushRow(id, full, ts, 'idb', !!x?._synced, tableName, {
        _local: x?._local === true || full?._local === true,
        _syncPending: x?._syncPending === true || full?._syncPending === true,
        _syncFailed: x?._syncFailed === true || full?._syncFailed === true,
        _syncError: x?._syncError || full?._syncError || '',
        local_sync_status: x?.local_sync_status || full?.local_sync_status || '',
      });
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


function buildOutboxProblemPastrimRows() {
  const outboxSnap = typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [];
  const problemStatuses = new Set(['failed', 'failed_permanently', 'dead_letter', 'error', 'db_verify_failed']);
  return Array.isArray(outboxSnap)
    ? outboxSnap.filter((it) => problemStatuses.has(String(it?.status || '').trim().toLowerCase()) && (it?.table === 'orders' || it?.table === 'transport_orders')).map((it) => {
        const rawPayload = it?.payload && typeof it.payload === 'object' ? it.payload : {};
        const table = String(it?.table || rawPayload?.table || rawPayload?._table || '').trim();
        const p = table === 'transport_orders' ? rawPayload : unwrapPayload(rawPayload);
        const view = p?.data && typeof p.data === 'object' ? p.data : p;
        const codeKey = view?.client?.code ?? view?.client?.tcode ?? p.code ?? p.code_str ?? p.code_n ?? p.order_code ?? p.client?.code ?? p.client_tcode ?? p.client_code ?? null;
        const m2 = computeM2(view);
        const cope = computePieces(view);
        return normalizeRenderableOrderRow({
          id: p.local_oid || p.id || rawPayload?.local_oid || rawPayload?.id || it?.op_id || null,
          local_oid: p.local_oid || rawPayload?.local_oid || null,
          status: normalizeStatus(p.status || rawPayload?.status || 'pastrim') || 'pastrim',
          source: 'OUTBOX',
          table,
          _table: table,
          ts: Number(it.updatedAt ? Date.parse(it.updatedAt) : it.createdAt ? Date.parse(it.createdAt) : Date.now()),
          name: view.client?.name || p.client?.name || p.client_name || 'Pa Emër',
          phone: view.client?.phone || p.client?.phone || p.client_phone || '',
          code: normalizeCode(codeKey),
          m2,
          cope,
          total: Number(view.pay?.euro || p.pay?.euro || p.total || 0),
          paid: Number(view.pay?.paid || p.pay?.paid || p.paid || 0),
          isPaid: false,
          isReturn: false,
          fullOrder: view,
          _outboxProblem: true,
          _syncFailed: true,
          _syncError: String(it?.lastError?.message || it?.lastError || it?.error || it?.status || ''),
          outbox_op_id: it?.op_id || it?.id || '',
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
function parsedOrderData(order) {
  if (!order || typeof order !== 'object') return {};
  const data = order.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {}
  }
  return {};
}
function positiveNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function fallbackM2FromRows(order) {
  if (!order) return 0;
  let total = 0;
  for (const r of getTepihaRows(order)) total += rowM2(r) * rowQty(r);
  for (const r of getStazaRows(order)) total += rowM2(r) * rowQty(r);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}
function fallbackPiecesFromRows(order) {
  if (!order) return 0;
  let pieces = 0;
  for (const r of getTepihaRows(order)) pieces += rowQty(r);
  for (const r of getStazaRows(order)) pieces += rowQty(r);
  pieces += getStairsQty(order);
  return pieces;
}
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
  const data = parsedOrderData(order);
  const preferred = positiveNumber(
    data?.pay?.m2,
    order?.pay?.m2,
    data?.m2_total,
    order?.m2_total,
    data?.total_m2,
    order?.total_m2
  );
  if (preferred > 0) return Number(preferred.toFixed(2));
  return fallbackM2FromRows(order);
}
function computePieces(order) {
  if (!order) return 0;
  const data = parsedOrderData(order);
  const preferred = positiveNumber(
    data?.pieces,
    order?.pieces,
    data?.cope,
    order?.cope
  );
  if (preferred > 0) return preferred;
  return fallbackPiecesFromRows(order);
}

function computeOrderMetrics(order) {
  if (!order) return { m2: 0, pieces: 0 };
  return {
    m2: computeM2(order),
    pieces: computePieces(order),
  };
}


function formatPaketimiM2(value) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(2)).toString();
}

function buildPaketimiPieceId(type, rowIndex, pieceIndex, m2) {
  const cleanType = String(type || 'tepih').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const m2Key = String(formatPaketimiM2(m2)).replace(/[^0-9]+/g, '_');
  return `${cleanType}_${Number(rowIndex || 0) + 1}_${Number(pieceIndex || 0) + 1}_${m2Key}`;
}

function normalizePaketimiQty(row, m2 = 0) {
  const raw = row?.qty ?? row?.pieces ?? row?.count ?? row?.quantity ?? row?.['copë'] ?? row?.cope;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
  return Number(m2) > 0 ? 1 : 0;
}

function buildPaketimiPiecesFromOrder(rawOrder = {}) {
  const order = unwrapOrderData(rawOrder || {});
  const data = parsedOrderData(order);
  const pieces = [];
  const typeCounters = { tepih: 0, staza: 0, shkallore: 0 };

  const pushPiece = (type, labelBase, rowIndex, pieceIndex, m2) => {
    const area = Number(m2) || 0;
    if (area <= 0) return;
    typeCounters[type] = Number(typeCounters[type] || 0) + 1;
    const qtyIndex = typeCounters[type];
    pieces.push({
      piece_id: buildPaketimiPieceId(type, rowIndex, pieceIndex, area),
      type,
      label: `${labelBase} ${qtyIndex} — ${formatPaketimiM2(area)} m²`,
      m2: Number(area.toFixed(2)),
      qty_index: qtyIndex,
      found: false,
      found_at: null,
      found_by: null,
    });
  };

  const pushRows = (rows, type, labelBase) => {
    (Array.isArray(rows) ? rows : []).forEach((row, rowIndex) => {
      const area = rowM2(row);
      const qty = normalizePaketimiQty(row, area);
      for (let i = 0; i < qty; i += 1) pushPiece(type, labelBase, rowIndex, i, area);
    });
  };

  pushRows(firstNonEmptyBridgeRows(data?.tepiha, data?.tepihaRows, order?.tepiha, order?.tepihaRows), 'tepih', 'Tepih');
  pushRows(firstNonEmptyBridgeRows(data?.staza, data?.stazaRows, order?.staza, order?.stazaRows), 'staza', 'Stazë');

  const stairsQty = Math.max(0, Math.floor(Number(data?.shkallore?.qty ?? data?.stairsQty ?? order?.shkallore?.qty ?? order?.stairsQty ?? getStairsQty(order)) || 0));
  const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? order?.shkallore?.per ?? order?.stairsPer ?? getStairsPer(order)) || SHKALLORE_M2_PER_STEP_DEFAULT;
  for (let i = 0; i < stairsQty; i += 1) pushPiece('shkallore', 'Shkallore', 0, i, stairsPer);

  if (pieces.length === 0) {
    const fallbackPieces = Math.max(0, Math.floor(Number(data?.pieces ?? order?.pieces ?? data?.cope ?? order?.cope ?? 0) || 0));
    const fallbackM2 = Number(data?.pay?.m2 ?? order?.pay?.m2 ?? data?.m2_total ?? order?.m2_total ?? data?.total_m2 ?? order?.total_m2 ?? computeM2(order)) || 0;
    const perPiece = fallbackPieces > 0 && fallbackM2 > 0 ? Number((fallbackM2 / fallbackPieces).toFixed(2)) : 0;
    for (let i = 0; i < fallbackPieces; i += 1) {
      typeCounters.tepih = Number(typeCounters.tepih || 0) + 1;
      pieces.push({
        piece_id: `fallback_${i + 1}_${String(formatPaketimiM2(perPiece)).replace(/[^0-9]+/g, '_')}`,
        type: 'tepih',
        label: `Copë ${i + 1}${perPiece > 0 ? ` — ${formatPaketimiM2(perPiece)} m²` : ''}`,
        m2: perPiece,
        qty_index: typeCounters.tepih,
        found: false,
        found_at: null,
        found_by: null,
      });
    }
  }

  return pieces;
}

function buildPaketimiPieceSignature(piece = {}) {
  return [piece?.type || '', formatPaketimiM2(piece?.m2), Number(piece?.qty_index || 0)].join('|');
}

function getPaketimiStats(paketimi = {}) {
  const pieces = Array.isArray(paketimi?.pieces) ? paketimi.pieces : [];
  const foundPieces = pieces.filter((piece) => !!piece?.found);
  const missingPieces = pieces.filter((piece) => !piece?.found);
  const missingM2 = missingPieces.reduce((sum, piece) => sum + (Number(piece?.m2) || 0), 0);
  const foundM2 = foundPieces.reduce((sum, piece) => sum + (Number(piece?.m2) || 0), 0);
  return {
    total: pieces.length,
    found: foundPieces.length,
    missing: missingPieces.length,
    missingM2: Number(missingM2.toFixed(2)),
    foundM2: Number(foundM2.toFixed(2)),
    foundPieces,
    missingPieces,
    allFound: pieces.length > 0 && missingPieces.length === 0,
    noneFound: foundPieces.length === 0,
    someFound: foundPieces.length > 0 && missingPieces.length > 0,
  };
}

function recalcPaketimiStatus(paketimi = {}) {
  const stats = getPaketimiStats(paketimi);
  const existingStatus = String(paketimi?.status || '').trim();
  if (existingStatus === 'final_ready' && stats.allFound && paketimi?.wrapped && String(paketimi?.final_rack || '').trim()) return 'final_ready';
  if (stats.noneFound) return 'not_started';
  if (stats.someFound) return 'partial';
  if (stats.allFound && !paketimi?.wrapped) return 'complete_not_wrapped';
  if (stats.allFound && paketimi?.wrapped && !String(paketimi?.final_rack || '').trim()) return 'wrapped_ready_for_rack';
  if (stats.allFound && paketimi?.wrapped && String(paketimi?.final_rack || '').trim()) return existingStatus === 'final_ready' ? 'final_ready' : 'wrapped_ready_for_rack';
  return existingStatus || 'not_started';
}

function mergeExistingPaketimiWithPieces(rawOrder = {}, row = {}) {
  const order = unwrapOrderData(rawOrder || row?.fullOrder || row?.data || row || {});
  const data = parsedOrderData(order);
  const existing = (order?.paketimi_v1 && typeof order.paketimi_v1 === 'object')
    ? order.paketimi_v1
    : ((data?.paketimi_v1 && typeof data.paketimi_v1 === 'object') ? data.paketimi_v1 : {});
  const basePieces = buildPaketimiPiecesFromOrder(order);
  const existingPieces = Array.isArray(existing?.pieces) ? existing.pieces : [];
  const byId = new Map();
  const bySig = new Map();
  existingPieces.forEach((piece) => {
    if (!piece || typeof piece !== 'object') return;
    const id = String(piece?.piece_id || '').trim();
    if (id) byId.set(id, piece);
    const sig = buildPaketimiPieceSignature(piece);
    if (sig && !bySig.has(sig)) bySig.set(sig, piece);
  });
  const pieces = basePieces.map((piece) => {
    const prev = byId.get(String(piece?.piece_id || '').trim()) || bySig.get(buildPaketimiPieceSignature(piece)) || null;
    return {
      ...piece,
      found: !!prev?.found,
      found_at: prev?.found_at || null,
      found_by: prev?.found_by || null,
    };
  });
  const next = {
    status: String(existing?.status || 'not_started').trim() || 'not_started',
    found_location_note: String(existing?.found_location_note || '').trim(),
    wrapped: !!existing?.wrapped,
    wrapped_at: existing?.wrapped_at || null,
    wrapped_by: existing?.wrapped_by || null,
    final_rack: normalizePaketimiFinalRack(existing?.final_rack),
    updated_at: existing?.updated_at || null,
    updated_by: existing?.updated_by || null,
    pieces,
  };
  next.status = recalcPaketimiStatus(next);
  return next;
}

function getOrderPaketimi(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const data = parsedOrderData(order);
  return (order?.paketimi_v1 && typeof order.paketimi_v1 === 'object')
    ? order.paketimi_v1
    : ((data?.paketimi_v1 && typeof data.paketimi_v1 === 'object') ? data.paketimi_v1 : null);
}

function getPaketimiBadge(row = {}) {
  const existing = getOrderPaketimi(row);
  if (!existing) return { text: 'PA PAKETU', tone: 'empty' };
  const paketimi = mergeExistingPaketimiWithPieces(row?.fullOrder || row?.data || row || {}, row);
  const stats = getPaketimiStats(paketimi);
  const status = recalcPaketimiStatus(paketimi);
  if (status === 'partial') {
    const firstMissing = stats.missingPieces[0];
    const missingText = stats.missingM2 > 0 ? `${formatPaketimiM2(stats.missingM2)} m²` : (firstMissing?.label || `${stats.missing} copë`);
    const note = String(paketimi?.found_location_note || '').trim();
    return {
      text: `PAKETIMI ${stats.found}/${stats.total} COPË • Mungon: ${missingText}${note ? ` • Të gjeturat: ${note}` : ''}`,
      tone: 'partial',
      title: `PAKETIMI ${stats.found}/${stats.total} COPË`,
      missingLabel: 'MUNGON:',
      missingValue: missingText,
      foundText: note ? `TË GJETURAT: ${note}` : '',
    };
  }
  if (status === 'complete_not_wrapped') return { text: `GJETUR ${stats.found}/${stats.total} — BËJE ROLL`, tone: 'complete' };
  if (status === 'wrapped_ready_for_rack') return { text: 'PAKETUAR — VENDOS RAFTIN', tone: 'wrapped' };
  if (status === 'final_ready') return { text: 'GATI PËR SMS', tone: 'ready' };
  return { text: 'PA PAKETU', tone: 'empty' };
}

function buildPaketimiMissingMessage(paketimi = {}, prefix = 'SMS nuk lejohet.') {
  const stats = getPaketimiStats(paketimi);
  const missingList = stats.missingPieces.map((piece) => piece?.label || `${formatPaketimiM2(piece?.m2)} m²`).filter(Boolean).join(', ');
  const note = String(paketimi?.found_location_note || '').trim();
  const parts = [];
  if (!stats.allFound) parts.push(`Mungon: ${missingList || `${stats.missing} copë`} ${stats.missingM2 > 0 ? `(${formatPaketimiM2(stats.missingM2)} m²)` : ''}`.trim());
  if (stats.allFound && !paketimi?.wrapped) parts.push('mungon roll/paketimi');
  if (stats.allFound && paketimi?.wrapped && !String(paketimi?.final_rack || '').trim()) parts.push('mungon rafti');
  if (note) parts.push(`Të gjeturat: ${note}`);
  return `${prefix} ${parts.join('. ')}`.trim();
}

function isPaketimiReadyForSms(paketimi = {}) {
  const stats = getPaketimiStats(paketimi);
  return stats.allFound && !!paketimi?.wrapped && !!String(paketimi?.final_rack || '').trim() && String(paketimi?.status || '').trim() === 'final_ready';
}

function buildPaketimiPhoneHref(phone) {
  const raw = String(phone || '').trim();
  if (!raw || /pa\s*num|pa\s*numer|pa\s*numër|pa\s*nr/i.test(raw)) return '';
  const compact = raw.replace(/[^+\d]/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length < 6) return '';
  return `tel:${compact}`;
}

function formatConcreteRackSlots(slots = []) {
  return normalizeRackSlots(slots).map((slot) => formatRackLocationLabel(slot)).join(', ');
}

function buildConcreteRackRequiredMessage(prefix = 'Nuk lejohet me vazhdu.') {
  return `${prefix} Zgjidh raftin konkret, p.sh. A12/B4 ose FURRA POSHT - A7. Vetëm “FURRA POSHT”, “FURRA NALT” ose shënim pa raft nuk mjafton.`;
}

function normalizePaketimiFinalRack(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  const upper = raw.toUpperCase();
  const plain = upper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slotMatch = plain.match(/(?:^|[^A-Z0-9])([A-Z]{1,2})\s*-?\s*(\d{1,3})(?=$|[^A-Z0-9])/);
  const slot = slotMatch ? `${slotMatch[1]}${slotMatch[2]}` : '';
  const isUpperOverflow = /\b(FURRA\s+)?(NALT|NALTE|LART)\b/.test(plain);
  const isLowerOverflow = !isUpperOverflow && /\b(FURRA\s+)?(POSHT|POSHTE)\b/.test(plain);
  if (isUpperOverflow) return slot ? `FURRA NALT — ${slot}` : 'FURRA NALT';
  if (isLowerOverflow) return slot ? `FURRA POSHT — ${slot}` : 'FURRA POSHT';
  return upper.trim();
}


const PAKETIMI_RACK_ZONE_OPTIONS = [
  { key: 'A', label: 'A' },
  { key: 'B', label: 'B' },
  { key: 'FURRA_POSHT', label: 'FURRA POSHT' },
  { key: 'FURRA_NALT', label: 'FURRA NALT' },
];

const PAKETIMI_RACK_SLOTS = {
  FURRA_POSHT: Array.from({ length: 40 }, (_, i) => `A${i + 1}`),
  FURRA_NALT: Array.from({ length: 40 }, (_, i) => `A${i + 1}`),
  A: Array.from({ length: 50 }, (_, i) => `A${i + 1}`),
  B: Array.from({ length: 20 }, (_, i) => `B${i + 1}`),
};

function normalizePaketimiRackZone(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'FURRA_POSHT' || /FURRA\s*POSHT/.test(raw)) return 'FURRA_POSHT';
  if (raw === 'FURRA_NALT' || /FURRA\s*NALT/.test(raw) || /FURRA\s*NALTE/.test(raw)) return 'FURRA_NALT';
  if (raw === 'B') return 'B';
  return 'A';
}

function inferPaketimiRackZone(value) {
  const slot = normalizeRackSlots(value)[0] || '';
  if (/^FURRA_POSHT_/.test(slot)) return 'FURRA_POSHT';
  if (/^FURRA_NALT_/.test(slot)) return 'FURRA_NALT';
  if (/^B\d+/i.test(slot)) return 'B';
  if (/^A\d+/i.test(slot)) return 'A';
  return normalizePaketimiRackZone(value) || 'A';
}

function getPaketimiRackSelectedSlot(value) {
  const slot = normalizeRackSlots(value)[0] || '';
  let match = slot.match(/^FURRA_(?:POSHT|NALT)_A(\d{1,2})$/);
  if (match) return `A${Number(match[1])}`;
  match = slot.match(/^([AB])(\d{1,2})$/);
  if (match) return `${match[1]}${Number(match[2])}`;
  return '';
}

function getPaketimiRackSlotsForZone(zone) {
  const key = normalizePaketimiRackZone(zone);
  return PAKETIMI_RACK_SLOTS[key] || PAKETIMI_RACK_SLOTS.A;
}

function buildPaketimiRackValue(zone, slot) {
  const zoneKey = normalizePaketimiRackZone(zone);
  const slotKey = String(slot || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!slotKey) return '';
  if (zoneKey === 'FURRA_POSHT' || zoneKey === 'FURRA_NALT') {
    return formatRackLocationLabel(`${zoneKey}_${slotKey}`);
  }
  return formatRackLocationLabel(slotKey);
}

function getPaketimiRackStepMeta(stats = {}, paketimi = {}) {
  const wrapped = !!paketimi?.wrapped;
  const rackReady = hasConcreteRackLocation(paketimi?.final_rack);
  if (rackReady) return { active: 3, foundDone: true, packageDone: true, rackDone: true };
  if (wrapped) return { active: 3, foundDone: true, packageDone: true, rackDone: false };
  if (stats?.allFound) return { active: 2, foundDone: true, packageDone: false, rackDone: false };
  return { active: 1, foundDone: false, packageDone: false, rackDone: false };
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


function schedulePastrimiIdleTask(task, delayMs = 300) {
  try {
    const run = () => {
      try {
        const result = typeof task === 'function' ? task() : null;
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {}
    };
    if (typeof window === 'undefined') {
      setTimeout(run, delayMs);
      return null;
    }
    return window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1800 });
        return;
      }
      run();
    }, delayMs);
  } catch {
    return null;
  }
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

function pastrimTimeMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return 0;
    if (value > 1000000000000) return value;
    if (value > 1000000000) return value * 1000;
    return 0;
  }
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 1000000000000) return n;
    if (n > 1000000000) return n * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pastrimIsoFromMs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  try { return new Date(n).toISOString(); } catch { return null; }
}

function readPastrimDelayReview(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const review = order?.pastrim_delay_review;
  return review && typeof review === 'object' && !Array.isArray(review) ? review : null;
}

function getPastrimStartedAtMs(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const statusHistory = Array.isArray(order?.status_history)
    ? order.status_history
    : (Array.isArray(order?.statusHistory) ? order.statusHistory : []);
  const pastrimHistory = [...statusHistory].reverse().find((item) => {
    const st = normalizeStatus(item?.status || item?.to || item?.next_status || item?.nextStatus || '');
    return st === 'pastrim' || st === 'pastrimi';
  });
  const candidates = [
    order?.pastrim_delay_started_at,
    order?.pastrim_started_at,
    order?.pastrimStartedAt,
    order?.pastrim_at,
    order?.base_processing_at,
    order?.baseProcessingAt,
    order?.status_entered_at,
    order?.statusEnteredAt,
    order?.status_changed_at,
    order?.statusChangedAt,
    pastrimHistory?.at,
    pastrimHistory?.created_at,
    pastrimHistory?.ts,
    row?.pastrim_started_at,
    row?.pastrim_at,
    row?.created_at,
    order?.created_at,
    row?.ts,
    order?.ts,
  ];
  for (const value of candidates) {
    const ms = pastrimTimeMs(value);
    if (ms > 0) return ms;
  }
  return Date.now();
}

function readPastrimDelayMoney(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const pay = order?.pay && typeof order.pay === 'object' ? order.pay : {};
  const metrics = computeOrderMetrics(order);
  const totalCandidates = [
    row?.total,
    row?.price_total,
    order?.price_total,
    order?.total,
    order?.totalEuro,
    order?.client_total,
    pay?.euro,
    pay?.total,
    pay?.price,
    metrics?.total,
  ];
  const paidCandidates = [
    row?.paid,
    row?.paid_amount,
    row?.paid_cash,
    order?.paid,
    order?.clientPaid,
    order?.paid_cash,
    pay?.paid,
    pay?.arkaRecordedPaid,
  ];
  const firstPositive = (values) => {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
    }
    return 0;
  };
  const maxPaid = paidCandidates.reduce((max, value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const total = firstPositive(totalCandidates);
  const paid = Number(Math.max(0, maxPaid).toFixed(2));
  const debt = Number(Math.max(0, total - paid).toFixed(2));
  return { total, paid, debt };
}

function getPastrimDelayReviewInfo(row = {}, nowMs = Date.now()) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  const table = String(row?._table || row?.table || row?.source || '').trim();
  const status = normalizeStatus(getDbTruthStatus(row) || row?.status || order?.status || '');
  const isPastrim = status === 'pastrim' || status === 'pastrimi';
  const isTransport = table === 'transport_orders' || isPastrimTransportScopedRow(row);
  const startedMs = getPastrimStartedAtMs(row);
  const ageMs = Math.max(0, Number(nowMs || Date.now()) - startedMs);
  const ageDaysExact = ageMs / (24 * 60 * 60 * 1000);
  const review = readPastrimDelayReview(row);
  const nextReviewMs = pastrimTimeMs(review?.next_review_at || order?.pastrim_delay_next_review_at || null);
  const nextReviewActive = isPastrim && nextReviewMs > Number(nowMs || Date.now());
  const warning = isPastrim && !isTransport && ageMs >= PASTRIM_DELAY_REVIEW_MS;
  return {
    isPastrim,
    isTransport,
    warning,
    due: warning && !nextReviewActive,
    softWarning: warning && nextReviewActive,
    started_at: pastrimIsoFromMs(startedMs),
    started_ms: startedMs,
    age_days: Math.floor(ageDaysExact),
    age_days_exact: Number(ageDaysExact.toFixed(2)),
    next_review_at: nextReviewMs > 0 ? pastrimIsoFromMs(nextReviewMs) : null,
    next_review_active: nextReviewActive,
    last_review: review,
  };
}

function buildPastrimDelayReviewKey(row = {}) {
  const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
  return String(row?.id || row?.dbId || order?.id || order?.local_oid || row?.local_oid || row?.code || '').trim();
}

function isPastrimDelayReviewDue(row = {}) {
  return !!getPastrimDelayReviewInfo(row).due;
}

// UI-only: does this row currently carry an unpaid balance?
// Read-only, derived from existing order fields. No DB write, no status change.
function pastrimRowHasDebt(row = {}) {
  return readPastrimDelayMoney(row).debt > 0;
}

// UI-only quick-filter predicate for the PASTRIMI list.
// Operates purely on the already-loaded row. Never queries the DB and never
// mutates status. `filter` is one of: all | over4 | unpacked | debt | snooze | due
function matchesPastrimFilter(row = {}, filter = 'all') {
  if (!filter || filter === 'all') return true;
  const info = getPastrimDelayReviewInfo(row);
  switch (filter) {
    case 'over4':
      return !!info.warning;
    case 'due':
      return !!info.due;
    case 'snooze':
      return !!info.softWarning;
    case 'unpacked':
      return getPaketimiBadge(row)?.tone === 'empty';
    case 'debt':
      return pastrimRowHasDebt(row);
    default:
      return true;
  }
}

function compactPastrimDelayWorker(user = {}) {
  const pin = String(user?.pin || user?.user_pin || user?.worker_pin || '').trim();
  const name = String(user?.name || user?.full_name || user?.worker_name || user?.label || '').trim();
  return { pin, name };
}

function appendPastrimDelayReviewHistory(data = {}, reviewEntry = {}) {
  const current = data && typeof data === 'object' ? data : {};
  const history = Array.isArray(current?.pastrim_delay_review_history)
    ? [...current.pastrim_delay_review_history]
    : [];
  const existingCurrent = current?.pastrim_delay_review && typeof current.pastrim_delay_review === 'object'
    ? current.pastrim_delay_review
    : null;
  const existingKey = (item) => [item?.reviewed_at, item?.status, item?.reason, item?.responsible_worker_pin].map((x) => String(x || '')).join('|');
  const keys = new Set(history.map(existingKey));
  if (existingCurrent && !keys.has(existingKey(existingCurrent))) {
    history.push(existingCurrent);
    keys.add(existingKey(existingCurrent));
  }
  history.push(reviewEntry);
  return history;
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

  const [orders, setOrders] = useState([]);
  const [exactRecoveredRow, setExactRecoveredRow] = useState(null);
  const [exactSearchTimedOut, setExactSearchTimedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [localModeNotice, setLocalModeNotice] = useState('DB_LOADING');
  const [dbTruthState, setDbTruthState] = useState({ dbFetchOk: false, dbFetchFailed: false, usingDbTruth: false, source: 'INIT' });
  const dbTruthStateRef = useRef({ dbFetchOk: false, dbFetchFailed: false, usingDbTruth: false, source: 'INIT' });
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  // UI-only quick filter for the PASTRIMI list. Pure client-side, does not change
  // any DB query, status or the list that is fetched. One of:
  // 'all' | 'over4' | 'unpacked' | 'debt' | 'snooze' | 'due'
  const [pastrimFilter, setPastrimFilter] = useState('all');
  const [, startListTransition] = useTransition();

  const [debugInfo, setDebugInfo] = useState({
    source: 'INIT', dbCount: 0, localCount: 0,
    dbRowsCount: 0, hiddenGhostRowsCount: 0, localProblemRowsCount: 0, lastDbFetchAt: null,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    lastError: null, ts: 0,
  });
  const [readyCountHint, setReadyCountHint] = useState(null);
  const [staffUsers, setStaffUsers] = useState([]);
  const [transportUserLookup, setTransportUserLookup] = useState(() => buildTransportUserLookup([]));
  const [pastrimDelayReview, setPastrimDelayReview] = useState({
    open: false, row: null, status: '', reason: '', responsible_pin: '', responsible_name: '', cash_amount: '', incident_note: '', dueInfo: null, source: 'auto',
  });
  const [pastrimDelayReviewBusy, setPastrimDelayReviewBusy] = useState(false);
  const [pastrimDelayReviewMsg, setPastrimDelayReviewMsg] = useState('');
  const pastrimDelayPromptedRef = useRef(new Set());

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const res = await listUsers({ includeInactive: true });
          if (!alive) return;
          const users = res?.ok ? (res.items || []) : [];
          setStaffUsers(Array.isArray(users) ? users : []);
          setTransportUserLookup(buildTransportUserLookup(users));
        } catch {
          if (alive) {
            setStaffUsers([]);
            setTransportUserLookup(buildTransportUserLookup([]));
          }
        }
      })();
    }, 250);
    return () => {
      alive = false;
      try { window.clearTimeout(timer); } catch {}
    };
  }, []);

  const pastrimDelayStaffOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    const push = (user) => {
      const worker = compactPastrimDelayWorker(user);
      if (!worker.pin && !worker.name) return;
      const key = `${worker.pin || ''}::${worker.name || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(worker);
    };
    (Array.isArray(staffUsers) ? staffUsers : []).forEach(push);
    Object.entries(transportUserLookup?.byPin || {}).forEach(([pin, name]) => push({ pin, name }));
    return out.sort((a, b) => String(a.name || a.pin || '').localeCompare(String(b.name || b.pin || '')));
  }, [staffUsers, transportUserLookup]);

  useEffect(() => {
    if (loading || editMode || pastrimDelayReview?.open) return;
    const dueRow = (Array.isArray(orders) ? orders : []).find((row) => isPastrimDelayReviewDue(row));
    if (!dueRow) return;
    const dueInfo = getPastrimDelayReviewInfo(dueRow);
    const keyBase = buildPastrimDelayReviewKey(dueRow);
    const key = `${keyBase}:${dueInfo?.last_review?.reviewed_at || dueInfo?.next_review_at || dueInfo?.started_at || 'initial'}`;
    if (keyBase && pastrimDelayPromptedRef.current.has(key)) return;
    if (keyBase) pastrimDelayPromptedRef.current.add(key);
    openPastrimDelayReview(dueRow, 'auto_enter_pastrim');
  }, [loading, editMode, orders, pastrimDelayReview?.open]);

  function updateDbTruthState(next = {}) {
    setDbTruthState((prev) => {
      const merged = { ...prev, ...(next && typeof next === 'object' ? next : {}) };
      dbTruthStateRef.current = merged;
      return merged;
    });
  }

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
          const currentlyOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
          const dbAlreadyFailed = !!dbTruthStateRef.current?.dbFetchFailed;
          setExactSearchTimedOut(true);
          if ((currentlyOffline || dbAlreadyFailed) && localRows.length > 0) {
            setLoading(false);
            applyPastrimiRowsLocalFirst(localRows, 'EXACT_SEARCH_TIMEOUT_LOCAL_LIST', { exactSearchTimeout: true, openId });
            markPastrimiFailOpenReady('exact_search_timeout_local_fail_open', localRows.length);
          }
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
  const [rowPaySheet, setRowPaySheet] = useState(false);
  const [rowPayOrder, setRowPayOrder] = useState(null);
  const [rowPayAmount, setRowPayAmount] = useState(0);
  const [rowPayBusy, setRowPayBusy] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [readyPlaceSheet, setReadyPlaceSheet] = useState(false);
  const [readyPlaceOrder, setReadyPlaceOrder] = useState(null);
  const [readyPlaceText, setReadyPlaceText] = useState('');
  const [readyPlaceBusy, setReadyPlaceBusy] = useState(false);
  const [readySlots, setReadySlots] = useState([]);
  const [smsModal, setSmsModal] = useState({ open: false, phone: '', text: '' });
  const [paketimiSheet, setPaketimiSheet] = useState(false);
  const [paketimiOrder, setPaketimiOrder] = useState(null);
  const [paketimiDraft, setPaketimiDraft] = useState(null);
  const [paketimiBusy, setPaketimiBusy] = useState(false);
  const [paketimiError, setPaketimiError] = useState('');
  const [paketimiNotice, setPaketimiNotice] = useState('');
  const [paketimiRackZone, setPaketimiRackZone] = useState('A');
  const paketimiRackInputRef = useRef(null);
  const [slotMap, setSlotMap] = useState({});
  const [payAdd, setPayAdd] = useState(0);

  const [streamPastrimM2, setStreamPastrimM2] = useState(0);
  const [localProblemRows, setLocalProblemRows] = useState([]);
  const [localProblemOpen, setLocalProblemOpen] = useState(false);
  const [resolvedLocalProblemVersion, setResolvedLocalProblemVersion] = useState(0);
  const [problemResolverState, setProblemResolverState] = useState({});
  const insertingProblemKeysRef = useRef(new Set());
  const deferredPersistTimer = useRef(null);
  const deferredPersistToken = useRef(0);

  useEffect(() => {
    if (!paketimiSheet || !paketimiDraft) return;
    const stats = getPaketimiStats(paketimiDraft);
    const hasMissingError = /mungon/i.test(String(paketimiError || ''));
    if (stats.allFound && hasMissingError) setPaketimiError('');
    if (stats.allFound && !paketimiDraft?.wrapped) {
      setPaketimiNotice('Krejt copat janë gjetur. Tash bëje roll/paketimin.');
    } else if (stats.allFound && paketimiDraft?.wrapped && !String(paketimiDraft?.final_rack || '').trim() && String(paketimiDraft?.status || '') !== 'final_ready') {
      setPaketimiNotice('Shkruaj raftin/lokacionin final.');
    } else {
      setPaketimiNotice('');
    }
  }, [paketimiSheet, paketimiDraft, paketimiError]);

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
    setLocalProblemRows([]);
    updateDbTruthState({
      dbFetchOk: false,
      dbFetchFailed: /FALLBACK|ERROR|TIMEOUT|FAILED/i.test(String(source || '')),
      usingDbTruth: false,
      source,
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

  function hidePastrimiProblemRow(row, marker) {
    const markerTokens = new Set([
      ...(marker?.tokens || []),
      ...getPastrimiResolvedProblemTokens(row),
      ...getPastrimiResolvedProblemTokens(marker || {}),
      ...getPastrimiResolvedProblemTokensDeep(row),
      ...getPastrimiResolvedProblemTokensDeep(marker || {}),
    ].filter(Boolean));
    setLocalProblemRows((prev) => {
      const next = filterResolvedPastrimiLocalProblems((Array.isArray(prev) ? prev : []).filter((candidate) => {
        const tokens = uniquePastrimiResolvedTokens([
          ...getPastrimiResolvedProblemTokens(candidate),
          ...getPastrimiResolvedProblemTokensDeep(candidate),
        ]);
        return !tokens.some((token) => markerTokens.has(token));
      }));
      setDebugInfo((prevInfo) => ({
        ...(prevInfo || {}),
        localCount: next.length,
        localProblemRowsCount: next.length,
        ts: Date.now(),
      }));
      updateDbTruthState({ localProblemCount: next.length });
      return next;
    });
    setResolvedLocalProblemVersion((v) => v + 1);
  }

  function handleResolvePastrimiLocalProblem(row, opts = {}) {
    if (typeof window !== 'undefined') {
      const ok = window.confirm('Ky problem do te fshihet vetem nga ky telefon. Nuk do te futet ne DB. Vazhdo?');
      if (!ok) return;
    }
    const key = buildPastrimiProblemKey(row);
    const scanResult = opts?.scanResult || problemResolverState?.[key]?.scan || null;
    const marker = persistPastrimiResolvedLocalProblem(row, opts?.note || '', {
      reason: opts?.reason || 'HIDDEN_BY_WORKER',
      scanResult,
    });
    persistPastrimiResolvedLocalProblemTombstones(marker?.tokens || []);
    const purgeResult = purgeResolvedPastrimiProblemFromLocalSources(row, marker);
    hidePastrimiProblemRow(row, marker);
    setLocalProblemRows((prev) => filterResolvedPastrimiLocalProblems(Array.isArray(prev) ? prev : []));
    setResolvedLocalProblemVersion((v) => v + 1);
    try { console.info('[PASTRIMI] local problem resolved and purged', purgeResult); } catch {}
    if (typeof window !== 'undefined') {
      window.alert('Problemi u fsheh nga ky telefon.');
    }
  }

  async function handleCheckPastrimiProblemInDb(row) {
    const key = buildPastrimiProblemKey(row);
    setProblemResolverState((prev) => ({
      ...(prev || {}),
      [key]: { ...((prev || {})[key] || {}), checking: true, error: null },
    }));
    try {
      const scan = await scanPastrimiProblemInDb(row);
      setProblemResolverState((prev) => ({
        ...(prev || {}),
        [key]: { ...((prev || {})[key] || {}), checking: false, checked: true, scan, error: null },
      }));
    } catch (error) {
      setProblemResolverState((prev) => ({
        ...(prev || {}),
        [key]: { ...((prev || {})[key] || {}), checking: false, checked: false, scan: null, error: String(error?.message || error || 'DB_SCAN_FAILED') },
      }));
    }
  }

  async function handleCopyPastrimiProblemReport(row) {
    const key = buildPastrimiProblemKey(row);
    const scan = problemResolverState?.[key]?.scan || null;
    const ok = await copyPastrimiProblemDiagnostic(row, scan);
    if (ok) alert('COPY RAPORT PËR ADMIN u kopjua.');
  }

  async function handleInsertPastrimiProblem(row) {
    const key = buildPastrimiProblemKey(row);
    const state = problemResolverState?.[key] || {};
    const scan = state?.scan || null;
    if (scan?.resolver_state !== 'SAFE_TO_INSERT') {
      alert('Së pari kliko KONTROLLO NË DB. FUTE NË PASTRIM hapet vetëm kur rezultati është SAFE_TO_INSERT.');
      return;
    }
    if (insertingProblemKeysRef.current.has(key)) return;
    if (typeof window !== 'undefined') {
      const ok = window.confirm('Ky order do të futet në DB si PASTRIM. Vazhdo?');
      if (!ok) return;
    }
    insertingProblemKeysRef.current.add(key);
    setProblemResolverState((prev) => ({
      ...(prev || {}),
      [key]: { ...((prev || {})[key] || {}), inserting: true, insertError: null },
    }));
    try {
      const res = await insertPastrimiProblemOrder(row, scan);
      const marker = persistPastrimiResolvedLocalProblem(row, 'U fut në DB nga PASTRIMI problem resolver.', {
        reason: 'INSERTED_FROM_PROBLEM_RESOLVER',
        scanResult: res?.scan || scan,
      });
      hidePastrimiProblemRow(row, marker);
      setProblemResolverState((prev) => ({
        ...(prev || {}),
        [key]: { ...((prev || {})[key] || {}), inserting: false, inserted: true, insertError: null, scan: res?.scan || scan, verified: res?.verified || null },
      }));
      alert('U FUT NË DB / DB VERIFIED');
      await refreshOrders({ force: true, source: 'problem_resolver_insert_verified' });
    } catch (error) {
      setProblemResolverState((prev) => ({
        ...(prev || {}),
        [key]: { ...((prev || {})[key] || {}), inserting: false, inserted: false, insertError: String(error?.message || error || 'INSERT_FAILED') },
      }));
      alert(`Gabim: ${String(error?.message || error || 'INSERT_FAILED')}`);
    } finally {
      insertingProblemKeysRef.current.delete(key);
    }
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
    const bootOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (bootOffline) {
      const localRows = buildImmediatePastrimLocalRows();
      applyPastrimiRowsLocalFirst(localRows, localRows.length ? 'LOCAL_OFFLINE_BOOT' : 'LOCAL_OFFLINE_EMPTY');
      markPastrimiFailOpenReady(localRows.length ? 'LOCAL_OFFLINE_BOOT' : 'LOCAL_OFFLINE_EMPTY', localRows.length);
      setLoading(false);
    } else {
      updateDbTruthState({ dbFetchOk: false, dbFetchFailed: false, usingDbTruth: false, source: 'DB_LOADING' });
      setOrders([]);
      setStreamPastrimM2(0);
      setLocalProblemRows([]);
      setLocalModeNotice('DB_LOADING');
      setDebugInfo((prev) => ({ ...prev, source: 'DB_LOADING', localCount: 0, lastError: null, online: true, ts: Date.now() }));
      setLoading(true);
    }

    const loadingGuard = window.setTimeout(() => {
      const currentRows = buildImmediatePastrimLocalRows();
      const currentlyOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const dbAlreadyFailed = !!dbTruthStateRef.current?.dbFetchFailed;
      if ((currentlyOffline || dbAlreadyFailed) && currentRows.length > 0) {
        applyPastrimiRowsLocalFirst(currentRows, currentlyOffline ? 'LOCAL_OFFLINE_GUARD' : 'LOCAL_TIMEOUT_FALLBACK', { remoteTimeout: dbAlreadyFailed });
        setLoading(false);
      }
      writePastrimiLoadingTimeoutMarker({
        source: 'mount_loading_guard',
        cacheSourceUsed: (currentlyOffline || dbAlreadyFailed) && currentRows.length > 0 ? 'local_cache' : 'db_loading_no_cache',
        localRowCount: (currentlyOffline || dbAlreadyFailed) ? currentRows.length : 0,
        remoteTimeout: dbAlreadyFailed,
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
        const currentlyOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const dbAlreadyFailed = !!dbTruthStateRef.current?.dbFetchFailed;
        if ((currentlyOffline || dbAlreadyFailed) && currentRows.length > 0) {
          applyPastrimiRowsLocalFirst(currentRows, currentlyOffline ? 'VISIBLE_OFFLINE_LOCAL_FALLBACK' : 'VISIBLE_STUCK_LOCAL_FALLBACK', { visibleStuck: true });
          setReadyCountHint(currentRows.length);
          setLoading(false);
          markPastrimiFailOpenReady('visible_stuck_loading_timeout', currentRows.length);
        }
        writePastrimiLoadingTimeoutMarker({
          source: 'visible_stuck_loading_watchdog',
          cacheSourceUsed: (currentlyOffline || dbAlreadyFailed) && currentRows.length > 0 ? 'local_cache' : 'db_loading_no_cache',
          localRowCount: (currentlyOffline || dbAlreadyFailed) ? currentRows.length : 0,
          remoteTimeout: dbAlreadyFailed,
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
                saveOrderLocal({ id: row.id, status: normalizeStatus(getDbTruthStatus(row)), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, _table: 'orders' }).catch(() => {});
                patchPastrimRealtimeRow(row, 'orders');
              }, 0);
            }
            const nextStatus = normalizeStatus(getDbTruthStatus(payload?.new) || '');
            const prevStatus = normalizeStatus(getDbTruthStatus(payload?.old) || '');
            const needsFullRefresh = String(payload?.eventType || '').toUpperCase() === 'DELETE' || prevStatus !== nextStatus;
            if (needsFullRefresh) scheduleRealtimeFullRefresh(PASTRTRIMI_REALTIME_FULL_REFRESH_DELAY_MS, 'realtime_orders_transition');
        }).subscribe();

      ch2 = supabase.channel('pastrim-live-transport')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transport_orders' }, async (payload) => {
            if (!isPastrimRealtimePayload(payload) || shouldSkipRealtimeEvent(payload, 'transport_orders')) return;
            const row = payload?.new || payload?.old;
            if (row?.id) {
              setTimeout(() => {
                const realtimeTransportRow = { id: row.id, status: normalizeStatus(getDbTruthStatus(row)), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, table: 'transport_orders', _table: 'transport_orders' };
                saveOrderLocal(realtimeTransportRow).catch(() => {});
                if (!shouldShowTransportBridgeInPastrim(normalizeRenderableOrderRow({ ...realtimeTransportRow, source: 'transport_orders', fullOrder: row.data ?? {} }))) {
                  removePastrimTransportRowsFromLocalCaches({ ...row, source: 'transport_orders', table: 'transport_orders', _table: 'transport_orders' }, 'realtime_transport_left_pastrim');
                  setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => !pastrimRowMatchesCleanupTarget(item, { ...row, source: 'transport_orders', table: 'transport_orders', _table: 'transport_orders' })));
                } else {
                  patchPastrimRealtimeRow(row, 'transport_orders');
                }
              }, 0);
            }
            const nextStatus = normalizeStatus(getDbTruthStatus(payload?.new) || '');
            const prevStatus = normalizeStatus(getDbTruthStatus(payload?.old) || '');
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
    const nextStatus = normalizeStatus(getDbTruthStatus(payload?.new) || '');
    const prevStatus = normalizeStatus(getDbTruthStatus(payload?.old) || '');
    return isPastrimStatusValue(nextStatus) || isPastrimStatusValue(prevStatus);
  }

  function shouldSkipRealtimeEvent(payload, sourceTable = 'orders') {
    try {
      const row = payload?.new || payload?.old || {};
      const sig = [sourceTable, String(payload?.eventType || ''), String(row?.id || ''), String(row?.updated_at || row?.created_at || ''), String(normalizeStatus(getDbTruthStatus(row) || ''))].join('|');
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
      try { patchBaseMasterRow({ id: row.id, status: normalizeStatus(getDbTruthStatus(row)), data: row.data ?? null, updated_at: row.updated_at || row.created_at || new Date().toISOString(), _table: 'orders', _synced: true }); } catch {}
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
        setLocalProblemRows([]);
        updateDbTruthState({ dbFetchOk: false, dbFetchFailed: false, usingDbTruth: false, source: 'LOCAL_OFFLINE_SNAPSHOT' });
        setLocalModeNotice('LOCAL_OFFLINE_SNAPSHOT');
        setDebugInfo({ source: 'LOCAL_OFFLINE_SNAPSHOT', dbCount: 0, localCount: fallbackRows.length, dbRowsCount: 0, hiddenGhostRowsCount: 0, localProblemRowsCount: 0, lastDbFetchAt: null, online: false, lastError: null, ts: Date.now() });
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
          id: row.id, local_oid: localOid || null, status: normalizeStatus(getDbTruthStatus(row) || order?.status || 'pastrim') || 'pastrim', source: 'orders', ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
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
          id: row.id, local_oid: localOid || null, status: normalizeStatus(getDbTruthStatus(row) || order?.status || 'pastrim') || 'pastrim', source: 'transport_orders', ts: Number(order.created_at ? Date.parse(order.created_at) : (Date.parse(row.created_at) || 0)),
          name: order.client?.name || '', phone: order.client?.phone || '',
          code: normalizeCode(row.code_str || order.client?.code), m2: metrics.m2,
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: false, fullOrder
        }));
      });

      const normalizedAllOrders = (Array.isArray(allOrders) ? allOrders : []).map((row) => normalizeRenderableOrderRow(row));
      let cleanOrders = normalizedAllOrders
        .filter((row) => shouldShowTransportBridgeInPastrim(row))
        .filter((row) => row?.cope > 0 || row?.m2 > 0 || (row?.name && String(row.name).trim() !== ''))
        .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
      cleanOrders.forEach((row) => pushPastrimTrace(trace, 'db_verified_only_normal_row', row, 'keep', 'online_db_fetch_succeeded_current_db_status'));

      const streamTotal = cleanOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      const lastDbFetchAt = new Date().toISOString();
      setReadyCountHint(cleanOrders.length);
      startListTransition(() => {
        setOrders(cleanOrders);
        setStreamPastrimM2(Number(streamTotal.toFixed(2)));
      });
      setLocalProblemRows([]);
      updateDbTruthState({ dbFetchOk: true, dbFetchFailed: false, usingDbTruth: true, source: 'DB_ONLY', dbRowsCount: cleanOrders.length, dbTotalM2: Number(streamTotal.toFixed(2)), localProblemCount: 0 });
      setLocalModeNotice('DB_ONLY');
      setDebugInfo({
        source: 'DB_ONLY',
        dbCount: cleanOrders.length,
        localCount: 0,
        dbRowsCount: cleanOrders.length,
        hiddenGhostRowsCount: 0,
        localProblemRowsCount: 0,
        lastDbFetchAt,
        online: true,
        lastError: null,
        ts: Date.now(),
      });
      persistPastrimPageSnapshot(cleanOrders, { source: 'DB_ONLY', sourceMode: 'DB_ONLY', count: cleanOrders.length, streamTotal: Number(streamTotal.toFixed(2)), lastDbFetchAt });
      lastSuccessfulRefreshAt.current = Date.now();

      schedulePastrimiIdleTask(async () => {
        try {
          if (refreshSignal?.aborted) return;
          let displayDbRows = cleanOrders;

          if (exactSearchMode && /^\d+$/.test(String(openId || '').trim()) && !displayDbRows.some((row) => String(row?.id || row?.dbId || '').trim() === String(openId || '').trim())) {
            const recoveredExactRow = await recoverExactPastrimRow(openId, { skipNetwork: !isDocumentVisible() && hiddenSearchBootRef.current });
            const recoveredSource = String(recoveredExactRow?.source || '').trim();
            if (recoveredExactRow && (recoveredSource === 'orders' || recoveredSource === 'transport_orders') && shouldShowTransportBridgeInPastrim(recoveredExactRow)) {
              displayDbRows = dedupePastrimRows([recoveredExactRow, ...displayDbRows]).sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
              setExactRecoveredRow(recoveredExactRow);
              const recoveredTotal = displayDbRows.reduce((sum, row) => sum + (Number(row?.m2) || 0), 0);
              setReadyCountHint(displayDbRows.length);
              startListTransition(() => {
                setOrders(displayDbRows);
                setStreamPastrimM2(Number(recoveredTotal.toFixed(2)));
              });
              updateDbTruthState({ dbFetchOk: true, dbFetchFailed: false, usingDbTruth: true, source: 'DB_ONLY', dbRowsCount: displayDbRows.length, dbTotalM2: Number(recoveredTotal.toFixed(2)) });
              setDebugInfo((prev) => ({ ...(prev || {}), source: 'DB_ONLY', dbCount: displayDbRows.length, dbRowsCount: displayDbRows.length, lastDbFetchAt, ts: Date.now() }));
              persistPastrimPageSnapshot(displayDbRows, { source: 'DB_ONLY', sourceMode: 'DB_ONLY', count: displayDbRows.length, streamTotal: Number(recoveredTotal.toFixed(2)), lastDbFetchAt });
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

          let masterCacheRows = (readPastrimRowsFromBaseMasterCache() || []).map((row) => normalizeRenderableOrderRow(row));
          if (!Array.isArray(masterCacheRows) || masterCacheRows.length === 0) {
            try {
              const hydratedCache = await withTimeout(ensureFreshBaseMasterCache(), 1200);
              masterCacheRows = (readPastrimRowsFromBaseMasterCache(hydratedCache) || []).map((row) => normalizeRenderableOrderRow(row));
            } catch {}
          }
          const pendingOutbox = buildPendingOutboxPastrimRows();
          const localRows = await getAllOrdersLocal().catch(() => []);
          const cacheCleanup = reconcileBaseMasterCacheScope({
            statusScope: ['pastrim', 'pastrimi'],
            dbRows: normalData || [],
            localRows,
            outboxItems: typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [],
          });
          masterCacheRows = (readPastrimRowsFromBaseMasterCache(cacheCleanup?.cache) || []).map((row) => normalizeRenderableOrderRow(row));
          purgeZombieLocalArtifacts(cacheCleanup?.removedIds || []);
          if (Array.isArray(dbMirrorRows) && dbMirrorRows.length > 0) {
            try { patchBaseMasterRows(dbMirrorRows); } catch {}
          }
          scheduleDeferredLocalPersist(dbMirrorRows.slice(0, 120), 2000);
          await yieldToMainThread();

          const currentDbRows = displayDbRows;
          const currentDbTokenSet = new Set(currentDbRows.flatMap((row) => getPastrimCanonicalTokens(row)));
          const normalizedMasterCacheRows = (Array.isArray(masterCacheRows) ? masterCacheRows : []).map((row) => normalizeRenderableOrderRow(row));
          const normalizedPendingOutbox = (Array.isArray(pendingOutbox) ? pendingOutbox : []).map((row) => normalizeRenderableOrderRow(row));
          const normalizedProblemOutbox = buildOutboxProblemPastrimRows().map((row) => normalizeRenderableOrderRow(row));
          const localPastrimRows = (await readLocalOrdersByStatus('pastrim').catch(() => [])).map((row) => normalizeRenderableOrderRow({
            ...row,
            ...(row?.fullOrder ? unwrapOrderData(row.fullOrder) : {}),
            id: row?.id || row?.local_oid || '',
            source: row?.source || 'LOCAL',
          }));
          const rawLocalProblemCandidates = dedupePastrimRows([
            ...localPastrimRows,
            ...normalizedPendingOutbox,
            ...normalizedProblemOutbox,
          ])
            .filter((row) => isPastrimiLocalProblemRow(row))
            .filter((row) => isActionablePastrimiLocalProblemRow(row))
            .filter((row) => !getPastrimCanonicalTokens(row).some((token) => currentDbTokenSet.has(token)))
            .filter((row) => shouldShowTransportBridgeInPastrim(row))
            .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
          const dbResolvedLocalProblemTokenSet = await buildDbResolvedLocalProblemTokenSet(rawLocalProblemCandidates);
          const localProblemCandidates = filterResolvedPastrimiLocalProblems(rawLocalProblemCandidates.filter((row) => {
            const tokens = getPastrimDbStatusLookupTokens(row);
            const resolvedByDb = tokens.some((token) => dbResolvedLocalProblemTokenSet.has(token));
            if (resolvedByDb) {
              pushPastrimTrace(trace, 'local_problem_db_lookup', row, 'drop', 'found_in_db_any_status_resolved_by_db');
              return false;
            }
            pushPastrimTrace(trace, 'local_problem_db_lookup', row, 'keep', 'not_found_in_db_by_strong_identity');
            return true;
          }));
          const localProblemTokenSet = new Set(localProblemCandidates.flatMap((row) => getPastrimCanonicalTokens(row)));
          const hiddenGhostRowsCount = countHiddenPastrimGhostRows([
            ...normalizedMasterCacheRows,
            ...localPastrimRows,
            ...normalizedPendingOutbox,
            ...normalizedProblemOutbox,
            ...readPastrimRowsFromPageSnapshot(),
          ], currentDbTokenSet, localProblemTokenSet);

          if (refreshSignal?.aborted) return;
          if (diagEnabled) {
            try {
              if (typeof window !== 'undefined') window.__tepihaPastrimTrace = trace;
            } catch {}
            try { console.debug('[PASTRIM refreshOrders deferred local trace]', trace); } catch {}
          }
          const filteredLocalProblemCandidates = filterResolvedPastrimiLocalProblems(localProblemCandidates);
          setLocalProblemRows(filteredLocalProblemCandidates);
          updateDbTruthState({ dbFetchOk: true, dbFetchFailed: false, usingDbTruth: true, source: 'DB_ONLY', localProblemCount: filteredLocalProblemCandidates.length });
          setDebugInfo((prev) => ({
            ...(prev || {}),
            source: 'DB_ONLY',
            dbCount: currentDbRows.length,
            dbRowsCount: currentDbRows.length,
            localCount: filteredLocalProblemCandidates.length,
            hiddenGhostRowsCount,
            localProblemRowsCount: filteredLocalProblemCandidates.length,
            lastDbFetchAt,
            online: true,
            lastError: null,
            ts: Date.now(),
          }));
        } catch (deferredError) {
          try { console.warn('PASTRIMI deferred local/problem scan failed:', deferredError); } catch {}
        }
      }, 300);

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
      updateDbTruthState({ dbFetchOk: false, dbFetchFailed: true, usingDbTruth: false, source: isTimeout ? 'DB_TIMEOUT_FALLBACK' : 'DB_FAILED_FALLBACK', lastError: String(e?.message || e || '') });
      if (fallbackRows.length > 0) {
        setReadyCountHint(fallbackRows.length);
        startListTransition(() => {
          setOrders(fallbackRows);
          setStreamPastrimM2(Number(fallbackTotal.toFixed(2)));
        });
        setLocalProblemRows([]);
        const fallbackSource = isTimeout ? 'DB_TIMEOUT_FALLBACK' : 'DB_FAILED_FALLBACK';
        setLocalModeNotice(fallbackSource);
        setDebugInfo({ source: fallbackSource, dbCount: 0, localCount: fallbackRows.length, dbRowsCount: 0, hiddenGhostRowsCount: 0, localProblemRowsCount: 0, lastDbFetchAt: null, online: navigator?.onLine !== false, lastError: String(e?.message || e), ts: Date.now() });
      } else {
        setReadyCountHint(0);
        startListTransition(() => {
          setOrders([]);
          setStreamPastrimM2(0);
        });
        setLocalProblemRows([]);
        setLocalModeNotice('ERROR');
        setDebugInfo({ source: 'ERROR', dbCount: 0, localCount: 0, dbRowsCount: 0, hiddenGhostRowsCount: 0, localProblemRowsCount: 0, lastDbFetchAt: null, online: navigator?.onLine !== false, lastError: String(e?.message || e), ts: Date.now() });
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
        router.push(`/transport/pranimi?edit=${encodeURIComponent(transportEditId)}&from=pastrimi-edit&baseBridge=1`);
        return;
      }

      const payload = buildCompactPranimiEditPayload({
        source: bridgeSource,
        safeDbId,
        localOid: normalizeLocalOidValue(item?.local_oid, fetchedRow?.local_oid, ord?.local_oid, ord?.data?.local_oid, ord?.oid, safeDbId, item?.id),
        ts: Number(ord?.ts || item?.ts || Date.parse(fetchedRow?.updated_at || fetchedRow?.created_at || 0) || Date.now()),
        code: normalizeCode(fetchedRow?.code_str || ord?.code_str || ord?.order_code || ord?.order_tcode || ord?.official_order_code || item?.code || ord?.code || ord?.client?.tcode || ord?.client?.code || fetchedRow?.client_tcode || fetchedRow?.code || ''),
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
    longPressTimer.current = setTimeout(() => {
      if (isPastrimDelayReviewDue(item) && openPastrimDelayReview(item, 'open_order_long_press')) return;
      openEdit(item);
    }, 600);
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  function updatePastrimDelayReviewDraft(patch = {}) {
    setPastrimDelayReview((prev) => ({ ...(prev || {}), ...(patch || {}) }));
  }

  function openPastrimDelayReview(row, source = 'manual') {
    if (!row) return false;
    const dueInfo = getPastrimDelayReviewInfo(row);
    if (!dueInfo.due) return false;
    const money = readPastrimDelayMoney(row);
    setPastrimDelayReview({
      open: true,
      row,
      status: '',
      reason: '',
      responsible_pin: '',
      responsible_name: '',
      cash_amount: money.debt > 0 ? money.debt.toFixed(2) : '',
      incident_note: '',
      dueInfo,
      source,
    });
    setPastrimDelayReviewMsg('');
    return true;
  }

  function resolvePastrimDelayResponsible(draft = {}, fallbackActor = null) {
    const pin = String(draft?.responsible_pin || '').trim();
    const name = String(draft?.responsible_name || '').trim();
    if (pin || name) return { pin: pin || null, name: name || null };
    if (fallbackActor?.pin || fallbackActor?.name) return { pin: fallbackActor.pin || null, name: fallbackActor.name || null };
    return { pin: null, name: null };
  }

  async function findExistingPastrimDelayArkaRow(idempotencyKey) {
    const key = String(idempotencyKey || '').trim();
    if (!key) return null;
    try {
      const { data, error } = await supabase
        .from('arka_pending_payments')
        .select('*')
        .eq('idempotency_key', key)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return null;
      return Array.isArray(data) && data.length ? data[0] : null;
    } catch {
      return null;
    }
  }

  async function createPastrimDelayWorkerDebt({ orderId, amount, actor, responsible, row, note, idempotencyKey }) {
    const amt = Number(Number(amount || 0).toFixed(2));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: true, skipped: true, amount: 0 };
    const existing = await findExistingPastrimDelayArkaRow(idempotencyKey);
    if (existing?.id) return { ok: true, existing: true, row: existing, payment: existing };
    const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
    const res = await createPendingCashPayment({
      amount: amt,
      type: 'EXPENSE',
      paymentType: 'EXPENSE',
      status: 'WORKER_DEBT',
      sourceModule: 'BASE',
      note: note || `PASTRIM DELAY REVIEW BORXH • order ${orderId}`,
      workerPin: responsible?.pin || actor?.pin || null,
      workerName: responsible?.name || actor?.name || null,
      workerRole: responsible?.role || actor?.role || null,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      created_by_role: actor?.role || null,
      actorPin: actor?.pin || null,
      actorName: actor?.name || null,
      actorRole: actor?.role || null,
      orderId,
      orderCode: normalizeCode(row?.code || order?.code || order?.client?.code || ''),
      clientName: row?.name || order?.client_name || order?.client?.name || null,
      clientPhone: row?.phone || order?.client_phone || order?.client?.phone || null,
      idempotencyKey,
    });
    if (!res?.ok) throw new Error(res?.error || 'ARKA_WORKER_DEBT_FAILED');
    return res;
  }

  async function submitPastrimDelayReview() {
    if (pastrimDelayReviewBusy) return;
    const draft = pastrimDelayReview || {};
    const row = draft.row;
    const selectedStatus = String(draft.status || '').trim();
    const reason = String(draft.reason || '').trim();
    const incidentNote = String(draft.incident_note || '').trim();
    if (!row) return;
    if (!selectedStatus || !PASTRIM_DELAY_REVIEW_STATUS_LABELS[selectedStatus]) {
      setPastrimDelayReviewMsg('Zgjidhe arsyen para se me vazhdu.');
      return;
    }
    if ((selectedStatus === 'not_dry' || selectedStatus === 'other') && !reason) {
      setPastrimDelayReviewMsg('Shënimi është i detyrueshëm për këtë arsye.');
      return;
    }

    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const moneyBefore = readPastrimDelayMoney(row);
    const enteredCash = Number(String(draft.cash_amount || '').replace(',', '.')) || 0;
    if (selectedStatus === 'client_picked_up') {
      const responsibleDraft = resolvePastrimDelayResponsible(draft, null);
      if (!responsibleDraft.pin && !responsibleDraft.name) {
        setPastrimDelayReviewMsg('Zgjidhe personin që i ka pranu paret.');
        return;
      }
      if (!online) {
        setPastrimDelayReviewMsg('Ky rast kërkon ARKA record dhe duhet të kryhet online.');
        return;
      }
      if (enteredCash < 0 || enteredCash > moneyBefore.debt + 0.01) {
        setPastrimDelayReviewMsg(`Shuma e pranuar nuk mund të jetë më e madhe se borxhi (${moneyBefore.debt.toFixed(2)}€).`);
        return;
      }
      if (moneyBefore.debt > 0.01 && enteredCash < moneyBefore.debt - 0.01 && !incidentNote) {
        setPastrimDelayReviewMsg('Kur nuk regjistrohet pagesë e plotë, duhet shënim incidenti/borxhi për ARKA.');
        return;
      }
    }

    setPastrimDelayReviewBusy(true);
    setPastrimDelayReviewMsg('Duke ruajtur review...');
    try {
      const actor = await requirePaymentPin({ label: 'PIN për PASTRIM DELAY REVIEW' });
      if (!actor?.pin && !actor?.name) throw new Error('REVIEW_ACTOR_REQUIRED');
      const responsible = selectedStatus === 'client_picked_up'
        ? resolvePastrimDelayResponsible(draft, actor)
        : (selectedStatus === 'forgot_to_mark_gati' ? resolvePastrimDelayResponsible(draft, actor) : { pin: null, name: null });
      if (selectedStatus === 'client_picked_up' && !responsible.pin && !responsible.name) throw new Error('RESPONSIBLE_WORKER_REQUIRED');

      const rawId = String(row?.id || row?.dbId || '').trim();
      const numericId = /^\d+$/.test(rawId) ? Number(rawId) : null;
      if (!numericId && selectedStatus === 'client_picked_up') throw new Error('ORDER_ID_REQUIRED_FOR_ARKA');

      let fresh = null;
      if (online && numericId) {
        fresh = await fetchOrderByIdSafe('orders', numericId, 'id,local_oid,code,status,client_name,client_phone,price_total,updated_at,created_at,data', { timeoutMs: 9000 });
      }
      if (!fresh) {
        fresh = {
          ...(row || {}),
          id: rawId || row?.local_oid || row?.code || '',
          data: unwrapOrderData(row?.fullOrder || row?.data || row || {}),
          status: row?.status || unwrapOrderData(row?.fullOrder || row?.data || row || {})?.status || 'pastrim',
        };
      }

      let currentData = unwrapOrderData(fresh?.data || row?.fullOrder || row?.data || row || {});
      const currentStatus = normalizeStatus(fresh?.status || currentData?.status || row?.status || '');
      if (currentStatus !== 'pastrim' && currentStatus !== 'pastrimi') throw new Error('ORDER_NOT_IN_PASTRIM');

      const startedInfo = getPastrimDelayReviewInfo({ ...row, ...fresh, fullOrder: currentData, data: currentData });
      const now = new Date();
      const nowIso = now.toISOString();
      const nextReviewAt = (selectedStatus === 'not_dry' || selectedStatus === 'other')
        ? new Date(now.getTime() + PASTRIM_DELAY_NEXT_REVIEW_MS).toISOString()
        : null;
      let nextStatus = 'pastrim';
      if (selectedStatus === 'forgot_to_mark_gati') nextStatus = 'gati';
      if (selectedStatus === 'client_picked_up') nextStatus = 'dorzim';

      let paymentRecord = null;
      let debtRecord = null;
      let acceptedCashRecorded = 0;
      let remainingDebt = readPastrimDelayMoney({ ...row, ...fresh, fullOrder: currentData, data: currentData }).debt;

      if (selectedStatus === 'client_picked_up') {
        if (enteredCash > remainingDebt + 0.01) throw new Error(`CASH_AMOUNT_OVER_DEBT_${remainingDebt.toFixed(2)}`);
        const acceptedAmount = Number(Math.min(Math.max(0, enteredCash), remainingDebt).toFixed(2));
        acceptedCashRecorded = acceptedAmount;
        if (acceptedAmount > 0.01) {
          const payRes = await recordOrderCashPayment({
            ...(currentData || {}),
            id: numericId,
            orderId: numericId,
            code: normalizeCode(fresh?.code || currentData?.code || currentData?.client?.code || row?.code || ''),
            clientName: fresh?.client_name || currentData?.client_name || currentData?.client?.name || row?.name || '',
            clientPhone: fresh?.client_phone || currentData?.client_phone || currentData?.client?.phone || row?.phone || '',
            payment_note: `PASTRIM DELAY REVIEW • ${PASTRIM_DELAY_REVIEW_STATUS_LABELS[selectedStatus]} • pranoi: ${responsible.name || responsible.pin || ''}`,
            source: 'PASTRIM_DELAY_REVIEW',
            payment_external_id: `pastrim_delay_review_payment:${numericId}:${acceptedAmount.toFixed(2)}:${responsible.pin || responsible.name || 'worker'}`,
          }, acceptedAmount, { ...actor, pin: responsible.pin || actor.pin, name: responsible.name || actor.name, role: actor.role }, 'CASH');
          if (!payRes?.ok || !payRes?.payment) throw new Error(payRes?.error || 'ARKA_PAYMENT_REQUIRED');
          paymentRecord = payRes.payment || payRes.row || null;
          if (payRes?.order) {
            fresh = { ...fresh, ...payRes.order };
            currentData = unwrapOrderData(payRes.order?.data || currentData);
          }
        }

        remainingDebt = readPastrimDelayMoney({ ...row, ...fresh, fullOrder: currentData, data: currentData }).debt;
        if (remainingDebt > 0.01) {
          const debtKey = `pastrim_delay_review_debt:${numericId}:${remainingDebt.toFixed(2)}:${responsible.pin || responsible.name || 'worker'}`;
          debtRecord = await createPastrimDelayWorkerDebt({
            orderId: numericId,
            amount: remainingDebt,
            actor,
            responsible,
            row: { ...row, ...fresh, fullOrder: currentData, data: currentData },
            idempotencyKey: debtKey,
            note: `PASTRIM DELAY REVIEW BORXH/INCIDENT • order ${numericId} • ${incidentNote || 'klienti e ka marrë pa pagesë të plotë'} • përgjegjës: ${responsible.name || responsible.pin || ''}`,
          });
        }
      }

      const reviewEntry = {
        id: `pastrim_delay_review_${Date.now()}_${rawId || numericId || 'order'}`,
        status: selectedStatus,
        reason: reason || incidentNote || PASTRIM_DELAY_REVIEW_STATUS_LABELS[selectedStatus],
        reviewed_by_pin: actor?.pin || '',
        reviewed_by_name: actor?.name || '',
        reviewed_at: nowIso,
        next_review_at: nextReviewAt,
        responsible_worker_pin: responsible?.pin || '',
        responsible_worker_name: responsible?.name || '',
        pastrim_started_at: startedInfo.started_at || null,
        pastrim_age_days: startedInfo.age_days_exact,
        financial_record: selectedStatus === 'client_picked_up' ? {
          accepted_amount: Number(Math.max(0, acceptedCashRecorded).toFixed(2)),
          remaining_debt: Number(Math.max(0, remainingDebt).toFixed(2)),
          payment_id: paymentRecord?.id || null,
          worker_debt_id: debtRecord?.row?.id || debtRecord?.payment?.id || null,
          incident_note: incidentNote || null,
        } : null,
      };

      const nextHistory = appendPastrimDelayReviewHistory(currentData, reviewEntry);
      const incidentEntry = selectedStatus === 'client_picked_up' && Number(remainingDebt || 0) > 0.01 ? {
        id: `pastrim_delay_incident_${Date.now()}_${rawId || numericId || 'order'}`,
        type: 'PASTRIM_DELAY_CLIENT_PICKED_UP_WITH_DEBT',
        amount: Number(remainingDebt.toFixed(2)),
        note: incidentNote || 'Klienti e ka marrë / është dorëzuar pa pagesë të plotë.',
        responsible_worker_pin: responsible?.pin || '',
        responsible_worker_name: responsible?.name || '',
        arka_pending_payment_id: debtRecord?.row?.id || debtRecord?.payment?.id || null,
        created_at: nowIso,
        created_by_pin: actor?.pin || '',
        created_by_name: actor?.name || '',
      } : null;
      const nextIncidentHistory = incidentEntry
        ? [...(Array.isArray(currentData?.arka_incident_history) ? currentData.arka_incident_history : []), incidentEntry]
        : (Array.isArray(currentData?.arka_incident_history) ? currentData.arka_incident_history : []);

      const nextData = {
        ...(currentData || {}),
        status: nextStatus,
        state: nextStatus,
        pastrim_delay_started_at: startedInfo.started_at || currentData?.pastrim_delay_started_at || currentData?.pastrim_started_at || currentData?.pastrim_at || currentData?.created_at || null,
        pastrim_delay_review: reviewEntry,
        pastrim_delay_review_history: nextHistory,
        pastrim_delay_next_review_at: nextReviewAt,
        updated_at: nowIso,
      };
      if (nextStatus === 'gati') {
        nextData.ready_at = currentData?.ready_at || nowIso;
        nextData.ready_note_at = currentData?.ready_note_at || nowIso;
        nextData.ready_note_by = currentData?.ready_note_by || actor?.name || actor?.pin || '';
      }
      if (incidentEntry) {
        nextData.arka_incident = incidentEntry;
        nextData.arka_incident_history = nextIncidentHistory;
      }

      if (online && numericId) {
        await updateOrderData('orders', numericId, () => nextData, { status: nextStatus, updated_at: nowIso });
      } else {
        await queueOp('patch_order_data', { table: 'orders', id: rawId || currentData?.local_oid || currentData?.oid, status: nextStatus, data: nextData, updated_at: nowIso });
      }

      const localPatch = normalizeRenderableOrderRow({
        ...(fresh || row || {}),
        id: String(rawId || numericId || currentData?.local_oid || currentData?.oid || ''),
        local_oid: fresh?.local_oid || currentData?.local_oid || currentData?.oid || row?.local_oid || null,
        code: fresh?.code || row?.code || currentData?.code || currentData?.client?.code || '',
        name: fresh?.client_name || row?.name || currentData?.client_name || currentData?.client?.name || '',
        phone: fresh?.client_phone || row?.phone || currentData?.client_phone || currentData?.client?.phone || '',
        status: nextStatus,
        data: nextData,
        fullOrder: nextData,
        updated_at: nowIso,
        _table: 'orders',
        table: 'orders',
        _synced: online,
        _syncPending: !online,
      });
      try { await saveOrderLocal(localPatch); } catch {}
      try { patchBaseMasterRow(localPatch); } catch {}

      setOrders((prev) => {
        const rows = Array.isArray(prev) ? prev : [];
        const matchId = String(rawId || numericId || '').trim();
        if (nextStatus === 'pastrim') {
          return rows.map((item) => String(item?.id || item?.dbId || '') === matchId ? localPatch : item);
        }
        return rows.filter((item) => String(item?.id || item?.dbId || '') !== matchId);
      });
      setPastrimDelayReview({ open: false, row: null, status: '', reason: '', responsible_pin: '', responsible_name: '', cash_amount: '', incident_note: '', dueInfo: null, source: 'done' });
      setPastrimDelayReviewMsg(selectedStatus === 'forgot_to_mark_gati'
        ? 'Review u ruajt dhe porosia kaloi në GATI.'
        : selectedStatus === 'client_picked_up'
          ? 'Review u ruajt, ARKA u regjistrua dhe porosia kaloi në DORZIM.'
          : 'Review u ruajt. Porosia mbetet në PASTRIM dhe do dalë prap pas 24h.'
      );
      if (online) await refreshOrders({ force: true, source: 'pastrim_delay_review' });
    } catch (e) {
      setPastrimDelayReviewMsg(`Gabim: ${String(e?.message || e || '')}`);
    } finally {
      setPastrimDelayReviewBusy(false);
    }
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

      const orderForDb = { ...order, status: 'pastrim' };
      const { error: dbErr } = await supabase.from(orderSource).update({ status: 'pastrim', data: orderForDb, updated_at: new Date().toISOString() }).eq('id', oid);
      if (dbErr) throw dbErr;

      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function readPaketimiActorLabel(order = null) {
    const actor = readPastrimiResolveActor(order || paketimiOrder || {});
    return String(actor?.name || actor?.pin || 'PUNËTOR').trim() || 'PUNËTOR';
  }

  function applyPaketimiRowPatch(orderRow, nextData, table) {
    const targetId = String(orderRow?.id || '').trim();
    if (!targetId || !nextData) return;
    setOrders((prev) => (Array.isArray(prev) ? prev : []).map((row) => {
      if (String(row?.id || '').trim() !== targetId) return row;
      const fullOrder = { ...(row?.fullOrder && typeof row.fullOrder === 'object' ? row.fullOrder : {}), ...nextData };
      return { ...row, fullOrder, data: nextData, table: table || row?.table, _table: table || row?._table };
    }));
    try {
      if ((table || getReadyTargetTable(orderRow)) === 'orders') {
        patchBaseMasterRow({ id: targetId, status: orderRow?.status || 'pastrim', data: nextData, updated_at: new Date().toISOString(), _table: 'orders' });
      }
    } catch {}
  }

  function openPaketimiSheet(o, initialMessage = '') {
    if (o?._outboxPending) {
      alert('⏳ Kjo porosi është në pritje për internet. Paketimi ruhet vetëm pasi të sinkronizohet në DB.');
      return;
    }
    if (isLocalReadyTransitionRow(o)) {
      alert('Kjo porosi është lokale/offline. Paketimi ruhet vetëm në DB.');
      return;
    }
    const order = unwrapOrderData(o?.fullOrder || o?.data || o || {});
    const draft = mergeExistingPaketimiWithPieces(order, o);
    setPaketimiRackZone(inferPaketimiRackZone(draft?.final_rack || 'A'));
    setPaketimiOrder(o);
    setPaketimiDraft(draft);
    setPaketimiError(String(initialMessage || '').trim());
    setPaketimiNotice('');
    setPaketimiSheet(true);
  }

  function closePaketimiSheet() {
    if (paketimiBusy) return;
    setPaketimiSheet(false);
    setPaketimiOrder(null);
    setPaketimiDraft(null);
    setPaketimiError('');
    setPaketimiNotice('');
    setPaketimiRackZone('A');
  }

  function updatePaketimiDraft(updater) {
    setPaketimiDraft((prev) => {
      const base = prev && typeof prev === 'object' ? prev : { pieces: [] };
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...(updater || {}) };
      return { ...next, status: recalcPaketimiStatus(next) };
    });
  }

  function togglePaketimiPiece(pieceId) {
    const id = String(pieceId || '').trim();
    if (!id) return;
    const now = new Date().toISOString();
    const by = readPaketimiActorLabel();
    setPaketimiDraft((prev) => {
      const base = prev && typeof prev === 'object' ? prev : { pieces: [] };
      const nextPieces = (Array.isArray(base?.pieces) ? base.pieces : []).map((piece) => {
        if (String(piece?.piece_id || '').trim() !== id) return piece;
        const nextFound = !piece?.found;
        return {
          ...piece,
          found: nextFound,
          found_at: nextFound ? (piece?.found_at || now) : null,
          found_by: nextFound ? (piece?.found_by || by) : null,
        };
      });
      const next = { ...base, pieces: nextPieces };
      next.status = recalcPaketimiStatus(next);
      const nextStats = getPaketimiStats(next);
      if (nextStats.allFound) {
        setPaketimiError((current) => (/mungon/i.test(String(current || '')) ? '' : current));
        if (!next?.wrapped) setPaketimiNotice('Krejt copat janë gjetur. Tash bëje roll/paketimin.');
      }
      return next;
    });
  }

  async function persistPaketimi(nextDraft, opts = {}) {
    if (!paketimiOrder || paketimiBusy) return null;
    if (isLocalReadyTransitionRow(paketimiOrder)) throw new Error('LOCAL_ORDER_NOT_SUPPORTED_FOR_PAKETIMI');
    const table = getReadyTargetTable(paketimiOrder);
    const now = new Date().toISOString();
    const by = readPaketimiActorLabel(paketimiOrder);
    const cleanDraft = {
      ...(nextDraft && typeof nextDraft === 'object' ? nextDraft : {}),
      found_location_note: String(nextDraft?.found_location_note || '').trim(),
      final_rack: normalizePaketimiFinalRack(nextDraft?.final_rack),
      updated_at: now,
      updated_by: by,
      pieces: (Array.isArray(nextDraft?.pieces) ? nextDraft.pieces : []).map((piece) => ({
        piece_id: String(piece?.piece_id || '').trim(),
        type: ['tepih', 'staza', 'shkallore'].includes(String(piece?.type || '').trim()) ? String(piece.type).trim() : 'tepih',
        label: String(piece?.label || '').trim(),
        m2: Number(piece?.m2) || 0,
        qty_index: Number(piece?.qty_index) || 0,
        found: !!piece?.found,
        found_at: piece?.found ? (piece?.found_at || now) : null,
        found_by: piece?.found ? (piece?.found_by || by) : null,
      })),
    };
    cleanDraft.status = String(opts?.forceStatus || recalcPaketimiStatus(cleanDraft)).trim() || 'not_started';

    setPaketimiBusy(true);
    setPaketimiError('');
    let savedData = null;
    try {
      await updateOrderData(table, paketimiOrder.id, (oldData) => {
        const safeOld = unwrapOrderData(oldData || {});
        savedData = { ...safeOld, paketimi_v1: cleanDraft };
        return savedData;
      }, { updated_at: now });
      setPaketimiDraft(cleanDraft);
      applyPaketimiRowPatch(paketimiOrder, savedData, table);
      return { paketimi: cleanDraft, data: savedData, table };
    } catch (e) {
      const msg = String(e?.message || e || 'Gabim gjatë ruajtjes së paketimit');
      setPaketimiError(msg);
      throw e;
    } finally {
      setPaketimiBusy(false);
    }
  }

  async function savePaketimiGrouping() {
    const draft = paketimiDraft && typeof paketimiDraft === 'object' ? paketimiDraft : null;
    if (!draft) return;
    const stats = getPaketimiStats(draft);
    if (stats.someFound && !stats.allFound && !String(draft?.found_location_note || '').trim()) {
      const msg = 'Shkruaj ku i le copët e gjetura para se me ruajt paketimin partial.';
      setPaketimiError(msg);
      return;
    }
    try {
      const next = { ...draft };
      next.status = recalcPaketimiStatus(next);
      await persistPaketimi(next);
      closePaketimiSheet();
    } catch (e) {
      alert('❌ Nuk u ruajt paketimi: ' + String(e?.message || e || 'UNKNOWN_ERROR'));
    }
  }

  async function markPaketimiWrapped() {
    const draft = paketimiDraft && typeof paketimiDraft === 'object' ? paketimiDraft : null;
    if (!draft) return;
    const stats = getPaketimiStats(draft);
    if (!stats.allFound) {
      const msg = buildPaketimiMissingMessage(draft, 'Nuk mund të bëhet roll.');
      setPaketimiError(msg);
      alert(msg);
      return;
    }
    const now = new Date().toISOString();
    const by = readPaketimiActorLabel();
    try {
      const next = { ...draft, wrapped: true, wrapped_at: now, wrapped_by: by, status: 'wrapped_ready_for_rack' };
      await persistPaketimi(next, { forceStatus: 'wrapped_ready_for_rack' });
      setPaketimiError('');
      setPaketimiNotice('Shkruaj raftin/lokacionin final.');
      try { window.setTimeout(() => paketimiRackInputRef.current?.focus?.(), 80); } catch {}
    } catch (e) {
      alert('❌ Nuk u ruajt roll/paketimi: ' + String(e?.message || e || 'UNKNOWN_ERROR'));
    }
  }

  async function paketimiMakeReady() {
    const draft = paketimiDraft && typeof paketimiDraft === 'object' ? paketimiDraft : null;
    if (!draft || !paketimiOrder) return;
    const stats = getPaketimiStats(draft);
    const rack = normalizePaketimiFinalRack(draft?.final_rack);
    if (!stats.allFound) {
      const msg = buildPaketimiMissingMessage(draft, 'Nuk mund të bëhet GATI.');
      setPaketimiError(msg);
      return;
    }
    if (!draft?.wrapped) {
      const msg = 'Nuk mund të bëhet GATI. Duhet me u paketuar / roll së pari.';
      setPaketimiError(msg);
      return;
    }
    const rackSlots = normalizeRackSlots(rack);
    if (!rack || !hasConcreteRackLocation(rack) || !rackSlots.length) {
      const msg = buildConcreteRackRequiredMessage('Nuk mund të bëhet GATI.');
      setPaketimiError(msg);
      return;
    }
    const rackLabel = formatConcreteRackSlots(rackSlots);
    try {
      const next = { ...draft, final_rack: rackLabel, found_location_note: '', status: 'final_ready' };
      await persistPaketimi(next, { forceStatus: 'final_ready' });
      setPaketimiSheet(false);
      setPaketimiOrder(null);
      setPaketimiDraft(null);
      await handleMarkReady(paketimiOrder, { readyNote: '', readySlots: rackSlots });
    } catch (e) {
      alert('❌ Nuk u bë GATI. Order-i mbeti në PASTRIMI: ' + String(e?.message || e || 'UNKNOWN_ERROR'));
    }
  }

  function openPaketimiSms() {
    const draft = paketimiDraft && typeof paketimiDraft === 'object' ? paketimiDraft : null;
    if (!draft || !paketimiOrder) return;
    if (!isPaketimiReadyForSms(draft)) {
      const msg = buildPaketimiMissingMessage(draft, 'SMS nuk lejohet.');
      setPaketimiError(msg);
      alert(msg);
      return;
    }
    const smsOrder = { ...(paketimiOrder || {}), fullOrder: { ...(paketimiOrder?.fullOrder || {}), paketimi_v1: draft } };
    const resolvedPhone = String(
      smsOrder?.client_phone ||
      smsOrder?.data?.client_phone ||
      smsOrder?.client?.phone ||
      smsOrder?.data?.client?.phone ||
      smsOrder?.phone ||
      smsOrder?.fullOrder?.client_phone ||
      smsOrder?.fullOrder?.client?.phone ||
      ''
    ).trim();
    if (!resolvedPhone) {
      alert('Nuk ka numër telefoni për SMS.');
      return;
    }
    const text = buildSmartSmsText(smsOrder, 'gati_baze');
    setSmsModal({ open: true, phone: resolvedPhone, text });
  }

  function getExistingPaketimiBlock(o) {
    const existing = getOrderPaketimi(o);
    if (!existing) return '';
    const paketimi = mergeExistingPaketimiWithPieces(o?.fullOrder || o?.data || o || {}, o);
    if (isPaketimiReadyForSms(paketimi)) return '';
    return buildPaketimiMissingMessage(paketimi, 'SMS/GATI nuk lejohet.');
  }

  function getPaketimiReadyGate(o) {
    const existing = getOrderPaketimi(o);
    if (!existing) {
      return { allowed: false, message: 'Fillimisht bëje PAKETIMIN / GRUMBULLIMIN.' };
    }
    const paketimi = mergeExistingPaketimiWithPieces(o?.fullOrder || o?.data || o || {}, o);
    if (isPaketimiReadyForSms(paketimi)) return { allowed: true, message: '' };
    return { allowed: false, message: buildPaketimiMissingMessage(paketimi, 'SMS/GATI nuk lejohet.') };
  }

  function openReadyPlaceSheet(o) {
    if (isPastrimDelayReviewDue(o) && openPastrimDelayReview(o, 'open_order_ready_flow')) return;
    const paketimiGate = getPaketimiReadyGate(o);
    if (!paketimiGate.allowed) {
      openPaketimiSheet(o, paketimiGate.message);
      return;
    }
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
    const nextSlots = normalizeRackSlots([picked]);
    if (!nextSlots.length) {
      alert(buildConcreteRackRequiredMessage('Nuk mund të bëhet GATI.'));
      return;
    }
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
    const resolvedReadySlots = normalizeRackSlots(Array.isArray(opts?.readySlots) ? opts.readySlots : []);
    const resolvedReadyText = String(opts?.readyNote || '').trim();
    if (!resolvedReadySlots.length) {
      const msg = buildConcreteRackRequiredMessage('Nuk mund të bëhet GATI.');
      alert(msg);
      if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }
      return;
    }
    const resolvedReadySlotText = formatConcreteRackSlots(resolvedReadySlots);
    const resolvedReadyNote = resolvedReadyText && resolvedReadyText !== resolvedReadySlotText
      ? `📍 [${resolvedReadySlotText}] ${resolvedReadyText}`.trim()
      : `📍 [${resolvedReadySlotText}]`;
    const existingOrder = mergeReadyMetaIntoOrder(o?.fullOrder || {}, o || {});
    const existingLocalOid = normalizeLocalOidValue(o?.local_oid, existingOrder?.local_oid, existingOrder?.oid);
    const readyDataPatch = {
      ...(resolvedReadyNote ? { ready_note: resolvedReadyNote } : {}),
      ready_note_text: resolvedReadyText,
      ready_location: resolvedReadySlotText,
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

  function askPastrimiPaidPickupTarget({ code: orderCode = '', clientName = '' } = {}) {
    const label = [orderCode ? `KODI: ${orderCode}` : '', clientName ? `KLIENTI: ${clientName}` : ''].filter(Boolean).join(' • ');
    const question = `${label ? `${label}\n\n` : ''}KLIENTI A PO I MERR TEPIHAT TASH?\n\nOK / PO = regjistro pagesën dhe kalo direkt në DORZIM.\nCancel / JO = regjistro pagesën, por lëje në PASTRIMI si të paguar.`;
    try {
      return window.confirm(question) ? 'dorzim' : 'pastrim';
    } catch {
      return 'pastrim';
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
    const willSettleFull = remaining <= 0.01;
    const fullPaymentTargetStatus = willSettleFull
      ? askPastrimiPaidPickupTarget({ code: normalizeCode(codeRaw), clientName: name.trim() })
      : '';
    const destinationLine = willSettleFull
      ? (fullPaymentTargetStatus === 'dorzim'
        ? 'VEPRIMI: KLIENTI I MERR — KALO NË DORZIM'
        : 'VEPRIMI: PAGUAR — MBETET NË PASTRIMI')
      : 'VEPRIMI: PAGESË PARTIALE — MBETET STATUSI AKTUAL';

    const pinLabel = `PAGESË: ${applied.toFixed(2)}€
KLIENTI DHA: ${cashGiven.toFixed(2)}€
KUSURI (RESTO): ${kusuri.toFixed(2)}€
BORXHI PAS: ${remaining.toFixed(2)}€
${destinationLine}

👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;

    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    try {
      if (payMethod === 'CASH') {
        const payRes = await recordOrderCashPayment({
          orderId: oid,
          code: normalizeCode(codeRaw),
          clientName: name.trim(),
          clientPhone: normalizePastrimiResolverPhone(phone) || `${phonePrefix}${phone}`,
          amount: applied,
          note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()} • ${fullPaymentTargetStatus === 'dorzim' ? 'CLIENT_PICKED_UP_TO_DORZIM' : 'PAID_STAYS_PASTRIMI'}`,
          source: 'PASTRIMI_EDIT_PAY',
          payMethod: 'CASH',
          user: pinData,
          rawOrder: {
            id: oid,
            status: fullPaymentTargetStatus || 'pastrim',
            code: normalizeCode(codeRaw),
            client_name: name.trim(),
            client_phone: normalizePastrimiResolverPhone(phone) || `${phonePrefix}${phone}`,
            price_total: Number(totalEuro || 0) || 0,
          },
          ...(fullPaymentTargetStatus ? { statusOnFullPayment: fullPaymentTargetStatus } : {}),
        });
        if (!payRes?.ok || !payRes?.payment || !payRes?.order) throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');
        const pay = payRes?.order?.data?.pay || {};
        setClientPaid(Number(pay.paid ?? payRes?.order?.data?.clientPaid ?? (Number(clientPaid || 0) + applied)) || 0);
        setArkaRecordedPaid(Number(pay.arkaRecordedPaid ?? (Number(arkaRecordedPaid || 0) + applied)) || 0);
      }
      setShowPaySheet(false);
    } catch (e) {
      alert(`❌ PAGESA NUK U KRYE: ${e?.message || 'PROVO PËRSËRI.'}`);
    }
  }


  async function openRowPay(row) {
    if (!row || row._outboxPending) {
      alert('KJO POROSI ËSHTË NË PRITJE PËR INTERNET. PROVO PËRSËRI PAK MË VONË.');
      return;
    }
    if (isPastrimTransportScopedRow(row)) {
      alert('PAGESA E TRANSPORTIT KRYHET TE TRANSPORT/ARKA, JO TE PASTRIMI BAZË.');
      return;
    }
    if (isPastrimDelayReviewDue(row) && openPastrimDelayReview(row, 'open_order_payment_flow')) return;

    try {
      const rawId = row?.db_id ?? row?.id ?? row?.fullOrder?.db_id ?? row?.fullOrder?.id ?? null;
      const orderId = typeof rawId === 'number' ? rawId : (/^\d+$/.test(String(rawId || '').trim()) ? Number(String(rawId).trim()) : null);
      if (!orderId) {
        alert('NUK U GJET ID E POROSISË PËR PAGESË.');
        return;
      }

      let dbRow = null;
      try {
        dbRow = await withTimeout(
          fetchOrderByIdSafe('orders', orderId, 'id,local_oid,status,created_at,updated_at,data,code,client_name,client_phone,price_total'),
          2600
        );
      } catch {}

      let localShadow = null;
      try {
        const raw = localStorage.getItem(`order_${orderId}`) || localStorage.getItem(`order_${row?.local_oid || ''}`);
        if (raw) localShadow = JSON.parse(raw);
      } catch {}

      const baseOrder = mergePastrimEditOrderForBridge(
        { ...(row || {}), fullOrder: localShadow || row?.fullOrder || row?.data || {} },
        dbRow
      );
      const safeCode = normalizeCode(baseOrder?.code || row?.code || dbRow?.code || baseOrder?.client?.code || '');
      const existingPay = (baseOrder?.pay && typeof baseOrder.pay === 'object') ? baseOrder.pay : {};
      const total = Number(computeOrderDisplayTotal({ ...baseOrder, total: row?.total, price_total: dbRow?.price_total }) || existingPay?.euro || row?.total || 0) || 0;
      const paid = Number(existingPay?.paid ?? baseOrder?.clientPaid ?? row?.paid ?? 0) || 0;
      const dueNow = Math.max(0, Number((total - paid).toFixed(2)));

      setRowPayOrder({
        id: String(orderId),
        order: baseOrder,
        code: safeCode,
        name: baseOrder?.client?.name || baseOrder?.client_name || row?.name || dbRow?.client_name || '',
        phone: baseOrder?.client?.phone || baseOrder?.client_phone || row?.phone || dbRow?.client_phone || '',
        total,
        paid,
        paidUpfront: !!existingPay?.paidUpfront,
      });
      setRowPayAmount(dueNow);
      setRowPaySheet(true);
    } catch {
      alert('❌ GABIM GJATË HAPJES SË PAGESËS.');
    }
  }

  function closeRowPay() {
    if (rowPayBusy) return;
    setRowPaySheet(false);
    setRowPayOrder(null);
    setRowPayAmount(0);
  }

  async function applyRowPayAndClose() {
    if (!rowPayOrder || rowPayBusy) return;

    const cashGiven = Number((Number(rowPayAmount) || 0).toFixed(2));
    const due = Math.max(0, Number((Number(rowPayOrder.total || 0) - Number(rowPayOrder.paid || 0)).toFixed(2)));
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
    const willSettleFull = remaining <= 0.01;
    const fullPaymentTargetStatus = willSettleFull
      ? askPastrimiPaidPickupTarget({ code: rowPayOrder.code, clientName: rowPayOrder.name })
      : '';
    const destinationLine = willSettleFull
      ? (fullPaymentTargetStatus === 'dorzim'
        ? 'VEPRIMI: KLIENTI I MERR — KALO NË DORZIM'
        : 'VEPRIMI: PAGUAR — MBETET NË PASTRIMI')
      : 'VEPRIMI: PAGESË PARTIALE — MBETET STATUSI AKTUAL';

    const pinLabel = `PAGESË NË PASTRIMI\nKODI: ${rowPayOrder.code}\n\nPAGESË SOT: ${applied.toFixed(2)}€\nKLIENTI DHA: ${cashGiven.toFixed(2)}€\nKUSURI: ${kusuri.toFixed(2)}€\nBORXHI PAS: ${remaining.toFixed(2)}€\n${destinationLine}\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    const actionAt = new Date().toISOString();
    const newPaid = Number((Number(rowPayOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(rowPayOrder.total || 0) - newPaid).toFixed(2)));
    const baseOrder = rowPayOrder.order || {};
    const existingPay = (baseOrder?.pay && typeof baseOrder.pay === 'object') ? baseOrder.pay : {};
    const nextOrder = {
      ...baseOrder,
      id: String(rowPayOrder.id || baseOrder?.id || ''),
      status: normalizeStatus(baseOrder?.status || 'pastrim') || 'pastrim',
      code: rowPayOrder.code || baseOrder?.code || '',
      client_name: baseOrder?.client_name || baseOrder?.client?.name || rowPayOrder.name || '',
      client_phone: baseOrder?.client_phone || baseOrder?.client?.phone || rowPayOrder.phone || '',
      price_total: Number(baseOrder?.price_total ?? existingPay?.euro ?? rowPayOrder.total ?? 0) || 0,
      paid_cash: newPaid,
      pay: {
        ...existingPay,
        euro: Number(existingPay?.euro ?? rowPayOrder.total ?? 0) || 0,
        paid: newPaid,
        debt: newDebt,
        arkaRecordedPaid: Number((Number(existingPay?.arkaRecordedPaid || 0) + applied).toFixed(2)),
        method: 'CASH',
        paidUpfront: !!existingPay?.paidUpfront,
      },
      clientPaid: newPaid,
      paid: newPaid,
      debt: newDebt,
      isPaid: newDebt <= 0,
      updated_at: actionAt,
    };
    if (!nextOrder.client || typeof nextOrder.client !== 'object') nextOrder.client = {};
    nextOrder.client = {
      ...nextOrder.client,
      name: nextOrder.client?.name || nextOrder.client_name || rowPayOrder.name || '',
      phone: nextOrder.client?.phone || nextOrder.client_phone || rowPayOrder.phone || '',
      code: nextOrder.client?.code || rowPayOrder.code || '',
    };

    setRowPayBusy(true);
    try {
      const payRes = await recordOrderCashPayment({
        rawOrder: {
          ...nextOrder,
          status: fullPaymentTargetStatus || nextOrder.status || 'pastrim',
        },
        orderId: rowPayOrder.id,
        code: rowPayOrder.code,
        clientName: rowPayOrder.name,
        clientPhone: rowPayOrder.phone,
        amount: applied,
        note: `PAGESË NË PASTRIMI ${applied.toFixed(2)}€ • #${rowPayOrder.code} • ${rowPayOrder.name || ''} • ${fullPaymentTargetStatus === 'dorzim' ? 'CLIENT_PICKED_UP_TO_DORZIM' : 'PAID_STAYS_PASTRIMI'}`,
        source: 'PASTRIMI_ROW_PAY',
        payMethod: 'CASH',
        user: pinData,
        ...(fullPaymentTargetStatus ? { statusOnFullPayment: fullPaymentTargetStatus } : {}),
      });
      if (!payRes?.ok || !payRes?.payment || !payRes?.order) throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');
      const engineOrder = payRes.order;
      const engineData = engineOrder?.data || nextOrder;
      const enginePay = engineData?.pay || {};
      const enginePaid = Number(enginePay.paid ?? engineData.clientPaid ?? newPaid) || newPaid;
      const engineDebt = Number(enginePay.debt ?? engineData.debt ?? newDebt) || 0;
      const engineStatus = engineOrder?.status || engineData?.status || nextOrder.status;
      const localOrder = { ...nextOrder, ...engineData, status: engineStatus, pay: { ...nextOrder.pay, ...enginePay } };
      try { await saveOrderLocal({ id: String(rowPayOrder.id), status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, _table: 'orders', _synced: true }); } catch {}
      try { patchBaseMasterRow({ id: rowPayOrder.id, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, paid_amount: enginePaid, price_total: localOrder.price_total, _table: 'orders' }); } catch {}
      try { localStorage.setItem(`order_${rowPayOrder.id}`, JSON.stringify(localOrder)); } catch {}

      setOrders((prev) => (prev || []).map((o) => String(o?.id) === String(rowPayOrder.id)
        ? { ...o, paid: enginePaid, isPaid: engineDebt <= 0, total: Number(rowPayOrder.total || o?.total || 0), fullOrder: localOrder }
        : o
      ));
      setRowPaySheet(false);
      setRowPayOrder(null);
      setRowPayAmount(0);
      alert('✅ PAGESA U REGJISTRUA.');
    } catch (err) {
      alert(`❌ PAGESA NUK U KRYE: ${err?.message || 'PROVO PËRSËRI.'}`);
    } finally {
      setRowPayBusy(false);
    }
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
    const phoneQuery = rawSearch.replace(/\D+/g, '');

    return list.filter((o) => {
      const name = String(o?.name || '').toLowerCase();
      const code = normalizeCode(o?.code || '');
      if (name.includes(s) || code.includes(scode)) return true;
      // Client-side phone match only (no DB query change).
      if (phoneQuery) {
        const phoneDigits = String(
          o?.phone || o?.client_phone || o?.fullOrder?.client_phone || o?.data?.client_phone || ''
        ).replace(/\D+/g, '');
        if (phoneDigits && phoneDigits.includes(phoneQuery)) return true;
      }
      return false;
    });
  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, deferredSearch]);

  const pastrimDelayReviewSummary = useMemo(() => {
    const due = [];
    const soft = [];
    const warnings = [];
    for (const row of Array.isArray(orders) ? orders : []) {
      if (!shouldShowTransportBridgeInPastrim(row)) continue;
      const info = getPastrimDelayReviewInfo(row);
      if (!info.warning) continue;
      const item = { ...row, pastrim_delay_info: info };
      warnings.push(item);
      if (info.due) due.push(item);
      else if (info.softWarning) soft.push(item);
    }
    const totalM2 = warnings.reduce((sum, row) => sum + (Number(row?.m2) || 0), 0);
    return {
      count: warnings.length,
      dueCount: due.length,
      softCount: soft.length,
      due,
      soft,
      warnings,
      totalM2: Number(totalM2.toFixed(2)),
    };
  }, [orders]);

  // UI-only: counts for the quick-filter chips. Derived from the already-visible
  // list. No DB query, no status change.
  const pastrimFilterCounts = useMemo(() => {
    const list = Array.isArray(visibleOrders) ? visibleOrders : [];
    const counts = { all: list.length, over4: 0, unpacked: 0, debt: 0, snooze: 0, due: 0 };
    for (const row of list) {
      const info = getPastrimDelayReviewInfo(row);
      if (info.warning) counts.over4 += 1;
      if (info.due) counts.due += 1;
      if (info.softWarning) counts.snooze += 1;
      if (getPaketimiBadge(row)?.tone === 'empty') counts.unpacked += 1;
      if (pastrimRowHasDebt(row)) counts.debt += 1;
    }
    return counts;
  }, [visibleOrders]);

  // UI-only: the list actually rendered, after applying the quick-filter chip.
  // Filters client-side on top of visibleOrders so the fetched list, search and
  // exact-open logic stay exactly as before.
  const displayOrders = useMemo(() => {
    const list = Array.isArray(visibleOrders) ? visibleOrders : [];
    if (!pastrimFilter || pastrimFilter === 'all') return list;
    return list.filter((row) => matchesPastrimFilter(row, pastrimFilter));
  }, [visibleOrders, pastrimFilter]);

  const PASTRIM_FILTER_CHIPS = [
    { key: 'all', label: 'Të gjitha' },
    { key: 'over4', label: 'Mbi 4 ditë' },
    { key: 'unpacked', label: 'Pa paketu' },
    { key: 'debt', label: 'Me borxh' },
    { key: 'snooze', label: 'Snooze' },
    { key: 'due', label: 'Due tani' },
  ];

  function openFirstPastrimDelayReview() {
    const row = Array.isArray(pastrimDelayReviewSummary?.due) ? pastrimDelayReviewSummary.due[0] : null;
    if (!row) {
      setPastrimDelayReviewMsg('Nuk ka PASTRIM DELAY REVIEW për momentin.');
      return;
    }
    openPastrimDelayReview(row, 'manual_delay_review_panel');
  }

  const headerPastrimM2 = useMemo(() => {
    const list = (Array.isArray(orders) ? orders : []).filter((row) => shouldShowTransportBridgeInPastrim(row));
    const total = list.reduce((sum, row) => sum + (Number(row?.m2) || 0), 0);
    return Number(total.toFixed(2));
  }, [orders]);

  const streamPct = Math.min(100, (Number(headerPastrimM2 || streamPastrimM2 || 0) / STREAM_MAX_M2) * 100);
  const pastrimiNoticeSource = String(debugInfo?.source || localModeNotice || '');
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const hasDbVerifiedSource = /DB_ONLY|DB_VERIFIED_ONLY|DB_VERIFIED|SYNC|REMOTE|SUPABASE/i.test(pastrimiNoticeSource)
    || (!!debugInfo?.lastDbFetchAt && !/LOCAL_|ERROR|FALLBACK|FAILED|TIMEOUT/i.test(pastrimiNoticeSource));
  const visibleRowsAreDbRows = Array.isArray(visibleOrders)
    && visibleOrders.length > 0
    && visibleOrders.every((row) => {
      const src = String(row?.source || row?._table || '').trim();
      return src === 'orders' || src === 'transport_orders';
    });
  const normalListIsDbVerified = !!dbTruthState?.usingDbTruth || hasDbVerifiedSource || visibleRowsAreDbRows;
  const hasRealFetchProblem = browserOffline
    || ((/LOCAL_OFFLINE|LOCAL_FALLBACK|ERROR/i.test(pastrimiNoticeSource) || !!debugInfo?.lastError) && !normalListIsDbVerified);
  const pastrimiSourceBadge = hasRealFetchProblem ? 'LOCAL' : 'SYNC / DB';
  const showCacheWarning = hasRealFetchProblem;
  const showPastrimiDebugUi = shouldShowPastrimiDebugUi();
  const visibleLocalProblemRows = useMemo(() => filterResolvedPastrimiLocalProblems((Array.isArray(localProblemRows) ? localProblemRows : []).filter((row) => isActionablePastrimiLocalProblemRow(row))), [localProblemRows, resolvedLocalProblemVersion]);
  const debugCounterText = `SOURCE: ${dbTruthState?.usingDbTruth ? 'DB_ONLY' : String(debugInfo?.source || localModeNotice || '—')} • DB: ${Number(debugInfo?.dbRowsCount ?? debugInfo?.dbCount ?? 0)} • DB M²: ${Number(headerPastrimM2 || 0).toFixed(2)} • LOCAL PROBLEM: ${Number(debugInfo?.localProblemRowsCount || 0)} • FLAGS: dbFetchOk=${dbTruthState?.dbFetchOk ? '1' : '0'} dbFetchFailed=${dbTruthState?.dbFetchFailed ? '1' : '0'} usingDbTruth=${dbTruthState?.usingDbTruth ? '1' : '0'}${debugInfo?.lastDbFetchAt ? ` • DB FETCH: ${String(debugInfo.lastDbFetchAt).slice(11, 19)}` : ''}`;

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 className="title" style={{ margin: 0 }}>PASTRIMI</h1>
          <span
            aria-label={`Burimi i të dhënave: ${pastrimiSourceBadge}`}
            title={pastrimiSourceBadge === 'LOCAL' ? 'TË DHËNA LOKALE' : 'SYNC / DB'}
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
        <div className="cap-value">{Number(headerPastrimM2 || streamPastrimM2 || 0).toFixed(1)}</div>
        <div className="cap-bar"><div className="cap-fill" style={{ width: `${streamPct}%` }} /></div>
        <div className="cap-row"><span>0 m²</span><span>MAX: {STREAM_MAX_M2} m²</span></div>
        {showPastrimiDebugUi ? (
          <div style={{ marginTop: 8, fontSize: 10, fontWeight: 900, color: 'rgba(226,232,240,.72)', letterSpacing: '.03em' }}>{debugCounterText}</div>
        ) : null}
      </section>

      {(() => {
        const dueCount = pastrimDelayReviewSummary.dueCount;
        const softCount = pastrimDelayReviewSummary.softCount;
        const totalCount = pastrimDelayReviewSummary.count;
        const riskM2 = Number(pastrimDelayReviewSummary.totalM2 || 0).toFixed(1);
        const hot = dueCount > 0;
        return (
          <section
            className="card"
            style={{
              padding: '9px 11px',
              marginBottom: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              border: hot ? '1px solid rgba(239,68,68,.55)' : '1px solid rgba(148,163,184,.20)',
              background: hot ? 'rgba(127,29,29,.22)' : 'rgba(15,23,42,.45)',
              boxShadow: hot ? '0 10px 30px rgba(127,29,29,.30)' : '0 8px 24px rgba(1,5,20,.55)',
              opacity: hot ? 1 : 0.92,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 1000, letterSpacing: '.06em', color: hot ? '#fecaca' : 'rgba(226,232,240,.66)' }}>
                ALERTE PËR REVIEW
              </div>
              <div style={{ marginTop: 3, fontSize: 12, fontWeight: 800, color: hot ? '#fee2e2' : 'rgba(226,232,240,.78)', lineHeight: 1.3 }}>
                Për sot: <b style={{ color: hot ? '#fff' : '#e2e8f0' }}>{dueCount}</b>
                {' • '}Snooze 24h: <b>{softCount}</b>
                {' • '}M² në risk: <b>{riskM2}</b>
              </div>
            </div>
            <button
              type="button"
              disabled={pastrimDelayReviewBusy || dueCount === 0}
              onClick={openFirstPastrimDelayReview}
              style={{
                flexShrink: 0,
                padding: hot ? '10px 14px' : '7px 11px',
                borderRadius: 10,
                fontWeight: 1000,
                fontSize: hot ? 12.5 : 11,
                letterSpacing: '.02em',
                cursor: dueCount === 0 ? 'default' : 'pointer',
                color: hot ? '#fff' : 'rgba(226,232,240,.62)',
                background: hot ? 'rgba(239,68,68,.92)' : 'rgba(30,41,59,.65)',
                border: hot ? '1px solid rgba(248,113,113,.9)' : '1px solid rgba(148,163,184,.22)',
                boxShadow: hot ? '0 8px 22px rgba(239,68,68,.45)' : 'none',
                opacity: dueCount === 0 ? 0.7 : 1,
              }}
            >{pastrimDelayReviewBusy ? 'DUKE RUAJTUR...' : `HAP REVIEW (${hot ? dueCount : totalCount})`}</button>
            {pastrimDelayReviewMsg ? (
              <div style={{ width: '100%', fontSize: 11, fontWeight: 900, color: pastrimDelayReviewMsg.startsWith('Gabim') ? '#fecaca' : (hot ? '#fef3c7' : 'rgba(226,232,240,.72)') }}>{pastrimDelayReviewMsg}</div>
            ) : null}
          </section>
        );
      })()}

      {showCacheWarning ? (
        <section className="card" style={{ padding: 10, border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.10)', color: '#fde68a', fontSize: 12, fontWeight: 900 }}>
          OFFLINE / CACHE — LISTA MUND TË JETË E VJETËR
        </section>
      ) : null}

      {visibleLocalProblemRows.length > 0 ? (
        <section
          className="card"
          style={{
            padding: 9,
            border: '1px solid rgba(239,68,68,.40)',
            background: 'rgba(127,29,29,.20)',
            marginBottom: 10,
            overflowX: 'hidden',
            minWidth: 0,
            maxWidth: '100%',
            wordBreak: 'break-word',
          }}
        >
          <button
            type="button"
            onClick={() => setLocalProblemOpen((v) => !v)}
            style={{ width: '100%', border: 0, background: 'transparent', color: '#fecaca', fontWeight: 1000, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 0, minWidth: 0 }}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>LOCAL / NOT SYNCED — {visibleLocalProblemRows.length}</span>
            <span style={{ flexShrink: 0 }}>{localProblemOpen ? 'MBYLLE' : 'HAPE'}</span>
          </button>
          {localProblemOpen ? visibleLocalProblemRows.slice(0, 8).map((row) => {
            const info = getPastrimProblemIdentity(row);
            const key = buildPastrimiProblemKey(row);
            const state = problemResolverState?.[key] || {};
            const scan = state?.scan || null;
            const canInsert = scan?.resolver_state === 'SAFE_TO_INSERT' && !state?.inserting;
            const labelCode = info.code && info.code !== '0' ? info.code : '—';
            const labelName = info.name && !isPlaceholderPastrimName(info.name) ? info.name : 'Pa Emër';
            const shortError = String(row?._syncError || row?.lastError || row?.status || 'LOCAL / NOT SYNCED').replace(/\s+/g, ' ').trim();
            const scanBadge = String(scan?.resolver_state || (state?.error ? 'NEEDS_ADMIN' : '') || '').trim();
            const scanTone = scan?.resolver_state === 'SAFE_TO_INSERT'
              ? { border: 'rgba(34,197,94,.45)', bg: 'rgba(20,83,45,.25)', color: '#bbf7d0' }
              : scan?.resolver_state === 'ALREADY_IN_DB'
                ? { border: 'rgba(96,165,250,.45)', bg: 'rgba(30,64,175,.22)', color: '#bfdbfe' }
                : scan?.resolver_state
                  ? { border: 'rgba(251,191,36,.45)', bg: 'rgba(120,53,15,.25)', color: '#fde68a' }
                  : { border: 'rgba(252,165,165,.35)', bg: 'rgba(127,29,29,.20)', color: '#fecaca' };
            const buttonBaseStyle = {
              width: '100%',
              minWidth: 0,
              borderRadius: 8,
              padding: '7px 6px',
              fontSize: 9,
              lineHeight: 1.1,
              fontWeight: 1000,
              textAlign: 'center',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
            };
            return (
              <div
                key={`problem-${info.outboxOpId || info.localOid || row?.id || row?.code}`}
                style={{
                  marginTop: 8,
                  padding: 9,
                  border: '1px solid rgba(255,255,255,.10)',
                  background: 'rgba(15,23,42,.32)',
                  borderRadius: 12,
                  fontSize: 12,
                  minWidth: 0,
                  maxWidth: '100%',
                  overflowX: 'hidden',
                  wordBreak: 'break-word',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#fff', fontWeight: 1000, lineHeight: 1.25, fontSize: 13, overflowWrap: 'anywhere' }}>
                    {labelCode} • {labelName}
                  </div>
                  <div style={{ marginTop: 3, color: '#fecaca', fontSize: 10, fontWeight: 900, lineHeight: 1.3, overflowWrap: 'anywhere' }}>
                    pastrim • {Number(info.pieces || 0) || '—'} copë • {Number(info.m2 || 0) ? Number(info.m2 || 0).toFixed(2) : '—'} m² • {Number(info.total || 0) ? `€${Number(info.total || 0).toFixed(2)}` : '€—'}
                  </div>
                </div>

                <div style={{ marginTop: 7, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 5, minWidth: 0 }}>
                  {[
                    ['Kodi', labelCode],
                    ['Klienti', labelName],
                    ['Telefoni', info.phone || '—'],
                    ['Copë', Number(info.pieces || 0) || '—'],
                    ['M²', Number(info.m2 || 0) ? Number(info.m2 || 0).toFixed(2) : '—'],
                    ['Shuma', Number(info.total || 0) ? `€${Number(info.total || 0).toFixed(2)}` : '—'],
                  ].map(([k, v]) => (
                    <div key={`${key}-${k}`} style={{ border: '1px solid rgba(255,255,255,.08)', background: 'rgba(15,23,42,.36)', borderRadius: 8, padding: '5px 6px', minWidth: 0 }}>
                      <div style={{ color: 'rgba(226,232,240,.58)', fontSize: 8.5, fontWeight: 1000, letterSpacing: '.04em' }}>{k}</div>
                      <div style={{ color: '#fff', fontSize: 10.5, fontWeight: 900, overflowWrap: 'anywhere' }}>{String(v)}</div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 6, border: '1px solid rgba(252,165,165,.16)', background: 'rgba(127,29,29,.18)', borderRadius: 8, padding: '5px 6px', color: '#fecaca', fontSize: 10, fontWeight: 900, lineHeight: 1.25, overflowWrap: 'anywhere' }}>
                  Error: {shortError.length > 95 ? `${shortError.slice(0, 95)}...` : shortError}
                </div>

                {(scan || state?.error || state?.insertError || state?.inserted) ? (
                  <div style={{ marginTop: 7, border: `1px solid ${scanTone.border}`, background: scanTone.bg, color: scanTone.color, borderRadius: 9, padding: '6px 7px', fontWeight: 900, lineHeight: 1.3, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                      {scanBadge ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%', border: `1px solid ${scanTone.border}`, background: 'rgba(15,23,42,.34)', borderRadius: 999, padding: '2px 7px', fontSize: 9, fontWeight: 1000, letterSpacing: '.03em', overflowWrap: 'anywhere' }}>
                          {scanBadge}
                        </span>
                      ) : null}
                      {state?.inserted ? <span style={{ color: '#bbf7d0', fontSize: 10 }}>U FUT NË DB / DB VERIFIED</span> : null}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 10.5 }}>
                      {state?.error ? `DB SCAN ERROR: ${state.error}` : (scan?.message || '—')}
                    </div>
                    {state?.insertError ? <div style={{ marginTop: 3, color: '#fecaca', fontSize: 10 }}>INSERT ERROR: {state.insertError}</div> : null}
                  </div>
                ) : (
                  <div style={{ marginTop: 7, color: 'rgba(254,202,202,.82)', fontWeight: 900, fontSize: 10 }}>
                    Kliko “KONTROLLO NË DB” para çdo vendimi.
                  </div>
                )}

                <details style={{ marginTop: 7, minWidth: 0 }}>
                  <summary style={{ cursor: 'pointer', color: '#bfdbfe', fontSize: 10, fontWeight: 1000, letterSpacing: '.03em', listStyle: 'none' }}>
                    DETAJE TEKNIKE
                  </summary>
                  <div style={{ marginTop: 6, display: 'grid', gap: 5, minWidth: 0 }}>
                    {[
                      ['local_oid', info.localOid || '—'],
                      ['save_attempt_id', info.saveAttemptId || '—'],
                      ['outbox_op_id', info.outboxOpId || '—'],
                      ['resolved_tokens', getPastrimiProblemHardResolvedTokens(row).join(' | ') || '—'],
                      ['error full', shortError || '—'],
                      ['DB scan result', scan?.resolver_state || state?.error || 'PA KONTROLL'],
                      ['ORDER/KODI NË DB', scan?.codeOrder ? stringifyPastrimiScanDbRow(scan.codeOrder) : '—'],
                      ['ORDER EKZISTON', scan?.existingOrder ? stringifyPastrimiScanDbRow(scan.existingOrder) : '—'],
                      ['CLIENT/KODI NË DB', scan?.codeClient ? stringifyPastrimiScanClient(scan.codeClient) : '—'],
                      ['MUNGON', scan?.missing?.length ? scan.missing.join(', ') : '—'],
                    ].map(([k, v]) => (
                      <div key={`${key}-tech-${k}`} style={{ border: '1px solid rgba(255,255,255,.07)', background: 'rgba(2,6,23,.30)', borderRadius: 7, padding: '4px 6px', minWidth: 0 }}>
                        <div style={{ color: 'rgba(226,232,240,.55)', fontSize: 8.5, fontWeight: 1000, letterSpacing: '.04em' }}>{k}</div>
                        <div style={{ color: '#e5e7eb', fontSize: 10, fontWeight: 800, overflowWrap: 'anywhere' }}>{String(v)}</div>
                      </div>
                    ))}
                  </div>
                </details>

                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, minWidth: 0, width: '100%', maxWidth: '100%' }}>
                  <button
                    type="button"
                    disabled={!!state?.checking}
                    onClick={() => handleCheckPastrimiProblemInDb(row)}
                    style={{ ...buttonBaseStyle, border: '1px solid rgba(96,165,250,.45)', background: 'rgba(30,64,175,.32)', color: '#bfdbfe', opacity: state?.checking ? .65 : 1 }}
                  >{state?.checking ? 'DUKE KONTROLLUAR...' : 'KONTROLLO NË DB'}</button>
                  <button
                    type="button"
                    disabled={!canInsert}
                    onClick={() => handleInsertPastrimiProblem(row)}
                    style={{ ...buttonBaseStyle, border: canInsert ? '1px solid rgba(34,197,94,.55)' : '1px solid rgba(148,163,184,.25)', background: canInsert ? 'rgba(20,83,45,.38)' : 'rgba(71,85,105,.22)', color: canInsert ? '#bbf7d0' : 'rgba(203,213,225,.55)', cursor: canInsert ? 'pointer' : 'not-allowed' }}
                  >{state?.inserting ? 'DUKE FUTUR...' : 'FUTE NË PASTRIM'}</button>
                  <button
                    type="button"
                    onClick={() => handleResolvePastrimiLocalProblem(row, { reason: 'HIDDEN_BY_WORKER', scanResult: scan })}
                    style={{ ...buttonBaseStyle, border: '1px solid rgba(34,197,94,.45)', background: 'rgba(20,83,45,.32)', color: '#bbf7d0' }}
                  >ZGJIDH / FSHEH</button>
                  <button
                    type="button"
                    onClick={() => handleCopyPastrimiProblemReport(row)}
                    style={{ ...buttonBaseStyle, border: '1px solid rgba(252,165,165,.40)', background: 'rgba(127,29,29,.35)', color: '#fecaca' }}
                  >COPY RAPORT</button>
                </div>
              </div>
            );
          }) : null}
        </section>
      ) : null}

      <input className="input" placeholder="🔎 Kërko kodin, emrin ose telefonin" value={search} onChange={e => setSearch(e.target.value)} />

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '2px 0 10px' }}>
        {PASTRIM_FILTER_CHIPS.map((chip) => {
          const isActive = pastrimFilter === chip.key;
          const count = pastrimFilterCounts?.[chip.key] ?? 0;
          const tone = (() => {
            switch (chip.key) {
              case 'over4': return { fg: '#fdba74', bg: 'rgba(234,88,12,.16)', bd: 'rgba(234,88,12,.5)' };
              case 'due': return { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)', bd: 'rgba(239,68,68,.5)' };
              case 'snooze': return { fg: '#93c5fd', bg: 'rgba(59,130,246,.16)', bd: 'rgba(59,130,246,.5)' };
              case 'debt': return { fg: '#fda4af', bg: 'rgba(136,19,55,.28)', bd: 'rgba(159,18,57,.55)' };
              case 'unpacked': return { fg: '#e2e8f0', bg: 'rgba(100,116,139,.20)', bd: 'rgba(148,163,184,.45)' };
              default: return { fg: '#bbf7d0', bg: 'rgba(34,197,94,.14)', bd: 'rgba(34,197,94,.45)' };
            }
          })();
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setPastrimFilter(chip.key)}
              style={{
                borderRadius: 999,
                padding: '6px 11px',
                fontSize: 11.5,
                fontWeight: 1000,
                lineHeight: 1.1,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                color: isActive ? tone.fg : 'rgba(226,232,240,.62)',
                background: isActive ? tone.bg : 'rgba(15,23,42,.5)',
                border: isActive ? `1px solid ${tone.bd}` : '1px solid rgba(148,163,184,.18)',
              }}
            >
              {chip.label}{chip.key !== 'all' ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      <section className="card" style={{ padding: '10px' }}>
        {!loading && exactSearchMode && !exactSearchTimedOut && visibleOrders.length === 0 ? <p data-visible-stuck-candidate="1" style={{ textAlign: 'center' }}>DUKE HAPUR NGA KËRKIMI... Nëse nuk gjendet shpejt, lista lokale hapet vetë.</p> : null}
        {loading && visibleOrders.length === 0 ? <p style={{ textAlign: 'center' }}>{browserOffline || hasRealFetchProblem ? 'Duke u ngarkuar nga cache...' : 'Duke u ngarkuar nga DB...'}</p> : (visibleOrders.length === 0 ? <p style={{ textAlign: 'center', color: 'rgba(255,255,255,.72)' }}>Nuk ka porosi në PASTRIMI.</p> : (displayOrders.length === 0 ? <p style={{ textAlign: 'center', color: 'rgba(255,255,255,.72)' }}>Asnjë porosi nuk përputhet me filtrin “{(PASTRIM_FILTER_CHIPS.find((c) => c.key === pastrimFilter) || {}).label || ''}”.</p> :
          displayOrders.map(o => {
              if (!o || !o.id) return null;
              // SHTUAR: Përmirësimi i Kodit
              const codeLabel = o?.code != null ? String(o.code).trim() : '—';
              const cope = Number(o?.cope || 0);
              const m2 = Number(o?.m2 || 0);
              const total = Number(o?.total || 0);
              const paid = Number(o?.paid || 0);

              const isTransportDisplay = isPastrimTransportScopedRow(o);
              const transportMeta = isTransportDisplay ? getTransportBaseSummary(o, transportUserLookup) : null;
              const paketimiBadge = getPaketimiBadge(o);
              const delayReviewInfo = getPastrimDelayReviewInfo(o);
              const rowMoney = readPastrimDelayMoney(o);
              const rowHasDebt = rowMoney.debt > 0;
              const lastDelayReview = delayReviewInfo.last_review || null;
              const lastDelayReviewStatusLabel = lastDelayReview?.status ? (PASTRIM_DELAY_REVIEW_STATUS_LABELS[String(lastDelayReview.status).trim()] || String(lastDelayReview.status).trim()) : '';
              const lastDelayReviewReason = String(lastDelayReview?.reason || lastDelayReview?.incident_note || '').trim();
              const lastDelayReviewSummaryRaw = [
                lastDelayReviewStatusLabel,
                lastDelayReviewReason && lastDelayReviewReason !== lastDelayReviewStatusLabel ? lastDelayReviewReason : '',
              ].filter(Boolean).join(' • ');
              const lastDelayReviewSummaryClean = lastDelayReviewSummaryRaw.replace(/\s+/g, ' ').trim();
              const lastDelayReviewSummary = lastDelayReviewSummaryClean.length > 38 ? `${lastDelayReviewSummaryClean.slice(0, 35)}…` : lastDelayReviewSummaryClean;
              const compactPackageBadgeText = String(paketimiBadge?.text || '').trim();
              const showCompactMetaLine = !!(delayReviewInfo.warning || rowHasDebt || lastDelayReviewSummary || compactPackageBadgeText);
              const paketimiBadgeStyle = paketimiBadge.tone === 'partial'
                ? { border: '1px solid rgba(245,158,11,.42)', background: 'rgba(245,158,11,.14)', color: '#fde68a' }
                : paketimiBadge.tone === 'ready'
                  ? { border: '1px solid rgba(34,197,94,.42)', background: 'rgba(34,197,94,.14)', color: '#bbf7d0' }
                  : paketimiBadge.tone === 'complete' || paketimiBadge.tone === 'wrapped'
                    ? { border: '1px solid rgba(96,165,250,.42)', background: 'rgba(37,99,235,.16)', color: '#bfdbfe' }
                    : { border: '1px solid rgba(148,163,184,.30)', background: 'rgba(15,23,42,.36)', color: 'rgba(226,232,240,.78)' };

              return (
              <div key={o.id + o.source} className="list-item-compact" style={{ display: 'flex', flexDirection: paketimiBadge.tone === 'partial' ? 'column' : 'row', justifyContent: 'space-between', alignItems: paketimiBadge.tone === 'partial' ? 'stretch' : 'center', gap: paketimiBadge.tone === 'partial' ? 8 : 6, minWidth: 0, width: '100%', boxSizing: 'border-box', overflow: 'hidden', padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', opacity: o.isReturn ? 0.92 : 1 }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1, minWidth: 0, width: paketimiBadge.tone === 'partial' ? '100%' : undefined }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, flexShrink:0 }}>
                    <div
                      onMouseDown={() => startLongPress(o)}
                      onTouchStart={() => startLongPress(o)}
                      onMouseUp={cancelLongPress}
                      onTouchEnd={cancelLongPress}
                      style={{
                        background: isTransportDisplay ? '#dc2626' : (delayReviewInfo.warning ? '#ea580c' : badgeColorByAge(o.ts)),
                        border: isTransportDisplay ? '2px solid rgba(255,255,255,0.18)' : 'none',
                        boxShadow: (!isTransportDisplay && delayReviewInfo.warning) ? '0 0 0 2px rgba(251,146,60,.85)' : undefined,
                        color: '#fff', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, fontWeight: 800, fontSize: 14, flexShrink: 0
                      }}>
                      {codeLabel}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>{formatDayMonth(o.ts)}</div>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      {o.name} 
                      {/* SHTUAR: Etiketa NË PRITJE për Offline */}
                      {o._outboxPending && <span style={{ color: '#f59e0b', fontWeight: 800, marginLeft: 6 }}>⏳ PRITJE</span>}
                      {o.isReturn && <span style={{color:'#f59e0b'}}>• KTHIM</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{cope} copë • {m2.toFixed(2)} m²</div>
                    {showCompactMetaLine ? (
                      <div
                        style={{
                          marginTop: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          flexWrap: 'nowrap',
                          maxWidth: '100%',
                          minWidth: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {delayReviewInfo.due ? (
                          <button
                            type="button"
                            onClick={() => openPastrimDelayReview(o, 'row_warning_badge')}
                            style={{ flexShrink: 0, border: '1px solid rgba(239,68,68,.5)', background: 'rgba(239,68,68,.18)', color: '#fecaca', borderRadius: 999, padding: '2px 6px', fontSize: 9, fontWeight: 1000, lineHeight: 1.1, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >DUE</button>
                        ) : null}
                        {delayReviewInfo.softWarning ? (
                          <span style={{ flexShrink: 0, border: '1px solid rgba(59,130,246,.45)', background: 'rgba(59,130,246,.15)', color: '#bfdbfe', borderRadius: 999, padding: '2px 6px', fontSize: 9, fontWeight: 1000, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                            SNOOZE{delayReviewInfo.next_review_at ? ` ${formatDayMonth(delayReviewInfo.next_review_at)}` : ''}
                          </span>
                        ) : (delayReviewInfo.warning ? (
                          <span style={{ flexShrink: 0, border: '1px solid rgba(251,146,60,.38)', background: 'rgba(234,88,12,.14)', color: '#fdba74', borderRadius: 999, padding: '2px 6px', fontSize: 9, fontWeight: 1000, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                            {delayReviewInfo.age_days_exact}d
                          </span>
                        ) : null)}
                        {rowHasDebt ? (
                          <span style={{ flexShrink: 0, border: '1px solid rgba(159,18,57,.48)', background: 'rgba(136,19,55,.24)', color: '#fda4af', borderRadius: 999, padding: '2px 6px', fontSize: 9, fontWeight: 1000, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                            BORXH €{rowMoney.debt.toFixed(2)}
                          </span>
                        ) : null}
                        {lastDelayReviewSummary ? (
                          <span
                            title={lastDelayReviewSummaryClean}
                            style={{
                              flex: '1 1 auto',
                              minWidth: 0,
                              color: 'rgba(191,219,254,.92)',
                              fontSize: 10,
                              fontWeight: 850,
                              lineHeight: 1.15,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >📝 {lastDelayReviewSummary}</span>
                        ) : null}
                        {compactPackageBadgeText && paketimiBadge.tone !== 'partial' ? (
                          <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', maxWidth: '42%', padding: '2px 6px', borderRadius: 999, fontSize: 9, fontWeight: 950, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...paketimiBadgeStyle }}>
                            {compactPackageBadgeText}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {paketimiBadge.tone === 'partial' ? (
                      <div
                        style={{
                          marginTop: 5,
                          width: '100%',
                          maxWidth: '100%',
                          boxSizing: 'border-box',
                          borderLeft: '4px solid rgba(245,158,11,.98)',
                          borderTop: '1px solid rgba(245,158,11,.30)',
                          borderRight: '1px solid rgba(245,158,11,.20)',
                          borderBottom: '1px solid rgba(245,158,11,.20)',
                          background: 'rgba(245,158,11,.12)',
                          borderRadius: 10,
                          padding: '7px 9px 7px 10px',
                          overflow: 'hidden',
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 1000, lineHeight: 1.15, color: '#fde68a', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                          {paketimiBadge.title || paketimiBadge.text}
                        </div>
                        <div style={{ marginTop: 4, fontSize: 12, fontWeight: 950, lineHeight: 1.18, color: 'rgba(254,243,199,.94)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                          <span>{paketimiBadge.missingLabel || 'MUNGON:'} </span>
                          <span style={{ color: '#fca5a5', fontSize: 15, fontWeight: 1000 }}>{paketimiBadge.missingValue || ''}</span>
                        </div>
                        {paketimiBadge.foundText ? (
                          <div style={{ marginTop: 4, fontSize: 11, fontWeight: 850, lineHeight: 1.22, color: 'rgba(255,255,255,.82)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                            {paketimiBadge.foundText}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {transportMeta?.broughtBy ? <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 800 }}>🚚 E SOLLI: {String(transportMeta.broughtBy).toUpperCase()}</div> : null}
                    {transportMeta?.rackText ? <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.68)', fontWeight: 700 }}>📍 {String(transportMeta.rackText).toUpperCase()}</div> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px', flexShrink: 0, width: paketimiBadge.tone === 'partial' ? '100%' : undefined }}>
                  {o.isPaid && <span style={{ flexShrink: 0 }}>✅</span>}
                  {!isTransportDisplay && (
                    <button className="btn secondary" style={{ padding: '5px 6px', fontSize: 10, whiteSpace: 'nowrap' }} onClick={() => openRowPay(o)}>
                      💶 PAGUAJ
                    </button>
                  )}
                  <button id={`btn-${o.id}`} className="btn primary" style={{ padding: '5px 6px', fontSize: 10, whiteSpace: 'nowrap', backgroundColor: isTransportDisplay ? '#dc2626' : '#16a34a' }} onClick={() => openReadyPlaceSheet(o)}>
                    PAKETO / SMS
                  </button>
                </div>
              </div>
            )})))}
      </section>

      {pastrimDelayReview.open && pastrimDelayReview.row ? (() => {
        const row = pastrimDelayReview.row;
        const info = pastrimDelayReview.dueInfo || getPastrimDelayReviewInfo(row);
        const money = readPastrimDelayMoney(row);
        const selectedStatus = String(pastrimDelayReview.status || '').trim();
        const requiresReason = selectedStatus === 'not_dry' || selectedStatus === 'other';
        const isClientPicked = selectedStatus === 'client_picked_up';
        const selectedResponsibleValue = `${pastrimDelayReview.responsible_pin || ''}|||${pastrimDelayReview.responsible_name || ''}`;
        const cashAmountPreview = Number(pastrimDelayReview.cash_amount || 0);
        const remainingDebtAfterCash = Number(Math.max(0, (money.debt || 0) - (Number.isFinite(cashAmountPreview) ? cashAmountPreview : 0)).toFixed(2));
        const reviewOrderCode = normalizeCode(row?.code || row?.fullOrder?.code || row?.fullOrder?.client?.code || '') || '—';
        const reviewClientName = row?.name || row?.fullOrder?.client_name || row?.fullOrder?.client?.name || 'Pa emër';
        const reviewAgeLabel = `${info.age_days_exact || info.age_days} ditë në PASTRIM`;
        const quickStatusOptions = [
          { key: 'not_dry', label: 'Nuk është tharë ende' },
          { key: 'forgot_to_mark_gati', label: 'E kemi harru me e qit në GATI' },
          { key: 'client_picked_up', label: 'Klienti e ka marrë' },
          { key: 'other', label: 'Arsye tjetër' },
        ];
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 80,
              background: 'rgba(2,6,23,.88)',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'center',
              paddingTop: 'max(env(safe-area-inset-top), 8px)',
              paddingRight: 8,
              paddingBottom: 'max(env(safe-area-inset-bottom), 8px)',
              paddingLeft: 8,
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                width: 'min(680px, 100%)',
                height: '100%',
                maxHeight: '100%',
                overflowY: 'auto',
                overflowX: 'hidden',
                border: '1px solid rgba(239,68,68,.36)',
                background: 'linear-gradient(180deg,#0f172a,#020617)',
                color: '#f8fafc',
                borderRadius: 20,
                padding: '14px 12px 18px',
                boxShadow: '0 24px 90px rgba(0,0,0,.68)',
                boxSizing: 'border-box',
              }}
            >
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 22, lineHeight: 1.05, fontWeight: 1000 }}>Çka ndodhi?</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ borderRadius: 999, padding: '4px 9px', background: 'rgba(37,99,235,.22)', border: '1px solid rgba(96,165,250,.34)', color: '#dbeafe', fontSize: 12, fontWeight: 1000 }}>Kodi {reviewOrderCode}</span>
                  <span style={{ borderRadius: 999, padding: '4px 9px', background: 'rgba(15,23,42,.7)', border: '1px solid rgba(148,163,184,.26)', color: 'rgba(226,232,240,.96)', fontSize: 12, fontWeight: 950, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{reviewClientName}</span>
                  <span style={{ borderRadius: 999, padding: '4px 9px', background: 'rgba(234,88,12,.16)', border: '1px solid rgba(251,146,60,.32)', color: '#fdba74', fontSize: 12, fontWeight: 950 }}>{reviewAgeLabel}</span>
                </div>
                {info.next_review_at ? (
                  <div style={{ fontSize: 11, color: '#fde68a', fontWeight: 900 }}>
                    Rikontroll: {String(info.next_review_at).replace('T', ' ').slice(0, 16)}
                  </div>
                ) : null}
              </div>

              <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                {quickStatusOptions.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    disabled={pastrimDelayReviewBusy}
                    onClick={() => updatePastrimDelayReviewDraft({
                      status: key,
                      cash_amount: key === 'client_picked_up' && !pastrimDelayReview.cash_amount && money.debt > 0 ? money.debt.toFixed(2) : pastrimDelayReview.cash_amount,
                    })}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      border: selectedStatus === key ? '1px solid rgba(96,165,250,.72)' : '1px solid rgba(148,163,184,.22)',
                      background: selectedStatus === key ? 'rgba(30,64,175,.34)' : 'rgba(15,23,42,.58)',
                      color: '#f8fafc',
                      borderRadius: 14,
                      padding: '12px 12px',
                      fontWeight: 1000,
                      fontSize: 16,
                      lineHeight: 1.2,
                    }}
                  >
                    {selectedStatus === key ? '✓ ' : ''}{label}
                  </button>
                ))}
              </div>

              {requiresReason ? (
                <label style={{ marginTop: 14, display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 1000 }}>Shënim</span>
                  <textarea
                    className="input"
                    value={pastrimDelayReview.reason || ''}
                    onChange={(e) => updatePastrimDelayReviewDraft({ reason: e.target.value })}
                    placeholder={selectedStatus === 'not_dry' ? 'p.sh. duhet edhe 24h me u tha' : 'Shkruaje shkurt çka ka ndodh'}
                    disabled={pastrimDelayReviewBusy}
                    style={{ minHeight: 100, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                  />
                </label>
              ) : null}

              {selectedStatus === 'forgot_to_mark_gati' ? (
                <div style={{ marginTop: 12, border: '1px solid rgba(34,197,94,.30)', background: 'rgba(20,83,45,.16)', color: '#bbf7d0', borderRadius: 14, padding: '10px 12px', fontSize: 12, fontWeight: 900, lineHeight: 1.35 }}>
                  Do të kalojë në GATI.
                </div>
              ) : null}

              {isClientPicked ? (
                <div style={{ marginTop: 14, display: 'grid', gap: 10, border: '1px solid rgba(251,191,36,.28)', background: 'rgba(120,53,15,.12)', borderRadius: 14, padding: 12 }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: '#fde68a' }}>Kush e pranoi?</div>
                    <select
                      className="input"
                      value={selectedResponsibleValue}
                      onChange={(e) => {
                        const [pin, name] = String(e.target.value || '').split('|||');
                        updatePastrimDelayReviewDraft({ responsible_pin: pin || '', responsible_name: name || '' });
                      }}
                      disabled={pastrimDelayReviewBusy}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    >
                      <option value="|||">Zgjedhe personin</option>
                      {pastrimDelayStaffOptions.map((user) => {
                        const value = `${user.pin || ''}|||${user.name || ''}`;
                        return <option key={value} value={value}>{user.name || user.pin}{user.pin ? ` (${user.pin})` : ''}</option>;
                      })}
                    </select>
                  </div>

                  {selectedResponsibleValue === '|||' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                      <input className="input" value={pastrimDelayReview.responsible_pin || ''} onChange={(e) => updatePastrimDelayReviewDraft({ responsible_pin: e.target.value })} placeholder="PIN" disabled={pastrimDelayReviewBusy} style={{ minWidth: 0 }} />
                      <input className="input" value={pastrimDelayReview.responsible_name || ''} onChange={(e) => updatePastrimDelayReviewDraft({ responsible_name: e.target.value })} placeholder="Emri" disabled={pastrimDelayReviewBusy} style={{ minWidth: 0 }} />
                    </div>
                  ) : null}

                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 1000 }}>Cash në ARKA</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0"
                      max={money.debt || 0}
                      value={pastrimDelayReview.cash_amount || ''}
                      onChange={(e) => updatePastrimDelayReviewDraft({ cash_amount: e.target.value })}
                      placeholder={`Borxhi: ${money.debt.toFixed(2)}€`}
                      disabled={pastrimDelayReviewBusy}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                  </label>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ borderRadius: 999, padding: '4px 9px', background: 'rgba(15,23,42,.7)', border: '1px solid rgba(148,163,184,.20)', color: '#e2e8f0', fontSize: 12, fontWeight: 900 }}>Total {money.total.toFixed(2)}€</span>
                    <span style={{ borderRadius: 999, padding: '4px 9px', background: 'rgba(15,23,42,.7)', border: '1px solid rgba(148,163,184,.20)', color: '#e2e8f0', fontSize: 12, fontWeight: 900 }}>Borxh {money.debt.toFixed(2)}€</span>
                    <span style={{ borderRadius: 999, padding: '4px 9px', background: remainingDebtAfterCash > 0 ? 'rgba(136,19,55,.24)' : 'rgba(20,83,45,.22)', border: remainingDebtAfterCash > 0 ? '1px solid rgba(244,114,182,.28)' : '1px solid rgba(74,222,128,.28)', color: remainingDebtAfterCash > 0 ? '#fda4af' : '#bbf7d0', fontSize: 12, fontWeight: 1000 }}>
                      Mbetet {remainingDebtAfterCash.toFixed(2)}€
                    </span>
                  </div>

                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 1000 }}>Shënim</span>
                    <textarea
                      className="input"
                      value={pastrimDelayReview.incident_note || ''}
                      onChange={(e) => updatePastrimDelayReviewDraft({ incident_note: e.target.value })}
                      placeholder={remainingDebtAfterCash > 0 ? 'Shkruaje kush i mori paratë ose sa borxh mbeti' : 'Opsionale'}
                      disabled={pastrimDelayReviewBusy}
                      style={{ minHeight: 96, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                    />
                  </label>
                </div>
              ) : null}

              {pastrimDelayReviewMsg ? (
                <div style={{ marginTop: 12, color: pastrimDelayReviewMsg.startsWith('Gabim') || /duhet|Zgjidhe|Shënimi|Ky rast/.test(pastrimDelayReviewMsg) ? '#fecaca' : '#bbf7d0', fontSize: 12, fontWeight: 950, lineHeight: 1.35 }}>
                  {pastrimDelayReviewMsg}
                </div>
              ) : null}

              <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={pastrimDelayReviewBusy}
                  onClick={submitPastrimDelayReview}
                  style={{ minHeight: 52, fontWeight: 1000, fontSize: 16, opacity: pastrimDelayReviewBusy ? .65 : 1, borderRadius: 14 }}
                >{pastrimDelayReviewBusy ? 'DUKE RUAJTUR...' : 'RUAJ REVIEW'}</button>
              </div>
            </div>
          </div>
        );
      })() : null}


      {paketimiSheet && paketimiOrder && paketimiDraft ? (() => {
        const stats = getPaketimiStats(paketimiDraft);
        const orderData = unwrapOrderData(paketimiOrder?.fullOrder || paketimiOrder?.data || paketimiOrder || {});
        const codeLabel = normalizeCode(orderData?.client_tcode || orderData?.code || orderData?.client?.code || paketimiOrder?.code || '');
        const paketimiDelayInfo = getPastrimDelayReviewInfo(paketimiOrder);
        const clientName = String(orderData?.client_name || orderData?.client?.name || paketimiOrder?.name || 'Pa emër').trim();
        const clientPhone = String(orderData?.client_phone || orderData?.client?.phone || paketimiOrder?.phone || '').trim();
        const clientPhoneHref = buildPaketimiPhoneHref(clientPhone);
        const money = readPastrimDelayMoney(paketimiOrder);
        const totalPieces = stats.total;
        const totalArea = (Array.isArray(paketimiDraft?.pieces) ? paketimiDraft.pieces : []).reduce((sum, piece) => sum + (Number(piece?.m2) || 0), 0);
        const noteRequired = stats.someFound && !stats.allFound;
        const rackValue = normalizePaketimiFinalRack(paketimiDraft?.final_rack);
        const rackSlots = normalizeRackSlots(rackValue);
        const rackLabel = rackSlots.length ? formatRackLocationLabel(rackSlots[0]) : '';
        const selectedRackSlot = getPaketimiRackSelectedSlot(rackValue);
        const rackSlotOptions = getPaketimiRackSlotsForZone(paketimiRackZone);
        const stepMeta = getPaketimiRackStepMeta(stats, paketimiDraft);
        const isFinalReady = String(paketimiDraft?.status || '').trim() === 'final_ready';
        const rawPaketimiError = String(paketimiError || '').trim();
        const isMissingFlowError = /^(fillimisht|sms\/gati nuk lejohet|sms nuk lejohet|nuk mund të bëhet gati\. mungon|nuk mund të bëhet roll\. mungon)/i.test(rawPaketimiError) || (/mungon:/i.test(rawPaketimiError) && stats.missing > 0);
        const visiblePaketimiError = isMissingFlowError ? '' : rawPaketimiError;
        const packageSummary = paketimiDraft?.wrapped ? `${stats.total}/${stats.total} të paketuara` : (stats.allFound ? `${stats.total}/${stats.total} gati për paketim` : `${stats.found}/${stats.total} të gjetura`);
        let primaryLabel = 'RUAJ GRUMBULLIMIN';
        let primaryDisabled = !!paketimiBusy;
        let primaryAction = savePaketimiGrouping;
        if (isFinalReady) {
          primaryLabel = 'GATI PËR SMS';
          primaryDisabled = true;
          primaryAction = undefined;
        } else if (stats.allFound && !paketimiDraft?.wrapped) {
          primaryLabel = 'VAZHDO TE RAFTI';
          primaryDisabled = !!paketimiBusy;
          primaryAction = markPaketimiWrapped;
        } else if (paketimiDraft?.wrapped && (!rackValue || !hasConcreteRackLocation(rackValue))) {
          primaryLabel = 'ZGJEDH RAFTIN';
          primaryDisabled = true;
          primaryAction = undefined;
        } else if (paketimiDraft?.wrapped && rackValue) {
          primaryLabel = 'RUAJE RAFTIN DHE BËJE GATI';
          primaryDisabled = !!paketimiBusy;
          primaryAction = paketimiMakeReady;
        }
        const selectRackZone = (zone) => {
          const nextZone = normalizePaketimiRackZone(zone);
          setPaketimiRackZone(nextZone);
          updatePaketimiDraft({ final_rack: '' });
          setPaketimiError('');
        };
        const selectRackSlot = (slot) => {
          const nextRack = buildPaketimiRackValue(paketimiRackZone, slot);
          updatePaketimiDraft({ final_rack: nextRack });
          setPaketimiError('');
        };
        const stepCircleStyle = (active, done) => ({
          width: 36,
          height: 36,
          borderRadius: 999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: done ? '1px solid rgba(134,239,172,.72)' : (active ? '1px solid rgba(96,165,250,.88)' : '1px solid rgba(148,163,184,.38)'),
          background: done ? 'rgba(34,197,94,.20)' : (active ? 'linear-gradient(180deg,#3b82f6,#1d4ed8)' : 'rgba(15,23,42,.72)'),
          color: done ? '#bbf7d0' : (active ? '#eff6ff' : '#94a3b8'),
          fontSize: 16,
          fontWeight: 1000,
          boxShadow: active ? '0 10px 28px rgba(37,99,235,.28)' : 'none',
        });
        const stepTextStyle = (active, done) => ({
          marginTop: 5,
          fontSize: 11,
          color: done ? '#86efac' : (active ? '#93c5fd' : '#94a3b8'),
          fontWeight: 1000,
        });
        const panelBg = 'linear-gradient(180deg, rgba(15,23,42,.98), rgba(5,7,13,.99))';
        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(2,6,23,.92)', display: 'flex', alignItems: 'stretch', justifyContent: 'center', padding: 0, overflowX: 'hidden' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) closePaketimiSheet(); }}
          >
            <div style={{ width: 'min(760px, 100%)', maxWidth: '100%', height: '100dvh', maxHeight: '100dvh', overflowY: 'auto', overflowX: 'hidden', borderRadius: 0, border: paketimiDelayInfo.warning ? '1px solid rgba(234,88,12,.55)' : '1px solid rgba(96,165,250,.22)', background: panelBg, color: '#f8fafc', boxShadow: '0 24px 72px rgba(0,0,0,.62)' }}>
              <div style={{ width: 52, height: 4, borderRadius: 999, background: 'rgba(148,163,184,.46)', margin: '9px auto 0' }} />
              {paketimiDelayInfo.warning ? (
                <div style={{ margin: '10px 12px 0', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'rgba(234,88,12,.16)', border: '1px solid rgba(234,88,12,.36)', color: '#fed7aa', fontSize: 11.5, fontWeight: 1000, lineHeight: 1.25, borderRadius: 14 }}>
                  <span aria-hidden="true">⚠️</span>
                  <span style={{ minWidth: 0 }}>Kjo porosi ka më shumë se 4 ditë në PASTRIM{paketimiDelayInfo.age_days_exact ? ` (${paketimiDelayInfo.age_days_exact} ditë)` : ''}</span>
                </div>
              ) : null}

              <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid rgba(148,163,184,.14)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '62px minmax(0,1fr) auto', gap: 10, alignItems: 'start' }}>
                  <div style={{ width: 54, height: 54, borderRadius: 13, background: 'linear-gradient(180deg,#22c55e,#16a34a)', color: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 1000, boxShadow: '0 10px 24px rgba(22,163,74,.24)' }}>{codeLabel || '—'}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 22, lineHeight: 1.08, fontWeight: 1000, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{codeLabel || '—'} — {clientName}</div>
                    <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(226,232,240,.82)', fontWeight: 850, display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', lineHeight: 1.25 }}>
                      <span>📞 Tel: {clientPhoneHref ? <a href={clientPhoneHref} style={{ color: '#93c5fd', fontWeight: 1000, textDecoration: 'underline' }}>{clientPhone}</a> : (clientPhone || '—')}</span>
                      <span>• {totalPieces} copë</span>
                      <span>• {formatPaketimiM2(totalArea)} m²</span>
                    </div>
                  </div>
                  {money.debt > 0 ? (
                    <div style={{ border: '1px solid rgba(248,113,113,.34)', background: 'rgba(127,29,29,.28)', color: '#fecaca', borderRadius: 13, padding: '7px 9px', textAlign: 'center', fontWeight: 1000, lineHeight: 1.05, minWidth: 72 }}>
                      <div style={{ fontSize: 11 }}>Borxh</div>
                      <div style={{ marginTop: 3, fontSize: 15 }}>€{money.debt.toFixed(2)}</div>
                    </div>
                  ) : null}
                </div>

                <div style={{ marginTop: 17, display: 'grid', gridTemplateColumns: '1fr 40px 1fr 40px 1fr', alignItems: 'center', gap: 8 }}>
                  <div style={{ textAlign: 'center' }}>
                    <span style={stepCircleStyle(stepMeta.active === 1, stepMeta.foundDone)}>{stepMeta.foundDone ? '✓' : '1'}</span>
                    <div style={stepTextStyle(stepMeta.active === 1, stepMeta.foundDone)}>Gjetur</div>
                  </div>
                  <div style={{ height: 2, borderRadius: 999, background: stepMeta.foundDone ? 'rgba(34,197,94,.62)' : 'rgba(148,163,184,.25)' }} />
                  <div style={{ textAlign: 'center' }}>
                    <span style={stepCircleStyle(stepMeta.active === 2, stepMeta.packageDone)}>{stepMeta.packageDone ? '✓' : '2'}</span>
                    <div style={stepTextStyle(stepMeta.active === 2, stepMeta.packageDone)}>Paketim</div>
                  </div>
                  <div style={{ height: 2, borderRadius: 999, background: stepMeta.packageDone ? 'rgba(34,197,94,.62)' : 'rgba(148,163,184,.25)' }} />
                  <div style={{ textAlign: 'center' }}>
                    <span style={stepCircleStyle(stepMeta.active === 3, stepMeta.rackDone)}>{stepMeta.rackDone ? '✓' : '3'}</span>
                    <div style={stepTextStyle(stepMeta.active === 3, stepMeta.rackDone)}>Rafti</div>
                  </div>
                </div>
              </div>

              <div style={{ padding: 14, display: 'grid', gap: 13, minWidth: 0 }}>
                {!paketimiDraft?.wrapped ? (
                  <>
                    <section style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 1000, color: '#cbd5e1' }}>Artikujt</div>
                        <div style={{ fontSize: 11, borderRadius: 999, padding: '4px 8px', border: '1px solid rgba(34,197,94,.24)', background: 'rgba(20,83,45,.18)', color: '#bbf7d0', fontWeight: 1000 }}>{stats.found}/{stats.total} të gjetura</div>
                      </div>
                      {(Array.isArray(paketimiDraft?.pieces) ? paketimiDraft.pieces : []).map((piece) => (
                        <button
                          key={piece?.piece_id}
                          type="button"
                          onClick={() => togglePaketimiPiece(piece?.piece_id)}
                          disabled={paketimiBusy || isFinalReady}
                          style={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: piece?.found ? '1px solid rgba(34,197,94,.46)' : '1px solid rgba(148,163,184,.26)', background: piece?.found ? 'rgba(20,83,45,.32)' : 'rgba(15,23,42,.60)', color: '#f8fafc', borderRadius: 15, padding: '11px 12px', textAlign: 'left', fontWeight: 950, touchAction: 'manipulation' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            <span style={{ width: 34, height: 34, borderRadius: 10, border: piece?.found ? '1px solid rgba(187,247,208,.78)' : '1px solid rgba(203,213,225,.44)', background: piece?.found ? 'rgba(34,197,94,.18)' : 'rgba(15,23,42,.40)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 21, lineHeight: 1 }}>{piece?.found ? '✓' : ''}</span>
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15, lineHeight: 1.15 }}>{piece?.label || 'Copë'}</span>
                            </span>
                          </span>
                          <span style={{ flexShrink: 0, borderRadius: 999, padding: '5px 9px', background: piece?.found ? 'rgba(22,101,52,.50)' : 'rgba(51,65,85,.42)', color: piece?.found ? '#bbf7d0' : 'rgba(226,232,240,.68)', fontSize: 10.5, fontWeight: 1000 }}>{piece?.found ? 'GJETUR' : 'MUNGON'}</span>
                        </button>
                      ))}
                    </section>

                    {noteRequired ? (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 1000, color: '#cbd5e1' }}>Ku i le copët e gjetura?</span>
                        <textarea
                          className="input"
                          value={paketimiDraft?.found_location_note || ''}
                          onChange={(e) => updatePaketimiDraft({ found_location_note: e.target.value })}
                          placeholder="p.sh. te makina shrink wrap"
                          disabled={paketimiBusy || isFinalReady}
                          style={{ minHeight: 62, resize: 'vertical' }}
                        />
                      </label>
                    ) : null}

                    {stats.allFound ? (
                      <section style={{ border: '1px solid rgba(34,197,94,.30)', background: 'rgba(20,83,45,.13)', borderRadius: 17, padding: 11, display: 'grid', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 1000 }}>Paketimi</div>
                          <div style={{ fontSize: 11, borderRadius: 999, padding: '4px 8px', color: '#bbf7d0', background: 'rgba(22,101,52,.55)', border: '1px solid rgba(74,222,128,.28)', fontWeight: 1000 }}>{packageSummary}</div>
                        </div>
                        {(Array.isArray(paketimiDraft?.pieces) ? paketimiDraft.pieces : []).map((piece) => (
                          <div key={`wrap_${piece?.piece_id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid rgba(148,163,184,.16)', background: 'rgba(15,23,42,.46)', borderRadius: 14, padding: '9px 10px' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                              <span style={{ width: 31, height: 31, borderRadius: 9, background: 'rgba(34,197,94,.16)', border: '1px solid rgba(74,222,128,.35)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>▣</span>
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', color: '#f8fafc', fontSize: 14, fontWeight: 1000, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{piece?.label || 'Copë'}</span>
                                <span style={{ color: '#86efac', fontSize: 11, fontWeight: 900 }}>{paketimiDraft?.wrapped ? 'Paketuar' : 'Gati për paketim'}</span>
                              </span>
                            </span>
                            <span style={{ width: 46, height: 28, borderRadius: 999, background: paketimiDraft?.wrapped ? '#22c55e' : 'rgba(71,85,105,.62)', border: '1px solid rgba(255,255,255,.12)', position: 'relative', flexShrink: 0 }}>
                              <span style={{ position: 'absolute', top: 3, left: paketimiDraft?.wrapped ? 21 : 3, width: 20, height: 20, borderRadius: 999, background: '#fff', transition: 'left .18s ease' }} />
                            </span>
                          </div>
                        ))}
                      </section>
                    ) : null}
                  </>
                ) : (
                  <section style={{ display: 'grid', gap: 13 }}>
                    <div style={{ fontSize: 18, fontWeight: 1000, lineHeight: 1.15 }}>Ku po e len këtë porosi?</div>
                    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
                      {PAKETIMI_RACK_ZONE_OPTIONS.map((zone) => {
                        const selected = normalizePaketimiRackZone(paketimiRackZone) === zone.key;
                        return (
                          <button
                            key={zone.key}
                            type="button"
                            onClick={() => selectRackZone(zone.key)}
                            disabled={paketimiBusy || isFinalReady}
                            style={{ flexShrink: 0, border: selected ? '1px solid rgba(147,197,253,.86)' : '1px solid rgba(148,163,184,.24)', background: selected ? 'linear-gradient(180deg,#3b82f6,#1d4ed8)' : 'rgba(15,23,42,.62)', color: selected ? '#eff6ff' : '#cbd5e1', borderRadius: 13, padding: '10px 13px', fontSize: 12, letterSpacing: '.03em', fontWeight: 1000, boxShadow: selected ? '0 10px 24px rgba(37,99,235,.25)' : 'none' }}
                          >
                            {zone.label}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 9, maxHeight: 260, overflowY: 'auto', paddingRight: 1 }}>
                      {rackSlotOptions.map((slot) => {
                        const selected = selectedRackSlot === slot;
                        return (
                          <button
                            key={`${paketimiRackZone}_${slot}`}
                            type="button"
                            onClick={() => selectRackSlot(slot)}
                            disabled={paketimiBusy || isFinalReady}
                            style={{ position: 'relative', minHeight: 78, borderRadius: 14, border: selected ? '1px solid rgba(96,165,250,.95)' : '1px solid rgba(148,163,184,.20)', background: selected ? 'rgba(37,99,235,.24)' : 'rgba(15,23,42,.58)', color: selected ? '#93c5fd' : '#e2e8f0', fontWeight: 1000, fontSize: 16, display: 'grid', placeItems: 'center', gap: 3, boxShadow: selected ? 'inset 0 0 0 1px rgba(59,130,246,.35)' : 'none' }}
                          >
                            <span style={{ display: 'block', fontSize: 18, lineHeight: 1 }}>▦</span>
                            <span>{slot}</span>
                            {selected ? <span style={{ position: 'absolute', top: -6, right: -5, width: 24, height: 24, borderRadius: 999, background: '#3b82f6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, boxShadow: '0 8px 18px rgba(37,99,235,.38)' }}>✓</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ border: rackLabel ? '1px solid rgba(34,197,94,.40)' : '1px solid rgba(248,113,113,.30)', background: rackLabel ? 'rgba(20,83,45,.18)' : 'rgba(127,29,29,.16)', borderRadius: 17, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 13 }}>
                        <span style={{ width: 45, height: 45, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: rackLabel ? 'rgba(34,197,94,.26)' : 'rgba(248,113,113,.16)', border: rackLabel ? '1px solid rgba(134,239,172,.38)' : '1px solid rgba(248,113,113,.32)', color: rackLabel ? '#bbf7d0' : '#fecaca', fontSize: 22 }}>📍</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: rackLabel ? '#bbf7d0' : '#fecaca', fontSize: 13, fontWeight: 950 }}>Lokacioni final</div>
                          <div style={{ marginTop: 3, color: '#f8fafc', fontSize: 22, lineHeight: 1.1, fontWeight: 1000, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rackLabel || 'Zgjedh raftin'}</div>
                        </div>
                      </div>
                      <div style={{ borderTop: '1px solid rgba(148,163,184,.14)', padding: '9px 13px', color: rackLabel ? '#86efac' : '#fecaca', fontSize: 12, fontWeight: 950 }}>
                        {rackLabel ? '✓ Rafti u zgjedh me sukses' : 'Zgjedh zonën dhe slotin konkret para se ta bësh GATI'}
                      </div>
                    </div>
                  </section>
                )}

                {visiblePaketimiError ? <div style={{ border: '1px solid rgba(248,113,113,.28)', background: 'rgba(127,29,29,.16)', color: '#fecaca', borderRadius: 13, padding: '9px 10px', fontSize: 12, fontWeight: 900, lineHeight: 1.3 }}>{visiblePaketimiError}</div> : null}

                <div style={{ position: 'sticky', bottom: 0, background: 'linear-gradient(180deg, rgba(5,7,13,.08), #05070d 28%)', padding: '9px 0 calc(10px + env(safe-area-inset-bottom))', display: 'grid', gridTemplateColumns: 'minmax(104px,.72fr) minmax(0,1.28fr)', gap: 9, alignItems: 'stretch' }}>
                  <button type="button" className="btn secondary" disabled={paketimiBusy} onClick={closePaketimiSheet} style={{ minHeight: 52, fontSize: 13, lineHeight: 1.15, whiteSpace: 'normal', opacity: paketimiBusy ? .55 : 1 }}>MBYLLE</button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={primaryDisabled}
                    onClick={() => { if (!primaryDisabled && primaryAction) primaryAction(); }}
                    style={{ minHeight: 52, fontSize: 13, lineHeight: 1.15, whiteSpace: 'normal', opacity: primaryDisabled ? .52 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                  >
                    {paketimiBusy ? 'DUKE RUAJTUR...' : primaryLabel}{!primaryDisabled && !paketimiBusy ? <span aria-hidden="true">→</span> : null}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })() : null}

      {rowPaySheet && rowPayOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/pastrimi" routeName="PASTRIMI" moduleName="PastrimiRowPosModal" componentName="PosModal" sourceLayer="pastrimi_panel" showHome={false}>
          <PosModal
            open={rowPaySheet}
            onClose={closeRowPay}
            title="PAGESA (ARKË)"
            subtitle={`KODI: ${normalizeCode(rowPayOrder.code)} • ${rowPayOrder.name || ''}`}
            total={Number(rowPayOrder.total || 0)}
            alreadyPaid={Number(rowPayOrder.paid || 0)}
            amount={rowPayAmount}
            setAmount={setRowPayAmount}
            payChips={PAY_CHIPS}
            confirmText="KRYEJ PAGESËN"
            cancelText="ANULO"
            disabled={rowPayBusy}
            onConfirm={applyRowPayAndClose}
            allowPartial
            footerNote="BORXHI SHFAQET VETËM KËTU. PAGESA E PJESSHME RUAHET AUTOMATIKISHT."
          />
        </LocalErrorBoundary>
      )}

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
