'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

function normalizeT(code) {
  const s = String(code || '').trim();
  if (!s) return '';
  const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '0';
  return `T${n}`;
}

function safeObj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

export default function TransportPickupPage() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');

  const transportId = String(me?.transport_id || '').trim();

  async function load() {
    if (!transportId) return;
    setLoading(true);
    setErr('');
    try {
      const res = await supabase
        .from('transport_orders')
        .select('id,created_at,code_str,status,data')
        .eq('transport_id', transportId)
        .in('status', ['pickup', 'loaded', 'transport_pickup', 'transport_loaded'])
        .order('created_at', { ascending: true })
        .limit(300);
      if (res?.error) throw res.error;

      const out = (res?.data || []).map((r) => {
        const d = safeObj(r.data);
        const name = String(d?.client?.name || '').trim();
        return {
          id: r.id,
          created_at: r.created_at,
          status: String(r.status || '').toLowerCase(),
          code: normalizeT(r.code_str || d?.client?.code || d?.code || ''),
          name,
        };
      });
      setItems(out);
    } catch (e) {
      setErr(e?.message || 'Gabim');
    } finally {
      setLoading(false);
    }
  }

  async function setStatus(id, next) {
    try {
      const row = items.find((x) => x.id === id);
      if (!row) return;
      const { data, error } = await supabase
        .from('transport_orders')
        .select('data')
        .eq('id', id)
        .single();
      if (error) throw error;
      const d = safeObj(data?.data);
      const merged = { ...d, status: next, updated_at: new Date().toISOString() };
      const up = await supabase
        .from('transport_orders')
        .update({ status: next, data: merged })
        .eq('id', id);
      if (up?.error) throw up.error;
      await load();
    } catch (e) {
      alert(`❌ S'u ndrru statusi\n${e?.message || ''}`);
    }
  }

  useEffect(() => {
    const s = getTransportSession();
    setMe(s || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!transportId) return;
    load();
    const t = setInterval(load, 25000);
    return () => clearInterval(t);
  }, [transportId]);

  const grouped = useMemo(() => {
    const pickup = [];
    const loaded = [];
    for (const x of items) {
      if (x.status.includes('loaded')) loaded.push(x);
      else pickup.push(x);
    }
    return { pickup, loaded };
  }, [items]);

  const ok = !!transportId;

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • PICKUP</h1>
          <div className="subtitle">PICKUP → LOADED → SHKARKO NË BAZË</div>
        </div>
        <Link className="pill" href="/transport/menu">MENU</Link>
      </header>

      <section className="card">
        {!ok ? (
          <div className="muted">NUK JE I KYÇUR — KTHEHU TE TRANSPORT dhe hyn me PIN.</div>
        ) : (
          <>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button className="pill" type="button" onClick={load} disabled={loading}>
                {loading ? 'REFRESH...' : 'REFRESH'}
              </button>
              <Link className="pill" href="/transport/offload">SHKARKO NË BAZË</Link>
            </div>

            {err ? <div className="muted" style={{ marginTop: 10, color: '#ef4444' }}>{err}</div> : null}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>PICKUP ({grouped.pickup.length})</div>
              {grouped.pickup.length === 0 ? (
                <div className="muted">S'ka asnjë porosi në PICKUP.</div>
              ) : (
                grouped.pickup.map((o) => (
                  <div key={o.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                    <div style={{ width: 64, fontWeight: 900 }}>{o.code}</div>
                    <div style={{ flex: 1, opacity: 0.92 }}>{(o.name || 'PA EMËR').toUpperCase()}</div>
                    <button className="btn" type="button" onClick={() => setStatus(o.id, 'loaded')} style={{ padding: '8px 10px' }}>
                      LOADED
                    </button>
                  </div>
                ))
              )}
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>LOADED ({grouped.loaded.length})</div>
              {grouped.loaded.length === 0 ? (
                <div className="muted">S'ka asnjë porosi të LOADED.</div>
              ) : (
                grouped.loaded.map((o) => (
                  <div key={o.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                    <div style={{ width: 64, fontWeight: 900 }}>{o.code}</div>
                    <div style={{ flex: 1, opacity: 0.92 }}>{(o.name || 'PA EMËR').toUpperCase()}</div>
                    <button className="btn secondary" type="button" onClick={() => setStatus(o.id, 'pickup')} style={{ padding: '8px 10px' }}>
                      KTHE PICKUP
                    </button>
                    <Link className="btn" href="/transport/offload" style={{ padding: '8px 10px' }}>
                      SHKARKO
                    </Link>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
