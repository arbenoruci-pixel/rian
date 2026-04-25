'use client';
import PosModal from '@/components/PosModal';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';

// app/gati/page.jsx

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';
import { createOrderRecord, fetchOrderByIdSafe, findLatestOrderByCode, listOrderRecords, transitionOrderStatus, updateOrderData, updateOrderRecord } from '@/lib/ordersService';
import { recordOrderCashPayment } from '@/components/payments/payService';
import { saveOrderLocal, getAllOrdersLocal } from '@/lib/offlineStore';
import { getOutboxSnapshot } from '@/lib/syncManager';
import { queueOp } from '@/lib/offlineSyncClient';
import { requirePaymentPin } from '@/lib/paymentPin';
import { fetchRackMapFromDb, normalizeRackSlots } from '@/lib/rackLocations';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildSmartSmsText } from '@/lib/smartSms';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';
import { clearPageSnapshot, readPageSnapshot, writePageSnapshot } from '@/lib/pageSnapshotCache';
import { clearBaseMasterCacheScope, ensureFreshBaseMasterCache, getBaseRowsByStatus, patchBaseMasterRow, patchBaseMasterRows, readBaseMasterCache, reconcileBaseMasterCacheScope, writeBaseMasterCache } from '@/lib/baseMasterCache';
import useRouteAlive from '@/lib/routeAlive';
import { isDiagEnabled } from '@/lib/diagMode';
import { listBaseCreateRecovery } from '@/lib/syncRecovery';

const RackLocationModal = React.lazy(() => import('@/components/RackLocationModal'));

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
    try { console.warn('[GATI] reconcile lazy load failed; using fallback merge', err); } catch {}
  }
  return fallbackReconciledRows(args);
}

async function safeRecordReconcileTombstone(payload, options) {
  try {
    const mod = await import('@/lib/reconcile/tombstones');
    if (typeof mod?.recordReconcileTombstone === 'function') return mod.recordReconcileTombstone(payload, options);
  } catch (err) {
    try { console.warn('[GATI] tombstone lazy load failed; continuing', err); } catch {}
  }
  return null;
}

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const BUCKET = 'tepiha-photos';
const PAY_CHIPS = [5, 10, 20, 30, 50];
const GATI_EDIT_TO_PRANIMI_KEY = 'tepiha_gati_edit_to_pranimi_v1';
const GATI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_gati_edit_to_pranimi_backup_v1';
const GATI_DB_TIMEOUT_MS = 9000;

const localShadowTimers = new Map();
function scheduleLocalShadowWrite(key, value, delay = 450) {
  try {
    const prev = localShadowTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      localShadowTimers.delete(key);
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }, delay);
    localShadowTimers.set(key, timer);
  } catch {}
}

const GATI_DEBUG_KEY = '__tepiha_gati_debug_v1__';
const GATI_FETCH_LIMIT = 200;

const AUDIT_STATUS = {
  UNVERIFIED: 'unverified',
  SEEN_IN_DEPOT: 'seen_in_depot',
  NOT_FOUND: 'not_found',
  HANDED_TO_CLIENT: 'handed_to_client',
  MOVED_LOCATION: 'moved_location',
  NEEDS_REVIEW: 'needs_review',
};

const AUDIT_STATUS_LABELS = {
  [AUDIT_STATUS.UNVERIFIED]: 'PA U VERIFIKU',
  [AUDIT_STATUS.SEEN_IN_DEPOT]: 'U PA NË DEPO',
  [AUDIT_STATUS.NOT_FOUND]: 'NUK U GJET',
  [AUDIT_STATUS.HANDED_TO_CLIENT]: 'IU DHA KLIENTIT',
  [AUDIT_STATUS.MOVED_LOCATION]: 'NË RAFT TJETËR / LOKACION TJETËR',
  [AUDIT_STATUS.NEEDS_REVIEW]: 'NË KONTEST / KËRKON KONTROLL',
};

const AUDIT_PAYMENT_STATUS_LABELS = {
  paid: 'PO',
  unpaid: 'JO',
  partial: 'PJESËRISHT',
};

function normalizeAuditStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return AUDIT_STATUS.UNVERIFIED;
  if (raw === 'u_pa_ne_depo' || raw === 'u pa ne depo' || raw === 'u pa në depo' || raw === 'seen' || raw === 'seen_in_depot') return AUDIT_STATUS.SEEN_IN_DEPOT;
  if (raw === 'nuk_u_gjet' || raw === 'nuk u gjet' || raw === 'not_found') return AUDIT_STATUS.NOT_FOUND;
  if (raw === 'iu_dha_klientit' || raw === 'iu dha klientit' || raw === 'handed_to_client' || raw === 'delivered_to_client') return AUDIT_STATUS.HANDED_TO_CLIENT;
  if (raw === 'ne_raft_tjeter' || raw === 'në raft tjetër' || raw === 'ne lokacion tjeter' || raw === 'në lokacion tjetër' || raw === 'moved_location' || raw === 'moved') return AUDIT_STATUS.MOVED_LOCATION;
  if (raw === 'kerkon_kontroll' || raw === 'kërkon kontroll' || raw === 'ne_kontest' || raw === 'në kontest' || raw === 'needs_review' || raw === 'contest') return AUDIT_STATUS.NEEDS_REVIEW;
  if (raw === 'pa_u_verifiku' || raw === 'pa u verifiku' || raw === 'unverified') return AUDIT_STATUS.UNVERIFIED;
  return raw;
}

function normalizeAuditPaymentStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'po' || raw === 'paid') return 'paid';
  if (raw === 'jo' || raw === 'unpaid' || raw === 'no') return 'unpaid';
  if (raw === 'pjeserisht' || raw === 'pjesërisht' || raw === 'partial') return 'partial';
  return raw;
}

function getAuditStatusLabel(status) {
  return AUDIT_STATUS_LABELS[normalizeAuditStatus(status)] || String(status || '').trim() || AUDIT_STATUS_LABELS[AUDIT_STATUS.UNVERIFIED];
}

function formatAuditDateTime(value) {
  const d = new Date(value || Date.now());
  if (Number.isNaN(d.getTime())) return '--';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function sameCalendarDay(a, b) {
  const da = new Date(a || 0);
  const db = new Date(b || 0);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function auditHistoryArray(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const status = normalizeAuditStatus(item.status || item.audit_status || '');
      const at = String(item.at || item.audited_at || item.ts || '').trim();
      return {
        id: String(item.id || `audit_${index}_${at || '0'}`).trim(),
        status,
        label: getAuditStatusLabel(status),
        at,
        by_name: String(item.by_name || item.audited_by_name || item.by || '').trim(),
        by_pin: String(item.by_pin || item.audited_by_pin || '').trim(),
        note: String(item.note || '').trim(),
        location: String(item.location || '').trim(),
        handed_to_name: String(item.handed_to_name || '').trim(),
        payment_status: normalizeAuditPaymentStatus(item.payment_status || item?.payment_snapshot?.payment_status || ''),
        amount_taken: Number(item.amount_taken ?? item?.payment_snapshot?.amount_taken ?? 0) || 0,
        debt_remaining: Number(item.debt_remaining ?? item?.payment_snapshot?.debt_remaining ?? 0) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
}

function readAuditState(source, row = {}) {
  const data = source && typeof source === 'object' ? source : {};
  const rowData = row?.data && typeof row.data === 'object' ? row.data : {};
  const rawAudit = (data?.audit && typeof data.audit === 'object')
    ? data.audit
    : (rowData?.audit && typeof rowData.audit === 'object')
      ? rowData.audit
      : (row?.audit && typeof row.audit === 'object')
        ? row.audit
        : {};

  const history = auditHistoryArray(rawAudit.history);
  const candidateLast = rawAudit.last_event && typeof rawAudit.last_event === 'object' ? rawAudit.last_event : null;
  const lastEvent = candidateLast
    ? auditHistoryArray([candidateLast])[0] || history[0] || null
    : history[0] || null;

  const status = normalizeAuditStatus(
    rawAudit.status
      || rawAudit.audit_status
      || data?.audit_status
      || row?.audit_status
      || lastEvent?.status
      || ''
  );

  const paymentSnapshotRaw = rawAudit.payment_snapshot && typeof rawAudit.payment_snapshot === 'object'
    ? rawAudit.payment_snapshot
    : lastEvent
      ? {
          payment_status: lastEvent.payment_status,
          amount_taken: lastEvent.amount_taken,
          debt_remaining: lastEvent.debt_remaining,
        }
      : {};

  return {
    status,
    label: getAuditStatusLabel(status),
    audited_at: String(rawAudit.audited_at || lastEvent?.at || '').trim(),
    audited_by_name: String(rawAudit.audited_by_name || lastEvent?.by_name || '').trim(),
    audited_by_pin: String(rawAudit.audited_by_pin || lastEvent?.by_pin || '').trim(),
    note: String(rawAudit.note || lastEvent?.note || '').trim(),
    location: String(rawAudit.location || lastEvent?.location || '').trim(),
    handed_to_name: String(rawAudit.handed_to_name || lastEvent?.handed_to_name || '').trim(),
    paymentSnapshot: {
      payment_status: normalizeAuditPaymentStatus(paymentSnapshotRaw.payment_status || ''),
      amount_taken: Number(paymentSnapshotRaw.amount_taken ?? 0) || 0,
      debt_remaining: Number(paymentSnapshotRaw.debt_remaining ?? 0) || 0,
    },
    lastEvent,
    history,
  };
}

function deriveAuditDiscrepancy(row) {
  const audit = row?.audit && typeof row.audit === 'object' ? row.audit : readAuditState(row?.fullOrder || row || {}, row || {});
  const status = normalizeAuditStatus(audit?.status || '');
  const operationalStatus = normalizeGatiStatus(
    row?.status
      || row?.fullOrder?.status
      || row?.fullOrder?.state
      || row?.fullOrder?.data?.status
      || row?.fullOrder?.data?.state
      || ''
  );

  if (operationalStatus === 'gati' && status === AUDIT_STATUS.HANDED_TO_CLIENT) {
    return { code: 'delivered_not_closed', label: 'DORËZUAR FIZIKISHT, JO MBYLLUR NË SISTEM' };
  }
  if (operationalStatus === 'gati' && status === AUDIT_STATUS.NOT_FOUND) {
    return { code: 'ready_not_found', label: 'GATI NË SISTEM, POR NUK U GJET' };
  }
  if ((operationalStatus === 'dorzim' || operationalStatus === 'marrje') && status === AUDIT_STATUS.SEEN_IN_DEPOT) {
    return { code: 'closed_but_present', label: 'MBYLLUR NË SISTEM, POR U PA NË DEPO' };
  }

  const payStatus = normalizeAuditPaymentStatus(audit?.paymentSnapshot?.payment_status || audit?.lastEvent?.payment_status || '');
  const debtRemaining = Number(audit?.paymentSnapshot?.debt_remaining ?? audit?.lastEvent?.debt_remaining ?? 0) || 0;
  if (status === AUDIT_STATUS.HANDED_TO_CLIENT && (payStatus === 'unpaid' || payStatus === 'partial' || debtRemaining > 0.009)) {
    return { code: 'delivery_payment_review', label: 'DORËZIM FIZIK ME PAGESË PËR KONTROLL' };
  }

  return null;
}

function buildAuditBadge(row) {
  const audit = row?.audit && typeof row.audit === 'object' ? row.audit : readAuditState(row?.fullOrder || row || {}, row || {});
  const discrepancy = deriveAuditDiscrepancy({ ...(row || {}), audit });
  if (discrepancy) return { text: 'NË MOSPËRPUTHJE', bg: '#7f1d1d', color: '#fecaca' };

  const status = normalizeAuditStatus(audit?.status || '');
  const auditedAt = audit?.audited_at;
  const now = Date.now();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);

  if (status === AUDIT_STATUS.SEEN_IN_DEPOT && auditedAt && sameCalendarDay(auditedAt, now)) {
    return { text: 'E VERIFIKUAR SOT', bg: 'rgba(34,197,94,0.15)', color: '#86efac' };
  }
  if (status === AUDIT_STATUS.SEEN_IN_DEPOT && auditedAt && sameCalendarDay(auditedAt, yesterday)) {
    return { text: 'E VERIFIKUAR DJE', bg: 'rgba(245,158,11,0.15)', color: '#fcd34d' };
  }
  if (status === AUDIT_STATUS.UNVERIFIED) {
    return { text: 'PA U VERIFIKU', bg: 'rgba(107,114,128,0.18)', color: '#d1d5db' };
  }
  if (status === AUDIT_STATUS.NOT_FOUND) {
    return { text: 'NUK U GJET', bg: 'rgba(239,68,68,0.15)', color: '#fca5a5' };
  }
  if (status === AUDIT_STATUS.HANDED_TO_CLIENT) {
    return { text: 'IU DHA KLIENTIT', bg: 'rgba(59,130,246,0.16)', color: '#93c5fd' };
  }
  if (status === AUDIT_STATUS.MOVED_LOCATION) {
    return { text: 'RAFT TJETËR', bg: 'rgba(168,85,247,0.16)', color: '#d8b4fe' };
  }
  if (status === AUDIT_STATUS.NEEDS_REVIEW) {
    return { text: 'KËRKON KONTROLL', bg: 'rgba(251,191,36,0.16)', color: '#fde68a' };
  }

  return { text: getAuditStatusLabel(status), bg: 'rgba(107,114,128,0.18)', color: '#e5e7eb' };
}

function gatiDbg(type, data = {}) {
  if (!isDiagEnabled()) return null;

  const entry = {
    ts: Date.now(),
    at: new Date().toISOString(),
    type,
    data: data || {},
  };

  try { bootLog(type, data || {}); } catch {}

  try {
    if (typeof window !== 'undefined') {
      const prev = JSON.parse(sessionStorage.getItem(GATI_DEBUG_KEY) || '[]');
      prev.push(entry);
      while (prev.length > 400) prev.shift();
      sessionStorage.setItem(GATI_DEBUG_KEY, JSON.stringify(prev));
    }
  } catch {}

  try { console.log('[GATI_DEBUG]', type, data || {}); } catch {}
  return entry;
}

function getActorDebug() {
  const actor = readActor() || {};
  return {
    pin: String(actor?.pin || actor?.transport_id || actor?.id || '').trim(),
    role: String(actor?.role || '').trim(),
    isHybrid: !!(actor?.is_hybrid_transport || actor?.isHybridTransport || actor?.hybrid_transport || actor?.hybridTransport),
    name: String(actor?.name || '').trim(),
  };
}

function gatiRowId(row) {
  return String(row?.id || row?.local_oid || row?.oid || '').trim();
}

function gatiRowCode(row) {
  return normalizeCode(row?.code || row?.code_n || row?.fullOrder?.code || row?.fullOrder?.client?.code || row?.data?.code || '');
}

function buildGatiRowsSignature(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    return [
      gatiRowId(row),
      gatiRowCode(row),
      Number(row?.readyTs || row?.ts || 0),
      Number(row?.m2 || 0),
      Number(row?.cope || 0),
      Number(row?.total || 0),
      Number(row?.paid || 0),
      String(row?.readyNote || row?.ready_location || row?.ready_note_text || ''),
      String(row?.updated_at || row?.fullOrder?.updated_at || ''),
      String(row?.status || row?.fullOrder?.status || row?.fullOrder?.state || ''),
    ].join('¦');
  }).join('||');
}

function normalizeGatiStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'pranimi') return 'pranim';
  if (raw === 'pastrimi') return 'pastrim';
  if (raw === 'marrje_sot') return 'marrje';
  if (raw === 'dorezim' || raw === 'dorëzim' || raw === 'dorëzuar' || raw === 'dorezuar') return 'dorzim';
  return raw;
}

function unwrapGatiOrder(raw) {
  let value = raw;
  if (!value) return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let data = value?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...value, ...data, data };
  }
  return value;
}

function extractGatiStatus(row, orderInput = null) {
  const order = orderInput && typeof orderInput === 'object' ? orderInput : unwrapGatiOrder(row?.data || row || {});
  return normalizeGatiStatus(
    row?.status
      || order?.status
      || order?.state
      || order?.statusi
      || order?.workflow_status
      || order?.data?.status
      || order?.data?.state
      || order?.data?.statusi
      || order?.data?.workflow_status
      || ''
  );
}

function isGatiRowLike(row, orderInput = null) {
  return extractGatiStatus(row, orderInput) === 'gati';
}

function readGatiReadyMeta(source, row = {}) {
  const data = source && typeof source === 'object' ? source : {};
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
  return { readyNote, readyText, readyLocation, readySlots };
}

function mapBaseCacheRowToGati(row) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const total = Number(row?.total_price || data?.price_total || data?.pay?.euro || 0);
  const paid = Number(row?.paid_amount || data?.paid_cash || data?.pay?.paid || 0);
  const computedM2 = computeM2(data);
  const computedPieces = computePieces(data);
  const readyMeta = readGatiReadyMeta(data, row || {});
  return {
    id: String(row?.id || row?.local_oid || ''),
    ts: Number(data?.ts || 0),
    readyTs: Date.parse(row?.updated_at || row?.created_at || 0) || Date.now(),
    name: row?.client_name || data?.client_name || data?.client?.name || 'Pa Emër',
    phone: row?.client_phone || data?.client_phone || data?.client?.phone || '',
    code: normalizeCode(row?.code || data?.code || data?.client?.code || ''),
    m2: Number((computedM2 > 0 ? computedM2 : (row?.total_m2 || 0)) || 0),
    cope: Number((computedPieces > 0 ? computedPieces : (row?.pieces || 0)) || 0),
    total,
    paid,
    paidUpfront: !!data?.pay?.paidUpfront,
    isReturn: !!data?.returnInfo?.active,
    readyNote: readyMeta.readyNote,
    ready_location: readyMeta.readyLocation,
    ready_note_text: readyMeta.readyText,
    ready_slots: readyMeta.readySlots,
    fullOrder: {
      ...data,
      ready_note: readyMeta.readyNote,
      ready_note_text: readyMeta.readyText,
      ready_location: readyMeta.readyLocation,
      ready_slots: readyMeta.readySlots,
    },
    _masterCache: true,
  };
}

function readGatiRowsFromBaseMasterCache(cache = null) {
  try {
    return (getBaseRowsByStatus('gati', cache) || []).map(mapBaseCacheRowToGati);
  } catch {
    return [];
  }
}

function readGatiRowsFromPageSnapshot() {
  try {
    const snapshot = readPageSnapshot('gati');
    return (Array.isArray(snapshot?.rows) ? snapshot.rows : []).map((row) => ({
      ...(row && typeof row === 'object' ? row : {}),
      _pageSnapshot: true,
      source: String(row?.source || 'PAGE_SNAPSHOT'),
    }));
  } catch {
    return [];
  }
}

function persistGatiPageSnapshot(rows = [], meta = {}) {
  try {
    const cleanRows = dedupeGatiSnapshotRows(Array.isArray(rows) ? rows : [])
      .filter((row) => !/^T\d+$/i.test(String(row?.code || '').trim()))
      .map((row) => {
        const next = row && typeof row === 'object' ? { ...row } : row;
        if (next && typeof next === 'object') {
          delete next._pageSnapshot;
          delete next._masterCache;
        }
        return next;
      });
    if (cleanRows.length > 0) writePageSnapshot('gati', cleanRows, meta);
    else clearPageSnapshot('gati');
  } catch {}
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

function mapLocalOrderToGatiRow(sourceRow = {}) {
  const order = unwrapGatiOrder(sourceRow || {});
  const m2 = computeM2(order);
  const total = Number(order.pay?.euro || computeTotalEuro(order));
  const paid = Number(order.pay?.paid || 0);
  const cope = computePieces(order);
  const readyTs = Number(order.ready_at || order.readyAt || order.ts || 0) || Date.now();
  const readyMeta = readGatiReadyMeta(order, sourceRow || {});
  return {
    id: String(order.id || order.local_oid || ''),
    local_oid: String(order.local_oid || order.oid || order.id || ''),
    source: String(order._synced === false ? 'OUTBOX' : 'LOCAL'),
    ts: Number(order.ts || 0),
    updated_at: String(order.updated_at || ''),
    readyTs,
    name: order.client?.name || order.client_name || '',
    phone: order.client?.phone || order.client_phone || '',
    code: normalizeCode(order.client?.code || order.code || ''),
    m2,
    cope,
    total,
    paid,
    paidUpfront: !!order.pay?.paidUpfront,
    isReturn: !!order.returnInfo?.active,
    readyNote: readyMeta.readyNote,
    ready_location: readyMeta.readyLocation,
    ready_note_text: readyMeta.readyText,
    ready_slots: readyMeta.readySlots,
    fullOrder: {
      ...order,
      ready_note: readyMeta.readyNote,
      ready_note_text: readyMeta.readyText,
      ready_location: readyMeta.readyLocation,
      ready_slots: readyMeta.readySlots,
    },
  };
}

function dedupeGatiSnapshotRows(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row?.id || '').trim();
    const localOid = String(row?.local_oid || row?.fullOrder?.local_oid || row?.fullOrder?.oid || '').trim();
    const code = normalizeCode(row?.code || row?.fullOrder?.code || row?.fullOrder?.client?.code || '');
    const key = id && isPersistedDbLikeId(id)
      ? `db:${id}`
      : localOid
        ? `local:${localOid}`
        : code
          ? `code:${code}`
          : id
            ? `tmp:${id}`
            : '';
    if (!key) continue;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }

    const prevPriority = prev?._masterCache ? 4 : String(prev?.source || '').toUpperCase() === 'OUTBOX' ? 3 : prev?._pageSnapshot ? 0 : 2;
    const nextPriority = row?._masterCache ? 4 : String(row?.source || '').toUpperCase() === 'OUTBOX' ? 3 : row?._pageSnapshot ? 0 : 2;
    const prevTs = Math.max(Number(prev?.readyTs || 0), Number(prev?.ts || 0), Date.parse(prev?.updated_at || 0) || 0);
    const nextTs = Math.max(Number(row?.readyTs || 0), Number(row?.ts || 0), Date.parse(row?.updated_at || 0) || 0);

    if (nextPriority > prevPriority || (nextPriority === prevPriority && nextTs >= prevTs)) {
      byKey.set(key, row);
    }
  }

  return Array.from(byKey.values())
    .filter((row) => !/^T\d+$/i.test(String(row?.code || '').trim()))
    .sort((a, b) => (Number(b?.readyTs || 0) - Number(a?.readyTs || 0)));
}

async function buildImmediateGatiLocalRows() {
  const pageSnapshotRows = readGatiRowsFromPageSnapshot();
  const masterCacheRows = readGatiRowsFromBaseMasterCache();
  const local = await getAllOrdersLocal().catch(() => []);
  const localRows = (Array.isArray(local) ? local : [])
    .filter((o) => isGatiRowLike(o))
    .map(mapLocalOrderToGatiRow);
  return dedupeGatiSnapshotRows([
    ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),
    ...(Array.isArray(masterCacheRows) ? masterCacheRows : []),
    ...localRows,
  ]);
}

// ---------------- HELPERS ----------------
function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function isPlaceholderCode(raw) {
  const s = String(raw ?? '').trim();
  return !s || s === '—' || s === '-' || s === '0' || /^pa\s*kod$/i.test(s);
}

function pickFirstValidCode(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (isPlaceholderCode(value)) continue;
    const normalized = normalizeCode(value);
    if (normalized && normalized !== '0') return normalized;
  }
  return '';
}

function flattenOrderForPersist(order) {
  if (!order || typeof order !== 'object') return {};
  if (order.order && typeof order.order === 'object') {
    const nested = order.order;
    const nestedHasStructured = !!(nested?.client || nested?.tepiha || nested?.tepihaRows || nested?.staza || nested?.stazaRows || nested?.pay);
    if (nestedHasStructured) return { ...nested };
  }
  return { ...order };
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/[^\d+]+/g, '');
}

function rowQty(row) {
  return Number(row?.qty ?? row?.pieces ?? 0) || 0;
}

function rowM2(row) {
  return Number(row?.m2 ?? row?.m ?? row?.area ?? 0) || 0;
}

function extractArray(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) return obj[k];
    if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[k]) && obj.data[k].length > 0) return obj.data[k];
  }
  return [];
}
function getTepihaRows(order) { return extractArray(order, 'tepiha', 'tepihaRows'); }
function getStazaRows(order) { return extractArray(order, 'staza', 'stazaRows'); }
function getStairsQty(order) {
  if (!order || typeof order !== 'object') return 0;
  return Number(order?.shkallore?.qty) || Number(order?.data?.shkallore?.qty) || Number(order?.stairsQty) || Number(order?.data?.stairsQty) || 0;
}
function getStairsPer(order) {
  if (!order || typeof order !== 'object') return 0.3;
  return Number(order?.shkallore?.per) || Number(order?.data?.shkallore?.per) || Number(order?.stairsPer) || Number(order?.data?.stairsPer) || 0.3;
}
function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  for (const r of getTepihaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}

function computeTotalEuro(order) {
  if (!order) return 0;
  if (order.pay && typeof order.pay.euro === 'number') return Number(order.pay.euro) || 0;
  const m2 = computeM2(order);
  const rate = Number(order.pay?.rate || 0);
  return Number((m2 * rate).toFixed(2));
}

const round2 = (n) => {
  const num = Number(n || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
};

function computePieces(order) {
  if (!order) return 0;
  let p = 0;
  for (const r of getTepihaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  p += getStairsQty(order);
  return p;
}

function explodeReturnPieces(order) {
  const out = [];
  let idx = 0;
  for (const r of getTepihaRows(order)) {
    const qty = rowQty(r);
    const m2 = rowM2(r);
    for (let i = 0; i < qty; i += 1) out.push({ id: `t_${idx++}`, kind: 'tepiha', m2, selected: true });
  }
  for (const r of getStazaRows(order)) {
    const qty = rowQty(r);
    const m2 = rowM2(r);
    for (let i = 0; i < qty; i += 1) out.push({ id: `s_${idx++}`, kind: 'staza', m2, selected: true });
  }
  const stairsQty = getStairsQty(order);
  const stairsPer = getStairsPer(order);
  for (let i = 0; i < stairsQty; i += 1) out.push({ id: `k_${idx++}`, kind: 'shkallore', m2: stairsPer, selected: true });
  return out;
}

function aggregateReturnPieces(items) {
  const res = { tepiha: [], staza: [], shkallore: { qty: 0, per: 0.3 } };
  const mapT = new Map();
  const mapS = new Map();
  for (const it of items || []) {
    const m2 = Number(it?.m2 || 0) || 0;
    if (m2 <= 0) continue;
    if (it.kind === 'tepiha') mapT.set(m2, (mapT.get(m2) || 0) + 1);
    else if (it.kind === 'staza') mapS.set(m2, (mapS.get(m2) || 0) + 1);
    else if (it.kind === 'shkallore') {
      res.shkallore.per = m2;
      res.shkallore.qty += 1;
    }
  }
  res.tepiha = Array.from(mapT.entries()).map(([m2, qty]) => ({ m2: Number(m2), qty }));
  res.staza = Array.from(mapS.entries()).map(([m2, qty]) => ({ m2: Number(m2), qty }));
  return res;
}
function triggerFatalCacheHeal() {
  console.error('Fatal Cache Error Detected. Auto-healing...');
  try { localStorage.removeItem('tepiha_offline_queue_v1'); } catch {}
  try { localStorage.removeItem('tepiha_local_orders_v1'); } catch {}
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

function getGatiRowMatchTokens(row) {
  const id = String(row?.id || row?.db_id || row?.server_id || '').trim();
  const localOid = String(row?.local_oid || row?.oid || row?.fullOrder?.local_oid || row?.fullOrder?.oid || row?.data?.local_oid || row?.data?.oid || '').trim();
  const code = normalizeCode(row?.code || row?.code_n || row?.fullOrder?.code || row?.fullOrder?.client?.code || row?.data?.code || row?.data?.client?.code || '');
  const tokens = [];
  if (localOid) tokens.push(`local:${localOid}`);
  if (id && isPersistedDbLikeId(id)) tokens.push(`id:${id}`);
  if (code) tokens.push(`code:${code}`);
  return Array.from(new Set(tokens));
}

function rowLooksPendingOrLocalGati(row) {
  const source = String(row?.source || '').trim().toUpperCase();
  const id = String(row?.id || row?.local_oid || row?.oid || '').trim();
  if (source === 'OUTBOX' || source === 'LOCAL') return true;
  if (!isPersistedDbLikeId(id)) return true;
  return !!(
    row?._pendingMutation ||
    row?._local === true ||
    row?._synced === false ||
    row?._syncPending === true ||
    Number(row?.pending_ops || 0) > 0
  );
}

function purgeGhostRowArtifacts(row, reason = 'ghost_row_cleanup') {
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
      const scopedStatus = ['gati', 'dorzim', 'marrje'].includes(String(item?.status || '').trim().toLowerCase());
      return !(scopedStatus && (sameId || sameCode));
    });
    if (filteredRows.length !== rows.length) writeBaseMasterCache({ ...cache, rows: filteredRows });
  } catch {}

  gatiDbg('gati_ghost_row_purged', { reason, ids, code });
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

function formatDayMonth(ts) {
  const d = new Date(ts || Date.now());
  if (Number.isNaN(d.getTime())) return '--/--';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

// ---------------- COMPONENT ----------------
function GatiPageInner() {
  useRouteAlive('gati_page');
  const router = useRouter();
  const sp = useSearchParams();
  const exactMode = String(sp?.get('exact') || '') === '1';
  const openId = String(sp?.get('openId') || '').trim();

  const holdTimer = useRef(null);
  const holdFired = useRef(false);

  const [orders, setOrders] = useState([]);
  const [readyCountHint, setReadyCountHint] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [auditMode, setAuditMode] = useState(false);
  const [showAuditSheet, setShowAuditSheet] = useState(false);
  const [auditOrder, setAuditOrder] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState('');
  const [auditActionMode, setAuditActionMode] = useState('');
  const [auditLocationInput, setAuditLocationInput] = useState('');
  const [auditNoteInput, setAuditNoteInput] = useState('');
  const [auditHandedToName, setAuditHandedToName] = useState('');
  const [auditPaymentStatus, setAuditPaymentStatus] = useState('paid');
  const [auditAmountTaken, setAuditAmountTaken] = useState('');
  const [auditDebtRemaining, setAuditDebtRemaining] = useState('0');

  const [showPlace, setShowPlace] = useState(false);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeErr, setPlaceErr] = useState('');
  const [placeOrderId, setPlaceOrderId] = useState(null);
  const [placeOrder, setPlaceOrder] = useState(null);
  const [placeText, setPlaceText] = useState('');
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [slotMap, setSlotMap] = useState({});
  const [smsModal, setSmsModal] = useState({ open: false, phone: '', text: '' });
  const smsOpenReqRef = useRef(0);

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [payOrder, setPayOrder] = useState(null);
  const [payAdd, setPayAdd] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');

  const [showReturnSheet, setShowReturnSheet] = useState(false);
  const [retOrder, setRetOrder] = useState(null);
  const [retReason, setRetReason] = useState('');
  const [retPhotoUrl, setRetPhotoUrl] = useState('');
  const [retItems, setRetItems] = useState([]);
  const [retPayMode, setRetPayMode] = useState('original');
  const [retBusy, setRetBusy] = useState(false);
  const [retErr, setRetErr] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const returnPhotoInputRef = useRef(null);

  const [showCodeMenu, setShowCodeMenu] = useState(false);
  const [menuOrder, setMenuOrder] = useState(null);

  const [showEditSheet, setShowEditSheet] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [editTepihaRows, setEditTepihaRows] = useState([{ id: 't1', m2: '', qty: '' }]);
  const [editStazaRows, setEditStazaRows] = useState([{ id: 's1', m2: '', qty: '' }]);
  const [editStairsQty, setEditStairsQty] = useState('0');
  const [editStairsPer, setEditStairsPer] = useState('0.3');
  const deferredPersistTimer = useRef(null);
  const deferredPersistToken = useRef(0);
  const localPendingTimer = useRef(null);
  const refreshSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const lastVisibleIdsRef = useRef(new Set());
  const resumeRefreshTimerRef = useRef(null);
  const lastResumeRefreshAtRef = useRef(0);
  const lastHiddenAtRef = useRef(0);
  const lastPageshowAtRef = useRef(0);
  const mountStartedAtRef = useRef(Date.now());
  const refreshInFlightRef = useRef(false);
  const autoRefreshCooldownUntilRef = useRef(0);
  const queuedAutoRefreshReasonRef = useRef('');
  const uiReadyMarkedRef = useRef(false);
  const currentOrdersRef = useRef([]);
  const lastOrdersSignatureRef = useRef('');

  function scheduleDeferredCachePersist(rows = [], delay = 4200) {
    try {
      deferredPersistToken.current += 1;
      const token = deferredPersistToken.current;
      const safeRows = Array.isArray(rows) ? rows.slice(0, 120).map((row) => ({ ...row })) : [];
      if (deferredPersistTimer.current) clearTimeout(deferredPersistTimer.current);
      deferredPersistTimer.current = window.setTimeout(() => {
        deferredPersistTimer.current = null;
        if (token !== deferredPersistToken.current) return;
        const commit = () => {
          if (token !== deferredPersistToken.current) return;
          try { if (safeRows.length) patchBaseMasterRows(safeRows); } catch {}
        };
        try {
          if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => commit(), { timeout: 2500 });
          } else {
            window.setTimeout(commit, 0);
          }
        } catch {
          commit();
        }
      }, delay);
    } catch {}
  }

  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
  }, [sp]);

  useEffect(() => {
    refreshOrders('mount');
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (deferredPersistTimer.current) clearTimeout(deferredPersistTimer.current);
      if (localPendingTimer.current) clearTimeout(localPendingTimer.current);
      if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
      queuedAutoRefreshReasonRef.current = '';
      refreshInFlightRef.current = false;
      deferredPersistToken.current += 1;
    };
  }, []);

  useEffect(() => {
    const safeRows = Array.isArray(orders) ? orders : [];
    currentOrdersRef.current = safeRows;
    lastOrdersSignatureRef.current = buildGatiRowsSignature(safeRows);
  }, [orders]);

  function applyOrdersIfChanged(nextRows, meta = {}) {
    const safeRows = Array.isArray(nextRows) ? nextRows : [];
    const nextSig = buildGatiRowsSignature(safeRows);
    const prevSig = String(lastOrdersSignatureRef.current || '');
    if (prevSig === nextSig) {
      gatiDbg('gati_rows_unchanged_skip_set', {
        ...(meta || {}),
        count: safeRows.length,
      });
      return false;
    }
    currentOrdersRef.current = safeRows;
    lastOrdersSignatureRef.current = nextSig;
    setOrders(safeRows);
    return true;
  }

  useEffect(() => {
    if (loading) return;
    const visibleCount = Array.isArray(orders) ? orders.length : 0;
    const hintCount = Number.isFinite(Number(readyCountHint)) ? Number(readyCountHint) : 0;
    const readyCount = visibleCount > 0 ? visibleCount : hintCount;
    try {
      bootLog('ui_ready', {
        page: 'gati',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
        count: readyCount,
        source: uiReadyMarkedRef.current ? 'state_repeat' : 'state_first',
      });
    } catch {}
    if (uiReadyMarkedRef.current) return;
    uiReadyMarkedRef.current = true;
    try {
      bootMarkReady({
        source: 'gati_page',
        page: 'gati',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
        count: readyCount,
      });
    } catch {}
  }, [loading, orders.length, readyCountHint]);

  useEffect(() => {
    if (isWithinStartupIsolationWindow()) {
      gatiDbg('gati_resume_isolation_skip', {
        path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
        leftMs: getStartupIsolationLeftMs(),
      });
      return undefined;
    }

    gatiDbg('gati_mount', {
      path: typeof window !== 'undefined' ? (window.location.pathname || '') : '/gati',
      actor: getActorDebug(),
    });
    try { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') lastHiddenAtRef.current = Date.now(); } catch {}

    try {
      window.__dumpGatiDebug = () => {
        try { return JSON.parse(sessionStorage.getItem(GATI_DEBUG_KEY) || '[]'); } catch { return []; }
      };
      window.__clearGatiDebug = () => {
        try { sessionStorage.removeItem(GATI_DEBUG_KEY); } catch {}
      };
    } catch {}

    const queueRefresh = (reason, extra = {}) => {
      const now = Date.now();
      const since = now - Number(lastResumeRefreshAtRef.current || 0);
      const hiddenElapsedMs = lastHiddenAtRef.current ? Math.max(0, now - Number(lastHiddenAtRef.current || 0)) : 0;
      const persisted = !!extra?.persisted;
      if (reason === 'pageshow_visible') lastPageshowAtRef.current = now;
      if ((reason === 'focus_visible' || reason === 'visibility_visible') && lastHiddenAtRef.current && hiddenElapsedMs < 1200) {
        gatiDbg('gati_resume_refresh_skip_short_hidden', { reason, hiddenElapsedMs, ...(extra || {}) });
        return;
      }
      if (reason === 'visibility_visible' && lastPageshowAtRef.current && (now - Number(lastPageshowAtRef.current || 0)) < 1800) {
        gatiDbg('gati_resume_refresh_skip_after_pageshow', { reason, hiddenElapsedMs, ...(extra || {}) });
        return;
      }
      if (now < Number(autoRefreshCooldownUntilRef.current || 0)) {
        const remainingMs = Math.max(0, Number(autoRefreshCooldownUntilRef.current || 0) - now);
        queuedAutoRefreshReasonRef.current = reason;
        gatiDbg('gati_resume_refresh_skip_cooldown', { reason, hiddenElapsedMs, remainingMs, ...(extra || {}) });
        if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
        resumeRefreshTimerRef.current = window.setTimeout(() => {
          resumeRefreshTimerRef.current = null;
          const queuedReason = String(queuedAutoRefreshReasonRef.current || '').trim();
          queuedAutoRefreshReasonRef.current = '';
          if (queuedReason) queueRefresh(queuedReason, { source: 'queued_after_cooldown' });
        }, Math.max(remainingMs + 60, 220));
        return;
      }
      const fire = () => {
        lastResumeRefreshAtRef.current = Date.now();
        gatiDbg('gati_resume_refresh', { reason, hiddenElapsedMs, ...(extra || {}) });
        refreshOrders(reason);
      };

      if (persisted && reason === 'pageshow_visible') {
        if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
        resumeRefreshTimerRef.current = window.setTimeout(fire, 450);
        return;
      }

      if (since < 2200) {
        if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
        resumeRefreshTimerRef.current = window.setTimeout(fire, Math.max(2300 - since, 180));
        return;
      }
      fire();
    };

    const onVisible = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = Date.now();
        if (resumeRefreshTimerRef.current) {
          clearTimeout(resumeRefreshTimerRef.current);
          resumeRefreshTimerRef.current = null;
        }
        queuedAutoRefreshReasonRef.current = '';
        return;
      }
      if (document.visibilityState === 'visible') queueRefresh('visibility_visible');
    };
    const onPageShow = (event) => {
      const persisted = !!event?.persisted;
      const now = Date.now();
      const hiddenElapsedMs = lastHiddenAtRef.current ? Math.max(0, now - Number(lastHiddenAtRef.current || 0)) : 0;
      const sinceMountMs = Math.max(0, now - Number(mountStartedAtRef.current || now));
      if (!persisted && (!lastHiddenAtRef.current || hiddenElapsedMs < 1200) && sinceMountMs < 10000) {
        gatiDbg('gati_pageshow_skip_fresh_navigation', { persisted, hiddenElapsedMs, sinceMountMs });
        return;
      }
      queueRefresh('pageshow_visible', { persisted, hiddenElapsedMs, sinceMountMs });
    };
    const onError = (event) => {
      const url = String(event?.filename || event?.target?.src || event?.target?.href || '').trim();
      if (!url) return;
      if (/\/_next\/static\/chunks\//.test(url)) {
        gatiDbg('gati_resource_error', { url });
      }
    };

    try { document.addEventListener('visibilitychange', onVisible, true); } catch {}
    try { window.addEventListener('pageshow', onPageShow, true); } catch {}
    try { window.addEventListener('error', onError, true); } catch {}

    return () => {
      try { document.removeEventListener('visibilitychange', onVisible, true); } catch {}
      try { window.removeEventListener('pageshow', onPageShow, true); } catch {}
      try { window.removeEventListener('error', onError, true); } catch {}
      if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
      queuedAutoRefreshReasonRef.current = '';
      refreshInFlightRef.current = false;
      gatiDbg('gati_unmount', {
        path: typeof window !== 'undefined' ? (window.location.pathname || '') : '/gati',
      });
    };
  }, []);

  async function dbFetchOrderById(idNum) {
    const numericId = Number(idNum);
    if (!Number.isFinite(numericId) || numericId <= 0) throw new Error('ORDER_NOT_FOUND');
    const data = await fetchOrderByIdSafe(
      'orders',
      numericId,
      'id,status,ready_at,picked_up_at,created_at,updated_at,data,code,client_name,client_phone',
      { timeoutMs: GATI_DB_TIMEOUT_MS }
    );
    if (!data) throw new Error('ORDER_NOT_FOUND');

    const order = { ...(data.data || {}) };
    order.id = String(data.id);
    order.status = data.status;
    order.code = data.code || order.code || order.client?.code || '';
    order.client_name = data.client_name || order.client_name || order.client?.name || '';
    order.client_phone = data.client_phone || order.client_phone || order.client?.phone || '';
    if (!order.client || typeof order.client !== 'object') order.client = {};
    order.client = {
      ...order.client,
      name: order.client?.name || data.client_name || order.client_name || '',
      phone: order.client?.phone || data.client_phone || order.client_phone || '',
      code: order.client?.code || data.code || order.code || '',
    };

    return { row: data, order };
  }

  async function refreshOrders(reason = 'manual') {
    const autoReason = new Set(['mount', 'pageshow_visible', 'visibility_visible', 'focus_visible']).has(String(reason || '').trim());
    const now = Date.now();
    if (autoReason && now < Number(autoRefreshCooldownUntilRef.current || 0)) {
      gatiDbg('gati_refresh_blocked_cooldown', {
        reason,
        remainingMs: Math.max(0, Number(autoRefreshCooldownUntilRef.current || 0) - now),
      });
      return;
    }
    if (refreshInFlightRef.current) {
      if (autoReason) queuedAutoRefreshReasonRef.current = String(reason || 'auto');
      gatiDbg('gati_refresh_skip_inflight', {
        reason,
        queuedReason: queuedAutoRefreshReasonRef.current || '',
      });
      return;
    }

    const seq = Number((refreshSeqRef.current || 0) + 1);
    refreshSeqRef.current = seq;
    refreshInFlightRef.current = true;
    if (autoReason) {
      autoRefreshCooldownUntilRef.current = Date.now() + 1800;
    }
    const currentRows = Array.isArray(currentOrdersRef.current) ? currentOrdersRef.current.slice() : [];
    let syncSnapshot = [];
    try {
      bootLog('before_local_read', {
        page: 'gati',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
        seq,
        reason,
        source: 'master_cache_sync',
      });
      const pageSnapshotRows = dedupeGatiSnapshotRows(readGatiRowsFromPageSnapshot());
      syncSnapshot = dedupeGatiSnapshotRows([
        ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),
        ...readGatiRowsFromBaseMasterCache(),
      ]);
      if (!Array.isArray(syncSnapshot) || syncSnapshot.length === 0) {
        try {
          const hydratedCache = await ensureFreshBaseMasterCache();
          syncSnapshot = dedupeGatiSnapshotRows([
            ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),
            ...readGatiRowsFromBaseMasterCache(hydratedCache),
          ]);
        } catch {}
      }
      bootLog('after_local_read', {
        page: 'gati',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
        seq,
        reason,
        source: 'master_cache_sync',
        count: Array.isArray(syncSnapshot) ? syncSnapshot.length : 0,
      });
    } catch {}

    const hasSyncSnapshot = Array.isArray(syncSnapshot) && syncSnapshot.length > 0;
    const shouldHydrateFromSnapshot = seq === refreshSeqRef.current && hasSyncSnapshot && currentRows.length === 0;
    if (shouldHydrateFromSnapshot) {
      applyOrdersIfChanged(syncSnapshot, { seq, reason, source: 'sync_snapshot' });
      setReadyCountHint(syncSnapshot.length);
      setLoading(false);
      gatiDbg('gati_sync_snapshot_applied', {
        seq,
        reason,
        count: syncSnapshot.length,
      });
    } else if (seq === refreshSeqRef.current && hasSyncSnapshot) {
      gatiDbg('gati_sync_snapshot_skip_live_rows', {
        seq,
        reason,
        snapshotCount: syncSnapshot.length,
        currentRowsCount: currentRows.length,
      });
    }

    const shouldBlockLoading = currentRows.length === 0 && !hasSyncSnapshot;
    if (shouldBlockLoading) setLoading(true);
    else {
      setReadyCountHint(currentRows.length > 0 ? currentRows.length : (hasSyncSnapshot ? syncSnapshot.length : 0));
      setLoading(false);
    }
    gatiDbg('gati_refresh_start', {
      seq,
      reason,
      actor: getActorDebug(),
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      autoReason,
    });
    try {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (isOffline) {
        const offlineRows = await buildImmediateGatiLocalRows().catch(() => []);
        const visibleOfflineRows = dedupeGatiSnapshotRows([
          ...(Array.isArray(offlineRows) ? offlineRows : []),
          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),
          ...currentRows,
        ])
          .filter((row) => !/^T\d+$/i.test(String(row?.code || '').trim()))
          .filter((row) => !isTerminalRecoveryGhostRow(row, buildTerminalRecoveryIndex()))
          .sort((a, b) => (Number(b?.readyTs || b?.ts || 0) - Number(a?.readyTs || a?.ts || 0)));
        if (seq === refreshSeqRef.current && visibleOfflineRows.length > 0) {
          applyOrdersIfChanged(visibleOfflineRows, { seq, reason, source: 'offline_snapshot' });
          setReadyCountHint(visibleOfflineRows.length);
          persistGatiPageSnapshot(visibleOfflineRows, { source: 'offline_snapshot', seq, reason });
        }
        gatiDbg('gati_offline_snapshot_applied', {
          seq,
          reason,
          count: visibleOfflineRows.length,
        });
        setLoading(false);
        return;
      }

      const shouldReadLocalWarm = currentRows.length === 0 && (!Array.isArray(syncSnapshot) || syncSnapshot.length === 0);
      const localWarmPromise = shouldReadLocalWarm ? (async () => {
        try {
          bootLog('before_local_read', {
            page: 'gati',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
            seq,
            reason,
            source: 'local_store_async',
          });
        } catch {}
        const rows = await buildImmediateGatiLocalRows().catch(() => []);
        try {
          bootLog('after_local_read', {
            page: 'gati',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/gati') : '/gati',
            seq,
            reason,
            source: 'local_store_async',
            count: Array.isArray(rows) ? rows.length : 0,
          });
        } catch {}
        return rows;
      })() : Promise.resolve([]);
      let dataError = null;
      const rootGatiPromise = listOrderRecords('orders', {
        select: 'id,status,ready_at,picked_up_at,delivered_at,local_oid,created_at,updated_at,data,code,client_name,client_phone',
        eq: { status: 'gati' },
        orderBy: 'updated_at',
        ascending: false,
        limit: GATI_FETCH_LIMIT,
        timeoutMs: GATI_DB_TIMEOUT_MS,
      }).catch((err) => {
        dataError = dataError || err;
        return [];
      });
      const recentBasePromise = Promise.resolve([]);
      const dataPromise = Promise.all([rootGatiPromise, recentBasePromise]).then(([rootGatiRows, recentBaseRows]) => {
        const merged = new Map();
        for (const row of [...(Array.isArray(rootGatiRows) ? rootGatiRows : []), ...(Array.isArray(recentBaseRows) ? recentBaseRows : [])]) {
          const key = String(row?.id || '').trim() || `${String(row?.code || '').trim()}|${String(row?.updated_at || row?.created_at || '').trim()}`;
          if (!key) continue;
          if (!merged.has(key)) merged.set(key, row);
        }
        return Array.from(merged.values());
      }).catch((err) => {
        dataError = dataError || err;
        return null;
      });

      const warmRows = await localWarmPromise;
      const canApplyWarmRows = (
        seq === refreshSeqRef.current
        && warmRows.length > 0
        && currentRows.length === 0
        && (!Array.isArray(syncSnapshot) || syncSnapshot.length === 0)
      );
      if (canApplyWarmRows) {
        applyOrdersIfChanged(warmRows, { seq, reason, source: 'local_warm' });
        setReadyCountHint(warmRows.length);
        setLoading(false);
        gatiDbg('gati_local_snapshot_applied', {
          seq,
          reason,
          count: warmRows.length,
        });
      } else if (warmRows.length > 0) {
        gatiDbg('gati_local_snapshot_skipped', {
          seq,
          reason,
          count: warmRows.length,
          currentRowsCount: currentRows.length,
          syncSnapshotCount: Array.isArray(syncSnapshot) ? syncSnapshot.length : 0,
        });
      }

      const data = await dataPromise;
      if (dataError) {
        gatiDbg('gati_db_fetch_failed', {
          seq,
          reason,
          message: String(dataError?.message || dataError || ''),
        });
      }

      const dedupeOrders = (rows) => {
        const aliasToCanonical = new Map();
        const canonicalRows = new Map();
        const list = Array.isArray(rows) ? rows : [];

        const rowFreshness = (row) => {
          return Math.max(
            Number(row?.readyTs || 0),
            Number(row?.ts || 0),
            Date.parse(row?.updated_at || 0) || 0,
            Date.parse(row?.created_at || 0) || 0,
          );
        };

        const rowPriority = (row) => {
          const source = String(row?.source || '').trim().toUpperCase();
          if (source === 'DB' || source === 'ORDERS' || source === 'ONLINE') return 5;
          if (row?._masterCache || source === 'BASE_CACHE') return 4;
          if (source === 'LOCAL' || source === 'OUTBOX') return 3;
          return 1;
        };

        const chooseBest = (prev, next) => {
          if (!prev) return next;
          const prevPriority = rowPriority(prev);
          const nextPriority = rowPriority(next);
          if (prevPriority !== nextPriority) return nextPriority > prevPriority ? next : prev;
          const prevFresh = rowFreshness(prev);
          const nextFresh = rowFreshness(next);
          if (prevFresh !== nextFresh) return nextFresh > prevFresh ? next : prev;
          const prevM2 = Number(prev?.m2 || 0);
          const nextM2 = Number(next?.m2 || 0);
          if (prevM2 !== nextM2) return nextM2 > prevM2 ? next : prev;
          return {
            ...prev,
            ...next,
            name: next?.name || prev?.name || '',
            phone: next?.phone || prev?.phone || '',
            code: next?.code || prev?.code || '',
            readyNote: next?.readyNote || prev?.readyNote || '',
          };
        };

        const getRowMeta = (row) => {
          const id = String(row?.id || '').trim();
          const localOid = String(row?.local_oid || row?.oid || row?.fullOrder?.local_oid || row?.fullOrder?.oid || '').trim();
          const code = normalizeCode(row?.code || row?.code_n || row?.fullOrder?.code || row?.fullOrder?.client?.code || '');
          const persisted = isPersistedDbLikeId(id);
          return { id, localOid, code, persisted };
        };

        const identityKeys = (row) => {
          const { id, localOid, code, persisted } = getRowMeta(row);
          const keys = [];
          if (persisted && id) keys.push(`db:${id}`);
          if (localOid) keys.push(`local:${localOid}`);
          if (code) keys.push(`code:${code}`);
          if (id && !persisted) keys.push(`temp:${id}`);
          return Array.from(new Set(keys));
        };

        for (const row of list) {
          if (!row || typeof row !== 'object') continue;
          const keys = identityKeys(row);
          if (!keys.length) continue;

          let canonicalKey = null;
          for (const key of keys) {
            const hit = aliasToCanonical.get(key);
            if (hit) {
              canonicalKey = hit;
              break;
            }
          }
          if (!canonicalKey) canonicalKey = keys[0];

          const prev = canonicalRows.get(canonicalKey);
          const best = chooseBest(prev, row);
          canonicalRows.set(canonicalKey, best);
          for (const key of keys) aliasToCanonical.set(key, canonicalKey);
        }

        const canonicalList = Array.from(canonicalRows.values());
        const dbCanonicalByCode = new Map();
        for (const row of canonicalList) {
          const { id, code, persisted } = getRowMeta(row);
          if (!persisted || !id || !code) continue;
          dbCanonicalByCode.set(code, row);
        }

        const merged = [];
        for (const row of canonicalList) {
          const { id, code, persisted } = getRowMeta(row);
          if (!persisted && code && dbCanonicalByCode.has(code)) {
            const dbRow = dbCanonicalByCode.get(code);
            dbCanonicalByCode.set(code, chooseBest(dbRow, row));
            continue;
          }
          merged.push(row);
        }

        return merged.map((row) => {
          const { code, persisted } = getRowMeta(row);
          if (persisted && code && dbCanonicalByCode.has(code)) {
            return dbCanonicalByCode.get(code);
          }
          return row;
        });
      };

      if (dataError && (!Array.isArray(data) || data.length === 0)) {
        const keepVisibleRows = dedupeOrders([
          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),
          ...currentRows,
        ])
          .filter((row) => !/^T\d+$/i.test(String(row?.code || '').trim()))
          .filter((row) => !isTerminalRecoveryGhostRow(row, buildTerminalRecoveryIndex()))
          .sort((a, b) => (Number(b?.readyTs || b?.ts || 0) - Number(a?.readyTs || a?.ts || 0)));
        if (keepVisibleRows.length > 0) {
          gatiDbg('gati_db_fetch_soft_keep_visible', {
            seq,
            reason,
            count: keepVisibleRows.length,
            message: String(dataError?.message || dataError || ''),
          });
          if (seq === refreshSeqRef.current) {
            applyOrdersIfChanged(keepVisibleRows, { seq, reason, source: 'db_fail_keep_visible' });
            setReadyCountHint(keepVisibleRows.length);
            setLoading(false);
          }
          autoRefreshCooldownUntilRef.current = Date.now() + 5000;
          return;
        }
      }

      let masterCacheRows = readGatiRowsFromBaseMasterCache();
      let finalRows = [];
      let zombieIds = new Set();

      if (Array.isArray(data)) {
        gatiDbg('gati_db_rows', {
          seq,
          reason,
          count: data.length,
          rows: data.slice(0, 40).map((row) => ({
            id: String(row?.id || ''),
            status: String(row?.status || ''),
            code: normalizeCode(row?.code || row?.data?.code || ''),
            ready_at: row?.ready_at || null,
            client_name: row?.client_name || row?.data?.client_name || '',
          })),
        });
      }

      if (!data) {
        try {
          const fallbackRows = await buildImmediateGatiLocalRows();
          if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
            finalRows = fallbackRows;
          } else {
            finalRows = Array.isArray(orders) ? orders.slice() : [];
          }
          if (dataError) {
            gatiDbg('gati_timeout_soft_fallback', {
              seq,
              reason,
              fallbackCount: Array.isArray(finalRows) ? finalRows.length : 0,
              message: String(dataError?.message || dataError || ''),
            });
          }
        } catch (e) {
          console.error('LOCAL_FALLBACK failed:', e);
          triggerFatalCacheHeal();
          finalRows = Array.isArray(orders) ? orders.slice() : [];
        }
      } else {
        const localRows = await getAllOrdersLocal().catch(() => []);
        const cacheCleanup = reconcileBaseMasterCacheScope({
          statusScope: ['gati'],
          dbRows: data || [],
          localRows,
          outboxItems: typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [],
        });
        masterCacheRows = (getBaseRowsByStatus('gati', cacheCleanup?.cache) || []).map(mapBaseCacheRowToGati);
        purgeZombieLocalArtifacts(cacheCleanup?.removedIds || []);

        const recoveryIndex = buildTerminalRecoveryIndex();
        zombieIds = new Set(cacheCleanup?.removedIds || []);
        const cleanedMasterCacheRows = (Array.isArray(masterCacheRows) ? masterCacheRows : []).filter((row) => {
          const id = String(row?.id || row?.local_oid || '').trim();
          if (isTerminalRecoveryGhostRow(row, recoveryIndex)) {
            if (id) zombieIds.add(id);
            return false;
          }
          return isGatiRowLike(row, row?.fullOrder || row?.data || row);
        });

        const rowsForCache = [];
        const dbRows = (data || []).map((row) => {
          const order = unwrapGatiOrder(row?.data || {});
          const normalizedStatus = extractGatiStatus(row, order);
          if (normalizedStatus !== 'gati') return null;
          const readyMeta = readGatiReadyMeta(order, row || {});

          if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) {
            order.tepiha = order.tepihaRows.map((r) => ({
              m2: Number(r?.m2) || 0,
              qty: Number(r?.qty ?? r?.pieces ?? 0) || 0,
              photoUrl: r?.photoUrl || '',
            }));
          }
          if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) {
            order.staza = order.stazaRows.map((r) => ({
              m2: Number(r?.m2) || 0,
              qty: Number(r?.qty ?? r?.pieces ?? 0) || 0,
              photoUrl: r?.photoUrl || '',
            }));
          }
          order.id = String(row.id);
          order.status = 'gati';
          order.state = 'gati';
          order.ready_note = readyMeta.readyNote;
          order.ready_note_text = readyMeta.readyText;
          order.ready_location = readyMeta.readyLocation;
          order.ready_slots = readyMeta.readySlots;

          const cacheRow = { ...order, id: String(row.id), status: 'gati', state: 'gati', ready_at: row.ready_at || null };
          rowsForCache.push({ ...cacheRow, table: 'orders', _local: false, _synced: true });

          const m2 = computeM2(order);
          const total = Number(order.pay?.euro || computeTotalEuro(order));
          const paid = Number(order.pay?.paid || 0);
          const cope = computePieces(order);
          const readyTs = (row.ready_at ? Date.parse(row.ready_at) : 0) || Number(order.ready_at) || Number(order.ts) || Date.parse(row.updated_at || row.created_at || 0) || Date.now();

          return {
            id: String(order.id),
            local_oid: String(order.local_oid || row.local_oid || order.oid || order.id || ''),
            source: 'DB',
            status: 'gati',
            ts: Number(order.ts || 0),
            updated_at: String(row.updated_at || order.updated_at || ''),
            readyTs,
            picked_up_at: row.picked_up_at || order.picked_up_at || order.data?.picked_up_at || null,
            delivered_at: row.delivered_at || order.delivered_at || order.data?.delivered_at || null,
            name: row.client_name || order.client_name || order.client?.name || order.data?.client_name || order.data?.client?.name || 'Pa Emër',
            phone: row.client_phone || order.client_phone || order.client?.phone || order.data?.client_phone || order.data?.client?.phone || '',
            code: normalizeCode(row.code || order.client?.code || order.code || ''),
            m2,
            cope,
            total,
            paid,
            paidUpfront: !!order.pay?.paidUpfront,
            isReturn: !!order.returnInfo?.active,
            readyNote: readyMeta.readyNote,
            ready_location: readyMeta.readyLocation,
            ready_note_text: readyMeta.readyText,
            ready_slots: readyMeta.readySlots,
            fullOrder: {
              ...order,
              local_oid: order.local_oid || row.local_oid || order.oid || order.id || '',
              picked_up_at: row.picked_up_at || order.picked_up_at || order.data?.picked_up_at || null,
              delivered_at: row.delivered_at || order.delivered_at || order.data?.delivered_at || null,
              ready_note: readyMeta.readyNote,
              ready_note_text: readyMeta.readyText,
              ready_location: readyMeta.readyLocation,
              ready_slots: readyMeta.readySlots,
            },
          };
        }).filter(Boolean);

        if (rowsForCache.length > 0) {
          try { patchBaseMasterRows(rowsForCache); } catch {}
        }

        const validDbIds = new Set(dbRows.map((r) => String(r?.id || '').trim()).filter(Boolean));
        const dbOnlyRows = dbRows.filter((row) => {
          const id = String(row?.id || row?.local_oid || '').trim();
          if (isTerminalRecoveryGhostRow(row, recoveryIndex)) return false;
          return !(isPersistedDbLikeId(id) && !validDbIds.has(id));
        });
        const healthyDbRows = dbOnlyRows.filter((row) => {
          const full = row?.fullOrder || {};
          const rowStatus = extractGatiStatus(row, full);
          return rowStatus === 'gati';
        });

        const reconciledRows = await safeBuildReconciledRows({
          page: 'gati',
          baseRows: [...(Array.isArray(cleanedMasterCacheRows) ? cleanedMasterCacheRows : []), ...dbRows],
          localRows: [...(Array.isArray(warmRows) ? warmRows : []), ...(Array.isArray(syncSnapshot) ? syncSnapshot : [])],
          outboxSnapshot: typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [],
          options: { hideTransport: true },
        });
        if (seq !== refreshSeqRef.current) return;

        const healthyDbTokenSet = new Set(healthyDbRows.flatMap((row) => getGatiRowMatchTokens(row)));
        const authoritativeReconciledRows = dedupeOrders(Array.isArray(reconciledRows) ? reconciledRows : []).filter((row) => {
          const id = String(row?.id || row?.local_oid || row?.oid || '').trim();
          const matchedByDb = getGatiRowMatchTokens(row).some((token) => healthyDbTokenSet.has(token));
          if (matchedByDb) return true;
          if (isTerminalRecoveryGhostRow(row, recoveryIndex)) {
            if (id) zombieIds.add(id);
            return false;
          }
          if (rowLooksPendingOrLocalGati(row)) return true;
          if (isPersistedDbLikeId(id)) {
            if (id) zombieIds.add(id);
            return false;
          }
          return true;
        });

        const pendingLocalRows = dedupeOrders([
          ...(Array.isArray(warmRows) ? warmRows : []),
          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),
        ]).filter((row) => {
          const source = String(row?.source || '').trim().toUpperCase();
          const id = String(row?.id || row?.local_oid || '').trim();
          const tokens = getGatiRowMatchTokens(row);
          const matchedByDb = tokens.some((token) => healthyDbTokenSet.has(token));
          if (matchedByDb) return false;
          return source === 'OUTBOX' || !isPersistedDbLikeId(id);
        });
        finalRows = dedupeOrders([
          ...healthyDbRows,
          ...authoritativeReconciledRows,
          ...pendingLocalRows,
        ]).sort((a, b) => (Number(b?.readyTs || b?.ts || 0) - Number(a?.readyTs || a?.ts || 0)));
        scheduleDeferredCachePersist(rowsForCache, 4200);

        if (localPendingTimer.current) clearTimeout(localPendingTimer.current);
        localPendingTimer.current = window.setTimeout(async () => {
          localPendingTimer.current = null;
          try {
            const local = await getAllOrdersLocal().catch(() => []);
            const list = Array.isArray(local) ? local : [];
            const localPending = list
              .filter((o) => isGatiRowLike(o))
              .map(mapLocalOrderToGatiRow)
              .filter((o) => {
                const id = String(o?.id || o?.local_oid || '').trim();
                if (isPersistedDbLikeId(id) && !validDbIds.has(id)) {
                  purgeZombieLocalArtifacts([id]);
                  return false;
                }
                const tokens = getGatiRowMatchTokens(o);
                const matchedByDb = tokens.some((token) => healthyDbTokenSet.has(token));
                if (matchedByDb) return false;
                return String(o?.source || '').toUpperCase() === 'OUTBOX' || !id;
              });
            if (!localPending.length) return;
            setOrders((prev) => {
              const merged = dedupeOrders([...(Array.isArray(prev) ? prev : []), ...localPending])
                .filter((r) => !/^T\d+$/i.test(String(r.code || '').trim()))
                .filter((r) => !isTerminalRecoveryGhostRow(r, recoveryIndex))
                .sort((a, b) => (b.readyTs || 0) - (a.readyTs || 0));
              return merged;
            });
          } catch {}
        }, 2600);
      }
      const rawRows = (Array.isArray(finalRows) ? finalRows : []).filter((row) => !isTerminalRecoveryGhostRow(row, typeof recoveryIndex !== 'undefined' ? recoveryIndex : buildTerminalRecoveryIndex()));
      const transportHidden = rawRows.filter((r) => /^T\d+$/i.test(String(r?.code || '').trim()));
      const nonTransportRows = rawRows.filter((r) => !/^T\d+$/i.test(String(r?.code || '').trim()));
      const baseOnly = dedupeOrders(nonTransportRows);

      if (exactMode && /^\d+$/.test(String(openId || '').trim()) && !baseOnly.some((row) => String(row?.id || row?.dbId || '').trim() === openId)) {
        try {
          const exactHit = await dbFetchOrderById(openId);
          const exactRow = exactHit?.row;
          const exactOrder = exactHit?.order;
          if (exactRow && extractGatiStatus(exactRow, exactOrder) === 'gati') {
            baseOnly.push({
              id: String(exactOrder?.id || exactRow?.id || openId),
              local_oid: String(exactOrder?.local_oid || exactOrder?.oid || exactOrder?.id || exactRow?.id || openId),
              source: 'DB',
              ts: Number(exactOrder?.ts || 0),
              updated_at: String(exactRow?.updated_at || exactOrder?.updated_at || ''),
              readyTs: (exactRow?.ready_at ? Date.parse(exactRow.ready_at) : 0) || Number(exactOrder?.ready_at) || Number(exactOrder?.ts) || Date.now(),
              name: exactRow?.client_name || exactOrder?.client_name || exactOrder?.client?.name || 'Pa Emër',
              phone: exactRow?.client_phone || exactOrder?.client_phone || exactOrder?.client?.phone || '',
              code: normalizeCode(exactRow?.code || exactOrder?.client?.code || exactOrder?.code || ''),
              m2: computeM2(exactOrder || {}),
              cope: computePieces(exactOrder || {}),
              total: Number(exactOrder?.pay?.euro || computeTotalEuro(exactOrder || {})),
              paid: Number(exactOrder?.pay?.paid || 0),
              paidUpfront: !!exactOrder?.pay?.paidUpfront,
              isReturn: !!exactOrder?.returnInfo?.active,
              readyNote: String(exactOrder?.ready_note || exactOrder?.ready_location || exactOrder?.ready_note_text || ''),
            });
            gatiDbg('gati_exact_openid_recovered', {
              seq,
              reason,
              openId,
              code: normalizeCode(exactRow?.code || exactOrder?.client?.code || exactOrder?.code || ''),
            });
          }
        } catch (exactErr) {
          gatiDbg('gati_exact_openid_recover_fail', {
            seq,
            reason,
            openId,
            message: String(exactErr?.message || exactErr || ''),
          });
        }
      }

      baseOnly.sort((a, b) => (b.readyTs || 0) - (a.readyTs || 0));

      if (seq !== refreshSeqRef.current) {
        gatiDbg('gati_refresh_drop_stale', {
          seq,
          currentSeq: refreshSeqRef.current,
          reason,
          candidateCount: baseOnly.length,
        });
        return;
      }

      const visibleIds = new Set(baseOnly.map((row) => gatiRowId(row)).filter(Boolean));
      const prevVisibleIds = lastVisibleIdsRef.current instanceof Set ? lastVisibleIdsRef.current : new Set();
      const removedIds = Array.from(prevVisibleIds).filter((id) => !visibleIds.has(id));
      const addedIds = Array.from(visibleIds).filter((id) => !prevVisibleIds.has(id));
      lastVisibleIdsRef.current = visibleIds;
      appliedSeqRef.current = seq;

      gatiDbg('gati_visible_snapshot', {
        seq,
        reason,
        visibleCount: baseOnly.length,
        rawCount: rawRows.length,
        nonTransportCount: nonTransportRows.length,
        transportHiddenCount: transportHidden.length,
        zombiePrunedCount: zombieIds instanceof Set ? zombieIds.size : 0,
        dedupedAwayCount: Math.max(0, nonTransportRows.length - baseOnly.length),
        addedIds: addedIds.slice(0, 20),
        removedIds: removedIds.slice(0, 20),
        rows: baseOnly.slice(0, 40).map((row) => ({
          id: gatiRowId(row),
          code: gatiRowCode(row),
          name: String(row?.name || ''),
          readyTs: Number(row?.readyTs || 0),
          source: String(row?.source || ''),
          status: String(row?.status || row?.fullOrder?.status || row?.fullOrder?.state || ''),
          picked_up_at: row?.picked_up_at || row?.fullOrder?.picked_up_at || row?.fullOrder?.data?.picked_up_at || null,
          delivered_at: row?.delivered_at || row?.fullOrder?.delivered_at || row?.fullOrder?.data?.delivered_at || null,
        })),
        hiddenTransport: transportHidden.slice(0, 20).map((row) => ({
          id: gatiRowId(row),
          code: gatiRowCode(row),
          name: String(row?.name || ''),
          source: String(row?.source || ''),
        })),
      });

      setReadyCountHint(baseOnly.length);
      applyOrdersIfChanged(baseOnly, { seq, reason, source: 'final_rows' });
      persistGatiPageSnapshot(baseOnly, { source: 'final_rows', seq, reason, count: baseOnly.length });
    } catch (e) {
      const message = String(e?.message || e || '');
      const transientFetchFail = /load failed|failed to fetch|networkerror|network request failed/i.test(message);
      gatiDbg('gati_refresh_fail', {
        seq,
        reason,
        message,
        transientFetchFail,
      });
      console.error('Gati refresh failed:', e);
      if (transientFetchFail) {
        autoRefreshCooldownUntilRef.current = Date.now() + 5000;
        queuedAutoRefreshReasonRef.current = '';
      } else {
        const fatalLocalIssue = /quota|indexeddb|localstorage|unexpected token|json|corrupt/i.test(message);
        if (fatalLocalIssue) triggerFatalCacheHeal();
      }
    } finally {
      refreshInFlightRef.current = false;
      if (seq === refreshSeqRef.current) {
        gatiDbg('gati_refresh_end', {
          seq,
          reason,
          appliedSeq: appliedSeqRef.current,
        });
        setLoading(false);
      }
      const queuedReason = String(queuedAutoRefreshReasonRef.current || '').trim();
      const cooldownRemainingMs = Math.max(0, Number(autoRefreshCooldownUntilRef.current || 0) - Date.now());
      if (queuedReason && !refreshInFlightRef.current) {
        queuedAutoRefreshReasonRef.current = '';
        if (resumeRefreshTimerRef.current) clearTimeout(resumeRefreshTimerRef.current);
        resumeRefreshTimerRef.current = window.setTimeout(() => {
          resumeRefreshTimerRef.current = null;
          refreshOrders(queuedReason);
        }, Math.max(cooldownRemainingMs + 80, 220));
      }
    }
  }

  const totalM2 = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0), [orders]);

  async function refreshRackMap(options = {}) {
    try {
      const map = await fetchRackMapFromDb(options);
      setSlotMap(map || {});
      return map || {};
    } catch {
      setSlotMap({});
      return {};
    }
  }

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    const list = Array.isArray(orders) ? orders : [];
    if (exactMode && openId) {
      return list.filter((o) => String(o?.id || '').trim() === openId || String(o?.dbId || '').trim() === openId);
    }
    if (!q) return list;
    return list.filter((o) => {
      const name = (o.name || '').toLowerCase();
      const phone = (o.phone || '').toLowerCase();
      const code = normalizeCode(o.code).toLowerCase();
      return name.includes(q) || phone.includes(q) || code.includes(q);
    });
  }, [orders, search, exactMode, openId]);

  const discrepancyRows = useMemo(() => {
    return (Array.isArray(orders) ? orders : [])
      .map((row) => {
        const audit = readAuditState(row?.fullOrder || row || {}, row || {});
        const discrepancy = deriveAuditDiscrepancy({ ...(row || {}), audit });
        return discrepancy ? { ...row, audit, discrepancy } : null;
      })
      .filter(Boolean);
  }, [orders]);

  const auditSummary = useMemo(() => {
    const list = Array.isArray(orders) ? orders : [];
    let verifiedPhysical = 0;
    let unverified = 0;
    let notFound = 0;
    let handedNoClose = 0;
    let discrepancyTotal = 0;

    for (const row of list) {
      const audit = readAuditState(row?.fullOrder || row || {}, row || {});
      const status = normalizeAuditStatus(audit?.status || '');
      const discrepancy = deriveAuditDiscrepancy({ ...(row || {}), audit });
      if (status === AUDIT_STATUS.SEEN_IN_DEPOT) verifiedPhysical += 1;
      if (status === AUDIT_STATUS.UNVERIFIED) unverified += 1;
      if (status === AUDIT_STATUS.NOT_FOUND) notFound += 1;
      if (discrepancy?.code === 'delivered_not_closed') handedNoClose += 1;
      if (discrepancy) discrepancyTotal += 1;
    }

    return {
      readyInSystem: list.length,
      verifiedPhysical,
      unverified,
      notFound,
      handedNoClose,
      discrepancyTotal,
    };
  }, [orders]);

  const activeAudit = useMemo(() => {
    if (!auditOrder) return null;
    return readAuditState(auditOrder?.fullOrder || auditOrder || {}, auditOrder || {});
  }, [auditOrder]);

  const activeAuditDiscrepancy = useMemo(() => {
    if (!auditOrder) return null;
    return deriveAuditDiscrepancy({ ...(auditOrder || {}), audit: activeAudit || undefined });
  }, [auditOrder, activeAudit]);

  function closeAuditSheet() {
    if (auditBusy) return;
    setShowAuditSheet(false);
    setAuditOrder(null);
    setAuditErr('');
    setAuditActionMode('');
    setAuditLocationInput('');
    setAuditNoteInput('');
    setAuditHandedToName('');
    setAuditPaymentStatus('paid');
    setAuditAmountTaken('');
    setAuditDebtRemaining('0');
  }

  function openAuditPanel(row, forcedAction = '') {
    if (!row) return;
    const audit = readAuditState(row?.fullOrder || row || {}, row || {});
    const total = Number(row?.total || 0) || 0;
    const paid = Number(row?.paid || 0) || 0;
    const due = Math.max(0, Number((total - paid).toFixed(2)));
    const defaultPaymentStatus = audit?.paymentSnapshot?.payment_status || (due <= 0 ? 'paid' : 'unpaid');
    setAuditOrder(row);
    setAuditErr('');
    setAuditActionMode(forcedAction || '');
    setAuditLocationInput(String(audit?.location || row?.ready_location || '').trim());
    setAuditNoteInput(String(audit?.note || '').trim());
    setAuditHandedToName(String(audit?.handed_to_name || row?.name || '').trim());
    setAuditPaymentStatus(defaultPaymentStatus);
    setAuditAmountTaken(
      audit?.paymentSnapshot?.amount_taken || audit?.lastEvent?.amount_taken
        ? String(Number(audit?.paymentSnapshot?.amount_taken ?? audit?.lastEvent?.amount_taken ?? 0) || 0)
        : ''
    );
    setAuditDebtRemaining(String(Number(audit?.paymentSnapshot?.debt_remaining ?? due) || 0));
    setShowAuditSheet(true);
  }

  async function saveAuditStatus(nextStatus) {
    if (!auditOrder) return;
    const status = normalizeAuditStatus(nextStatus);
    if (!status) return;

    const actor = readActor() || {};
    const fullOrder = unwrapGatiOrder(auditOrder?.fullOrder || auditOrder || {});
    const audit = readAuditState(fullOrder, auditOrder || {});
    const id = String(auditOrder?.id || fullOrder?.id || '').trim();
    const localOid = String(auditOrder?.local_oid || fullOrder?.local_oid || fullOrder?.oid || id).trim();
    const atIso = new Date().toISOString();
    const note = String(auditNoteInput || '').trim();
    const location = String(auditLocationInput || '').trim();
    const handedToName = String(auditHandedToName || auditOrder?.name || '').trim();
    const amountTaken = Number(auditAmountTaken || 0) || 0;
    const debtRemaining = Number(auditDebtRemaining || 0) || 0;
    const paymentStatus = normalizeAuditPaymentStatus(auditPaymentStatus || '');

    if (status === AUDIT_STATUS.HANDED_TO_CLIENT && !paymentStatus) {
      setAuditErr('Zgjedhe statusin e pagesës.');
      return;
    }

    const event = {
      id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      status,
      label: getAuditStatusLabel(status),
      at: atIso,
      by_name: String(actor?.name || actor?.pin || actor?.transport_id || 'STAF').trim(),
      by_pin: String(actor?.pin || actor?.transport_id || actor?.id || '').trim(),
      note,
      location,
      handed_to_name: status === AUDIT_STATUS.HANDED_TO_CLIENT ? handedToName : '',
      payment_status: status === AUDIT_STATUS.HANDED_TO_CLIENT ? paymentStatus : '',
      amount_taken: status === AUDIT_STATUS.HANDED_TO_CLIENT ? amountTaken : 0,
      debt_remaining: status === AUDIT_STATUS.HANDED_TO_CLIENT ? debtRemaining : 0,
    };

    const nextHistory = [event, ...(audit?.history || [])].slice(0, 80);
    const nextAudit = {
      status,
      audited_at: atIso,
      audited_by_name: event.by_name,
      audited_by_pin: event.by_pin,
      note,
      location,
      handed_to_name: event.handed_to_name,
      payment_snapshot: status === AUDIT_STATUS.HANDED_TO_CLIENT
        ? {
            payment_status: paymentStatus,
            amount_taken: amountTaken,
            debt_remaining: debtRemaining,
          }
        : {
            payment_status: normalizeAuditPaymentStatus(audit?.paymentSnapshot?.payment_status || ''),
            amount_taken: Number(audit?.paymentSnapshot?.amount_taken ?? 0) || 0,
            debt_remaining: Number(audit?.paymentSnapshot?.debt_remaining ?? 0) || 0,
          },
      last_event: event,
      history: nextHistory,
    };

    const mergedData = {
      ...(fullOrder || {}),
      local_oid: localOid || fullOrder?.local_oid || fullOrder?.oid || '',
      oid: localOid || fullOrder?.oid || fullOrder?.local_oid || '',
      audit: nextAudit,
    };

    setAuditBusy(true);
    setAuditErr('');
    try {
      const localPatch = {
        id: id || localOid,
        local_oid: localOid || id,
        updated_at: atIso,
        audit: nextAudit,
        data: mergedData,
      };
      try { await saveOrderLocal(localPatch); } catch {}
      try { patchBaseMasterRow({ ...localPatch, table: 'orders' }); } catch {}
      try { scheduleLocalShadowWrite(`order_${id || localOid}`, { ...(auditOrder?.fullOrder || {}), ...localPatch }, 350); } catch {}

      setOrders((prev) =>
        (prev || []).map((row) =>
          String(row?.id || '') === String(auditOrder?.id || '')
            ? {
                ...row,
                updated_at: atIso,
                audit: nextAudit,
                fullOrder: {
                  ...(row?.fullOrder || {}),
                  audit: nextAudit,
                  local_oid: localOid || row?.fullOrder?.local_oid || row?.local_oid || '',
                  oid: localOid || row?.fullOrder?.oid || row?.local_oid || '',
                },
              }
            : row
        )
      );

      let remoteSaved = false;
      try {
        await updateOrderData(
          'orders',
          id || localOid,
          (current) => ({
            ...(current || {}),
            local_oid: localOid || current?.local_oid || current?.oid || '',
            oid: localOid || current?.oid || current?.local_oid || '',
            audit: nextAudit,
          }),
          { updated_at: atIso }
        );
        remoteSaved = true;
      } catch {}

      if (!remoteSaved) {
        await queueOp('patch_order_data', {
          table: 'orders',
          id: id || localOid,
          local_oid: localOid || id,
          data: mergedData,
          updated_at: atIso,
        });
      }

      closeAuditSheet();
    } catch (e) {
      setAuditErr(e?.message || 'Audit-i nuk u ruajt.');
    } finally {
      setAuditBusy(false);
    }
  }

  async function sendPickupSms(row) {
    const requestId = Date.now() + Math.random();
    smsOpenReqRef.current = requestId;
    let smsOrder = row;
    try {
      const fresh = await fetchOrderByIdSafe('orders', row?.id, '*', { timeoutMs: GATI_DB_TIMEOUT_MS });
      if (fresh) smsOrder = fresh;
    } catch {}
    if (smsOpenReqRef.current !== requestId) return;
    const phone = sanitizePhone(
      smsOrder?.client_phone ||
      smsOrder?.data?.client_phone ||
      smsOrder?.client?.phone ||
      smsOrder?.data?.client?.phone ||
      smsOrder?.phone ||
      row?.phone ||
      ''
    );
    if (!phone) return alert('Nuk ka numër telefoni.');
    const text = buildSmartSmsText(smsOrder || row, 'gati_baze');
    setSmsModal({ open: true, phone, text });
  }

  // ---------------- KU E LAM ----------------
  async function openPlaceCard(row) {
    try {
      setPlaceErr('');
      setPlaceBusy(true);
      setShowPlace(true);
      setPlaceOrderId(String(row?.id || ''));

      await refreshRackMap();

      const { order } = await dbFetchOrderById(row?.id);
      setPlaceOrder(order);

      setSelectedSlots(normalizeRackSlots(order?.ready_slots || order?.ready_location || order?.ready_note || ''));
      setPlaceText(order?.ready_note_text || order?.ready_note || order?.ready_location || '');
    } catch (e) {
      setPlaceErr('Nuk u hap kartela. Provo prap.');
      setPlaceOrder(null);
      setPlaceText('');
      setSelectedSlots([]);
    } finally {
      setPlaceBusy(false);
    }
  }

  function closePlaceCard() {
    setShowPlace(false);
    setPlaceErr('');
    setPlaceOrderId(null);
    setPlaceOrder(null);
    setPlaceText('');
    setSelectedSlots([]);
  }

  function toggleSlot(s) {
    setSelectedSlots((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function savePlaceCard() {
    if (!placeOrderId) return;

    const txt = String(placeText || '').trim();
    const actor = readActor();

    const finalNoteString = selectedSlots.length > 0 ? `📍 [${selectedSlots.join(', ')}] ${txt}`.trim() : txt;

    const patch = {
      ready_note: finalNoteString,
      ready_note_text: txt,
      ready_location: selectedSlots.length > 0 ? selectedSlots.join(', ') : txt,
      ready_note_at: new Date().toISOString(),
      ready_note_by: actor?.name || actor?.role || 'UNKNOWN',
      ready_slots: selectedSlots,
    };

    setPlaceBusy(true);
    setPlaceErr('');
    try {
      const merged = { ...(placeOrder || {}), ...patch };

      try {
        await saveOrderLocal(merged);
      } catch {}
      try { patchBaseMasterRow({ id: placeOrderId, table: 'orders', ...merged }); } catch {}
      try {
        scheduleLocalShadowWrite(`order_${placeOrderId}`, merged, 650);
      } catch {}

      let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

      if (online) {
        await updateOrderData('orders', placeOrderId, () => merged, { updated_at: new Date().toISOString() });
      } else {
        await queueOp('patch_order_data', { id: placeOrderId, data: { data: merged, updated_at: new Date().toISOString() } });
      }

      setOrders((prev) =>
        (prev || []).map((x) =>
          String(x.id) === String(placeOrderId)
            ? { ...x, readyNote: finalNoteString, readySlots: selectedSlots }
            : x
        )
      );
      await refreshRackMap({ force: true });
      closePlaceCard();
    } catch (e) {
      try {
        await queueOp('patch_order_data', { id: placeOrderId, data: { data: merged, updated_at: new Date().toISOString() } });
      } catch {}
      setPlaceErr("S'u ruajt online, por u ruajt lokalisht.");
    } finally {
      setPlaceBusy(false);
    }
  }

  // ---------------- PAY FULLSCREEN ----------------
  async function openPay(row) {
    try {
      let order = null;
      try {
        const raw = localStorage.getItem(`order_${row.id}`);
        if (raw) order = JSON.parse(raw);
      } catch {
        order = null;
      }
      if (!order) {
        const res = await dbFetchOrderById(row.id);
        order = res.order;
        scheduleLocalShadowWrite(`order_${row.id}`, order, 650);
      }
      if (!order) return alert('Nuk u gjet porosia.');

      const total = Number(order.pay?.euro || computeTotalEuro(order)) || 0;
      const paid = Number(order.pay?.paid || 0) || 0;

      const resolvedCode = pickFirstValidCode(order.code, order.code_n, row.code, order.client?.code, order.client_code);

      setPayOrder({
        id: String(row.id),
        order,
        code: resolvedCode,
        name: order.client?.name || order.client_name || row.name || '',
        phone: order.client?.phone || order.client_phone || row.phone || '',
        total,
        paid,
        arkaRecordedPaid: Number(order.pay?.arkaRecordedPaid || 0) || 0,
        paidUpfront: !!order.pay?.paidUpfront,
        m2: computeM2(order),
      });
      const dueNow = Math.max(0, Number((total - paid).toFixed(2)));
      setPayAdd(dueNow);
      setPayMethod('CASH');
      setShowPaySheet(true);
    } catch {
      alert('❌ Gabim gjatë hapjes së pagesës.');
    }
  }

  function closePay() {
    setShowPaySheet(false);
    setPayOrder(null);
    setPayAdd(0);
    setPayMethod('CASH');
  }

  // PAGESA PA DORËZUAR
  async function applyPayOnly() {
    if (!payOrder) return;

    const due = Math.max(0, Number((Number(payOrder.total || 0) - Number(payOrder.paid || 0)).toFixed(2)));
    const payNow = Number((Number(payAdd) || 0).toFixed(2));

    if (due <= 0) {
      alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.');
      return;
    }
    if (payNow <= 0) {
      alert('SHKRUANI SHUMËN!');
      return;
    }
    const applied = Math.min(payNow, due);
    const kusuri = Math.max(0, payNow - due);

    const pinLabel = `PAGESË: ${applied.toFixed(2)}€
KLIENTI DHA: ${payNow.toFixed(2)}€
KUSURI (RESTO): ${kusuri.toFixed(2)}€

👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI
    const newPaid = Number((Number(payOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(payOrder.total || 0) - newPaid).toFixed(2)));
    setPayOrder({ ...payOrder, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 });
    setOrders((prev) =>
      (prev || []).map((o) =>
        o.id === payOrder.id ? { ...o, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 } : o
      )
    );

    closePay();

    // Background network work
    const snap = { ...payOrder, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 };
    void (async () => {
      try {
        setPayBusy(true);
        setPayErr(null);
        await recordOrderCashPayment(snap, applied, pinData, payMethod);
        await refreshOrders();
      } catch (e) {
        setPayErr(e?.message || 'Gabim pagesë');
      } finally {
        setPayBusy(false);
      }
    })();
  }

  // DORËZIMI FINAL DHE PAGESA
  async function confirmDelivery() {
    if (!payOrder) return;

    // 1) Validate payment (if any)
    const due = Math.max(0, Number((Number(payOrder.total || 0) - Number(payOrder.paid || 0)).toFixed(2)));
    const payNow = Number((Number(payAdd) || 0).toFixed(2));
    if (payNow < 0) {
      alert('SHUMA E PAVLEFSHME!');
      return;
    }
    const applied = Math.min(payNow, due);
    const kusuri = Math.max(0, payNow - due);

    const newPaid = Number((Number(payOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(payOrder.total || 0) - newPaid).toFixed(2)));

    // 2) Require PIN
    const pinLabel = `DORËZIM POROSIE\nKODI: ${payOrder.code}\n\nPAGESË SOT: ${applied.toFixed(2)}€\nKLIENTI DHA: ${payNow.toFixed(2)}€
KUSURI: ${kusuri.toFixed(2)}€
BORXHI PAS: ${newDebt.toFixed(2)}€\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KONFIRMUAR:`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI: hiqe nga lista dhe mbyll modalin menjëherë
    const actionAt = new Date().toISOString();
    const optimisticBase = flattenOrderForPersist(payOrder?.order);
    const snapOrder = {
      ...payOrder,
      paid: newPaid,
      debt: newDebt,
      isPaid: newDebt <= 0,
      status: 'dorzim',
      delivered_at: actionAt,
      picked_up_at: actionAt,
      delivered_by: pinData?.pin || null,
    };

    try {
      await safeRecordReconcileTombstone({
        id: snapOrder?.id,
        local_oid: payOrder?.order?.local_oid || payOrder?.order?.oid || payOrder?.id || '',
        code: snapOrder?.code || payOrder?.order?.code || payOrder?.order?.client?.code || '',
        table: 'orders',
        status: 'dorzim',
      }, { reason: 'gati_confirm_delivery', ttlMs: 1000 * 60 * 60 * 8 });
    } catch {}

    setOrders((prev) => (prev || []).filter((o) => o.id !== payOrder.id));
    closePay();

    try {
      const pickupEventRow = {
        id: snapOrder.id,
        code: snapOrder.code,
        name: snapOrder.name,
        phone: snapOrder.phone,
        address: String(optimisticBase?.client?.address || optimisticBase?.pickup_address || optimisticBase?.address || ''),
        status: 'dorzim',
        state: 'dorzim',
        pieces: Number(snapOrder.cope || computePieces(optimisticBase) || 0),
        m2: Number(snapOrder.m2 || computeM2(optimisticBase) || 0),
        total: Number(snapOrder.total || computeTotalEuro(optimisticBase) || 0),
        eventTs: Date.parse(actionAt) || Date.now(),
        delivered_at: actionAt,
        picked_up_at: actionAt,
      };
      window.dispatchEvent(new CustomEvent('tepiha:pickup-committed', { detail: pickupEventRow }));
    } catch {}

    // Background: DB + arka + foto nënshkrimi + refresh
    void (async () => {
      try {
        setPayBusy(true);
        setPayErr(null);

        const baseOrder = flattenOrderForPersist(payOrder?.order);
        const safeCode = pickFirstValidCode(
          baseOrder?.code,
          baseOrder?.code_n,
          payOrder?.code,
          baseOrder?.client?.code,
          payOrder?.order?.code,
          payOrder?.order?.client?.code
        );
        const existingPay = (baseOrder?.pay && typeof baseOrder.pay === 'object') ? baseOrder.pay : {};

        const payload = {
          delivered_at: snapOrder.delivered_at,
          picked_up_at: snapOrder.picked_up_at,
          ...baseOrder,
          id: String(snapOrder.id || baseOrder.id || ''),
          status: 'dorzim',
          state: 'dorzim',
          code: safeCode || baseOrder?.code || '',
          client_name: baseOrder?.client_name || baseOrder?.client?.name || snapOrder?.name || '',
          client_phone: baseOrder?.client_phone || baseOrder?.client?.phone || snapOrder?.phone || '',
          price_total: Number(baseOrder?.price_total ?? existingPay?.euro ?? snapOrder?.total ?? 0) || 0,
          paid_cash: Number(baseOrder?.paid_cash ?? existingPay?.paid ?? newPaid ?? 0) || 0,
          ready_note: '',
          ready_note_text: '',
          ready_location: '',
          ready_slots: [],
          ready_note_at: null,
          ready_note_by: null,
          pay: {
            ...existingPay,
            euro: Number(existingPay?.euro ?? snapOrder?.total ?? 0) || 0,
            paid: newPaid,
            debt: newDebt,
            arkaRecordedPaid: Number(existingPay?.arkaRecordedPaid ?? snapOrder?.arkaRecordedPaid ?? 0) || 0,
            paidUpfront: !!(existingPay?.paidUpfront ?? snapOrder?.paidUpfront),
          },
          total: Number(snapOrder?.total ?? existingPay?.euro ?? baseOrder?.price_total ?? 0) || 0,
          paid: newPaid,
          debt: newDebt,
          isPaid: newDebt <= 0,
          delivered_by: snapOrder.delivered_by,
          updated_at: snapOrder.delivered_at,
        };

        if (!payload?.client || typeof payload.client !== 'object') payload.client = {};
        payload.client = {
          ...payload.client,
          name: payload.client?.name || payload.client_name || snapOrder?.name || '',
          phone: payload.client?.phone || payload.client_phone || snapOrder?.phone || '',
          code: safeCode || payload.client?.code || '',
        };

        // Save local mirror (mos blloko UI edhe nëse dështon)
        try {
          scheduleLocalShadowWrite(`tepiha_delivered_${snapOrder.id}`, payload, 650);
          await saveOrderLocal({
            id: snapOrder.id,
            status: 'dorzim',
            data: payload,
            updated_at: payload.delivered_at,
            delivered_at: payload.delivered_at,
            picked_up_at: payload.picked_up_at,
            _synced: false,
            _table: 'orders',
          });
          try { patchBaseMasterRow({ id: snapOrder.id, status: 'dorzim', data: payload, updated_at: payload.delivered_at, delivered_at: payload.delivered_at, picked_up_at: payload.picked_up_at, table: 'orders', _synced: false }); } catch {}
        } catch (e) {}

        // Record payment if any
        if (applied > 0) {
          try {
            await recordOrderCashPayment(payload, applied, pinData, payMethod);
          } catch (e) {}
        }

        // Update server (orders table)
        try {
          await transitionOrderStatus('orders', snapOrder.id, 'dorzim', { data: payload, updated_at: payload.delivered_at, delivered_at: payload.delivered_at, picked_up_at: payload.picked_up_at });
        } catch (e) {
          // fallback queue
          try {
            await queueOp('patch_order_data', {
              id: snapOrder.id,
              data: {
                data: payload,
                updated_at: payload.delivered_at,
                delivered_at: payload.delivered_at,
                picked_up_at: payload.picked_up_at,
              },
            });
          } catch (e2) {}
        }

        await refreshOrders();
      } catch (e) {
        setPayErr(e?.message || 'Gabim dorëzim');
        await refreshOrders();
      } finally {
        setPayBusy(false);
      }
    })();
  }

  // ---------------- HIDDEN RETURN ----------------
  async function openReturn(row) {
    try {
      setRetErr('');
      setRetBusy(true);
      let order = null;

      try {
        const res = await dbFetchOrderById(row.id);
        order = res?.order || null;
        if (order) {
          try { scheduleLocalShadowWrite(`order_${row.id}`, order, 650); } catch {}
        }
      } catch {}

      if (!order) {
        try {
          const raw = localStorage.getItem(`order_${row.id}`);
          if (raw) order = JSON.parse(raw);
        } catch {
          order = null;
        }
      }

      if (!order) {
        try {
          order = await downloadJsonNoCache(`orders/${row.id}.json`);
          try { scheduleLocalShadowWrite(`order_${row.id}`, order, 650); } catch {}
        } catch {}
      }

      if (!order) {
        purgeGhostRowArtifacts(row, 'open_return_missing_order');
        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => String(item?.id || item?.db_id || '') !== String(row?.id || row?.db_id || '')));
        throw new Error('ORDER_NOT_FOUND');
      }

      if (!order.db_id && row?.id) order.db_id = row.id;
      if (!order.id && row?.id) order.id = row.id;
      if (!order.data || typeof order.data !== 'object') order.data = {};

      setRetOrder(order);
      setRetReason('');
      setRetPhotoUrl('');
      setRetItems(explodeReturnPieces(order));
      setRetPayMode('original');
      setShowReturnSheet(true);
    } catch (e) {
      setRetErr('Gabim gjatë hapjes së kthimit.');
      alert('❌ Gabim gjatë hapjes së kthimit.');
    } finally {
      setRetBusy(false);
    }
  }

  function closeReturn() {
    setShowReturnSheet(false);
    setRetOrder(null);
    setRetReason('');
    setRetPhotoUrl('');
    setRetItems([]);
    setRetPayMode('original');
    setRetErr('');
    setRetBusy(false);
    try { if (returnPhotoInputRef.current) returnPhotoInputRef.current.value = ''; } catch {}
  }

  async function handleReturnPhoto(file) {
    const oid = retOrder?.id || retOrder?.db_id;
    if (!file || !oid) return;
    setPhotoUploading(true);
    setRetErr('');
    try {
      const url = await uploadPhoto(file, oid, 'return');
      if (url) setRetPhotoUrl(url);
    } catch {
      setRetErr('Gabim gjatë ngarkimit të fotos.');
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

async function resolveReturnDbId(row) {
  const direct = row?.db_id || row?.id || row?.data?.db_id || null;
  if (direct && /^\d+$/.test(String(direct))) return Number(direct);

  const code = Number(row?.code || row?.data?.code || row?.client?.code || 0) || 0;
  if (!code) return null;

  try {
    const row = await findLatestOrderByCode('orders', code, 'id,code,status');
    if (row?.id) return Number(row.id);
  } catch {}

  return null;
}


  async function confirmReturn() {
    setRetBusy(true);
    setRetErr('');
    try {
      const oid = await resolveReturnDbId(retOrder);
      if (!oid) {
        setRetErr("S'u gjet ID e porosisë për kthim.");
        alert("❌ S'u gjet porosia për kthim.");
        return;
      }
      const reason = (retReason || '').trim();
      if (!reason) {
        setRetErr('Shkruaj arsyen e kthimit.');
        return;
      }
      const selected = (retItems || []).filter((x) => x?.selected);
      if (!selected.length) {
        setRetErr('Zgjidh të paktën një tepih për kthim.');
        return;
      }
      const full = await dbFetchOrderById(oid).catch(() => null);
      const baseOrder = full?.order || retOrder || {};
      const allPieces = explodeReturnPieces(baseOrder);
      const selectedIds = new Set(selected.map((x) => x.id));
      const remaining = allPieces.filter((x) => !selectedIds.has(x.id));
      const selAgg = aggregateReturnPieces(selected);
      const remAgg = aggregateReturnPieces(remaining);
      const returnedPieces = selected.length;
      const returnedM2 = round2(selected.reduce((sum, item) => sum + Number(item?.m2 || 0), 0));
      const originalM2 = Number(baseOrder?.m2_total ?? baseOrder?.data?.m2_total ?? computeM2(baseOrder) ?? 0) || 0;
      const originalTotal = Number(baseOrder?.price_total ?? baseOrder?.data?.price_total ?? computeTotalEuro(baseOrder) ?? 0) || 0;
      const originalPaid = Number(baseOrder?.paid_cash ?? baseOrder?.data?.paid_cash ?? baseOrder?.pay?.paid ?? 0) || 0;
      const pricePerM2 = originalM2 > 0 ? (originalTotal / originalM2) : 0;
      const returnedPrice = round2(returnedM2 * pricePerM2);
      const remainingM2 = round2(remaining.reduce((sum, item) => sum + Number(item?.m2 || 0), 0));
      const remainingPrice = round2(Math.max(0, originalTotal - returnedPrice));
      let returnedPaid = 0;
      if (retPayMode === 'paid') returnedPaid = returnedPrice;
      else if (retPayMode === 'debt') returnedPaid = 0;
      else {
        const ratio = originalTotal > 0 ? Math.max(0, Math.min(1, originalPaid / originalTotal)) : 0;
        returnedPaid = round2(returnedPrice * ratio);
      }
      const returnedData = {
        ...((baseOrder?.data && typeof baseOrder.data === 'object') ? baseOrder.data : {}),
        tepiha: selAgg.tepiha,
        tepihaRows: selAgg.tepiha,
        staza: selAgg.staza,
        stazaRows: selAgg.staza,
        shkallore: selAgg.shkallore,
        stairsQty: selAgg.shkallore.qty,
        stairsPer: selAgg.shkallore.per,
        returnInfo: { active: true, reason, photoUrl: retPhotoUrl || '', at: Date.now() },
      };

      const kthimNote = [String(baseOrder?.note || '').trim(), `(KTHIM) ${reason}`].filter(Boolean).join(' • ');
      const nextData = {
        ...returnedData,
        status: 'pastrim',
        state: 'pastrim',
        is_kthim: true,
        kthim: {
          active: true,
          partial: Boolean(remaining.length),
          reason,
          photoUrl: retPhotoUrl || '',
          at: Date.now(),
          returned_pieces: returnedPieces,
          returned_m2: returnedM2,
          returned_price: returnedPrice,
          remaining_pieces: remaining.length,
          remaining_m2: remainingM2,
          remaining_price: remainingPrice,
        },
      };
      await transitionOrderStatus('orders', oid, 'pastrim', {
        client_name: baseOrder?.client_name || baseOrder?.data?.client_name || baseOrder?.client?.name || null,
        client_phone: baseOrder?.client_phone || baseOrder?.data?.client_phone || baseOrder?.client?.phone || null,
        pieces: returnedPieces,
        m2_total: returnedM2,
        price_total: returnedPrice,
        paid_cash: returnedPaid,
        is_paid_upfront: returnedPaid >= returnedPrice && returnedPrice > 0,
        note: kthimNote,
        ready_at: null,
        picked_up_at: null,
        data: nextData,
        updated_at: new Date().toISOString(),
      });
      try {
        patchBaseMasterRow({ id: String(oid), table: 'orders', status: 'pastrim', note: kthimNote, data: nextData, updated_at: new Date().toISOString() });
      } catch {}
      closeReturn();
      await refreshOrders();
    } catch (e) {
      console.error(e);
      setRetErr(e?.message || 'Gabim gjatë ruajtjes së kthimit.');
      alert('❌ Gabim gjatë ruajtjes së kthimit.');
    } finally {
      setRetBusy(false);
    }
  }

  function openCodeMenu(row) {
    setMenuOrder(row || null);
    setShowCodeMenu(true);
  }

  function closeCodeMenu() {
    setShowCodeMenu(false);
    setMenuOrder(null);
  }

  async function openFullEdit(row) {
    try {
      let ord = row?.fullOrder || row?.data || null;

      if (!ord || typeof ord !== 'object' || Object.keys(ord).length === 0) {
        try {
          const numericId = Number(row?.db_id ?? row?.id ?? 0);
          if (Number.isFinite(numericId) && numericId > 0) {
            const res = await dbFetchOrderById(numericId);
            ord = res?.order || null;
          }
        } catch {}
      }

      if (!ord || typeof ord !== 'object' || Object.keys(ord).length === 0) {
        try {
          const raw = localStorage.getItem(`order_${row?.id}`);
          if (raw) ord = JSON.parse(raw);
        } catch {}
      }

      ord = (ord && typeof ord === 'object') ? JSON.parse(JSON.stringify(ord)) : {};
      if (!ord || typeof ord !== 'object' || !Object.keys(ord).length) {
        purgeGhostRowArtifacts(row, 'open_full_edit_missing_order');
        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => String(item?.id || item?.db_id || '') !== String(row?.id || row?.db_id || '')));
        alert('Kjo porosi nuk ekziston më. U hoq nga lista.');
        return;
      }
      if (!ord.client || typeof ord.client !== 'object') ord.client = {};
      ord.client.name = ord.client.name || ord.client_name || row?.name || '';
      ord.client.phone = ord.client.phone || ord.client_phone || row?.phone || '';
      ord.client.code = ord.client.code || ord.code || ord.code_n || row?.code || '';
      const preservedLocalOid = String(
        row?.local_oid ||
        ord?.local_oid ||
        ord?.data?.local_oid ||
        ord?.oid ||
        ''
      ).trim();
      if (preservedLocalOid) {
        ord.local_oid = preservedLocalOid;
        if (!ord.data || typeof ord.data !== 'object') ord.data = {};
        ord.data.local_oid = preservedLocalOid;
      }

      const rawDbId = row?.db_id ?? row?.id ?? ord?.db_id ?? ord?.id ?? null;
      const safeDbId =
        typeof rawDbId === 'number' ? rawDbId :
        (typeof rawDbId === 'string' && /^\d+$/.test(rawDbId.trim()) ? Number(rawDbId.trim()) : null);

      const payload = buildCompactPranimiEditPayload({
        source: 'orders',
        safeDbId,
        localOid: String(
          row?.local_oid ||
          ord?.local_oid ||
          ord?.data?.local_oid ||
          ord?.oid ||
          ''
        ),
        ts: Number(ord?.ts || row?.ts || Date.now()),
        code: normalizeCode(row?.code || ord?.code || ord?.code_n || ord?.client?.code || ''),
        order: ord,
      });
      try {
        const rawPayload = JSON.stringify(payload);
        localStorage.setItem(GATI_EDIT_TO_PRANIMI_KEY, rawPayload);
        try { sessionStorage.setItem(GATI_EDIT_TO_PRANIMI_BACKUP_KEY, rawPayload); } catch {}
      } catch {}
      router.push('/pranimi?from=gati-edit');
    } catch {
      alert('❌ Gabim gjatë hapjes së editimit.');
    }
  }

  async function openEditMeasures(row) {
    try {
      setEditErr('');
      setEditBusy(true);
      let order = null;

      try {
        const res = await dbFetchOrderById(row.id);
        order = res?.order || null;
      } catch {}

      if (!order) {
        try {
          const raw = localStorage.getItem(`order_${row.id}`);
          if (raw) order = JSON.parse(raw);
        } catch {}
      }

      if (!order) {
        try {
          order = await downloadJsonNoCache(`orders/${row.id}.json`);
        } catch {}
      }

      if (!order) {
        purgeGhostRowArtifacts(row, 'open_edit_measures_missing_order');
        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((item) => String(item?.id || item?.db_id || '') !== String(row?.id || row?.db_id || '')));
        throw new Error('ORDER_NOT_FOUND');
      }

      if (!order.id) order.id = row.id;
      if (!order.db_id) order.db_id = row.id;
      const preservedLocalOid = String(
        order?.local_oid ||
        order?.data?.local_oid ||
        row?.local_oid ||
        row?.data?.local_oid ||
        order?.oid ||
        ''
      ).trim();
      if (preservedLocalOid) {
        order.local_oid = preservedLocalOid;
        if (!order.data || typeof order.data !== 'object') order.data = {};
        order.data.local_oid = preservedLocalOid;
      }

      const tList = getTepihaRows(order);
      const sList = getStazaRows(order);

      setEditOrder(order);
      setEditTepihaRows(
        tList.length
          ? tList.map((x, i) => ({ id: `t${i + 1}`, m2: String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty: String(x?.qty ?? x?.pieces ?? '') }))
          : [{ id: 't1', m2: '', qty: '' }]
      );
      setEditStazaRows(
        sList.length
          ? sList.map((x, i) => ({ id: `s${i + 1}`, m2: String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty: String(x?.qty ?? x?.pieces ?? '') }))
          : [{ id: 's1', m2: '', qty: '' }]
      );
      setEditStairsQty(String(getStairsQty(order) || 0));
      setEditStairsPer(String(getStairsPer(order) || 0.3));
      setShowEditSheet(true);
    } catch (e) {
      setEditErr('Gabim gjatë hapjes së editimit.');
      alert('❌ Gabim gjatë hapjes së editimit.');
    } finally {
      setEditBusy(false);
    }
  }

  function closeEditSheet() {
    setShowEditSheet(false);
    setEditOrder(null);
    setEditErr('');
    setEditBusy(false);
    setEditTepihaRows([{ id: 't1', m2: '', qty: '' }]);
    setEditStazaRows([{ id: 's1', m2: '', qty: '' }]);
    setEditStairsQty('0');
    setEditStairsPer('0.3');
  }

  function addEditRow(kind) {
    if (kind === 'tepiha') {
      setEditTepihaRows((prev) => [...prev, { id: `t${prev.length + 1}`, m2: '', qty: '' }]);
      return;
    }
    setEditStazaRows((prev) => [...prev, { id: `s${prev.length + 1}`, m2: '', qty: '' }]);
  }

  function updateEditRow(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setEditTepihaRows : setEditStazaRows;
    setter((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function removeEditRow(kind, id) {
    const setter = kind === 'tepiha' ? setEditTepihaRows : setEditStazaRows;
    setter((prev) => {
      const next = prev.filter((row) => row.id !== id);
      if (next.length) return next;
      return [kind === 'tepiha' ? { id: 't1', m2: '', qty: '' } : { id: 's1', m2: '', qty: '' }];
    });
  }

  async function saveEditMeasures() {
    if (!editOrder) return;
    setEditBusy(true);
    setEditErr('');
    try {
      const cleanRows = (rows) =>
        (rows || [])
          .map((r) => ({
            m2: Number(r?.m2 || 0) || 0,
            qty: Number(r?.qty || 0) || 0,
          }))
          .filter((r) => r.m2 > 0 && r.qty > 0);

      const tepiha = cleanRows(editTepihaRows);
      const staza = cleanRows(editStazaRows);
      const shkallore = {
        qty: Number(editStairsQty || 0) || 0,
        per: Number(editStairsPer || 0.3) || 0.3,
      };

      const nextData = {
        ...((editOrder?.data && typeof editOrder.data === 'object') ? editOrder.data : {}),
        tepiha,
        tepihaRows: tepiha,
        staza,
        stazaRows: staza,
        shkallore,
        stairsQty: shkallore.qty,
        stairsPer: shkallore.per,
      };

      const nextPieces = computePieces({ ...editOrder, data: nextData, tepiha, tepihaRows: tepiha, staza, stazaRows: staza, shkallore, stairsQty: shkallore.qty, stairsPer: shkallore.per });
      const nextM2 = computeM2({ ...editOrder, data: nextData, tepiha, tepihaRows: tepiha, staza, stazaRows: staza, shkallore, stairsQty: shkallore.qty, stairsPer: shkallore.per });
      const nextTotal = Number((Number(editOrder?.pay?.euro || editOrder?.data?.pay?.euro || editOrder?.price_total || 0) > 0
        ? Number(editOrder?.pay?.euro || editOrder?.data?.pay?.euro || editOrder?.price_total || 0)
        : computeTotalEuro({ ...editOrder, data: nextData, tepiha, tepihaRows: tepiha, staza, stazaRows: staza, shkallore, stairsQty: shkallore.qty, stairsPer: shkallore.per })) || 0);

      const stableLocalOid = String(
        editOrder?.local_oid ||
        editOrder?.data?.local_oid ||
        editOrder?.oid ||
        ''
      ).trim();
      const nextDataWithTotals = {
        ...nextData,
        local_oid: stableLocalOid || nextData?.local_oid || null,
        pieces: nextPieces,
        m2_total: nextM2,
        price_total: nextTotal,
        totals: {
          ...((nextData?.totals && typeof nextData.totals === 'object') ? nextData.totals : {}),
          pieces: nextPieces,
          m2: nextM2,
          total: nextTotal,
          euro: nextTotal,
        },
      };

      const updated = {
        ...editOrder,
        local_oid: stableLocalOid || editOrder?.local_oid || editOrder?.id || '',
        data: nextDataWithTotals,
        tepiha,
        tepihaRows: tepiha,
        staza,
        stazaRows: staza,
        shkallore,
        stairsQty: shkallore.qty,
        stairsPer: shkallore.per,
        pieces: nextPieces,
        m2_total: nextM2,
        price_total: nextTotal,
      };

      try { await saveOrderLocal(updated); } catch {}
      try { patchBaseMasterRow({ id: updated.id, local_oid: updated.local_oid || updated?.data?.local_oid || '', table: 'orders', ...updated }); } catch {}
      try { scheduleLocalShadowWrite(`order_${updated.id}`, updated, 650); } catch {}

      await updateOrderData('orders', updated.db_id || updated.id, () => nextDataWithTotals, { updated_at: new Date().toISOString(), pieces: nextPieces, m2_total: nextM2, price_total: nextTotal });

      setOrders((prev) =>
        (prev || []).map((o) =>
          String(o.id) === String(updated.id)
            ? { ...o, m2: computeM2(updated), cope: computePieces(updated), total: Number(updated.pay?.euro || computeTotalEuro(updated)) }
            : o
        )
      );
      closeEditSheet();
    } catch (e) {
      setEditErr(e?.message || 'Gabim gjatë ruajtjes së masave.');
    } finally {
      setEditBusy(false);
    }
  }

  function onPayPressStart(row) {
    holdFired.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      openReturn(row);
    }, 2000);
  }
  function onPayPressEnd(row) {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdFired.current) return;
    openPay(row);
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">GATI</h1>
          <div className="subtitle">Porositë e gatshme për marrje</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div>
            TOTAL M²: <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setAuditMode((v) => !v)}
              style={{
                background: auditMode ? 'rgba(34,197,94,0.18)' : 'rgba(59,130,246,0.14)',
                border: auditMode ? '1px solid rgba(34,197,94,0.45)' : '1px solid rgba(59,130,246,0.35)',
                color: auditMode ? '#86efac' : '#93c5fd',
                padding: '6px 10px',
                borderRadius: '8px',
                fontWeight: '900',
                fontSize: '11px'
              }}
            >{auditMode ? 'AUDIT MODE: ON' : 'AUDIT MODE'}</button>
            <button
              onClick={async () => {
                if (!window.confirm('A jeni të sigurt që doni të pastroni ghost cache për GATI?')) return;
                try {
                  const cleared = clearBaseMasterCacheScope(['gati']);
                  clearPageSnapshot('gati');
                  purgeZombieLocalArtifacts(cleared?.removedIds || []);
                  setOrders([]);
                  setLoading(true);
                  await refreshOrders('manual_clear_scope_gati');
                } catch (e) {
                  console.error('[gati] scoped clear cache failed', e);
                  alert('Gabim gjatë pastrimit të cache për GATI.');
                }
              }}
              style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', color: '#fca5a5', padding: '6px 10px', borderRadius: '8px', fontWeight: '900', fontSize: '11px' }}
            >🧹 FSHI CACHE</button>
          </div>
        </div>
      </header>

      <input
        className="input"
        placeholder="🔎 Kërko emrin / telefonin / kodin..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {auditMode && (
        <div className="card" style={{ padding: 12, marginTop: 10, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: '#c7d2fe' }}>AUDIT SUMMARY</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.68)', fontWeight: 700 }}>KLIKONI KODIN OSE BUTONIN AUDIT PËR KONTROLL TË SHPEJTË</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}><div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>GATI NË SISTEM</div><div style={{ fontSize: 22, fontWeight: 900 }}>{auditSummary.readyInSystem}</div></div>
            <div style={{ border: '1px solid rgba(34,197,94,0.18)', borderRadius: 12, padding: 10, background: 'rgba(34,197,94,0.08)' }}><div style={{ fontSize: 11, color: '#86efac' }}>TË VERIFIKUARA FIZIKISHT</div><div style={{ fontSize: 22, fontWeight: 900, color: '#bbf7d0' }}>{auditSummary.verifiedPhysical}</div></div>
            <div style={{ border: '1px solid rgba(107,114,128,0.18)', borderRadius: 12, padding: 10, background: 'rgba(107,114,128,0.08)' }}><div style={{ fontSize: 11, color: '#d1d5db' }}>PA U VERIFIKU</div><div style={{ fontSize: 22, fontWeight: 900 }}>{auditSummary.unverified}</div></div>
            <div style={{ border: '1px solid rgba(239,68,68,0.18)', borderRadius: 12, padding: 10, background: 'rgba(239,68,68,0.08)' }}><div style={{ fontSize: 11, color: '#fca5a5' }}>NUK U GJETËN</div><div style={{ fontSize: 22, fontWeight: 900, color: '#fecaca' }}>{auditSummary.notFound}</div></div>
            <div style={{ border: '1px solid rgba(59,130,246,0.2)', borderRadius: 12, padding: 10, background: 'rgba(59,130,246,0.08)' }}><div style={{ fontSize: 11, color: '#93c5fd' }}>IU DHANË PA MBYLLJE</div><div style={{ fontSize: 22, fontWeight: 900, color: '#bfdbfe' }}>{auditSummary.handedNoClose}</div></div>
            <div style={{ border: '1px solid rgba(251,191,36,0.2)', borderRadius: 12, padding: 10, background: 'rgba(251,191,36,0.08)' }}><div style={{ fontSize: 11, color: '#fde68a' }}>MOSPËRPUTHJE TOTALE</div><div style={{ fontSize: 22, fontWeight: 900, color: '#fef3c7' }}>{auditSummary.discrepancyTotal}</div></div>
          </div>
        </div>
      )}

      {discrepancyRows.length > 0 && (
        <section className="card" style={{ padding: 12, marginTop: 10, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: '#fecaca' }}>MOSPËRPUTHJE / DISCREPANCIES</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {discrepancyRows.slice(0, 12).map((row) => (
              <button
                key={`disc_${row.id}`}
                type="button"
                onClick={() => openAuditPanel(row)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'rgba(127,29,29,0.35)',
                  border: '1px solid rgba(239,68,68,0.28)',
                  borderRadius: 12,
                  padding: 10,
                  color: '#fff'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <div style={{ fontWeight: 900 }}>NR {normalizeCode(row.code)} • {row.name || 'Pa emër'}</div>
                  <div style={{ fontSize: 11, color: '#fca5a5', fontWeight: 900 }}>{row.discrepancy?.label}</div>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)', marginTop: 4 }}>
                  AUDIT: {row.audit?.label || 'PA U VERIFIKU'} • {row.audit?.audited_at ? formatAuditDateTime(row.audit.audited_at) : 'PA ORË'}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card" style={{ padding: '10px' }}>
        {loading ? (
          <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p>
        ) : filtered.length === 0 ? (
          <p style={{ textAlign: 'center' }}>Nuk ka porosi GATI.</p>
        ) : (
          filtered.map((o) => {
            if (!o || !o.id) return null;
            const total = Number(o?.total || 0);
            const paid = Number(o?.paid || 0);
            const isPaid = total > 0 && paid >= total;
            const debt = Math.max(0, Number((total - paid).toFixed(2)));
            const cope = Number(o?.cope || 0);
            const m2 = Number(o?.m2 || 0);
            const readyAgeDays = Math.max(0, Number(daysSince(o.readyTs || o.ts) || 0));
            const overdueDayBadge = readyAgeDays >= 4 ? readyAgeDays : 0;
            const audit = readAuditState(o?.fullOrder || o || {}, o || {});
            const auditBadge = buildAuditBadge({ ...(o || {}), audit });
            const discrepancy = deriveAuditDiscrepancy({ ...(o || {}), audit });

            return (
              <div
                key={o.id}
                className="list-item-compact"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 4px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  opacity: o.isReturn ? 0.92 : 1,
                }}
              >
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <div
                      style={{
                        background: badgeColorByAge(o.readyTs || o.ts),
                        color: '#fff',
                        width: 40,
                        height: 40,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        fontWeight: 900,
                        fontSize: 14,
                        flexShrink: 0,
                        cursor: 'pointer',
                      }}
                      onClick={() => (auditMode ? openAuditPanel(o) : openCodeMenu(o))}
                    >
                      {normalizeCode(o.code)}
                    </div>
                    {overdueDayBadge > 0 && (
                      <div style={{ minWidth: 26, height: 18, padding: '0 6px', borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                        {overdueDayBadge}D
                      </div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.name || 'Pa emër'}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                      {cope} copë • {m2.toFixed(2)} m²
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.48)', marginTop: 2 }}>
                      PRANUAR: {formatDayMonth(o.ts)}
                    </div>
                    {o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 900 }}>✅ E PAGUAR (NË FILLIM)</div>
                    )}
                    {paid > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 800 }}>Paguar: {paid.toFixed(2)}€</div>
                    )}
                    {debt > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 900 }}>Borxh: {debt.toFixed(2)}€</div>
                    )}
                    <div style={{ fontSize: 11, color: o.readyNote ? '#4ade80' : '#f59e0b', fontWeight: 800 }}>
                      {o.readyNote ? String(o.readyNote).split('\n')[0].slice(0, 42) : '📍 PA VEND'}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 900, padding: '4px 8px', borderRadius: 999, background: auditBadge.bg, color: auditBadge.color }}>
                        {auditBadge.text}
                      </span>
                      {audit?.audited_by_name && (
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.62)' }}>
                          {audit.audited_by_name} • {audit.audited_at ? formatAuditDateTime(audit.audited_at) : '--'}
                        </span>
                      )}
                    </div>
                    {discrepancy && (
                      <div style={{ fontSize: 10, color: '#fca5a5', fontWeight: 900, marginTop: 4 }}>
                        {discrepancy.label}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isPaid && <span style={{ fontSize: 14 }}>✅</span>}
                  {auditMode ? (
                    <button className="btn secondary" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => openAuditPanel(o)}>
                      AUDIT
                    </button>
                  ) : (
                    <button className="btn secondary" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => sendPickupSms(o)}>
                      SMS
                    </button>
                  )}
                  <button
                    className="btn primary"
                    style={{ padding: '6px 10px', fontSize: 12, touchAction: 'manipulation' }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      onPayPressStart(o);
                    }}
                    onPointerUp={(e) => {
                      e.preventDefault();
                      onPayPressEnd(o);
                    }}
                    onPointerCancel={() => {
                      if (holdTimer.current) clearTimeout(holdTimer.current);
                    }}
                    onPointerLeave={() => {
                      if (holdTimer.current) clearTimeout(holdTimer.current);
                    }}
                  >
                    💶 PAGUAJ
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <footer className="dock">
        <button
          type="button"
          className="btn secondary"
          style={{ width: '100%', touchAction: 'manipulation' }}
          onPointerDown={(e) => {
            e.preventDefault();
            router.push('/');
          }}
          onClick={(e) => {
            e.preventDefault();
            router.push('/');
          }}
        >
          🏠 HOME
        </button>
      </footer>

      <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiSmartSmsModal" componentName="SmartSmsModal" sourceLayer="gati_panel" showHome={false}>
        <SmartSmsModal
          isOpen={smsModal.open}
        onClose={() => {
          smsOpenReqRef.current = Date.now() + Math.random();
          setSmsModal((s) => ({ ...s, open: false }));
        }}
        phone={smsModal.phone}
          messageText={smsModal.text}
        />
      </LocalErrorBoundary>

      {showAuditSheet && auditOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiAuditSheet" componentName="AuditSheet" sourceLayer="gati_panel" showHome={false}>
          <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">AUDIT MODE</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.68)', marginTop: 4 }}>
                NR {normalizeCode(auditOrder?.code)} • {auditOrder?.name || 'Pa emër'}
              </div>
            </div>
            <button className="btn secondary" onClick={closeAuditSheet} disabled={auditBusy}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0, display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                <div><div className="label">NR / KODI</div><div style={{ fontWeight: 900, marginTop: 4 }}>{normalizeCode(auditOrder?.code)}</div></div>
                <div><div className="label">STATUSI OPERATIV</div><div style={{ fontWeight: 900, marginTop: 4 }}>{String(auditOrder?.status || 'gati').toUpperCase()}</div></div>
                <div><div className="label">KLIENTI</div><div style={{ fontWeight: 800, marginTop: 4 }}>{auditOrder?.name || 'Pa emër'}</div></div>
                <div><div className="label">COPË / M² / TOTALI</div><div style={{ fontWeight: 800, marginTop: 4 }}>{Number(auditOrder?.cope || 0)} copë • {Number(auditOrder?.m2 || 0).toFixed(2)} m² • {(Number(auditOrder?.total || 0) || 0).toFixed(2)}€</div></div>
                <div><div className="label">RAFTI / LOKACIONI</div><div style={{ fontWeight: 800, marginTop: 4 }}>{auditOrder?.ready_location || activeAudit?.location || 'Pa lokacion'}</div></div>
                <div><div className="label">STATUSI I AUDITIT</div><div style={{ fontWeight: 900, marginTop: 4 }}>{activeAudit?.label || 'PA U VERIFIKU'}</div></div>
                <div><div className="label">AUDITI I FUNDIT</div><div style={{ fontWeight: 800, marginTop: 4 }}>{activeAudit?.audited_at ? formatAuditDateTime(activeAudit.audited_at) : 'Pa auditim'}</div></div>
                <div><div className="label">AUDITUAR NGA</div><div style={{ fontWeight: 800, marginTop: 4 }}>{activeAudit?.audited_by_name || activeAudit?.audited_by_pin || '—'}</div></div>
              </div>

              {activeAuditDiscrepancy && (
                <div style={{ background: 'rgba(127,29,29,0.35)', border: '1px solid rgba(239,68,68,0.28)', color: '#fecaca', borderRadius: 12, padding: 10, fontWeight: 900 }}>
                  {activeAuditDiscrepancy.label}
                </div>
              )}

              <div style={{ display: 'grid', gap: 8 }}>
                <div className="label">VEPRIME TË SHPEJTA</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                  <button className="btn secondary" disabled={auditBusy} onClick={() => saveAuditStatus(AUDIT_STATUS.SEEN_IN_DEPOT)}>U PA NË DEPO</button>
                  <button className="btn secondary" disabled={auditBusy} onClick={() => saveAuditStatus(AUDIT_STATUS.NOT_FOUND)}>NUK U GJET</button>
                  <button className="btn secondary" disabled={auditBusy} onClick={() => { setAuditActionMode(AUDIT_STATUS.HANDED_TO_CLIENT); }}>IU DHA KLIENTIT</button>
                  <button className="btn secondary" disabled={auditBusy} onClick={() => saveAuditStatus(AUDIT_STATUS.MOVED_LOCATION)}>NË RAFT TJETËR</button>
                  <button className="btn secondary" disabled={auditBusy} onClick={() => saveAuditStatus(AUDIT_STATUS.NEEDS_REVIEW)} style={{ gridColumn: '1 / -1' }}>KËRKON KONTROLL</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div className="label">LOKACIONI AKTUAL</div>
                  <input className="input" value={auditLocationInput} onChange={(e) => setAuditLocationInput(e.target.value)} placeholder="p.sh. RAFT 3 / KATI 2" />
                </div>
                <div>
                  <div className="label">SHËNIM</div>
                  <input className="input" value={auditNoteInput} onChange={(e) => setAuditNoteInput(e.target.value)} placeholder="Shënim opsional" />
                </div>
              </div>

              {auditActionMode === AUDIT_STATUS.HANDED_TO_CLIENT && (
                <div style={{ display: 'grid', gap: 10, padding: 10, borderRadius: 12, border: '1px solid rgba(59,130,246,0.25)', background: 'rgba(59,130,246,0.08)' }}>
                  <div style={{ fontWeight: 900, color: '#bfdbfe' }}>KONFIRMIMI I DORËZIMIT FIZIK</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={auditPaymentStatus === 'paid'} onChange={() => setAuditPaymentStatus('paid')} /> <span>PO</span></label>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={auditPaymentStatus === 'unpaid'} onChange={() => setAuditPaymentStatus('unpaid')} /> <span>JO</span></label>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={auditPaymentStatus === 'partial'} onChange={() => setAuditPaymentStatus('partial')} /> <span>PJESËRISHT</span></label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <div className="label">SA U MOR?</div>
                      <input className="input" inputMode="decimal" value={auditAmountTaken} onChange={(e) => setAuditAmountTaken(e.target.value)} placeholder="0" />
                    </div>
                    <div>
                      <div className="label">SA MBETI BORXH?</div>
                      <input className="input" inputMode="decimal" value={auditDebtRemaining} onChange={(e) => setAuditDebtRemaining(e.target.value)} placeholder="0" />
                    </div>
                  </div>
                  <div>
                    <div className="label">KUJT IU DHA?</div>
                    <input className="input" value={auditHandedToName} onChange={(e) => setAuditHandedToName(e.target.value)} placeholder="Emri i klientit / familjar / person tjetër" />
                  </div>
                  <button className="btn primary" disabled={auditBusy} onClick={() => saveAuditStatus(AUDIT_STATUS.HANDED_TO_CLIENT)}>
                    {auditBusy ? 'DUKE RUAJTUR...' : 'RUAJ DORËZIMIN FIZIK'}
                  </button>
                </div>
              )}

              {auditErr ? <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 800 }}>{auditErr}</div> : null}

              <div style={{ display: 'grid', gap: 8 }}>
                <div className="label">AUDIT HISTORY</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(activeAudit?.history || []).length === 0 ? (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.62)' }}>Nuk ka histori auditi ende.</div>
                  ) : (
                    (activeAudit?.history || []).map((item) => (
                      <div key={item.id} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
                        <div style={{ fontSize: 12, fontWeight: 900 }}>{formatAuditDateTime(item.at)} — {item.label}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>NGA: {item.by_name || item.by_pin || '—'}{item.location ? ` • ${item.location}` : ''}</div>
                        {item.handed_to_name ? <div style={{ fontSize: 11, color: '#bfdbfe', marginTop: 4 }}>IU DHA: {item.handed_to_name}</div> : null}
                        {item.payment_status ? <div style={{ fontSize: 11, color: '#86efac', marginTop: 4 }}>PAGESA: {AUDIT_PAYMENT_STATUS_LABELS[item.payment_status] || item.payment_status} • U MOR: {(Number(item.amount_taken || 0) || 0).toFixed(2)}€ • BORXH: {(Number(item.debt_remaining || 0) || 0).toFixed(2)}€</div> : null}
                        {item.note ? <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 4 }}>SHËNIM: {item.note}</div> : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={closeAuditSheet} disabled={auditBusy}>MBYLL</button>
          </div>
          </div>
        </LocalErrorBoundary>
      )}

      {showCodeMenu && menuOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiCodeMenu" componentName="CodeMenu" sourceLayer="gati_panel" showHome={false}>
          <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">VEPRIMET E KODIT</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                KODI: {normalizeCode(menuOrder.code)}
              </div>
            </div>
            <button className="btn secondary" onClick={closeCodeMenu}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0, display: 'grid', gap: 10 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openPlaceCard(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                📍 VENDOS LOKACIONIN
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openEditMeasures(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                ✏️ EDITO MASAT
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openFullEdit(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                🧾 EDITO TE PRANIMI
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openReturn(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                ↩️ KTHIM NË PASTRIM
              </button>
            </div>
          </div>
          </div>
        </LocalErrorBoundary>
      )}

      {/* ============ PAGESA ME DIZAJN TE RI ARKË (POS) ============ */}
      {showPaySheet && payOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiPosModal" componentName="PosModal" sourceLayer="gati_panel" showHome={false}>
          <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="DORËZIMI & PAGESA"
          subtitle={`KODI: ${normalizeCode(payOrder.code)} • ${payOrder.name || ''}`}
          total={Number(payOrder.total || 0)}
          alreadyPaid={Number(payOrder.paid || 0)}
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KONFIRMO DORËZIMIN"
          cancelText="ANULO"
          disabled={payBusy}
          onConfirm={confirmDelivery}
          footerNote={
            <button
              className="btn secondary"
              onClick={applyPayOnly}
              disabled={payBusy}
              style={{
                width: '100%',
                padding: '12px',
                marginTop: '10px',
                background: 'rgba(59,130,246,0.15)',
                color: '#60a5fa',
                border: '1px solid rgba(59,130,246,0.3)',
                fontWeight: 'bold',
              }}
            >
              PAGUAJ PA DORËZU
            </button>
          }
          />
        </LocalErrorBoundary>
      )}

      {showEditSheet && editOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiEditMeasuresSheet" componentName="EditMeasuresSheet" sourceLayer="gati_panel" showHome={false}>
          <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">EDITO MASAT</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                KODI: {normalizeCode(editOrder?.client?.code || editOrder?.code)}
              </div>
            </div>
            <button className="btn secondary" onClick={closeEditSheet} disabled={editBusy}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0, display: 'grid', gap: 14 }}>
              <div>
                <div className="label" style={{ marginBottom: 8 }}>TEPIHA</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {editTepihaRows.map((row) => (
                    <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                      <input className="input" inputMode="decimal" placeholder="m²" value={row.m2} onChange={(e) => updateEditRow('tepiha', row.id, 'm2', e.target.value)} />
                      <input className="input" inputMode="numeric" placeholder="copë" value={row.qty} onChange={(e) => updateEditRow('tepiha', row.id, 'qty', e.target.value)} />
                      <button className="btn secondary" type="button" onClick={() => removeEditRow('tepiha', row.id)}>✕</button>
                    </div>
                  ))}
                </div>
                <button className="btn secondary" type="button" onClick={() => addEditRow('tepiha')} style={{ marginTop: 8 }}>+ SHTO RRESHT</button>
              </div>

              <div>
                <div className="label" style={{ marginBottom: 8 }}>STAZA</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {editStazaRows.map((row) => (
                    <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                      <input className="input" inputMode="decimal" placeholder="m²" value={row.m2} onChange={(e) => updateEditRow('staza', row.id, 'm2', e.target.value)} />
                      <input className="input" inputMode="numeric" placeholder="copë" value={row.qty} onChange={(e) => updateEditRow('staza', row.id, 'qty', e.target.value)} />
                      <button className="btn secondary" type="button" onClick={() => removeEditRow('staza', row.id)}>✕</button>
                    </div>
                  ))}
                </div>
                <button className="btn secondary" type="button" onClick={() => addEditRow('staza')} style={{ marginTop: 8 }}>+ SHTO RRESHT</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>SHKALLORE COPË</div>
                  <input className="input" inputMode="numeric" value={editStairsQty} onChange={(e) => setEditStairsQty(e.target.value)} />
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>M² / COPË</div>
                  <input className="input" inputMode="decimal" value={editStairsPer} onChange={(e) => setEditStairsPer(e.target.value)} />
                </div>
              </div>

              {editErr ? <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 800 }}>{editErr}</div> : null}
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={closeEditSheet} disabled={editBusy}>ANULO</button>
            <button className="btn primary" onClick={saveEditMeasures} disabled={editBusy}>{editBusy ? 'DUKE RUAJTUR...' : 'RUAJ MASAT'}</button>
          </div>
          </div>
        </LocalErrorBoundary>
      )}

      {/* ============ KTHIMI NË PASTRIM ============ */}
      {showReturnSheet && retOrder && (
        <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiReturnSheet" componentName="ReturnSheet" sourceLayer="gati_panel" showHome={false}>
          <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">KTHIMI NË PASTRIM</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                Shkruaj arsyen dhe shto foto nëse duhet.
              </div>
            </div>
            <button className="btn secondary" onClick={closeReturn} disabled={retBusy || photoUploading}>
              ✕
            </button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>ARSYEJA E KTHIMIT</div>
                  <textarea
                    className="input"
                    value={retReason}
                    onChange={(e) => setRetReason(e.target.value)}
                    placeholder="p.sh. ka mbetur njollë, duhet ripastruar..."
                    rows={5}
                    style={{ minHeight: 120, resize: 'vertical', paddingTop: 12 }}
                  />
                </div>

                <div>
                  <div className="label" style={{ marginBottom: 8 }}>TEPIHAT QË KTHEHEN</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(retItems || []).map((it) => (
                      <label key={it.id} className="row" style={{ gap: 10, alignItems: 'center' }}>
                        <input type="checkbox" checked={!!it.selected} onChange={(e) => setRetItems((prev) => prev.map((x) => x.id === it.id ? { ...x, selected: e.target.checked } : x))} />
                        <span style={{ fontWeight: 800, color: '#fff' }}>{Number(it.m2 || 0).toFixed(1)} m²</span>
                        <span style={{ color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase' }}>{it.kind}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="label" style={{ marginBottom: 8 }}>PAGESA E KTHIMIT</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={retPayMode === 'original'} onChange={() => setRetPayMode('original')} /> <span>SI ORIGJINALI</span></label>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={retPayMode === 'paid'} onChange={() => setRetPayMode('paid')} /> <span>E PAGUAR</span></label>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" checked={retPayMode === 'debt'} onChange={() => setRetPayMode('debt')} /> <span>BORXH</span></label>
                  </div>
                </div>

                <div>
                  <div className="label" style={{ marginBottom: 8 }}>FOTO E PROBLEMIT</div>
                  <input
                    ref={returnPhotoInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => handleReturnPhoto(e.target.files?.[0] || null)}
                    style={{ display: 'none' }}
                  />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => returnPhotoInputRef.current?.click()}
                      disabled={retBusy || photoUploading}
                      style={{ minWidth: 160 }}
                    >
                      {photoUploading ? 'DUKE NGARKUAR...' : '📷 BASHKANGJIT FOTO'}
                    </button>
                    {retPhotoUrl ? (
                      <a
                        href={retPhotoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn secondary"
                        style={{ textDecoration: 'none' }}
                      >
                        SHIKO FOTON
                      </a>
                    ) : null}
                  </div>
                </div>

                {retErr ? (
                  <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 800 }}>
                    {retErr}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={closeReturn} disabled={retBusy || photoUploading}>
              ANULO
            </button>
            <button className="btn primary" onClick={confirmReturn} disabled={retBusy || photoUploading}>
              {retBusy ? 'DUKE RUAJTUR...' : 'KONFIRMO KTHIMIN'}
            </button>
          </div>
          </div>
        </LocalErrorBoundary>
      )}

      <LocalErrorBoundary boundaryKind="panel" routePath="/gati" routeName="GATI" moduleName="GatiRackLocationModal" componentName="RackLocationModal" sourceLayer="gati_panel" showHome={false} repairHref="/pwa-repair.html?from=rack_modal_import_failure" repairLabel="RIPARO APP">
        <Suspense fallback={showPlace ? <div className="card" style={{ marginTop: 12, color: '#fff', fontWeight: 900 }}>DUKE HAPUR LOKACIONIN…</div> : null}>
          {showPlace ? (
            <RackLocationModal
              open={showPlace}
              busy={placeBusy}
              orderCode={normalizeCode(placeOrder?.code || placeOrder?.client?.code)}
              currentOrderId={placeOrderId}
              subtitle="Zgjidh një ose më shumë vende"
              slotMap={slotMap}
              selectedSlots={selectedSlots}
              placeText={placeText}
              onTextChange={setPlaceText}
              onToggleSlot={toggleSlot}
              onClose={closePlaceCard}
              onClear={() => { setSelectedSlots([]); setPlaceText(''); }}
              onSave={savePlaceCard}
              error={placeErr}
            />
          ) : null}
        </Suspense>
      </LocalErrorBoundary>

      <style jsx>{`
        .dock {
          position: sticky;
          bottom: 0;
          padding: 10px 0 6px 0;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0));
          margin-top: 10px;
        }
        .payfs {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(5, 8, 12, 0.96);
          display: flex;
          flex-direction: column;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .payfs-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 14px 14px;
          background: #0b0f14;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .payfs-title {
          color: #fff;
          font-weight: 900;
          font-size: 18px;
          letter-spacing: 0.02em;
        }
        .payfs-sub {
          color: rgba(255, 255, 255, 0.72);
          font-size: 12px;
          margin-top: 2px;
          line-height: 1.25;
        }
        .payfs-body {
          flex: 1;
          overflow: auto;
          padding: 14px;
        }
        .payfs-footer {
          display: flex;
          gap: 10px;
          padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #0b0f14;
          position: sticky;
          bottom: 0;
          z-index: 2;
        }
        .payfs-footer .btn {
          flex: 1;
          padding: 16px 0;
        }
      `}</style>
    </div>
  );
}
export default function GatiPage() {
  return (
    <Suspense fallback={null}>
      <GatiPageInner />
    </Suspense>
  );
}
