'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';
import TransportEditModal from '@/components/transport/TransportEditModal';

function safeJson(v){
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
}

function normalizeTCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '0';
    return `T${n}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n ? `T${n}` : '';
}

function computePieces(order){
  const t = Array.isArray(order?.tepiha) ? order.tepiha.reduce((a,r)=>a+(Number(r?.qty)||0),0) : 0;
  const s = Array.isArray(order?.staza) ? order.staza.reduce((a,r)=>a+(Number(r?.qty)||0),0) : 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
}

function computeM2(order){
  const t = Array.isArray(order?.tepiha) ? order.tepiha.reduce((a,r)=>a+(Number(r?.m2)||0)*(Number(r?.qty)||0),0) : 0;
  const s = Array.isArray(order?.staza) ? order.staza.reduce((a,r)=>a+(Number(r?.m2)||0)*(Number(r?.qty)||0),0) : 0;
  const sh = (Number(order?.shkallore?.qty)||0) * (Number(order?.shkallore?.per)||0);
  return Number((t+s+sh).toFixed(2));
}

function missingFlags(order){
  const name = String(order?.client?.name || '').trim();
  const phone = String(order?.client?.phone || '').replace(/\s+/g,'').trim();
  const m2 = computeM2(order);
  const pieces = computePieces(order);
  const total = Number(order?.pay?.euro || 0);

  const miss = [];
  if (!name) miss.push('EMËR');
  if (!phone || phone.replace(/\D+/g,'').length < 6) miss.push('TEL');
  if (pieces <= 0) miss.push('COPË');
  if (m2 <= 0) miss.push('m²');
  if (total <= 0) miss.push('€');
  return miss;
}

export default function TransportOffloadPage(){
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({}); // id -> true

  const [editOpen, setEditOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const transportId = String(me?.transport_id || '').trim();

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) { router.push('/transport'); return; }
    setMe(s);
  }, [router]);

  async function load(){
    if (!transportId) return;
    setBusy(true); setErr('');
    try{
      // DB FIX REQUIRED:
      // Ensure table public.transport_orders has a real column `transport_id` (generated from JSONB data)
      // so RLS/policies and filtering do not reference a missing column.
      const { data, error } = await supabase
        .from('transport_orders')
        .select('id,status,created_at,code_str,code_n,data')
        .eq('transport_id', transportId)
        .in('status', ['teren','transport_incomplete','pickup','loaded','transport_pickup'])
        .order('created_at', { ascending:false })
        .limit(500);
      if (error) throw error;

      const list = (data||[]).map(r => {
        const d = safeJson(r.data);
        const code = normalizeTCode(r.code_str || r.code_n || d?.client?.code || '');
        return {
          id: r.id,
          code,
          created_at: r.created_at,
          status: r.status,
          order: d || {},
          transport_id: transportId,
        };
      });

      setItems(list);
      setSel(prev => {
        const keep = {};
        const ids = new Set(list.map(x=>x.id));
        for (const k of Object.keys(prev||{})) if (ids.has(k) && prev[k]) keep[k]=true;
        return keep;
      });
    }catch(e){
      setErr(String(e?.message || e || 'Gabim'));
      setItems([]);
      setSel({});
    }finally{
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [transportId]);

  const view = useMemo(() => {
    return items.map(it => {
      const o = it.order || {};
      const name = String(o?.client?.name || '').trim() || '(PA EMËR)';
      const phone = String(o?.client?.phone || '').trim() || '';
      const pieces = computePieces(o);
      const m2 = computeM2(o);
      const total = Number(o?.pay?.euro || 0);
      const miss = missingFlags(o);
      return { ...it, name, phone, pieces, m2, total, miss };
    });
  }, [items]);

  const selectedIds = useMemo(() => Object.keys(sel).filter(k => sel[k]), [sel]);
  const allSelected = useMemo(() => view.length > 0 && selectedIds.length === view.length, [view.length, selectedIds.length]);

  function toggleAll(){
    if (allSelected) { setSel({}); return; }
    const next = {};
    for (const it of view) next[it.id]=true;
    setSel(next);
  }
  function toggleOne(id){
    setSel(prev => ({...prev, [id]: !prev[id]}));
  }

  async function offloadOne(it){
    const miss = it.miss || [];
    if (miss.length) {
      alert('MUNGON: ' + miss.join(', ') + '\nSË PARI PLOTËSOJE.');
      return;
    }
    if (!confirm(`SHKARKO NË BAZË?\n${it.code} • ${it.name}`)) return;

    const now = new Date().toISOString();
    const nextData = { ...(it.order||{}) };
    nextData.status = 'pastrim';
    nextData.at_base = true;
    nextData.needs_review = false;
    nextData.offloaded_at = now;
    nextData.offloaded_by = transportId;

    const { error } = await supabase
      .from('transport_orders')
      .update({ status: 'pastrim', data: nextData })
      .eq('id', it.id);

    if (error) { alert('GABIM: ' + (error.message||'')); return; }
    await load();
  }

  async function offloadSelected(){
    if (!selectedIds.length) { alert('ZGJIDH TË PAKTËN 1'); return; }

    const chosen = view.filter(x => selectedIds.includes(x.id));
    const bad = chosen.filter(x => (x.miss||[]).length);
    if (bad.length) {
      alert('KËTO S’MUNDEN ME U SHKARKU (MUNGON):\n' + bad.map(x => `${x.code}: ${x.miss.join(', ')}`).join('\n'));
      return;
    }
    if (!confirm(`SHKARKO ${chosen.length} POROSI NË BAZË?`)) return;

    const now = new Date().toISOString();
    for (const it of chosen){
      const nextData = { ...(it.order||{}) };
      nextData.status = 'pastrim';
      nextData.at_base = true;
      nextData.needs_review = false;
      nextData.offloaded_at = now;
      nextData.offloaded_by = transportId;

      const { error } = await supabase
        .from('transport_orders')
        .update({ status: 'pastrim', data: nextData })
        .eq('id', it.id);

      if (error) { alert(`GABIM te ${it.code}: ${error.message||''}`); return; }
    }
    await load();
    setSel({});
  }

  return (
    <main className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">OFFLOAD NË BAZË</h1>
          <div className="subtitle">VETËM TË MIAT • TEREN → PASTRIM</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      {err ? <section className="card"><div className="muted">{err}</div></section> : null}

      <section className="card">
        <div className="toolbar">
          <button className="btn ghost" onClick={toggleAll}>{allSelected ? 'HIQ KREJT' : 'SELECT ALL'}</button>
          <button className="btn" onClick={offloadSelected}>SHKARKO NË BAZË</button>
          <button className="btn ghost" onClick={load}>REFRESH</button>
          <Link className="btn ghost" href="/transport/pranimi">+ PRANIMI</Link>
        </div>

        {busy ? <div className="muted" style={{ paddingTop: 10 }}>Loading…</div> : null}
        {!busy && view.length === 0 ? <div className="muted" style={{ paddingTop: 10 }}>S’KE POROSI “TEREN”.</div> : null}

        <div className="list">
          {view.map(it => (
            <div key={it.id} className={"rowline" + (sel[it.id] ? " selected" : "")}>
              <div className="left">
                <input type="checkbox" checked={!!sel[it.id]} onChange={() => toggleOne(it.id)} style={{ width: 18, height: 18 }} />
                <span className="code">{it.code}</span>
                <div className="meta">
                  <div className="name">{it.name}</div>
                  <div className="sub">{it.pieces} COPË • {it.m2} m² • €{Number(it.total||0).toFixed(2)}</div>
                  {it.miss?.length ? <div className="warn">MUNGON: {it.miss.join(', ')}</div> : <div className="ok">GATI PËR SHKARKIM ✅</div>}
                </div>
              </div>

              <div className="actions">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setEditItem({ id: it.id, data: it.order, code_str: it.code });
                    setEditOpen(true);
                  }}
                >
                  EDIT
                </button>
                <button className="btn" onClick={() => offloadOne(it)}>SHKARKO</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <TransportEditModal
        open={editOpen}
        item={editItem}
        onClose={() => { setEditOpen(false); setEditItem(null); }}
        onSaved={load}
      />

      <style jsx>{`
        .wrap { padding: 18px; max-width: 980px; margin: 0 auto; }
        .header-row { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; margin-bottom: 14px; }
        .title { margin:0; font-size: 22px; letter-spacing: .5px; }
        .subtitle { opacity:.8; font-size: 12px; margin-top: 2px; }
        .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 14px; }
        .pill { padding: 8px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); text-decoration:none; font-weight:700; font-size: 12px; }
        .btn { padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; font-weight: 800; font-size: 12px; text-decoration:none; }
        .btn.ghost { background: transparent; }
        .btn:disabled { opacity:.4; }
        .muted { opacity:.75; font-size: 12px; }
        .toolbar { display:flex; flex-wrap:wrap; gap: 8px; align-items:center; justify-content:space-between; margin-bottom: 10px; }

        .list { margin-top: 8px; display:flex; flex-direction:column; gap: 8px; }
        .rowline { display:flex; justify-content:space-between; align-items:center; gap: 10px; padding: 10px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.03); }
        .rowline.selected { border-color: rgba(34,197,94,.45); background: rgba(34,197,94,.10); }
        .left { display:flex; align-items:center; gap: 10px; min-width: 0; flex: 1; }
        .code { background: rgba(59,130,246,.18); border: 1px solid rgba(59,130,246,.35); padding: 6px 10px; border-radius: 999px; font-weight: 900; }
        .meta { min-width: 0; }
        .name { font-weight: 900; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
        .sub { opacity:.8; font-size: 12px; margin-top: 1px; }
        .warn { margin-top: 4px; font-size: 11px; font-weight: 900; color: #f59e0b; }
        .ok { margin-top: 4px; font-size: 11px; font-weight: 900; color: #22c55e; }
        .actions { display:flex; gap: 8px; align-items:center; }

        @media (max-width: 520px) {
          .wrap { padding: 14px; }
          .rowline { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
          .left { width: 100%; }
          .actions { width: 100%; }
          .actions .btn { width: 100%; min-height: 44px; }
        }
      `}</style>
    </main>
  );
}
