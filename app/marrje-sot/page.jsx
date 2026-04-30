'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrdersLocal } from '@/lib/offlineStore';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';

const DAY_QUERY_LIMIT = 80;
const PICKUP_EVENT_NAME = 'tepiha:pickup-committed';
const DB_TIMEOUT_MS = 3500;

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
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function parseData(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return typeof raw === 'object' ? raw : {};
}

function cleanText(v, fallback = '') {
  const s = String(v ?? '').trim();
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

function pickM2(row, data) {
  const direct = Number(row?.m2_total ?? row?.total_m2 ?? data?.m2_total ?? data?.totals?.m2 ?? data?.totals?.area);
  if (Number.isFinite(direct) && direct >= 0) return Number(direct.toFixed(2));

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

function pickTotal(row, data) {
  const candidates = [
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

function pickEventTs(row, data) {
  return (
    toMs(row?.picked_up_at) ||
    toMs(row?.delivered_at) ||
    toMs(data?.picked_up_at) ||
    toMs(data?.delivered_at) ||
    toMs(row?.updated_at) ||
    Date.now()
  );
}

function hasPickupEventStamp(row, data) {
  return !!(row?.picked_up_at || row?.delivered_at || data?.picked_up_at || data?.delivered_at);
}

function buildRowsForDate(rows, dateKey) {
  const bucket = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const mapped = mapDbRow(row);
    if (!mapped.id) continue;
    if (!sameLocalDay(mapped.eventTs, dateKey)) continue;
    const prev = bucket.get(mapped.id);
    if (!prev || mapped.eventTs >= prev.eventTs) bucket.set(mapped.id, mapped);
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
    if (!hasPickupEventStamp(row, data)) continue;
    filtered.push(row);
  }
  return buildRowsForDate(filtered, dateKey);
}

function mapDbRow(row) {
  const data = parseData(row?.data);
  const eventTs = pickEventTs(row, data);
  return {
    id: String(row?.id || ''),
    code: normalizeCode(row?.code || row?.code_n || data?.code || data?.client?.code || ''),
    name: cleanText(row?.client_name || data?.client_name || data?.client?.name, 'PA EMËR'),
    phone: cleanText(row?.client_phone || data?.client_phone || data?.client?.phone, ''),
    address: cleanText(data?.client?.address || data?.pickup_address || data?.address, 'PA ADRESË'),
    status: cleanText(row?.status || data?.status, '').toLowerCase(),
    pieces: pickPieces(row, data),
    m2: pickM2(row, data),
    total: pickTotal(row, data),
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
    code: normalizeCode(detail?.code || data?.code || data?.client?.code || ''),
    name: cleanText(detail?.name || detail?.client_name || data?.client_name || data?.client?.name, 'PA EMËR'),
    phone: cleanText(detail?.phone || detail?.client_phone || data?.client_phone || data?.client?.phone, ''),
    address: cleanText(detail?.address || data?.client?.address || data?.pickup_address || data?.address, 'PA ADRESË'),
    status: cleanText(detail?.status || data?.status || 'dorzim', 'dorzim').toLowerCase(),
    pieces: Number(detail?.pieces),
    m2: Number(detail?.m2),
    total: Number(detail?.total),
    eventTs,
  };
  if (!Number.isFinite(base.pieces) || base.pieces <= 0) base.pieces = pickPieces(detail, data);
  if (!Number.isFinite(base.m2) || base.m2 < 0) base.m2 = pickM2(detail, data);
  if (!Number.isFinite(base.total) || base.total < 0) base.total = pickTotal(detail, data);
  base.m2 = Number((base.m2 || 0).toFixed(2));
  base.total = Number((base.total || 0).toFixed(2));
  return base;
}

async function fetchRowsForDate(dateKey) {
  const startIso = startOfLocalDay(dateKey).toISOString();
  const endIso = endOfLocalDay(dateKey).toISOString();
  const select = 'id, code, status, client_name, client_phone, pieces, m2_total, price_total, data, created_at, updated_at, delivered_at, picked_up_at';

  const { data, error } = await supabase
    .from('orders')
    .select(select)
    .in('status', ['dorzim', 'marrje'])
    .or(`and(delivered_at.gte.${startIso},delivered_at.lt.${endIso}),and(picked_up_at.gte.${startIso},picked_up_at.lt.${endIso})`)
    .order('created_at', { ascending: false })
    .limit(DAY_QUERY_LIMIT);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  await saveOrdersLocal(
    rows.map((row) => ({ ...row, _local: false, _synced: true, table: 'orders' })),
    { skipMasterCache: true }
  ).catch(() => {});

  return buildRowsForDate(rows, dateKey);
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

const shellStyle = {
  minHeight: '100dvh',
  background: '#0b1020',
  color: '#fff',
  padding: '16px 14px 28px',
};

const cardStyle = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 16,
  padding: 12,
  backdropFilter: 'blur(6px)',
};

function MarrjeSotList({ online, loading, error, filtered }) {
  if (!online && !loading && filtered.length === 0) {
    return (
      <div style={{ ...cardStyle, borderColor: 'rgba(255,120,120,0.35)', color: '#ffd6d6' }}>
        OFFLINE. NËSE EKZISTON CACHE LOKALE, DO TË SHFAQET KËTU.
      </div>
    );
  }

  if (loading) {
    return <div data-visible-stuck-candidate="1" style={cardStyle}>DUKE LEXUAR NGA DB... Nëse rrjeti nuk përgjigjet, cache lokale hapet vetë.</div>;
  }

  if (error && filtered.length === 0) {
    return <div style={{ ...cardStyle, borderColor: 'rgba(255,120,120,0.35)', color: '#ffd6d6' }}>{error}</div>;
  }

  if (filtered.length === 0) {
    return <div style={cardStyle}>NUK KA MARRJE PËR KËTË DATË.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {filtered.map((row) => (
        <div key={row.id} style={{ ...cardStyle, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ minWidth: 52, height: 52, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(80,220,120,0.18)', border: '1px solid rgba(80,220,120,0.35)', fontWeight: 800 }}>
                {row.code || '#'}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</div>
                <div style={{ fontSize: 13, opacity: 0.78 }}>{row.phone || 'PA NUMËR'}</div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, opacity: 0.72 }}>ORA</div>
              <div style={{ fontWeight: 800 }}>{formatClock(row.eventTs)}</div>
            </div>
          </div>

          <div style={{ fontSize: 13, opacity: 0.82 }}>{row.address}</div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ padding: '7px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>COPË {row.pieces || 0}</span>
            <span style={{ padding: '7px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>M² {Number(row.m2 || 0).toFixed(2)}</span>
            <span style={{ padding: '7px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>€ {Number(row.total || 0).toFixed(2)}</span>
            <span style={{ padding: '7px 10px', borderRadius: 999, background: 'rgba(80,220,120,0.18)', border: '1px solid rgba(80,220,120,0.35)' }}>MARRË</span>
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
            if (list.length > 0) setError('RRJETI DËSHTOI. PO SHFAQET CACHE LOKALE.');
            else setError(cleanText(err?.message, 'NUK U LEXUAN TË DHËNAT NGA DB.'));
          }
        }
      } else {
        list = await warmLocalPromise;
        if (latestDateRef.current === dateToLoad && !onlineNow && list.length > 0) {
          setError('OFFLINE: PO SHFAQET CACHE LOKALE.');
        }
      }

      if (latestDateRef.current === dateToLoad) {
        setRows(Array.isArray(list) ? list : []);
        if (!list.length && !onlineNow) setError('OFFLINE DHE NUK U GJET CACHE LOKALE.');
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
      }
      return undefined;
    }

    function startInitialLoad() {
      if (firstLoadStartedRef.current) return;
      firstLoadStartedRef.current = true;
      void load(dateKey);
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
            setError('RRJETI DËSHTOI. PO SHFAQET CACHE LOKALE.');
          } else {
            setError('RRJETI DËSHTOI. NUK U GJET CACHE LOKALE PËR SOT.');
          }
        } catch {
          if (!alive) return;
          setError('RRJETI DËSHTOI. HAPE HOME OSE PROVO PËRSËRI.');
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
    }, 2200);
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
        const idx = next.findIndex((item) => String(item?.id || '') === mapped.id);
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
      const hay = [row.code, row.name, row.phone, row.address].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  const summary = useMemo(() => {
    return filtered.reduce(
      (acc, row) => {
        acc.count += 1;
        acc.pieces += Number(row.pieces) || 0;
        acc.m2 += Number(row.m2) || 0;
        acc.total += Number(row.total) || 0;
        return acc;
      },
      { count: 0, pieces: 0, m2: 0, total: 0 }
    );
  }, [filtered]);

  return (
    <div style={shellStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 1 }}>LIGHTWEIGHT • EVENT DRIVEN</div>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.05 }}>MARRJE SOT</div>
        </div>
        <button
          type="button"
          onClick={() => { router.push('/'); }}
          style={{ color: '#fff', textDecoration: 'none', padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)' }}
        >
          HOME
        </button>
      </div>

      <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>ZGJIDH DATËN</span>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value || todayKey())}
              style={{
                width: '100%',
                background: '#121a32',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: '12px 12px',
              }}
            />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>KËRKO</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="KODI, EMRI, TELEFONI"
              style={{
                minWidth: 150,
                background: '#121a32',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: '12px 12px',
              }}
            />
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
        <div style={cardStyle}><div style={{ fontSize: 12, opacity: 0.72 }}>KLIENTË</div><div style={{ fontSize: 20, fontWeight: 800 }}>{summary.count}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 12, opacity: 0.72 }}>COPË</div><div style={{ fontSize: 20, fontWeight: 800 }}>{summary.pieces}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 12, opacity: 0.72 }}>M²</div><div style={{ fontSize: 20, fontWeight: 800 }}>{summary.m2.toFixed(2)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 12, opacity: 0.72 }}>€</div><div style={{ fontSize: 20, fontWeight: 800 }}>{summary.total.toFixed(2)}</div></div>
      </div>

      <MarrjeSotList online={online} loading={loading} error={error} filtered={filtered} />
    </div>
  );
}
