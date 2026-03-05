"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export default function AdminDevicesPage() {
  const router = useRouter();
  const [masterPin, setMasterPin] = useState('');
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('PUNTOR');
  const [newPin, setNewPin] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');

  useEffect(() => {
    const actor = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!actor?.role || String(actor.role).toUpperCase() !== 'ADMIN') {
      router.push('/login');
    }
    if (actor?.pin) setMasterPin(String(actor.pin));
  }, [router]);

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

    if (!device_id) return setErr('ZGJIDH NJË DEVICE NGA LISTA PENDING.');
    if (!name) return setErr('EMRI ËSHTË I DETYRUESHËM.');
    if (pin.length < 4) return setErr('PIN DUHET ME QENË MINIMUM 4 NUMRA.');

    const r = await api('create_user_and_approve', { name, role, pin, device_id, label: deviceLabel || null });
    if (r) {
      setNewName(''); setNewPin(''); setDeviceLabel(''); setSelectedDeviceId('');
      refresh();
      alert('✅ U krijua user-i dhe u aprovua pajisja!');
    }
  }

  async function linkExistingAndApprove() {
    setErr('');
    const pin = String(newPin || '').replace(/\D/g, '').slice(0, 8);
    const device_id = String(selectedDeviceId || '').trim();
    
    if (!device_id) return setErr('ZGJIDH NJË DEVICE NGA LISTA PENDING.');
    if (pin.length < 4) return setErr('SHKRU PIN (4-8) PËR USER-IN EKZISTUES.');

    const r = await api('link_user_and_approve', { pin, device_id, label: deviceLabel || null });
    if (r) {
      setNewPin(''); setDeviceLabel(''); setSelectedDeviceId('');
      refresh();
      alert('✅ U lidh user-i ekzistues dhe u aprovua pajisja!');
    }
  }

  return (
    <div className="adminPage">
      <div className="maxWidth">
        
        {/* HEADER */}
        <div className="topHeader">
          <div>
            <h1 className="h1">KASAFORTA</h1>
            <p className="meta">APROVIMI I TELEFONAVE</p>
          </div>
          <button className="backBtn" onClick={() => router.push('/arka/puntoret')}>
            KTHEHU
          </button>
        </div>

        <div className="mainGrid">
          
          {/* KOLONA E MAJTË: FORMULARI & MASTER PIN */}
          <div className="leftCol">
            
            {/* MASTER PIN CARD */}
            <div className="panel masterCard">
              <div className="panelHead">
                <span className="panelTitle textWhite">MASTER PIN (ADMIN)</span>
              </div>
              <div className="panelBody">
                <div className="flexRow">
                  <input
                    className="input"
                    value={masterPin}
                    onChange={(e) => setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="p.sh. 2380"
                    inputMode="numeric"
                  />
                  <button className="primaryBtn" onClick={refresh} disabled={loading}>
                    {loading ? '...' : 'REFRESH'}
                  </button>
                </div>
                {err && <div className="errorBox">❌ {err}</div>}
              </div>
            </div>

            {/* FORMULARI KRIJIMIT */}
            <div className="panel">
              <div className="panelHead">
                <span className="panelTitle textBlue">KRIJO OSE LIDH PUNËTORIN</span>
              </div>
              <div className="panelBody formStack">
                
                <div className="field">
                  <label className="label">PAJISJA NË PRITJE</label>
                  <select
                    className="input selectBox"
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
                    <option value="">— ZGJIDH PAJISJEN —</option>
                    {pending.map((x) => (
                      <option key={x.id} value={x.device_id}>
                        {shortDevice(x.device_id)} • {x?.tepiha_users?.name || 'PA EMËR'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="label">EMRI MBIEMRI (Për të rinjtë)</label>
                  <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="p.sh. Bujar Oruqi" />
                </div>

                <div className="field">
                  <label className="label">ROLI</label>
                  <div className="roleGrid">
                    {['ADMIN', 'PUNTOR', 'DISPATCH', 'TRANSPORT'].map((x) => (
                      <button
                        key={x}
                        type="button"
                        className={`roleBtn ${String(newRole).toUpperCase() === x ? 'roleActive' : ''}`}
                        onClick={() => setNewRole(x)}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label className="label">PIN I PUNTORIT</label>
                  <input
                    className="input"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="p.sh. 2580"
                    inputMode="numeric"
                  />
                </div>

                <div className="field">
                  <label className="label">EMRI TELEFONIT (OPSIONALE)</label>
                  <input
                    className="input"
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(e.target.value)}
                    placeholder="p.sh. iPhone Arbeni"
                  />
                </div>

                <div className="flexRow gap10 mt10">
                  <button type="button" className="successBtn flex1" onClick={createUserAndApprove} disabled={loading}>
                    KRIJO TË RI
                  </button>
                  <button type="button" className="outlineBtn flex1" onClick={linkExistingAndApprove} disabled={loading}>
                    LIDH EKZISTUES
                  </button>
                </div>

              </div>
            </div>
          </div>

          {/* KOLONA E DJATHTË: LISTAT */}
          <div className="rightCol">
            
            {/* PENDING LIST */}
            <div className="panel borderWarning">
              <div className="panelHead bgWarning">
                <span className="panelTitle textBlack">NË PRITJE PËR APROVIM ({pending.length})</span>
              </div>
              <div className="panelBody p0">
                {pending.length === 0 ? (
                  <div className="emptyState">Nuk ka asnjë pajisje në pritje.</div>
                ) : (
                  pending.map((x) => (
                    <div key={x.id} className="deviceRow">
                      <div className="deviceInfo">
                        <div className="flexRow alignCenter gap8">
                          <span className="badge warningBadge">PENDING</span>
                          <span className="monoText">{shortDevice(x.device_id)}</span>
                        </div>
                        <div className="deviceDetails">
                          {x.label && <div className="textBlue">📱 {x.label}</div>}
                          <div>PIN REQ: <strong className="textWhite">{x.requested_pin || x?.tepiha_users?.pin || '—'}</strong></div>
                          <div>USER: <strong className="textWhite">{x?.tepiha_users?.name || 'I RI / I PANJOHUR'}</strong></div>
                        </div>
                      </div>
                      <div className="deviceActions">
                        <button
                          className="actionBtn outlineBtn"
                          onClick={() => {
                            setSelectedDeviceId(String(x.device_id));
                            setDeviceLabel(x?.label || '');
                            setNewRole(String(x.requested_role || x?.tepiha_users?.role || 'PUNTOR').toUpperCase());
                            if (x.requested_pin) setNewPin(String(x.requested_pin));
                            if (x?.tepiha_users?.name) setNewName(String(x.tepiha_users.name));
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          PLOTËSO
                        </button>
                        <button className="actionBtn successBtn" onClick={() => approveOne(x)}>
                          APROVO
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* APPROVED LIST */}
            <div className="panel borderSuccess mt20">
              <div className="panelHead bgSuccess">
                <span className="panelTitle textBlack">TË APROVUARA ({approved.length})</span>
              </div>
              <div className="panelBody p0">
                {approved.slice(0, 100).map((x) => (
                  <div key={x.id} className="deviceRow">
                    <div className="deviceInfo">
                      <div className="flexRow alignCenter gap8">
                        <span className="badge successBadge">OK</span>
                        <span className="monoText">{shortDevice(x.device_id)}</span>
                      </div>
                      <div className="deviceDetails mt4">
                        {x.label && <div className="textBlue">📱 {x.label}</div>}
                        <div>USER: <strong className="textWhite">{x?.tepiha_users?.name || '—'}</strong></div>
                      </div>
                    </div>
                    <button className="actionBtn dangerBtn" onClick={() => revokeOne(x)}>
                      BLLOKO
                    </button>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>

      <style jsx>{`
        .adminPage { min-height: 100vh; background: #000; color: #eee; font-family: sans-serif; padding: 20px; }
        .maxWidth { max-width: 1200px; margin: 0 auto; }
        
        .topHeader { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1px solid #222; padding-bottom: 20px; margin-bottom: 24px; }
        .h1 { font-size: 24px; font-weight: 900; letter-spacing: 0.05em; margin: 0; color: #fff; }
        .meta { font-size: 11px; letter-spacing: 0.1em; color: #666; margin-top: 5px; font-weight: 700; }
        .backBtn { background: #111; border: 1px solid #333; color: #ccc; font-size: 11px; font-weight: 800; padding: 10px 18px; border-radius: 10px; cursor: pointer; transition: 0.2s; }
        .backBtn:hover { background: #222; color: #fff; border-color: #555; }

        .mainGrid { display: grid; gap: 24px; }
        @media (min-width: 1024px) { .mainGrid { grid-template-columns: 400px 1fr; } .leftCol { position: sticky; top: 20px; height: fit-content; } }
        
        .panel { background: #0a0a0a; border: 1px solid #222; border-radius: 16px; overflow: hidden; margin-bottom: 20px; }
        .masterCard { background: linear-gradient(145deg, #111, #050505); border-color: #333; }
        
        .panelHead { background: rgba(255,255,255,0.03); padding: 14px 18px; border-bottom: 1px solid #222; }
        .panelTitle { font-size: 11px; font-weight: 900; letter-spacing: 0.1em; }
        .panelBody { padding: 18px; }
        .p0 { padding: 0; }
        .mt20 { margin-top: 20px; }
        .mt10 { margin-top: 10px; }
        .mt4 { margin-top: 4px; }

        .textWhite { color: #fff; }
        .textBlack { color: #000; }
        .textBlue { color: #3b82f6; }

        .borderWarning { border-color: rgba(245,158,11,0.3); }
        .bgWarning { background: rgba(245,158,11,0.9); border-bottom: none; }
        .borderSuccess { border-color: rgba(16,185,129,0.3); }
        .bgSuccess { background: rgba(16,185,129,0.9); border-bottom: none; }

        .formStack { display: flex; flex-direction: column; gap: 16px; }
        .field { display: flex; flex-direction: column; gap: 8px; }
        .label { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; color: #888; margin-left: 2px; }
        
        .input { background: #000; border: 1px solid #333; color: #fff; padding: 14px; font-size: 14px; border-radius: 12px; outline: none; font-weight: 700; transition: 0.2s; width: 100%; }
        .input:focus { border-color: #0070f3; background: #050505; }
        .selectBox { appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 14px center; background-size: 16px; padding-right: 40px; }

        .flexRow { display: flex; align-items: center; }
        .gap10 { gap: 10px; }
        .gap8 { gap: 8px; }
        .flex1 { flex: 1; }

        .primaryBtn { background: #0070f3; color: #fff; border: none; padding: 0 20px; border-radius: 10px; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; cursor: pointer; margin-left: 10px; transition: 0.2s; }
        .primaryBtn:hover { background: #0060df; }
        
        .successBtn { background: #10b981; color: #000; border: none; padding: 14px; border-radius: 12px; font-size: 11px; font-weight: 900; letter-spacing: 0.05em; cursor: pointer; transition: 0.2s; }
        .successBtn:hover { background: #059669; }
        
        .outlineBtn { background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.15); padding: 14px; border-radius: 12px; font-size: 11px; font-weight: 900; letter-spacing: 0.05em; cursor: pointer; transition: 0.2s; }
        .outlineBtn:hover { background: rgba(255,255,255,0.1); }
        
        .dangerBtn { background: rgba(239,68,68,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); padding: 10px 14px; border-radius: 8px; font-size: 10px; font-weight: 900; cursor: pointer; }
        .dangerBtn:hover { background: rgba(239,68,68,0.2); }

        .roleGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .roleBtn { background: #111; border: 1px solid #333; color: #888; padding: 12px; border-radius: 10px; font-size: 11px; font-weight: 800; cursor: pointer; transition: 0.2s; }
        .roleActive { background: rgba(59,130,246,0.15); border-color: #3b82f6; color: #3b82f6; }

        .deviceRow { padding: 16px 18px; border-bottom: 1px solid #1a1a1a; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; transition: 0.2s; }
        .deviceRow:last-child { border-bottom: none; }
        .deviceRow:hover { background: rgba(255,255,255,0.02); }
        
        .deviceInfo { display: flex; flex-direction: column; gap: 6px; }
        .monoText { font-family: monospace; font-size: 12px; color: #aaa; background: #111; padding: 2px 6px; border-radius: 4px; border: 1px solid #222; }
        .badge { font-size: 9px; font-weight: 900; padding: 3px 8px; border-radius: 6px; letter-spacing: 0.05em; }
        .warningBadge { background: rgba(245,158,11,0.2); color: #f59e0b; border: 1px solid rgba(245,158,11,0.5); }
        .successBadge { background: rgba(16,185,129,0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.5); }
        
        .deviceDetails { font-size: 12px; color: #888; line-height: 1.5; }
        
        .deviceActions { display: flex; gap: 8px; }
        .actionBtn { padding: 10px 14px; border-radius: 8px; font-size: 10px; }

        .errorBox { margin-top: 10px; background: rgba(239,68,68,0.1); color: #ef4444; padding: 10px; border-radius: 8px; font-size: 11px; font-weight: 800; border: 1px solid rgba(239,68,68,0.3); }
        .emptyState { padding: 30px; text-align: center; color: #666; font-size: 12px; font-weight: 700; font-style: italic; }
      `}</style>
    </div>
  );
}
