"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

// Helpers
function jparse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function safeUpper(v, fallback = "") { return String(v || "").trim().toUpperCase() || fallback; }
function shortDevice(did) { return String(did || "").split("-")[0] + "..."; }
const euro = (n) => `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

export default function StaffAndDevicesDashboard() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [masterPin, setMasterPin] = useState("");

  // States
  const [pending, setPending] = useState([]);
  const [staff, setStaff] = useState([]);
  const [debtsMap, setDebtsMap] = useState({}); // Avanset automatike nga porositë
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  // Edit/Add Staff
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "", role: "PUNTOR", pin: "", salary: "", avans_manual: "", borxh_afatgjat: "", is_active: true
  });

  // Paguaj Rrogën Modal
  const [salaryModal, setSalaryModal] = useState(null);

  useEffect(() => {
    const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!a) return router.push("/login");
    setActor(a);

    const savedPin = localStorage.getItem("MASTER_ADMIN_PIN") || "";
    if (savedPin) setMasterPin(savedPin);

    reloadAll(false);
    const interval = setInterval(() => { reloadAll(true); }, 10000);
    return () => clearInterval(interval);
  }, []);

  async function reloadAll(isSilent = false) {
    if (!isSilent) setLoading(true);

    try {
      const { data: st, error: stErr } = await supabase.from("tepiha_users").select("*").order("name", { ascending: true });
      if (!stErr && st) setStaff(st);

      const { data: rawDevices, error: devErr } = await supabase.from("tepiha_user_devices").select("*").eq("is_approved", false).order("created_at", { ascending: false });
      if (devErr) throw devErr;

      const { data: rawDebts } = await supabase
        .from("arka_pending_payments")
        .select("amount, created_by_name")
        .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"]);

      const dMap = {};
      if (rawDebts) {
        rawDebts.forEach(d => {
          const amt = Number(d.amount || 0);
          const name = String(d.created_by_name || "").trim().toUpperCase();
          if (name) dMap[name] = (dMap[name] || 0) + amt;
        });
      }
      setDebtsMap(dMap);

      const usersMap = {};
      (st || []).forEach(u => { usersMap[u.id] = u; if (u.pin) usersMap[u.pin] = u; });
      const hydrated = (rawDevices || []).map(d => ({ ...d, tepiha_users: d.requested_pin ? usersMap[d.requested_pin] : usersMap[d.user_id] }));
      setPending(hydrated);

    } catch (err) {
      console.error("Gabim sinkronizimi:", err);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }

  // APROVIMET E PAJISJEVE
  async function handleOneClickApprove(device) {
    if (!masterPin) return alert("Ju lutem shkruani Master PIN-in lart!");
    setActionBusy(true);
    try {
      const { error } = await supabase.from("tepiha_user_devices").update({ is_approved: true, approved_at: new Date().toISOString() }).eq("device_id", device.device_id);
      if (error) throw error;
      alert("✅ Pajisja u aprovua me sukses!");
      reloadAll(false);
    } catch (e) { alert("GABIM: " + e.message); } finally { setActionBusy(false); }
  }

  async function handleReject(device) {
    if (!confirm("A jeni i sigurt që dëshironi ta fshini këtë kërkesë?")) return;
    setActionBusy(true);
    try {
      const { error } = await supabase.from("tepiha_user_devices").delete().eq("device_id", device.device_id);
      if (error) throw error;
      reloadAll(false);
    } catch (e) { alert("GABIM: " + e.message); } finally { setActionBusy(false); }
  }

  // MENAXHIMI I STAFIT
  function startCreateStaff() {
    setEditingId('NEW');
    setEditForm({ name: "", role: "PUNTOR", pin: "", salary: "", avans_manual: "", borxh_afatgjat: "", is_active: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(u) {
    setEditingId(u.id);
    setEditForm({
      name: u.name || "",
      role: safeUpper(u.role),
      pin: "",
      salary: u.salary || "",
      avans_manual: u.avans_manual || "",
      borxh_afatgjat: u.borxh_afatgjat || "",
      is_active: u.is_active !== false
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveStaffEdit() {
    if (!editForm.name) return alert("Ju lutem shkruani emrin!");
    setActionBusy(true);

    const payload = {
      name: editForm.name,
      role: editForm.role,
      is_active: editForm.is_active,
      salary: Number(editForm.salary) || 0,
      avans_manual: Number(editForm.avans_manual) || 0,
      borxh_afatgjat: Number(editForm.borxh_afatgjat) || 0,
    };

    try {
      if (editingId === 'NEW') {
        if (editForm.pin.length < 4) return alert("PIN duhet të ketë të paktën 4 shifra!");
        payload.pin = editForm.pin;
        const { error } = await supabase.from("users").insert([payload]);
        if (error) throw error;
      } else {
        if (editForm.pin.length >= 4) payload.pin = editForm.pin;
        const { error } = await supabase.from("users").update(payload).eq("id", editingId);
        if (error) throw error;
      }
      setEditingId(null);
      reloadAll(false);
    } catch (err) {
      alert("GABIM: " + err.message);
    } finally {
      setActionBusy(false);
    }
  }

  // PAGESA E RROGËS DHE FSHIRJA E AVANSEVE
  async function handlePaySalary() {
    if (!salaryModal || !masterPin) return alert("Kërkohet Master PIN për këtë veprim!");
    const conf = confirm(`A jeni i sigurt që dëshironi t'i paguani rrogën dhe të shlyeni avanset për ${salaryModal.name}? (Borxhi afatgjatë nuk do të fshihet)`);
    if (!conf) return;

    setActionBusy(true);
    try {
      // 1. Shlyen Avanset Automatike nga Porositë
      const { error: err1 } = await supabase
        .from("arka_pending_payments")
        .update({ status: 'CLEARED_PAID', applied_at: new Date().toISOString() })
        .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"])
        .eq("created_by_name", salaryModal.name);
      if (err1) throw err1;

      // 2. Zero Avansin Manual në profilin e tij (por lë Borxhin Afatgjatë)
      const { error: err2 } = await supabase
        .from("users")
        .update({ avans_manual: 0 })
        .eq("id", salaryModal.id);
      if (err2) throw err2;

      alert(`✅ Rroga u pagua me sukses! Të gjitha avanset (Manual & Porosi) u zeruan për ${salaryModal.name}.`);
      setSalaryModal(null);
      reloadAll(false);
    } catch (e) {
      alert("GABIM: " + e.message);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="proDashboard">
      <div className="container">

        <div className="headerArea">
          <div className="flex-between">
            <div>
              <h1 className="title">MENAXHIMI I STAFIT & FINANCAVE</h1>
              <p className="subtitle">Admin: {actor?.name}</p>
            </div>
            <Link href="/arka" className="btn-outline">KTHEHU NË ARKË</Link>
          </div>

          <div className="masterPinBox">
            <div className="pinInfo">
              <span className="icon">🔒</span>
              <div>
                <strong>Master PIN i Mjeshtrit</strong>
                <p>Kërkohet për aprovime dhe pagesa rrogash.</p>
              </div>
            </div>
            <div className="pinInputGroup">
              <input type="password" placeholder="****" className="input" value={masterPin} onChange={(e) => {
                const val = onlyDigits(e.target.value);
                setMasterPin(val);
                localStorage.setItem("MASTER_ADMIN_PIN", val);
              }} />
              <button className="btn-primary" onClick={() => reloadAll(false)} disabled={actionBusy}>REFRESH</button>
            </div>
          </div>
        </div>

        <div className="grid-layout">

          {/* KOLONA 1: KËRKESAT E PAJISJEVE */}
          <div className="col">
            <div className="card">
              <div className="card-header flex-between">
                <h3 className="card-title text-orange">Kërkesat Hyrëse ({pending.length})</h3>
                <span className="badge badge-orange">LIVE SYNC</span>
              </div>
              <div className="card-body p-0">
                {pending.length === 0 ? <div className="empty-state">Nuk ka asnjë kërkesë telefoni të re.</div> :
                  pending.map(d => (
                    <div key={d.device_id} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start', borderLeft: '4px solid #EA580C' }}>
                      <strong style={{ fontSize: '16px' }}>{d.tepiha_users?.name || "❓ Pajisje e Panjohur"}</strong>
                      <p className="text-sm text-muted" style={{ marginTop: '4px' }}>ID: {shortDevice(d.device_id)} | PIN: <strong>{d.requested_pin}</strong></p>
                      <div style={{ display: 'flex', gap: '10px', width: '100%', marginTop: '12px' }}>
                        <button className="btn-danger-light" style={{ flex: 1 }} onClick={() => handleReject(d)} disabled={actionBusy}>FSHIJ</button>
                        <button className="btn-success" style={{ flex: 2 }} onClick={() => handleOneClickApprove(d)} disabled={actionBusy}>✅ APROVO</button>
                      </div>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>

          {/* KOLONA 2: MENAXHIMI I STAFIT & FINANCAVE */}
          <div className="col">

            {/* Formular i Editimit */}
            {editingId && (
              <div className="card mb-4 edit-card">
                <div className="card-header flex-between" style={{ background: 'transparent', borderBottom: '1px solid #BFDBFE' }}>
                  <h3 className="card-title" style={{ color: '#1D4ED8' }}>
                    {editingId === 'NEW' ? 'SHTO PUNËTOR TË RI' : 'EDITO PUNËTORIN'}
                  </h3>
                  <button onClick={() => setEditingId(null)} className="close-btn">✕</button>
                </div>
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="grid-2">
                    <div>
                      <label className="field-label">Emri i Plotë</label>
                      <input className="input full-width" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} placeholder="P.sh. Adem Jashari" />
                    </div>
                    <div>
                      <label className="field-label">Roli</label>
                      <select className="input full-width" value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })}>
                        {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="grid-2">
                    <div>
                      <label className="field-label">{editingId === 'NEW' ? 'PIN i Qasjes' : 'Ndrysho PIN'}</label>
                      <input className="input full-width" placeholder="****" value={editForm.pin} onChange={e => setEditForm({ ...editForm, pin: onlyDigits(e.target.value) })} />
                    </div>
                    <div>
                      <label className="field-label" style={{ color: '#059669' }}>Rroga Bazë (€)</label>
                      <input type="number" inputMode="numeric" min="0" step="1" className="input full-width" placeholder="P.sh. 500" value={editForm.salary} onChange={e => setEditForm({ ...editForm, salary: onlyDigits(e.target.value) })} style={{ borderColor: '#6EE7B7', background: '#F0FDF4' }} />
                    </div>
                  </div>

                  <div className="grid-2" style={{ borderTop: '1px dashed #BFDBFE', paddingTop: '16px' }}>
                    <div>
                      <label className="field-label" style={{ color: '#D97706' }}>Avans Manual (€)</label>
                      <input type="number" inputMode="numeric" min="0" step="1" className="input full-width" placeholder="P.sh. 50" value={editForm.avans_manual} onChange={e => setEditForm({ ...editForm, avans_manual: onlyDigits(e.target.value) })} style={{ borderColor: '#FCD34D', background: '#FFFBEB' }} />
                      <span style={{ fontSize: '11px', color: '#92400E' }}>Zbritet automatikisht te rroga</span>
                    </div>
                    <div>
                      <label className="field-label" style={{ color: '#DC2626' }}>Borxh Afatgjatë (€)</label>
                      <input type="number" inputMode="numeric" min="0" step="1" className="input full-width" placeholder="P.sh. 1000" value={editForm.borxh_afatgjat} onChange={e => setEditForm({ ...editForm, borxh_afatgjat: onlyDigits(e.target.value) })} style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }} />
                      <span style={{ fontSize: '11px', color: '#991B1B' }}>Nuk zerohet kur jep rrogën</span>
                    </div>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'bold', marginTop: '8px' }}>
                    <input type="checkbox" checked={editForm.is_active} onChange={e => setEditForm({ ...editForm, is_active: e.target.checked })} style={{ width: '18px', height: '18px' }} />
                    Llogari Aktive
                  </label>
                  <button className="btn-primary full-width" onClick={saveStaffEdit} disabled={actionBusy}>RUAJ TË DHËNAT</button>
                </div>
              </div>
            )}

            {/* Lista e Stafit dhe Financave */}
            <div className="card">
              <div className="card-header flex-between">
                <h3 className="card-title">Lista & Financat</h3>
                <button className="btn-success btn-small" onClick={startCreateStaff}>➕ SHTO PUNËTOR</button>
              </div>
              <div className="card-body p-0">
                {loading ? <div className="empty-state">Po llogariten financat...</div> :
                  staff.map(u => {
                    const workerName = String(u.name || "").trim().toUpperCase();
                    const baseSalary = Number(u.salary || 0);
                    const autoDebt = debtsMap[workerName] || 0;
                    const manualAdvance = Number(u.avans_manual || 0);
                    const totalAdvance = autoDebt + manualAdvance;
                    const longTermDebt = Number(u.borxh_afatgjat || 0);

                    return (
                      <div key={u.id} className="list-item staff-row" style={{ opacity: u.is_active ? 1 : 0.5 }}>

                        <div className="staff-info">
                          <strong style={{ display: 'block', fontSize: '15px' }}>{u.name}</strong>
                          <span className="text-xs text-muted" style={{ display: 'block', marginTop: '2px' }}>Roli: {u.role}</span>
                        </div>

                        <div className="finance-badges">
                          <div className="badge-box badge-rroga">
                            <span>RROGA</span>
                            <strong>{baseSalary > 0 ? euro(baseSalary) : '-'}</strong>
                          </div>

                          {(totalAdvance > 0) && (
                            <div className="badge-box badge-avans">
                              <span>AVANSE</span>
                              <strong>{euro(totalAdvance)}</strong>
                            </div>
                          )}

                          {(longTermDebt > 0) && (
                            <div className="badge-box badge-borxh">
                              <span>BORXH AF.</span>
                              <strong>{euro(longTermDebt)}</strong>
                            </div>
                          )}
                        </div>

                        <div className="action-buttons">
                          <button className="btn-small btn-light" onClick={() => startEdit(u)}>✏️ EDIT</button>
                          <button className="btn-small btn-pay" onClick={() => setSalaryModal({ ...u, baseSalary, autoDebt, manualAdvance, totalAdvance, longTermDebt })}>
                            💳 RROGA
                          </button>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* MODAL I LLOGARITJES SË RROGËS */}
      {salaryModal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSalaryModal(null); }}>
          <div className="modal-content receipt-modal">
            <div className="flex-between" style={{ marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#0F172A', letterSpacing: '1px' }}>FLETËPAGESA</h3>
              <button className="btn-small btn-light" onClick={() => setSalaryModal(null)}>✕</button>
            </div>

            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ fontSize: '22px', fontWeight: 900, color: '#1E293B', textTransform: 'uppercase' }}>{salaryModal.name}</div>
              <div style={{ color: '#64748B', fontSize: '13px', fontWeight: 600 }}>Roli: {salaryModal.role}</div>
            </div>

            <div className="receipt-box">
              <div className="receipt-row">
                <span>Rroga Bazë:</span>
                <strong style={{ color: '#0F172A' }}>{euro(salaryModal.baseSalary)}</strong>
              </div>

              {salaryModal.autoDebt > 0 && (
                <div className="receipt-row text-red">
                  <span>- Avans nga Porositë:</span>
                  <strong>- {euro(salaryModal.autoDebt)}</strong>
                </div>
              )}

              {salaryModal.manualAdvance > 0 && (
                <div className="receipt-row text-red">
                  <span>- Avans Manual:</span>
                  <strong>- {euro(salaryModal.manualAdvance)}</strong>
                </div>
              )}

              <div className="receipt-total">
                <span>TOTALI PËR T'U PAGUAR:</span>
                <strong style={{ color: '#10B981', fontSize: '24px' }}>{euro(salaryModal.baseSalary - salaryModal.totalAdvance)}</strong>
              </div>
            </div>

            {salaryModal.longTermDebt > 0 && (
              <div className="long-term-info">
                ⚠️ <strong>Informacion:</strong> Ky punëtor ka një Borxh Afatgjatë prej <strong>{euro(salaryModal.longTermDebt)}</strong>. Ky borxh <u>nuk</u> po zbritet automatikisht tani.
              </div>
            )}

            <button className="btn-success btn-large" disabled={actionBusy} onClick={handlePaySalary}>
              PAGUAJ DHE SHLYEJ AVANSET
            </button>
          </div>
        </div>
      )}

      {/* CSS Styles */}
      <style jsx>{`
        .proDashboard { background: #F8FAFC; min-height: 100vh; padding: 24px 16px; font-family: system-ui, -apple-system, sans-serif; color: #0F172A; }
        .container { max-width: 1100px; margin: 0 auto; }
        .headerArea { margin-bottom: 30px; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .title { margin: 0; font-size: 24px; font-weight: 800; color: #1E293B; letter-spacing: -0.5px; }
        .subtitle { margin: 4px 0 0 0; font-size: 14px; color: #64748B; text-transform: uppercase; font-weight: 600; }

        .masterPinBox { background: white; border: 1px solid #E2E8F0; border-radius: 12px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); flex-wrap: wrap; gap: 16px; }
        .pinInfo { display: flex; align-items: center; gap: 12px; }
        .pinInfo .icon { font-size: 20px; background: #F1F5F9; padding: 10px; border-radius: 10px; }
        .pinInfo strong { display: block; font-size: 15px; }
        .pinInfo p { margin: 2px 0 0 0; font-size: 13px; color: #64748B; }
        .pinInputGroup { display: flex; gap: 10px; }

        .grid-layout { display: grid; grid-template-columns: 1fr; gap: 24px; }
        @media(min-width: 900px) { .grid-layout { grid-template-columns: 1fr 1.5fr; } }

        .card { background: white; border-radius: 12px; border: 1px solid #E2E8F0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); overflow: hidden; }
        .card-header { padding: 16px 20px; background: #FAFAF9; border-bottom: 1px solid #F1F5F9; }
        .card-title { margin: 0; font-size: 14px; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 0.5px; }
        .card-body { padding: 20px; }
        .p-0 { padding: 0 !important; }
        .mb-4 { margin-bottom: 24px; }

        .edit-card { border-color: #BFDBFE; background: #EFF6FF; }
        .close-btn { background: none; border: none; cursor: pointer; font-size: 16px; color: #1D4ED8; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }

        .staff-row { flex-wrap: wrap; gap: 12px; }
        .staff-info { flex: 1; min-width: 140px; }
        .finance-badges { display: flex; gap: 8px; flex-wrap: wrap; }
        .badge-box { text-align: center; padding: 6px 10px; border-radius: 8px; min-width: 80px; }
        .badge-box span { display: block; font-size: 10px; font-weight: 800; margin-bottom: 2px; }
        .badge-box strong { font-size: 14px; }

        .badge-rroga { background: #F8FAFC; border: 1px solid #E2E8F0; color: #0F172A; }
        .badge-avans { background: #FEF2F2; border: 1px solid #FECACA; color: #DC2626; }
        .badge-borxh { background: #FFF1F2; border: 1px solid #FECDD3; color: #BE123C; }

        .action-buttons { display: flex; gap: 6px; width: 100%; justify-content: flex-end; margin-top: 5px; }
        @media(min-width: 600px) { .action-buttons { width: auto; margin-top: 0; } }

        .list-item { padding: 16px 20px; border-bottom: 1px solid #F1F5F9; display: flex; justify-content: space-between; align-items: center; transition: 0.2s; }
        .list-item:hover { background: #F8FAFC; }

        .field-label { display: block; font-size: 12px; font-weight: 800; color: #475569; margin-bottom: 6px; text-transform: uppercase; }
        .input { padding: 12px 14px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 14px; outline: none; transition: 0.2s; background: white; font-weight: 600; }
        .input:focus { border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
        .full-width { width: 100%; box-sizing: border-box; }

        .btn-primary { background: #2563EB; color: white; border: none; padding: 12px 16px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.2s; }
        .btn-success { background: #10B981; color: white; border: none; padding: 12px 16px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.2s; }
        .btn-danger-light { background: #FEF2F2; color: #EF4444; border: 1px solid #FEE2E2; padding: 12px 16px; border-radius: 8px; font-weight: 800; cursor: pointer; }
        .btn-outline { background: white; color: #334155; border: 1px solid #CBD5E1; padding: 10px 16px; border-radius: 8px; font-weight: 800; font-size: 13px; text-decoration: none; }
        .btn-small { padding: 8px 12px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer; border: none; }
        .btn-light { background: #F1F5F9; color: #475569; border: 1px solid #E2E8F0; }
        .btn-pay { background: #3B82F6; color: white; border: none; }
        .btn-large { width: 100%; padding: 16px; font-size: 15px; }

        .text-orange { color: #EA580C; }
        .text-muted { color: #64748B; }
        .text-red { color: #DC2626; }
        .text-xs { font-size: 12px; }
        .text-sm { font-size: 13px; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 800; letter-spacing: 0.5px; }
        .badge-orange { background: #FFF7ED; color: #EA580C; border: 1px solid #FFEDD5; }
        .empty-state { padding: 40px; text-align: center; color: #94A3B8; font-size: 14px; font-weight: 600; }

        /* Modal Styles */
        .modal-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(6px); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .modal-content { width: 100%; max-width: 420px; background: white; border-radius: 24px; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); }
        .receipt-box { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 16px; padding: 20px; margin-bottom: 20px; }
        .receipt-row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 15px; font-weight: 600; color: #475569; }
        .receipt-total { display: flex; justify-content: space-between; align-items: center; font-size: 16px; font-weight: 800; color: #0F172A; border-top: 2px dashed #CBD5E1; padding-top: 16px; margin-top: 16px; }
        .long-term-info { background: #FFFBEB; border: 1px solid #FEF3C7; color: #92400E; padding: 12px; border-radius: 12px; font-size: 12px; line-height: 1.5; margin-bottom: 20px; }
      `}</style>
    </div>
  );
}
