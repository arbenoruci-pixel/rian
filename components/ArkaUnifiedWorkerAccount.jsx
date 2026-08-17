'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';

const TIME_ZONE = 'Europe/Belgrade';
const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MANAGER_ROLES = new Set(['ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER']);

function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function euro(value) {
  return `€${MONEY.format(n(value))}`;
}
function upper(value) {
  return String(value || '').trim().toUpperCase();
}
function rows(value) {
  return Array.isArray(value) ? value : [];
}
function dayKey(value = new Date()) {
  try {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0,10);
  }
}
function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

const c = {
  page: '#05070d', panel: 'rgba(8,15,28,.94)', soft: 'rgba(15,23,42,.68)',
  line: 'rgba(148,163,184,.20)', text: '#f8fafc', muted: '#94a3b8',
  green: '#86efac', blue: '#93c5fd', yellow: '#fde68a', red: '#fca5a5', purple: '#d8b4fe',
};

function Card({ children, tone = '', style = {} }) {
  const border = tone === 'green' ? 'rgba(34,197,94,.42)'
    : tone === 'blue' ? 'rgba(59,130,246,.42)'
      : tone === 'yellow' ? 'rgba(245,158,11,.42)'
        : tone === 'red' ? 'rgba(239,68,68,.42)'
          : c.line;
  return <section style={{ border:`1px solid ${border}`, borderRadius:18, padding:14, background:c.panel, display:'grid', gap:11, boxShadow:'0 18px 45px rgba(0,0,0,.20)', ...style }}>{children}</section>;
}

function Metric({ label, value, sub = '', tone = '' }) {
  const color = tone === 'green' ? c.green : tone === 'blue' ? c.blue : tone === 'yellow' ? c.yellow : tone === 'red' ? c.red : tone === 'purple' ? c.purple : '#e2e8f0';
  return (
    <div style={{ border:`1px solid ${c.line}`, borderRadius:14, padding:11, background:c.soft, minWidth:0 }}>
      <div style={{ fontSize:10, fontWeight:1000, letterSpacing:'.08em', color }}>{label}</div>
      <div style={{ marginTop:7, fontSize:23, lineHeight:1, fontWeight:1000, color:'#fff', overflowWrap:'anywhere' }}>{value}</div>
      {sub ? <div style={{ marginTop:6, color:c.muted, fontSize:10.5, lineHeight:1.35, fontWeight:750 }}>{sub}</div> : null}
    </div>
  );
}

function ProfilePill({ children, enabled = true }) {
  return <span style={{ border:`1px solid ${enabled ? 'rgba(34,197,94,.36)' : c.line}`, borderRadius:999, padding:'6px 9px', background:enabled ? 'rgba(21,128,61,.18)' : 'rgba(51,65,85,.48)', color:enabled ? c.green : c.muted, fontSize:9.5, fontWeight:1000, letterSpacing:'.04em' }}>{children}</span>;
}

function PaymentRow({ row, showCommission }) {
  return (
    <div style={{ border:`1px solid ${c.line}`, borderRadius:14, padding:11, background:'rgba(2,6,23,.54)', display:'grid', gap:8 }}>
      <div style={{ display:'grid', gridTemplateColumns:'auto minmax(0,1fr) auto', gap:9, alignItems:'start' }}>
        <span style={{ border:'1px solid rgba(59,130,246,.46)', background:'rgba(30,64,175,.22)', color:'#dbeafe', borderRadius:999, padding:'5px 8px', fontSize:10.5, fontWeight:1000 }}>{upper(row?.code || '—')}</span>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:12.5, fontWeight:1000, color:'#fff', lineHeight:1.25, overflowWrap:'anywhere' }}>{upper(row?.client_name || 'KLIENT')}</div>
          <div style={{ marginTop:4, fontSize:10, color:c.muted, fontWeight:750 }}>{stamp(row?.created_at)} • {upper(row?.status || 'OPEN')}</div>
        </div>
        <strong style={{ fontSize:15, whiteSpace:'nowrap', color:c.green }}>{euro(row?.due_to_base)}</strong>
      </div>
      {showCommission ? (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,minmax(0,1fr))', gap:6 }}>
          <div style={{ fontSize:9.5, color:c.muted }}>KLIENTI <b style={{ color:'#fff' }}>{euro(row?.amount)}</b></div>
          <div style={{ fontSize:9.5, color:c.muted }}>KOMISION <b style={{ color:c.yellow }}>{euro(row?.commission)}</b></div>
          <div style={{ fontSize:9.5, color:c.muted }}>PËR BAZË <b style={{ color:c.green }}>{euro(row?.due_to_base)}</b></div>
        </div>
      ) : null}
    </div>
  );
}

export default function ArkaUnifiedWorkerAccount({ actor, targetPin, title = '', showManagerLinks = true, onSnapshot = null }) {
  // UNIFIED_WORKER_FINANCE_UI_V1
  const actorPin = String(actor?.pin || '').trim();
  const cleanTargetPin = String(targetPin || actorPin || '').trim();
  const actorRole = upper(actor?.role);
  const manager = MANAGER_ROLES.has(actorRole);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const seqRef = useRef(0);

  async function load({ silent = false } = {}) {
    if (!actorPin || !cleanTargetPin) return;
    const seq = ++seqRef.current;
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('get_worker_finance_snapshot_v1', {
        p_actor_pin: actorPin,
        p_worker_pin: cleanTargetPin,
        p_date: dayKey(new Date()),
      });
      if (rpcError) throw rpcError;
      if (seq !== seqRef.current) return;
      setSnapshot(data || null);
      try { onSnapshot?.(data || null); } catch {}
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(String(err?.message || err?.details || err || 'NUK U NGARKUA LLOGARIA E PUNTORIT.'));
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!actorPin || !cleanTargetPin) return undefined;
    let timer = null;
    const refresh = () => void load({ silent:true });
    const onVisible = () => { if (document.visibilityState !== 'hidden') refresh(); };
    void load();
    timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('arka:refresh', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('arka:refresh', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [actorPin, cleanTargetPin]);

  const profile = snapshot?.profile || {};
  const cash = snapshot?.cash || {};
  const expenses = snapshot?.expenses || {};
  const payroll = snapshot?.payroll || {};
  const advances = snapshot?.advances || {};
  const fixedFullCash = upper(profile?.cash_mode) === 'FULL_CASH' && profile?.commission_enabled !== true;
  const showCommission = profile?.commission_enabled === true && upper(profile?.cash_mode) === 'HYBRID_COMMISSION';
  const openRows = useMemo(() => rows(cash?.rows), [cash?.rows]);

  if (loading && !snapshot) {
    return <Card tone="blue"><div style={{ padding:18, textAlign:'center', color:c.blue, fontWeight:1000 }}>DUKE NGARKUAR TË NJËJTËN LLOGARI NGA DB...</div></Card>;
  }

  return (
    <div data-unified-worker-finance="1" style={{ display:'grid', gap:12 }}>
      <Card tone="blue">
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:10, flexWrap:'wrap' }}>
          <div>
            <div style={{ color:c.blue, fontSize:10.5, fontWeight:1000, letterSpacing:'.12em' }}>ARKA • NJË BURIM I VETËM</div>
            <div style={{ marginTop:5, fontSize:26, lineHeight:1, fontWeight:1000 }}>{upper(title || snapshot?.worker?.name || cleanTargetPin)}</div>
            <div style={{ marginTop:7, color:c.muted, fontSize:11.5, fontWeight:800 }}>PIN {snapshot?.worker?.pin || cleanTargetPin} • {upper(snapshot?.worker?.role || 'WORKER')} • {dayKey(new Date())}</div>
          </div>
          <button type="button" disabled={refreshing} onClick={() => void load({ silent:true })} style={{ border:`1px solid ${c.line}`, borderRadius:12, background:'rgba(51,65,85,.64)', color:'#fff', padding:'10px 12px', fontWeight:1000, cursor:'pointer' }}>{refreshing ? 'DUKE FRESKUAR...' : 'REFRESH'}</button>
        </div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          <ProfilePill enabled={profile?.salary_enabled === true}>RROGË {profile?.salary_enabled ? euro(profile?.salary_amount) : 'JO'}</ProfilePill>
          <ProfilePill enabled={profile?.meal_enabled === true}>USHQIM {profile?.meal_enabled ? euro(profile?.meal_amount) : 'JO'}</ProfilePill>
          <ProfilePill enabled={profile?.transport_bonus_enabled === true}>BONUS TRANSPORT {profile?.transport_bonus_enabled ? euro(profile?.transport_bonus_amount) : 'JO'}</ProfilePill>
          <ProfilePill enabled={profile?.commission_enabled === true}>KOMISION {profile?.commission_enabled ? `${n(profile?.commission_rate_m2).toFixed(2)}€/m²` : 'JO'}</ProfilePill>
          <ProfilePill enabled={profile?.ready_bonus_enabled === true}>BONUS BAZE {profile?.ready_bonus_enabled ? 'PO' : 'JO'}</ProfilePill>
          <ProfilePill enabled={fixedFullCash}>CASH: {upper(profile?.cash_mode || 'FULL_CASH')}</ProfilePill>
        </div>
        {profile?.notes ? <div style={{ border:`1px solid ${c.line}`, borderRadius:12, background:'rgba(2,6,23,.48)', color:'#cbd5e1', padding:9, fontSize:10.5, lineHeight:1.4, fontWeight:800 }}>{profile.notes}</div> : null}
        {error ? <div style={{ border:'1px solid rgba(239,68,68,.45)', borderRadius:12, background:'rgba(127,29,29,.25)', color:c.red, padding:10, fontSize:11, fontWeight:900 }}>{error}</div> : null}
      </Card>

      <Card tone="green">
        <div style={{ fontSize:10.5, color:c.green, fontWeight:1000, letterSpacing:'.11em' }}>PYETJA KRYESORE</div>
        <div style={{ fontSize:16, fontWeight:1000 }}>DORËZO TASH</div>
        <div style={{ fontSize:44, lineHeight:1, fontWeight:1000, color:'#dcfce7' }}>{euro(cash?.open_due_to_base)}</div>
        <div style={{ color:c.muted, fontSize:11, fontWeight:800 }}>
          {fixedFullCash ? 'KREJT CASH-I I KLIENTËVE DORËZOHET NË BAZË.' : showCommission ? 'CASH BRUTO − KOMISIONI I DEFINUAR = PËR BAZË.' : 'TOTALI I HAPUR PËR DORËZIM.'}
        </div>
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))', gap:8 }}>
        <Metric label="PAGUAR SOT" value={euro(cash?.today_gross)} sub={`${n(cash?.today_count)} pagesa`} tone="green" />
        <Metric label="MBETUR NGA MË HERËT" value={euro(cash?.carryover_gross)} sub={`${n(cash?.carryover_count)} pagesa`} tone="blue" />
        {showCommission ? <Metric label="KOMISION I HAPUR" value={euro(cash?.open_commission)} sub={`${n(profile?.commission_rate_m2).toFixed(2)}€/m²`} tone="yellow" /> : null}
        <Metric label="SHPENZIME SOT" value={euro(expenses?.today_total)} sub={`Në pritje ${euro(expenses?.today_pending)}`} tone="yellow" />
        <Metric label="TE DISPATCH" value={euro(cash?.pending_handoff_total)} sub={`${n(cash?.pending_handoff_count)} dorëzime`} tone="purple" />
        <Metric label="DORËZUAR SOT" value={euro(cash?.accepted_handoff_today)} sub="Pranuar nga Dispatch" tone="green" />
      </div>

      <Card tone="green">
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <div>
            <div style={{ fontSize:14, fontWeight:1000 }}>KLIENTËT ME CASH TË HAPUR</div>
            <div style={{ marginTop:4, color:c.muted, fontSize:10.5, fontWeight:800 }}>{openRows.length} pagesa • i njëjti listim për punëtorin dhe adminin</div>
          </div>
          <strong style={{ color:c.green, fontSize:17 }}>{euro(cash?.open_due_to_base)}</strong>
        </div>
        <div style={{ display:'grid', gap:8 }}>
          {openRows.length ? openRows.map((row) => <PaymentRow key={`unified_cash_${row?.id}`} row={row} showCommission={showCommission} />) : <div style={{ color:c.muted, fontSize:11, padding:8 }}>S’KA PAGESA TË HAPURA.</div>}
        </div>
      </Card>

      <Card tone="blue">
        <div style={{ fontSize:14, fontWeight:1000 }}>PAYROLL I LIDHUR ME STAFIN</div>
        <div style={{ color:c.muted, fontSize:10.5, fontWeight:800 }}>Këto shifra lexohen nga të njëjtat opsione që caktohen te STAFI / PAYROLL.</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(135px,1fr))', gap:8 }}>
          <Metric label="RROGA" value={euro(payroll?.salary)} tone="blue" />
          <Metric label="USHQIM / BONUS" value={euro(payroll?.meal_bonus)} tone="green" />
          <Metric label="BONUS TRANSPORT" value={euro(payroll?.transport_bonus)} tone="green" />
          {showCommission ? <Metric label="KOMISION I MBAJTUR KËTË MUAJ" value={euro(payroll?.commission_retained_month)} tone="yellow" /> : null}
          <Metric label="AVANSE AKTIVE" value={euro(advances?.active_total)} tone="red" />
          <Metric label="NETO FIKSE PAS AVANSEVE" value={euro(payroll?.net_fixed_after_advances)} tone="purple" />
        </div>
      </Card>

      {manager && showManagerLinks ? (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:8 }}>
          <Link to="/arka/ditore" style={linkStyle}>MBYLLJA DITORE</Link>
          <Link to="/arka/payroll" style={linkStyle}>PAYROLL</Link>
          <Link to="/arka/stafi" style={linkStyle}>DEFINO STAFIN</Link>
          <Link to="/arka" style={linkStyle}>ADMIN ARKA</Link>
        </div>
      ) : null}
    </div>
  );
}

const linkStyle = {
  border:'1px solid rgba(59,130,246,.40)', borderRadius:13, background:'rgba(30,64,175,.20)', color:'#dbeafe',
  padding:'12px 13px', textDecoration:'none', textAlign:'center', fontSize:11, fontWeight:1000,
};
