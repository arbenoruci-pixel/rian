'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import {
  canonicalBonusUserId,
  isBujarBonusViewer,
  readyBonusCacheKeyForUserId,
  resolveReadyBonusViewerUserId,
} from '@/lib/readyBonusAttentionIdentity';
import { supabase } from '@/lib/supabaseClient';

function text(v) { try { return String(v ?? '').trim(); } catch { return ''; } }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtClock(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return '—';
  try { return new Intl.DateTimeFormat('sq-AL', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); }
  catch { return '—'; }
}
function fmtDuration(hours) {
  const totalMin = Math.max(0, Math.ceil(num(hours) * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function readCache(userId) {
  const cacheKey = readyBonusCacheKeyForUserId(userId);
  if (!cacheKey) return null;
  try { const raw = localStorage.getItem(cacheKey); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(userId, value) {
  const cacheKey = readyBonusCacheKeyForUserId(userId);
  if (!cacheKey) return;
  try { localStorage.setItem(cacheKey, JSON.stringify(value)); } catch {}
}

export default function ReadyBonusAttention({ compact = false, actor = null }) {
  const [payload, setPayload] = useState(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [viewerUserId, setViewerUserId] = useState('');
  const [loadedIdentityKey, setLoadedIdentityKey] = useState('');
  const sessionActor = actor || getActor();
  const actorPin = text(sessionActor?.pin);
  const actorUserId = canonicalBonusUserId(sessionActor?.user_id || sessionActor?.id);
  const actorIdentityKey = actorPin ? `${actorUserId || 'no-user-id'}:${actorPin}` : '';

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    setPayload(null);
    setOffline(false);
    setOpen(false);
    setViewerUserId('');
    setLoadedIdentityKey('');

    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!actorPin) return;
        const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
        if (online) {
          const { data, error } = await supabase.rpc('get_base_bonus_opportunities_v1', { p_actor_pin: actorPin });
          if (error) throw error;
          const next = data && typeof data === 'object' ? data : { rows: [], config: {} };
          const canonicalViewerUserId = resolveReadyBonusViewerUserId(next, sessionActor);
          writeCache(canonicalViewerUserId, { saved_at: new Date().toISOString(), payload: next });
          if (!cancelled) {
            setViewerUserId(canonicalViewerUserId);
            setPayload(next);
            setOffline(false);
            setLoadedIdentityKey(actorIdentityKey);
          }
        } else {
          const cached = readCache(actorUserId);
          if (!cancelled) {
            setViewerUserId(resolveReadyBonusViewerUserId(cached?.payload, sessionActor));
            setPayload(cached?.payload || null);
            setOffline(true);
            setLoadedIdentityKey(actorIdentityKey);
          }
        }
      } catch {
        const cached = readCache(actorUserId);
        if (!cancelled) {
          setViewerUserId(resolveReadyBonusViewerUserId(cached?.payload, sessionActor));
          setPayload(cached?.payload || null);
          setOffline(true);
          setLoadedIdentityKey(actorIdentityKey);
        }
      } finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('arka:refresh', refresh);
    window.addEventListener('base-ready-bonus:refresh', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('arka:refresh', refresh);
      window.removeEventListener('base-ready-bonus:refresh', refresh);
    };
  }, [actorIdentityKey, actorPin, actorUserId]);

  const scopedPayload = loadedIdentityKey === actorIdentityKey ? payload : null;
  const scopedViewerUserId = loadedIdentityKey === actorIdentityKey ? viewerUserId : '';
  const config = scopedPayload?.config || {};
  const windowHours = Math.max(1, num(config?.window_hours) || 72);
  const rate = num(config?.rate_m2) || 0.10;
  const items = useMemo(() => (Array.isArray(scopedPayload?.rows) ? scopedPayload.rows : []).map((row) => ({
    id: row?.order_id,
    code: row?.order_code || '—',
    name: text(row?.client_name || 'KLIENT'),
    m2: num(row?.m2),
    bonus: num(row?.potential_bonus),
    hoursLeft: num(row?.hours_left),
    deadlineAt: row?.deadline_at || null,
    status: text(row?.status).toUpperCase(),
    readyAt: row?.ready_at || null,
  })).sort((a, b) => a.hoursLeft - b.hoursLeft), [scopedPayload]);

  const urgent = items.filter((item) => item.hoursLeft <= 12);
  const possibleMoney = items.reduce((sum, item) => sum + item.bonus, 0);
  const count = urgent.length;
  const isBujar = isBujarBonusViewer(scopedViewerUserId);

  if (!items.length) return null;

  return (
    <div data-ready-bonus-attention="2" style={{ marginTop: compact ? 8 : 12 }}>
      {isBujar && !offline ? (
        <div data-bujar-bonus-motivation="1" style={{marginBottom:8,padding:'10px 12px',borderRadius:13,border:'1px solid rgba(74,222,128,.38)',background:'linear-gradient(135deg,rgba(20,83,45,.48),rgba(15,23,42,.94))',color:'#dcfce7',fontSize:12,lineHeight:1.4,fontWeight:900}}>
          💪 BUJAR, SOT I KI {items.length} MUNDËSI. NËSE E SHTYN FORT, MUNDESH ME I KAP DERI +{possibleMoney.toFixed(2)}€ BONUS.
        </div>
      ) : null}
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ width:'100%', borderRadius:14, border:`1px solid ${count ? 'rgba(248,113,113,.55)' : 'rgba(250,204,21,.35)'}`, background:count ? 'linear-gradient(135deg,rgba(127,29,29,.72),rgba(15,23,42,.95))' : 'linear-gradient(135deg,rgba(113,63,18,.42),rgba(15,23,42,.95))', color:'#fff', padding:'11px 12px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, textAlign:'left' }}>
        <div>
          <div style={{fontSize:10,fontWeight:1000,letterSpacing:'.12em',color:count?'#fecaca':'#fde68a'}}>⚠️ ATTENTION • BONUSI {windowHours}H</div>
          <div style={{fontSize:16,fontWeight:1000,marginTop:3}}>{count ? `${count} POROSI PO SKADOJNË` : `${items.length} MUNDËSI BONUSI`}</div>
          <div style={{fontSize:10,fontWeight:800,color:'#cbd5e1',marginTop:3}}>Mundësi: {possibleMoney.toFixed(2)}€ • {rate.toFixed(2)}€/m² • prek për listën</div>
        </div>
        <div style={{minWidth:38,height:38,borderRadius:12,display:'grid',placeItems:'center',background:count?'#dc2626':'#ca8a04',fontWeight:1000,fontSize:17}}>{count || items.length}</div>
      </button>

      {open ? <div style={{marginTop:8,display:'grid',gap:7}}>
        {offline ? <div style={{fontSize:9,fontWeight:900,color:'#fde68a'}}>OFFLINE • SNAPSHOT I FUNDIT</div> : null}
        {items.slice(0, compact ? 8 : 15).map((item) => {
          const urgency = item.hoursLeft <= 3 ? 'critical' : item.hoursLeft <= 6 ? 'urgent' : item.hoursLeft <= 12 ? 'today' : 'normal';
          const label = urgency === 'critical' ? 'KRITIKE' : urgency === 'urgent' ? 'URGJENTE' : urgency === 'today' ? 'SKADON SOT' : 'KAP BONUSIN';
          const accent = urgency === 'critical' ? '#ef4444' : urgency === 'urgent' ? '#f97316' : '#eab308';
          return <Link key={item.id} href={`/pastrimi?open=${encodeURIComponent(item.id || '')}`} style={{textDecoration:'none',color:'#fff',border:`1px solid ${accent}55`,borderLeft:`5px solid ${accent}`,borderRadius:12,padding:'10px 11px',background:'rgba(2,6,23,.78)',display:'grid',gap:5}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:8}}><b>#{item.code} • {item.name.toUpperCase()}</b><b style={{color:accent}}>{label}</b></div>
            <div style={{display:'flex',justifyContent:'space-between',gap:8,fontSize:11,color:'#cbd5e1',fontWeight:850}}><span>{item.m2.toFixed(1)} m² • +{item.bonus.toFixed(2)}€ • {item.status}</span><span>{fmtDuration(item.hoursLeft)} • deri {fmtClock(item.deadlineAt)}</span></div>
          </Link>;
        })}
      </div> : null}
    </div>
  );
}

// READY_BONUS_ATTENTION_V2 — server/RPC is the single source of truth for window and opportunities.
