'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function computePieces(order) {
  return (
    (Array.isArray(order.tepiha) ? order.tepiha.length : 0) +
    (Array.isArray(order.staza) ? order.staza.length : 0) +
    (order.shkallore && Number(order.shkallore.qty) > 0 ? 1 : 0)
  );
}

function computeM2(order) {
  const t =
    Array.isArray(order.tepiha) ?
      order.tepiha.reduce(
        (sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0),
        0
      ) :
      0;
  const s =
    Array.isArray(order.staza) ?
      order.staza.reduce(
        (sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0),
        0
      ) :
      0;
  const stairs = order.shkallore ? Number(order.shkallore.m2 || 0) : 0;
  return t + s + stairs;
}

function computeTotalEuro(order) {
  if (order.pay && typeof order.pay.euro === 'number') {
    return order.pay.euro;
  }
  if (order.m2 && order.pay && order.pay.rate) {
    return Number(order.m2) * Number(order.pay.rate);
  }
  return Number(order.total || 0) || 0;
}

function buildIndexFromOrder(order) {
  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  return {
    id: order.id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    deliveredAt: order.deliveredAt || order.ts || Date.now(),
  };
}

function isSameDay(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function loadOrdersFromSupabaseForToday() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const today = Date.now();
  const orders = [];
  for (const item of data) {
    if (!item || !item.name) continue;
    try {
      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`orders/${item.name}`);
      if (dErr || !file) continue;
      const text = await file.text();
      const order = JSON.parse(text);
      if (!order || !order.id) continue;
      if (order.status !== 'dorzim') continue;
      const idxEntry = buildIndexFromOrder(order);
      if (isSameDay(idxEntry.deliveredAt, today)) {
        orders.push(idxEntry);
      }
    } catch (e) {
      console.error('Error parsing order for Marrje Sot', item.name, e);
    }
  }

  orders.sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
  return orders;
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
  const result = [];
  for (const entry of list) {
    try {
      const rawOrder = localStorage.getItem(`order_${entry.id}`);
      if (!rawOrder) continue;
      const order = JSON.parse(rawOrder);
      if (order.status !== 'dorzim') continue;
      const idx = buildIndexFromOrder(order);
      if (isSameDay(idx.deliveredAt, today)) {
        result.push(idx);
      }
    } catch {
      // ignore
    }
  }
  result.sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
  return result;
}

export default function Page() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabaseForToday();
      } catch (e) {
        console.error('Error loading Marrje Sot from Supabase', e);
      }
      if (online && online.length > 0) {
        setOrders(online);
      } else {
        setOrders(loadOrdersLocalForToday());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh();
  }, []);

  const listTotalM2 = useMemo(
    () => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0),
    [orders]
  );
  const listTotalEuro = useMemo(
    () => orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    [orders]
  );

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

      <section className="card">
        <h2 className="card-title">Lista e porosive të dorëzuara sot</h2>
        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && orders.length === 0 && <p>Sot ende nuk ka marrje të regjistruara.</p>}

        {!loading &&
          orders.map((o) => (
            <div key={o.id} className="home-btn">
              <div className="home-btn-main">
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {o.code ? `KODI: ${o.code}` : 'PA KOD'}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    {o.name || 'Klient pa emër'} • {(o.phone || '').trim()}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    {o.pieces} copë • {o.m2.toFixed(2)} m²
                  </div>
                  <div>
                    <strong>{o.total.toFixed(2)} €</strong>
                  </div>
                </div>
              </div>
            </div>
          ))}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
