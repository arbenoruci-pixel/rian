"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { getOrderTable } from "@/lib/orderSource";
import { createOrderRecord, listMixedOrderRecords, updateOrderData, updateOrderRecord } from "@/lib/ordersService";
import { listUsers } from "@/lib/usersDb";
import { bootLog, bootMarkReady } from "@/lib/bootLog";
import { getActor } from "@/lib/actorSession";
import { supabase } from "@/lib/supabaseClient";
import { markTransportCodeUsed, reserveTransportCode } from "@/lib/transportCodes";
import { findTransportClientByPhoneOnly, isValidTransportPhoneDigits, normTCode, normalizeTransportPhoneKey, sameTransportPhoneDigits, upsertTransportClient } from "@/lib/transport/transportDb";

const TAB_TODAY = "today";
const TAB_TOMORROW = "tomorrow";
const TAB_ONLINE = "online";
const TAB_PHONE = "phone";
const TAB_UPDATES = "updates";
const TAB_CANCELLED = "cancelled";

const DISPATCH_LOAD_LIMIT_ORDERS = 96;
const DISPATCH_LOAD_LIMIT_TRANSPORT = 160;
const DISPATCH_SEARCH_LIMIT_ORDERS = 120;
const DISPATCH_SEARCH_LIMIT_TRANSPORT = 140;

const SLOT_OPTIONS = [
  { value: "morning", label: "PARADITE", window: "09:00 – 13:00" },
  { value: "evening", label: "MBRËMJE", window: "18:00 – 21:00" },
];

const DISPATCH_TIMELINE_STEPS = [
  "PA PLAN",
  "PRANUAR NGA SHOFERI",
  "NË RRUGË PËR PICKUP",
  "U MOR TE KLIENTI",
  "U SHKARKUA NË BAZË",
  "NË PASTRIM / NË BAZË",
  "U BË GATI",
  "NË DËRGESË / PICKUP KTHIMI",
  "U DORËZUA TE KLIENTI",
];

function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}
function s(v) {
  return String(v ?? "").trim();
}
function up(v) {
  return s(v).toUpperCase();
}


const TRANSPORT_PRE_PICKUP_STATUSES = new Set(["", "new", "inbox", "pending", "scheduled", "draft", "pranim", "dispatched", "assigned", "accepted"]);
const DISPATCH_CANCELLED_STATUSES = new Set(["cancelled", "canceled", "anuluar", "annulled", "void", "deleted", "removed"]);
const DISPATCH_CANCEL_VISIBLE_MS = 24 * 60 * 60 * 1000;

function rawStatus(value) {
  return s(value).toLowerCase();
}

function getDbTruthStatus(row = {}) {
  const top = s(row?.status);
  if (top) return top;
  let data = row?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return s(data.status || data.transport_status || data.dispatch_status);
  }
  return "";
}

function canAssignRewriteTransportStatus(currentStatus) {
  return TRANSPORT_PRE_PICKUP_STATUSES.has(rawStatus(currentStatus));
}

function resolveAssignPlanStatus(currentStatus, hasDriver) {
  const current = rawStatus(currentStatus);
  if (!canAssignRewriteTransportStatus(current)) return undefined;
  // Dispatch assignment must land in TË REJA first. The transporter moves it
  // to PIKAP only when they accept/start it from the transport flow.
  return hasDriver ? "assigned" : "inbox";
}

const DISPATCH_ACCESS_ROLES = new Set(["DISPATCH", "ADMIN", "ADMIN_MASTER", "OWNER", "PRONAR", "SUPERADMIN"]);

function canAccessDispatch(actor) {
  return DISPATCH_ACCESS_ROLES.has(up(actor?.role));
}
function toLocalYmd(input) {
  try {
    const d = input ? new Date(input) : new Date();
    if (!Number.isFinite(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  } catch {
    return "";
  }
}
function addDaysYmd(baseYmd, days) {
  try {
    const d = new Date(`${baseYmd}T12:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    return toLocalYmd(d);
  } catch {
    return baseYmd;
  }
}
function uiDate(ymd) {
  try {
    if (!ymd) return "-";
    return new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return ymd || "-";
  }
}
function niceDate(v) {
  try {
    if (!v) return "-";
    return new Date(v).toLocaleString();
  } catch {
    return "-";
  }
}
function getClientName(row) {
  return s(row?.client_name || row?.data?.client?.name || row?.data?.client_name || row?.data?.name || row?.name);
}
function getClientPhone(row) {
  return onlyDigits(row?.client_phone || row?.data?.client?.phone || row?.data?.client_phone || row?.data?.phone || row?.phone || "");
}
function getAddress(row) {
  return s(
    row?.address ||
      row?.pickup_address ||
      row?.delivery_address ||
      row?.data?.address ||
      row?.data?.pickup_address ||
      row?.data?.delivery_address ||
      row?.data?.client?.address ||
      row?.data?.location ||
      ""
  );
}
function getOrderCode(row) {
  return s(
    row?.code_str || row?.data?.code_str || row?.data?.order_code || row?.data?.order_tcode || row?.data?.official_order_code || row?.order_code || row?.t_code || row?.data?.t_code ||
    row?.client_tcode || row?.data?.client_tcode || row?.data?.client?.tcode || row?.data?.client?.code || row?.code || row?.data?.code || row?.id
  );
}
function getTransportClientId(row) {
  return s(row?.client_id || row?.data?.client_id || row?.data?.client?.id || (row?.source === "transport_clients" ? row?.id : ""));
}
function getTransportTCode(row) {
  return normTCode(row?.tcode || row?.data?.transport_client_tcode || row?.data?.client?.transport_client_tcode || row?.client_tcode || row?.data?.client_tcode || row?.data?.client?.tcode || row?.data?.client?.code || "");
}
function tCodeNumber(raw) {
  const n = String(raw || '').replace(/\D+/g, '').replace(/^0+/, '');
  return n ? Number(n) : null;
}
function getTransportClientSource(row) {
  return s(row?.source || row?._table || row?.data?.source || "");
}
function getDispatchPhoneDigits(value) {
  return normalizeTransportPhoneKey(value);
}

const DISPATCH_DIRECT_AVAILABLE_STATUSES = ['available', 'free', 'released'];
const DISPATCH_DIRECT_USED_STATUS = 'used';

function dispatchTransportPoolRowCode(row = {}) {
  return normTCode(row?.code_str || row?.code_n || row?.code || row?.transport_code || '');
}

const DISPATCH_TCODE_QUERY_TIMEOUT_MS = 4200;
const DISPATCH_TCODE_CLAIM_TIMEOUT_MS = 3200;
const DISPATCH_TCODE_HISTORY_CHUNK_SIZE = 64;
const DISPATCH_TCODE_RESERVE_DEADLINE_MS = 15000;

function dispatchIsOptionalSchemaError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return ['42703', '42P01', '22P02', 'PGRST100', 'PGRST204'].includes(code)
    || /column .* does not exist/i.test(message)
    || /relation .* does not exist/i.test(message)
    || /could not find .* column/i.test(message)
    || /invalid input syntax for type (?:integer|bigint|uuid)/i.test(message);
}

function dispatchHistoryQueryError(label, error) {
  const detail = String(error?.message || error || 'UNKNOWN_ERROR').trim();
  const wrapped = new Error(`${label}: ${detail}`);
  wrapped.code = error?.code || 'DISPATCH_TCODE_HISTORY_QUERY_FAILED';
  wrapped.cause = error;
  return wrapped;
}

async function dispatchHistoryRows(label, buildQuery, options = {}) {
  try {
    let query = buildQuery();
    if (typeof query?.timeout === 'function') {
      query = query.timeout(DISPATCH_TCODE_QUERY_TIMEOUT_MS, label);
    }
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (options?.optionalSchema && dispatchIsOptionalSchemaError(error)) return [];
    throw dispatchHistoryQueryError(label, error);
  }
}

function dispatchCollectHistoryCodes(rows = [], target = new Set()) {
  for (const row of Array.isArray(rows) ? rows : []) {
    let data = row?.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    data = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const client = data?.client && typeof data.client === 'object' && !Array.isArray(data.client) ? data.client : {};
    const values = [
      row?.code_str,
      row?.code_n,
      row?.client_tcode,
      row?.transport_code_str,
      row?.order_code,
      row?.tcode,
      row?.code,
      row?.client_code,
      row?.transport_code,
      data?.code_str,
      data?.code_n,
      data?.code,
      data?.order_code,
      data?.order_tcode,
      data?.official_order_code,
      data?.client_tcode,
      data?.transport_code,
      client?.code,
      client?.tcode,
      client?.transport_client_tcode,
    ];
    for (const value of values) {
      const code = normTCode(value);
      if (code && code !== 'T0') target.add(code);
    }
  }
  return target;
}

function dispatchPostgrestInValues(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(',');
}

async function dispatchCodesWithRealHistory(codes = []) {
  const cleanCodes = Array.from(new Set((Array.isArray(codes) ? codes : [])
    .map(normTCode)
    .filter((code) => code && code !== 'T0')));
  if (!cleanCodes.length) return new Set();

  const numericCodes = cleanCodes
    .map((code) => tCodeNumber(code))
    .filter((value) => Number.isFinite(value) && value > 0);
  const resultLimit = Math.min(Math.max(cleanCodes.length * 8, 32), 1200);
  const codeList = dispatchPostgrestInValues(cleanCodes);
  const numberList = dispatchPostgrestInValues(numericCodes);
  const dataFilters = [
    `data->>code_str.in.(${codeList})`,
    `data->>order_code.in.(${codeList})`,
    `data->>order_tcode.in.(${codeList})`,
    `data->>official_order_code.in.(${codeList})`,
    `data->>client_tcode.in.(${codeList})`,
    ...(numberList ? [
      `data->>code.in.(${numberList})`,
      `data->>code_n.in.(${numberList})`,
    ] : []),
  ].join(',');

  const tasks = [
    dispatchHistoryRows(
      'DISPATCH_TCODE_ORDERS_CODE_STR_TIMEOUT',
      () => supabase.from('transport_orders').select('code_str').in('code_str', cleanCodes).limit(resultLimit)
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_ORDERS_CODE_N_TIMEOUT',
      () => supabase.from('transport_orders').select('code_n').in('code_n', numericCodes).limit(resultLimit),
      { optionalSchema: true }
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_ORDERS_CLIENT_CODE_TIMEOUT',
      () => supabase.from('transport_orders').select('client_tcode').in('client_tcode', cleanCodes).limit(resultLimit),
      { optionalSchema: true }
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_ORDERS_DATA_TIMEOUT',
      () => supabase.from('transport_orders').select('data').or(dataFilters).limit(resultLimit),
      { optionalSchema: true }
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_CLIENTS_TIMEOUT',
      () => supabase.from('transport_clients').select('tcode').in('tcode', cleanCodes).limit(resultLimit)
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_PAYMENTS_CODE_TIMEOUT',
      () => supabase.from('arka_pending_payments').select('transport_code_str').eq('type', 'TRANSPORT').in('transport_code_str', cleanCodes).limit(resultLimit),
      { optionalSchema: true }
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_PAYMENTS_ORDER_TEXT_TIMEOUT',
      () => supabase.from('arka_pending_payments').select('order_code').eq('type', 'TRANSPORT').in('order_code', cleanCodes).limit(resultLimit),
      { optionalSchema: true }
    ),
    dispatchHistoryRows(
      'DISPATCH_TCODE_PAYMENTS_ORDER_NUM_TIMEOUT',
      () => supabase.from('arka_pending_payments').select('order_code').eq('type', 'TRANSPORT').in('order_code', numericCodes).limit(resultLimit),
      { optionalSchema: true }
    ),
  ];

  const groups = await Promise.all(tasks);
  const used = new Set();
  groups.forEach((rows) => dispatchCollectHistoryCodes(rows, used));
  return used;
}

async function dispatchCodeHasRealHistory(code) {
  const c = normTCode(code);
  if (!c || c === 'T0') return true;
  const used = await dispatchCodesWithRealHistory([c]);
  return used.has(c);
}

function isDispatchTcodeClientConflict(error) {
  const msg = String(error?.message || error || '');
  return /T-CODE\s+T?\d+\s+ËSHTË I ZËNË/i.test(msg)
    || /T-CODE\s+T?\d+\s+ESHTE I ZENE/i.test(msg)
    || /Krijo klient të ri me T-code tjetër/i.test(msg)
    || /Krijo klient te ri me T-code tjeter/i.test(msg);
}

async function dispatchClaimTransportCode(code, owner, poolRow = null) {
  const c = normTCode(code);
  const n = tCodeNumber(c);
  if (!c || !n) return false;

  const payloads = [
    { status: DISPATCH_DIRECT_USED_STATUS, owner_id: owner || 'DISPATCH' },
    { status: DISPATCH_DIRECT_USED_STATUS },
  ];
  const rowId = s(poolRow?.id);
  const rawValues = Array.from(new Set([
    poolRow?.code,
    poolRow?.code_str,
    poolRow?.code_n,
    poolRow?.transport_code,
    n,
    String(n),
    c,
  ].map((value) => String(value ?? '').trim()).filter(Boolean)));

  for (const payload of payloads) {
    if (rowId) {
      try {
        let query = supabase
          .from('transport_code_pool')
          .update(payload)
          .in('status', DISPATCH_DIRECT_AVAILABLE_STATUSES)
          .eq('id', rowId)
          .select('*')
          .limit(1);
        if (typeof query?.timeout === 'function') {
          query = query.timeout(DISPATCH_TCODE_CLAIM_TIMEOUT_MS, 'DISPATCH_TCODE_CLAIM_TIMEOUT');
        }
        const { data, error } = await query;
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
      } catch (error) {
        // Some older pools do not expose id/owner_id. Retry the compatible path.
        if (!payload.owner_id && !dispatchIsOptionalSchemaError(error)) throw error;
      }
    }

    for (const raw of rawValues) {
      try {
        let query = supabase
          .from('transport_code_pool')
          .update(payload)
          .in('status', DISPATCH_DIRECT_AVAILABLE_STATUSES)
          .eq('code', raw)
          .select('*')
          .limit(1);
        if (typeof query?.timeout === 'function') {
          query = query.timeout(DISPATCH_TCODE_CLAIM_TIMEOUT_MS, 'DISPATCH_TCODE_CLAIM_TIMEOUT');
        }
        const { data, error } = await query;
        if (error) throw error;
        if (Array.isArray(data) && data.length > 0) return true;
      } catch (error) {
        if (payload.owner_id) break;
        if (!dispatchIsOptionalSchemaError(error)) throw error;
      }
    }
  }

  return false;
}

function dispatchNormalizeRpcCodes(data) {
  const rows = Array.isArray(data) ? data : (data == null ? [] : [data]);
  return Array.from(new Set(rows.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return normTCode(item);
    return normTCode(item?.code_str || item?.code || item?.code_n || item?.transport_code || '');
  }).filter((code) => code && code !== 'T0'))).sort((a, b) => (tCodeNumber(a) || 0) - (tCodeNumber(b) || 0));
}

function dispatchCacheReservedCode(oid, code) {
  try {
    const cacheKey = oid ? `transport_order_code_v1__${oid}` : '';
    if (cacheKey && typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, code);
  } catch {}
}

async function dispatchPoolRowsByCodes(values, label) {
  try {
    let query = supabase
      .from('transport_code_pool')
      .select('*')
      .in('status', DISPATCH_DIRECT_AVAILABLE_STATUSES)
      .in('code', values)
      .limit(Math.max(Array.isArray(values) ? values.length : 0, 1));
    if (typeof query?.timeout === 'function') {
      query = query.timeout(DISPATCH_TCODE_QUERY_TIMEOUT_MS, label);
    }
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (error) {
    // Mixed deployments store pool.code either as T123 text or as 123 numeric.
    // A type mismatch on one representation is expected; a network timeout is not.
    if (dispatchIsOptionalSchemaError(error)) return [];
    throw error;
  }
}

async function dispatchLoadAvailablePoolWindow(startN, batchSize) {
  const count = Math.max(1, Number(batchSize) || 1);
  const tCodes = Array.from({ length: count }, (_, idx) => `T${startN + idx}`);
  const numericCodes = Array.from({ length: count }, (_, idx) => startN + idx);
  const settled = await Promise.allSettled([
    dispatchPoolRowsByCodes(tCodes, 'DISPATCH_TCODE_POOL_TEXT_TIMEOUT'),
    dispatchPoolRowsByCodes(numericCodes, 'DISPATCH_TCODE_POOL_NUM_TIMEOUT'),
  ]);

  const rows = [];
  const seen = new Set();
  let hardError = null;
  settled.forEach((result) => {
    if (result.status === 'rejected') {
      hardError = hardError || result.reason;
      return;
    }
    for (const row of result.value || []) {
      const key = s(row?.id) || `${s(row?.code)}|${s(row?.code_str)}|${s(row?.code_n)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  });

  if (!rows.length && hardError) throw hardError;
  return rows;
}

async function reserveDispatchCodeViaRpc(owner, deadlineMs) {
  // Ask the fallback RPC for exactly one code. Older implementations mark
  // every returned code as claimed, so requesting a batch here would strand extras.
  const attempts = [
    { p_owner_id: owner || 'DISPATCH', p_n: 1 },
    { p_reserved_by: owner || 'DISPATCH', p_count: 1 },
  ];

  for (const args of attempts) {
    if (Date.now() >= deadlineMs) return '';
    try {
      let query = supabase.rpc('reserve_transport_codes_batch', args);
      if (typeof query?.timeout === 'function') {
        query = query.timeout(DISPATCH_TCODE_QUERY_TIMEOUT_MS, 'DISPATCH_TCODE_RPC_TIMEOUT');
      }
      const { data, error } = await query;
      if (error) throw error;
      const codes = dispatchNormalizeRpcCodes(data);
      if (!codes.length) continue;
      const used = await dispatchCodesWithRealHistory(codes);
      const safe = codes.find((code) => !used.has(code));
      if (safe) return safe;
    } catch {}
  }
  return '';
}

async function reserveDispatchSmallestTransportCode(owner, opts = {}) {
  const oid = String(opts?.oid || '').trim();
  const maxProbe = Math.min(Math.max(Number(opts?.maxProbe || 2500) || 2500, 50), 5000);
  const batchSize = 250;
  const deadlineMs = Date.now() + DISPATCH_TCODE_RESERVE_DEADLINE_MS;
  let directError = null;

  try {
    for (let startN = 1; startN <= maxProbe; startN += batchSize) {
      if (Date.now() >= deadlineMs) throw new Error('DISPATCH_TCODE_RESERVATION_DEADLINE');
      const windowSize = Math.min(batchSize, maxProbe - startN + 1);
      const rows = await dispatchLoadAvailablePoolWindow(startN, windowSize);
      const candidates = rows
        .map((row) => {
          const code = dispatchTransportPoolRowCode(row);
          return { row, code, n: tCodeNumber(code) || 0 };
        })
        .filter((item) => item.code && item.n >= startN && item.n < startN + windowSize)
        .sort((a, b) => a.n - b.n);

      for (let offset = 0; offset < candidates.length; offset += DISPATCH_TCODE_HISTORY_CHUNK_SIZE) {
        if (Date.now() >= deadlineMs) throw new Error('DISPATCH_TCODE_RESERVATION_DEADLINE');
        const chunk = candidates.slice(offset, offset + DISPATCH_TCODE_HISTORY_CHUNK_SIZE);
        const used = await dispatchCodesWithRealHistory(chunk.map((item) => item.code));

        for (const item of chunk) {
          if (used.has(item.code)) continue;
          if (Date.now() >= deadlineMs) throw new Error('DISPATCH_TCODE_RESERVATION_DEADLINE');
          const claimed = await dispatchClaimTransportCode(item.code, owner, item.row);
          if (!claimed) continue;
          dispatchCacheReservedCode(oid, item.code);
          return item.code;
        }
      }
    }
  } catch (error) {
    directError = error;
    console.warn('DISPATCH_FAST_TCODE_DIRECT_FAILED', error);
  }

  const rpcCode = await reserveDispatchCodeViaRpc(owner, deadlineMs);
  if (rpcCode) {
    dispatchCacheReservedCode(oid, rpcCode);
    return rpcCode;
  }

  const detail = String(directError?.message || '').trim();
  throw new Error(`NUK U GJET T-CODE I LIRË BRENDA KUFIRIT TË SHPEJTË. PROVO PRAPË. ${detail}`.trim());
}

const DISPATCH_CODE_BUFFER_TARGET = 2;
const dispatchCodeWarmInFlight = new Map();
const DISPATCH_CODE_BUFFER_MAX_AGE_MS = 30 * 60 * 1000;

function dispatchCodeBufferKey(owner = 'DISPATCH') {
  return `dispatch_tcode_buffer_v3_lowwindow__${String(owner || 'DISPATCH').replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

function dispatchCodeHoldOwner(owner = 'DISPATCH') {
  return `DISPATCH_HOLD_${String(owner || 'DISPATCH').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${Date.now()}`;
}

function canUseDispatchLocalStorage() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function normalizeDispatchBufferEntry(entry) {
  if (!entry) return null;
  const code = normTCode(typeof entry === 'string' ? entry : entry.code);
  if (!code || code === 'T0') return null;
  const reservedAt = Number(typeof entry === 'object' ? entry.reservedAt : Date.now()) || Date.now();
  return { code, reservedAt };
}

function readDispatchCodeBuffer(owner = 'DISPATCH') {
  if (!canUseDispatchLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(dispatchCodeBufferKey(owner));
    const arr = raw ? JSON.parse(raw) : [];
    const seen = new Set();
    return (Array.isArray(arr) ? arr : [])
      .map(normalizeDispatchBufferEntry)
      .filter(Boolean)
      .filter((entry) => {
        if (Date.now() - Number(entry.reservedAt || 0) > DISPATCH_CODE_BUFFER_MAX_AGE_MS) return false;
        if (seen.has(entry.code)) return false;
        seen.add(entry.code);
        return true;
      })
      .sort((a, b) => tCodeNumber(a.code) - tCodeNumber(b.code));
  } catch {
    return [];
  }
}

function writeDispatchCodeBuffer(owner = 'DISPATCH', entries = []) {
  if (!canUseDispatchLocalStorage()) return [];
  const seen = new Set();
  const clean = (Array.isArray(entries) ? entries : [])
    .map(normalizeDispatchBufferEntry)
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.code)) return false;
      seen.add(entry.code);
      return true;
    })
    .sort((a, b) => tCodeNumber(a.code) - tCodeNumber(b.code))
    .slice(0, DISPATCH_CODE_BUFFER_TARGET);
  try {
    localStorage.setItem(dispatchCodeBufferKey(owner), JSON.stringify(clean));
  } catch {}
  return clean;
}

function popDispatchBufferedCode(owner = 'DISPATCH') {
  const current = readDispatchCodeBuffer(owner);
  if (!current.length) return '';
  const [first, ...rest] = current;
  writeDispatchCodeBuffer(owner, rest);
  return normTCode(first.code);
}

async function releaseDispatchBufferedCodeIfUnused(code) {
  const c = normTCode(code);
  if (!c || c === 'T0') return false;
  const hasHistory = await dispatchCodeHasRealHistory(c);
  if (hasHistory) return false;
  try {
    const { error } = await supabase
      .from('transport_code_pool')
      .update({ status: 'available', owner_id: 'POOL' })
      .eq('code', c)
      .eq('status', DISPATCH_DIRECT_USED_STATUS);
    return !error;
  } catch {
    return false;
  }
}

async function releaseExpiredDispatchBufferCodes(owner = 'DISPATCH') {
  if (!canUseDispatchLocalStorage()) return;
  let raw = [];
  try {
    raw = JSON.parse(localStorage.getItem(dispatchCodeBufferKey(owner)) || '[]');
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw) || !raw.length) return;

  const fresh = [];
  const expired = [];
  for (const item of raw) {
    const entry = normalizeDispatchBufferEntry(item);
    if (!entry) continue;
    if (Date.now() - Number(entry.reservedAt || 0) > DISPATCH_CODE_BUFFER_MAX_AGE_MS) expired.push(entry);
    else fresh.push(entry);
  }

  writeDispatchCodeBuffer(owner, fresh);
  for (const entry of expired) {
    try { await releaseDispatchBufferedCodeIfUnused(entry.code); } catch {}
  }
}

async function warmDispatchCodeBuffer(owner = 'DISPATCH', opts = {}) {
  const bufferOwner = String(owner || 'DISPATCH').trim() || 'DISPATCH';
  const existingWarm = dispatchCodeWarmInFlight.get(bufferOwner);
  if (existingWarm) return existingWarm;

  const task = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return readDispatchCodeBuffer(bufferOwner).map((entry) => entry.code);
    }

    // Expired holds are removed from the local buffer immediately and released in
    // the background. They must never delay the next interactive reservation.
    void releaseExpiredDispatchBufferCodes(bufferOwner).catch(() => {});

    let buffer = readDispatchCodeBuffer(bufferOwner);
    const target = Math.min(Math.max(Number(opts.target || DISPATCH_CODE_BUFFER_TARGET) || DISPATCH_CODE_BUFFER_TARGET, 1), DISPATCH_CODE_BUFFER_TARGET);

    for (let i = 0; i < 5 && buffer.length < target; i += 1) {
      const holdOwner = dispatchCodeHoldOwner(bufferOwner);
      let code = '';
      try {
        code = normTCode(await reserveDispatchSmallestTransportCode(holdOwner, { oid: `dispatch_buffer_${bufferOwner}_${Date.now()}_${i}` }));
      } catch (error) {
        console.warn('DISPATCH_TCODE_WARM_FAILED', error);
        break;
      }
      if (!code || code === 'T0') break;
      if (!buffer.some((entry) => entry.code === code)) {
        buffer.push({ code, reservedAt: Date.now() });
        buffer = writeDispatchCodeBuffer(bufferOwner, buffer);
      }
    }

    return buffer.map((entry) => entry.code);
  })();

  dispatchCodeWarmInFlight.set(bufferOwner, task);
  try {
    return await task;
  } finally {
    if (dispatchCodeWarmInFlight.get(bufferOwner) === task) {
      dispatchCodeWarmInFlight.delete(bufferOwner);
    }
  }
}

async function getDispatchBufferedTransportCode(owner = 'DISPATCH', opts = {}) {
  const bufferOwner = String(owner || 'DISPATCH').trim() || 'DISPATCH';
  let buffered = popDispatchBufferedCode(bufferOwner);
  if (buffered) return buffered;

  // When the page warm-up is already claiming one code, give it a brief chance
  // to finish instead of launching a duplicate scan from the DËRGO click.
  const warming = dispatchCodeWarmInFlight.get(bufferOwner);
  if (warming) {
    try {
      await Promise.race([
        warming,
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {}
    buffered = popDispatchBufferedCode(bufferOwner);
    if (buffered) return buffered;
  }

  // Emergency path: bounded fast reservation when no ready code exists.
  const holdOwner = dispatchCodeHoldOwner(bufferOwner);
  return normTCode(await reserveDispatchSmallestTransportCode(holdOwner, opts));
}

async function ensureDispatchTransportClientLink({ name, phone, address, existingPhoneClient, verifiedPhoneClient = undefined, tcodeOwner, reservedOrderCode }) {
  const cleanName = s(name);
  const cleanPhone = onlyDigits(phone);
  const phoneDigits = getDispatchPhoneDigits(cleanPhone);

  if (!isValidTransportPhoneDigits(phoneDigits)) {
    throw new Error("TELEFONI NUK ËSHTË VALID. SHKRUAJ NUMËR ME SË PAKU 8 SHIFRA.");
  }

  let liveClient = verifiedPhoneClient;
  if (verifiedPhoneClient === undefined) {
    try {
      liveClient = await findTransportClientByPhoneOnly(cleanPhone, { timeoutMs: 5500 });
    } catch (error) {
      throw new Error(`NUK U VERIFIKUA KLIENTI ME TELEFON. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
    }
  }

  const selectedClient = liveClient && dispatchSamePhone(getClientPhone(liveClient) || liveClient?.phone_digits || liveClient?.phone, cleanPhone)
    ? liveClient
    : (existingPhoneClient && dispatchSamePhone(getClientPhone(existingPhoneClient) || existingPhoneClient?.phone_digits || existingPhoneClient?.phone, cleanPhone) ? existingPhoneClient : null);

  let clientId = selectedClient ? getTransportClientId(selectedClient) : "";
  let tcode = selectedClient ? getTransportTCode(selectedClient) : "";

  if (!tcode) {
    tcode = normTCode(reservedOrderCode || '');
  }
  if (!tcode) {
    try {
      tcode = normTCode(await reserveTransportCode(tcodeOwner || "DISPATCH", { oid: `dispatch_client_${Date.now()}` }));
    } catch (error) {
      throw new Error(`NUK U REZERVUA T-CODE. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
    }
  }

  if (!tcode) {
    throw new Error("NUK U GJET / KRIJUA T-CODE. POROSIA NUK U RUAJT.");
  }

  const upsertResult = await upsertTransportClient({
    ...(clientId ? { id: clientId } : {}),
    name: cleanName,
    phone: cleanPhone,
    phone_digits: phoneDigits,
    tcode,
    address: s(address),
  });

  if (!upsertResult?.ok || !(upsertResult?.id || clientId)) {
    throw new Error(upsertResult?.error || "TRANSPORT_CLIENT_LINK_FAILED");
  }

  const linkedTcode = normTCode(upsertResult?.tcode || tcode);
  const linkedClientId = upsertResult?.id || clientId;
  if (!linkedClientId || !linkedTcode) {
    throw new Error("TRANSPORT_CLIENT_LINK_INCOMPLETE");
  }

  return {
    clientId: linkedClientId,
    tcode: linkedTcode,
    name: cleanName,
    phone: cleanPhone,
    phoneDigits,
    source: getTransportClientSource(selectedClient) || "transport_clients",
    rowId: selectedClient?.row_id || selectedClient?.id || null,
  };
}
function dispatchSafePhoneMatch(a, b) {
  const aa = getDispatchPhoneDigits(a);
  const bb = getDispatchPhoneDigits(b);
  if (!aa || !bb) return false;
  if (isValidTransportPhoneDigits(aa) && isValidTransportPhoneDigits(bb) && aa === bb) return true;
  const shortest = Math.min(aa.length, bb.length);
  const tailLen = shortest >= 8 ? 8 : (shortest >= 7 ? 7 : 0);
  if (!tailLen) return false;
  return aa.slice(-tailLen) === bb.slice(-tailLen);
}
function dispatchSamePhone(a, b) {
  return dispatchSafePhoneMatch(a, b) || sameTransportPhoneDigits(a, b);
}
function dispatchPhoneSearchReady(value) {
  return getDispatchPhoneDigits(value).length >= 7;
}

function isEditableActiveDispatchOrder(row) {
  if (!row || !isDispatchTransportRow(row)) return false;
  const status = rawStatus(getDbTruthStatus(row));
  if (DISPATCH_CANCELLED_STATUSES.has(status)) return false;
  if (['done', 'dorzim', 'delivery', 'delivered', 'gati', 'pastrim', 'base', 'loaded'].includes(status)) return false;
  return canAssignRewriteTransportStatus(status);
}

function findActiveDispatchOrderForPhone(rows = [], phoneValue = '') {
  const phoneKey = getDispatchPhoneDigits(phoneValue);
  if (!dispatchPhoneSearchReady(phoneKey)) return null;
  const matches = keepDispatchTransportOnly(Array.isArray(rows) ? rows : [])
    .filter((row) => isEditableActiveDispatchOrder(row))
    .filter((row) => dispatchSamePhone(getClientPhone(row) || row?.phone_digits || row?.phone, phoneKey))
    .sort((a, b) => lastTs(b) - lastTs(a));
  return matches[0] || null;
}
function looksLikeTransportCode(value) {
  return /^T[\s-]*\d+/i.test(s(value));
}
function isDispatchTransportRow(row) {
  if (!row) return false;
  const table = getOrderTable(row);
  if (table === "transport_orders" || row?._table === "transport_orders") return true;
  if (looksLikeTransportCode(getOrderCode(row))) return true;

  const markers = [
    row?.kind,
    row?.type,
    row?.source,
    row?.order_table,
    row?.table,
    row?.__src,
    row?.data?.kind,
    row?.data?.type,
    row?.data?.source,
    row?.data?.order_table,
    row?.data?.table,
    row?.data?.order_origin,
    row?.data?.source_table,
  ];
  return markers.some((marker) => up(marker).includes("TRANSPORT"));
}
function keepDispatchTransportOnly(rows) {
  return mergeById(Array.isArray(rows) ? rows : []).filter(isDispatchTransportRow);
}
function shouldHideDispatchCode(row) {
  if (isDispatchTransportRow(row)) return false;
  const source = rowSource(row);
  if (source !== 'online') return false;
  return row?.data?.defer_dispatch_code !== false;
}
function getDispatchCardCode(row) {
  if (shouldHideDispatchCode(row)) return 'ONLINE';
  return getOrderCode(row) || 'T-NEW';
}
function normalizeStatus(v) {
  const x = s(v).toLowerCase();
  if (["new", "inbox", "pranim", "dispatched", "assigned"].includes(x)) return "PA PLAN";
  if (x === "accepted" || x === "pranuar" || x === "pranu") return "PRANUAR";
  if (x === "pickup") return "PICKUP";
  if (["delivery", "dorzim", "dorëzim", "dorezim", "dorezuar", "dorëzuar", "dorzuar", "marrje"].includes(x)) return "DORZIM";
  if (["failed", "deshtuar", "dështuar", "parealizuar", "no_show", "noshow", "returned", "kthim"].includes(x)) return "DËSHTUAR";
  if (DISPATCH_CANCELLED_STATUSES.has(x)) return "ANULUAR";
  if (x === "loaded" || x === "ngarkim" || x === "ngarkuar") return "NGARKIM";
  if (x === "gati") return "GATI";
  if (x === "done") return "DONE";
  return up(v || "-");
}
function orderAssignedDriver(o) {
  return String(o?.actor || o?.data?.actor || o?.driver_name || o?.data?.driver_name || o?.data?.transport_name || "").trim();
}
function rowSource(row) {
  const rawSource = s(
    row?.source ||
    row?.data?.source ||
    row?.data?.order_origin ||
    row?.order_origin ||
    ''
  ).toLowerCase();

  const isOnline = [
    'online',
    'online_web',
    'facebook_web',
    'web_online',
    'public_form',
  ].includes(rawSource);

  if (isOnline) return 'online';
  if (["phone", "dispatch", "manual"].includes(rawSource)) return "phone";
  if (row?._table === "transport_orders") return "phone";
  return "base";
}
function sourceLabel(row) {
  if (isDispatchTransportRow(row)) return "TRANSPORT";
  const src = rowSource(row);
  if (src === "online") return "ONLINE";
  if (src === "phone") return "TELEFONATË";
  return row?._table === "orders" ? "BAZË" : "TRANSPORT";
}
function rowPickupDate(row) {
  return (
    s(row?.pickup_date) ||
    s(row?.data?.pickup_date) ||
    s(row?.data?.schedule_date) ||
    s(row?.data?.planned_date) ||
    (row?.data?.reschedule_at ? toLocalYmd(row.data.reschedule_at) : "") ||
    toLocalYmd(row?.updated_at || row?.created_at)
  );
}
function rowPickupSlot(row) {
  const raw = s(row?.pickup_slot || row?.data?.pickup_slot || row?.data?.pickup_window || row?.data?.schedule_slot).toLowerCase();
  if (raw.includes("09") || raw.includes("13") || raw.includes("paradite") || raw === "morning") return "morning";
  if (raw.includes("18") || raw.includes("21") || raw.includes("mbr") || raw === "evening") return "evening";
  return "";
}
function slotWindow(slot) {
  const found = SLOT_OPTIONS.find((x) => x.value === slot);
  return found?.window || "-";
}
function rowPlanningBucket(row) {
  return s(row?.planning_bucket || row?.data?.planning_bucket || row?.data?.schedule_bucket).toLowerCase();
}
function lastTs(row) {
  return Date.parse(row?.updated_at || row?.created_at || row?.data?.assigned_at || 0) || 0;
}
function mergeById(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = `${getOrderTable(row) || "x"}:${row?.id || Math.random()}`;
    const prev = map.get(key);
    const prevTs = lastTs(prev);
    const nextTs = lastTs(row);
    if (!prev || nextTs >= prevTs) map.set(key, row);
  });
  return Array.from(map.values());
}
function isDispatchRemovedRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return !!(
    data.dispatch_removed ||
    data.dispatch_hidden ||
    data.dispatch_archived ||
    data.deleted_from_dispatch ||
    data.soft_deleted
  );
}
function isCancelledRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(getDbTruthStatus(row) || data.dispatch_status || "");
  return DISPATCH_CANCELLED_STATUSES.has(raw) || !!(data.cancelled || data.canceled || data.cancelled_at || data.canceled_at);
}
function cancelledAtMs(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = data.cancelled_at || data.canceled_at || data.dispatch_removed_at || data.failed_at || data.unsuccessful_at || row?.updated_at || row?.created_at;
  const ms = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}
function isRecentDispatchCancellation(row) {
  if (!row) return false;
  if (!(isCancelledRow(row) || isFailedRow(row) || isDispatchRemovedRow(row))) return false;
  const ms = cancelledAtMs(row);
  if (!ms) return false;
  return Date.now() - ms <= DISPATCH_CANCEL_VISIBLE_MS;
}
function cancelReason(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return s(data.cancellation_reason || data.cancel_reason || data.dispatch_removed_reason || data.failed_note || data.reason || data.unsuccess_reason || data.note || "PA ARSYE");
}
function cancelActor(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return s(data.cancelled_by || data.dispatch_removed_by || data.transport_name || data.driver_name || data.actor || "-");
}
function cancelSource(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const explicit = s(data.cancellation_source);
  if (explicit) return up(explicit);
  if (data.dispatch_removed_by || data.dispatch_removed_at || data.dispatch_hidden) return "DISPATCH";
  return up(data.source || sourceLabel(row));
}
function isFailedRow(row) {
  const st = normalizeStatus(getDbTruthStatus(row) || "");
  if (st === "DËSHTUAR") return true;
  return !!(row?.data?.failed || row?.data?.unsuccessful || row?.data?.not_done || row?.data?.rejected_delivery);
}
function isCompletedRow(row) {
  const st = normalizeStatus(getDbTruthStatus(row) || "");
  return ["DONE", "GATI", "ANULUAR"].includes(st) || isFailedRow(row) || isDispatchRemovedRow(row);
}
function canDispatchRemoveRow(row) {
  if (!isDispatchTransportRow(row)) return false;
  if (isDoneDispatchRow(row)) return false;
  if (isDispatchRemovedRow(row) || isCancelledRow(row) || isFailedRow(row)) return true;
  return TRANSPORT_PRE_PICKUP_STATUSES.has(rawStatus(getDbTruthStatus(row) || ""));
}

const DISPATCH_DONE_STATUSES = new Set([
  "done",
  "delivered",
  "dorzuar",
  "dorezuar",
  "dorëzuar",
]);

function isDoneDispatchRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = String(getDbTruthStatus(row) || "").trim().toLowerCase();

  return (
    DISPATCH_DONE_STATUSES.has(raw) ||
    !!data.done_at ||
    !!data.delivered_at ||
    !!data.customer_delivered_at ||
    !!data.delivery_done_at
  );
}

function doneDateYmd(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return toLocalYmd(
    data.done_at ||
      data.delivered_at ||
      data.customer_delivered_at ||
      data.delivery_done_at ||
      row?.updated_at ||
      row?.created_at
  );
}

function isDoneToday(row) {
  if (!isDoneDispatchRow(row)) return false;
  return doneDateYmd(row) === toLocalYmd(new Date());
}

function isLiveBoardRow(row) {
  if (!isDispatchTransportRow(row)) return false;
  if (isDispatchRemovedRow(row) || isCancelledRow(row) || isFailedRow(row)) return false;

  if (isDoneDispatchRow(row)) {
    return isDoneToday(row);
  }

  return true;
}
function transportStageIndex(row) {
  const data = (row?.data && typeof row.data === "object") ? row.data : {};
  const raw = s(getDbTruthStatus(row) || data.transport_status || data.dispatch_status).toLowerCase();
  const marker = [raw, s(data.step), s(data.stage), s(data.driver_stage), s(data.timeline_status)].join(" ").toLowerCase();

  if (data.delivered_at || data.customer_delivered_at || data.delivery_done_at || ["done", "delivered", "dorezuar", "dorzuar", "dorëzuar"].includes(raw)) return 8;
  if (data.return_started_at || data.delivery_started_at || ["delivery", "dorzim", "dorëzim", "dorezim", "marrje", "kthim", "return", "returning"].includes(raw)) return 7;
  if (data.ready_at || raw === "gati") return 6;
  if (data.base_processing_at || data.pastrim_started_at || ["pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë"].includes(raw)) return 5;
  if (data.unloaded_at || data.base_unloaded_at || marker.includes("shkark")) return 4;
  if (data.picked_up_at || data.loaded_at || ["loaded", "ngarkim", "ngarkuar"].includes(raw)) return 3;
  if (data.pickup_started_at || data.on_way_pickup_at || raw === "pickup" || marker.includes("pickup")) return 2;
  if (data.accepted_at || data.driver_accepted_at || ["accepted", "pranuar", "pranu"].includes(raw)) return 1;
  return 0;
}
function transportStageLabel(row) {
  return DISPATCH_TIMELINE_STEPS[transportStageIndex(row)] || DISPATCH_TIMELINE_STEPS[0];
}
function timelineStyle(idx, current) {
  if (idx < current) return ui.timelineDone;
  if (idx === current) return ui.timelineNow;
  return ui.timelinePending;
}
function formatMoney(v) {
  const n = Number(v || 0);
  return `€${n.toFixed(2)}`;
}
function getTotals(row) {
  const pieces = Number(row?.pieces ?? row?.data?.pieces ?? row?.data?.totals?.pieces ?? 0) || 0;
  const m2 = Number(row?.m2_total ?? row?.data?.m2_total ?? row?.data?.totals?.m2_total ?? row?.data?.totals?.m2 ?? 0) || 0;
  const total = Number(row?.price_total ?? row?.data?.price_total ?? row?.data?.totals?.grandTotal ?? row?.data?.totals?.total ?? row?.data?.totals?.euro ?? 0) || 0;
  return { pieces, m2, total };
}

function finiteMoneyValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function moneyDash(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} €`;
}
function getPaymentInfo(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const pay = data?.pay && typeof data.pay === "object" ? data.pay : {};
  const totals = data?.totals && typeof data.totals === "object" ? data.totals : {};
  const payment = data?.payment && typeof data.payment === "object" ? data.payment : {};
  const paymentSnapshot = data?.payment_snapshot && typeof data.payment_snapshot === "object" ? data.payment_snapshot : {};
  const total = finiteMoneyValue(
    row?.price_total,
    row?.total_price,
    row?.total,
    data?.price_total,
    data?.total_price,
    data?.total,
    pay?.euro,
    pay?.total,
    totals?.grandTotal,
    totals?.grand_total,
    totals?.total,
    totals?.euro,
    payment?.total,
    paymentSnapshot?.total
  );
  let paid = finiteMoneyValue(
    row?.paid_amount,
    row?.paid_cash,
    row?.clientPaid,
    row?.paid,
    data?.paid_amount,
    data?.paid_cash,
    data?.clientPaid,
    data?.paid,
    pay?.paid,
    payment?.paid,
    payment?.amount_taken,
    paymentSnapshot?.amount_taken
  );
  let debt = finiteMoneyValue(
    row?.debt,
    row?.debt_remaining,
    data?.debt,
    data?.debt_remaining,
    pay?.debt,
    payment?.debt,
    payment?.debt_remaining,
    paymentSnapshot?.debt_remaining
  );
  if (debt === null && total !== null && paid !== null) debt = Math.max(0, Number((total - paid).toFixed(2)));
  if (paid === null && total !== null && debt !== null) paid = Math.max(0, Number((total - debt).toFixed(2)));
  return { total, paid, debt };
}
function getRowPieces(row) {
  const totals = getTotals(row);
  return totals.pieces || Number(row?.data?.qty || row?.data?.items_count || row?.data?.["copë"] || row?.data?.cope || 0) || 0;
}
function getScheduleText(row) {
  const date = rowPickupDate(row);
  const slot = rowPickupSlot(row);
  const slotText = slot ? slotWindow(slot) : "";
  if (date && slotText) return `${uiDate(date)} • ${slotText}`;
  if (date) return uiDate(date);
  if (slotText) return slotText;
  return "—";
}
function dispatchStatusLabel(rowOrStatus) {
  const row = typeof rowOrStatus === "object" ? rowOrStatus : null;
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(row ? (getDbTruthStatus(row) || data.transport_status || data.dispatch_status) : rowOrStatus);
  if (["assigned", "inbox", "new", "pranim", "dispatched", "scheduled", "pending", "draft", "accepted", "pranuar", "pranu"].includes(raw)) return "E PLANIFIKUAR";
  if (raw === "pickup") return "SHOFERI PO SHKON ME I MARRË";
  if (["loaded", "ngarkim", "ngarkuar"].includes(raw)) return "U MORËN, JANË RRUGËS PËR BAZË";
  if (["pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë"].includes(raw)) return "NË PASTRIM";
  if (raw === "gati") return "GATI PËR DORËZIM";
  if (["delivery", "dorzim", "dorëzim", "dorezim", "marrje", "kthim", "return", "returning"].includes(raw)) return "SHOFERI ËSHTË RRUGËS TE KLIENTI";
  if (["done", "delivered", "dorzuar", "dorezuar", "dorëzuar"].includes(raw)) return "E DORËZUAR";
  if (["ne_depo", "në_depo", "depo", "depot"].includes(raw)) return "NË DEPO";
  if (["cancelled", "canceled", "anuluar", "annulled", "void", "deleted", "removed"].includes(raw)) return "ANULUAR";
  if (["failed", "deshtuar", "dështuar", "parealizuar", "no_show", "noshow", "returned"].includes(raw)) return "DËSHTUAR";
  return normalizeStatus(raw || "-");
}
function shortStatusLabel(row) {
  const label = dispatchStatusLabel(row);
  if (label === "SHOFERI PO SHKON ME I MARRË") return "PICKUP";
  if (label === "U MORËN, JANË RRUGËS PËR BAZË") return "PËR BAZË";
  if (label === "SHOFERI ËSHTË RRUGËS TE KLIENTI") return "PËR KLIENT";
  return label;
}
function rowNeedsDriver(row) {
  return !s(orderAssignedDriver(row) || row?.data?.transport_name || row?.data?.driver_name || row?.data?.actor || row?.data?.transport_id || row?.data?.transport_user_id || row?.data?.assigned_driver_id);
}
function driverDisplayName(driver) {
  return up(driver?.name || driver?.full_name || driver?.username || driver?.pin || "SHOFER");
}
function driverStableId(driver) {
  return String(driver?.id || driver?.user_id || driver?.pin || driver?.user_pin || "").trim();
}
function driverStablePin(driver) {
  return String(driver?.pin || driver?.user_pin || driver?.transport_pin || "").trim();
}
function rowDriverTokens(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return [
    row?.driver_id,
    row?.driver_pin,
    row?.driver_name,
    row?.transport_id,
    row?.transport_pin,
    row?.transport_name,
    row?.assigned_driver_id,
    data.transport_id,
    data.transport_user_id,
    data.assigned_driver_id,
    data.driver_id,
    data.driver_pin,
    data.driver_name,
    data.transport_pin,
    data.transport_name,
    data.actor,
  ].map((x) => s(x)).filter(Boolean);
}
function rowMatchesDriver(row, driver) {
  if (!driver) return false;
  const id = driverStableId(driver);
  const pin = driverStablePin(driver);
  const name = driverDisplayName(driver);
  const tokens = rowDriverTokens(row);
  return tokens.some((token) => {
    const raw = String(token || "").trim();
    if (!raw) return false;
    if (id && raw === id) return true;
    if (pin && raw === pin) return true;
    return up(raw) === name;
  });
}
function isBaseSideRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(getDbTruthStatus(row) || data.transport_status || data.dispatch_status || "");
  if (["loaded", "ngarkim", "ngarkuar", "pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë", "gati", "ne_depo", "në_depo", "depo", "depot"].includes(raw)) return true;
  const idx = transportStageIndex(row);
  return idx >= 3 && idx <= 6;
}
function rowHasDebt(row) {
  const pay = getPaymentInfo(row);
  if (pay.debt !== null) return Number(pay.debt) > 0.009;
  if (pay.total !== null && pay.paid !== null) return Number(pay.total) > Number(pay.paid) + 0.009;
  return false;
}
function isDepotRow(row) {
  const raw = rawStatus(getDbTruthStatus(row) || row?.data?.transport_status || row?.data?.dispatch_status || "");
  return ["ne_depo", "në_depo", "depo", "depot"].includes(raw);
}
function isReadyRow(row) {
  const raw = rawStatus(getDbTruthStatus(row) || row?.data?.transport_status || row?.data?.dispatch_status || "");
  return raw === "gati" || !!row?.data?.ready_at;
}
function commandSearchText(row) {
  return [
    getDispatchCardCode(row),
    getOrderCode(row),
    getTransportTCode(row),
    getClientName(row),
    getClientPhone(row),
    getAddress(row),
    getDbTruthStatus(row),
    row?.status,
    row?.data?.status,
    dispatchStatusLabel(row),
    orderAssignedDriver(row),
    rowPickupDate(row),
    rowPickupSlot(row),
  ].join(" ").toLowerCase();
}
function matchesCommandSearch(row, query) {
  const q = s(query).toLowerCase();
  if (!q) return true;
  const digits = onlyDigits(q);
  if (digits && getClientPhone(row).includes(digits)) return true;
  return commandSearchText(row).includes(q);
}
function matchesCommandFilter(row, filter) {
  if (!filter) return true;
  if (filter === "no_driver") return rowNeedsDriver(row);
  if (filter === "no_address") return !getAddress(row);
  if (filter === "depo") return isDepotRow(row);
  if (filter === "gati") return isReadyRow(row);
  if (filter === "debt") return rowHasDebt(row);
  if (filter === "done_today") return isDoneToday(row);
  return true;
}
function matchesCommandDriverFilter(row, filter, drivers) {
  if (!filter || filter === "all") return true;
  if (filter === "base") return isBaseSideRow(row);
  const driver = (drivers || []).find((d) => driverStableId(d) === String(filter));
  return rowMatchesDriver(row, driver);
}
function sortCommandRows(a, b, filter) {
  if (filter === "debt") return (rowHasDebt(b) ? 1 : 0) - (rowHasDebt(a) ? 1 : 0) || lastTs(b) - lastTs(a);
  if (filter === "gati") return transportStageIndex(a) - transportStageIndex(b) || lastTs(a) - lastTs(b);
  if (filter === "done_today") return lastTs(b) - lastTs(a);
  return lastTs(b) - lastTs(a);
}
function getCopyReplyText(row) {
  const pay = getPaymentInfo(row);
  const code = getDispatchCardCode(row);
  const name = getClientName(row) || "klient";
  const address = getAddress(row) || "—";
  const driver = orderAssignedDriver(row) || "—";
  const schedule = getScheduleText(row);
  return `Përshëndetje ${name},\nPorosia juaj ${code} është në statusin: ${dispatchStatusLabel(row)}.\nTotali është ${moneyDash(pay.total)}, paguar ${moneyDash(pay.paid)}, borxhi ${moneyDash(pay.debt)}.\nAdresa: ${address}.\nShoferi/orari: ${driver} ${schedule}.`;
}
function phoneHref(row) {
  const phone = getClientPhone(row);
  return phone ? `tel:${phone}` : "";
}
function whatsappHref(row) {
  const phone = getClientPhone(row);
  if (!phone) return "";
  const text = encodeURIComponent(getCopyReplyText(row));
  return `https://wa.me/${phone}?text=${text}`;
}


const DISPATCH_DISCOUNT_RE = /(ma\s*lir[eë]?|m[ëe]\s*lir[eë]?|zbritje|lir\b|çmim|cmim|qmim|shum[eë]|presion|rabat|ulje)/i;

const CUSTOMER_MESSAGE_TEMPLATES = [
  { key: "today", label: "DO VIJMË SOT", text: "Përshëndetje {EMRI}, sot do të vijmë për marrjen e tepihave. Ju lutem mbani telefonin afër. Faleminderit." },
  { key: "on_way", label: "JEMI NË RRUGË", text: "Përshëndetje {EMRI}, shoferi është nisur drejt adresës suaj. Ju lutem përgatitni tepihat për marrje." },
  { key: "location", label: "DËRGO LOKACION", text: "Përshëndetje {EMRI}, ju lutem na dërgoni lokacionin në WhatsApp/Viber që shoferi ta gjejë adresën më lehtë." },
  { key: "not_found", label: "S’PO JU GJEJMË", text: "Përshëndetje {EMRI}, shoferi është afër adresës, por nuk po arrin t’ju kontaktojë. Ju lutem na ktheni thirrjen ose na dërgoni lokacionin." },
  { key: "ready", label: "GATI PËR DORËZIM", text: "Përshëndetje {EMRI}, tepihat tuaja janë gati për dorëzim. Ju lutem na tregoni kur ju përshtatet t’i sjellim." },
  { key: "bring_today", label: "DO T’I SJELLIM SOT", text: "Përshëndetje {EMRI}, sot do t’i sjellim tepihat tuaja. Shoferi do t’ju kontaktojë para nisjes." },
  { key: "cod", label: "PAGESA NË DORËZIM", text: "Përshëndetje {EMRI}, tepihat janë gati. Pagesa bëhet në dorëzim. Faleminderit." },
  { key: "price_after_measure", label: "ÇMIMI KONFIRMOHET PAS MATJES", text: "Përshëndetje {EMRI}, çmimi final konfirmohet pas matjes së saktë në bazë. Faleminderit." },
  { key: "small_discount", label: "ZBRITJE E VOGËL", text: "Përshëndetje {EMRI}, për shkak që keni disa tepiha, mund t’ju bëjmë një zbritje të vogël. Çmimi final konfirmohet pas matjes." },
  { key: "regular", label: "KLIENT I RREGULLT", text: "Përshëndetje {EMRI}, pasi jeni klient i rregullt, do ta shënojmë për zbritje dhe do t’ju konfirmojmë totalin pas matjes." },
];

const DRIVER_MESSAGE_CHIPS = [
  "COPY KLIENTIN",
  "COPY LISTËN E SOTME",
  "THIRR KLIENTIN PARA SE ME SHKU",
  "KLIENTI KËRKON LOKACION",
  "KLIENTI KËRKON ZBRITJE",
  "KUJDES: PAGESA NË DORËZIM",
];

const DISCOUNT_MESSAGE_CHIPS = [
  "-5% PROPOZIM",
  "-10% PROPOZIM",
  "KLIENT I RREGULLT",
  "KËRKON APROVIM ADMIN",
];

function normalizeKosovoPhone(raw) {
  const original = s(raw);
  const digits = onlyDigits(original);
  let normalized = "";
  if (/^04\d{7}$/.test(digits)) normalized = `+383${digits.slice(1)}`;
  else if (/^3834\d{7}$/.test(digits)) normalized = `+${digits}`;
  else if (/^\+3834\d{7}$/.test(original.replace(/\s+/g, ""))) normalized = original.replace(/\s+/g, "");
  else if (/^4\d{7}$/.test(digits)) normalized = `+383${digits}`;
  else if (digits) normalized = original.startsWith("+") ? `+${digits}` : digits;
  const linkDigits = normalized.startsWith("+") ? normalized.slice(1) : onlyDigits(normalized);
  return { original, digits, normalized, linkDigits };
}

function extractPastePhone(text) {
  const raw = s(text);
  const matches = raw.match(/(?:\+?383[\s\-.]*)?0?4\d[\s\-.]*\d{3}[\s\-.]*\d{3}/g) || [];
  const picked = matches[0] || "";
  return picked ? picked.replace(/[\n\r]+/g, " ").trim() : "";
}

function extractPasteLineValue(lines, labels) {
  for (const line of lines) {
    const clean = s(line);
    if (!clean) continue;
    for (const label of labels) {
      const re = new RegExp(`^\\s*${label}\\s*[:=\u2013-]\\s*(.+)$`, "i");
      const m = clean.match(re);
      if (m?.[1]) return s(m[1]);
    }
  }
  return "";
}


function stripPasteAddressNoise(line) {
  const raw = s(line)
    .replace(/^(adresa|adres|rruga|lagjja|lagjia|lokacion|location|address)\s*[:=–-]\s*/i, "")
    .trim();
  if (!raw) return "";
  const scheduleOrPiecesRe = /\b(sot|nes[eë]r|paradite|pasdite|mbr[eë]mje|mramje|mengjes|mëngjes|ora|orari)\b|\b\d{1,3}\s*(cop[eë]|copa|tepih[aë]?|tepihat|qilim[aë]?)\b/i;
  const parts = raw.split(/[,;|]/).map((x) => s(x)).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter((part) => !scheduleOrPiecesRe.test(part));
    if (kept.length) return kept.join(", ").trim();
  }
  return raw.replace(/\s{2,}/g, " ").trim();
}

function looksLikePasteAddressLine(line) {
  const clean = s(line);
  if (!clean) return false;
  if (/^(adresa|adres|rruga|lagjja|lagjia|lokacion|location|address)\b/i.test(clean)) return true;
  return /(rr\.?|rruga|lagjja|lagjia|qender|qend[eë]r|mahall|banes|hyrja|objekti|prishtin|fush[eë]\s*kosov|ferizaj|prizren|pej|gjakov|gjilan|mitrovic|podujev|vushtrri|dardani|ulpian|veternik|arb[eë]ri|bregu\s*i\s*diellit|aktash|mati|kalabri|lakrisht)/i.test(clean);
}

function isLikelyScheduleOrPiecesOnly(line) {
  const clean = s(line);
  if (!clean) return false;
  const withoutPieces = clean.replace(/\b\d{1,3}\s*(cop[eë]|copa|tepih[aë]?|tepihat|qilim[aë]?)\b/gi, "").trim();
  return /^(sot|nes[eë]r|paradite|pasdite|mbr[eë]mje|mramje|mengjes|mëngjes|ora|orari)(\b|\s|[:=–-])/i.test(withoutPieces);
}

function guessPasteName(lines, phoneOriginal) {
  const labelled = extractPasteLineValue(lines, ["emri", "emer", "emër", "klienti", "klient", "name"]);
  if (labelled) return labelled;
  const phoneDigits = onlyDigits(phoneOriginal);
  for (const line of lines) {
    const clean = s(line);
    if (!clean || onlyDigits(clean) === phoneDigits) continue;
    if (/^(adresa|adres|rruga|lagjja|lagjia|lokacion|ora|orari|tel|telefon|phone|note|shenim|shënim)\b/i.test(clean)) continue;
    if (looksLikePasteAddressLine(clean) || isLikelyScheduleOrPiecesOnly(clean)) continue;
    if (/\d{2,}/.test(clean)) continue;
    if (/[a-zA-ZçÇëË]/.test(clean) && clean.length <= 38) return clean;
  }
  return "";
}

function extractPasteAddress(lines, raw) {
  const labelled = extractPasteLineValue(lines, ["adresa", "adres", "rruga", "lagjja", "lagjia", "lokacion", "location", "address"]);
  if (labelled) return stripPasteAddressNoise(labelled);
  const candidates = lines.map(s).filter(Boolean);
  const hit = candidates.find((line) => looksLikePasteAddressLine(line));
  if (hit) return stripPasteAddressNoise(hit);
  const fallback = candidates.find((line) => {
    const clean = s(line);
    if (!clean) return false;
    if (/^(emri|emer|emër|name|klienti|klient|tel|telefon|phone|note|shenim|shënim)\b/i.test(clean)) return false;
    if (/BEGIN:VCARD|END:VCARD|VERSION:/i.test(clean)) return false;
    if (onlyDigits(clean).length >= 7) return false;
    if (isLikelyScheduleOrPiecesOnly(clean)) return false;
    return /[a-zA-ZçÇëË]/.test(clean) && /\d/.test(clean);
  });
  if (fallback) return stripPasteAddressNoise(fallback);
  const locationUrl = s(raw.match(/https?:\/\/\S+/i)?.[0] || "");
  return locationUrl;
}

function extractPasteArea(address, raw) {
  const source = `${address}\n${raw}`;
  const areas = ["Prishtinë", "Prishtina", "Fushë Kosovë", "Ferizaj", "Prizren", "Pejë", "Gjakovë", "Gjilan", "Mitrovicë", "Podujevë", "Vushtrri", "Dardani", "Ulpianë", "Veternik", "Arbëri", "Bregu i Diellit", "Aktash", "Mati", "Kalabri", "Lakrishtë"];
  const found = areas.find((x) => source.toLowerCase().includes(x.toLowerCase()));
  return found || "";
}

function extractPasteSchedule(raw) {
  const text = s(raw);
  const low = text.toLowerCase();
  const bits = [];
  if (/\bsot\b/i.test(low)) bits.push("SOT");
  if (/\bnes[eë]r\b/i.test(low)) bits.push("NESËR");
  const date = text.match(/\b(\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/);
  if (date?.[1]) bits.push(date[1]);
  const time = text.match(/\b(?:ora\s*)?(\d{1,2}[:.]\d{2}|\d{1,2}\s?(?:am|pm))\b/i);
  if (time?.[1]) bits.push(`ORA ${time[1].replace(".", ":")}`);
  const window = text.match(/\b(paradite|pasdite|mbr[eë]mje|mramje|mengjes|mëngjes)\b/i);
  if (window?.[1]) bits.push(up(window[1]));
  return bits.join(" • ");
}

function extractPastePieces(raw) {
  const m = s(raw).match(/\b(\d{1,3})\s*(cop[eë]|copa|tepih[aë]?|tepihat|qilim[aë]?)\b/i);
  return m?.[1] ? String(Number(m[1])) : "";
}

function emptyDispatchPasteResult(raw = "") {
  return {
    originalText: s(raw),
    name: "",
    phoneOriginal: "",
    phoneNormalized: "",
    phoneLinkDigits: "",
    address: "",
    area: "",
    schedule: "",
    pieces: "",
    wantsDiscount: false,
    notes: s(raw),
    hasPhone: false,
    hasName: false,
    missingAddress: true,
    missingSchedule: true,
    source: "",
    error: "",
  };
}

function parseDispatchPasteText(raw) {
  try {
    const text = s(raw);
    if (!text) return emptyDispatchPasteResult("");
    const lines = text.split(/[\n\r]+/).map((x) => s(x)).filter(Boolean);
    const contact = parseDispatchContactImport(text);
    const phoneOriginal = extractPastePhone(text) || contact?.contactPhoneOriginal || "";
    const phoneNorm = normalizeContactPhone(phoneOriginal);
    const address = extractPasteAddress(lines, text) || contact?.address || "";
    const schedule = extractPasteSchedule(text) || contact?.schedule || "";
    const name = contact?.contactName || guessPasteName(lines, phoneOriginal) || "";
    const source = /BEGIN:VCARD|\bFN(?:;[^:]*)?:|\bTEL(?:;[^:]*)?:/i.test(text) || (contact?.hasPhone && !address)
      ? "KONTAKT NGA VIBER/WHATSAPP"
      : "MESAZH NGA VIBER/WHATSAPP";
    const result = {
      originalText: text,
      name,
      phoneOriginal,
      phoneNormalized: phoneNorm.normalized,
      phoneLinkDigits: phoneNorm.linkDigits,
      address,
      area: extractPasteArea(address, text),
      schedule,
      pieces: extractPastePieces(text),
      wantsDiscount: DISPATCH_DISCOUNT_RE.test(text),
      notes: text,
      hasPhone: !!phoneOriginal,
      hasName: !!name,
      missingAddress: !address,
      missingSchedule: !schedule,
      source,
      error: "",
    };
    return result;
  } catch (error) {
    return { ...emptyDispatchPasteResult(raw), error: error?.message || "PARSER_ERROR" };
  }
}

function smartPastePreviewChips(result) {
  const r = result || emptyDispatchPasteResult("");
  const chips = [];
  if (r.name) chips.push({ label: `EMRI: ${up(r.name)}`, kind: "ok" });
  else chips.push({ label: "PA EMËR", kind: "bad" });
  if (r.phoneOriginal) chips.push({ label: `TEL: ${r.phoneOriginal}${r.phoneNormalized && r.phoneNormalized !== r.phoneOriginal ? ` → ${r.phoneNormalized}` : ""}`, kind: "ok" });
  else chips.push({ label: "PA TELEFON", kind: "bad" });
  if (r.address) chips.push({ label: `ADRESË: ${r.address}`, kind: "ok" });
  else chips.push({ label: "PA ADRESË", kind: "bad" });
  if (r.schedule) chips.push({ label: `ORAR: ${r.schedule}`, kind: "ok" });
  else chips.push({ label: "PA ORAR", kind: "warn" });
  if (r.pieces) chips.push({ label: `COPA: ${r.pieces}`, kind: "ok" });
  if (r.area) chips.push({ label: `ZONA: ${r.area}`, kind: "ok" });
  if (r.wantsDiscount) chips.push({ label: "ZBRITJE", kind: "warn" });
  if (r.missingAddress || r.missingSchedule || !r.hasPhone || !r.hasName) chips.push({ label: "DUHET KONFIRMIM", kind: "warn" });
  chips.push({ label: r.source || "VIBER/WHATSAPP", kind: "ok" });
  return chips;
}

function emptySmartCreateFillStatus() {
  return {
    smartCreateFilled: false,
    smartCreateMissingAddress: false,
    smartCreateMissingSchedule: false,
    smartCreateContactImported: false,
    smartCreateReady: false,
  };
}

function buildSmartCreateFillStatus(result) {
  const r = result || emptyDispatchPasteResult("");
  const missingAddress = !!r.missingAddress;
  const missingSchedule = !!r.missingSchedule;
  const contactImported = /KONTAKT/i.test(s(r.source));
  return {
    smartCreateFilled: true,
    smartCreateMissingAddress: missingAddress,
    smartCreateMissingSchedule: missingSchedule,
    smartCreateContactImported: contactImported,
    smartCreateReady: !!(r.hasName && r.hasPhone && !missingAddress && !missingSchedule),
  };
}

function smartCreateFillChips(status) {
  const st = status || emptySmartCreateFillStatus();
  const chips = [{ label: "NGA SMART CREATE", kind: "ok" }];
  if (st.smartCreateContactImported) chips.push({ label: "KONTAKT IMPORT", kind: "ok" });
  if (st.smartCreateMissingAddress) chips.push({ label: "PA ADRESË", kind: "bad" });
  if (st.smartCreateMissingSchedule) chips.push({ label: "PA ORAR", kind: "warn" });
  if (st.smartCreateMissingAddress || st.smartCreateMissingSchedule) chips.push({ label: "DUHET KONFIRMIM", kind: "warn" });
  if (st.smartCreateReady) chips.push({ label: "GATI PËR KRIJIM", kind: "ok" });
  return chips;
}

function confirmSmartCreateIncomplete(status) {
  const st = status || emptySmartCreateFillStatus();
  if (!st.smartCreateFilled) return true;
  const missingAddress = !!st.smartCreateMissingAddress;
  const missingSchedule = !!st.smartCreateMissingSchedule;
  if (!missingAddress && !missingSchedule) return true;
  let text = "";
  if (missingAddress && missingSchedule) {
    text = "Ky order nuk ka adresë dhe orar. A do me e ruajt si draft/manual dhe me konfirmu më vonë?";
  } else if (missingAddress) {
    text = "Ky order nuk ka adresë. A do me e ruajt si draft/manual dhe me konfirmu më vonë?";
  } else {
    text = "Ky order nuk ka orar. A do me e ruajt dhe me caktu orarin më vonë?";
  }
  try {
    return window.confirm(text);
  } catch {
    return true;
  }
}


function emptyDispatchContactImportResult(raw = "") {
  return {
    originalText: s(raw),
    contactName: "",
    contactPhoneOriginal: "",
    contactPhoneNormalized: "",
    contactPhoneLinkDigits: "",
    address: "",
    schedule: "",
    hasPhone: false,
    hasName: false,
    missingAddress: true,
    missingSchedule: true,
    source: "KONTAKT NGA VIBER/WHATSAPP",
    error: "",
  };
}

function splitContactImportLines(raw) {
  return s(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]+/g, " ")
    .split(/\n+/)
    .map((x) => s(x))
    .filter(Boolean);
}

function extractContactVCardField(raw, fields) {
  try {
    const lines = splitContactImportLines(raw);
    for (const line of lines) {
      for (const field of fields) {
        const re = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, "i");
        const hit = line.match(re);
        if (hit?.[1]) return s(hit[1].replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";"));
      }
    }
  } catch {}
  return "";
}

function normalizeContactVCardName(value) {
  const raw = s(value);
  if (!raw) return "";
  if (!raw.includes(";")) return raw;
  const parts = raw.split(";").map((x) => s(x)).filter(Boolean);
  if (parts.length >= 2) return [parts[1], parts[0], ...parts.slice(2)].filter(Boolean).join(" ");
  return parts.join(" ");
}

function extractContactLineValue(lines, labels) {
  for (const line of lines || []) {
    const clean = s(line);
    if (!clean) continue;
    for (const label of labels) {
      const re = new RegExp(`^\\s*${label}\\s*[:=\\u2013-]\\s*(.+)$`, "i");
      const hit = clean.match(re);
      if (hit?.[1]) return s(hit[1]);
    }
  }
  return "";
}

function cleanContactPhoneOriginal(value) {
  return s(value)
    .replace(/^(tel|telefon|phone|mobile|cell|cel)\s*[:=\u2013-]\s*/i, "")
    .replace(/[;,]+$/g, "")
    .trim();
}

function scoreContactPhoneCandidate(candidate) {
  const raw = cleanContactPhoneOriginal(candidate);
  const digits = onlyDigits(raw);
  if (digits.length < 7) return -99;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(raw)) return -30;
  let score = 0;
  if (raw.startsWith("+")) score += 6;
  if (/^04\d{7}$/.test(digits) || /^3834\d{7}$/.test(digits) || /^4\d{7}$/.test(digits)) score += 8;
  if (digits.length >= 10) score += 3;
  if (digits.length > 15) score -= 3;
  return score;
}

function extractContactPhone(raw, lines) {
  const telFromVcard = extractContactVCardField(raw, ["TEL"]);
  if (telFromVcard) return cleanContactPhoneOriginal(telFromVcard);

  const labelled = extractContactLineValue(lines, ["tel", "telefoni", "telefon", "phone", "mobile", "cell", "cel"]);
  if (labelled) return cleanContactPhoneOriginal(labelled);

  const matches = s(raw).match(/(?:\+|00)?\d[\d\s().-]{5,}\d/g) || [];
  let best = "";
  let bestScore = -100;
  for (const candidate of matches) {
    const clean = cleanContactPhoneOriginal(candidate);
    const score = scoreContactPhoneCandidate(clean);
    if (score > bestScore) {
      best = clean;
      bestScore = score;
    }
  }
  return bestScore > -20 ? best : "";
}

function normalizeContactPhone(raw) {
  const original = cleanContactPhoneOriginal(raw);
  const compact = original.replace(/[\s().-]+/g, "");
  const digits = onlyDigits(compact);
  let normalized = "";

  if (!digits) normalized = "";
  else if (/^04\d{7}$/.test(digits)) normalized = `+383${digits.slice(1)}`;
  else if (/^3834\d{7}$/.test(digits)) normalized = `+${digits}`;
  else if (/^4\d{7}$/.test(digits)) normalized = `+383${digits}`;
  else if (/^\+3834\d{7}$/.test(compact)) normalized = compact;
  else if (compact.startsWith("+")) normalized = `+${digits}`;
  else if (digits.length >= 10 && digits.length <= 15) normalized = `+${digits}`;
  else normalized = original;

  const linkDigits = normalized.startsWith("+") ? normalized.slice(1) : onlyDigits(normalized);
  return { original, normalized, linkDigits };
}

function stripContactPhoneFromLine(line, phoneOriginal) {
  let value = s(line);
  const phone = s(phoneOriginal);
  if (phone) value = s(value.replace(phone, ""));
  const phoneDigits = onlyDigits(phone);
  if (phoneDigits) {
    const compactDigits = onlyDigits(value);
    if (compactDigits === phoneDigits) return "";
    value = s(value.replace(/(?:\+|00)?\d[\d\s().-]{5,}\d/g, ""));
  }
  return value.replace(/\s{2,}/g, " ").trim();
}

function extractContactName(raw, lines, phoneOriginal) {
  const fn = extractContactVCardField(raw, ["FN"]);
  if (fn) return normalizeContactVCardName(fn);
  const n = extractContactVCardField(raw, ["N"]);
  if (n) return normalizeContactVCardName(n);

  const labelled = extractContactLineValue(lines, ["emri", "emer", "emër", "name", "klienti", "klient", "customer"]);
  if (labelled) return stripContactPhoneFromLine(labelled, phoneOriginal);

  for (const line of lines || []) {
    let clean = stripContactPhoneFromLine(line, phoneOriginal);
    clean = clean.replace(/^(emri|emer|emër|name|klienti|klient|customer)\s*[:=\u2013-]\s*/i, "").trim();
    if (!clean) continue;
    if (/^(begin|end|version|tel|telefon|phone|mobile|cell|adr|email|org|title)\b/i.test(clean)) continue;
    if (/\d{2,}/.test(clean)) continue;
    if (/[a-zA-ZçÇëË]/.test(clean) && clean.length <= 64) return clean;
  }
  return "";
}

function extractContactAddress(raw, lines) {
  const adr = extractContactVCardField(raw, ["ADR"]);
  if (adr) return s(adr.split(";").map((x) => s(x)).filter(Boolean).join(", "));
  return extractPasteAddress(lines, raw);
}

function parseDispatchContactImport(raw) {
  try {
    const text = s(raw);
    if (!text) return emptyDispatchContactImportResult("");
    const lines = splitContactImportLines(text);
    const phoneOriginal = extractContactPhone(text, lines);
    const phoneNorm = normalizeContactPhone(phoneOriginal);
    const address = extractContactAddress(text, lines);
    const schedule = extractPasteSchedule(text);
    const contactName = extractContactName(text, lines, phoneOriginal);
    return {
      originalText: text,
      contactName,
      contactPhoneOriginal: phoneNorm.original || phoneOriginal,
      contactPhoneNormalized: phoneNorm.normalized,
      contactPhoneLinkDigits: phoneNorm.linkDigits,
      address,
      schedule,
      hasPhone: !!(phoneNorm.original || phoneOriginal),
      hasName: !!contactName,
      missingAddress: !address,
      missingSchedule: !schedule,
      source: "KONTAKT NGA VIBER/WHATSAPP",
      error: "",
    };
  } catch (error) {
    return { ...emptyDispatchContactImportResult(raw), error: error?.message || "CONTACT_IMPORT_PARSER_ERROR" };
  }
}

function hasDiscountLanguage(value) {
  return DISPATCH_DISCOUNT_RE.test(s(value));
}

function rowNeedsDiscountReview(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return !!(
    data.wants_discount ||
    data.discount_requested ||
    data.client_requested_discount ||
    hasDiscountLanguage([data.note, data.client_note, data.customer_note, data.dispatch_note, data.original_text, row?.note].join(" "))
  );
}

function getDispatchWarnings(row) {
  const warnings = [];
  if (!getClientPhone(row)) warnings.push("PA TELEFON");
  if (!getAddress(row)) warnings.push("PA ADRESË");
  if (rowNeedsDriver(row)) warnings.push("PA SHOFER");
  if (rowSource(row) === "online" && !getTransportTCode(row)) warnings.push("ONLINE PA T-CODE");
  if (rowNeedsDiscountReview(row)) warnings.push("KËRKON ZBRITJE");
  return warnings;
}

function dispatchTaskLabel(row) {
  const label = dispatchStatusLabel(row).toLowerCase();
  const raw = rawStatus(getDbTruthStatus(row) || "");
  if (label.includes("dor") || raw.includes("delivery") || raw.includes("dorz") || raw === "gati") return "DORËZIM";
  return "MARRJE";
}

function buildDriverCopyText(row) {
  if (!row) return "";
  return [
    `Klienti: ${getClientName(row) || "—"}`,
    `Tel: ${normalizeKosovoPhone(getClientPhone(row)).normalized || getClientPhone(row) || "—"}`,
    `Adresa: ${getAddress(row) || "—"}`,
    `Kodi: ${getDispatchCardCode(row) || "—"}`,
    `Detyra: ${dispatchTaskLabel(row)}`,
    `Koha: ${getScheduleText(row) || "—"}`,
    `Shënim: ${s(row?.data?.note || row?.data?.client_note || row?.note || "—")}`,
  ].join("\n");
}

function buildPasteDriverCopyText(parsed) {
  const r = parsed || emptyDispatchPasteResult("");
  const phoneText = r.phoneNormalized || r.phoneOriginal || "—";
  const contactOnlyNeedsAddress = !!(r.name || r.phoneOriginal || r.phoneNormalized) && !r.address && !r.schedule && !r.pieces;
  if (contactOnlyNeedsAddress) {
    return [
      `Klienti: ${r.name || "—"}`,
      `Tel: ${phoneText}`,
      "Adresa: PA ADRESË",
      "Detyra: Duhet konfirmim",
      "Shënim: Klienti u importua nga kontakt/Viber/WhatsApp. Duhet me kërku adresën/lokacionin.",
    ].join("\n");
  }
  return [
    `Klienti: ${r.name || "—"}`,
    `Tel: ${phoneText}`,
    `Adresa: ${r.address || "PA ADRESË"}`,
    "Kodi: PA KOD",
    `Detyra: ${r.address ? "MARRJE" : "Duhet konfirmim"}`,
    `Koha: ${r.schedule || "—"}`,
    `Shënim: ${[r.pieces ? `${r.pieces} copë` : "", r.area ? `Zona: ${r.area}` : "", r.wantsDiscount ? "Kërkon zbritje" : "", !r.address ? "Duhet me kërku adresën/lokacionin." : ""].filter(Boolean).join(" • ") || "—"}`,
  ].join("\n");
}

function buildSmartPasteAddressRequestText(result) {
  const r = result || emptyDispatchPasteResult("");
  const name = r.name || "klient";
  return `Përshëndetje ${name}, ju lutem na dërgoni adresën/lokacionin dhe kohën që ju përshtatet për marrjen e tepihave. Faleminderit.`;
}


function buildCustomerConfirmText(row) {
  const name = getClientName(row) || "klient";
  return `Përshëndetje ${name}, ju kontaktojmë nga pastrimi i tepihave. Ju lutem na konfirmoni adresën dhe kohën që ju përshtatet. Faleminderit.`;
}

function replaceDispatchPlaceholders(template, row) {
  const name = getClientName(row) || "klient";
  const code = getDispatchCardCode(row) || "—";
  const tel = normalizeKosovoPhone(getClientPhone(row)).normalized || getClientPhone(row) || "—";
  const address = getAddress(row) || "—";
  const schedule = getScheduleText(row) || "—";
  const note = s(row?.data?.note || row?.data?.client_note || row?.note || "");
  return s(template)
    .replaceAll("{EMRI}", name)
    .replaceAll("{KODI}", code)
    .replaceAll("{TEL}", tel)
    .replaceAll("{ADRESA}", address)
    .replaceAll("{DATA/ORARI}", schedule)
    .replaceAll("{ORARI}", schedule)
    .replaceAll("{NOTE}", note || "—");
}

function buildDriverChipText(label, row, rows) {
  const name = getClientName(row) || "klienti";
  const phone = normalizeKosovoPhone(getClientPhone(row)).normalized || getClientPhone(row) || "—";
  const address = getAddress(row) || "—";
  const code = getDispatchCardCode(row) || "—";
  if (label === "COPY KLIENTIN") return buildDriverCopyText(row);
  if (label === "COPY LISTËN E SOTME") {
    const list = (rows || []).slice(0, 30).map((r, idx) => `${idx + 1}. ${getDispatchCardCode(r)} • ${getClientName(r) || "PA EMËR"} • ${normalizeKosovoPhone(getClientPhone(r)).normalized || getClientPhone(r) || "PA TEL"} • ${getAddress(r) || "PA ADRESË"} • ${getScheduleText(r)}`).join("\n");
    return list || "Nuk ka listë të sotme në Dispatch.";
  }
  if (label === "THIRR KLIENTIN PARA SE ME SHKU") return `Para se me shku, thirre klientin: ${name}\nTel: ${phone}\nAdresa: ${address}\nKodi: ${code}`;
  if (label === "KLIENTI KËRKON LOKACION") return `Klienti ${name} kërkon lokacion/koordinim. Dërgo lokacionin ose thirre para nisjes.\nTel: ${phone}\nAdresa: ${address}\nKodi: ${code}`;
  if (label === "KLIENTI KËRKON ZBRITJE") return `Kujdes: klienti ${name} kërkon zbritje. Mos ndrysho çmim në teren pa aprovim.\nTel: ${phone}\nKodi: ${code}`;
  if (label === "KUJDES: PAGESA NË DORËZIM") return `Kujdes: pagesa duhet me u marrë në dorëzim te klienti ${name}.\nTel: ${phone}\nAdresa: ${address}\nKodi: ${code}`;
  return buildDriverCopyText(row);
}

function buildDiscountChipText(label, row) {
  const name = getClientName(row) || "klient";
  if (label === "-5% PROPOZIM") return `Përshëndetje ${name}, mund t’ju propozojmë -5% zbritje nëse aprovohet nga administrata. Çmimi final konfirmohet pas matjes.`;
  if (label === "-10% PROPOZIM") return `Përshëndetje ${name}, për zbritje -10% duhet aprovim nga administrata. Çmimi final konfirmohet pas matjes.`;
  if (label === "KLIENT I RREGULLT") return `Përshëndetje ${name}, pasi jeni klient i rregullt, do ta shënojmë për zbritje dhe do t’ju konfirmojmë totalin pas matjes.`;
  if (label === "KËRKON APROVIM ADMIN") return `KLIENTI KËRKON ZBRITJE. Duhet aprovim admin para se të ndryshohet çmimi. Klienti: ${name}. Kodi: ${getDispatchCardCode(row) || "—"}.`;
  return "";
}

async function copyDispatchPlainText(text) {
  const value = s(text);
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

function outboundHref(channel, phoneValue, text) {
  const norm = normalizeKosovoPhone(phoneValue);
  const body = encodeURIComponent(s(text));
  if (channel === "whatsapp" && norm.linkDigits) return `https://wa.me/${norm.linkDigits}${body ? `?text=${body}` : ""}`;
  if (channel === "viber" && norm.normalized) return `viber://chat?number=${encodeURIComponent(norm.normalized)}`;
  if (channel === "sms" && norm.normalized) return `sms:${encodeURIComponent(norm.normalized)}${body ? `?body=${body}` : ""}`;
  return "";
}

function sameCustomer(a, b) {
  const p1 = getClientPhone(a);
  const p2 = getClientPhone(b);
  if (p1 && p2 && p1 === p2) return true;
  const n1 = up(getClientName(a));
  const n2 = up(getClientName(b));
  const a1 = up(getAddress(a));
  const a2 = up(getAddress(b));
  return !!n1 && !!n2 && n1 === n2 && (!!a1 ? a1 === a2 : true);
}

function DispatchCard({ row, onOpen }) {
  const code = getDispatchCardCode(row);
  const driver = orderAssignedDriver(row) || "PA SHOFER";
  const pay = getPaymentInfo(row);
  const pieces = getRowPieces(row);
  const address = getAddress(row);
  const status = shortStatusLabel(row);
  const warnings = getDispatchWarnings(row);
  const hasPaymentInfo = [pay.total, pay.paid, pay.debt].some((value) => value !== null && value !== undefined);
  const piecesText = Number(pieces || 0) > 0 ? `${pieces} copë` : "COPË: PA REGJISTRUAR";
  return (
    <button type="button" onClick={() => onOpen(row)} style={ui.orderCardBtn}>
      <div style={ui.orderCard}>
        <div style={ui.codePill}>{code}</div>
        <div style={ui.cardBody}>
          <div style={ui.compactTop}>
            <div style={ui.cardNameWrap}>
              <span style={ui.compactName}>{up(getClientName(row) || "PA EMËR")}</span>
            </div>
            <span style={normalizeStatus(getDbTruthStatus(row)) === "DORZIM" ? ui.badgeWarn : ui.badgeOk}>{status}</span>
          </div>

          <div style={ui.cardLabel}>ADRESA</div>
          <div style={address ? ui.addressStrong : ui.addressWarn}>{address || "PA ADRESË"}</div>
          {warnings.length ? (
            <div style={ui.readonlyBadgeRow}>
              {warnings.map((w) => <span key={`${code}_${w}`} style={w.includes("ZBRITJE") ? ui.badgeWarn : ui.badgeBad}>{w}</span>)}
            </div>
          ) : null}

          {hasPaymentInfo ? (
            <div style={ui.moneyGrid}>
              <div><span style={ui.moneyLabel}>TOTALI:</span> <strong>{moneyDash(pay.total)}</strong></div>
              <div><span style={ui.moneyLabel}>PAGUAR:</span> <strong>{moneyDash(pay.paid)}</strong></div>
              <div><span style={rowHasDebt(row) ? ui.debtStrong : ui.moneyLabel}>BORXH:</span> <strong>{moneyDash(pay.debt)}</strong></div>
            </div>
          ) : (
            <div style={ui.moneyLine}><span style={ui.moneyLabel}>TOTALI:</span> <strong>PA LLOGARITUR</strong></div>
          )}

          <div style={ui.cardFooterRow}>
            <span style={ui.compactSub}>{piecesText}{hasPaymentInfo && pay.total !== null ? ` • ${moneyDash(pay.total)}` : ""}</span>
            <span style={ui.compactSub}>Shoferi: {driver}</span>
            <span style={ui.compactSub}>Orari: {getScheduleText(row)}</span>
            <span style={ui.compactOpen}>HAP ➔</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function CancellationRow({ row, onOpen }) {
  const code = getDispatchCardCode(row);
  return (
    <div style={ui.cancelCard}>
      <div style={ui.cancelTop}>
        <div style={ui.cancelCode}>{code}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={ui.cancelName}>{up(getClientName(row) || "PA EMËR")}</div>
          <div style={ui.cancelSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
        </div>
        <span style={ui.badgeBad}>{isFailedRow(row) ? "DËSHTUAR" : "ANULUAR"}</span>
      </div>
      <div style={ui.cancelReason}>ARSYE: {up(cancelReason(row))}</div>
      <div style={ui.cancelMeta}>
        <span>{niceDate(cancelledAtMs(row))}</span>
        <span>BURIMI: {cancelSource(row)}</span>
        <span>NGA: {up(cancelActor(row))}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" style={ui.btnGhostMini} onClick={() => onOpen(row)}>HAP</button>
      </div>
    </div>
  );
}

function DispatchAccessScreen({ checking = false }) {
  return (
    <div style={ui.accessPage}>
      <div style={ui.accessCard}>
        <div style={ui.accessTitle}>{checking ? "DUKE KONTROLLUAR QASJEN" : "NUK KENI QASJE NË DISPATCH"}</div>
        <div style={ui.accessSub}>{checking ? "Ju lutem prisni." : "Ky modul hapet vetëm për DISPATCH / ADMIN."}</div>
        <Link href="/" prefetch={false} style={ui.accessBtn}>KTHEHU NË HOME</Link>
      </div>
    </div>
  );
}

export default function DispatchPage() {
  const todayYmd = useMemo(() => toLocalYmd(new Date()), []);
  const tomorrowYmd = useMemo(() => addDaysYmd(toLocalYmd(new Date()), 1), []);

  const [activeTab, setActiveTab] = useState(TAB_TODAY);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [drivers, setDrivers] = useState([]);
  const [driverId, setDriverId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [allRows, setAllRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [crmQuery, setCrmQuery] = useState("");
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmOpen, setCrmOpen] = useState(false);
  const [crmHits, setCrmHits] = useState([]);
  const [phoneHit, setPhoneHit] = useState(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [planMode, setPlanMode] = useState("today");
  const [customDate, setCustomDate] = useState(todayYmd);
  const [slot, setSlot] = useState("morning");
  const [selectedRow, setSelectedRow] = useState(null);
  const [editDate, setEditDate] = useState(todayYmd);
  const [editSlot, setEditSlot] = useState("morning");
  const [editDriver, setEditDriver] = useState("");
  const [editNote, setEditNote] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusyId, setDeleteBusyId] = useState("");
  const [searchTimer, setSearchTimer] = useState(null);
  const phoneTimer = useRef(null);
  const nameRef = useRef('');
  const addressRef = useRef('');
  const autoAddressRef = useRef({ phoneKey: '', address: '' });
  const uiReadyMarkedRef = useRef(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const [accessAllowed, setAccessAllowed] = useState(false);
  const [liveMode, setLiveMode] = useState("POLL");
  const [commandOpen, setCommandOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandFilter, setCommandFilter] = useState("");
  const [commandDriverFilter, setCommandDriverFilter] = useState("all");
  const [copyMsg, setCopyMsg] = useState("");
  const [smartPasteText, setSmartPasteText] = useState("");
  const [smartPasteResult, setSmartPasteResult] = useState(() => emptyDispatchPasteResult(""));
  const [smartPasteAnalyzed, setSmartPasteAnalyzed] = useState(false);
  const [smartPasteMsg, setSmartPasteMsg] = useState("");
  const [smartCreateFillStatus, setSmartCreateFillStatus] = useState(() => emptySmartCreateFillStatus());
  const [smartMessageText, setSmartMessageText] = useState("");
  const [smartMessageLabel, setSmartMessageLabel] = useState("");
  const [customerMessagesOpen, setCustomerMessagesOpen] = useState(false);
  const [driverMessagesOpen, setDriverMessagesOpen] = useState(false);
  const [discountMessagesOpen, setDiscountMessagesOpen] = useState(false);
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false);
  const realtimeTimerRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const refreshAccess = () => {
      const actor = getActor() || null;
      const allowed = canAccessDispatch(actor);
      if (!alive) return;
      setAccessAllowed(allowed);
      setAccessChecked(true);
      try { bootLog(allowed ? "dispatch_access_allowed" : "dispatch_access_denied", { role: actor?.role || "", hasPin: !!actor?.pin }); } catch {}
    };
    refreshAccess();
    try { window.addEventListener("tepiha:session-changed", refreshAccess); } catch {}
    try { window.addEventListener("storage", refreshAccess); } catch {}
    return () => {
      alive = false;
      try { window.removeEventListener("tepiha:session-changed", refreshAccess); } catch {}
      try { window.removeEventListener("storage", refreshAccess); } catch {}
    };
  }, []);

  useEffect(() => {
    const markReady = (source = "dispatch_first_paint") => {
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      const path = typeof window !== "undefined" ? String(window.location?.pathname || "/dispatch") : "/dispatch";
      try { bootLog("ui_ready", { page: "dispatch", path, source }); } catch {}
      try { bootMarkReady({ page: "dispatch", path, source }); } catch {}
      try { window.__TEPIHA_UI_READY = true; } catch {}
    };

    let raf1 = 0;
    let raf2 = 0;
    let timer = 0;

    try {
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => markReady("dispatch_first_paint"));
      });
      timer = window.setTimeout(() => markReady("dispatch_ready_fallback"), 1800);
    } catch {
      markReady("dispatch_ready_sync_fallback");
    }

    return () => {
      try { if (raf1) window.cancelAnimationFrame(raf1); } catch {}
      try { if (raf2) window.cancelAnimationFrame(raf2); } catch {}
      try { if (timer) window.clearTimeout(timer); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    (async () => {
      const res = await listUsers();
      if (res?.ok) {
        const ds = (res.items || []).filter((u) => {
          const roleOk = String(u.role || "").toUpperCase() === "TRANSPORT";
          const hybridOk = u?.is_hybrid_transport === true;
          const activeOk = u?.is_active !== false;
          return activeOk && (roleOk || hybridOk);
        });
        setDrivers(ds);
        if (ds.length === 1) setDriverId(String(ds[0].id));
      }
    })();
  }, [accessChecked, accessAllowed]);

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const merged = keepDispatchTransportOnly(
        await listMixedOrderRecords({
          tables: ["transport_orders"],
          byTable: {
            transport_orders: { orderBy: "updated_at", ascending: false, limit: DISPATCH_LOAD_LIMIT_TRANSPORT },
          },
        })
      );
      setAllRows(merged);
    } catch {
      setAllRows([]);
    } finally {
      setLoadingRows(false);
    }
  }, []);

  async function getSearchRows() {
    if (Array.isArray(allRows) && allRows.length) return keepDispatchTransportOnly(allRows);
    return keepDispatchTransportOnly(
      await listMixedOrderRecords({
        tables: ["transport_orders"],
        byTable: {
          transport_orders: { orderBy: "updated_at", ascending: false, limit: DISPATCH_SEARCH_LIMIT_TRANSPORT },
        },
      })
    );
  }

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    const t = setTimeout(() => loadRows(), 350);
    return () => clearTimeout(t);
  }, [accessChecked, accessAllowed, loadRows]);

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    const actor = getActor() || null;
    const bufferOwner = String(actor?.pin || 'DISPATCH').trim() || 'DISPATCH';
    const t = setTimeout(() => {
      void warmDispatchCodeBuffer(bufferOwner, { target: 1 }).catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  }, [accessChecked, accessAllowed]);

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    let channel = null;
    let pollTimer = 0;
    const scheduleLiveRefresh = (delay = 450) => {
      try { if (realtimeTimerRef.current) window.clearTimeout(realtimeTimerRef.current); } catch {}
      try { realtimeTimerRef.current = window.setTimeout(() => loadRows(), delay); } catch {}
    };

    try {
      if (supabase && typeof supabase.channel === "function") {
        channel = supabase
          .channel("dispatch-transport-live-v2")
          .on("postgres_changes", { event: "*", schema: "public", table: "transport_orders" }, () => scheduleLiveRefresh(350))
          .subscribe((status) => {
            if (String(status || "").toUpperCase() === "SUBSCRIBED") setLiveMode("REALTIME");
          });
      }
    } catch {
      setLiveMode("POLL");
    }

    pollTimer = window.setInterval(() => {
      try { if (document?.visibilityState === "hidden") return; } catch {}
      loadRows();
    }, 20000);

    return () => {
      try { if (realtimeTimerRef.current) window.clearTimeout(realtimeTimerRef.current); } catch {}
      try { if (pollTimer) window.clearInterval(pollTimer); } catch {}
      try { if (channel && supabase?.removeChannel) supabase.removeChannel(channel); } catch {}
    };
  }, [accessChecked, accessAllowed, loadRows]);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  useEffect(() => {
    const digits = onlyDigits(phone);
    const phoneDigits = getDispatchPhoneDigits(digits);
    if (phoneTimer.current) clearTimeout(phoneTimer.current);

    setCrmHits([]);
    setCrmOpen(false);

    const auto = autoAddressRef.current || { phoneKey: '', address: '' };
    if (auto.phoneKey && auto.phoneKey !== phoneDigits) {
      if (auto.address && s(addressRef.current) === auto.address) setAddress('');
      autoAddressRef.current = { phoneKey: '', address: '' };
    }

    if (!isValidTransportPhoneDigits(phoneDigits)) {
      setPhoneHit(null);
      return;
    }

    phoneTimer.current = setTimeout(async () => {
      setPhoneBusy(true);
      try {
        const rawHit = await findTransportClientByPhoneOnly(phone, { timeoutMs: 5500 }).catch(() => null);
        const hit = rawHit && dispatchSamePhone(getClientPhone(rawHit) || rawHit?.phone_digits || rawHit?.phone, phone) ? rawHit : null;
        setPhoneHit(hit || null);
        if (hit && !s(nameRef.current)) setName(getClientName(hit));
        if (hit && !s(addressRef.current)) {
          const hitAddress = getAddress(hit);
          if (hitAddress) {
            setAddress(hitAddress);
            autoAddressRef.current = { phoneKey: getDispatchPhoneDigits(phone), address: hitAddress };
          }
        }
      } catch {
        setPhoneHit(null);
      } finally {
        setPhoneBusy(false);
      }
    }, 320);
    return () => {
      if (phoneTimer.current) clearTimeout(phoneTimer.current);
    };
  }, [phone]);

  useEffect(() => {
    if (searchTimer) clearTimeout(searchTimer);
    const q = s(crmQuery);
    if (q.length < 2) {
      setCrmHits([]);
      setCrmOpen(false);
      return;
    }
    const t = setTimeout(() => {
      runSmartSearch(q);
    }, 220);
    setSearchTimer(t);
    return () => clearTimeout(t);
  }, [crmQuery]);

  async function runSmartSearch(q) {
    const queryPhone = getDispatchPhoneDigits(q);
    if (!dispatchPhoneSearchReady(queryPhone)) {
      setCrmHits([]);
      setCrmOpen(false);
      setCrmBusy(false);
      return;
    }
    setCrmBusy(true);
    try {
      const rows = await getSearchRows();
      const hits = rows.filter((row) => dispatchSamePhone(getClientPhone(row) || row?.phone_digits || row?.phone, queryPhone));
      const dedup = [];
      const seen = new Set();
      for (const row of hits) {
        const rowPhone = getDispatchPhoneDigits(getClientPhone(row) || row?.phone_digits || row?.phone);
        if (!rowPhone) continue;
        const key = rowPhone.slice(-8) || rowPhone;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(row);
        if (dedup.length >= 8) break;
      }
      setCrmHits(dedup);
      setCrmOpen(dedup.length > 0);
    } catch {
      setCrmHits([]);
      setCrmOpen(false);
    } finally {
      setCrmBusy(false);
    }
  }

  function applySuggestion(row, options = {}) {
    const rowPhone = getClientPhone(row) || row?.phone_digits || row?.phone || '';
    const currentPhone = phone || crmQuery;
    if (!dispatchSamePhone(rowPhone, currentPhone)) {
      setPhoneHit(null);
      setCrmHits([]);
      setCrmOpen(false);
      return;
    }
    const cleanPhone = getClientPhone(row) || onlyDigits(rowPhone);
    const cleanAddress = getAddress(row);
    setName(getClientName(row));
    setPhone(cleanPhone);
    setAddress(cleanAddress);
    if (cleanAddress) autoAddressRef.current = { phoneKey: getDispatchPhoneDigits(cleanPhone), address: cleanAddress };
    setNote(s(row?.data?.note || row?.data?.client_note || note));
    setCrmQuery(cleanPhone);
    setCrmOpen(false);
    setCrmHits([]);
    setPhoneHit(options?.keepPhoneHit ? row : row);
  }

  function prefillCreateFromCommandSearch() {
    const q = s(commandQuery);
    if (!q) return;
    const digits = onlyDigits(q);
    if (digits.length >= 7) {
      setPhone(digits);
      setCrmQuery(digits);
    } else if (looksLikeTransportCode(q)) {
      setCrmQuery(q);
      setNote((prev) => s(prev) || `Kërkuar nga dispatch: ${q}`);
    } else {
      setName((prev) => s(prev) || q);
      setCrmQuery(q);
    }
    setMsg("SEARCH U KALUA TE SMART CREATE ✅");
    window.setTimeout(() => setMsg(""), 2200);
  }


  function resetSmartCreateFillStatus() {
    setSmartCreateFillStatus(emptySmartCreateFillStatus());
  }

  function markSmartCreateScheduleConfirmed() {
    setSmartCreateFillStatus((prev) => {
      const old = prev || emptySmartCreateFillStatus();
      if (!old.smartCreateFilled) return old;
      const next = { ...old, smartCreateMissingSchedule: false };
      next.smartCreateReady = !!(!next.smartCreateMissingAddress);
      return next;
    });
  }

  function handleSmartPasteChange(value) {
    setSmartPasteText(value);
    setSmartPasteResult(parseDispatchPasteText(value));
    setSmartPasteAnalyzed(false);
    setSmartPasteMsg("");
  }

  function analyzeSmartPaste() {
    const parsed = parseDispatchPasteText(smartPasteText);
    setSmartPasteResult(parsed);
    setSmartPasteAnalyzed(true);
    setSmartPasteMsg(parsed?.error ? "PARSER-I NUK E LEXOI MIRË, POR FAQJA VAZHDON." : "U ANALIZUA LOKALISHT ✅");
    try { window.setTimeout(() => setSmartPasteMsg(""), 2200); } catch {}
  }

  function clearSmartPaste() {
    setSmartPasteText("");
    setSmartPasteResult(emptyDispatchPasteResult(""));
    setSmartPasteAnalyzed(false);
    setSmartPasteMsg("");
    resetSmartCreateFillStatus();
  }

  function smartPasteLiveResult() {
    return smartPasteResult?.originalText ? smartPasteResult : parseDispatchPasteText(smartPasteText);
  }

  function smartPastePhoneValue() {
    const parsed = smartPasteLiveResult();
    return parsed?.phoneNormalized || parsed?.phoneOriginal || "";
  }

  function copySmartPasteAddressRequest() {
    const parsed = smartPasteLiveResult();
    setSmartPasteResult(parsed);
    setSmartPasteAnalyzed(true);
    return copyDispatchText(buildSmartPasteAddressRequestText(parsed), "MESAZHI PËR ADRESË U KOPJUA ✅");
  }

  function openSmartPasteMessage(channel) {
    const parsed = smartPasteLiveResult();
    setSmartPasteResult(parsed);
    setSmartPasteAnalyzed(true);
    openDispatchMessage(channel, parsed?.phoneNormalized || parsed?.phoneOriginal || "", buildSmartPasteAddressRequestText(parsed));
  }

  function callSmartPastePhone() {
    try {
      const phoneValue = smartPastePhoneValue();
      const norm = normalizeContactPhone(phoneValue);
      const tel = norm.normalized || norm.original || phoneValue;
      if (!tel) {
        setCopyMsg("NUK KA TELEFON PËR THIRRJE");
        try { window.setTimeout(() => setCopyMsg(""), 2200); } catch {}
        return;
      }
      window.location.href = `tel:${tel}`;
    } catch {
      setCopyMsg("NUK U HAP THIRRJA");
      try { window.setTimeout(() => setCopyMsg(""), 2200); } catch {}
    }
  }

  function fillFormFromSmartPaste() {
    const parsed = smartPasteLiveResult();
    setSmartPasteResult(parsed);
    setSmartPasteAnalyzed(true);
    setSmartCreateFillStatus(buildSmartCreateFillStatus(parsed));
    if (parsed?.name) setName(parsed.name);
    if (parsed?.phoneOriginal || parsed?.phoneNormalized) setPhone(parsed.phoneNormalized || parsed.phoneOriginal);
    if (parsed?.address) setAddress(parsed.address);
    setCrmQuery("");
    setCrmHits([]);
    setCrmOpen(false);
    const noteLines = [
      parsed?.source ? parsed.source : "NGA VIBER/WHATSAPP",
      parsed?.pieces ? `COPË: ${parsed.pieces}` : "",
      parsed?.schedule ? `ORARI NGA CHAT: ${parsed.schedule}` : "PA ORAR / DUHET KONFIRMIM",
      parsed?.area ? `LAGJJA/QYTETI: ${parsed.area}` : "",
      parsed?.missingAddress ? "PA ADRESË / DUHET KONFIRMIM" : "",
      parsed?.wantsDiscount ? "KËRKON ZBRITJE / ÇMIM MË TË LIRË" : "",
      parsed?.originalText ? `NGA VIBER/WHATSAPP:\n${parsed.originalText}` : "",
    ].filter(Boolean);
    setNote((prev) => [s(prev), noteLines.join("\n")].filter(Boolean).join("\n\n"));
    const lowSchedule = s(parsed?.schedule).toLowerCase();
    if (lowSchedule.includes("nes")) setPlanMode("tomorrow");
    else if (lowSchedule.includes("sot")) setPlanMode("today");
    const hourMatch = lowSchedule.match(/(\d{1,2})[:.]\d{2}|ora\s*(\d{1,2})/i);
    const hour = Number(hourMatch?.[1] || hourMatch?.[2] || NaN);
    if (Number.isFinite(hour)) setSlot(hour >= 17 ? "evening" : "morning");
    setSmartPasteMsg("FORMA U MBUSH. ORDER NUK U KRIJUA ✅");
    try { window.setTimeout(() => setSmartPasteMsg(""), 2600); } catch {}
  }

  function notifyCopyStatus(ok, okText = "U KOPJUA ✅") {
    setCopyMsg(ok ? okText : "NUK U KOPJUA — PROVO PRAP");
    try { window.setTimeout(() => setCopyMsg(""), 2200); } catch {}
  }

  async function copyDispatchText(text, okText = "U KOPJUA ✅") {
    const ok = await copyDispatchPlainText(text);
    notifyCopyStatus(ok, okText);
    return ok;
  }

  function openDispatchMessage(channel, phoneValue, text) {
    try {
      const href = outboundHref(channel, phoneValue, text);
      if (!href) {
        setCopyMsg("NUK KA TELEFON VALID PËR KËTË VEPRIM");
        try { window.setTimeout(() => setCopyMsg(""), 2200); } catch {}
        return;
      }
      if (channel === "viber") copyDispatchPlainText(text).catch(() => {});
      const opened = window.open(href, "_blank", "noopener,noreferrer");
      if (!opened) window.location.href = href;
    } catch {
      setCopyMsg("NUK U HAP MESAZHI");
      try { window.setTimeout(() => setCopyMsg(""), 2200); } catch {}
    }
  }

  function copyFromSelectedRow(kind) {
    if (!selectedRow) return;
    const phoneNorm = normalizeKosovoPhone(selectedPhone).normalized || selectedPhone;
    if (kind === "phone") return copyDispatchText(phoneNorm || selectedPhone, "TEL U KOPJUA ✅");
    if (kind === "name_phone") return copyDispatchText(`${getClientName(selectedRow) || "—"} • ${phoneNorm || "—"}`, "EMRI + TEL U KOPJUA ✅");
    if (kind === "address") return copyDispatchText(getAddress(selectedRow) || "", "ADRESA U KOPJUA ✅");
    if (kind === "driver") return copyDispatchText(buildDriverCopyText(selectedRow), "COPY PËR SHOFER U KOPJUA ✅");
    if (kind === "client") return copyDispatchText(buildCustomerConfirmText(selectedRow), "COPY PËR KLIENT U KOPJUA ✅");
  }

  function pickCustomerMessage(template) {
    if (!selectedRow) return;
    setSmartMessageLabel(template.label);
    setSmartMessageText(replaceDispatchPlaceholders(template.text, selectedRow));
    setOtherOptionsOpen(true);
  }

  function pickDriverMessage(label) {
    if (!selectedRow) return;
    setSmartMessageLabel(label);
    setSmartMessageText(buildDriverChipText(label, selectedRow, todayRows));
    setOtherOptionsOpen(true);
  }

  function pickDiscountMessage(label) {
    if (!selectedRow) return;
    setSmartMessageLabel(label);
    setSmartMessageText(buildDiscountChipText(label, selectedRow));
    setOtherOptionsOpen(true);
  }

  function sendSmartPreview(channel) {
    if (!selectedRow) return;
    openDispatchMessage(channel, selectedPhone, smartMessageText || buildCustomerConfirmText(selectedRow));
  }

  const plannedDate = useMemo(() => {
    if (planMode === "tomorrow") return tomorrowYmd;
    if (planMode === "custom") return customDate || todayYmd;
    return todayYmd;
  }, [planMode, customDate, todayYmd, tomorrowYmd]);

  const dispatchRows = useMemo(() => keepDispatchTransportOnly(allRows), [allRows]);

  const quickFilters = useMemo(() => ([
    { key: "no_driver", label: "PA SHOFER", count: dispatchRows.filter((row) => !isCompletedRow(row) && rowNeedsDriver(row)).length },
    { key: "no_address", label: "PA ADRESË", count: dispatchRows.filter((row) => !isCompletedRow(row) && !getAddress(row)).length },
    { key: "depo", label: "DEPO", count: dispatchRows.filter((row) => !isCompletedRow(row) && isDepotRow(row)).length },
    { key: "gati", label: "GATI", count: dispatchRows.filter((row) => !isCompletedRow(row) && isReadyRow(row)).length },
    { key: "debt", label: "BORXH", count: dispatchRows.filter((row) => rowHasDebt(row)).length },
    { key: "done_today", label: "DORËZUAR SOT", count: dispatchRows.filter((row) => isDoneToday(row)).length },
  ]), [dispatchRows]);

  const commandDriverFilters = useMemo(() => {
    const activeRows = dispatchRows.filter((row) => !isCompletedRow(row));
    return [
      { key: "all", label: "TË GJITHA", count: activeRows.length },
      { key: "base", label: "BAZA", count: activeRows.filter((row) => isBaseSideRow(row)).length },
      ...drivers.map((driver) => {
        const key = driverStableId(driver);
        return {
          key,
          label: driverDisplayName(driver),
          count: activeRows.filter((row) => rowMatchesDriver(row, driver)).length,
        };
      }).filter((x) => !!x.key),
    ];
  }, [dispatchRows, drivers]);

  const commandActive = s(commandQuery).length > 0 || !!commandFilter || commandDriverFilter !== "all";
  const commandRows = useMemo(() => {
    if (!commandActive) return [];
    return dispatchRows
      .filter((row) => matchesCommandSearch(row, commandQuery))
      .filter((row) => matchesCommandFilter(row, commandFilter))
      .filter((row) => matchesCommandDriverFilter(row, commandDriverFilter, drivers))
      .sort((a, b) => sortCommandRows(a, b, commandFilter))
      .slice(0, 50);
  }, [dispatchRows, commandQuery, commandFilter, commandDriverFilter, drivers, commandActive]);

  const daySlotCount = useMemo(() => {
    return dispatchRows.filter((row) => {
      if (isCompletedRow(row)) return false;
      return rowPickupDate(row) === plannedDate && rowPickupSlot(row) === slot;
    }).length;
  }, [dispatchRows, plannedDate, slot]);

  const dayTotalCount = useMemo(() => {
    return dispatchRows.filter((row) => {
      if (isCompletedRow(row)) return false;
      return rowPickupDate(row) === plannedDate;
    }).length;
  }, [dispatchRows, plannedDate]);

  const todayRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowPickupDate(row) === todayYmd)
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows, todayYmd]);

  const tomorrowRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowPickupDate(row) === tomorrowYmd)
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows, tomorrowYmd]);

  const onlineRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowSource(row) === "online")
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows]);

  const phoneRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowSource(row) === "phone")
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows]);

  const liveRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isLiveBoardRow(row))
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 50);
  }, [dispatchRows]);

  const failedRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isFailedRow(row) && !isDispatchRemovedRow(row) && !isCancelledRow(row))
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 20);
  }, [dispatchRows]);

  const cancellationRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isRecentDispatchCancellation(row))
      .sort((a, b) => cancelledAtMs(b) - cancelledAtMs(a))
      .slice(0, 40);
  }, [dispatchRows]);

  const reschedules = useMemo(() => {
    const nowMs = Date.now();
    return dispatchRows
      .filter((r) => {
        const ra = r?.data?.reschedule_at || r?.data?.rescheduleAt || r?.data?.riplanifikim_at;
        const ms = ra ? Date.parse(String(ra)) : NaN;
        return Number.isFinite(ms) && ms > nowMs;
      })
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 20);
  }, [dispatchRows]);

  const tabCounts = useMemo(
    () => ({
      [TAB_TODAY]: todayRows.length,
      [TAB_TOMORROW]: tomorrowRows.length,
      [TAB_ONLINE]: onlineRows.length,
      [TAB_PHONE]: phoneRows.length,
      [TAB_UPDATES]: liveRows.length + failedRows.length + reschedules.length,
      [TAB_CANCELLED]: cancellationRows.length,
    }),
    [todayRows.length, tomorrowRows.length, onlineRows.length, phoneRows.length, liveRows.length, failedRows.length, reschedules.length, cancellationRows.length]
  );

  const smartPasteHasText = s(smartPasteText).length > 0;
  const smartPasteShouldShowPreview = smartPasteHasText || smartPasteAnalyzed;
  const smartPasteHasPhone = !!(smartPasteResult?.phoneNormalized || smartPasteResult?.phoneOriginal);
  const smartCreateLiveFillStatus = useMemo(() => {
    const base = smartCreateFillStatus || emptySmartCreateFillStatus();
    if (!base.smartCreateFilled) return base;
    const next = { ...base, smartCreateMissingAddress: !s(address) };
    next.smartCreateReady = !!(s(name).length >= 2 && isValidTransportPhoneDigits(getDispatchPhoneDigits(phone)) && !next.smartCreateMissingAddress && !next.smartCreateMissingSchedule);
    return next;
  }, [smartCreateFillStatus, address, name, phone]);

  const canSend = useMemo(() => s(name).length >= 2 && isValidTransportPhoneDigits(getDispatchPhoneDigits(phone)), [name, phone]);
  const activePhoneOrder = useMemo(() => findActiveDispatchOrderForPhone(allRows, phone), [allRows, phone]);
  const canCreateNewDispatchOrder = canSend && !activePhoneOrder;

  async function send() {
    if (!canSend) {
      setErr("PLOTËSO EMRIN DHE TELEFON VALID");
      return;
    }
    if (activePhoneOrder) {
      setErr(`KY TELEFON KA POROSI AKTIVE ${getDispatchCardCode(activePhoneOrder)}. NDRYSHO DATËN/ORARIN TE EDITO PLANIN, MOS KRIJO KOD TË RI.`);
      setCreateOpen(false);
      openRow(activePhoneOrder);
      return;
    }
    if (!confirmSmartCreateIncomplete(smartCreateLiveFillStatus)) {
      return;
    }
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const pickedDriver = drivers.find((d) => String(d?.id || "") === String(driverId || "")) || null;
      const pickedDriverName = String(pickedDriver?.name || pickedDriver?.full_name || "").trim();
      const pickedDriverPin = String(pickedDriver?.pin || pickedDriver?.user_pin || "").trim();
      const cleanName = s(name);
      const cleanPhone = onlyDigits(phone);
      const cleanAddress = s(address);
      const cleanNote = s(note);
      const existingPhoneClient = phoneHit && dispatchSamePhone(getClientPhone(phoneHit) || phoneHit?.phone_digits || phoneHit?.phone, cleanPhone) ? phoneHit : null;
      let verifiedPhoneClient = existingPhoneClient || undefined;
      if (verifiedPhoneClient === undefined) {
        let rawPhoneClient = null;
        try {
          rawPhoneClient = await findTransportClientByPhoneOnly(cleanPhone, { timeoutMs: 5500 });
        } catch (error) {
          throw new Error(`NUK U VERIFIKUA KLIENTI ME TELEFON. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
        }
        verifiedPhoneClient = rawPhoneClient && dispatchSamePhone(getClientPhone(rawPhoneClient) || rawPhoneClient?.phone_digits || rawPhoneClient?.phone, cleanPhone)
          ? rawPhoneClient
          : null;
      }
      const actorNow = getActor() || null;
      const poolOwner = pickedDriverPin || String(actorNow?.pin || '').trim() || 'DISPATCH';
      const dispatchBufferOwner = String(actorNow?.pin || 'DISPATCH').trim() || 'DISPATCH';
      let officialOrderCode = '';
      let clientLink = null;
      let lastTcodeConflict = null;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const dispatchOid = `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${attempt}`;
        try {
          officialOrderCode = normTCode(await getDispatchBufferedTransportCode(dispatchBufferOwner, { oid: dispatchOid }));
        } catch (error) {
          throw new Error(`NUK U REZERVUA T-CODE ZYRTAR. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
        }

        if (!officialOrderCode) {
          throw new Error('NUK U REZERVUA T-CODE ZYRTAR. POROSIA NUK U RUAJT.');
        }

        try {
          clientLink = await ensureDispatchTransportClientLink({
            name: cleanName,
            phone: cleanPhone,
            address: cleanAddress,
            existingPhoneClient,
            verifiedPhoneClient,
            tcodeOwner: poolOwner,
            reservedOrderCode: officialOrderCode,
          });
          break;
        } catch (error) {
          if (isDispatchTcodeClientConflict(error)) {
            lastTcodeConflict = error;
            void releaseDispatchBufferedCodeIfUnused(officialOrderCode).catch(() => {});
            officialOrderCode = '';
            continue;
          }
          throw error;
        }
      }

      if (!clientLink) {
        throw new Error(`NUK U GJET T-CODE I LIRË PËR KËTË KLIENT. ${lastTcodeConflict?.message || ''}`.trim());
      }
      // Dispatch-created orders assigned to a driver must appear in TË REJA first.
      // PIKAP starts only after the transporter accepts/starts the order.
      const assignedStatus = driverId ? "assigned" : "inbox";
      const nowIso = new Date().toISOString();
      const payload = {
        status: assignedStatus,
        client_id: clientLink.clientId,
        client_tcode: officialOrderCode,
        code_str: officialOrderCode,
        code_n: tCodeNumber(officialOrderCode),
        client_name: clientLink.name,
        client_phone: clientLink.phone,
        data: {
          client: {
            id: clientLink.clientId,
            tcode: officialOrderCode,
            code: officialOrderCode,
            transport_client_tcode: clientLink.tcode || null,
            order_code: officialOrderCode,
            official_order_code: officialOrderCode,
            name: clientLink.name,
            phone: clientLink.phone,
            phone_digits: clientLink.phoneDigits,
            address: cleanAddress,
          },
          client_id: clientLink.clientId,
          client_tcode: officialOrderCode,
          code_str: officialOrderCode,
          order_code: officialOrderCode,
          official_order_code: officialOrderCode,
          order_tcode: officialOrderCode,
          transport_client_tcode: clientLink.tcode || null,
          status: assignedStatus,
          phone_digits: clientLink.phoneDigits,
          address: cleanAddress,
          note: cleanNote,
          created_by: "DISPATCH",
          created_by_role: "DISPATCH",
          created_by_pin: String(actorNow?.pin || '').trim() || null,
          created_by_name: s(actorNow?.name || actorNow?.full_name || actorNow?.role || 'DISPATCH'),
          order_origin: "DISPATCH",
          defer_dispatch_code: false,
          source: "phone",
          pickup_date: plannedDate,
          pickup_slot: slot,
          pickup_window: slotWindow(slot),
          planning_bucket: planMode === "custom" ? "scheduled" : planMode,
          transport_id: driverId || null,
          transport_user_id: driverId || null,
          transport_name: pickedDriverName || null,
          transport_pin: pickedDriverPin || null,
          actor: pickedDriverName || pickedDriverPin || null,
          driver_name: pickedDriverName || null,
          driver_pin: pickedDriverPin || null,
          assigned_driver_id: driverId || null,
          assigned_at: nowIso,
          last_customer_hit: {
            id: clientLink.clientId,
            tcode: clientLink.tcode,
            order_code: officialOrderCode,
            source: clientLink.source || "transport_clients",
            row_id: clientLink.rowId || null,
            matched_by: "phone_digits",
          },
        },
      };

      if (!payload.client_id || !payload.client_tcode || !payload.code_str || !payload.data?.client?.id || !payload.data?.client?.tcode) {
        throw new Error("TRANSPORT_CLIENT_LINK_INCOMPLETE");
      }

      const createdRecord = await createOrderRecord("transport_orders", payload);
      void markTransportCodeUsed(officialOrderCode, poolOwner).catch(() => {});
      setMsg(`U DËRGUA ${officialOrderCode} ✅`);
      setBusy(false);
      setCreateOpen(false);
      setName("");
      setPhone("");
      setAddress("");
      setNote("");
      setCrmQuery("");
      setCrmHits([]);
      setCrmOpen(false);
      setPhoneHit(null);
      resetSmartCreateFillStatus();
      try {
        const createdItem = createdRecord?.data || createdRecord?.item || createdRecord?.record || payload;
        setAllRows((prev) => keepDispatchTransportOnly([
          {
            ...payload,
            ...(createdItem || {}),
            id: createdItem?.id || payload?.id || `optimistic_${officialOrderCode}_${Date.now()}`,
            _table: 'transport_orders',
          },
          ...(Array.isArray(prev) ? prev : []),
        ]));
      } catch {}
      void warmDispatchCodeBuffer(dispatchBufferOwner).catch(() => {});
      try {
        void loadRows();
      } catch {}
    } catch (e) {
      setErr(e?.message || "GABIM");
    } finally {
      setBusy(false);
    }
  }

  function openRow(row) {
    setSelectedRow(row);
    setEditDate(rowPickupDate(row) || todayYmd);
    setEditSlot(rowPickupSlot(row) || "morning");
    const pickedDriver = drivers.find((d) => String(d?.id || "") === String(row?.data?.transport_id || row?.data?.transport_user_id || ""));
    setEditDriver(String(pickedDriver?.id || row?.data?.transport_id || row?.data?.transport_user_id || ""));
    setEditNote(s(row?.data?.note || ""));
    setSmartMessageLabel("COPY PËR KLIENT");
    setSmartMessageText(buildCustomerConfirmText(row));
  }

  async function savePlan() {
    if (!selectedRow?.id) return;
    setSaveBusy(true);
    try {
      const rowTable = getOrderTable(selectedRow);
      if (!rowTable) throw new Error("Burimi i porosisë mungon.");
      const pickedDriver = drivers.find((d) => String(d?.id || "") === String(editDriver || "")) || null;
      const pickedDriverName = s(pickedDriver?.name || pickedDriver?.full_name);
      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);
      const nextData = {
        ...(selectedRow.data || {}),
        note: s(editNote),
        pickup_date: editDate,
        pickup_slot: editSlot,
        pickup_window: slotWindow(editSlot),
        planning_bucket: editDate === todayYmd ? "today" : editDate === tomorrowYmd ? "tomorrow" : "scheduled",
        transport_id: editDriver || null,
        transport_user_id: editDriver || null,
        transport_name: pickedDriverName || null,
        transport_pin: pickedDriverPin || null,
        actor: pickedDriverName || pickedDriverPin || null,
        driver_name: pickedDriverName || null,
        driver_pin: pickedDriverPin || null,
        assigned_driver_id: editDriver || null,
        assigned_at: new Date().toISOString(),
        defer_dispatch_code: false,
      };
      const actorNow = getActor() || null;
      const planPoolOwner = pickedDriverPin || String(actorNow?.pin || '').trim() || 'DISPATCH';
      let assignedOrderCode = normTCode(selectedRow?.code_str || selectedRow?.data?.code_str || selectedRow?.data?.order_code || '');
      let reservedPlanCode = '';
      if (rowTable === "transport_orders" && (!assignedOrderCode || selectedRow?.data?.defer_dispatch_code === true || String(selectedRow?.data?.defer_dispatch_code || "").toLowerCase() === "true")) {
        try {
          reservedPlanCode = normTCode(await reserveTransportCode(planPoolOwner, { oid: `dispatch_plan_${selectedRow.id}_${Date.now()}` }));
        } catch (error) {
          throw new Error(`NUK U REZERVUA T-CODE ZYRTAR PËR ASSIGNMENT. ${error?.message || ''}`.trim());
        }
        if (!reservedPlanCode) throw new Error('NUK U REZERVUA T-CODE ZYRTAR PËR ASSIGNMENT.');
        assignedOrderCode = reservedPlanCode;
        nextData.code_str = assignedOrderCode;
        nextData.order_code = assignedOrderCode;
        nextData.client_tcode = assignedOrderCode;
        nextData.dispatch_code_reserved_at = new Date().toISOString();
        nextData.official_order_code = assignedOrderCode;
        nextData.order_tcode = assignedOrderCode;
      }
      const currentStatus = getDbTruthStatus(selectedRow) || "";
      const nextStatus = rowTable === "transport_orders"
        ? resolveAssignPlanStatus(currentStatus, !!editDriver)
        : (editDriver ? "assigned" : "inbox");
      if (nextStatus) nextData.status = nextStatus;
      const planPatch = { updated_at: new Date().toISOString(), data: nextData };
      if (assignedOrderCode) planPatch.code_str = assignedOrderCode;
      if (reservedPlanCode) {
        planPatch.code_n = tCodeNumber(reservedPlanCode);
        planPatch.client_tcode = assignedOrderCode;
      }
      if (nextStatus) planPatch.status = nextStatus;
      await updateOrderRecord(rowTable, selectedRow.id, planPatch);
      if (reservedPlanCode) {
        try { await markTransportCodeUsed(reservedPlanCode, planPoolOwner); } catch {}
      }
      setSelectedRow(null);
      await loadRows();
    } catch (e) {
      alert(e?.message || "Gabim gjatë ruajtjes.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function removeDispatchRow(row) {
    if (!row?.id) return;
    if (!canDispatchRemoveRow(row)) {
      alert("Kjo porosi nuk fshihet nga Dispatch në këtë fazë. Nëse puna ka nisur, përdor statuset operative që të mos humbin pagesat ose gjurmët.");
      return;
    }
    const code = getDispatchCardCode(row);
    const defaultReason = isFailedRow(row) ? "DËSHTOI / NUK U REALIZUA" : isCancelledRow(row) ? "ANULUAR" : "ANULUAR NGA DISPATCH";
    const reason = window.prompt(`ARSYEJA E FSHIRJES / ANULIMIT PËR ${code}`, defaultReason);
    if (reason === null) return;
    const cleanReason = s(reason) || defaultReason;
    const ok = window.confirm(`A je i sigurt që don me e heq këtë porosi nga Dispatch?\n\n${code} • ${up(getClientName(row) || "PA EMËR")}\nARSYE: ${cleanReason}\n\nKjo është soft-delete: porosia nuk fshihet nga DB, vetëm shënohet ANULUAR dhe largohet nga listat aktive.`);
    if (!ok) return;
    setDeleteBusyId(String(row.id));
    try {
      const rowTable = getOrderTable(row);
      if (!rowTable) throw new Error("Burimi i porosisë mungon.");
      const nowIso = new Date().toISOString();
      const actorNow = getActor() || null;
      const actorName = s(actorNow?.name || actorNow?.full_name || actorNow?.pin || actorNow?.role || "DISPATCH");
      const nextData = {
        ...(row.data || {}),
        status: "cancelled",
        cancelled: true,
        canceled: true,
        cancelled_at: nowIso,
        canceled_at: nowIso,
        cancellation_reason: cleanReason,
        cancel_reason: cleanReason,
        cancelled_by: actorName,
        cancellation_source: "DISPATCH",
        dispatch_removed: true,
        dispatch_hidden: true,
        dispatch_removed_at: nowIso,
        dispatch_removed_by: actorName,
        dispatch_removed_reason: cleanReason,
      };
      await updateOrderRecord(rowTable, row.id, {
        status: "cancelled",
        updated_at: nowIso,
        data: nextData,
      });
      if (selectedRow?.id === row.id) setSelectedRow(null);
      setAllRows((prev) => (Array.isArray(prev) ? prev.filter((x) => String(x?.id || "") !== String(row.id || "")) : prev));
      await loadRows();
    } catch (e) {
      alert(e?.message || "Gabim gjatë fshirjes/anulimit.");
    } finally {
      setDeleteBusyId("");
    }
  }

  async function setDispatchReschedule(row) {
    if (!row?.id) return;
    const date = prompt("RIPLANIFIKIM — DATA (YYYY-MM-DD)", rowPickupDate(row) || todayYmd);
    if (!date) return;
    const time = prompt("RIPLANIFIKIM — ORA (HH:MM)", rowPickupSlot(row) === "evening" ? "18:00" : "09:00");
    if (!time) return;
    const whenLocal = new Date(`${date}T${time}:00`);
    if (!Number.isFinite(whenLocal.getTime())) return alert("DATA/ORA jo valide.");
    const nextData = { ...(row.data || {}) };
    nextData.reschedule_at = whenLocal.toISOString();
    nextData.reschedule_by = "DISPATCH";
    nextData.pickup_date = date;
    nextData.pickup_slot = Number(String(time).slice(0, 2)) >= 17 ? "evening" : "morning";
    nextData.pickup_window = slotWindow(nextData.pickup_slot);
    try {
      await updateOrderData("transport_orders", row.id, () => nextData, { updated_at: new Date().toISOString() });
      await loadRows();
    } catch (error) {
      alert("Gabim: " + (error?.message || error));
    }
  }

  async function copyReply(row) {
    await copyDispatchText(getCopyReplyText(row), "PËRGJIGJJA U KOPJUA ✅");
  }

  const currentRows = useMemo(() => {
    if (activeTab === TAB_TOMORROW) return tomorrowRows;
    if (activeTab === TAB_ONLINE) return onlineRows;
    if (activeTab === TAB_PHONE) return phoneRows;
    if (activeTab === TAB_CANCELLED) return cancellationRows;
    if (activeTab === TAB_TODAY) return todayRows;
    return [];
  }, [activeTab, todayRows, tomorrowRows, onlineRows, phoneRows, cancellationRows]);

  const showCommandDetails = commandOpen || commandActive;
  const activeQuickFilterLabel = quickFilters.find((filter) => filter.key === commandFilter)?.label || "";
  const activeDriverFilterLabel = commandDriverFilters.find((filter) => String(filter.key) === String(commandDriverFilter))?.label || "TË GJITHA";

  function toggleCommandPanel() {
    const next = !commandOpen;
    setCommandOpen(next);
    if (next) {
      setCreateOpen(false);
      setLiveOpen(false);
    }
  }

  function toggleCreatePanel() {
    const next = !createOpen;
    setCreateOpen(next);
    if (next) {
      setCommandOpen(false);
      setLiveOpen(false);
    }
  }

  function toggleLivePanel() {
    const next = !liveOpen;
    setLiveOpen(next);
    if (next) {
      setCommandOpen(false);
      setCreateOpen(false);
    }
  }

  const selectedPay = selectedRow ? getPaymentInfo(selectedRow) : { total: null, paid: null, debt: null };
  const selectedPhone = selectedRow ? getClientPhone(selectedRow) : "";
  const selectedWarnings = selectedRow ? getDispatchWarnings(selectedRow) : [];
  const selectedPhoneLink = selectedRow ? phoneHref(selectedRow) : "";
  const selectedWhatsappLink = selectedRow ? whatsappHref(selectedRow) : "";
  const selectedTransportHref = selectedRow?.id ? `/transport/board` : "/transport/board";

  if (!accessChecked) return <DispatchAccessScreen checking />;
  if (!accessAllowed) return <DispatchAccessScreen />;

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div style={ui.headerLeft}>
          <div style={ui.title}>DISPATCH</div>
          <button type="button" style={ui.liveChip} onClick={toggleLivePanel}>
            {liveMode === "REALTIME" ? "LIVE REALTIME" : "LIVE 20s"} {liveOpen ? "▴" : "▾"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/transport/board" style={ui.btnGhost}>TEREN</Link>
          <Link href="/" style={ui.btnGhost}>HOME</Link>
        </div>
      </div>

      <div style={ui.statsStrip}>
        <button type="button" style={activeTab === TAB_TODAY ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_TODAY)}>SOT <strong>{tabCounts[TAB_TODAY]}</strong></button>
        <button type="button" style={activeTab === TAB_TOMORROW ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_TOMORROW)}>NESËR <strong>{tabCounts[TAB_TOMORROW]}</strong></button>
        <button type="button" style={activeTab === TAB_ONLINE ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_ONLINE)}>ONLINE <strong>{tabCounts[TAB_ONLINE]}</strong></button>
        <button type="button" style={liveOpen ? ui.statChipOn : ui.statChip} onClick={toggleLivePanel}>LIVE <strong>{tabCounts[TAB_UPDATES]}</strong></button>
        <button type="button" style={activeTab === TAB_CANCELLED ? ui.statChipDangerOn : ui.statChipDanger} onClick={() => setActiveTab(TAB_CANCELLED)}>ANULIME <strong>{tabCounts[TAB_CANCELLED]}</strong></button>
      </div>

      <div style={ui.commandCard}>
        <div style={ui.field}>
          <div style={ui.searchHeadRow}>
            <div>
              <div style={ui.label}>KËRKO KLIENTIN</div>
              <div style={ui.searchHint}>Tel / T-code për search komandë. CRM klient ekzistues lidhet vetëm me telefon.</div>
            </div>
            <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "↻"}</button>
          </div>
          <input
            style={ui.commandInput}
            value={commandQuery}
            onChange={(e) => setCommandQuery(e.target.value)}
            placeholder="Tel / T-code / emër / adresë"
            inputMode="search"
          />
        </div>

        <div style={ui.topActions}>
          <button type="button" style={showCommandDetails ? ui.topActionOn : ui.topActionOff} onClick={toggleCommandPanel}>COMMAND {showCommandDetails ? "▴" : "▾"}</button>
          <button type="button" style={createOpen ? ui.topActionOn : ui.topActionOff} onClick={toggleCreatePanel}>+ SMART CREATE</button>
          <button type="button" style={liveOpen ? ui.topActionOn : ui.topActionOff} onClick={toggleLivePanel}>{liveMode === "REALTIME" ? "LIVE" : "LIVE 20s"} {liveOpen ? "▴" : "▾"}</button>
        </div>

        {showCommandDetails ? (
          <div style={ui.commandDetails}>
            <div style={ui.compactToggleRow}>
              <button type="button" style={ui.panelToggle} onClick={() => setDriversOpen(!driversOpen)}>
                Shoferë/Baza: {activeDriverFilterLabel} {driversOpen ? "▴" : "▾"}
              </button>
              <button type="button" style={ui.panelToggle} onClick={() => setAdvancedFiltersOpen(!advancedFiltersOpen)}>
                Advanced filters{activeQuickFilterLabel ? `: ${activeQuickFilterLabel}` : ""} {advancedFiltersOpen ? "▴" : "▾"}
              </button>
              {(commandFilter || commandDriverFilter !== "all" || s(commandQuery)) ? (
                <button type="button" style={ui.panelToggleDanger} onClick={() => { setCommandQuery(""); setCommandFilter(""); setCommandDriverFilter("all"); }}>PASTRO</button>
              ) : null}
            </div>

            {driversOpen ? (
              <div style={ui.smartChipRow}>
                {commandDriverFilters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    style={commandDriverFilter === filter.key ? ui.smartChipOn : ui.smartChipOff}
                    onClick={() => setCommandDriverFilter(filter.key)}
                  >
                    <span>{filter.label}</span>
                    <strong>{filter.count}</strong>
                  </button>
                ))}
              </div>
            ) : null}

            {advancedFiltersOpen ? (
              <div style={ui.quickChipRow}>
                {quickFilters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    style={commandFilter === filter.key ? ui.quickChipOn : ui.quickChipOff}
                    onClick={() => setCommandFilter(commandFilter === filter.key ? "" : filter.key)}
                  >
                    <span>{filter.label}</span>
                    <strong>{filter.count}</strong>
                  </button>
                ))}
              </div>
            ) : null}

            {commandActive ? (
              <div style={ui.commandResults}>
                <div style={ui.sectionHeadRow}>
                  <div style={ui.sectionTitle}>REZULTATET ({commandRows.length})</div>
                </div>
                {commandRows.length === 0 ? (
                  <div style={ui.emptyBox}>
                    <div>NUK U GJET KLIENT. HAPE + SMART CREATE PËR POROSI TË RE.</div>
                    {s(commandQuery) ? <button type="button" style={ui.btnGhostMini} onClick={() => { prefillCreateFromCommandSearch(); setCreateOpen(true); setCommandOpen(false); }}>KRIJO ME KËTË SEARCH</button> : null}
                  </div>
                ) : (
                  <div style={ui.list}>
                    {commandRows.map((row) => (
                      <DispatchCard key={`command_${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={ui.sectionHint}>Shkruaj tel/T-code/emër/adresë ose hap një filter për me i nxjerrë rezultatet.</div>
            )}
          </div>
        ) : (
          <div style={ui.sectionHint}>Search-i qëndron gjithmonë hapur. Hape COMMAND për shoferë/bazë, filtra dhe rezultate të detajuara.</div>
        )}
      </div>

      {createOpen ? (
      <div style={ui.cardCompact}>
        <div style={ui.sectionHeadRowCompact}>
          <div>
            <div style={ui.sectionTitle}>DISPATCH SMART CREATE</div>
            <div style={ui.sectionHintCompact}>Ngjit mesazh/kontakt. Order ruhet vetëm kur klikon krijo.</div>
          </div>
          <div style={ui.headerMiniActions}>
            <button type="button" style={ui.btnGhostMini} onClick={() => setCreateOpen(false)}>MBYLL</button>
            <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "↻"}</button>
          </div>
        </div>

        <div style={ui.smartPasteCardCompact}>
          <div style={ui.compactInputHead}>
            <div style={ui.label}>Mesazh / kontakt</div>
            {smartPasteHasText ? <button type="button" style={ui.inlineClearBtn} onClick={clearSmartPaste}>PASTRO</button> : null}
          </div>
          <textarea
            style={ui.smartPasteTextareaCompact}
            value={smartPasteText}
            onChange={(e) => handleSmartPasteChange(e.target.value)}
            placeholder={`Feriz +38344123456
Mati 1, nesër paradite, 3 tepiha`}
          />
          {smartPasteShouldShowPreview ? (
            <>
              <div style={ui.readonlyBadgeRowCompact}>
                {smartPastePreviewChips(smartPasteResult).map((chip) => (
                  <span key={chip.label} style={chip.kind === "bad" ? ui.badgeBad : chip.kind === "warn" ? ui.badgeWarn : ui.badgeOk}>{chip.label}</span>
                ))}
              </div>
              {smartPasteResult?.hasName && smartPasteResult?.hasPhone && smartPasteResult?.missingAddress ? (
                <div style={ui.compactWarnBox}>Duhet adresë para transportit.</div>
              ) : null}
            </>
          ) : null}

          <div style={ui.smartActionStack}>
            <div style={ui.actionGridTwoCompact}>
              <button type="button" style={ui.actionBtnCompact} onClick={analyzeSmartPaste}>ANALIZO</button>
              <button type="button" style={ui.actionBtnCompact} onClick={fillFormFromSmartPaste}>MBUSH FORMËN</button>
            </div>
            <div style={ui.actionGridTwoCompact}>
              <button type="button" style={ui.actionBtnCompact} onClick={() => copyDispatchText(buildPasteDriverCopyText(smartPasteLiveResult()), "COPY PËR SHOFER U KOPJUA ✅")}>COPY SHOFER</button>
              <button type="button" style={ui.actionBtnCompact} onClick={copySmartPasteAddressRequest}>MESAZH ADRESË</button>
            </div>
            {smartPasteHasPhone ? (
              <div style={ui.actionGridFourCompact}>
                <button type="button" style={ui.actionBtnCompact} onClick={() => openSmartPasteMessage("whatsapp")}>WHATSAPP</button>
                <button type="button" style={ui.actionBtnCompact} onClick={() => openSmartPasteMessage("viber")}>VIBER</button>
                <button type="button" style={ui.actionBtnCompact} onClick={() => openSmartPasteMessage("sms")}>SMS</button>
                <button type="button" style={ui.actionBtnCompact} onClick={callSmartPastePhone}>THIRR</button>
              </div>
            ) : null}
          </div>
          {smartPasteMsg ? <div style={ui.ok}>{smartPasteMsg}</div> : null}
        </div>

        <div style={{ ...ui.field, marginBottom: 14, position: "relative" }}>
          <div style={ui.label}>SMART SEARCH (CRM) — TELI VETËM</div>
          <div style={ui.sectionHintCompact}>Klient ekzistues del vetëm kur telefoni përputhet. Emri/lagjja nuk përdoren për match.</div>
          <input
            style={ui.input}
            value={crmQuery}
            onChange={(e) => {
              setCrmQuery(e.target.value);
              setCrmOpen(true);
            }}
            placeholder="TELI VETËM"
          />
          {crmBusy ? <div style={ui.mini}>DUKE KËRKUAR…</div> : null}
          {crmOpen && crmHits.length > 0 ? (
            <div style={ui.suggestBox}>
              {crmHits.map((row) => (
                <button key={`${getOrderTable(row)}_${row.id}`} type="button" style={ui.suggestItem} onClick={() => applySuggestion(row)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 900 }}>{up(getClientName(row) || "PA EMËR")}</div>
                    <div style={ui.badge}>{sourceLabel(row)}</div>
                  </div>
                  <div style={ui.suggestSub}>{getClientPhone(row) || "PA TEL"}</div>
                  <div style={ui.suggestSub}>{getAddress(row) || "PA ADRESË"}</div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div style={ui.row2}>
          <div style={ui.field}>
            <div style={ui.label}>EMRI</div>
            <input style={ui.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
          </div>
          <div style={ui.field}>
            <div style={ui.label}>TEL</div>
            <input style={ui.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+383..." inputMode="tel" />
            {phoneBusy ? <div style={ui.mini}>PO KONTROLLOJ KLIENTIN…</div> : null}
          </div>
        </div>

        {phoneHit ? (
          <div style={ui.crmHitBox}>
            <div style={ui.crmHitTitle}>KY KLIENT EKZISTON NË DB. A DON ME SHTU POROSI TË RE TE KY KLIENT?</div>
            <div style={ui.crmHitSub}>EMRI: {up(getClientName(phoneHit) || "PA EMËR")}</div>
            <div style={ui.crmHitSub}>TEL: {getClientPhone(phoneHit) || phoneHit?.phone_digits || "PA TEL"}</div>
            <div style={ui.crmHitSub}>T-CODE: {getTransportTCode(phoneHit) || "PA T-CODE"}</div>
            <div style={ui.crmHitSub}>ADRESA/GPS: {getAddress(phoneHit) || "PA ADRESË"}{phoneHit?.gps_lat && phoneHit?.gps_lng ? ` • ${phoneHit.gps_lat}, ${phoneHit.gps_lng}` : ""}</div>
            <div style={ui.crmHitSub}>BURIMI: {phoneHit?.source === "transport_clients" ? "TRANSPORT_CLIENTS" : "TRANSPORT ORDER HISTORY"} • {niceDate(phoneHit?.updated_at || phoneHit?.created_at)}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={ui.btnGhostMini} onClick={() => applySuggestion(phoneHit, { keepPhoneHit: true })}>PO, PËRDOR KËTË KLIENT</button>
              <button type="button" style={ui.btnGhostMini} onClick={() => setPhoneHit(null)}>JO, VAZHDO PA LIDHJE</button>
            </div>
          </div>
        ) : null}

        {activePhoneOrder ? (
          <div style={{ ...ui.smartCreateStatusCard, border: "1px solid rgba(245,158,11,0.38)", background: "rgba(245,158,11,0.12)" }}>
            <div style={{ ...ui.smartCreateStatusText, color: "#92400e" }}>
              KY TELEFON KA POROSI AKTIVE: {getDispatchCardCode(activePhoneOrder)} — {up(getClientName(activePhoneOrder) || "PA EMËR")}
            </div>
            <div style={ui.crmHitSub}>
              Orari aktual: {getScheduleText(activePhoneOrder)} • Shoferi: {orderAssignedDriver(activePhoneOrder) || "PA SHOFER"}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={ui.btnGhostMini}
                onClick={() => {
                  setCreateOpen(false);
                  openRow(activePhoneOrder);
                }}
              >
                EDITO DATËN / ORARIN
              </button>
            </div>
          </div>
        ) : null}

        {smartCreateLiveFillStatus.smartCreateFilled ? (
          <div style={ui.smartCreateStatusCard}>
            <div style={ui.smartCreateStatusText}>Kontrollo të dhënat para krijimit.</div>
            <div style={ui.smartCreateStatusChips}>
              {smartCreateFillChips(smartCreateLiveFillStatus).map((chip) => (
                <span key={chip.label} style={chip.kind === "bad" ? ui.badgeBad : chip.kind === "warn" ? ui.badgeWarn : ui.badgeOk}>{chip.label}</span>
              ))}
            </div>
          </div>
        ) : null}

        <div style={ui.field}>
          <div style={ui.label}>ADRESA</div>
          <input style={ui.input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="RRUGA / LAGJJA" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHËNIM</div>
          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>PLANIFIKIMI</div>
          <div style={ui.pillRow}>
            <button type="button" style={planMode === "today" ? ui.pillOn : ui.pillOff} onClick={() => { setPlanMode("today"); markSmartCreateScheduleConfirmed(); }}>PËR SOT</button>
            <button type="button" style={planMode === "tomorrow" ? ui.pillOn : ui.pillOff} onClick={() => { setPlanMode("tomorrow"); markSmartCreateScheduleConfirmed(); }}>PËR NESËR</button>
            <button type="button" style={planMode === "custom" ? ui.pillOn : ui.pillOff} onClick={() => { setPlanMode("custom"); markSmartCreateScheduleConfirmed(); }}>DATË TJETËR</button>
          </div>
          {planMode === "custom" ? <input type="date" style={ui.input} value={customDate} onChange={(e) => { setCustomDate(e.target.value); markSmartCreateScheduleConfirmed(); }} /> : null}
          <div style={ui.pillRow}>
            {SLOT_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" style={slot === opt.value ? ui.pillOn : ui.pillOff} onClick={() => { setSlot(opt.value); markSmartCreateScheduleConfirmed(); }}>
                {opt.label} • {opt.window}
              </button>
            ))}
          </div>
          <div style={ui.capacityBox}>
            <div><strong>{uiDate(plannedDate)}</strong> • {slotWindow(slot)}</div>
            <div>{daySlotCount}/15 në slot • {dayTotalCount}/30 në ditë</div>
            {(daySlotCount >= 15 || dayTotalCount >= 30) ? <div style={ui.capacityWarn}>SLOTI/DITA ËSHTË FULL – DISPATCH MUND TË BËJË OVERRIDE</div> : null}
          </div>
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHOFERI</div>
          <div style={ui.smartChipRow}>
            <button type="button" style={!driverId ? ui.smartChipOn : ui.smartChipOff} onClick={() => setDriverId("")}>BAZA / PA SHOFER</button>
            {drivers.map((d) => (
              <button
                key={`create_driver_${String(d.id)}`}
                type="button"
                style={String(driverId || "") === String(d.id || "") ? ui.smartChipOn : ui.smartChipOff}
                onClick={() => setDriverId(String(d.id || ""))}
              >
                {driverDisplayName(d)}
              </button>
            ))}
          </div>
          <select style={ui.input} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option style={ui.selectOption} value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
            {drivers.map((d) => (
              <option style={ui.selectOption} key={String(d.id)} value={String(d.id)}>{driverDisplayName(d)}</option>
            ))}
          </select>
        </div>

        {err ? <div style={ui.err}>{err}</div> : null}
        {msg ? <div style={ui.ok}>{msg}</div> : null}

        {activePhoneOrder ? (
          <button
            type="button"
            style={{ ...ui.btnPrimary, width: "100%", background: "#92400e" }}
            onClick={() => {
              setCreateOpen(false);
              openRow(activePhoneOrder);
            }}
          >
            EDITO POROSINË EKZISTUESE
          </button>
        ) : (
          <button style={{ ...ui.btnPrimary, opacity: canCreateNewDispatchOrder && !busy ? 1 : 0.5 }} disabled={!canCreateNewDispatchOrder || busy} onClick={send}>
            {busy ? "DUKE DËRGU…" : "DËRGO"}
          </button>
        )}
      </div>
      ) : null}

      {liveOpen ? (
        <div style={ui.card}>
          <div style={ui.sectionHeadRow}>
            <div>
              <div style={ui.sectionTitle}>LIVE / TRANSPORT CONTROL TOWER</div>
              <div style={ui.sectionHint}>{liveMode === "REALTIME" ? "Supabase realtime" : "Refresh i lehtë çdo 20 sekonda"}</div>
            </div>
            <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "↻"}</button>
          </div>
          {(liveRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA AKTIVITET LIVE.</div> : <div style={ui.list}>{liveRows.map((row) => <DispatchCard key={`live_panel_${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />)}</div>}
        </div>
      ) : null}

      <div style={ui.card}>
        <div style={ui.tabRow}>
          <button type="button" style={activeTab === TAB_TODAY ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_TODAY)}>SOT ({tabCounts[TAB_TODAY]})</button>
          <button type="button" style={activeTab === TAB_TOMORROW ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_TOMORROW)}>NESËR ({tabCounts[TAB_TOMORROW]})</button>
          <button type="button" style={activeTab === TAB_ONLINE ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_ONLINE)}>ONLINE ({tabCounts[TAB_ONLINE]})</button>
          <button type="button" style={activeTab === TAB_PHONE ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_PHONE)}>TELEFONATA ({tabCounts[TAB_PHONE]})</button>
          <button type="button" style={activeTab === TAB_UPDATES ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_UPDATES)}>LIVE ({tabCounts[TAB_UPDATES]})</button>
          <button type="button" style={activeTab === TAB_CANCELLED ? ui.tabDangerOn : ui.tabDangerOff} onClick={() => setActiveTab(TAB_CANCELLED)}>ANULIME 24H ({tabCounts[TAB_CANCELLED]})</button>
        </div>

        {activeTab === TAB_CANCELLED ? (
          <>
            <div style={ui.sectionHeadRow}>
              <div style={ui.sectionTitle}>ANULIME / DËSHTIME — 24 ORËT E FUNDIT</div>
              <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "REFRESH"}</button>
            </div>
            <div style={ui.sectionHint}>Këtu shihen porositë e anuluara nga Dispatch ose shoferi. Pas 24 orëve nuk shfaqen më në këtë listë, por mbeten të ruajtura në DB si audit.</div>
            {(cancellationRows?.length || 0) === 0 ? (
              <div style={ui.empty}>S'KA ANULIME NË 24 ORËT E FUNDIT.</div>
            ) : (
              <div style={ui.list}>
                {cancellationRows.map((row) => (
                  <CancellationRow key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                ))}
              </div>
            )}
          </>
        ) : activeTab !== TAB_UPDATES ? (
          <>
            <div style={ui.sectionHint}>
              {activeTab === TAB_ONLINE ? "Porositë që vijnë nga forma online." : activeTab === TAB_PHONE ? "Porositë që dispatch i fut manualisht nga telefonatat." : activeTab === TAB_TOMORROW ? "Planifikimi për nesër." : "Planifikimi për sot."}
            </div>
            {(currentRows?.length || 0) === 0 ? (
              <div style={ui.empty}>S'KA POROSI NË KËTË TAB.</div>
            ) : (
              <div style={ui.list}>
                {currentRows.map((row) => (
                  <DispatchCard key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={ui.sectionHeadRow}>
              <div style={ui.sectionTitle}>LIVE TRANSPORT</div>
              <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "REFRESH"}</button>
            </div>
            <div style={ui.sectionHint}>Vetëm transport orders / T-codes. Përditësim: {liveMode === "REALTIME" ? "Supabase realtime" : "refresh i lehtë çdo 20 sekonda"}.</div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>AKTIVITET</div>
              {(liveRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA AKTIVITET.</div> : <div style={ui.list}>{liveRows.map((row) => <DispatchCard key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />)}</div>}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>POROSITË E DËSHTUARA</div>
              {(failedRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA TË DËSHTUARA.</div> : (
                <div style={ui.list}>
                  {failedRows.map((row) => (
                    <div key={`${getOrderTable(row)}_${row.id}`} style={{ ...ui.compactRow, border: "1px solid rgba(239,68,68,0.22)", background: "linear-gradient(180deg, rgba(239,68,68,0.07), rgba(239,68,68,0.03))" }}>
                      <div style={ui.compactCode}>{getOrderCode(row) || "T-NEW"}</div>
                      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
                        <div style={ui.compactTop}>
                          <div style={{ minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" }}>
                            <span style={ui.compactName}>{up(getClientName(row) || "PA EMËR")}</span>
                            <span style={ui.badgeBad}>DËSHTUAR</span>
                          </div>
                          <span style={ui.compactTime}>{niceDate(row.updated_at || row.created_at)}</span>
                        </div>
                        <div style={ui.compactSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
                        <div style={ui.compactSub}>ARSYE: {up(row?.data?.failed_note || row?.data?.reason || row?.data?.unsuccess_reason || "PA SHËNIM")}</div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" style={ui.btnGhostMini} onClick={() => openRow(row)}>HAP</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>RIPLANIFIKIME</div>
              {(reschedules?.length || 0) === 0 ? <div style={ui.empty}>S'KA RIPLANIFIKIME.</div> : (
                <div style={ui.list}>
                  {reschedules.map((r) => (
                    <div key={`${getOrderTable(r)}_${r.id}`} style={ui.compactRow}>
                      <div style={ui.compactCode}>{getOrderCode(r) || "T-NEW"}</div>
                      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
                        <div style={ui.compactTop}>
                          <div style={{ minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" }}>
                            <span style={ui.compactName}>{up(getClientName(r) || "PA EMËR")}</span>
                            <span style={ui.badgeWarn}>RIPLAN</span>
                          </div>
                          <span style={ui.compactTime}>{niceDate(r?.data?.reschedule_at)}</span>
                        </div>
                        <div style={ui.compactSub}>{getClientPhone(r) || "PA TEL"} • {getAddress(r) || "PA ADRESË"}</div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                          <button type="button" style={ui.btnGhostMini} onClick={() => openRow(r)}>HAP</button>
                          <button type="button" style={ui.btnGhostMini} onClick={() => setDispatchReschedule(r)}>NDËRRO ORARIN</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {selectedRow ? (
        <div style={ui.modalOverlay} onClick={() => setSelectedRow(null)}>
          <div style={ui.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={ui.sectionHeadRow}>
              <div>
                <div style={ui.modalKicker}>KLIENTI</div>
                <div style={ui.sectionTitle}>{getDispatchCardCode(selectedRow)} • {up(getClientName(selectedRow) || "PA EMËR")}</div>
                <div style={ui.sectionHint}>{selectedPhone || "PA TEL"}</div>
              </div>
              <button type="button" style={ui.btnGhostMini} onClick={() => setSelectedRow(null)}>MBYLLE</button>
            </div>

            {selectedWarnings.length ? (
              <div style={ui.readonlyBadgeRow}>
                {selectedWarnings.map((w) => <span key={`selected_${w}`} style={w.includes("ZBRITJE") ? ui.badgeWarn : ui.badgeBad}>{w}</span>)}
              </div>
            ) : null}

            <div style={ui.detailGrid}>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>STATUSI AKTUAL</div>
                <div style={ui.detailValue}>{dispatchStatusLabel(selectedRow)}</div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>SA I BËHEN</div>
                <div style={ui.paymentRows}>
                  <div><span>TOTALI</span><strong>{moneyDash(selectedPay.total)}</strong></div>
                  <div><span>PAGUAR</span><strong>{moneyDash(selectedPay.paid)}</strong></div>
                  <div><span>BORXH</span><strong style={rowHasDebt(selectedRow) ? ui.debtInline : undefined}>{moneyDash(selectedPay.debt)}</strong></div>
                </div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>ADRESA</div>
                <div style={getAddress(selectedRow) ? ui.detailValue : ui.addressWarn}>{getAddress(selectedRow) || "PA ADRESË"}</div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>SHOFERI / ORARI</div>
                <div style={ui.detailValue}>Shoferi: {orderAssignedDriver(selectedRow) || "PA SHOFER"}</div>
                <div style={ui.detailSub}>Data/sloti: {getScheduleText(selectedRow)}</div>
              </div>
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>TIMELINE</div>
              <div style={ui.timelineWrap}>
                {DISPATCH_TIMELINE_STEPS.map((step, idx) => (
                  <span key={step} style={timelineStyle(idx, transportStageIndex(selectedRow))}>{idx + 1}. {step}</span>
                ))}
              </div>
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>VEPRIME</div>
              <div style={ui.actionGrid}>
                {selectedPhoneLink ? <a href={selectedPhoneLink} style={ui.actionBtn}>THIRR</a> : null}
                {selectedWhatsappLink ? <a href={selectedWhatsappLink} target="_blank" rel="noreferrer" style={ui.actionBtn}>WHATSAPP</a> : null}
                <button type="button" style={ui.actionBtn} onClick={() => copyFromSelectedRow("phone")}>COPY TEL</button>
                <button type="button" style={ui.actionBtn} onClick={() => copyFromSelectedRow("name_phone")}>COPY EMËR + TEL</button>
                <button type="button" style={ui.actionBtn} onClick={() => copyFromSelectedRow("address")}>COPY ADRESË</button>
                <button type="button" style={ui.actionBtn} onClick={() => copyFromSelectedRow("driver")}>COPY PËR SHOFER</button>
                <button type="button" style={ui.actionBtn} onClick={() => copyFromSelectedRow("client")}>COPY PËR KLIENT</button>
                {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => openDispatchMessage("whatsapp", selectedPhone, smartMessageText || buildCustomerConfirmText(selectedRow))}>WHATSAPP</button> : null}
                {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => openDispatchMessage("viber", selectedPhone, smartMessageText || buildCustomerConfirmText(selectedRow))}>VIBER</button> : null}
                {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => openDispatchMessage("sms", selectedPhone, smartMessageText || buildCustomerConfirmText(selectedRow))}>SMS</button> : null}
                <button type="button" style={ui.actionBtn} onClick={() => copyReply(selectedRow)}>KOPJO PËRGJIGJEN</button>
                <button type="button" style={ui.actionBtn} onClick={() => setDispatchReschedule(selectedRow)}>RIPLAN</button>
                <a href={selectedTransportHref} style={ui.actionBtn}>HAP NË TRANSPORT</a>
                <button type="button" style={ui.actionBtnDisabled} disabled>EDITO ADRESËN</button>
              </div>
              {copyMsg ? <div style={ui.ok}>{copyMsg}</div> : null}
            </div>

            <div style={ui.updateSection}>
              <button type="button" style={ui.accordionToggle} onClick={() => setCustomerMessagesOpen(!customerMessagesOpen)}>
                <span>Mesazhe klienti</span><strong>{customerMessagesOpen ? "MBYLL" : "HAP"}</strong>
              </button>
              {customerMessagesOpen ? (
                <div style={ui.messageChipRowCompact}>
                  {CUSTOMER_MESSAGE_TEMPLATES.map((tpl) => (
                    <button key={tpl.key} type="button" style={smartMessageLabel === tpl.label ? ui.messageChipOn : ui.messageChip} onClick={() => pickCustomerMessage(tpl)}>{tpl.label}</button>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={ui.updateSection}>
              <button type="button" style={ui.accordionToggle} onClick={() => setDriverMessagesOpen(!driverMessagesOpen)}>
                <span>Mesazhe shoferi</span><strong>{driverMessagesOpen ? "MBYLL" : "HAP"}</strong>
              </button>
              {driverMessagesOpen ? (
                <div style={ui.messageChipRowCompact}>
                  {DRIVER_MESSAGE_CHIPS.map((label) => (
                    <button key={label} type="button" style={smartMessageLabel === label ? ui.messageChipOn : ui.messageChip} onClick={() => pickDriverMessage(label)}>{label}</button>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={ui.updateSection}>
              <button type="button" style={ui.accordionToggle} onClick={() => setDiscountMessagesOpen(!discountMessagesOpen)}>
                <span>Discount</span><strong>{discountMessagesOpen ? "MBYLL" : "HAP"}</strong>
              </button>
              {discountMessagesOpen ? (
                <div style={ui.messageChipRowCompact}>
                  {DISCOUNT_MESSAGE_CHIPS.map((label) => (
                    <button key={label} type="button" style={smartMessageLabel === label ? ui.messageChipOn : ui.messageChipWarn} onClick={() => pickDiscountMessage(label)}>{label}</button>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={ui.updateSection}>
              <button type="button" style={ui.accordionToggle} onClick={() => setOtherOptionsOpen(!otherOptionsOpen)}>
                <span>Opsione tjera{smartMessageLabel ? ` • ${smartMessageLabel}` : ""}</span><strong>{otherOptionsOpen ? "MBYLL" : "HAP"}</strong>
              </button>
              {otherOptionsOpen ? (
                <div style={ui.messagePreviewBlock}>
                  <textarea style={ui.messagePreviewTextarea} value={smartMessageText} onChange={(e) => setSmartMessageText(e.target.value)} placeholder="Zgjedh chip ose shkruaj mesazh…" />
                  <div style={ui.actionGridCompact}>
                    <button type="button" style={ui.actionBtn} onClick={() => copyDispatchText(smartMessageText, "MESAZHI U KOPJUA ✅")}>COPY</button>
                    {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => sendSmartPreview("whatsapp")}>WHATSAPP</button> : null}
                    {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => sendSmartPreview("viber")}>VIBER</button> : null}
                    {selectedPhone ? <button type="button" style={ui.actionBtn} onClick={() => sendSmartPreview("sms")}>SMS</button> : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>NDËRRO DATËN / ORARIN</div>
              <div style={ui.sectionHint}>Mos e anulo për datë gabim. Këtu ruhet e njëjta porosi dhe i njëjti T-code.</div>
              <div style={ui.field}>
                <div style={ui.label}>DATA</div>
                <div style={ui.pillRow}>
                  <button type="button" style={editDate === todayYmd ? ui.pillOn : ui.pillOff} onClick={() => setEditDate(todayYmd)}>PËR SOT</button>
                  <button type="button" style={editDate === tomorrowYmd ? ui.pillOn : ui.pillOff} onClick={() => setEditDate(tomorrowYmd)}>PËR NESËR</button>
                </div>
                <input type="date" style={ui.input} value={editDate} onChange={(e) => setEditDate(e.target.value)} />
              </div>
              <div style={ui.field}>
                <div style={ui.label}>SLOTI</div>
                <div style={ui.pillRow}>
                  {SLOT_OPTIONS.map((opt) => (
                    <button key={opt.value} type="button" style={editSlot === opt.value ? ui.pillOn : ui.pillOff} onClick={() => setEditSlot(opt.value)}>
                      {opt.label} • {opt.window}
                    </button>
                  ))}
                </div>
              </div>
              <div style={ui.field}>
                <div style={ui.label}>SHOFERI</div>
                <select style={ui.input} value={editDriver} onChange={(e) => setEditDriver(e.target.value)}>
                  <option style={ui.selectOption} value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
                  {drivers.map((d) => (
                    <option style={ui.selectOption} key={String(d.id)} value={String(d.id)}>{up(d.name || "TRANSPORT")}</option>
                  ))}
                </select>
              </div>
              <div style={ui.field}>
                <div style={ui.label}>SHËNIM</div>
                <textarea style={ui.textarea} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="OPSIONALE" />
              </div>
            </div>

            {canDispatchRemoveRow(selectedRow) ? (
              <div style={ui.adminRiskBox}>
                <div>
                  <div style={ui.sectionTitle}>ANULIM — JO PËR NDRYSHIM DATE</div>
                  <div style={ui.sectionHint}>Përdore vetëm kur klienti anulon krejt. Për sot/nesër përdor “NDËRRO DATËN / ORARIN” më lart.</div>
                </div>
                <button
                  type="button"
                  style={ui.btnDanger}
                  onClick={() => removeDispatchRow(selectedRow)}
                  disabled={deleteBusyId === String(selectedRow?.id || "")}
                >
                  {deleteBusyId === String(selectedRow?.id || "") ? "DUKE ANULU…" : "ANULO KREJT"}
                </button>
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={{ ...ui.btnPrimary, flex: 1 }} onClick={savePlan} disabled={saveBusy}>{saveBusy ? "DUKE RUAJT…" : "RUAJ DATËN / ORARIN"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ui = {
  accessPage: { minHeight: "100vh", background: "#070b14", color: "#fff", padding: 16, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" },
  accessCard: { width: "min(420px, 100%)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", padding: 18, boxShadow: "0 18px 40px rgba(0,0,0,0.28)", display: "grid", gap: 12, textAlign: "center", boxSizing: "border-box" },
  accessTitle: { fontSize: 18, fontWeight: 1000, letterSpacing: 0.2 },
  accessSub: { fontSize: 13, fontWeight: 800, color: "rgba(255,255,255,0.72)" },
  accessBtn: { height: 46, borderRadius: 14, background: "#fff", color: "#070b14", display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontWeight: 1000, marginTop: 4 },
  row2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, minWidth: 0 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, minWidth: 0, maxWidth: "100%" },
  mini: { fontSize: 11, fontWeight: 800, opacity: 0.65, marginTop: 6 },
  suggestSub: { fontSize: 12, opacity: 0.72, marginTop: 3 },
  sectionHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap", minWidth: 0 },
  list: { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" },
  compactTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0, width: "100%" },
  driverChip: { display: "inline-flex", alignItems: "center", gap: 4, justifySelf: "start", borderRadius: 12, padding: "4px 8px", background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.22)", color: "#2563eb", fontSize: 11, fontWeight: 900 },
  orderCardBtn: { display: "block", width: "100%", maxWidth: "100%", minWidth: 0, border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", boxSizing: "border-box", overflow: "hidden" },
  tabRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, minWidth: 0, maxWidth: "100%" },
  pillRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, minWidth: 0, maxWidth: "100%" },
  capacityWarn: { color: "#8a5a00", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.22)", padding: 8, borderRadius: 10 },
  crmHitSub: { fontSize: 12, opacity: 0.8, marginTop: 4, fontWeight: 700 },
  planRow: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" },
  stageBadge: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(37,99,235,0.24)", background: "rgba(59,130,246,0.12)", color: "#1d4ed8" },
  timelineWrap: { display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", minWidth: 0, maxWidth: "100%", marginTop: 2 },
  timelineDone: { fontSize: 10, fontWeight: 1000, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(16,185,129,0.22)", background: "rgba(16,185,129,0.12)", color: "#047857", lineHeight: 1.15 },
  timelineNow: { fontSize: 10, fontWeight: 1000, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(37,99,235,0.28)", background: "rgba(59,130,246,0.14)", color: "#1d4ed8", lineHeight: 1.15 },
  timelinePending: { fontSize: 10, fontWeight: 900, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(0,0,0,0.08)", background: "rgba(0,0,0,0.03)", color: "rgba(17,17,17,0.56)", lineHeight: 1.15 },
  cancelCard: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(185,28,28,0.18)", borderRadius: 16, padding: 12, display: "grid", gap: 8, background: "linear-gradient(180deg, rgba(254,242,242,0.95), rgba(255,255,255,0.96))", boxShadow: "0 8px 18px rgba(0,0,0,0.05)", boxSizing: "border-box", overflow: "hidden" },
  cancelTop: { display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, maxWidth: "100%" },
  cancelCode: { minWidth: 52, height: 42, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(185,28,28,0.10)", color: "#991b1b", fontSize: 13, fontWeight: 1000, border: "1px solid rgba(185,28,28,0.16)" },
  cancelName: { minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 1000 },
  cancelSub: { minWidth: 0, maxWidth: "100%", fontSize: 12, opacity: 0.72, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 800 },
  cancelReason: { borderRadius: 12, background: "rgba(185,28,28,0.07)", border: "1px solid rgba(185,28,28,0.10)", color: "#7f1d1d", padding: "8px 10px", fontSize: 12, fontWeight: 900 },
  cancelMeta: { display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, opacity: 0.68, fontWeight: 900 },
  top: { maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", boxSizing: "border-box" },
  title: { fontSize: 18, fontWeight: 1000, letterSpacing: 0.5, color: "#f8fafc" },
  sub: { fontSize: 12, color: "rgba(226,232,240,0.68)", fontWeight: 800 },
  card: { maxWidth: 960, width: "100%", margin: "14px auto 0", background: "rgba(15,23,42,0.96)", borderRadius: 18, border: "1px solid rgba(148,163,184,0.18)", padding: 14, boxShadow: "0 18px 36px rgba(0,0,0,0.28)", boxSizing: "border-box", overflow: "hidden" },
  statsGrid: { maxWidth: 960, width: "100%", margin: "14px auto 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 10, boxSizing: "border-box" },
  statCard: { background: "rgba(15,23,42,0.92)", borderRadius: 16, border: "1px solid rgba(148,163,184,0.16)", padding: 12, boxShadow: "0 12px 24px rgba(0,0,0,0.22)", minWidth: 0, boxSizing: "border-box" },
  statLabel: { fontSize: 11, fontWeight: 1000, color: "rgba(203,213,225,0.72)" },
  statValue: { fontSize: 28, fontWeight: 1000, lineHeight: 1.1, marginTop: 4, color: "#f8fafc" },
  label: { fontSize: 12, fontWeight: 1000, color: "rgba(203,213,225,0.82)" },
  sectionTitle: { fontWeight: 1000, marginBottom: 8, color: "#f8fafc", letterSpacing: 0.2 },
  sectionHint: { fontSize: 12, color: "rgba(203,213,225,0.70)", marginBottom: 10, fontWeight: 700 },
  empty: { fontWeight: 900, color: "rgba(203,213,225,0.72)" },
  input: { height: 44, borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", padding: "0 12px", fontWeight: 900, outline: "none", width: "100%", maxWidth: "100%", background: "rgba(2,6,23,0.72)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", boxSizing: "border-box" },
  textarea: { minHeight: 70, borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", padding: 12, fontWeight: 900, outline: "none", background: "rgba(2,6,23,0.72)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", width: "100%", maxWidth: "100%", boxSizing: "border-box" },
  selectOption: { background: "#0f172a", color: "#f8fafc" },
  btnGhost: { border: "1px solid rgba(148,163,184,0.24)", background: "rgba(15,23,42,0.92)", padding: "10px 12px", borderRadius: 12, fontWeight: 1000, textDecoration: "none", color: "#f8fafc" },
  btnGhostMini: { border: "1px solid rgba(148,163,184,0.24)", background: "rgba(15,23,42,0.92)", padding: "8px 10px", borderRadius: 10, fontWeight: 1000, color: "#f8fafc", cursor: "pointer" },
  btnPrimary: { height: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.32)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", padding: "0 16px" },
  btnDanger: { height: 48, borderRadius: 14, border: "1px solid rgba(248,113,113,0.28)", background: "rgba(127,29,29,0.62)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", padding: "0 16px" },
  btnDangerMini: { height: 38, borderRadius: 12, border: "1px solid rgba(248,113,113,0.28)", background: "rgba(127,29,29,0.52)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", padding: "0 14px", whiteSpace: "nowrap" },
  err: { background: "rgba(127,29,29,0.30)", border: "1px solid rgba(248,113,113,0.25)", color: "#fecaca", padding: 10, borderRadius: 12, fontWeight: 900, marginBottom: 10 },
  ok: { background: "rgba(6,78,59,0.32)", border: "1px solid rgba(52,211,153,0.24)", color: "#bbf7d0", padding: 10, borderRadius: 12, fontWeight: 1000, marginBottom: 10 },
  suggestBox: { position: "absolute", left: 0, right: 0, top: 78, background: "#0f172a", border: "1px solid rgba(148,163,184,0.22)", borderRadius: 14, boxShadow: "0 14px 28px rgba(0,0,0,0.32)", zIndex: 20, overflow: "hidden" },
  suggestItem: { width: "100%", textAlign: "left", background: "#0f172a", color: "#f8fafc", border: "none", borderBottom: "1px solid rgba(148,163,184,0.12)", padding: 12, cursor: "pointer" },
  badge: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(148,163,184,0.22)", background: "rgba(148,163,184,0.10)", color: "#e2e8f0" },
  badgeOk: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(52,211,153,0.24)", background: "rgba(16,185,129,0.14)", color: "#86efac" },
  badgeWarn: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(251,191,36,0.28)", background: "rgba(245,158,11,0.14)", color: "#fde68a" },
  badgeBad: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(248,113,113,0.30)", background: "rgba(239,68,68,0.14)", color: "#fecaca" },
  badgeGhost: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(148,163,184,0.18)", background: "rgba(148,163,184,0.08)", color: "#cbd5e1" },
  tabOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(96,165,250,0.34)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabDangerOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(248,113,113,0.30)", background: "#991b1b", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabDangerOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.18)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillOn: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(96,165,250,0.34)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillOff: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8, margin: "8px 0 12px", minWidth: 0 },
  quickFilterOn: { minHeight: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.42)", background: "rgba(37,99,235,0.88)", color: "#fff", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 1000, cursor: "pointer" },
  quickFilterOff: { minHeight: 48, borderRadius: 14, border: "1px solid rgba(148,163,184,0.18)", background: "rgba(2,6,23,0.45)", color: "#e2e8f0", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 1000, cursor: "pointer" },
  smartFilterBlock: { borderRadius: 16, border: "1px solid rgba(148,163,184,0.12)", background: "rgba(2,6,23,0.24)", padding: 10, marginTop: 10, minWidth: 0, overflow: "hidden" },
  smartFilterTitle: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.8, color: "rgba(147,197,253,0.88)", marginBottom: 8 },
  smartChipRow: { display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%", marginBottom: 8 },
  smartChipOn: { minHeight: 38, borderRadius: 999, border: "1px solid rgba(96,165,250,0.42)", background: "rgba(37,99,235,0.92)", color: "#fff", padding: "0 12px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  smartChipOff: { minHeight: 38, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.82)", color: "#e2e8f0", padding: "0 12px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  emptyBox: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderRadius: 14, border: "1px solid rgba(148,163,184,0.14)", background: "rgba(2,6,23,0.28)", padding: 12, fontWeight: 900, color: "rgba(226,232,240,0.82)" },
  commandResults: { borderTop: "1px solid rgba(148,163,184,0.14)", marginTop: 12, paddingTop: 12 },
  capacityBox: { borderRadius: 14, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(2,6,23,0.36)", padding: 10, fontSize: 12, fontWeight: 900, display: "grid", gap: 6, width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  crmHitBox: { borderRadius: 14, border: "1px solid rgba(96,165,250,0.26)", background: "rgba(37,99,235,0.14)", padding: 12, marginBottom: 10 },
  crmHitTitle: { fontSize: 12, fontWeight: 1000, color: "#bfdbfe" },
  inlineDangerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", border: "1px solid rgba(248,113,113,0.18)", borderRadius: 14, padding: "10px 12px", background: "rgba(127,29,29,0.16)", width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  inlineDangerHint: { fontSize: 12, fontWeight: 800, color: "rgba(254,202,202,0.86)", flex: 1, minWidth: 180 },
  updateSection: { marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.14)", paddingTop: 12 },
  compactRow: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(148,163,184,0.14)", borderRadius: 16, padding: 10, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 10px 22px rgba(0,0,0,0.18)", background: "rgba(2,6,23,0.42)", boxSizing: "border-box", overflow: "hidden" },
  compactCode: { minWidth: 52, height: 42, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(57,216,111,0.16)", color: "#86efac", fontSize: 13, fontWeight: 1000, border: "1px solid rgba(57,216,111,0.22)" },
  compactSub: { minWidth: 0, maxWidth: "100%", fontSize: 13, color: "rgba(203,213,225,0.74)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 800 },
  compactTime: { fontSize: 11, color: "rgba(203,213,225,0.58)", fontWeight: 1000, whiteSpace: "nowrap", flexShrink: 0 },
  orderCard: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(148,163,184,0.16)", borderRadius: 18, padding: 12, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 14px 30px rgba(0,0,0,0.22)", background: "linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.92))", boxSizing: "border-box", overflow: "hidden" },
  cardBody: { flex: 1, minWidth: 0, display: "grid", gap: 8 },
  cardNameWrap: { minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" },
  codePill: { width: 50, minWidth: 50, height: 50, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", background: "#39d86f", color: "#03140a", fontSize: 14, fontWeight: 1000, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), 0 10px 20px rgba(57,216,111,0.20)" },
  compactName: { minWidth: 0, maxWidth: "100%", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 1000, letterSpacing: 0.2, color: "#f8fafc" },
  cardLabel: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.7, color: "rgba(147,197,253,0.82)", marginTop: 2 },
  addressStrong: { fontSize: 14, fontWeight: 1000, color: "#f8fafc", lineHeight: 1.25, overflowWrap: "anywhere" },
  addressWarn: { fontSize: 13, fontWeight: 1000, color: "#fde68a", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.22)", borderRadius: 12, padding: "7px 9px", lineHeight: 1.25, overflowWrap: "anywhere" },
  moneyGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px, 1fr))", gap: 6, borderRadius: 14, background: "rgba(15,23,42,0.74)", border: "1px solid rgba(148,163,184,0.12)", padding: 8, fontSize: 12, color: "#e2e8f0" },
  moneyLabel: { color: "rgba(203,213,225,0.70)", fontWeight: 900 },
  debtStrong: { color: "#fecaca", fontWeight: 1000 },
  debtInline: { color: "#fecaca" },
  cardFooterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0 },
  compactOpen: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 74, height: 32, padding: "0 12px", borderRadius: 999, background: "rgba(59,130,246,0.20)", border: "1px solid rgba(96,165,250,0.30)", color: "#bfdbfe", fontSize: 11, fontWeight: 1000, letterSpacing: 0.3, flexShrink: 0 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(2,6,23,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 },
  modalCard: { width: "min(720px, 100%)", maxWidth: "100%", maxHeight: "90vh", overflow: "auto", background: "#0f172a", color: "#f8fafc", borderRadius: 20, border: "1px solid rgba(148,163,184,0.22)", padding: 16, boxShadow: "0 24px 48px rgba(0,0,0,0.42)", boxSizing: "border-box" },
  modalKicker: { fontSize: 11, fontWeight: 1000, color: "#93c5fd", letterSpacing: 0.7, marginBottom: 4 },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 10 },
  detailBox: { borderRadius: 16, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(2,6,23,0.42)", padding: 12, display: "grid", gap: 6, minWidth: 0 },
  detailLabel: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.7, color: "rgba(147,197,253,0.86)" },
  detailValue: { fontSize: 14, fontWeight: 1000, color: "#f8fafc", overflowWrap: "anywhere" },
  detailSub: { fontSize: 12, fontWeight: 800, color: "rgba(203,213,225,0.72)" },
  paymentRows: { display: "grid", gap: 6, fontSize: 13 },
  actionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 },
  actionBtn: { minHeight: 42, borderRadius: 12, border: "1px solid rgba(96,165,250,0.28)", background: "rgba(37,99,235,0.18)", color: "#dbeafe", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 12px", fontWeight: 1000, textDecoration: "none", cursor: "pointer", boxSizing: "border-box" },
  actionBtnDisabled: { minHeight: 42, borderRadius: 12, border: "1px solid rgba(148,163,184,0.14)", background: "rgba(148,163,184,0.08)", color: "rgba(203,213,225,0.42)", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 12px", fontWeight: 1000, cursor: "not-allowed", boxSizing: "border-box" },
  page: { minHeight: "100vh", background: "#070b14", color: "#f8fafc", padding: "16px 16px calc(120px + env(safe-area-inset-bottom))", width: "100%", maxWidth: "100vw", overflowX: "hidden", boxSizing: "border-box" },
  headerLeft: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 },
  liveChip: { minHeight: 30, borderRadius: 999, border: "1px solid rgba(96,165,250,0.32)", background: "rgba(37,99,235,0.18)", color: "#dbeafe", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", letterSpacing: 0.2 },
  statsStrip: { maxWidth: 960, width: "100%", margin: "10px auto 0", display: "flex", gap: 8, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 2, boxSizing: "border-box" },
  statChip: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipOn: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(96,165,250,0.38)", background: "#2563eb", color: "#fff", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipDanger: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.18)", color: "#fecaca", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipDangerOn: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(248,113,113,0.34)", background: "#991b1b", color: "#fff", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  searchHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 },
  searchHint: { fontSize: 11, color: "rgba(203,213,225,0.64)", fontWeight: 800, marginTop: 2 },
  topActions: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 8, minWidth: 0 },
  topActionOn: { minHeight: 38, borderRadius: 12, border: "1px solid rgba(96,165,250,0.38)", background: "#2563eb", color: "#fff", padding: "0 8px", fontSize: 12, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  topActionOff: { minHeight: 38, borderRadius: 12, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(2,6,23,0.42)", color: "#e2e8f0", padding: "0 8px", fontSize: 12, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  commandDetails: { marginTop: 10, borderTop: "1px solid rgba(148,163,184,0.12)", paddingTop: 10, display: "grid", gap: 10 },
  compactToggleRow: { display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 },
  panelToggle: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.82)", color: "#e2e8f0", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  panelToggleDanger: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.22)", color: "#fecaca", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  quickChipRow: { display: "flex", gap: 7, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" },
  quickChipOn: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(96,165,250,0.40)", background: "#2563eb", color: "#fff", padding: "0 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  quickChipOff: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(148,163,184,0.18)", background: "rgba(2,6,23,0.36)", color: "#e2e8f0", padding: "0 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  commandCard: { maxWidth: 960, width: "100%", margin: "10px auto 0", background: "linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))", borderRadius: 18, border: "1px solid rgba(96,165,250,0.24)", padding: 12, boxShadow: "0 18px 34px rgba(0,0,0,0.30)", boxSizing: "border-box", overflow: "hidden" },
  commandInput: { height: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.34)", padding: "0 13px", fontWeight: 1000, outline: "none", width: "100%", maxWidth: "100%", background: "rgba(2,6,23,0.86)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", boxSizing: "border-box", fontSize: 15 },
  moneyLine: { borderRadius: 12, background: "rgba(15,23,42,0.54)", border: "1px solid rgba(148,163,184,0.10)", padding: "7px 9px", fontSize: 12, color: "#e2e8f0", fontWeight: 1000 },
  adminRiskBox: { marginTop: 12, borderTop: "1px solid rgba(248,113,113,0.18)", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderRadius: 14 },
  smartPasteCard: { borderRadius: 18, border: "1px solid rgba(96,165,250,0.24)", background: "rgba(2,6,23,0.52)", padding: 12, marginBottom: 14, display: "grid", gap: 10, boxSizing: "border-box" },
  smartPasteTextarea: { minHeight: 116, borderRadius: 14, border: "1px solid rgba(96,165,250,0.26)", padding: 12, fontWeight: 900, outline: "none", background: "rgba(2,6,23,0.84)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", width: "100%", maxWidth: "100%", boxSizing: "border-box", resize: "vertical" },
  readonlyBadgeRow: { display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginTop: 4, minWidth: 0, maxWidth: "100%" },
  actionGridCompact: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))", gap: 8, marginTop: 4 },
  cardCompact: { maxWidth: 960, width: "100%", margin: "10px auto 0", background: "rgba(15,23,42,0.96)", borderRadius: 16, border: "1px solid rgba(148,163,184,0.18)", padding: 10, boxShadow: "0 14px 28px rgba(0,0,0,0.24)", boxSizing: "border-box", overflow: "hidden" },
  sectionHeadRowCompact: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8, flexWrap: "wrap", minWidth: 0 },
  sectionHintCompact: { fontSize: 11, color: "rgba(203,213,225,0.66)", fontWeight: 800, lineHeight: 1.25, marginTop: 2 },
  headerMiniActions: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  smartPasteCardCompact: { borderRadius: 16, border: "1px solid rgba(96,165,250,0.22)", background: "rgba(2,6,23,0.48)", padding: 8, marginBottom: 10, display: "grid", gap: 7, boxSizing: "border-box" },
  compactInputHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 },
  inlineClearBtn: { border: 0, background: "transparent", color: "#93c5fd", fontSize: 11, fontWeight: 1000, cursor: "pointer", padding: "3px 4px", textDecoration: "underline" },
  smartPasteTextareaCompact: { minHeight: 104, borderRadius: 13, border: "1px solid rgba(96,165,250,0.24)", padding: 9, fontSize: 13, lineHeight: 1.32, fontWeight: 900, outline: "none", background: "rgba(2,6,23,0.84)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", width: "100%", maxWidth: "100%", boxSizing: "border-box", resize: "vertical" },
  readonlyBadgeRowCompact: { display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginTop: 0, minWidth: 0, maxWidth: "100%" },
  compactWarnBox: { borderRadius: 12, border: "1px solid rgba(245,158,11,0.24)", background: "rgba(245,158,11,0.10)", color: "#fde68a", padding: "8px 10px", fontSize: 12, fontWeight: 1000, lineHeight: 1.25 },
  smartActionStack: { display: "grid", gap: 6, marginTop: 2 },
  actionGridTwoCompact: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 },
  actionGridFourCompact: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 },
  actionBtnCompact: { minHeight: 34, borderRadius: 11, border: "1px solid rgba(96,165,250,0.26)", background: "rgba(37,99,235,0.16)", color: "#dbeafe", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 7px", fontSize: 11, fontWeight: 1000, textDecoration: "none", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  smartCreateStatusCard: { borderRadius: 14, border: "1px solid rgba(96,165,250,0.22)", background: "rgba(37,99,235,0.10)", padding: "8px 9px", display: "grid", gap: 6, marginBottom: 10 },
  smartCreateStatusText: { fontSize: 12, fontWeight: 1000, color: "#dbeafe", lineHeight: 1.25 },
  smartCreateStatusChips: { display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", minWidth: 0, maxWidth: "100%" },
  messageChipRow: { display: "flex", gap: 7, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" },
  messageChipRowCompact: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0, maxWidth: "100%", marginTop: 8 },
  accordionToggle: { width: "100%", minHeight: 38, borderRadius: 13, border: "1px solid rgba(148,163,184,0.18)", background: "rgba(2,6,23,0.34)", color: "#e2e8f0", padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, fontWeight: 1000, cursor: "pointer", boxSizing: "border-box" },
  messagePreviewBlock: { display: "grid", gap: 8, marginTop: 8 },
  messageChip: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(2,6,23,0.38)", color: "#e2e8f0", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  messageChipOn: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(96,165,250,0.42)", background: "#2563eb", color: "#fff", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  messageChipWarn: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(245,158,11,0.34)", background: "rgba(245,158,11,0.14)", color: "#fde68a", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  messagePreviewTextarea: { minHeight: 118, borderRadius: 14, border: "1px solid rgba(96,165,250,0.26)", padding: 12, fontWeight: 900, outline: "none", background: "rgba(2,6,23,0.76)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", width: "100%", maxWidth: "100%", boxSizing: "border-box", resize: "vertical" },
};
