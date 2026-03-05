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

  // Create user form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('PUNTOR');
  const [newPin, setNewPin] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');

  const actor = useMemo(() => getActor(), []);

  useEffect(() => {
    if (!actor?.role || String(actor.role).toUpperCase() !== 'ADMIN') router.push('/login');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterPin]);

  const pending = items.filter((x) => !x?.is_approved);
  const approved = items.filter((x) => !!x?.is_approved);

  function shortDevice(did) {
    const s = String(did || '');
    if (!s) return '—';
    return s.split('-')[0] + '...';
  }

  async function approveOne(x) {
    const label = prompt('Vendos një emër për këtë telefon (p.sh. iPhone Arbeni):', x?.label || '') || '';
    const r = await api('approve', { id: x.id, label });
    if (r) refresh();
  }

  async function revokeOne(x) {
    if (!confirm("A jeni të sigurt që doni t'ia hiqni qasjen kësaj pajisjeje?")) return;
    const r = await api('revoke', { id: x.id });
    if (r) refresh();
  }

  async function createUserAndApprove() {
    setErr('');
    const name = String(newName || '').trim();
    const pin = String(newPin || '').replace(/\D/g, '').slice(0, 8);
    const role = String(newRole || '').toUpperCase();
    const device_id = String(selectedDeviceId || '').trim();

    if (!device_id) {
      setErr('ZGJIDH NJË DEVICE NGA LISTA PENDING.');
      return;
    }
    if (!name) {
      setErr('EMRI ËSHTË I DETYRUESHËM.');
      return;
    }
    if (pin.length < 4) {
      setErr('PIN DUHET ME QENË 4-8 NUMRA.');
      return;
    }

    const r = await api('create_user_and_approve', { name, role, pin, device_id, label: deviceLabel || null });
    if (r) {
      setNewName('');
      setNewPin('');
      setDeviceLabel('');
      setSelectedDeviceId('');
      refresh();
      alert('✅ U krijua user-i dhe u aprovua pajisja!');
    }
  }

  async function linkExistingAndApprove() {
    setErr('');
    const pin = String(newPin || '').replace(/\D/g, '').slice(0, 8);
    const device_id = String(selectedDeviceId || '').trim();
    if (!device_id) {
      setErr('ZGJIDH NJË DEVICE NGA LISTA PENDING.');
      return;
    }
    if (pin.length < 4) {
      setErr('SHKRU PIN (4-8) PËR USER-IN EKZISTUES.');
      return;
    }

    const r = await api('link_user_and_approve', { pin, device_id, label: deviceLabel || null });
    if (r) {
      setNewPin('');
      setDeviceLabel('');
      setSelectedDeviceId('');
      refresh();
      alert('✅ U lidh user-i ekzistues dhe u aprovua pajisja!');
    }
  }

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
          <label className="label">MASTER PIN (ADMIN)</label>
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
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
          Ky panel punon vetëm nëse user-i yt ADMIN ka <b>is_master=true</b> në databazë.
        </div>
      </div>

      {/* CREATE USER + APPROVE */}
      <div className="card">
        <h2 className="card-title" style={{ color: '#60a5fa' }}>KRIJO USER + APROVO DEVICE</h2>

        <div className="field-group">
          <label className="label">DEVICE NË PRITJE (ZGJIDH)</label>
          <select
            className="input"
            value={selectedDeviceId}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedDeviceId(v);
              const found = pending.find((x) => String(x.device_id) === String(v));
              setDeviceLabel(found?.label || '');
              if (found?.tepiha_users?.name && !newName) setNewName(found.tepiha_users.name);
              if (found?.requested_role) setNewRole(String(found.requested_role).toUpperCase());
              if (found?.requested_pin) setNewPin(String(found.requested_pin));
            }}
          >
            <option value="">— ZGJIDH —</option>
            {pending.map((x) => (
              <option key={x.id} value={x.device_id}>
                {shortDevice(x.device_id)} • PIN:{x.requested_pin || (x?.tepiha_users?.pin || '—')} • {x?.tepiha_users?.name || 'PA USER'}
              </option>
            ))}
          </select>
        </div>

        <div className="field-group">
          <label className="label">EMRI</label>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="p.sh. Bujar Oruqi" />
        </div>

        <div className="field-group">
          <label className="label">ROLI</label>
          <div className="chip-row">
            {['ADMIN', 'PUNTOR', 'DISPATCH', 'TRANSPORT'].map((x) => (
              <button
                key={x}
                type="button"
                className={'chip ' + (String(newRole).toUpperCase() === x ? '' : 'chip-outline')}
                onClick={() => setNewRole(x)}
              >
                {x}
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <label className="label">PIN (4-8 NUMRA)</label>
          <input
            className="input"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="p.sh. 2580"
            inputMode="numeric"
          />
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
            Nëse user-i ekziston tashmë, përdor butonin <b>LINK EKZISTUES + APROVO</b>.
          </div>
        </div>

        <div className="field-group">
          <label className="label">EMRI I PAJISJES (OPTIONAL)</label>
          <input
            className="input"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            placeholder="p.sh. iPhone Arbeni"
          />
        </div>

        <div className="btn-row">
          <button type="button" className="btn" onClick={createUserAndApprove} disabled={loading}>
            {loading ? '...' : 'KRIJO + APROVO'}
          </button>
          <button type="button" className="btn secondary" onClick={linkExistingAndApprove} disabled={loading}>
            {loading ? '...' : 'LINK EKZISTUES + APROVO'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title" style={{ color: '#f59e0b' }}>NË PRITJE PËR APROVIM ({pending.length})</h2>
        {pending.length === 0 ? <div style={{ opacity: 0.6, fontSize: 12 }}>S’ka pajisje në pritje.</div> : null}

        {pending.map((x) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ background: '#f59e0b', color: '#000', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 900 }}>PENDING</span>
                <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'monospace' }}>{shortDevice(x.device_id)}</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                {x.label ? <span style={{ color: '#60a5fa' }}>📱 {x.label}<br /></span> : null}
                PIN: <b>{x.requested_pin || x?.tepiha_users?.pin || '—'}</b> • ROLI: <b>{String(x.requested_role || x?.tepiha_users?.role || '—').toUpperCase()}</b>
                <br />
                USER: <b>{x?.tepiha_users?.name || 'PA USER'}</b>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn secondary"
                style={{ padding: '8px 12px', fontSize: 12 }}
                onClick={() => {
                  setSelectedDeviceId(String(x.device_id));
                  setDeviceLabel(x?.label || '');
                  setNewRole(String(x.requested_role || x?.tepiha_users?.role || 'PUNTOR').toUpperCase());
                  if (x.requested_pin) setNewPin(String(x.requested_pin));
                  if (x?.tepiha_users?.name) setNewName(String(x.tepiha_users.name));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                disabled={loading}
              >
                PLOTËSO
              </button>
              <button
                className="btn primary"
                style={{ background: '#10b981', padding: '8px 12px', fontSize: 12 }}
                onClick={() => approveOne(x)}
                disabled={loading}
              >
                APROVO
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2 className="card-title" style={{ color: '#10b981' }}>TË APROVUARA ({approved.length})</h2>

        {approved.slice(0, 150).map((x) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ background: '#10b981', color: '#000', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 900 }}>OK</span>
                <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'monospace' }}>{shortDevice(x.device_id)}</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                {x.label ? <span style={{ color: '#60a5fa' }}>📱 {x.label}<br /></span> : null}
                USER: <b>{x?.tepiha_users?.name || '—'}</b> • ROLI: <b>{String(x?.tepiha_users?.role || '—').toUpperCase()}</b>
              </div>
            </div>
            <button
              className="btn secondary"
              style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)', padding: '8px 12px', fontSize: 12 }}
              onClick={() => revokeOne(x)}
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
