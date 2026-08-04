'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';

const RATE = 0.10;
const WINDOW_MS = 48 * 60 * 60 * 1000;
const CACHE_KEY = 'tepiha_ready_bonus_attention_v1';
const ACTIVE = new Set(['PRANIM', 'PASTRIM', 'LOADED', 'GATI']);

function text(v) { try { return String(v ?? '').trim(); } catch { return ''; } }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function upper(v) { return text(v).toUpperCase(); }
function firstDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}
function totalM2(row = {}) {
  const d = row?.data || {};
  const candidates = [row?.m2_total, row?.total_m2, row?.m2, d?.m2_total, d?.total_m2, d?.m2, d?.totals?.m2_total];
  for (const value of candidates) { const n = num(value); if (n > 0) return n; }
  const pieces = Array.isArray(d?.pieces) ? d.pieces : Array.isArray(d?.items) ? d.items : [];
  return pieces.reduce((sum, item) => sum + num(item?.m2 || item?.area || item?.total_m2), 0);
}
function entryMs(row = {}) {
  const d = row?.data || {};
  return firstDate(d?.at_base_at, d?.base_arrived_at, d?.brought_to_base_at, d?.unloaded_at, d?.pastrim_at, d?.accepted_at, row?.created_at);
}
function readyMs(row = {}) {
  const d = row?.data || {};
  return firstDate(d?.ready_at, d?.gati_at, d?.packed_at, row?.ready_at, upper(row?.status) === 'GATI' ? row?.updated_at : null);
}
function fmtClock(ms) {
  try { return new Intl.DateTimeFormat('sq-AL', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); }
  catch { return '—'; }
}
function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function readCache() {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(value) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch {} }

export default function ReadyBonusAttention({ compact = false }) {
  const [rows, setRows] = useState([]);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
        if (online) {
          const { data, error } = await supabase
            .from('orders')
            .select('id,local_oid,code,client_name,status,data,created_at,updated_at,m2,total_m2,m2_total,ready_at')
            .in('status', ['pranim', 'pastrim', 'loaded', 'gati'])
            .order('created_at', { ascending: true })
            .limit(250);
          if (error) throw error;
          const payload = { saved_at: new Date().toISOString(), rows: Array.isArray(data) ? data : [] };
          writeCache(payload);
          if (!cancelled) { setRows(payload.rows); setOffline(false); }
        } else {
          const cached = readCache();
          if (!cancelled) { setRows(Array.isArray(cached?.rows) ? cached.rows : []); setOffline(true); }
        }
      } catch {
        const cached = readCache();
        if (!cancelled) { setRows(Array.isArray(cached?.rows) ? cached.rows : []); setOffline(true); }
      } finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, []);

  const items = useMemo(() => {
    const now = Date.now();
    return rows.map((row) => {
      const status = upper(row?.status);
      if (!ACTIVE.has(status)) return null;
      const start = entryMs(row);
      if (!start) return null;
      const deadline = start + WINDOW_MS;
      const ready = readyMs(row);
      const m2 = totalM2(row);
      const secured = ready > 0 && ready <= deadline;
      const left = deadline - now;
      if (!secured && left <= 0) return null;
      const urgency = secured ? 'secured' : left <= 3 * 3600000 ? 'critical' : left <= 6 * 3600000 ? 'urgent' : left <= 12 * 3600000 ? 'today' : 'normal';
      return {
        id: row?.id || row?.local_oid,
        code: row?.code || '—',
        name: text(row?.client_name || row?.data?.client_name || 'KLIENT'),
        m2,
        bonus: Number((m2 * RATE).toFixed(2)),
        deadline,
        left,
        secured,
        urgency,
      };
    }).filter(Boolean).sort((a, b) => {
      if (a.secured !== b.secured) return a.secured ? 1 : -1;
      return a.deadline - b.deadline;
    }).slice(0, 30);
  }, [rows]);

  const urgent = items.filter((item) => !item.secured && item.left <= 12 * 3600000);
  const possible = items.filter((item) => !item.secured);
  const possibleMoney = possible.reduce((sum, item) => sum + item.bonus, 0);
  const count = urgent.length;

  if (!items.length) return null;

  return (
    <div data-ready-bonus-attention="1" style={{ marginTop: compact ? 8 : 12 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ width:'100%', borderRadius:14, border:`1px solid ${count ? 'rgba(248,113,113,.55)' : 'rgba(250,204,21,.35)'}`, background:count ? 'linear-gradient(135deg,rgba(127,29,29,.72),rgba(15,23,42,.95))' : 'linear-gradient(135deg,rgba(113,63,18,.42),rgba(15,23,42,.95))', color:'#fff', padding:'11px 12px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, textAlign:'left' }}>
        <div>
          <div style={{fontSize:10,fontWeight:1000,letterSpacing:'.12em',color:count?'#fecaca':'#fde68a'}}>⚠️ ATTENTION • BONUSI 48H</div>
          <div style={{fontSize:16,fontWeight:1000,marginTop:3}}>{count ? `${count} POROSI PO SKADOJNË` : `${possible.length} MUNDËSI BONUSI`}</div>
          <div style={{fontSize:10,fontWeight:800,color:'#cbd5e1',marginTop:3}}>Mundësi: {possibleMoney.toFixed(2)}€ • prek për listën</div>
        </div>
        <div style={{minWidth:38,height:38,borderRadius:12,display:'grid',placeItems:'center',background:count?'#dc2626':'#ca8a04',fontWeight:1000,fontSize:17}}>{count || possible.length}</div>
      </button>

      {open ? <div style={{marginTop:8,display:'grid',gap:7}}>
        {offline ? <div style={{fontSize:9,fontWeight:900,color:'#fde68a'}}>OFFLINE • SNAPSHOT I FUNDIT</div> : null}
        {items.slice(0, compact ? 8 : 15).map((item) => {
          const label = item.secured ? 'BONUSI U SIGURUA' : item.urgency === 'critical' ? 'KRITIKE' : item.urgency === 'urgent' ? 'URGJENTE' : item.urgency === 'today' ? 'SKADON SOT' : 'KAP BONUSIN';
          const accent = item.secured ? '#22c55e' : item.urgency === 'critical' ? '#ef4444' : item.urgency === 'urgent' ? '#f97316' : '#eab308';
          return <Link key={item.id} href={`/pastrimi?open=${encodeURIComponent(item.id || '')}`} style={{textDecoration:'none',color:'#fff',border:`1px solid ${accent}55`,borderLeft:`5px solid ${accent}`,borderRadius:12,padding:'10px 11px',background:'rgba(2,6,23,.78)',display:'grid',gap:5}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:8}}><b>#{item.code} • {item.name.toUpperCase()}</b><b style={{color:accent}}>{label}</b></div>
            <div style={{display:'flex',justifyContent:'space-between',gap:8,fontSize:11,color:'#cbd5e1',fontWeight:850}}><span>{item.m2.toFixed(1)} m² • +{item.bonus.toFixed(2)}€</span><span>{item.secured ? `GATI para ${fmtClock(item.deadline)}` : `${fmtDuration(item.left)} • deri ${fmtClock(item.deadline)}`}</span></div>
          </Link>;
        })}
      </div> : null}
    </div>
  );
}
