"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getActor } from '@/lib/actorSession';

export default function AdminDevicesPage() {
  const router = useRouter();
  const [masterPin, setMasterPin] = useState('');
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const actor = useMemo(() => getActor(), []);

  useEffect(() => {
    if (!actor?.role || actor.role !== 'ADMIN') router.push('/login');
    if (actor?.pin) setMasterPin(String(actor.pin));
  }, [actor, router]);

  async function api(action, extra = {}) {
    setErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, master_pin: masterPin, ...extra }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'FAIL');
      return json;
    } catch (e) {
      setErr(String(e?.message || e));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    const r = await api('list');
    if (r?.items) setItems(r.items);
  }

  useEffect(() => {
    if (masterPin) refresh();
  }, [masterPin]);

  // 🔥 NDRYSHIMI KËTU: Përdorim 'approved' në vend të 'is_approved'
  const pending = items.filter((x) => !x.approved);
  const approved = items.filter((x) => !!x.approved);

  return (
    <div className="page wrap">
      <div className="header-row">
        <div>
          <h1 className="title">ADMIN</h1>
          <p className="subtitle">APROVIMI I PAJISJEVE</p>
        </div>
        <button className="badge" onClick={() => router.push('/')}>HOME</button>
      </div>

      <div className="card">
        <div className="field-group">
          <label className="label">PIN-i YT I ADMINIT</label>
          <div className="row" style={{ gap: 10 }}>
            <input
              className="input"
              value={masterPin}
              onChange={(e) => setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="p.sh. 2380"
              inputMode="numeric"
              style={{ flex: 1 }}
            />
            <button className="btn secondary" onClick={refresh} disabled={loading}>
              {loading ? '...' : 'RIFRESKO'}
            </button>
          </div>
        </div>
        {err ? <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 10, fontWeight: 800 }}>❌ {err}</div> : null}
      </div>

      <div className="card">
        <h2 className="card-title" style={{ color: '#f59e0b' }}>NË PRITJE PËR APROVIM ({pending.length})</h2>
        {pending.length === 0 ? <div style={{ opacity: 0.6, fontSize: 12 }}>S’ka pajisje në pritje.</div> : null}
        
        {pending.map((x) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ background: '#f59e0b', color: '#000', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 900 }}>PENDING</span>
                <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'monospace' }}>{x.device_id?.split('-')[0]}...</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                PUNËTORI: <b>{x?.tepiha_users?.name || '—'}</b> (PIN: {x?.tepiha_users?.pin || '—'})
              </div>
            </div>
            <button
              className="btn primary"
              style={{ background: '#10b981', padding: '8px 12px', fontSize: 12 }}
              onClick={async () => {
                // 🔥 NDRYSHIMI KËTU: E dërgojmë si 'device_name' në API nese databaza pret këtë emër
                const device_name = prompt('Vendos një emër për këtë telefon (p.sh. iPhone Arbeni):') || '';
                const r = await api('approve', { id: x.id, label: device_name });
                if (r) refresh();
              }}
              disabled={loading}
            >
              APROVO
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2 className="card-title" style={{ color: '#10b981' }}>TË APROVUARA ({approved.length})</h2>
        
        {approved.slice(0, 80).map((x) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ background: '#10b981', color: '#000', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 900 }}>OK</span>
                <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'monospace' }}>{x.device_id?.split('-')[0]}...</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                {/* 🔥 NDRYSHIMI KËTU: Përdorim 'device_name' në vend të 'label' */}
                {x.device_name ? <span style={{ color: '#60a5fa' }}>📱 {x.device_name} <br/></span> : null}
                PUNËTORI: <b>{x?.tepiha_users?.name || '—'}</b>
              </div>
            </div>
            <button
              className="btn secondary"
              style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)', padding: '8px 12px', fontSize: 12 }}
              onClick={async () => {
                if (!confirm('A jeni të sigurt që doni t\'ia hiqni qasjen kësaj pajisjeje?')) return;
                const r = await api('revoke', { id: x.id });
                if (r) refresh();
              }}
              disabled={loading}
            >
              BLLOKO
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
