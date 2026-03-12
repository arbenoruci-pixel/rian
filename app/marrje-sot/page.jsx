// app/marrje-sot/page.jsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal } from '@/lib/offlineStore';

// -------- helpers --------
function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/[^\d+]+/g, '');
}

function unwrapOrderData(raw) {
  let o = raw;
  if (!o) return {};
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  if (o && o.data) {
    let d = o.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (d && (d.client || d.tepiha || d.pay || d.transport)) o = d;
  }
  return (o && typeof o === 'object') ? o : {};
}

function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (order.shkallore) total += (Number(order.shkallore.qty) || 0) * (Number(order.shkallore.per) || 0);
  return Number(total.toFixed(2));
}

function computePieces(order) {
  const t = order?.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const s = order?.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
}

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export default function MarrjeSotPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const todayKey = dayKeyLocal(new Date());
      const map = new Map();

      const pushItem = (row, source) => {
        const order = unwrapOrderData(row.data || row);
        const status = String(row.status || order.status || '').toLowerCase();
        
        // Pranojmë vetëm ato që janë bërë "dorzim" (ose marrje)
        if (status !== 'dorzim' && status !== 'marrje') return;

        // Data kur është përditësuar statusi i fundit
        const ts = row.updated_at || order.picked_up_at || order.delivered_at || row.created_at || order.ts || Date.now();
        const itemDayKey = dayKeyLocal(new Date(ts));
        
        // ✅ FILTRI AUTOMATIK: Sapo ndërron data, ky kusht bie poshtë dhe nuk shfaqen
        if (itemDayKey !== todayKey) return;

        const id = String(row.id || order.id || '');
        if (!id) return;

        const m2 = computeM2(order);
        const cope = computePieces(order);
        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const code = normalizeCode(order.client?.code || order.code || row.code || row.code_str || '');

        if (!map.has(id)) {
          map.set(id, {
            id,
            source,
            code,
            name: order.client?.name || order.client_name || 'Pa emër',
            phone: order.client?.phone || order.client_phone || '',
            m2,
            cope,
            total,
            paid,
            pickedAt: ts,
            fullOrder: order
          });
        }
      };

      // 1. Lexojmë nga Local (Offline Mirror)
      try {
        const local = await getAllOrdersLocal();
        (local || []).forEach(x => pushItem(x, 'LOCAL'));
      } catch {}

      // 2. Lexojmë nga DB (Online) - vetëm të ditëve të fundit për shpejtësi
      try {
        if (typeof navigator === 'undefined' || navigator.onLine) {
          // Marrim 2 ditët e fundit për të mbuluar zonat kohore
          const dSafe = new Date();
          dSafe.setDate(dSafe.getDate() - 2);
          const safeIso = dSafe.toISOString();

          const [resOrders, resTrans] = await Promise.all([
            supabase.from('orders').select('id, status, code, data, updated_at, created_at').in('status', ['dorzim', 'marrje']).gte('updated_at', safeIso).limit(500),
            supabase.from('transport_orders').select('id, status, code_str, data, updated_at, created_at').in('status', ['dorzim', 'marrje']).gte('updated_at', safeIso).limit(500)
          ]);

          (resOrders.data || []).forEach(x => pushItem(x, 'DB_ORDERS'));
          (resTrans.data || []).forEach(x => pushItem(x, 'DB_TRANS'));
        }
      } catch (e) {
        console.warn("Online fetch failed for Marrje Sot:", e);
      }

      const list = Array.from(map.values());
      // Sortojmë: Ato që janë marrë më së fundmi shfaqen lart
      list.sort((a, b) => new Date(b.pickedAt).getTime() - new Date(a.pickedAt).getTime());

      setRows(list);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const name = (r.name || '').toLowerCase();
      const phone = (r.phone || '').toLowerCase();
      const code = normalizeCode(r.code).toLowerCase();
      return name.includes(q) || phone.includes(q) || code.includes(q);
    });
  }, [rows, search]);

  const totalM2 = useMemo(() => rows.reduce((s, r) => s + (Number(r.m2) || 0), 0), [rows]);
  const totalEuro = useMemo(() => rows.reduce((s, r) => s + (Number(r.total) || 0), 0), [rows]);

  function sendSms(row) {
    const phone = sanitizePhone(row.phone || '');
    if (!phone) return alert('Nuk ka numër telefoni.');
    const msg =
      `Përshëndetje ${row.name || 'klient'}, ` +
      `faleminderit! Porosia${row.code ? ` (kodi ${row.code})` : ''} u dorëzua sot.\n` +
      `${row.cope || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².\n` +
      `Faleminderit!`;
    window.location.href = `sms:${phone}?&body=${encodeURIComponent(msg)}`;
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">Porositë e dorëzuara sot</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL: <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
          <div>
            XHIRO: <strong>{totalEuro.toFixed(2)} €</strong>
          </div>
        </div>
      </header>

      <input
        className="input"
        placeholder="🔎 Kërko emrin / telefonin / kodin..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <section className="card" style={{ padding: '10px' }}>
        {loading ? (
          <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p>
        ) : filtered.length === 0 ? (
          <p style={{ textAlign: 'center', opacity: 0.7, padding: '20px 0' }}>S'ka dorëzime për sot.</p>
        ) : (
          filtered.map((r) => (
            <div
              key={r.id}
              className="list-item-compact"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 4px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    background: '#16a34a',
                    color: '#fff',
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    fontWeight: 900,
                    fontSize: 14,
                    flexShrink: 0,
                  }}
                >
                  {normalizeCode(r.code)}
                </div>

                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.name || 'Pa emër'}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                    {r.cope} copë • {Number(r.m2 || 0).toFixed(2)} m²
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                    {new Date(r.pickedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn secondary"
                  style={{ padding: '6px 10px', fontSize: 12 }}
                  onClick={() => sendSms(r)}
                >
                  SMS
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <footer className="dock">
        <Link href="/" className="btn secondary" style={{ width: '100%' }}>
          🏠 HOME
        </Link>
      </footer>

      <style jsx>{`
        .dock {
          position: sticky;
          bottom: 0;
          padding: 10px 0 6px 0;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0));
          margin-top: 10px;
        }
      `}</style>
    </div>
  );
}
