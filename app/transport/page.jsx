'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

// --- LOGJIKA (E PANDRYSHUAR) ---
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

// --- UI E PËRMIRËSUAR (SOFT BACKGROUND) ---

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

  // Llogaritja e Loading Bar (max 150m2 vizualisht)
  const percent = Math.min((busy.m2 / 150) * 100, 100);
  
  // Ngjyrat dinamike
  let barColor = '#10b981'; // Green (Emerald)
  let statusText = 'LIRË';
  
  if (busy.level === 'MID') {
    barColor = '#f59e0b'; // Amber
    statusText = 'MESATAR';
  } else if (busy.level === 'HIGH') {
    barColor = '#ef4444'; // Red
    statusText = 'FULL';
  }

  return (
    // Këtu është ndryshimi kryesor: Background #f0f2f5 (Soft Grey)
    <div style={{ 
      backgroundColor: '#f0f2f5', 
      minHeight: '100vh', 
      padding: '20px 16px', 
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' 
    }}>
      
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        
        {/* HEADER */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: 0 }}>TRANSPORT</h1>
          </div>
          
          {me ? (
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              {/* Emri shumë i vogël dhe diskret */}
              <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {me.name}
              </span>
              <Link href="/" style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'none' }}>Dil</Link>
            </div>
          ) : (
             <Link href="/login" style={{ fontSize: 14, fontWeight: 600, color: '#2563eb' }}>Hyrje</Link>
          )}
        </header>

        {me && (
          <>
            {/* KAPACITETI - KARTELË E BARDHË ME LOADING BAR */}
            <div style={{ 
              backgroundColor: '#ffffff', 
              borderRadius: 16, 
              padding: '16px 20px', 
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)', 
              marginBottom: 24 
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'flex-end' }}>
                <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>NGARKESA NË BAZË</span>
                <span style={{ fontSize: 12, color: barColor, fontWeight: 800 }}>{statusText}</span>
              </div>
              
              {/* Sfondi i Bar-it (shumë i lehtë) */}
              <div style={{ height: 12, width: '100%', backgroundColor: '#f3f4f6', borderRadius: 10, overflow: 'hidden' }}>
                {/* Pjesa e mbushur */}
                <div style={{ 
                  height: '100%', 
                  width: `${percent}%`, 
                  backgroundColor: barColor, 
                  borderRadius: 10,
                  transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)'
                }} />
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                 <button 
                   onClick={refreshGlobalPastrimi} 
                   style={{ 
                     background: 'none', border: 'none', 
                     fontSize: 11, color: '#9ca3af', cursor: 'pointer', padding: 0 
                   }}>
                   {refreshing ? 'Duke matur...' : 'Rifresko'}
                 </button>
              </div>
            </div>

            {/* BUTONAT KRYESORË (BIG & BOLD) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <Link href="/transport/pranimi" style={{ textDecoration: 'none' }}>
                <div style={primaryCardStyle('#2563eb')}> {/* Strong Blue */}
                  <span style={{ fontSize: 28, marginBottom: 8 }}>📥</span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>PRANIMI</span>
                </div>
              </Link>

              <Link href="/transport/pickup" style={{ textDecoration: 'none' }}>
                <div style={primaryCardStyle('#4f46e5')}> {/* Indigo */}
                  <span style={{ fontSize: 28, marginBottom: 8 }}>🚚</span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>PICKUP</span>
                </div>
              </Link>
            </div>

            {/* BUTONAT SEKONDARË (CLEAN WHITE) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Link href="/transport/gati" style={secondaryCardStyle}>
                <span>✅ GATI</span>
              </Link>
              
              <Link href="/transport/arka" style={secondaryCardStyle}>
                <span>💰 ARKA</span>
              </Link>

              <Link href="/transport/fletore" style={secondaryCardStyle}>
                <span>📝 FLETORJA</span>
              </Link>

              <Link href="/pastrimi" style={secondaryCardStyle}>
                <span>🧼 PASTRIMI</span>
              </Link>
            </div>
          </>
        )}

        {!me && (
          <div style={{ textAlign: 'center', marginTop: 40, color: '#6b7280' }}>
            <p>Ju lutem kyçuni për të vazhduar.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// STYLES
const primaryCardStyle = (bg) => ({
  backgroundColor: bg,
  color: 'white',
  padding: '24px 16px',
  borderRadius: 16,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: `0 10px 15px -3px ${bg}40`, // Colored soft shadow
  height: 130,
  transition: 'transform 0.1s active'
});

const secondaryCardStyle = {
  backgroundColor: '#ffffff',
  color: '#374151',
  borderRadius: 12,
  padding: '16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  fontSize: 13,
  textDecoration: 'none',
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)', // Subtle shadow
  height: 60,
  border: '1px solid transparent' // Keeps spacing clean
};
