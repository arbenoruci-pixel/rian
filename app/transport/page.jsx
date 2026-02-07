'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

// --- LOGJIKA E PANDRYSHUAR ---
function m2ToLevel(m2) {
  const v = Number(m2) || 0;
  if (v >= 140) return 'HIGH';
  if (v >= 80) return 'MID';
  return 'LOW';
}

async function loadGlobalPastrimi() {
  const [normalRes, transRes] = await Promise.all([
    supabase.from('orders').select('id,data,status').eq('status', 'pastrim').limit(300),
    supabase.from('transport_orders').select('id,data,status').eq('status', 'pastrim').limit(300),
  ]);

  const rows = [];
  if (normalRes.data) rows.push(...normalRes.data);
  if (transRes.data) rows.push(...transRes.data);

  let m2 = 0;
  for (const r of rows) {
    let raw = r.data;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch {} }
    const o = raw || {};
    
    // Normalizimi
    const tepiha = Array.isArray(o.tepiha) ? o.tepiha : (o.tepihaRows || []).map(x => ({ m2: Number(x?.m2)||0, qty: Number(x?.qty||x?.pieces)||0 }));
    const staza = Array.isArray(o.staza) ? o.staza : (o.stazaRows || []).map(x => ({ m2: Number(x?.m2)||0, qty: Number(x?.qty||x?.pieces)||0 }));

    for (const x of tepiha) m2 += (Number(x.m2)||0) * (Number(x.qty)||0);
    for (const x of staza) m2 += (Number(x.m2)||0) * (Number(x.qty)||0);
    if (o.shkallore) m2 += (Number(o.shkallore.qty)||0) * (Number(o.shkallore.per)||0);
  }

  m2 = Number(m2.toFixed(1));
  return { count: rows.length, m2, score: 0, level: m2ToLevel(m2) };
}

function readActor() {
  try {
    const s = getTransportSession();
    if (!s?.transport_id) return null;
    return { role: s.role || 'TRANSPORT', name: s.transport_name || 'TRANSPORT', pin: s.transport_id };
  } catch { return null; }
}

// --- UI MODERNE / KOMPAKTE ---

export default function TransportHome() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState({ m2: 0, level: '...' });
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
    const t = setInterval(refreshGlobalPastrimi, 30000);
    return () => clearInterval(t);
  }, []);

  // Llogaritja e përqindjes për "Loading Bar" (Max 150m2 visualisht)
  const percent = Math.min((busy.m2 / 150) * 100, 100);
  
  // Ngjyrat dinamike
  let barColor = '#22c55e'; // Green
  let statusText = 'LIRË';
  
  if (busy.level === 'MID') {
    barColor = '#f59e0b'; // Orange
    statusText = 'MESATAR';
  } else if (busy.level === 'HIGH') {
    barColor = '#ef4444'; // Red
    statusText = 'FULL';
  }

  return (
    <div style={{ maxWidth: 500, margin: '0 auto', padding: '10px 15px', fontFamily: '-apple-system, sans-serif', background: '#f8fafc', minHeight: '100vh' }}>
      
      {/* 1. HEADER I THJESHTE */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900, color: '#0f172a', margin: 0, letterSpacing: '-0.5px' }}>TRANSPORT</h1>
        </div>
        
        {me ? (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{me.name.toUpperCase()}</div>
            <Link href="/" style={{ fontSize: 11, color: '#94a3b8', textDecoration: 'none', fontWeight: 500 }}>DIL (LOGOUT)</Link>
          </div>
        ) : (
           <Link href="/login" style={{ fontSize: 13, fontWeight: 600, color: '#2563eb' }}>LOGIN</Link>
        )}
      </header>

      {me && (
        <>
          {/* 2. KAPACITETI (LOADING BAR STYLE) */}
          <div style={{ background: '#fff', padding: '12px 16px', borderRadius: 14, boxShadow: '0 2px 4px rgba(0,0,0,0.04)', marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'flex-end' }}>
              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>Ngarkesa në bazë</span>
              <span style={{ fontSize: 11, color: barColor, fontWeight: 800 }}>{statusText}</span>
            </div>
            
            {/* The Bar Container */}
            <div style={{ height: 10, width: '100%', background: '#f1f5f9', borderRadius: 10, overflow: 'hidden' }}>
              {/* The Filled Part */}
              <div style={{ 
                height: '100%', 
                width: `${percent}%`, 
                background: barColor, 
                borderRadius: 10,
                transition: 'width 0.5s ease-in-out'
              }} />
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
               <button onClick={refreshGlobalPastrimi} style={{ background: 'none', border: 'none', fontSize: 10, color: '#94a3b8', cursor: 'pointer' }}>
                 {refreshing ? 'Duke u matur...' : 'Rifresko'}
               </button>
            </div>
          </div>

          {/* 3. VEPRIMET KRYESORE (BIG BUTTONS) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Link href="/transport/pranimi" style={{ textDecoration: 'none' }}>
              <div style={bigCardStyle('#3b82f6')}> {/* Blue */}
                <span style={{ fontSize: 26 }}>📥</span>
                <span style={{ fontWeight: 700, fontSize: 16, marginTop: 4 }}>PRANIMI</span>
              </div>
            </Link>

            <Link href="/transport/pickup" style={{ textDecoration: 'none' }}>
              <div style={bigCardStyle('#6366f1')}> {/* Indigo */}
                <span style={{ fontSize: 26 }}>🚚</span>
                <span style={{ fontWeight: 700, fontSize: 16, marginTop: 4 }}>PICKUP</span>
              </div>
            </Link>
          </div>

          {/* 4. VEPRIMET DYTESORE (GRID) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Link href="/transport/gati" style={smallCardStyle}>
              <span>✅ GATI</span>
            </Link>
            
            <Link href="/transport/arka" style={smallCardStyle}>
              <span>💰 ARKA</span>
            </Link>

            <Link href="/transport/fletore" style={smallCardStyle}>
              <span>📝 FLETORJA</span>
            </Link>

            <Link href="/pastrimi" style={smallCardStyle}>
              <span>🧼 PASTRIMI</span>
            </Link>
          </div>
        </>
      )}

      {!me && (
        <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
          Duhet të hysh me PIN.
        </div>
      )}
    </div>
  );
}

// STYLES
const bigCardStyle = (color) => ({
  background: color,
  color: 'white',
  padding: '20px',
  borderRadius: 16,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: `0 8px 15px -3px ${color}55`, // Colored shadow
  height: 120,
  transition: 'transform 0.1s'
});

const smallCardStyle = {
  background: '#fff',
  color: '#334155',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  padding: '14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  fontSize: 14,
  textDecoration: 'none',
  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  height: 50
};
