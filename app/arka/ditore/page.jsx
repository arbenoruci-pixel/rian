'use client';

import Link from '@/lib/routerCompat.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { supabase } from '@/lib/supabaseClient';
import useRouteAlive from '@/lib/routeAlive';
import { bootMarkReady } from '@/lib/bootLog';

const TIME_ZONE = 'Europe/Belgrade';
const RPC_NAME = 'get_dispatch_daily_control_v1';
const CACHE_PREFIX = 'tepiha_dispatch_daily_control_v1:';
const AUTO_REFRESH_MS = 60_000;
const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUMBER = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function safeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeRows(value) {
  return Array.isArray(value) ? value : [];
}

function euro(value) {
  return `€${MONEY.format(safeNumber(value))}`;
}

function m2(value) {
  return `${NUMBER.format(safeNumber(value))} m²`;
}

function dateKeyInBelgrade(value = new Date()) {
  try {
    const d = value instanceof Date ? value : new Date(value || Date.now());
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(dateKey, days) {
  const parts = String(dateKey || '').split('-').map(Number);
  const date = new Date(Date.UTC(parts[0] || 1970, (parts[1] || 1) - 1, parts[2] || 1, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function formatDateLabel(dateKey) {
  try {
    const [y, m, d] = String(dateKey || '').split('-').map(Number);
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0)));
  } catch {
    return String(dateKey || '');
  }
}

function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return String(value || '—');
  }
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cacheKey(pin, dateKey) {
  return `${CACHE_PREFIX}${String(pin || '').trim()}:${String(dateKey || '').trim()}`;
}

function readCachedReport(pin, dateKey) {
  try {
    const raw = window.localStorage.getItem(cacheKey(pin, dateKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedReport(pin, dateKey, report) {
  try {
    window.localStorage.setItem(cacheKey(pin, dateKey), JSON.stringify({
      report,
      cached_at: new Date().toISOString(),
    }));
  } catch {}
}

const TONES = {
  neutral: { border: 'rgba(148,163,184,.25)', bg: 'rgba(15,23,42,.78)', text: '#e2e8f0' },
  info: { border: 'rgba(59,130,246,.42)', bg: 'rgba(30,64,175,.20)', text: '#bfdbfe' },
  ok: { border: 'rgba(34,197,94,.42)', bg: 'rgba(21,128,61,.18)', text: '#bbf7d0' },
  warn: { border: 'rgba(245,158,11,.48)', bg: 'rgba(146,64,14,.20)', text: '#fde68a' },
  bad: { border: 'rgba(239,68,68,.50)', bg: 'rgba(127,29,29,.25)', text: '#fecaca' },
  strong: { border: 'rgba(168,85,247,.46)', bg: 'rgba(88,28,135,.22)', text: '#e9d5ff' },
};

function MetricCard({ label, value, sub = '', tone = 'neutral' }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <div style={{ border: `1px solid ${t.border}`, background: t.bg, borderRadius: 16, padding: 12, minWidth: 0 }}>
      <div style={{ fontSize: 10, lineHeight: 1.1, fontWeight: 1000, letterSpacing: '.075em', color: t.text }}>{label}</div>
      <div style={{ marginTop: 7, fontSize: 24, lineHeight: 1, fontWeight: 1000, color: '#fff', overflowWrap: 'anywhere' }}>{value}</div>
      {sub ? <div style={{ marginTop: 7, fontSize: 11, lineHeight: 1.35, color: 'rgba(226,232,240,.72)', fontWeight: 750 }}>{sub}</div> : null}
    </div>
  );
}

function Section({ title, subtitle = '', children, tone = 'neutral' }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <section style={{ border: `1px solid ${t.border}`, background: 'rgba(8,15,28,.86)', borderRadius: 18, padding: 13, display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 1000, letterSpacing: '.045em', color: t.text }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.4, color: 'rgba(203,213,225,.68)', fontWeight: 750 }}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SmallStat({ label, value, tone = 'neutral' }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,.065)', padding: '8px 0' }}>
      <span style={{ fontSize: 11, color: 'rgba(226,232,240,.72)', fontWeight: 800 }}>{label}</span>
      <strong style={{ fontSize: 13, color: t.text, textAlign: 'right' }}>{value}</strong>
    </div>
  );
}

function DailyRows({ rows, kind = 'order', empty = 'S’KA RRESHTA.' }) {
  const list = safeRows(rows);
  if (!list.length) return <div style={{ padding: 12, textAlign: 'center', color: 'rgba(203,213,225,.58)', fontSize: 12, fontWeight: 800 }}>{empty}</div>;

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {list.map((row, index) => {
        const id = String(row?.id || `${kind}_${index}`);
        if (kind === 'ledger') {
          const isIn = upper(row?.direction) === 'IN';
          return (
            <div key={id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, border: '1px solid rgba(148,163,184,.16)', borderRadius: 12, padding: 10, background: 'rgba(15,23,42,.46)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 950, color: '#f8fafc' }}>{upper(row?.category || row?.source_type || 'LEDGER')}</div>
                <div style={{ marginTop: 3, fontSize: 10.5, lineHeight: 1.35, color: 'rgba(203,213,225,.68)', overflowWrap: 'anywhere' }}>{row?.description || '—'}</div>
                <div style={{ marginTop: 4, fontSize: 10, color: 'rgba(148,163,184,.72)' }}>{stamp(row?.at)} • #{row?.id || '—'}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 1000, color: isIn ? '#86efac' : '#fca5a5' }}>{isIn ? '+' : '-'}{euro(row?.amount)}</div>
            </div>
          );
        }

        if (kind === 'payment') {
          const status = upper(row?.status);
          const statusTone = status.includes('ACCEPTED') ? '#86efac' : status === 'PENDING' || status === 'COLLECTED' ? '#fcd34d' : '#cbd5e1';
          return (
            <div key={id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, border: '1px solid rgba(148,163,184,.16)', borderRadius: 12, padding: 10, background: 'rgba(15,23,42,.46)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 950, color: '#f8fafc' }}>{String(row?.code || '—').toUpperCase()} • {String(row?.client || 'KLIENT').toUpperCase()}</div>
                <div style={{ marginTop: 3, fontSize: 10.5, color: 'rgba(203,213,225,.72)' }}>{upper(row?.source)} • {row?.m2 > 0 ? `${m2(row.m2)} • ` : ''}{upper(row?.worker_name || row?.worker_pin)}</div>
                <div style={{ marginTop: 4, fontSize: 10, color: statusTone }}>{stamp(row?.at)} • {status || '—'}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 1000, color: '#fff' }}>{euro(row?.amount)}</div>
            </div>
          );
        }

        const isTransport = String(row?.code || '').toUpperCase().startsWith('T');
        return (
          <div key={id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, border: '1px solid rgba(148,163,184,.16)', borderRadius: 12, padding: 10, background: 'rgba(15,23,42,.46)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 950, color: '#f8fafc' }}>{isTransport ? upper(row?.code) : `#${row?.code || '—'}`} • {String(row?.client || 'KLIENT').toUpperCase()}</div>
              <div style={{ marginTop: 3, fontSize: 10.5, color: 'rgba(203,213,225,.72)' }}>{m2(row?.m2)} • {euro(row?.value)} • {upper(row?.status)}</div>
              <div style={{ marginTop: 4, fontSize: 10, color: 'rgba(148,163,184,.74)' }}>{stamp(row?.at)}{row?.worker_name || row?.worker_pin ? ` • E SOLLI: ${upper(row?.worker_name || row?.worker_pin)}` : ''}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Details({ title, count = 0, children, open = false }) {
  return (
    <details open={open} style={{ border: '1px solid rgba(148,163,184,.16)', borderRadius: 13, background: 'rgba(15,23,42,.34)', overflow: 'hidden' }}>
      <summary style={{ cursor: 'pointer', padding: 11, fontSize: 11, fontWeight: 1000, color: '#dbeafe', listStylePosition: 'inside' }}>{title} • {count}</summary>
      <div style={{ borderTop: '1px solid rgba(148,163,184,.12)', padding: 9 }}>{children}</div>
    </details>
  );
}

function AccessDenied({ actor }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05070d', color: '#fff', padding: 18 }}>
      <div style={{ width: 'min(520px,100%)', border: '1px solid rgba(239,68,68,.42)', borderRadius: 20, padding: 18, background: 'rgba(69,10,10,.38)' }}>
        <div style={{ fontSize: 12, color: '#fca5a5', fontWeight: 1000, letterSpacing: '.1em' }}>VETEM DISPATCH</div>
        <div style={{ marginTop: 8, fontSize: 24, fontWeight: 1000 }}>NUK KE QASJE</div>
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45, color: '#fecaca' }}>Kjo pamje lexon kontrollin e plote ditor te kompanise dhe hapet vetem me llogari DISPATCH. Aktori aktual: {upper(actor?.name || actor?.pin || 'PA LOGIN')}.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
          <Link to="/" style={{ textAlign: 'center', textDecoration: 'none', padding: 12, borderRadius: 12, background: '#334155', color: '#fff', fontWeight: 950 }}>HOME</Link>
          <Link to="/arka" style={{ textAlign: 'center', textDecoration: 'none', padding: 12, borderRadius: 12, background: '#2563eb', color: '#fff', fontWeight: 950 }}>ARKA</Link>
        </div>
      </div>
    </div>
  );
}

export default function ArkaDitorePage() {
  useRouteAlive('arka_ditore_page');
  const todayKey = useMemo(() => dateKeyInBelgrade(new Date()), []);
  const [actor, setActor] = useState(null);
  const [dateKey, setDateKey] = useState(todayKey);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [offlineSnapshot, setOfflineSnapshot] = useState(false);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const current = getActor() || null;
    setActor(current);
    try { bootMarkReady({ source: 'arka_ditore_page', page: 'arka_ditore', path: '/arka/ditore' }); } catch {}
  }, []);

  async function loadReport({ force = false, source = 'manual' } = {}) {
    const pin = String(actor?.pin || '').trim();
    if (!pin || !dateKey) {
      setLoading(false);
      return;
    }

    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const cached = readCachedReport(pin, dateKey);
    if (!force && cached?.report && !report) {
      setReport(cached.report);
      setOfflineSnapshot(true);
      setLoading(false);
    }

    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) {
      if (cached?.report) {
        setReport(cached.report);
        setOfflineSnapshot(true);
        setError('OFFLINE — PO SHFAQET SNAPSHOT-I I FUNDIT I KESAJ DATE.');
      } else {
        setError('OFFLINE — NUK KA SNAPSHOT TE RUAJTUR PER KETE DATE.');
      }
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (report) setRefreshing(true);
    else setLoading(true);
    setError('');

    try {
      const { data, error: rpcError } = await supabase.rpc(RPC_NAME, {
        p_actor_pin: pin,
        p_date: dateKey,
      });
      if (rpcError) throw rpcError;
      if (seq !== requestSeqRef.current) return;
      const next = safeObject(data);
      setReport(next);
      setDenied(false);
      setOfflineSnapshot(false);
      writeCachedReport(pin, dateKey, next);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      const message = String(err?.message || err?.details || err || 'NUK U NGARKUA KONTROLLI DITOR.');
      if (/DISPATCH_ONLY/i.test(message)) {
        setDenied(true);
        setReport(null);
        setError('');
      } else if (cached?.report) {
        setReport(cached.report);
        setOfflineSnapshot(true);
        setError(`LIVE NUK U NGARKUA — PO SHFAQET SNAPSHOT. ${message}`);
      } else {
        setError(message);
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!actor?.pin) return;
    const cached = readCachedReport(actor.pin, dateKey);
    if (cached?.report) {
      setReport(cached.report);
      setOfflineSnapshot(true);
      setLoading(false);
    } else {
      setReport(null);
      setLoading(true);
    }
    void loadReport({ force: true, source: 'date_change' });
  }, [actor?.pin, dateKey]);

  useEffect(() => {
    if (!actor?.pin) return undefined;
    const refreshIfVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadReport({ force: true, source: 'lifecycle' });
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshIfVisible(); };
    const onOnline = () => refreshIfVisible();
    const interval = dateKey === todayKey ? window.setInterval(refreshIfVisible, AUTO_REFRESH_MS) : null;
    try { window.addEventListener('focus', refreshIfVisible, { passive: true }); } catch {}
    try { window.addEventListener('online', onOnline, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', onVisibility, { passive: true }); } catch {}
    return () => {
      if (interval) window.clearInterval(interval);
      try { window.removeEventListener('focus', refreshIfVisible); } catch {}
      try { window.removeEventListener('online', onOnline); } catch {}
      try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
    };
  }, [actor?.pin, dateKey, todayKey]);

  if (actor && upper(actor?.role) !== 'DISPATCH' && denied) return <AccessDenied actor={actor} />;
  if (!actor && !loading) return <AccessDenied actor={actor} />;
  if (denied) return <AccessDenied actor={actor} />;

  const operations = safeObject(report?.operations);
  const incoming = safeObject(operations?.incoming);
  const outgoing = safeObject(operations?.outgoing);
  const current = safeObject(operations?.current);
  const arka = safeObject(report?.arka);
  const clientCash = safeObject(arka?.client_cash);
  const ledger = safeObject(arka?.ledger);
  const handoffs = safeObject(arka?.handoffs);
  const openCash = safeObject(arka?.open_cash);
  const pendingExpenses = safeObject(arka?.pending_expenses);
  const commissions = safeObject(report?.commissions);
  const alerts = safeRows(report?.alerts);
  const badAlerts = alerts.filter((row) => upper(row?.tone) === 'BAD').length;
  const warnAlerts = alerts.filter((row) => upper(row?.tone) === 'WARN').length;
  const controlTone = badAlerts ? 'bad' : warnAlerts ? 'warn' : 'ok';
  const controlLabel = badAlerts ? 'KA GABIME' : warnAlerts ? 'KERKON KONTROLL' : 'NE RREGULL';
  const isToday = dateKey === todayKey;

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(circle at 50% -10%, rgba(37,99,235,.18), transparent 34%), #05070d', color: '#f8fafc', padding: '12px 10px calc(26px + env(safe-area-inset-bottom,0px))', fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
      <div style={{ width: 'min(980px,100%)', margin: '0 auto', display: 'grid', gap: 12 }}>
        <header style={{ display: 'grid', gap: 10, border: '1px solid rgba(96,165,250,.28)', borderRadius: 20, padding: 14, background: 'rgba(8,15,28,.90)', boxShadow: '0 20px 60px rgba(0,0,0,.32)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: '#93c5fd', fontWeight: 1000, letterSpacing: '.12em' }}>ARKA • VETEM DISPATCH</div>
              <h1 style={{ margin: '5px 0 0', fontSize: 27, lineHeight: 1, letterSpacing: '-.02em' }}>KONTROLLI DITOR</h1>
              <div style={{ marginTop: 7, fontSize: 12, color: 'rgba(203,213,225,.74)', fontWeight: 750 }}>{formatDateLabel(dateKey)} • {isToday ? 'SOT' : dateKey}</div>
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <Link to="/arka" style={{ textDecoration: 'none', border: '1px solid rgba(148,163,184,.26)', borderRadius: 11, padding: '9px 11px', background: 'rgba(51,65,85,.58)', color: '#fff', fontSize: 11, fontWeight: 950 }}>← ARKA</Link>
              <button type="button" disabled={refreshing || loading} onClick={() => void loadReport({ force: true, source: 'manual' })} style={{ border: '1px solid rgba(59,130,246,.52)', borderRadius: 11, padding: '9px 11px', background: 'rgba(37,99,235,.28)', color: '#dbeafe', fontSize: 11, fontWeight: 950 }}>{refreshing ? 'DUKE FRESKUAR...' : 'REFRESH'}</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(140px,1fr) auto auto', gap: 7, alignItems: 'center' }}>
            <button type="button" onClick={() => setDateKey((d) => addDays(d, -1))} style={{ border: '1px solid rgba(148,163,184,.24)', borderRadius: 10, padding: '10px 9px', background: 'rgba(30,41,59,.72)', color: '#fff', fontWeight: 1000 }}>←</button>
            <input type="date" max={todayKey} value={dateKey} onChange={(e) => { if (e.target.value) setDateKey(e.target.value); }} style={{ width: '100%', minWidth: 0, border: '1px solid rgba(96,165,250,.30)', borderRadius: 10, padding: '10px 9px', background: '#0f172a', color: '#fff', fontWeight: 900, colorScheme: 'dark' }} />
            <button type="button" disabled={dateKey >= todayKey} onClick={() => setDateKey((d) => addDays(d, 1))} style={{ border: '1px solid rgba(148,163,184,.24)', borderRadius: 10, padding: '10px 9px', background: 'rgba(30,41,59,.72)', color: dateKey >= todayKey ? '#64748b' : '#fff', fontWeight: 1000 }}>→</button>
            <button type="button" disabled={isToday} onClick={() => setDateKey(todayKey)} style={{ border: '1px solid rgba(34,197,94,.35)', borderRadius: 10, padding: '10px 9px', background: 'rgba(21,128,61,.20)', color: isToday ? '#64748b' : '#bbf7d0', fontSize: 10, fontWeight: 1000 }}>SOT</button>
          </div>

          {offlineSnapshot ? <div style={{ border: '1px solid rgba(245,158,11,.38)', borderRadius: 11, padding: 9, background: 'rgba(120,53,15,.24)', color: '#fde68a', fontSize: 11, fontWeight: 850 }}>SNAPSHOT LOKAL — shifrat live do te rifreskohen sapo te kete internet.</div> : null}
          {error ? <div style={{ border: '1px solid rgba(239,68,68,.36)', borderRadius: 11, padding: 9, background: 'rgba(127,29,29,.24)', color: '#fecaca', fontSize: 11, fontWeight: 850 }}>{error}</div> : null}
        </header>

        {loading && !report ? <div style={{ border: '1px solid rgba(96,165,250,.25)', borderRadius: 18, padding: 24, textAlign: 'center', background: 'rgba(8,15,28,.80)', color: '#bfdbfe', fontWeight: 1000 }}>DUKE LLOGARITUR FAKTET E DITES...</div> : null}

        {report ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 8 }}>
              <MetricCard label="HYRJE TOTAL" value={m2(incoming?.total?.m2)} sub={`${safeNumber(incoming?.total?.count)} porosi • ${euro(incoming?.total?.value)}`} tone="info" />
              <MetricCard label="DALJE TOTAL" value={m2(outgoing?.total?.m2)} sub={`${safeNumber(outgoing?.total?.count)} porosi • ${euro(outgoing?.total?.value)}`} tone="strong" />
              <MetricCard label="NETO M²" value={m2(operations?.net_m2)} sub="Hyrje minus dalje" tone={safeNumber(operations?.net_m2) > 0 ? 'warn' : 'ok'} />
              <MetricCard label="CASH NGA KLIENTET" value={euro(clientCash?.gross)} sub={`${safeNumber(clientCash?.count)} pagesa te regjistruara`} tone="ok" />
              <MetricCard label="HYRI NE BUXHET" value={euro(ledger?.in)} sub={`Ledger IN • neto ${euro(ledger?.net)}`} tone="ok" />
              <MetricCard label="DOLI NGA BUXHETI" value={euro(ledger?.out)} sub="Ledger OUT / shpenzime" tone="bad" />
              <MetricCard label="BUXHETI AKTUAL" value={euro(ledger?.balance)} sub="Bilanci i ledger-it te kompanise" tone="strong" />
              <MetricCard label="STATUS KONTROLLI" value={controlLabel} sub={`${badAlerts} gabime • ${warnAlerts} paralajmerime`} tone={controlTone} />
            </div>

            <Section title="TEPIHAT QE HYNE" subtitle="BAZA numerohen nga porosite e finalizuara te krijuara ne kete date. TRANSPORTI numerohen vetem kur ka timestamp fizik te arritjes ne baze." tone="info">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 9 }}>
                <div style={{ border: '1px solid rgba(74,222,128,.24)', borderRadius: 14, padding: 11, background: 'rgba(22,101,52,.12)' }}>
                  <div style={{ fontSize: 12, color: '#bbf7d0', fontWeight: 1000 }}>BAZA</div>
                  <SmallStat label="Porosi" value={safeNumber(incoming?.base?.count)} />
                  <SmallStat label="Metra katror" value={m2(incoming?.base?.m2)} tone="ok" />
                  <SmallStat label="Vlera e punes" value={euro(incoming?.base?.value)} />
                </div>
                <div style={{ border: '1px solid rgba(251,191,36,.28)', borderRadius: 14, padding: 11, background: 'rgba(146,64,14,.12)' }}>
                  <div style={{ fontSize: 12, color: '#fde68a', fontWeight: 1000 }}>TRANSPORTI</div>
                  <SmallStat label="Porosi" value={safeNumber(incoming?.transport?.count)} />
                  <SmallStat label="Metra katror" value={m2(incoming?.transport?.m2)} tone="warn" />
                  <SmallStat label="Vlera e punes" value={euro(incoming?.transport?.value)} />
                </div>
              </div>
              <Details title="LISTA BAZA" count={safeNumber(incoming?.base?.count)}><DailyRows rows={incoming?.base?.rows} /></Details>
              <Details title="LISTA TRANSPORT" count={safeNumber(incoming?.transport?.count)}><DailyRows rows={incoming?.transport?.rows} /></Details>
            </Section>

            <Section title="TEPIHAT QE DOLEN" subtitle="Dalja lidhet me timestamp-in real te dorezimit/done, jo vetem me statusin aktual." tone="strong">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 9 }}>
                <div style={{ border: '1px solid rgba(96,165,250,.24)', borderRadius: 14, padding: 11, background: 'rgba(30,64,175,.12)' }}>
                  <div style={{ fontSize: 12, color: '#bfdbfe', fontWeight: 1000 }}>BAZA</div>
                  <SmallStat label="Porosi" value={safeNumber(outgoing?.base?.count)} />
                  <SmallStat label="Metra katror" value={m2(outgoing?.base?.m2)} tone="info" />
                  <SmallStat label="Vlera" value={euro(outgoing?.base?.value)} />
                </div>
                <div style={{ border: '1px solid rgba(192,132,252,.24)', borderRadius: 14, padding: 11, background: 'rgba(88,28,135,.13)' }}>
                  <div style={{ fontSize: 12, color: '#e9d5ff', fontWeight: 1000 }}>TRANSPORTI</div>
                  <SmallStat label="Porosi" value={safeNumber(outgoing?.transport?.count)} />
                  <SmallStat label="Metra katror" value={m2(outgoing?.transport?.m2)} tone="strong" />
                  <SmallStat label="Vlera" value={euro(outgoing?.transport?.value)} />
                </div>
              </div>
              <Details title="DALJET BAZA" count={safeNumber(outgoing?.base?.count)}><DailyRows rows={outgoing?.base?.rows} /></Details>
              <Details title="DALJET TRANSPORT" count={safeNumber(outgoing?.transport?.count)}><DailyRows rows={outgoing?.transport?.rows} /></Details>
            </Section>

            <Section title="ARKA E DITES" subtitle="Cash-i i klientit matet kur regjistrohet pagesa. Ledger-i mat vetem parate e pranuara ose te dala nga buxheti i kompanise." tone="ok">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 9 }}>
                <div style={{ border: '1px solid rgba(34,197,94,.24)', borderRadius: 14, padding: 11, background: 'rgba(21,128,61,.10)' }}>
                  <div style={{ fontSize: 12, color: '#bbf7d0', fontWeight: 1000 }}>PAGESAT E KLIENTEVE</div>
                  <SmallStat label="BAZA" value={euro(clientCash?.base)} />
                  <SmallStat label="TRANSPORT" value={euro(clientCash?.transport)} />
                  <SmallStat label="Pending" value={euro(clientCash?.pending)} tone="warn" />
                  <SmallStat label="Collected" value={euro(clientCash?.collected)} tone="warn" />
                  <SmallStat label="Accepted" value={euro(clientCash?.accepted)} tone="ok" />
                </div>
                <div style={{ border: '1px solid rgba(245,158,11,.24)', borderRadius: 14, padding: 11, background: 'rgba(146,64,14,.10)' }}>
                  <div style={{ fontSize: 12, color: '#fde68a', fontWeight: 1000 }}>CASH I HAPUR TASH</div>
                  <SmallStat label="Gjithsej" value={`${euro(openCash?.amount)} • ${safeNumber(openCash?.count)} rreshta`} tone="warn" />
                  <SmallStat label="Nga dite te vjetra" value={`${euro(openCash?.old_amount)} • ${safeNumber(openCash?.old_count)} rreshta`} tone={safeNumber(openCash?.old_count) ? 'bad' : 'ok'} />
                  <SmallStat label="Handoff pending" value={`${euro(handoffs?.pending_now_amount)} • ${safeNumber(handoffs?.pending_now_count)}`} tone="warn" />
                  <SmallStat label="Shpenzime pending" value={`${euro(pendingExpenses?.amount)} • ${safeNumber(pendingExpenses?.count)}`} tone={safeNumber(pendingExpenses?.count) ? 'warn' : 'ok'} />
                </div>
                <div style={{ border: '1px solid rgba(59,130,246,.24)', borderRadius: 14, padding: 11, background: 'rgba(30,64,175,.10)' }}>
                  <div style={{ fontSize: 12, color: '#bfdbfe', fontWeight: 1000 }}>HANDOFF TE DISPATCH</div>
                  <SmallStat label="U derguan ne kete date" value={`${euro(handoffs?.submitted_amount)} • ${safeNumber(handoffs?.submitted_count)}`} />
                  <SmallStat label="U pranuan ne kete date" value={`${euro(handoffs?.accepted_amount)} • ${safeNumber(handoffs?.accepted_count)}`} tone="ok" />
                  <SmallStat label="Ledger IN" value={euro(ledger?.in)} tone="ok" />
                  <SmallStat label="Ledger OUT" value={euro(ledger?.out)} tone="bad" />
                </div>
              </div>
              <Details title="PAGESAT E KLIENTEVE" count={safeNumber(clientCash?.count)}><DailyRows rows={clientCash?.rows} kind="payment" /></Details>
              <Details title="LEVIZJET E LEDGER-IT" count={safeRows(ledger?.rows).length}><DailyRows rows={ledger?.rows} kind="ledger" /></Details>
            </Section>

            <Section title="KOMISIONET E TRANSPORTIT" subtitle="Llogariten nga m² qe transportuesi i ka sjelle fizikisht ne baze ne daten e zgjedhur × norma e tij ne USERS." tone="warn">
              <MetricCard label="KOMISION TOTAL" value={euro(commissions?.total)} sub={`${safeRows(commissions?.workers).length} transportues`} tone="warn" />
              <div style={{ display: 'grid', gap: 8 }}>
                {safeRows(commissions?.workers).length ? safeRows(commissions?.workers).map((worker) => (
                  <div key={String(worker?.pin || worker?.name)} style={{ border: '1px solid rgba(245,158,11,.20)', borderRadius: 13, padding: 11, background: 'rgba(120,53,15,.12)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 1000 }}>{upper(worker?.name || worker?.pin)}</div>
                        <div style={{ marginTop: 3, fontSize: 10.5, color: 'rgba(203,213,225,.68)' }}>PIN {worker?.pin || '—'} • {safeNumber(worker?.orders)} porosi • {m2(worker?.m2)} • {euro(worker?.rate)}/m²</div>
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 1000, color: '#fde68a' }}>{euro(worker?.commission)}</div>
                    </div>
                  </div>
                )) : <div style={{ textAlign: 'center', color: 'rgba(203,213,225,.58)', fontSize: 12, fontWeight: 800 }}>S’KA HYRJE TRANSPORTI ME KOMISION.</div>}
              </div>
            </Section>

            <Section title="GJENDJA AKTUALE E DEPOSE" subtitle="Keto jane totalet live tani, jo vetem per daten e zgjedhur." tone="neutral">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 9 }}>
                <MetricCard label="NE PASTRIM" value={m2(current?.pastrim?.m2)} sub={`${safeNumber(current?.pastrim?.count)} porosi`} tone="info" />
                <MetricCard label="GATI" value={m2(current?.gati?.m2)} sub={`${safeNumber(current?.gati?.count)} porosi`} tone="ok" />
              </div>
            </Section>

            <Section title="KONTROLLI AUTOMATIK / ALARMET" subtitle="Çdo alarm del nga DB-ja. Rreshtat pa m², pa transportues, draftet, duplicate pagesat dhe handoff-et qe nuk perputhen shfaqen ketu." tone={controlTone}>
              {alerts.length ? alerts.map((alert, index) => {
                const tone = upper(alert?.tone) === 'BAD' ? 'bad' : upper(alert?.tone) === 'WARN' ? 'warn' : 'neutral';
                const t = TONES[tone];
                return (
                  <div key={`${alert?.code || 'alert'}_${index}`} style={{ border: `1px solid ${t.border}`, borderRadius: 13, padding: 11, background: t.bg }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 1000, color: t.text }}>{upper(alert?.label || alert?.code)}</div>
                      <div style={{ fontSize: 12, fontWeight: 1000, color: t.text }}>{safeNumber(alert?.count)}</div>
                    </div>
                    {alert?.detail && Object.keys(safeObject(alert.detail)).length ? <pre style={{ margin: '7px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'rgba(226,232,240,.72)', fontSize: 10, lineHeight: 1.35 }}>{JSON.stringify(alert.detail, null, 2)}</pre> : null}
                  </div>
                );
              }) : <div style={{ border: '1px solid rgba(34,197,94,.34)', borderRadius: 13, padding: 14, textAlign: 'center', background: 'rgba(21,128,61,.15)', color: '#bbf7d0', fontWeight: 1000 }}>NUK U GJET ASNJE PROBLEM PER KETE DATE.</div>}
            </Section>

            <div style={{ border: '1px solid rgba(148,163,184,.16)', borderRadius: 14, padding: 11, background: 'rgba(15,23,42,.40)', color: 'rgba(203,213,225,.62)', fontSize: 10.5, lineHeight: 1.45 }}>
              Gjeneruar: {stamp(report?.generated_at)} • Versioni: {report?.version || '—'} • Auto-refresh çdo 60 sekonda kur shfaqet dita e sotme. Kjo faqe eshte vetem lexim dhe nuk ndryshon porosi, pagesa ose ledger.
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
