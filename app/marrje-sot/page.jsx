'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Preserve TRANSPORT codes (T123)
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function computePieces(order) {
  const tCope = Array.isArray(order.tepiha)
    ? order.tepiha.reduce((a, b) => a + (Number(b.qty) || 0), 0)
    : 0;
  const sCope = Array.isArray(order.staza)
    ? order.staza.reduce((a, b) => a + (Number(b.qty) || 0), 0)
    : 0;
  const shk = order.shkallore && Number(order.shkallore.qty) > 0 ? 1 : 0;
  return tCope + sCope + shk;
}

function computeM2(order) {
  const t = Array.isArray(order.tepiha)
    ? order.tepiha.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0)
    : 0;
  const s = Array.isArray(order.staza)
    ? order.staza.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0)
    : 0;
  const stairs = order.shkallore ? (Number(order.shkallore.qty) || 0) * (Number(order.shkallore.per) || 0) : 0;
  return Number((t + s + stairs).toFixed(2));
}

function computeTotalEuro(order) {
  if (order.pay && typeof order.pay.euro === 'number') return Number(order.pay.euro || 0);
  const m2 = computeM2(order);
  const rate = Number(order.pay?.rate || 0);
  return Number((m2 * rate).toFixed(2));
}

function buildIndexFromOrder(order) {
  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = Number(order.pay?.euro ?? computeTotalEuro(order)) || 0;

  return {
    id: order.id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    deliveredAt: Number(order.deliveredAt || order.delivered_at || order.ts || Date.now()),
  };
}

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

async function loadOrdersFromSupabaseForToday() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', { limit: 1000 });
  if (error || !data) return [];

  const today = Date.now();
  const out = [];

  const items = (data || []).filter((x) => (x.name || '').endsWith('.json'));
  for (const item of items) {
    try {
      const order = await downloadJsonNoCache(`orders/${item.name}`);
      if (!order?.id) continue;
      const st = String(order.status || '').toLowerCase();
      const deliveredFlag =
        st === 'dorzim' ||
        st === 'delivered' ||
        st === 'done' ||
        st === 'completed' ||
        String(order.stage || '').toLowerCase() === 'marrje' ||
        order.delivered === true ||
        order.is_delivered === true ||
        !!order.deliveredAt ||
        !!order.delivered_at ||
        !!order.pickedUpAt ||
        !!order.picked_up_at;
      if (!deliveredFlag) continue;

      const idx = buildIndexFromOrder(order);
      if (isSameDay(idx.deliveredAt, today)) out.push(idx);
    } catch {
      // ignore bad file
    }
  }

  out.sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
  return out;
}

function loadOrdersLocalForToday() {
  if (typeof window === 'undefined') return [];
  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    list = Array.isArray(raw) ? raw : [];
  } catch {
    list = [];
  }

  const today = Date.now();
  const out = [];

  for (const entry of list) {
    try {
      const rawOrder = localStorage.getItem(`order_${entry.id}`);
      if (!rawOrder) continue;
      const order = JSON.parse(rawOrder);
      {
      const st = String(order.status || '').toLowerCase();
      const deliveredFlag =
        st === 'dorzim' ||
        st === 'delivered' ||
        st === 'done' ||
        st === 'completed' ||
        String(order.stage || '').toLowerCase() === 'marrje' ||
        order.delivered === true ||
        order.is_delivered === true ||
        !!order.deliveredAt ||
        !!order.delivered_at ||
        !!order.pickedUpAt ||
        !!order.picked_up_at;
      if (!deliveredFlag) continue;
    }

      const idx = buildIndexFromOrder(order);
      if (isSameDay(idx.deliveredAt, today)) out.push(idx);
    } catch {
      // ignore
    }
  }

  out.sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
  return out;
}

export default function Page() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      let online = [];
      try {
        online = await loadOrdersFromSupabaseForToday();
      } catch {}
      if (online && online.length > 0) setOrders(online);
      else setOrders(loadOrdersLocalForToday());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh();
  }, []);

  const listTotalM2 = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0), [orders]);
  const listTotalEuro = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0), [orders]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">Porositë e dorëzuara sot</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            M² SOT: <strong>{listTotalM2.toFixed(2)} m²</strong>
          </div>
          <div>
            € SOT: <strong>{listTotalEuro.toFixed(2)} €</strong>
          </div>
        </div>
      </header>

      <section className="card" style={{ padding: 10 }}>
        {loading && <p style={{ textAlign: 'center' }}>Duke i lexuar porositë...</p>}
        {!loading && orders.length === 0 && <p style={{ textAlign: 'center' }}>Sot ende nuk ka marrje të regjistruara.</p>}

        {!loading &&
          orders.map((o) => {
            const code = normalizeCode(o.code);
            return (
              <div key={o.id} className="fast-row">
                {/* BIG CODE BADGE */}
                <div className="code-badge" title="KODI">
                  {code || '—'}
                </div>

                {/* CENTER: NAME + PHONE */}
                <div className="mid">
                  <div className="name" title={o.name || ''}>
                    {o.name || 'PA EMËR'}
                  </div>
                  <div className="sub" title={o.phone || ''}>
                    {(o.phone || '').trim()}
                  </div>
                </div>

                {/* RIGHT: METRICS */}
                <div className="right">
                  <div className="mline">
                    {Number(o.pieces || 0)} copë • {Number(o.m2 || 0).toFixed(2)} m²
                  </div>
                  <div className="euro">{Number(o.total || 0).toFixed(2)} €</div>
                </div>
              </div>
            );
          })}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>

      <style jsx>{`
        /* FAST LIST ROW */
        .fast-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 6px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .fast-row:last-child {
          border-bottom: none;
        }

        .code-badge {
          width: 46px;
          height: 46px;
          border-radius: 10px;
          background: rgba(22, 163, 74, 0.95);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 900;
          font-size: 15px;
          color: #fff;
          flex-shrink: 0;
          box-shadow: 0 10px 18px rgba(0, 0, 0, 0.35);
        }

        .mid {
          flex: 1;
          min-width: 0;
        }
        .name {
          font-weight: 900;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sub {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.65);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 2px;
        }

        .right {
          text-align: right;
          flex-shrink: 0;
          min-width: 110px;
        }
        .mline {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.7);
          font-weight: 700;
        }
        .euro {
          margin-top: 2px;
          font-size: 13px;
          font-weight: 900;
          color: #fff;
        }
      `}</style>
    </div>
  );
}