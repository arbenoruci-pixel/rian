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

function safeUpper(v, fallback = '') {
  const s = String(v || '').trim();
  return s ? s.toUpperCase() : fallback;
}

function fmtDt(v) {
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v || '');
    return d.toLocaleString();
  } catch {
    return String(v || '');
  }
}

async function postAdminDevices(payload) {
  const res = await fetch('/api/admin/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    const msg = json?.error || `HTTP_${res.status}`;
    throw new Error(String(msg));
  }
  return json;
}

export default function PuntoretDashboardPage() {
  const router = useRouter();
  const topRef = useRef(null);

  const [actor, setActor] = useState(null);

  // Master PIN for device approval actions
  const [masterPin, setMasterPin] = useState('');
  const [masterHint, setMasterHint] = useState('');

  // Pending devices
  const [pending, setPending] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingErr, setPendingErr] = useState('');
  const [pendingSelected, setPendingSelected] = useState(null);
  const [createForm, setCreateForm] = useState({ name: '', role: 'PUNTOR', pin: '', label: '' });
  const [approveBusy, setApproveBusy] = useState(false);

  // Staff list
  const [staff, setStaff] = useState([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffErr, setStaffErr] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: 'PUNTOR', pin: '', is_active: true });
  const [saveBusy, setSaveBusy] = useState(false);

  const canManageStaff = useMemo(() => {
    const r = safeUpper(actor?.role);
    return r === 'OWNER' || r === 'ADMIN' || r === 'DISPATCH';
  }, [actor]);

  const canApproveDevices = useMemo(() => {
    const r = safeUpper(actor?.role);
    return r === 'ADMIN' || r === 'OWNER';
  }, [actor]);

  useEffect(() => {
    const a = jparse(localStorage.getItem('CURRENT_USER_DATA'), null);
    if (!a) {
      router.push('/login');
      return;
    }
    setActor(a);

    try {
      const p = localStorage.getItem('MASTER_ADMIN_PIN') || '';
      if (p && !masterPin) setMasterPin(onlyDigits(p));
    } catch {}

    void reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function reloadAll() {
    await Promise.all([reloadPending(), reloadStaff()]);
  }

  async function reloadPending() {
    setPendingLoading(true);
    setPendingErr('');
    try {
      const pin = onlyDigits(masterPin);
      if (!pin) {
        setPending([]);
        setMasterHint('Shkruaj MASTER PIN për me i pa “Pajisjet në pritje”.');
        return;
      }
      setMasterHint('');
      const json = await postAdminDevices({ action: 'list', master_pin: pin });
      const items = Array.isArray(json?.items) ? json.items : [];
      const pendingOnly = items.filter((d) => d?.is_approved !== true);
      setPending(pendingOnly);
    } catch (e) {
      setPendingErr(String(e?.message || e));
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  }

  async function reloadStaff() {
    setStaffLoading(true);
    setStaffErr('');
    try {
      // ✅ Read from VIEW
      const { data, error } = await supabase
        .from('tepiha_users')
        .select('id, name, role, pin, is_active, is_master, created_at')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setStaff(Array.isArray(data) ? data : []);
    } catch (e) {
      setStaffErr(String(e?.message || e));
      setStaff([]);
    } finally {
      setStaffLoading(false);
    }
  }

  function pickPending(d) {
    setPendingSelected(d);
    setCreateForm({
      name: '',
      role: safeUpper(d?.requested_role, 'PUNTOR') || 'PUNTOR',
      pin: onlyDigits(d?.requested_pin || ''),
      label: String(d?.label || ''),
    });
    try {
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }

  function clearPendingSelection() {
    setPendingSelected(null);
    setCreateForm({ name: '', role: 'PUNTOR', pin: '', label: '' });
  }

  async function createUserAndApprove() {
    const pin = onlyDigits(masterPin);
    if (!pin) return alert('SHKRUJ MASTER PIN');
    if (!pendingSelected?.device_id) return;

    const name = String(createForm.name || '').trim();
    const role = safeUpper(createForm.role || 'PUNTOR', 'PUNTOR');
    const userPin = onlyDigits(createForm.pin);
    const label = String(createForm.label || '').trim() || null;

    if (!name) return alert('SHKRUAJ EMRIN');
    if (userPin.length < 4) return alert('PIN DUHET 4+ SHIFRA');

    setApproveBusy(true);
    try {
      try {
        localStorage.setItem('MASTER_ADMIN_PIN', pin);
      } catch {}
      await postAdminDevices({
        action: 'create_user_and_approve',
        master_pin: pin,
        name,
        role,
        pin: userPin,
        device_id: String(pendingSelected.device_id),
        label,
      });
      clearPendingSelection();
      await reloadAll();
      alert('✅ U KRIJUA USER + U APROVUA PAJISJA');
    } catch (e) {
      alert('ERROR: ' + String(e?.message || e));
    } finally {
      setApproveBusy(false);
    }
  }

  async function linkExistingPinAndApprove() {
    const pin = onlyDigits(masterPin);
    if (!pin) return alert('SHKRUJ MASTER PIN');
    if (!pendingSelected?.device_id) return;

    const userPin = onlyDigits(createForm.pin);
    const label = String(createForm.label || '').trim() || null;
    if (userPin.length < 4) return alert('SHKRUJ PIN-IN E PUNTORIT (4+ SHIFRA)');

    setApproveBusy(true);
    try {
      try {
        localStorage.setItem('MASTER_ADMIN_PIN', pin);
      } catch {}
      await postAdminDevices({
        action: 'link_user_and_approve',
        master_pin: pin,
        pin: userPin,
        device_id: String(pendingSelected.device_id),
        label,
      });
      clearPendingSelection();
      await reloadAll();
      alert('✅ U LIDH USERI + U APROVUA PAJISJA');
    } catch (e) {
      alert('ERROR: ' + String(e?.message || e));
    } finally {
      setApproveBusy(false);
    }
  }

  function startEdit(row) {
    if (!canManageStaff) return;
    setEditingId(row.id);
    setEditForm({
      name: row.name || '',
      role: safeUpper(row.role, 'PUNTOR') || 'PUNTOR',
      pin: '',
      is_active: row.is_active !== false,
    });
    try {
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({ name: '', role: 'PUNTOR', pin: '', is_active: true });
  }

  async function saveStaffEdit() {
    if (!canManageStaff) return;
    if (!editingId) return;

    const name = String(editForm.name || '').trim();
    const role = safeUpper(editForm.role || 'PUNTOR', 'PUNTOR');
    const pin = onlyDigits(editForm.pin);
    const is_active = editForm.is_active !== false;

    if (!name) return alert('SHKRUAJ EMRIN');
    if (editForm.pin && pin.length < 4) return alert('PIN DUHET 4+ SHIFRA');

    setSaveBusy(true);
    try {
      // ✅ Update TABLE
      const payload = { name, role, is_active };
      if (editForm.pin) payload.pin = pin;
      const { error } = await supabase.from('users').update(payload).eq('id', editingId);
      if (error) throw error;
      cancelEdit();
      await reloadStaff();
      alert('✅ U RUAJT');
    } catch (e) {
      alert('ERROR: ' + String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function toggleActive(row) {
    if (!canManageStaff) return;
    const next = row.is_active === false;
    setSaveBusy(true);
    try {
      const { error } = await supabase.from('users').update({ is_active: next }).eq('id', row.id);
      if (error) throw error;
      await reloadStaff();
    } catch (e) {
      alert('ERROR: ' + String(e?.message || e));
    } finally {
      setSaveBusy(false);
    }
  }

  const pendingCount = pending.length;
  const staffCount = staff.length;

  return (
    <div className="pageContainer">
      <div className="maxWidth" ref={topRef}>
        <div className="topHeader">
          <div>
            <h1 className="h1">ARKA • PUNËTORËT</h1>
            <p className="meta">LOGGED: {actor?.name} ({safeUpper(actor?.role)})</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Link href="/arka" className="backBtn">
              KTHEHU
            </Link>
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panelHead">
            <span className="panelTitle">MASTER PIN (PËR APROVIM)</span>
            <button
              className="cancelBtn"
              onClick={() => {
                setMasterPin('');
                try {
                  localStorage.removeItem('MASTER_ADMIN_PIN');
                } catch {}
              }}
            >
              FSHIJ
            </button>
          </div>
          <div className="panelBody">
            <div className="formStack" style={{ gap: 10 }}>
              <div className="field">
                <label className="label">MASTER PIN</label>
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="p.sh. 2380"
                  value={masterPin}
                  onChange={(e) => setMasterPin(onlyDigits(e.target.value))}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className="primaryBtn"
                  onClick={() => reloadPending()}
                  disabled={pendingLoading || approveBusy}
                  style={{ flex: 1 }}
                >
                  {pendingLoading ? 'DUKE LEXUAR...' : 'REFRESH PAJISJET'}
                </button>
                <button
                  className="primaryBtn"
                  onClick={() => reloadAll()}
                  disabled={staffLoading || pendingLoading || approveBusy}
                  style={{
                    flex: 1,
                    background: 'rgba(59,130,246,0.15)',
                    border: '1px solid rgba(59,130,246,0.35)',
                  }}
                >
                  REFRESH KREJT
                </button>
              </div>
              {!!masterHint && <div className="warnBox">{masterHint}</div>}
              {!!pendingErr && (
                <div
                  className="warnBox"
                  style={{ borderColor: 'rgba(239,68,68,0.35)', color: '#fecaca' }}
                >
                  {pendingErr}
                </div>
              )}
              {!canApproveDevices && (
                <div className="warnBox">
                  KJO FAQE ËSHTË VETËM PËR ADMIN/OWNER. (Aprovimi kontrollohet nga serveri.)
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mainGrid">
          {/* SEKSIONI 1 */}
          <div className="formSection">
            <div className={`panel ${pendingSelected ? 'panelActive' : ''}`}>
              <div className="panelHead">
                <span className="panelTitle">PAJISJET NË PRITJE</span>
                <span className="badge">{pendingCount} PENDING</span>
              </div>
              <div className="panelBody">
                {pendingLoading ? (
                  <div className="emptyState">DUKE LEXUAR...</div>
                ) : pendingCount === 0 ? (
                  <div className="emptyState">NUK KA PAJISJE NË PRITJE</div>
                ) : (
                  <div className="listBody" style={{ padding: 0 }}>
                    {(pending || []).map((d) => {
                      const selected = String(pendingSelected?.id || '') === String(d?.id || '');
                      return (
                        <button
                          key={d.id}
                          onClick={() => pickPending(d)}
                          className="userRow"
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            cursor: 'pointer',
                            background: selected ? 'rgba(59,130,246,0.12)' : 'transparent',
                            border: selected
                              ? '1px solid rgba(59,130,246,0.35)'
                              : '1px solid rgba(255,255,255,0.06)',
                            borderRadius: 12,
                            marginBottom: 10,
                          }}
                        >
                          <div className="userInfo">
                            <div className="userHeader">
                              <span className={`statusDot dotRed`}></span>
                              <span className="userName">{d.label || 'PA LABEL'}</span>
                            </div>
                            <div className="userMeta">
                              <span className="roleTag">{String(d.device_id || '').slice(0, 10)}…</span>
                              {d.requested_role && (
                                <span className="roleTag">REQ: {safeUpper(d.requested_role)}</span>
                              )}
                              {d.requested_pin && <span className="pinTag">REQ PIN: {String(d.requested_pin)}</span>}
                            </div>
                            <div className="meta" style={{ marginTop: 6, opacity: 0.8 }}>
                              {d.created_at ? `CREATED: ${fmtDt(d.created_at)}` : ''}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {pendingSelected && (
                  <div style={{ marginTop: 12 }}>
                    <div className="panel" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
                      <div className="panelHead">
                        <span className="panelTitle">KRIJO PUNTOR + APROVO</span>
                        <button className="cancelBtn" onClick={clearPendingSelection} disabled={approveBusy}>
                          ANULO
                        </button>
                      </div>
                      <div className="panelBody">
                        <div className="formStack">
                          <div className="field">
                            <label className="label">PAJISJA</label>
                            <div
                              className="input"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                            >
                              <span style={{ fontWeight: 800, opacity: 0.9 }}>{String(pendingSelected?.device_id || '')}</span>
                              <span style={{ fontSize: 12, opacity: 0.65 }}>{pendingSelected?.label || ''}</span>
                            </div>
                          </div>

                          <div className="field">
                            <label className="label">EMRI</label>
                            <input
                              className="input"
                              placeholder="Emri mbiemri..."
                              value={createForm.name}
                              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                            />
                          </div>

                          <div className="field">
                            <label className="label">ROLI</label>
                            <select
                              className="input"
                              value={createForm.role}
                              onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}
                            >
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
                              placeholder="p.sh. 1111"
                              value={createForm.pin}
                              onChange={(e) => setCreateForm((f) => ({ ...f, pin: onlyDigits(e.target.value) }))}
                            />
                          </div>

                          <div className="field">
                            <label className="label">LABEL (OPSIONALE)</label>
                            <input
                              className="input"
                              placeholder="p.sh. IPHONE 14 • PUNTOR 1"
                              value={createForm.label}
                              onChange={(e) => setCreateForm((f) => ({ ...f, label: e.target.value }))}
                            />
                          </div>

                          <button className="primaryBtn" disabled={approveBusy} onClick={createUserAndApprove}>
                            {approveBusy ? 'DUKE APROVUAR...' : '✅ KRIJO USER + APROVO PAJISJEN'}
                          </button>

                          <button
                            className="primaryBtn"
                            disabled={approveBusy}
                            onClick={linkExistingPinAndApprove}
                            style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.35)' }}
                          >
                            🔗 LIDH PIN EKZISTUES + APROVO
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SEKSIONI 2 */}
          <div className="listSection">
            <div className="panel">
              <div className="panelHead">
                <span className="panelTitle">LISTA E STAFIT</span>
                <span className="badge">{staffCount} TOTAL</span>
              </div>
              <div className="panelBody">
                {!!staffErr && (
                  <div className="warnBox" style={{ borderColor: 'rgba(239,68,68,0.35)', color: '#fecaca' }}>
                    {staffErr}
                  </div>
                )}
                {!canManageStaff && <div className="warnBox">S'KE AKSES PËR MENAXHIM (duhet ADMIN/OWNER/DISPATCH)</div>}

                {editingId && (
                  <div className="panel" style={{ marginBottom: 12, border: '1px solid rgba(255,255,255,0.12)' }}>
                    <div className="panelHead">
                      <span className="panelTitle">EDIT PUNTORIN</span>
                      <button className="cancelBtn" onClick={cancelEdit} disabled={saveBusy}>
                        ANULO
                      </button>
                    </div>
                    <div className="panelBody">
                      <div className="formStack">
                        <div className="field">
                          <label className="label">EMRI</label>
                          <input
                            className="input"
                            value={editForm.name}
                            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          />
                        </div>
                        <div className="field">
                          <label className="label">ROLI</label>
                          <select
                            className="input"
                            value={editForm.role}
                            onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}
                          >
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
                            placeholder="lëre bosh nëse s'do me ndërru"
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
                            <div className="switchThumb" />
                          </div>
                          <span className={`switchLabel ${editForm.is_active ? 'textGreen' : 'textGray'}`}>
                            {editForm.is_active ? 'USER AKTIV' : 'JO-AKTIV (I BLLOKUAR)'}
                          </span>
                        </label>

                        <button className="primaryBtn" disabled={saveBusy} onClick={saveStaffEdit}>
                          {saveBusy ? 'DUKE RUAJTUR...' : 'RUAJ NDRYSHIMET'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {staffLoading ? (
                  <div className="emptyState">DUKE LEXUAR STAFIN...</div>
                ) : staff.length === 0 ? (
                  <div className="emptyState">NUK KA USER NË SISTEM</div>
                ) : (
                  <div className="listBody" style={{ padding: 0 }}>
                    {staff.map((r) => {
                      const active = r.is_active !== false;
                      const isEditing = String(editingId || '') === String(r.id || '');
                      return (
                        <div
                          key={r.id}
                          className={`userRow ${isEditing ? 'rowEditing' : ''}`}
                          style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, marginBottom: 10 }}
                        >
                          <div className="userInfo">
                            <div className="userHeader">
                              <span className={`statusDot ${active ? 'dotGreen' : 'dotRed'}`} />
                              <span className="userName">{r.name || 'PA EMËR'}</span>
                              {r.is_master && (
                                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 900, color: '#f59e0b' }}>MASTER</span>
                              )}
                            </div>
                            <div className="userMeta">
                              <span className="roleTag">{safeUpper(r.role) || 'PUNTOR'}</span>
                              <span className="pinTag">PIN: ****</span>
                            </div>
                          </div>

                          {canManageStaff && (
                            <div
                              className="userActions"
                              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                            >
                              <button className="btnKartela" onClick={() => startEdit(r)}>
                                ✏️ EDIT
                              </button>
                              <button className="btnKartela" onClick={() => toggleActive(r)} disabled={saveBusy}>
                                {active ? '⛔ BLOKO' : '✅ AKTIVIZO'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <button className="backBtn" onClick={() => router.push('/')} style={{ flex: 1, textAlign: 'center' }}>
            🏠 HOME
          </button>
          <button className="backBtn" onClick={() => reloadAll()} style={{ flex: 1, textAlign: 'center' }}>
            ↻ REFRESH
          </button>
        </div>

        <style jsx>{`
          .badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 2px 10px;
            border-radius: 999px;
            font-weight: 900;
            font-size: 12px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .rowEditing {
            border-color: rgba(59, 130, 246, 0.35) !important;
            background: rgba(59, 130, 246, 0.08) !important;
          }
          .btnKartela {
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.92);
            font-weight: 900;
            font-size: 12px;
            text-transform: uppercase;
          }
          .btnKartela:active {
            transform: scale(0.98);
          }
        `}</style>
      </div>
    </div>
  );
}
