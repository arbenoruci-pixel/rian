'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function computeM2(order) {
  if (order?.pay && typeof order.pay.m2 === 'number') {
    return Number(order.pay.m2) || 0;
  }
  let total = 0;
  if (Array.isArray(order?.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (Array.isArray(order?.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (order?.shkallore) {
    const qty = Number(order.shkallore.qty) || 0;
    const per = Number(order.shkallore.per) || 0;
    total += qty * per;
  }
  return Number(total.toFixed(2));
}

async function loadDeliveredFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const result = [];
  for (const item of data) {
    if (!item.name.endsWith('.json')) continue;
    const path = `orders/${item.name}`;
    const { data: file } = await supabase.storage.from(BUCKET).download(path);
    if (!file) continue;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (obj && obj.id && obj.status === 'dorzim') {
        result.push(obj);
      }
    } catch {
      // ignore
    }
  }
  return result;
}

function loadDeliveredLocal() {
  if (typeof window === 'undefined') return [];
  let list = [];
  try {
    list = JSON.parse(window.localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const result = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    try {
      const raw = window.localStorage.getItem(`order_${entry.id}`);
      if (!raw) continue;
      const full = JSON.parse(raw);
      if (full && full.status === 'dorzim') result.push(full);
    } catch {
      // ignore
    }
  }
  return result;
}

export default function MarrjeSotPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (typeof window === 'undefined') return;
      setLoading(true);
      try {
        let online = [];
        try {
          online = await loadDeliveredFromSupabase();
        } catch (e) {
          console.error('Error loading delivered from Supabase', e);
        }
        const base = online && online.length > 0 ? online : loadDeliveredLocal();
        if (!cancelled) {
          // Sort by deliveredAt or ts desc
          const sorted = [...base].sort((a, b) => {
            const ta = a.deliveredAt || a.ts || 0;
            const tb = b.deliveredAt || b.ts || 0;
            return tb - ta;
          });
          setOrders(sorted);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => {
      const code = normalizeCode(o.client?.code || '');
      const name = (o.client?.name || '').toLowerCase();
      const phone = String(o.client?.phone || '').toLowerCase();
      return (
        code.includes(q) ||
        name.includes(q) ||
        phone.includes(q) ||
        String(o.id).toLowerCase().includes(q)
      );
    });
  }, [orders, search]);

  const totalM2 = useMemo(
    () => filtered.reduce((sum, o) => sum + computeM2(o), 0),
    [filtered],
  );

  const totalOrders = filtered.length;

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">Porositë e dorëzuara (status DORZIM)</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL M²: <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
          <div>
            POROSI: <strong>{totalOrders}</strong>
          </div>
        </div>
      </header>

      <section className="card">
        <div className="field-group">
          <label className="label">KËRKO (kod, emër, telefon)</label>
          <input
            className="input"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="P.sh. 12, ARBEN, +383..."
          />
        </div>

        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && filtered.length === 0 && (
          <p style={{ marginTop: 12 }}>Nuk ka porosi të dorëzuara.</p>
        )}

        {!loading &&
          filtered.map((o) => {
            const code = normalizeCode(o.client?.code || '');
            const m2 = computeM2(o);
            const d = o.deliveredAt ? new Date(o.deliveredAt) : null;
            const dateLabel = d
              ? d.toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: '2-digit',
                  year: '2-digit',
                })
              : '';

            return (
              <div
                key={o.id}
                className="home-btn"
                style={{
                  marginTop: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      padding: '2px 8px',
                      borderRadius: 4,
                      backgroundColor: '#22c55e',
                      color: '#ffffff',
                      minWidth: 32,
                      textAlign: 'center',
                    }}
                  >
                    {code || o.id}
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.client?.name || 'klient pa emër'}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>
                      {dateLabel}{' '}
                      {m2 > 0 ? `· ${m2.toFixed(2)} m²` : ''}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  {o.pay && typeof o.pay.euro === 'number' && (
                    <div>
                      Totali:{' '}
                      <strong>{Number(o.pay.euro || 0).toFixed(2)} €</strong>
                    </div>
                  )}
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
    </div>
  );
}
