'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';
import TransportInlineEdit from '@/components/transport/TransportInlineEdit';

function safeJson(v) {
  try {
    if (!v) return {};
    if (typeof v === 'string') return JSON.parse(v) || {};
    return v || {};
  } catch {
    return {};
  }
}

function calcFromData(data) {
  const o = safeJson(data);

  const tepiha =
    Array.isArray(o.tepiha)
      ? o.tepiha
      : (o.tepihaRows || []).map((x) => ({
          m2: Number(x?.m2) || 0,
          qty: Number(x?.qty || x?.pieces) || 0,
        }));

  const staza =
    Array.isArray(o.staza)
      ? o.staza
      : (o.stazaRows || []).map((x) => ({
          m2: Number(x?.m2) || 0,
          qty: Number(x?.qty || x?.pieces) || 0,
        }));

  let m2 = 0;
  let pieces = 0;

  for (const x of tepiha) {
    const q = Number(x?.qty) || 0;
    const a = Number(x?.m2) || 0;
    m2 += a * q;
    pieces += q;
  }
  for (const x of staza) {
    const q = Number(x?.qty) || 0;
    const a = Number(x?.m2) || 0;
    m2 += a * q;
    pieces += q;
  }
  if (o.shkallore) {
    const q = Number(o.shkallore?.qty) || 0;
    const per = Number(o.shkallore?.per) || 0;
    m2 += q * per;
    pieces += q;
  }

  const totalEur = Number(o?.payment?.euro ?? o?.totalEuro ?? o?.total ?? o?.euro ?? 0) || 0;
  const paidEur = Number(o?.payment?.paid ?? o?.paid ?? 0) || 0;

  return {
    m2: Number(m2.toFixed(1)),
    pieces,
    totalEur: Number(totalEur.toFixed(2)),
    paidEur: Number(paidEur.toFixed(2)),
    clientName: o?.client?.name || '',
    clientPhone: o?.client?.phone || '',
  };
}

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('sq-AL', { maximumFractionDigits: 1 });
}

export default function TransportPickupPage() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [editItem, setEditItem] = useState(null);

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const s = getTransportSession();
      if (!s?.transport_id) {
        setMe(null);
        setRows([]);
        return;
      }
      setMe(s);

      const { data, error } = await supabase
        .from('transport_orders')
        .select('id, code_n, code_str, client_name, client_phone, status, data, transport_id, created_at, updated_at')
        .eq('transport_id', s.transport_id)
        .in('status', ['pickup', 'loaded'])
        .order('code_n', { ascending: true })
        .limit(500);

      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const pickup = useMemo(() => rows.filter((r) => r.status === 'pickup'), [rows]);
  const loaded = useMemo(() => rows.filter((r) => r.status === 'loaded'), [rows]);

  const pickupStats = useMemo(() => {
    let m2 = 0, pieces = 0, eur = 0;
    for (const r of pickup) {
      const c = calcFromData(r.data);
      m2 += c.m2;
      pieces += c.pieces;
      eur += c.totalEur;
    }
    return { m2: Number(m2.toFixed(1)), pieces, eur: Number(eur.toFixed(2)) };
  }, [pickup]);

  const loadedStats = useMemo(() => {
    let m2 = 0, pieces = 0, eur = 0;
    for (const r of loaded) {
      const c = calcFromData(r.data);
      m2 += c.m2;
      pieces += c.pieces;
      eur += c.totalEur;
    }
    return { m2: Number(m2.toFixed(1)), pieces, eur: Number(eur.toFixed(2)) };
  }, [loaded]);

  const truckM2 = pickupStats.m2 + loadedStats.m2;
  const truckPercent = Math.min((truckM2 / 200) * 100, 100);
  const truckBarColor = truckPercent > 95 ? '#ef4444' : truckPercent > 80 ? '#f59e0b' : '#3b82f6';

  async function markLoaded(id) {
    setBusyId(id);
    setErr('');
    try {
      const { error } = await supabase
        .from('transport_orders')
        .update({ status: 'loaded', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  }

  async function markPickup(id) {
    setBusyId(id);
    setErr('');
    try {
      const { error } = await supabase
        .from('transport_orders')
        .update({ status: 'pickup', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  }

  // --- INLINE EDIT (same idea as PASTRIMI edit: stay on same stage page) ---
  if (editItem) {
    return (
      <TransportInlineEdit
        item={{
          id: editItem.id,
          code: editItem.code_str || (editItem.code_n != null ? `T${editItem.code_n}` : ''),
          order: safeJson(editItem.data),
          status: editItem.status,
          transport_id: editItem.transport_id,
        }}
        transportId={String(me?.transport_id || '')}
        title="TRANSPORT • PICKUP"
        subtitle="EDITIMI"
        onClose={() => setEditItem(null)}
        onSaved={load}
      />
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.topbar}>
          <div>
            <div style={styles.title}>TRANSPORT • PICKUP</div>
            <div style={styles.sub}>PICKUP → LOADED → SHKARKO NË BAZË</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Link href="/transport/menu" style={styles.menuBtn}>MENU</Link>
            <button onClick={load} style={styles.refreshBtn} disabled={loading}>
              {loading ? '...' : 'REFRESH'}
            </button>
          </div>
        </div>

        {err ? <div style={styles.err}>{err}</div> : null}

        <div style={styles.card}>
          <div style={styles.rowBetween}>
            <div style={styles.kicker}>KAMIONI IM</div>
            <div style={styles.kickerRight}>{fmt(truckM2)} m² / 200</div>
          </div>
          <div style={styles.barBg}>
            <div style={{ ...styles.barFill, width: `${truckPercent}%`, backgroundColor: truckBarColor }} />
          </div>

          <div style={styles.statsGrid}>
            <div style={styles.stat}>
              <div style={styles.statLabel}>PICKUP</div>
              <div style={styles.statValue}>{pickup.length} porosi</div>
              <div style={styles.statSub}>{fmt(pickupStats.m2)} m² • {pickupStats.pieces} copë</div>
            </div>
            <div style={styles.stat}>
              <div style={styles.statLabel}>LOADED</div>
              <div style={styles.statValue}>{loaded.length} porosi</div>
              <div style={styles.statSub}>{fmt(loadedStats.m2)} m² • {loadedStats.pieces} copë</div>
            </div>
          </div>
        </div>

        <Section
          title={`PICKUP (${pickup.length})`}
          emptyText="S'KA ASNJË POROSI NË PICKUP."
          items={pickup}
          actionLabel="LOADED"
          onAction={markLoaded}
          onEdit={(row) => setEditItem(row)}
          busyId={busyId}
        />

        <Section
          title={`LOADED (${loaded.length})`}
          emptyText="S'KA ASNJË POROSI NË LOADED."
          items={loaded}
          actionLabel="KTHE NË PICKUP"
          onAction={markPickup}
          onEdit={(row) => setEditItem(row)}
          busyId={busyId}
          secondary
        />

        <div style={{ height: 22 }} />

        <Link href="/transport/offload" style={styles.offloadBtn}>
          SHKARKO NË BAZË
        </Link>
      </div>
    </div>
  );
}

function Section({ title, emptyText, items, actionLabel, onAction, onEdit, busyId, secondary }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {items.length === 0 ? (
        <div style={styles.empty}>{emptyText}</div>
      ) : (
        <div style={styles.list}>
          {items.map((r) => {
            const c = calcFromData(r.data);
            const code = r.code_str || (r.code_n != null ? `T${r.code_n}` : 'T?');
            const nm = r.client_name || c.clientName || 'PA EMËR';
            const ph = r.client_phone || c.clientPhone || '';
            return (
              <div key={r.id} style={styles.item}>
                <div style={styles.itemLeft}>
                  <div style={styles.itemTop}>
                    <span style={styles.badge}>{code}</span>
                    <span style={styles.name}>{nm}</span>
                  </div>
                  <div style={styles.meta}>
                    {ph ? <span>{ph}</span> : null}
                    <span style={{ opacity: 0.35 }}>•</span>
                    <span>{c.pieces} copë</span>
                    <span style={{ opacity: 0.35 }}>•</span>
                    <span>{fmt(c.m2)} m²</span>
                    <span style={{ opacity: 0.35 }}>•</span>
                    <span>€{Number(c.totalEur || 0).toFixed(0)}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    onClick={() => onEdit?.(r)}
                    style={styles.btnEdit}
                    disabled={busyId === r.id}
                  >
                    EDIT
                  </button>
                  <button
                    onClick={() => onAction(r.id)}
                    style={secondary ? styles.btnSecondary : styles.btnPrimary}
                    disabled={busyId === r.id}
                  >
                    {busyId === r.id ? '...' : actionLabel}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(1200px 600px at 20% 10%, rgba(37, 99, 235, 0.18), transparent 55%), linear-gradient(180deg, #070a12, #070a12)',
    padding: '18px 14px',
    color: '#e5e7eb',
    fontFamily: '-apple-system, system-ui, Segoe UI, Roboto, sans-serif',
  },
  wrap: { maxWidth: 560, margin: '0 auto' },
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  title: { fontSize: 26, fontWeight: 900, letterSpacing: 1.2 },
  sub: { fontSize: 12, color: 'rgba(226,232,240,0.75)', marginTop: 4 },
  menuBtn: {
    textDecoration: 'none',
    padding: '10px 12px',
    borderRadius: 14,
    border: '1px solid rgba(148,163,184,0.25)',
    color: '#e5e7eb',
    background: 'rgba(15, 23, 42, 0.35)',
    fontWeight: 800,
    fontSize: 12,
  },
  refreshBtn: {
    padding: '10px 12px',
    borderRadius: 14,
    border: '1px solid rgba(148,163,184,0.25)',
    color: '#e5e7eb',
    background: 'rgba(15, 23, 42, 0.65)',
    fontWeight: 800,
    fontSize: 12,
  },
  err: {
    background: 'rgba(239,68,68,0.12)',
    border: '1px solid rgba(239,68,68,0.25)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    color: '#fecaca',
    fontWeight: 700,
    fontSize: 13,
  },
  card: {
    background: 'rgba(2, 6, 23, 0.55)',
    border: '1px solid rgba(148,163,184,0.14)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
    boxShadow: '0 12px 30px rgba(0,0,0,0.25)',
  },
  rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  kicker: { fontSize: 12, fontWeight: 900, letterSpacing: 1.2, color: 'rgba(226,232,240,0.75)' },
  kickerRight: { fontSize: 12, fontWeight: 800, color: 'rgba(226,232,240,0.85)' },
  barBg: { height: 10, background: 'rgba(148,163,184,0.15)', borderRadius: 10, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 10, transition: 'width 0.25s ease' },
  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 },
  stat: {
    background: 'rgba(15, 23, 42, 0.55)',
    border: '1px solid rgba(148,163,184,0.12)',
    borderRadius: 16,
    padding: 12,
  },
  statLabel: { fontSize: 11, letterSpacing: 1.1, fontWeight: 900, color: 'rgba(148,163,184,0.9)' },
  statValue: { marginTop: 6, fontSize: 18, fontWeight: 900 },
  statSub: { marginTop: 4, fontSize: 12, color: 'rgba(226,232,240,0.75)' },
  section: { marginTop: 12 },
  sectionTitle: { fontSize: 14, fontWeight: 900, letterSpacing: 1.1, margin: '6px 2px 10px 2px' },
  empty: {
    background: 'rgba(2, 6, 23, 0.35)',
    border: '1px solid rgba(148,163,184,0.12)',
    borderRadius: 16,
    padding: 14,
    color: 'rgba(226,232,240,0.7)',
    fontWeight: 700,
  },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  item: {
    background: 'rgba(2, 6, 23, 0.55)',
    border: '1px solid rgba(148,163,184,0.14)',
    borderRadius: 18,
    padding: 12,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  itemLeft: { minWidth: 0, flex: 1 },
  itemTop: { display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 },
  badge: {
    background: 'rgba(16,185,129,0.18)',
    border: '1px solid rgba(16,185,129,0.35)',
    color: '#a7f3d0',
    borderRadius: 999,
    padding: '6px 10px',
    fontWeight: 900,
    fontSize: 12,
    flexShrink: 0,
  },
  name: { fontWeight: 900, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  meta: { marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'rgba(226,232,240,0.75)' },
  btnEdit: {
    border: '1px solid rgba(148,163,184,0.30)',
    borderRadius: 14,
    padding: '10px 10px',
    background: 'rgba(15, 23, 42, 0.25)',
    color: '#e5e7eb',
    fontWeight: 900,
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
  },
  btnPrimary: {
    border: 'none',
    borderRadius: 14,
    padding: '10px 12px',
    background: '#2563eb',
    color: '#fff',
    fontWeight: 900,
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
  },
  btnSecondary: {
    border: '1px solid rgba(148,163,184,0.25)',
    borderRadius: 14,
    padding: '10px 12px',
    background: 'rgba(15, 23, 42, 0.6)',
    color: '#e5e7eb',
    fontWeight: 900,
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
  },
  offloadBtn: {
    display: 'block',
    textAlign: 'center',
    textDecoration: 'none',
    padding: '14px 14px',
    borderRadius: 18,
    background: 'linear-gradient(90deg, rgba(16,185,129,0.9), rgba(34,197,94,0.9))',
    color: '#02130a',
    fontWeight: 950,
    letterSpacing: 1.2,
  },
};
