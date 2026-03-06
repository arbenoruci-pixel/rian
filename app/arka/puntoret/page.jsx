'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const ROLES = ['OWNER', 'ADMIN', 'DISPATCH', 'PUNTOR', 'TRANSPORT'];

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizeDeviceId(v) {
  return String(v || '').trim();
}

export default function PuntoretDashboardPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);

  // --- MASTER PIN (used for /api/admin/devices) ---
  const [masterPin, setMasterPin] = useState('');

  // --- DEVICES ---
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesErr, setDevicesErr] = useState('');
  const [devices, setDevices] = useState([]);
  const pendingDevices = useMemo(() => (devices || []).filter((d) => d?.is_approved !== true), [devices]);

  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const selectedDevice = useMemo(
    () => pendingDevices.find((d) => String(d.device_id) === String(selectedDeviceId)) || null,
    [pendingDevices, selectedDeviceId]
  );

  // Create+Approve form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('PUNTOR');
  const [newPin, setNewPin] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveErr, setApproveErr] = useState('');

  // Link existing + approve
  const [linkPin, setLinkPin] = useState('');

  // --- STAFF ---
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffErr, setStaffErr] = useState('');
  const [staff, setStaff] = useState([]);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: 'PUNTOR', pin: '', is_active: true });
  const editRef = useRef(null);

  const canManage = useMemo(() => {
    const r = String(actor?.role || '').toUpperCase();
    return r === 'OWNER' || r === 'ADMIN' || r === 'DISPATCH';
  }, [actor]);

  useEffect(() => {
    const u = jparse(localStorage.getItem('CURRENT_USER_DATA'), null);
    if (!u) {
      router.push('/login');
      return;
    }
    setActor(u);
  }, [router]);

  useEffect(() => {
    // initial loads (staff only; devices load needs master pin)
    void reloadStaff();
  }, []);

  async function reloadStaff() {
    setStaffLoading(true);
    setStaffErr('');
    try {
      const { data, error } = await supabase
        .from('tepiha_users')
        .select('id,name,role,pin,is_active,created_at')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setStaff(Array.isArray(data) ? data : []);
    } catch (e) {
      setStaff([]);
      setStaffErr(String(e?.message || e));
    } finally {
      setStaffLoading(false);
    }
  }

  async function reloadDevices() {
    const mp = onlyDigits(masterPin);
    if (!mp) {
      setDevicesErr('SHKRUAJ MASTER PIN');
      return;
    }
    setDevicesLoading(true);
    setDevicesErr('');
    try {
      const res = await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list', master_pin: mp }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'FAILED');
      setDevices(Array.isArray(json.items) ? json.items : []);
      // keep selection valid
      if (selectedDeviceId && !(json.items || []).some((d) => String(d.device_id) === String(selectedDeviceId))) {
        setSelectedDeviceId('');
      }
    } catch (e) {
      setDevices([]);
      setDevicesErr(String(e?.message || e));
    } finally {
      setDevicesLoading(false);
    }
  }

  function resetApproveForms() {
    setNewName('');
    setNewRole('PUNTOR');
    setNewPin('');
    setDeviceLabel('');
    setLinkPin('');
    setApproveErr('');
  }

  async function createUserAndApprove() {
    if (!canManage) return;
    const mp = onlyDigits(masterPin);
    const device_id = normalizeDeviceId(selectedDevice?.device_id || selectedDeviceId);
    const name = String(newName || '').trim();
    const role = String(newRole || 'PUNTOR').trim();
    const pin = onlyDigits(newPin);
    const label = String(deviceLabel || '').trim();

    if (!mp) return setApproveErr('SHKRUAJ MASTER PIN');
    if (!device_id) return setApproveErr('ZGJIDH PAJISJEN');
    if (!name) return setApproveErr('SHKRUAJ EMRIN');
    if (pin.length < 4) return setApproveErr('PIN DUHET MIN 4 SHIFRA');

    setApproveBusy(true);
    setApproveErr('');
    try {
      const res = await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create_user_and_approve',
          master_pin: mp,
          device_id,
          name,
          role,
          pin,
          label,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'FAILED');
      await reloadDevices();
      await reloadStaff();
      setSelectedDeviceId('');
      resetApproveForms();
      alert('✅ U KRIJUA USERI & U APROVUA PAJISJA');
    } catch (e) {
      setApproveErr(String(e?.message || e));
    } finally {
      setApproveBusy(false);
    }
  }

  async function linkUserAndApprove() {
    if (!canManage) return;
    const mp = onlyDigits(masterPin);
    const device_id = normalizeDeviceId(selectedDevice?.device_id || selectedDeviceId);
    const pin = onlyDigits(linkPin);
    const label = String(deviceLabel || '').trim();

    if (!mp) return setApproveErr('SHKRUAJ MASTER PIN');
    if (!device_id) return setApproveErr('ZGJIDH PAJISJEN');
    if (pin.length < 4) return setApproveErr('PIN DUHET MIN 4 SHIFRA');

    setApproveBusy(true);
    setApproveErr('');
    try {
      const res = await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'link_user_and_approve',
          master_pin: mp,
          device_id,
          pin,
          label,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'FAILED');
      await reloadDevices();
      setSelectedDeviceId('');
      resetApproveForms();
      alert('✅ U LIDH USERI & U APROVUA PAJISJA');
    } catch (e) {
      setApproveErr(String(e?.message || e));
    } finally {
      setApproveBusy(false);
    }
  }

  function startEdit(row) {
    if (!canManage) return;
    setEditingId(row.id);
    setEditForm({
      name: row.name || '',
      role: row.role || 'PUNTOR',
      pin: '', // pin change optional
      is_active: row.is_active !== false,
    });
    setTimeout(() => {
      try {
        editRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {}
    }, 50);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({ name: '', role: 'PUNTOR', pin: '', is_active: true });
  }

  async function saveEdit() {
    if (!canManage) return;
    const id = editingId;
    const name = String(editForm.name || '').trim();
    const role = String(editForm.role || 'PUNTOR').trim();
    const pin = onlyDigits(editForm.pin);
    const is_active = editForm.is_active !== false;
    if (!id) return;
    if (!name) return alert('SHKRUAJ EMRIN');
    if (editForm.pin && pin.length < 4) return alert('PIN DUHET MIN 4 SHIFRA');

    setStaffErr('');
    setStaffLoading(true);
    try {
      const payload = { name, role, is_active };
      if (editForm.pin) payload.pin = pin;

      const { error } = await supabase.from('users').update(payload).eq('id', id);
      if (error) throw error;

      await reloadStaff();
      cancelEdit();
      alert('✅ U RUAJT');
    } catch (e) {
      setStaffErr(String(e?.message || e));
    } finally {
      setStaffLoading(false);
    }
  }

  async function toggleActive(row) {
    if (!canManage) return;
    setStaffErr('');
    try {
      const nextActive = row.is_active === false;
      const { error } = await supabase.from('users').update({ is_active: nextActive }).eq('id', row.id);
      if (error) throw error;
      await reloadStaff();
    } catch (e) {
      setStaffErr(String(e?.message || e));
    }
  }

  if (!actor) return null;

  return (
    <div className="pageContainer">
      <div className="maxWidth">
        <div className="topHeader">
          <div>
            <h1 className="h1">ARKA • PUNËTORËT</h1>
            <p className="meta">
              LOGGED: {actor.name} ({String(actor.role || '').toUpperCase()})
            </p>
          </div>
          <Link href="/arka" className="backBtn">
            KTHEHU
          </Link>
        </div>

        {!canManage && (
          <div className="warnBox" style={{ marginBottom: 12 }}>
            S&apos;KE AKSES PËR MENAXHIM (DUHET ADMIN/OWNER/DISPATCH)
          </div>
        )}

        {/* MASTER PIN BAR */}
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panelHead">
            <span className="panelTitle">MASTER PIN (PËR APROVIME)</span>
          </div>
          <div className="panelBody" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              inputMode="numeric"
              placeholder="2380..."
              value={masterPin}
              onChange={(e) => setMasterPin(onlyDigits(e.target.value))}
            />
            <button className="primaryBtn" disabled={devicesLoading || !canManage} onClick={reloadDevices}>
              {devicesLoading ? 'DUKE NGARKUAR...' : 'REFRESH PAJISJET'}
            </button>
            {devicesErr && (
              <span style={{ color: '#ef4444', fontWeight: 800, fontSize: 12 }}>{String(devicesErr)}</span>
            )}
          </div>
        </div>

        <div className="mainGrid">
          {/* SECTION 1: Pending Devices */}
          <div className="formSection" ref={editRef}>
            <div className="panel">
              <div className="panelHead">
                <span className="panelTitle">PAJISJET NË PRITJE</span>
                <span className="badge">{pendingDevices.length} PENDING</span>
              </div>
              <div className="panelBody">
                {devicesLoading ? (
                  <div className="emptyState">DUKE LEXUAR PAJISJET...</div>
                ) : pendingDevices.length === 0 ? (
                  <div className="emptyState">NUK KA PAJISJE NË PRITJE</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {pendingDevices.map((d) => (
                      <button
                        key={String(d.device_id)}
                        className="btnKartela"
                        onClick={() => {
                          setSelectedDeviceId(String(d.device_id));
                          setDeviceLabel(String(d.label || ''));
                          setApproveErr('');
                        }}
                        style={{
                          justifyContent: 'space-between',
                          borderColor:
                            String(d.device_id) === String(selectedDeviceId)
                              ? 'rgba(34,197,94,0.6)'
                              : undefined,
                        }}
                      >
                        <span style={{ fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {String(d.label || 'PAJISJE')} • {String(d.device_id).slice(0, 10)}...
                        </span>
                        <span style={{ opacity: 0.7, fontSize: 12 }}>{d.created_at ? new Date(d.created_at).toLocaleString() : ''}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div style={{ height: 12 }} />

                <div className="panel" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <div className="panelHead">
                    <span className="panelTitle">APROVIMI</span>
                    {selectedDevice ? (
                      <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.4)' }}>
                        {String(selectedDevice.device_id).slice(0, 16)}...
                      </span>
                    ) : (
                      <span className="badge">ZGJIDH PAJISJEN</span>
                    )}
                  </div>
                  <div className="panelBody">
                    <div className="field">
                      <label className="label">LABEL (OPSIONALE)</label>
                      <input
                        className="input"
                        placeholder="p.sh. IPHONE ARBEN"
                        value={deviceLabel}
                        onChange={(e) => setDeviceLabel(e.target.value)}
                      />
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="panel" style={{ background: 'rgba(34,197,94,0.06)' }}>
                      <div className="panelHead">
                        <span className="panelTitle">KRIJO USER TË RI + APROVO</span>
                      </div>
                      <div className="panelBody" style={{ display: 'grid', gap: 10 }}>
                        <div className="field">
                          <label className="label">EMRI</label>
                          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Emri..." />
                        </div>
                        <div className="field">
                          <label className="label">ROLI</label>
                          <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label className="label">PIN (4+ SHIFRA)</label>
                          <input
                            className="input"
                            inputMode="numeric"
                            value={newPin}
                            onChange={(e) => setNewPin(onlyDigits(e.target.value))}
                            placeholder="p.sh. 1234"
                          />
                        </div>
                        <button className="primaryBtn" disabled={!canManage || approveBusy} onClick={createUserAndApprove}>
                          {approveBusy ? 'DUKE APROVUAR...' : 'KRIJO & APROVO'}
                        </button>
                      </div>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="panel" style={{ background: 'rgba(59,130,246,0.06)' }}>
                      <div className="panelHead">
                        <span className="panelTitle">LIDH USER EKZISTUES (PIN) + APROVO</span>
                      </div>
                      <div className="panelBody" style={{ display: 'grid', gap: 10 }}>
                        <div className="field">
                          <label className="label">PIN EKZISTUES</label>
                          <input
                            className="input"
                            inputMode="numeric"
                            value={linkPin}
                            onChange={(e) => setLinkPin(onlyDigits(e.target.value))}
                            placeholder="p.sh. 1111"
                          />
                        </div>
                        <button className="primaryBtn" disabled={!canManage || approveBusy} onClick={linkUserAndApprove}>
                          {approveBusy ? 'DUKE APROVUAR...' : 'LIDH & APROVO'}
                        </button>
                      </div>
                    </div>

                    {approveErr && (
                      <div style={{ marginTop: 10, color: '#ef4444', fontWeight: 900, fontSize: 12 }}>{String(approveErr)}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* SECTION 2: Staff List */}
          <div className="listSection">
            <div className="panel">
              <div className="panelHead">
                <span className="panelTitle">LISTA E STAFIT</span>
                <span className="badge">{staff.length} TOTAL</span>
              </div>
              <div className="listBody">
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <button className="primaryBtn" disabled={staffLoading} onClick={reloadStaff}>
                    {staffLoading ? 'DUKE NGARKUAR...' : 'REFRESH STAFI'}
                  </button>
                  {editingId && (
                    <button className="cancelBtn" onClick={cancelEdit}>
                      ANULO EDIT
                    </button>
                  )}
                </div>

                {staffErr && (
                  <div className="warnBox" style={{ marginBottom: 10 }}>
                    {String(staffErr)}
                  </div>
                )}

                {editingId && (
                  <div className="panel" style={{ marginBottom: 12 }}>
                    <div className="panelHead">
                      <span className="panelTitle">EDIT USER</span>
                      <span className="badge">{editingId.slice(0, 6)}...</span>
                    </div>
                    <div className="panelBody" style={{ display: 'grid', gap: 10 }}>
                      <div className="field">
                        <label className="label">EMRI</label>
                        <input className="input" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label className="label">ROLI</label>
                        <select className="input" value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label className="label">NDRYSHO PIN (OPSIONALE)</label>
                        <input
                          className="input"
                          inputMode="numeric"
                          placeholder="lëre bosh nëse s'do me ndrru"
                          value={editForm.pin}
                          onChange={(e) => setEditForm((f) => ({ ...f, pin: onlyDigits(e.target.value) }))}
                        />
                      </div>
                      <label className="switchRow">
                        <div className={`switchTrack ${editForm.is_active ? 'trackActive' : ''}`}>
                          <input
                            type="checkbox"
                            className="hidden"
                            checked={!!editForm.is_active}
                            onChange={(e) => setEditForm((f) => ({ ...f, is_active: e.target.checked }))}
                          />
                          <div className="switchThumb"></div>
                        </div>
                        <span className={`switchLabel ${editForm.is_active ? 'textGreen' : 'textGray'}`}>
                          {editForm.is_active ? 'USER AKTIV' : 'JO-AKTIV (I BLLOKUAR)'}
                        </span>
                      </label>
                      <button className="primaryBtn" disabled={staffLoading} onClick={saveEdit}>
                        RUAJ
                      </button>
                    </div>
                  </div>
                )}

                {staffLoading ? (
                  <div className="emptyState">DUKE LEXUAR STAFIN...</div>
                ) : staff.length === 0 ? (
                  <div className="emptyState">NUK KA PUNËTORË</div>
                ) : (
                  staff.map((r) => (
                    <div key={r.id} className={`userRow ${editingId === r.id ? 'rowEditing' : ''}`}>
                      <div className="userInfo" style={{ minWidth: 0 }}>
                        <div className="userHeader">
                          <span className={`statusDot ${r.is_active === false ? 'dotRed' : 'dotGreen'}`}></span>
                          <span className="userName" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {r.name || 'PA EMËR'}
                          </span>
                        </div>
                        <div className="userMeta">
                          <span className="roleTag">{String(r.role || 'PUNTOR').toUpperCase()}</span>
                          <span className="pinTag">PIN: ****</span>
                        </div>
                      </div>

                      {canManage && (
                        <div className="userActions">
                          <button className="btnKartela" onClick={() => startEdit(r)}>
                            EDIT
                          </button>
                          <button className="btnKartela" onClick={() => toggleActive(r)}>
                            {r.is_active === false ? 'AKTIVIZO' : 'BLOKO'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
