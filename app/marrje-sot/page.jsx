'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrdersLocal } from '@/lib/offlineStore';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';

const DAY_QUERY_LIMIT = 220;
const TRANSPORT_QUERY_LIMIT = 360;
const PICKUP_EVENT_NAME = 'tepiha:pickup-committed';
const DB_TIMEOUT_MS = 4200;

function withTimeout(promise, ms = DB_TIMEOUT_MS, label = 'db_timeout') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(label);
        err.code = 'TEPIHA_TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]).finally(() => {
    try { if (timer) clearTimeout(timer); } catch {}
  });
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDateKey(dateKey, days) {
  const d = startOfLocalDay(dateKey || todayKey());
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateHuman(dateKey) {
  try {
    return new Intl.DateTimeFormat('sq-AL', { weekday: 'short', day: '2-digit', month: 'short' }).format(startOfLocalDay(dateKey));
  } catch {
    return String(dateKey || '');
  }
}

function startOfLocalDay(dateKey) {
  const [y, m, d] = String(dateKey || todayKey()).split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function endOfLocalDay(dateKey) {
  const s = startOfLocalDay(dateKey);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, 0, 0, 0, 0);
}

function nextLocalMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
}

function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1000000000000) return v;
    if (v > 1000000000) return v * 1000;
    return 0;
  }
  const s = String(v || '').trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (n > 1000000000000) return n;
    if (n > 1000000000) return n * 1000;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseData(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function cleanText(v, fallback = '') {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s === 'undefined' || s === 'null') return fallback;
  return s;
}

function normalizeCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '';
}

function sameLocalDay(ts, dateKey) {
  if (!ts) return false;
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}` === String(dateKey || '');
}

function pickPieces(row, data) {
  const direct = Number(
    row?.pieces ??
    row?.total_pieces ??
    data?.pieces ??
    data?.totals?.pieces ??
    data?.pieces_total
  );
  if (Number.isFinite(direct) && direct > 0) return direct;

  const rugs = Array.isArray(data?.tepiha)
    ? data.tepiha.reduce((sum, item) => sum + (Number(item?.qty) || 0), 0)
    : 0;
  const staza = Array.isArray(data?.staza)
    ? data.staza.reduce((sum, item) => sum + (Number(item?.qty) || 0), 0)
    : 0;
  const shk = Number(data?.shkallore?.qty) || 0;
  return rugs + staza + shk;
}

function pickM2(row, data, source = 'base') {
  const candidates = source === 'transport'
    ? [
        row?.m2_total,
        row?.m2,
        data?.pay?.m2,
        data?.m2_total,
        data?.m2,
        data?.totals?.m2,
        data?.totals?.area,
      ]
    : [
        row?.m2_total,
        row?.total_m2,
        data?.m2_total,
        data?.totals?.m2,
        data?.totals?.area,
        data?.pay?.m2,
      ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Number(n.toFixed(2));
  }

  let total = 0;
  if (Array.isArray(data?.tepiha)) {
    for (const item of data.tepiha) total += (Number(item?.m2) || 0) * (Number(item?.qty) || 0);
  }
  if (Array.isArray(data?.staza)) {
    for (const item of data.staza) total += (Number(item?.m2) || 0) * (Number(item?.qty) || 0);
  }
  if (data?.shkallore) total += (Number(data.shkallore?.qty) || 0) * (Number(data.shkallore?.per) || 0);
  return Number(total.toFixed(2));
}

function pickTotal(row, data, source = 'base') {
  const candidates = source === 'transport'
    ? [
        row?.price_total,
        row?.total_price,
        row?.total,
        row?.amount,
        data?.pay?.euro,
        data?.pay?.total,
        data?.total,
        data?.totals?.total,
        data?.price_total,
      ]
    : [
        row?.price_total,
        row?.total_price,
        row?.total,
        data?.total,
        data?.pay?.euro,
        data?.totals?.total,
        data?.totals?.grandTotal,
        data?.totals?.euro,
        data?.price_total,
      ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Number(n.toFixed(2));
  }
  return 0;
}

function pickEventTs(row, data, source = 'base') {
  if (source === 'transport') {
    return (
      toMs(row?.delivered_at) ||
      toMs(data?.delivered_at) ||
      toMs(row?.completed_at) ||
      toMs(data?.completed_at) ||
      toMs(row?.done_at) ||
      toMs(data?.done_at) ||
      toMs(row?.picked_up_at) ||
      toMs(data?.picked_up_at) ||
      toMs(row?.updated_at) ||
      toMs(data?.updated_at) ||
      0
    );
  }

  return (
    toMs(row?.picked_up_at) ||
    toMs(row?.delivered_at) ||
    toMs(data?.picked_up_at) ||
    toMs(data?.delivered_at) ||
    toMs(row?.updated_at) ||
    Date.now()
  );
}

function hasPickupEventStamp(row, data, source = 'base') {
  if (source === 'transport') {
    return !!(
      row?.delivered_at ||
      data?.delivered_at ||
      row?.completed_at ||
      data?.completed_at ||
      row?.done_at ||
      data?.done_at ||
      row?.picked_up_at ||
      data?.picked_up_at
    );
  }
  return !!(row?.picked_up_at || row?.delivered_at || data?.picked_up_at || data?.delivered_at);
}

function buildRowsForDate(rows, dateKey, source = 'base') {
  const bucket = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const mapped = mapDbRow(row, source);
    if (!mapped.id) continue;
    if (!sameLocalDay(mapped.eventTs, dateKey)) continue;
    const key = `${mapped.source}:${mapped.id}`;
    const prev = bucket.get(key);
    if (!prev || mapped.eventTs >= prev.eventTs) bucket.set(key, mapped);
  }
  return Array.from(bucket.values()).sort((a, b) => b.eventTs - a.eventTs);
}

async function buildRowsFromLocal(dateKey) {
  const rows = await getAllOrdersLocal().catch(() => []);
  const filtered = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const data = parseData(row?.data);
    const status = cleanText(row?.status || data?.status, '').toLowerCase();
    if (status !== 'dorzim' && status !== 'marrje') continue;
    if (!hasPickupEventStamp(row, data, 'base')) continue;
    filtered.push(row);
  }
  return buildRowsForDate(filtered, dateKey, 'base');
}

function mapDbRow(row, source = 'base') {
  const data = parseData(row?.data);
  const isTransport = source === 'transport';
  const eventTs = pickEventTs(row, data, source);
  const code = isTransport
    ? normalizeCode(row?.code_str || data?.code_str || row?.code || row?.code_n || data?.code || data?.code_n || '')
    : normalizeCode(row?.code || row?.code_n || data?.code || data?.client?.code || '');
  return {
    id: String(row?.id || data?.id || ''),
    source,
    code,
    name: cleanText(row?.client_name || data?.client_name || data?.client?.name || row?.name || data?.name, 'PA EMËR'),
    phone: cleanText(row?.client_phone || data?.client_phone || data?.client?.phone || row?.phone || data?.phone, ''),
    address: cleanText(data?.client?.address || data?.pickup_address || data?.delivery_address || data?.address || row?.address, ''),
    status: cleanText(row?.status || data?.status, '').toLowerCase(),
    pieces: isTransport ? 0 : pickPieces(row, data),
    m2: pickM2(row, data, source),
    total: pickTotal(row, data, source),
    eventTs,
  };
}

function mapEventRow(detail) {
  const data = parseData(detail?.data || detail?.order || detail?.payload || {});
  const eventTs = (
    toMs(detail?.eventTs) ||
    toMs(detail?.picked_up_at) ||
    toMs(detail?.delivered_at) ||
    toMs(data?.picked_up_at) ||
    toMs(data?.delivered_at) ||
    Date.now()
  );
  const base = {
    id: String(detail?.id || data?.id || ''),
    source: 'base',
    code: normalizeCode(detail?.code || data?.code || data?.client?.code || ''),
    name: cleanText(detail?.name || detail?.client_name || data?.client_name || data?.client?.name, 'PA EMËR'),
    phone: cleanText(detail?.phone || detail?.client_phone || data?.client_phone || data?.client?.phone, ''),
    address: cleanText(detail?.address || data?.client?.address || data?.pickup_address || data?.address, ''),
    status: cleanText(detail?.status || data?.status || 'dorzim', 'dorzim').toLowerCase(),
    pieces: Number(detail?.pieces),
    m2: Number(detail?.m2),
    total: Number(detail?.total),
    eventTs,
  };
  if (!Number.isFinite(base.pieces) || base.pieces <= 0) base.pieces = pickPieces(detail, data);
  if (!Number.isFinite(base.m2) || base.m2 < 0) base.m2 = pickM2(detail, data, 'base');
  if (!Number.isFinite(base.total) || base.total < 0) base.total = pickTotal(detail, data, 'base');
  base.m2 = Number((base.m2 || 0).toFixed(2));
  base.total = Number((base.total || 0).toFixed(2));
  return base;
}

async function fetchBaseRowsForDate(dateKey) {
  const startIso = startOfLocalDay(dateKey).toISOString();
  const endIso = endOfLocalDay(dateKey).toISOString();
  const select = 'id, code, status, client_name, client_phone, pieces, m2_total, price_total, data, created_at, updated_at, delivered_at, picked_up_at';

  const { data, error } = await supabase
    .from('orders')
    .select(select)
    .in('status', ['dorzim', 'marrje'])
    .or(`and(delivered_at.gte.${startIso},delivered_at.lt.${endIso}),and(picked_up_at.gte.${startIso},picked_up_at.lt.${endIso}),and(updated_at.gte.${startIso},updated_at.lt.${endIso})`)
    .order('updated_at', { ascending: false })
    .limit(DAY_QUERY_LIMIT);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  await saveOrdersLocal(
    rows.map((row) => ({ ...row, _local: false, _synced: true, table: 'orders' })),
    { skipMasterCache: true }
  ).catch(() => {});

  return buildRowsForDate(rows, dateKey, 'base');
}

async function fetchTransportRowsForDate(dateKey) {
  const startIso = startOfLocalDay(dateKey).toISOString();
  const endIso = endOfLocalDay(dateKey).toISOString();

  const dateFilter = `and(delivered_at.gte.${startIso},delivered_at.lt.${endIso}),and(completed_at.gte.${startIso},completed_at.lt.${endIso}),and(picked_up_at.gte.${startIso},picked_up_at.lt.${endIso}),and(updated_at.gte.${startIso},updated_at.lt.${endIso})`;

  let rows = [];
  let directError = null;

  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .or(dateFilter)
      .order('updated_at', { ascending: false })
      .limit(TRANSPORT_QUERY_LIMIT);
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    directError = err;
  }

  if (!rows.length) {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(TRANSPORT_QUERY_LIMIT);
    if (error && directError) throw directError;
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  }

  const filtered = rows.filter((row) => {
    const data = parseData(row?.data);
    const status = cleanText(row?.status || data?.status, '').toLowerCase();
    const statusOk = ['done', 'dorzim', 'delivery', 'delivered', 'marrje', 'gati'].includes(status);
    if (!statusOk) return false;
    if (!hasPickupEventStamp(row, data, 'transport') && status !== 'done') return false;
    const eventTs = pickEventTs(row, data, 'transport');
    return sameLocalDay(eventTs, dateKey);
  });

  return buildRowsForDate(filtered, dateKey, 'transport');
}

async function fetchRowsForDate(dateKey) {
  const [baseRows, transportRows] = await Promise.all([
    fetchBaseRowsForDate(dateKey).catch((err) => {
      console.error('Marrje base fetch failed:', err);
      return [];
    }),
    fetchTransportRowsForDate(dateKey).catch((err) => {
      console.error('Marrje transport fetch failed:', err);
      return [];
    }),
  ]);

  return [...baseRows, ...transportRows].sort((a, b) => b.eventTs - a.eventTs);
}

function formatClock(ts) {
  if (!ts) return '--:--';
  try {
    return new Intl.DateTimeFormat('sq-AL', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  } catch {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function formatMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

const shellStyle = {
  minHeight: '100dvh',
  background: 'linear-gradient(180deg,#020617 0%,#0b1120 55%,#111827 100%)',
  color: '#fff',
  padding: 'max(env(safe-area-inset-top), 12px) 10px max(env(safe-area-inset-bottom), 28px)',
  boxSizing: 'border-box',
  overflowX: 'hidden',
};

const cardStyle = {
  background: 'rgba(15,23,42,0.72)',
  border: '1px solid rgba(148,163,184,0.18)',
  borderRadius: 16,
  padding: 11,
  boxShadow: '0 12px 28px rgba(0,0,0,0.22)',
  boxSizing: 'border-box',
  minWidth: 0,
};

const inputStyle = {
  width: '100%',
  minWidth: 0,
  background: 'rgba(2,6,23,.72)',
  color: '#fff',
  border: '1px solid rgba(148,163,184,.24)',
  borderRadius: 13,
  padding: '11px 11px',
  outline: 'none',
  boxSizing: 'border-box',
  fontWeight: 900,
};

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  padding: '4px 8px',
  fontSize: 10,
  lineHeight: 1.1,
  fontWeight: 1000,
  whiteSpace: 'nowrap',
  border: '1px solid rgba(148,163,184,.22)',
  background: 'rgba(255,255,255,.06)',
  color: 'rgba(226,232,240,.92)',
};

const sourceStyle = {
  base: {
    background: 'rgba(34,197,94,.16)',
    border: '1px solid rgba(74,222,128,.34)',
    color: '#bbf7d0',
  },
  transport: {
    background: 'rgba(239,68,68,.18)',
    border: '1px solid rgba(248,113,113,.34)',
    color: '#fecaca',
  },
};

function rowSourceLabel(row) {
  return row.source === 'transport' ? 'TRANSPORT' : 'BAZË';
}

function MarrjeSotList({ online, loading, error, filtered }) {
  if (!online && !loading && filtered.length === 0) {
    return (
      <div style={{ ...cardStyle, borderColor: 'rgba(255,120,120,0.35)', color: '#ffd6d6' }}>
        OFFLINE. Nëse ka cache lokale, shfaqet këtu.
      </div>
    );
  }

  if (loading) {
    return <div data-visible-stuck-candidate="1" style={cardStyle}>Duke lexuar...</div>;
  }

  if (error && filtered.length === 0) {
    return <div style={{ ...cardStyle, borderColor: 'rgba(255,120,120,0.35)', color: '#ffd6d6' }}>{error}</div>;
  }

  if (filtered.length === 0) {
    return <div style={cardStyle}>Nuk ka marrje për këtë datë.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 8, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      {filtered.map((row) => (
        <div key={`${row.source}:${row.id}`} style={{ ...cardStyle, display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr)', gap: 9, alignItems: 'center' }}>
          <div style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            display: 'grid',
            placeItems: 'center',
            background: row.source === 'transport' ? '#dc2626' : '#16a34a',
            color: '#fff',
            fontSize: 13,
            fontWeight: 1000,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.18), 0 10px 22px rgba(0,0,0,.20)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {row.code || '—'}
          </div>

          <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <div style={{ minWidth: 0, flex: 1, color: '#fff', fontSize: 15, lineHeight: 1.16, fontWeight: 1000, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.name}
              </div>
              <span style={{ ...chipStyle, ...(sourceStyle[row.source] || sourceStyle.base), flexShrink: 0 }}>{rowSourceLabel(row)}</span>
              <span style={{ ...chipStyle, flexShrink: 0 }}>{formatClock(row.eventTs)}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ minWidth: 0, flex: 1, color: 'rgba(226,232,240,.66)', fontSize: 11.5, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.phone || row.address || 'PA NUMËR'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
              {row.source !== 'transport' ? <span style={chipStyle}>{row.pieces || 0} copë</span> : null}
              <span style={chipStyle}>{Number(row.m2 || 0).toFixed(2)} m²</span>
              <span style={chipStyle}>€{formatMoney(row.total)}</span>
              <span style={{ ...chipStyle, background: 'rgba(34,197,94,.15)', border: '1px solid rgba(74,222,128,.28)', color: '#bbf7d0' }}>MARRË</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MarrjeSotPage() {
  const router = useRouter();
  useRouteAlive('marrje_sot_page');
  const [hydrated, setHydrated] = useState(false);
  const [dateKey, setDateKey] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [online, setOnline] = useState(true);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const latestDateRef = useRef('');
  const uiReadyMarkedRef = useRef(false);
  const firstLoadSettledRef = useRef(false);
  const firstLoadStartedRef = useRef(false);

  useEffect(() => {
    const next = todayKey();
    latestDateRef.current = next;
    setHydrated(true);
    setDateKey(next);
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
  }, []);

  const load = useCallback(async (targetDate, options = {}) => {
    const dateToLoad = String(targetDate || latestDateRef.current || todayKey());
    if (!dateToLoad) return;
    latestDateRef.current = dateToLoad;

    const preferLocal = !!options.preferLocal;
    const onlineNow = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }

    inFlightRef.current = true;
    setOnline(onlineNow);
    if (!options.keepRows) setRows([]);
    setLoading(true);
    setError('');

    const warmLocalPromise = buildRowsFromLocal(dateToLoad).catch(() => []);

    try {
      if (!options.keepRows) {
        try {
          bootLog('before_local_read', {
            page: 'marrje_sot',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/marrje-sot') : '/marrje-sot',
            source: 'local_boot_warm',
            targetDate: dateToLoad,
          });
        } catch {}
        const warmLocal = await Promise.race([
          warmLocalPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 180)),
        ]);
        try {
          bootLog('after_local_read', {
            page: 'marrje_sot',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/marrje-sot') : '/marrje-sot',
            source: 'local_boot_warm',
            targetDate: dateToLoad,
            count: Array.isArray(warmLocal) ? warmLocal.length : -1,
          });
        } catch {}
        if (latestDateRef.current === dateToLoad && Array.isArray(warmLocal) && warmLocal.length > 0) {
          setRows(warmLocal);
          setLoading(false);
        }
      }

      let list = [];
      if (onlineNow && !preferLocal) {
        try {
          list = await withTimeout(fetchRowsForDate(dateToLoad), DB_TIMEOUT_MS, 'marrje_sot_db_timeout');
        } catch (err) {
          console.error('Marrje Sot DB failed, switching to local cache:', err);
          list = await warmLocalPromise;
          if (latestDateRef.current === dateToLoad) {
            if (list.length > 0) setError('Rrjeti dështoi. Po shfaqet cache lokale.');
            else setError(cleanText(err?.message, 'Nuk u lexuan të dhënat nga DB.'));
          }
        }
      } else {
        list = await warmLocalPromise;
        if (latestDateRef.current === dateToLoad && !onlineNow && list.length > 0) {
          setError('Offline: po shfaqet cache lokale.');
        }
      }

      if (latestDateRef.current === dateToLoad) {
        setRows(Array.isArray(list) ? list : []);
        if (!list.length && !onlineNow) setError('Offline dhe nuk u gjet cache lokale.');
      }
    } finally {
      if (latestDateRef.current === dateToLoad) setLoading(false);
      firstLoadSettledRef.current = true;
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void load(latestDateRef.current, { keepRows: true, preferLocal: !onlineNow });
      }
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !dateKey) return undefined;
    latestDateRef.current = dateKey;

    if (isWithinStartupIsolationWindow()) {
      bootLog('marrje_sot_startup_isolation_skip_visible_gate', {
        path: typeof window !== 'undefined' ? (window.location.pathname || '/marrje-sot') : '/marrje-sot',
        leftMs: getStartupIsolationLeftMs(),
      });
      if (!firstLoadStartedRef.current) {
        firstLoadStartedRef.current = true;
        void load(dateKey);
      } else {
        void load(dateKey, { keepRows: true });
      }
      return undefined;
    }

    function startInitialLoad() {
      if (!firstLoadStartedRef.current) {
        firstLoadStartedRef.current = true;
        void load(dateKey);
      } else {
        void load(dateKey, { keepRows: true });
      }
    }

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisible);
        startInitialLoad();
      };
      document.addEventListener('visibilitychange', onVisible, { passive: true });
      return () => document.removeEventListener('visibilitychange', onVisible);
    }

    startInitialLoad();
    return undefined;
  }, [dateKey, hydrated, load]);

  useEffect(() => {
    if (!hydrated || !dateKey) return undefined;
    if (loading) return undefined;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return undefined;
    const timer = setTimeout(() => {
      try {
        bootLog('ui_ready', {
          page: 'marrje_sot',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/marrje-sot') : '/marrje-sot',
          source: uiReadyMarkedRef.current ? 'stable_repeat' : 'stable_first',
          count: Array.isArray(rows) ? rows.length : 0,
          loading: !!loading,
          error: !!error,
        });
      } catch {}
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      try {
        bootMarkReady({
          source: 'marrje_sot_page',
          page: 'marrje_sot',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/marrje-sot') : '/marrje-sot',
          count: Array.isArray(rows) ? rows.length : 0,
          loading: !!loading,
        });
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, [dateKey, hydrated, loading, rows.length, error]);

  useEffect(() => {
    if (!hydrated || !dateKey || !loading) return undefined;
    let alive = true;
    const timer = setTimeout(async () => {
      if (!alive) return;
      if (latestDateRef.current !== dateKey) return;
      if (!firstLoadSettledRef.current) {
        try {
          const localRows = await Promise.race([
            buildRowsFromLocal(dateKey),
            new Promise((resolve) => setTimeout(() => resolve([]), 700)),
          ]);
          if (!alive || latestDateRef.current !== dateKey) return;
          if (Array.isArray(localRows) && localRows.length > 0) {
            setRows(localRows);
            setError('Rrjeti dështoi. Po shfaqet cache lokale.');
          } else {
            setError('Rrjeti dështoi. Nuk u gjet cache lokale për këtë datë.');
          }
        } catch {
          if (!alive) return;
          setError('Rrjeti dështoi. Hape HOME ose provo përsëri.');
        }
        firstLoadSettledRef.current = true;
        inFlightRef.current = false;
        queuedRef.current = false;
        setLoading(false);
        try {
          window.dispatchEvent(new CustomEvent('tepiha:route-ui-alive', {
            detail: { source: 'marrje_sot_visible_stuck_guard_v25', path: '/marrje-sot', reason: 'db_timeout_fail_open' }
          }));
          window.dispatchEvent(new CustomEvent('tepiha:force-route-settled', {
            detail: { source: 'marrje_sot_visible_stuck_guard_v25', path: '/marrje-sot', reason: 'db_timeout_fail_open' }
          }));
        } catch {}
      }
    }, 2400);
    return () => { alive = false; clearTimeout(timer); };
  }, [dateKey, hydrated, loading]);

  useEffect(() => {
    if (!hydrated) return undefined;

    function handleOnline() {
      setOnline(true);
      if (latestDateRef.current) void load(latestDateRef.current, { keepRows: true });
    }

    function handleOffline() {
      setOnline(false);
      if (latestDateRef.current) void load(latestDateRef.current, { keepRows: true, preferLocal: true });
    }

    function handlePickupCommitted(ev) {
      const selected = latestDateRef.current;
      if (!selected || selected !== todayKey()) return;
      const mapped = mapEventRow(ev?.detail || {});
      if (!mapped.id) return;
      if (!sameLocalDay(mapped.eventTs, selected)) return;
      setRows((prev) => {
        const next = Array.isArray(prev) ? [...prev] : [];
        const idx = next.findIndex((item) => String(item?.id || '') === mapped.id && String(item?.source || 'base') === mapped.source);
        if (idx >= 0) next.splice(idx, 1);
        next.unshift(mapped);
        next.sort((a, b) => Number(b?.eventTs || 0) - Number(a?.eventTs || 0));
        return next;
      });
      setLoading(false);
      setError('');
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener(PICKUP_EVENT_NAME, handlePickupCommitted);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener(PICKUP_EVENT_NAME, handlePickupCommitted);
    };
  }, [hydrated, load]);

  useEffect(() => {
    if (!hydrated || !dateKey) return undefined;

    function wakeReload() {
      if (!firstLoadSettledRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!latestDateRef.current) return;
      void load(latestDateRef.current, { keepRows: true });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', wakeReload, { passive: true });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', wakeReload, { passive: true });
      window.addEventListener('focus', wakeReload, { passive: true });
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', wakeReload);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', wakeReload);
        window.removeEventListener('focus', wakeReload);
      }
    };
  }, [dateKey, hydrated, load]);

  useEffect(() => {
    let timer = null;
    const selectedIsToday = hydrated && !!dateKey && dateKey === todayKey();
    if (!selectedIsToday) return undefined;
    const wait = Math.max(1000, nextLocalMidnight().getTime() - Date.now());
    timer = setTimeout(() => {
      const next = todayKey();
      latestDateRef.current = next;
      setDateKey(next);
      setRows([]);
      void load(next);
    }, wait);
    return () => timer && clearTimeout(timer);
  }, [dateKey, hydrated, load]);

  const filtered = useMemo(() => {
    const q = String(search || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const hay = [row.code, row.name, row.phone, row.address, row.source].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  const summary = useMemo(() => {
    return filtered.reduce(
      (acc, row) => {
        acc.count += 1;
        acc.base += row.source === 'transport' ? 0 : 1;
        acc.transport += row.source === 'transport' ? 1 : 0;
        acc.pieces += Number(row.pieces) || 0;
        acc.m2 += Number(row.m2) || 0;
        acc.total += Number(row.total) || 0;
        return acc;
      },
      { count: 0, base: 0, transport: 0, pieces: 0, m2: 0, total: 0 }
    );
  }, [filtered]);

  const selectedLabel = dateKey === todayKey()
    ? 'Sot'
    : (dateKey === shiftDateKey(todayKey(), -1) ? 'Dje' : formatDateHuman(dateKey));

  return (
    <div style={shellStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, opacity: 0.72, letterSpacing: 1.1, fontWeight: 950 }}>BAZË + TRANSPORT</div>
          <div style={{ fontSize: 28, fontWeight: 1000, lineHeight: 1.05 }}>MARRJET</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(226,232,240,.68)', fontWeight: 850 }}>{selectedLabel} • {dateKey || '—'}</div>
        </div>
        <button
          type="button"
          onClick={() => { router.push('/'); }}
          style={{ color: '#fff', textDecoration: 'none', padding: '10px 12px', borderRadius: 13, border: '1px solid rgba(148,163,184,.22)', background: 'rgba(15,23,42,.78)', fontWeight: 1000, flexShrink: 0 }}
        >
          HOME
        </button>
      </div>

      <div style={{ ...cardStyle, marginBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 9 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
            <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 11, opacity: 0.76, fontWeight: 1000 }}>DATA</span>
              <input
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value || todayKey())}
                style={inputStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 11, opacity: 0.76, fontWeight: 1000 }}>KËRKO</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Kod / emër / tel"
                style={inputStyle}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setDateKey(todayKey())} style={{ ...chipStyle, padding: '8px 11px', cursor: 'pointer', ...(dateKey === todayKey() ? sourceStyle.base : {}) }}>SOT</button>
            <button type="button" onClick={() => setDateKey(shiftDateKey(todayKey(), -1))} style={{ ...chipStyle, padding: '8px 11px', cursor: 'pointer', ...(dateKey === shiftDateKey(todayKey(), -1) ? sourceStyle.base : {}) }}>DJE</button>
            <button type="button" onClick={() => void load(dateKey, { keepRows: true })} style={{ ...chipStyle, padding: '8px 11px', cursor: 'pointer' }}>RIFRESKO</button>
            {!online ? <span style={{ ...chipStyle, borderColor: 'rgba(248,113,113,.40)', color: '#fecaca' }}>OFFLINE</span> : null}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
        <div style={cardStyle}><div style={{ fontSize: 11, opacity: 0.72, fontWeight: 900 }}>MARRJE</div><div style={{ fontSize: 21, fontWeight: 1000 }}>{summary.count}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 11, opacity: 0.72, fontWeight: 900 }}>EURO</div><div style={{ fontSize: 21, fontWeight: 1000 }}>€{summary.total.toFixed(2)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 11, opacity: 0.72, fontWeight: 900 }}>M²</div><div style={{ fontSize: 21, fontWeight: 1000 }}>{summary.m2.toFixed(2)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 11, opacity: 0.72, fontWeight: 900 }}>BAZË / TRANSPORT</div><div style={{ fontSize: 16, fontWeight: 1000 }}>{summary.base} / {summary.transport}</div></div>
      </div>

      {error ? <div style={{ ...cardStyle, marginBottom: 10, borderColor: 'rgba(251,191,36,.30)', color: '#fde68a', fontSize: 12, fontWeight: 900 }}>{error}</div> : null}

      <MarrjeSotList online={online} loading={loading} error={error} filtered={filtered} />
    </div>
  );
}
