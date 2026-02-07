'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

// --- LOGJIKA E PANDRYSHUAR ---

// Thresholds based on total m² currently in 'pastrim' status.
// < 80 m²   -> LOW
// 80 - 139 m² -> MID
// >= 140 m² -> HIGH
function m2ToLevel(m2) {
  const v = Number(m2) || 0;
  if (v >= 140) return 'HIGH';
  if (v >= 80) return 'MID';
  return 'LOW';
}

async function loadGlobalPastrimi() {
  const [normalRes, transRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id,created_at,data,code,status')
      .eq('status', 'pastrim')
      .order('created_at', { ascending: true })
      .limit(300),
    supabase
      .from('transport_orders')
      .select('id,created_at,data,code_str,status')
      .eq('status', 'pastrim')
      .order('created_at', { ascending: true })
      .limit(300),
  ]);

  if (normalRes?.error) console.error('GLOBAL PASTRIMI orders', normalRes.error);
  if (transRes?.error) console.error('GLOBAL PASTRIMI transport_orders', transRes.error);

  const rows = [];
  for (const row of normalRes?.data || []) rows.push({ source: 'orders', id: row.id, data: row.data });
  for (const row of transRes?.data || []) rows.push({ source: 'transport_orders', id: row.id, data: row.data });

  let m2 = 0;
  for (const r of rows) {
    let raw = r.data;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const o = raw || {};

    const tepiha = Array.isArray(o.tepiha)
      ? o.tepiha
      : Array.isArray(o.tepihaRows)
        ? o.tepihaRows.map(x => ({ m2: Number(x?.m2) || 0, qty: Number(x?.qty || x?.pieces) || 0 }))
        : [];

    const staza = Array.isArray(o.staza)
      ? o.staza
      : Array.isArray(o.stazaRows)
        ? o.stazaRows.map(x => ({ m2: Number(x?.m2) || 0, qty: Number(x?.qty || x?.pieces) || 0 }))
        : [];

    for (const x of tepiha) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);
    for (const x of staza) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);

    if (o.shkallore) {
      m2 += (Number(o.shkallore.qty) || 0) * (Number(o.shkallore.per) || 0);
    }
  }

  m2 = Number(m2.toFixed(1));
  const count = rows.length;
  const level = m2ToLevel(m2);

  return { count, m2, score: 0, level };
}

function readActor() {
  try {
    const s = getTransportSession();
    if (!s?.transport_id) return null;
    return {
      role: s?.role || 'TRANSPORT',
      name: s?.transport_name || 'TRANSPORT',
      pin: String(s.transport_id),
      transport_id: String(s.transport_id),
      from: s?.from || 'transport',
    };
  } catch {
    return null;
  }
}

// --- KOMPONENTI MODERN ---

export default function TransportHome() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState({ count: 0, m2: 0, score: 0, level: '...' });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshGlobalPastrimi() {
    setRefreshing(true);
    try {
      const v = await loadGlobalPastrimi();
      setBusy(v);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setMe(readActor());
    refreshGlobalPastrimi();
    const t = setInterval(() => refreshGlobalPastrimi(), 30000);
    return () => clearInterval(t);
  }, []);

  const role = String(me?.role || '').toUpperCase();
  const ok = role === 'TRANSPORT' || role === 'OWNER' || role === 'ADMIN' || role === 'DISPATCH';

  // Helper për ngjyrat e statusit
  const getStatusColor = (lvl) => {
    if (lvl === 'LOW') return { bg: '#dcfce7', text: '#166534', border: '#bbf7d0', label: '🟢 LEHTË', desc: 'Mund të pranoni lirisht' };
    if (lvl === 'MID') return { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa', label: '🟠 MESATARE', desc: 'Ngarkesë normale' };
    if (lvl === 'HIGH') return { bg: '#fee2e2', text: '#991b1b', border: '#fecaca', label: '🔴 E LARTË', desc: 'Kujdes me oraret' };
    return { bg: '#f3f4f6', text: '#374151', border: '#e5e7eb', label: 'Duke u llogaritur...', desc: '...' };
  };

  const statusStyle = getStatusColor(busy.level);

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '20px 16px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      
      {/* HEADER */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#111' }}>TRANSPORT</h1>
          <span style={{ fontSize: 13, color: '#666', fontWeight: 500 }}>DASHBOARD</span>
        </div>
        <Link 
          href="/" 
          style={{ 
            backgroundColor: '#f3f4f6', color: '#1f2937', padding: '8px 16px', 
            borderRadius: 20, textDecoration: 'none', fontSize: 13, fontWeight: 600 
          }}>
          DALJA
        </Link>
      </header>

      {!ok ? (
        // STATE: NOT LOGGED IN
        <div style={{ textAlign: 'center', padding: 40, background: '#fff', borderRadius: 16, border: '1px solid #eee', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 18 }}>Kërkohet Qasje</h3>
          <p style={{ color: '#666', marginBottom: 24 }}>Duhet të jeni të kyçur me PIN për të vazhduar.</p>
          <Link 
            href="/login" 
            style={{ 
              display: 'inline-block', background: '#000', color: '#fff', 
              padding: '12px 32px', borderRadius: 8, textDecoration: 'none', fontWeight: 600 
            }}>
            SHKO TE LOGIN
          </Link>
        </div>
      ) : (
        // STATE: LOGGED IN
        <>
          {/* USER CARD */}
          <div style={{ background: '#fff', borderRadius: 16, padding: 16, border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: 18 }}>
              {me?.name?.charAt(0) || 'T'}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>{String(me?.name).toUpperCase()}</div>
              <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{role} • ID: {me?.pin}</div>
            </div>
          </div>

          {/* CAPACITY STATUS CARD */}
          <div style={{ 
            background: statusStyle.bg, 
            border: `1px solid ${statusStyle.border}`, 
            borderRadius: 16, padding: '16px 20px', marginBottom: 24 
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.5px', color: statusStyle.text, opacity: 0.8, marginBottom: 4 }}>
                  Kapaciteti Aktual
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: statusStyle.text }}>
                  {statusStyle.label}
                </div>
                <div style={{ fontSize: 13, color: statusStyle.text, marginTop: 4, opacity: 0.9 }}>
                  {statusStyle.desc}
                </div>
              </div>
              <button 
                onClick={refreshGlobalPastrimi}
                disabled={refreshing}
                style={{ 
                  background: 'rgba(255,255,255,0.5)', border: 'none', borderRadius: 20, 
                  padding: '6px 12px', fontSize: 12, fontWeight: 600, color: statusStyle.text,
                  cursor: refreshing ? 'wait' : 'pointer'
                }}>
                {refreshing ? 'Duke marrë...' : 'Rifresko ↻'}
              </button>
            </div>
          </div>

          {/* MAIN ACTIONS GRID */}
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#9ca3af', marginBottom: 12, textTransform: 'uppercase' }}>Veprimet Kryesore</h3>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
            {/* PRANIMI - Primary Action */}
            <Link href="/transport/pranimi" style={{ textDecoration: 'none' }}>
              <div style={{ 
                background: '#2563eb', color: 'white', padding: 20, borderRadius: 16, 
                height: '100%', minHeight: 110, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.3)'
              }}>
                <div style={{ fontSize: 24 }}>📥</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>PRANIMI</div>
              </div>
            </Link>

            {/* PICKUP - Primary Action */}
            <Link href="/transport/pickup" style={{ textDecoration: 'none' }}>
              <div style={{ 
                background: '#4f46e5', color: 'white', padding: 20, borderRadius: 16, 
                height: '100%', minHeight: 110, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: '0 4px 6px -1px rgba(79, 70, 229, 0.3)'
              }}>
                <div style={{ fontSize: 24 }}>🚚</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>PICKUP</div>
              </div>
            </Link>
          </div>

          {/* SECONDARY ACTIONS GRID */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Link href="/transport/gati" style={secondaryBtnStyle}>
              <span>✅ GATI</span>
            </Link>
            
            <Link href="/transport/arka" style={secondaryBtnStyle}>
              <span>💰 ARKA</span>
            </Link>

            <Link href="/transport/fletore" style={secondaryBtnStyle}>
              <span>📝 FLETORJA (PDF)</span>
            </Link>

            <Link href="/pastrimi" style={{ ...secondaryBtnStyle, background: '#f0fdf4', color: '#166534', borderColor: '#bbf7d0' }}>
              <span>🧼 PASTRIMI</span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// Stili i thjeshtë për butonat dytësorë
const secondaryBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '16px',
  color: '#374151',
  fontWeight: 600,
  fontSize: 14,
  textDecoration: 'none',
  textAlign: 'center',
  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  transition: 'transform 0.1s',
  minHeight: 60
};
