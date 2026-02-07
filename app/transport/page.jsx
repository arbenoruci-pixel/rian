'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

// --- LOGJIKA E KAPACITETIT ---

// 1. KAPACITETI I BAZES (Global)
function m2ToLevel(m2) {
  const v = Number(m2) || 0;
  if (v >= 140) return 'HIGH';
  if (v >= 80) return 'MID';
  return 'LOW';
}

// Helper për llogaritjen e m2 nga JSON
function calculateM2(rows) {
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
  return Number(m2.toFixed(1));
}

async function loadStats(myTransportId) {
  // 1. BAZA (PASTRIMI) - Të gjitha porositë në pastrim
  const [bazaNormal, bazaTrans] = await Promise.all([
    supabase.from('orders').select('data').eq('status', 'pastrim').limit(300),
    supabase.from('transport_orders').select('data').eq('status', 'pastrim').limit(300),
  ]);
  
  const bazaRows = [...(bazaNormal.data || []), ...(bazaTrans.data || [])];
  const bazaM2 = calculateM2(bazaRows);

  // 2. KAMIONI (PICKUP) - Porositë e mia që janë 'transport' (në makinë)
  // Supozojmë që statusi kur i merr është 'transport'. Nëse është ndryshe, ndërro 'transport' me statusin tënd.
  let truckRows = [];
  if (myTransportId) {
    const [truckNormal, truckTrans] = await Promise.all([
      supabase.from('orders').select('data').eq('transport_id', myTransportId).eq('status', 'transport'),
      supabase.from('transport_orders').select('data').eq('transport_id', myTransportId).eq('status', 'transport'),
    ]);
    truckRows = [...(truckNormal.data || []), ...(truckTrans.data || [])];
  }

  const truckM2 = calculateM2(truckRows);
  const truckCount = truckRows.length;

  return {
    baza: { m2: bazaM2, level: m2ToLevel(bazaM2) },
    truck: { m2: truckM2, count: truckCount }
  };
}

function readActor() {
  try {
    const s = getTransportSession();
    if (!s?.transport_id) return null;
    return { role: s.role || 'TRANSPORT', name: s.transport_name || 'TRANSPORT', pin: s.transport_id };
  } catch { return null; }
}

// --- UI MODERNE ---

export default function TransportHome() {
  const [me, setMe] = useState(null);
  const [stats, setStats] = useState({ 
    baza: { m2: 0, level: '...' }, 
    truck: { m2: 0, count: 0 } 
  });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshData() {
    setRefreshing(true);
    try {
      // Pass ID to filter my truck orders
      const v = await loadStats(me?.pin);
      setStats(v);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const actor = readActor();
    setMe(actor);
    
    // Load fillestar
    if (actor?.pin) {
      loadStats(actor.pin).then(setStats);
    } else {
      loadStats(null).then(setStats);
    }

    const t = setInterval(() => {
      const currentActor = readActor();
      if (currentActor?.pin) loadStats(currentActor.pin).then(setStats);
    }, 30000);

    return () => clearInterval(t);
  }, []);

  // --- LLOGARITJET VIZUALE ---

  // 1. KAMIONI (Max 200m2)
  const truckPercent = Math.min((stats.truck.m2 / 200) * 100, 100);
  let truckColor = '#3b82f6'; // Blue
  if (truckPercent > 80) truckColor = '#f59e0b'; // Orange warning
  if (truckPercent > 95) truckColor = '#ef4444'; // Red full

  // 2. BAZA (Max 150m2 visual)
  const basePercent = Math.min((stats.baza.m2 / 150) * 100, 100);
  let baseColor = '#10b981'; // Green
  let baseText = 'LIRË';
  if (stats.baza.level === 'MID') { baseColor = '#f59e0b'; baseText = 'MESATAR'; }
  if (stats.baza.level === 'HIGH') { baseColor = '#ef4444'; baseText = 'FULL'; }

  return (
    <div style={{ backgroundColor: '#f0f2f5', minHeight: '100vh', padding: '20px 16px', fontFamily: '-apple-system, sans-serif' }}>
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        
        {/* HEADER */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: 0 }}>TRANSPORT</h1>
          {me ? (
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>{me.name}</span>
            </div>
          ) : (
             <Link href="/login" style={{ fontSize: 14, fontWeight: 600, color: '#2563eb' }}>Hyrje</Link>
          )}
        </header>

        {me && (
          <>
            {/* KARTELA E STATISTIKAVE (GRID 2-ROW) */}
            <div style={{ backgroundColor: '#fff', borderRadius: 16, padding: '16px 20px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', marginBottom: 24 }}>
              
              {/* 1. KAMIONI IM (Pickup) */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'flex-end' }}>
                  <span style={{ fontSize: 12, color: '#475569', fontWeight: 700 }}>KAMIONI IM (PICKUP)</span>
                  <span style={{ fontSize: 12, color: '#334155', fontWeight: 600 }}>
                    {stats.truck.count} Porosi <span style={{color:'#cbd5e1'}}>|</span> {Math.round(stats.truck.m2)} m²
                  </span>
                </div>
                <div style={{ height: 12, width: '100%', backgroundColor: '#f1f5f9', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${truckPercent}%`, backgroundColor: truckColor, borderRadius: 10, transition: 'width 0.5s ease' }} />
                </div>
              </div>

              {/* 2. KAPACITETI BAZES */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'flex-end' }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>NGARKESA NË BAZË</span>
                  <span style={{ fontSize: 11, color: baseColor, fontWeight: 800 }}>{baseText}</span>
                </div>
                <div style={{ height: 8, width: '100%', backgroundColor: '#f8fafc', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${basePercent}%`, backgroundColor: baseColor, borderRadius: 10, opacity: 0.8, transition: 'width 0.5s ease' }} />
                </div>
              </div>

              {/* Refresh Button Text */}
              <div style={{ textAlign: 'right', marginTop: 10 }}>
                <button onClick={refreshData} style={{ background: 'none', border: 'none', fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                  {refreshing ? 'Duke llogaritur...' : 'Rifresko Të Dhënat'}
                </button>
              </div>
            </div>

            {/* VEPRIMET KRYESORE */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <Link href="/transport/pranimi" style={{ textDecoration: 'none' }}>
                <div style={primaryCardStyle('#2563eb')}>
                  <span style={{ fontSize: 28, marginBottom: 8 }}>📥</span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>PRANIMI</span>
                </div>
              </Link>
              <Link href="/transport/pickup" style={{ textDecoration: 'none' }}>
                <div style={primaryCardStyle('#4f46e5')}>
                  <span style={{ fontSize: 28, marginBottom: 8 }}>🚚</span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>PICKUP</span>
                </div>
              </Link>
            </div>

            {/* VEPRIMET DYTESORE */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Link href="/transport/gati" style={secondaryCardStyle}><span>✅ GATI</span></Link>
              <Link href="/transport/arka" style={secondaryCardStyle}><span>💰 ARKA</span></Link>
              <Link href="/transport/fletore" style={secondaryCardStyle}><span>📝 FLETORJA</span></Link>
              <Link href="/pastrimi" style={secondaryCardStyle}><span>🧼 PASTRIMI</span></Link>
            </div>
          </>
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
  boxShadow: `0 10px 15px -3px ${bg}40`,
  height: 130,
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
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  height: 60,
};
