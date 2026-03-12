"use client";

import React, { useEffect, useMemo, useState } from "react";
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
const fmtDateTime = (v) => {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleString("sq-AL", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(v);
  }
};

function classifyHistoryItem(item) {
  const status = safeUpper(item?.status);
  const type = safeUpper(item?.type);
  const note = String(item?.note || item?.reject_note || "").toLowerCase();

  if (note.includes("rrog") || status === "CLEARED_PAID") {
    return { label: "Rrogë", cls: "history-badge-salary" };
  }
  if (status === "ADVANCE" || type === "ADVANCE") {
    return { label: "Avans", cls: "history-badge-advance" };
  }
  if (["REJECTED", "OWED", "WORKER_DEBT"].includes(status)) {
    return { label: "Borxh", cls: "history-badge-debt" };
  }
  if (["APPLIED", "COLLECTED", "PENDING"].includes(status)) {
    return { label: "Dorëzim", cls: "history-badge-delivery" };
  }
  return { label: status || type || "Veprim", cls: "history-badge-default" };
}

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
    name: "", role: "PUNTOR", pin: "", salary: "", salary_day: "", avans_manual: "", borxh_afatgjat: "", is_active: true
  });
  const [profileTab, setProfileTab] = useState("edit");
  const [workerHistory, setWorkerHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Paguaj Rrogën Modal
  const [salaryModal, setSalaryModal] = useState(null);

  const salaryToPay = useMemo(() => {
    if (!salaryModal) return 0;
    const baseSalary = Number(salaryModal.baseSalary || 0);
    const autoDebt = Number(salaryModal.autoDebt || 0);
    const manualAdvance = Number(salaryModal.manualAdvance || 0);
    const longTermDebt = Number(salaryModal.longTermDebt || 0);
    const deductOrders = salaryModal.deductOrders ? autoDebt : 0;
    const deductManual = salaryModal.deductManual ? manualAdvance : 0;
    const requestedLongTerm = Number(salaryModal.longTermDeduction || 0);
    const appliedLongTerm = Math.max(0, Math.min(requestedLongTerm, longTermDebt));
    return Math.max(0, baseSalary - deductOrders - deductManual - appliedLongTerm);
  }, [salaryModal]);

  const todayDate = new Date().getDate();

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
      const { data: st, error: stErr } = await supabase.from("users").select("*").order("name", { ascending: true });
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

  async function fetchWorkerHistory(workerName) {
    const name = String(workerName || "").trim();
    if (!name) {
      setWorkerHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const { data, error } = await supabase
        .from("arka_pending_payments")
        .select("id, created_at, amount, status, type, note, reject_note, applied_at")
        .eq("created_by_name", name)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      setWorkerHistory(data || []);
    } catch (err) {
      console.error("Gabim te historiku financiar:", err);
      setWorkerHistory([]);
    } finally {
      setHistoryLoading(false);
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
    setProfileTab("edit");
    setWorkerHistory([]);
    setEditForm({ name: "", role: "PUNTOR", pin: "", salary: "", salary_day: "", avans_manual: "", borxh_afatgjat: "", is_active: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(u) {
    setEditingId(u.id);
    setProfileTab("edit");
    setEditForm({
      name: u.name || "",
      role: safeUpper(u.role),
      pin: "",
      salary: u.salary || "",
      salary_day: u.salary_day || "",
      avans_manual: u.avans_manual || "",
      borxh_afatgjat: u.borxh_afatgjat || "",
      is_active: u.is_active !== false
    });
    fetchWorkerHistory(u.name);
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
      salary_day: Math.min(31, Math.max(1, Number(editForm.salary_day) || 0)) || null,
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
      setWorkerHistory([]);
      reloadAll(false);
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.toLowerCase().includes("salary_day") || msg.toLowerCase().includes("schema cache") || msg.toLowerCase().includes("could not find")) {
        alert("SHËNIM: Duhet ta shtoni kolonën salary_day në tabelën users në Supabase, pastaj provo përsëri.");
      } else {
        alert("GABIM: " + err.message);
      }
    } finally {
      setActionBusy(false);
    }
  }

  // PAGESA E RROGËS DHE FSHIRJA E AVANSEVE
  async function handlePaySalary() {
    if (!salaryModal || !masterPin) return alert("Kërkohet Master PIN për këtë veprim!");

    const autoDeduct = salaryModal.deductOrders ? Number(salaryModal.autoDebt || 0) : 0;
    const manualDeduct = salaryModal.deductManual ? Number(salaryModal.manualAdvance || 0) : 0;
    const currentLongTerm = Number(salaryModal.longTermDebt || 0);
    const requestedLongTerm = Number(salaryModal.longTermDeduction || 0);
    const longTermDeduct = Math.max(0, Math.min(requestedLongTerm, currentLongTerm));
    const totalPay = Math.max(0, Number(salaryModal.baseSalary || 0) - autoDeduct - manualDeduct - longTermDeduct);

    const conf = confirm(
      `A jeni i sigurt që dëshironi t'i paguani rrogën ${salaryModal.name}?

` +
      `RROGA BAZË: ${euro(salaryModal.baseSalary)}
` +
      `Zbritje Avans Porosi: ${euro(autoDeduct)}
` +
      `Zbritje Avans Manual: ${euro(manualDeduct)}
` +
      `Zbritje Borxh Afatgjatë: ${euro(longTermDeduct)}

` +
      `TOTALI PËR PAGESË: ${euro(totalPay)}`
    );
    if (!conf) return;

    setActionBusy(true);
    try {
      if (salaryModal.deductOrders) {
        const { error: err1 } = await supabase
          .from("arka_pending_payments")
          .update({ status: 'CLEARED_PAID', applied_at: new Date().toISOString() })
          .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"])
          .eq("created_by_name", salaryModal.name);
        if (err1) throw err1;
      }

      const userUpdate = {
        borxh_afatgjat: Math.max(0, currentLongTerm - longTermDeduct),
      };
      if (salaryModal.deductManual) userUpdate.avans_manual = 0;

      const { error: err2 } = await supabase
        .from("users")
        .update(userUpdate)
        .eq("id", salaryModal.id);
      if (err2) throw err2;

      alert(`✅ Rroga u përpunua me sukses për ${salaryModal.name}.
Totali për pagesë: ${euro(totalPay)}`);
      setSalaryModal(null);
      reloadAll(false);
    } catch (e) {
      alert("GABIM: " + e.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleMoveAdvancesToLongTerm() {
    if (!salaryModal || !masterPin) return alert("Kërkohet Master PIN për këtë veprim!");
    const totalAdvance = Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0);
    if (totalAdvance <= 0) return alert("Ky punëtor nuk ka avanse për t'i kaluar në borxh afatgjatë.");

    const conf = confirm(
      `A jeni i sigurt?

` +
      `AVANSE TOTALE: ${euro(totalAdvance)}
` +
      `BORXH AKTUAL AFATGJATË: ${euro(salaryModal.longTermDebt || 0)}
` +
      `BORXH I RI AFATGJATË: ${euro(Number(salaryModal.longTermDebt || 0) + totalAdvance)}

` +
      `Rroga bazë nuk do të preket.`
    );
    if (!conf) return;

    setActionBusy(true);
    try {
      if (Number(salaryModal.autoDebt || 0) > 0) {
        const { error: err1 } = await supabase
          .from("arka_pending_payments")
          .update({ status: 'CLEARED_PAID', applied_at: new Date().toISOString(), note: 'KALUAR NË BORXH AFATGJATË' })
          .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"])
          .eq("created_by_name", salaryModal.name);
        if (err1) throw err1;
      }

      const { error: err2 } = await supabase
        .from("users")
        .update({
          avans_manual: 0,
          borxh_afatgjat: Number(salaryModal.longTermDebt || 0) + totalAdvance,
        })
        .eq("id", salaryModal.id);
      if (err2) throw err2;

      alert(`✅ Avanset u kaluan në Borxh Afatgjatë për ${salaryModal.name}.`);
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

            {/* Formular i Editimit / Kartela e Punëtorit */}
            {editingId && (
              <div className="card mb-4 edit-card">
                <div className="card-header flex-between" style={{ background: 'transparent', borderBottom: '1px solid #BFDBFE' }}>
                  <div>
                    <h3 className="card-title" style={{ color: '#1D4ED8' }}>
                      {editingId === 'NEW' ? 'SHTO PUNËTOR TË RI' : 'KARTELA PROFESIONALE E PUNËTORIT'}
                    </h3>
                    {editingId !== 'NEW' && <div className="text-xs text-muted" style={{ marginTop: '6px' }}>Editim + histori financiare në një vend</div>}
                  </div>
                  <button onClick={() => { setEditingId(null); setWorkerHistory([]); }} className="close-btn">✕</button>
                </div>

                {editingId !== 'NEW' && (
                  <div className="inner-tabs">
                    <button className={`inner-tab ${profileTab === 'edit' ? 'active' : ''}`} onClick={() => setProfileTab('edit')}>TË DHËNAT & EDITIMI</button>
                    <button className={`inner-tab ${profileTab === 'history' ? 'active' : ''}`} onClick={() => setProfileTab('history')}>HISTORIKU FINANCIAR</button>
                  </div>
                )}

                {((editingId === 'NEW') || profileTab === 'edit') && (
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

                    <div className="grid-2">
                      <div>
                        <label className="field-label" style={{ color: '#1D4ED8' }}>Dita e Rrogës (1-31)</label>
                        <input type="number" inputMode="numeric" min="1" max="31" step="1" className="input full-width" placeholder="P.sh. 15" value={editForm.salary_day} onChange={e => setEditForm({ ...editForm, salary_day: onlyDigits(e.target.value).slice(0, 2) })} style={{ borderColor: '#93C5FD', background: '#EFF6FF' }} />
                        <span style={{ fontSize: '11px', color: '#1E40AF' }}>SHËNIM: Duhet të shtoni kolonën <strong>salary_day</strong> në Supabase.</span>
                      </div>
                      <div />
                    </div>

                    <div className="grid-2" style={{ borderTop: '1px dashed #BFDBFE', paddingTop: '16px' }}>
                      <div>
                        <label className="field-label" style={{ color: '#D97706' }}>Avans Manual (€)</label>
                        <input type="number" inputMode="numeric" min="0" step="1" className="input full-width" placeholder="P.sh. 50" value={editForm.avans_manual} onChange={e => setEditForm({ ...editForm, avans_manual: onlyDigits(e.target.value) })} style={{ borderColor: '#FCD34D', background: '#FFFBEB' }} />
                        <span style={{ fontSize: '11px', color: '#92400E' }}>Zbritet automatikisht te rroga vetëm nëse e zgjedh në fletëpagesë</span>
                      </div>
                      <div>
                        <label className="field-label" style={{ color: '#DC2626' }}>Borxh Afatgjatë (€)</label>
                        <input type="number" inputMode="numeric" min="0" step="1" className="input full-width" placeholder="P.sh. 1000" value={editForm.borxh_afatgjat} onChange={e => setEditForm({ ...editForm, borxh_afatgjat: onlyDigits(e.target.value) })} style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }} />
                        <span style={{ fontSize: '11px', color: '#991B1B' }}>Mund të zbritet pjesërisht nga fletëpagesa</span>
                      </div>
                    </div>

                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'bold', marginTop: '8px' }}>
                      <input type="checkbox" checked={editForm.is_active} onChange={e => setEditForm({ ...editForm, is_active: e.target.checked })} style={{ width: '18px', height: '18px' }} />
                      Llogari Aktive
                    </label>
                    <button className="btn-primary full-width" onClick={saveStaffEdit} disabled={actionBusy}>RUAJ TË DHËNAT</button>
                  </div>
                )}

                {(editingId !== 'NEW' && profileTab === 'history') && (
                  <div className="card-body">
                    {historyLoading ? (
                      <div className="empty-state">Po ngarkohet historiku financiar...</div>
                    ) : workerHistory.length === 0 ? (
                      <div className="empty-state">Nuk ka ende veprime financiare për këtë punëtor.</div>
                    ) : (
                      <div className="history-list">
                        {workerHistory.map(item => {
                          const badge = classifyHistoryItem(item);
                          return (
                            <div key={item.id} className="history-item">
                              <div className="history-top">
                                <div className="history-date">{fmtDateTime(item.created_at || item.applied_at)}</div>
                                <div className={`history-badge ${badge.cls}`}>{badge.label}</div>
                              </div>
                              <div className="history-amount">{euro(item.amount || 0)}</div>
                              <div className="history-note">{item.note || item.reject_note || 'Pa shënim'}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
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
                    const salaryDay = Number(u.salary_day || 0);
                    const salaryDue = salaryDay > 0 && todayDate >= salaryDay;

                    return (
                      <div key={u.id} className="list-item staff-row" style={{ opacity: u.is_active ? 1 : 0.5 }}>

                        <div className="staff-info">
                          <strong style={{ display: 'block', fontSize: '15px' }}>
                            {u.name}
                            {salaryDue && <span className="salary-alert-badge">⚠️ KOHA PËR RROGË</span>}
                          </strong>
                          <span className="text-xs text-muted" style={{ display: 'block', marginTop: '2px' }}>Roli: {u.role}{salaryDay > 0 ? ` • Dita e Rrogës: ${salaryDay}` : ''}</span>
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
                          <button className="btn-small btn-pay" onClick={() => setSalaryModal({ ...u, baseSalary, autoDebt, manualAdvance, totalAdvance, longTermDebt, deductOrders: autoDebt > 0, deductManual: manualAdvance > 0, longTermDeduction: '' })}>
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
              <h3 style={{ margin: 0, color: '#0F172A', letterSpacing: '1px' }}>SMART PAYROLL</h3>
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

              <label className="deduction-line">
                <div>
                  <input type="checkbox" checked={!!salaryModal.deductOrders} onChange={(e) => setSalaryModal({ ...salaryModal, deductOrders: e.target.checked })} />
                  <span>Zbrit Avansin nga Porositë ({euro(salaryModal.autoDebt)})</span>
                </div>
                <strong>- {euro(salaryModal.deductOrders ? salaryModal.autoDebt : 0)}</strong>
              </label>

              <label className="deduction-line">
                <div>
                  <input type="checkbox" checked={!!salaryModal.deductManual} onChange={(e) => setSalaryModal({ ...salaryModal, deductManual: e.target.checked })} />
                  <span>Zbrit Avansin Manual ({euro(salaryModal.manualAdvance)})</span>
                </div>
                <strong>- {euro(salaryModal.deductManual ? salaryModal.manualAdvance : 0)}</strong>
              </label>

              <div className="long-term-deduct-box">
                <label className="field-label" style={{ marginBottom: '8px', color: '#991B1B' }}>Zbrit nga Borxhi Afatgjatë (Opsionale)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  className="input full-width"
                  placeholder={`Maksimumi ${Number(salaryModal.longTermDebt || 0)}`}
                  value={salaryModal.longTermDeduction}
                  onChange={(e) => setSalaryModal({ ...salaryModal, longTermDeduction: onlyDigits(e.target.value) })}
                />
                <span className="text-xs text-muted" style={{ display: 'block', marginTop: '6px' }}>Borxhi aktual afatgjatë: {euro(salaryModal.longTermDebt)}</span>
              </div>

              <div className="receipt-total">
                <span>TOTALI PËR T'U PAGUAR:</span>
                <strong style={{ color: '#10B981', fontSize: '24px' }}>{euro(salaryToPay)}</strong>
              </div>
            </div>

            {salaryModal.longTermDebt > 0 && (
              <div className="long-term-info">
                ⚠️ <strong>Informacion:</strong> Ky punëtor ka një Borxh Afatgjatë prej <strong>{euro(salaryModal.longTermDebt)}</strong>. Mund të zbrisni një pjesë të tij nga kjo rrogë ose t'i kaloni avanset e mbetura në borxh afatgjatë.
              </div>
            )}

            <div className="salary-modal-actions">
              <button className="btn-outline btn-large" disabled={actionBusy} onClick={handleMoveAdvancesToLongTerm}>
                KALO AVANSET NË BORXH AFATGJATË
              </button>
              <button className="btn-success btn-large" disabled={actionBusy} onClick={handlePaySalary}>
                PAGUAJ RROGËN
              </button>
            </div>
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

        .inner-tabs { display: flex; gap: 8px; padding: 14px 20px 0 20px; background: transparent; }
        .inner-tab { flex: 1; border: 1px solid #BFDBFE; background: #DBEAFE; color: #1D4ED8; border-radius: 10px; padding: 10px 12px; font-size: 12px; font-weight: 800; cursor: pointer; }
        .inner-tab.active { background: white; color: #0F172A; border-color: #93C5FD; box-shadow: 0 2px 6px rgba(37,99,235,0.08); }

        .history-list { display: flex; flex-direction: column; gap: 12px; }
        .history-item { border: 1px solid #DBEAFE; background: white; border-radius: 12px; padding: 14px; }
        .history-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }
        .history-date { font-size: 12px; font-weight: 700; color: #64748B; }
        .history-amount { font-size: 19px; font-weight: 900; color: #0F172A; margin-bottom: 6px; }
        .history-note { font-size: 13px; color: #475569; line-height: 1.5; }
        .history-badge { padding: 5px 9px; border-radius: 999px; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.4px; }
        .history-badge-delivery { background: #DCFCE7; color: #166534; }
        .history-badge-advance { background: #FEF3C7; color: #92400E; }
        .history-badge-debt { background: #FEE2E2; color: #B91C1C; }
        .history-badge-salary { background: #DBEAFE; color: #1D4ED8; }
        .history-badge-default { background: #E2E8F0; color: #334155; }

        .staff-row { flex-wrap: wrap; gap: 12px; }
        .staff-info { flex: 1; min-width: 140px; }
        .salary-alert-badge { display: inline-block; margin-left: 8px; background: #FEF3C7; color: #92400E; border: 1px solid #FCD34D; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 900; vertical-align: middle; }
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
        .modal-content { width: 100%; max-width: 460px; background: white; border-radius: 24px; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); }
        .receipt-box { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 16px; padding: 20px; margin-bottom: 20px; }
        .receipt-row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 15px; font-weight: 600; color: #475569; }
        .deduction-line { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 14px; font-weight: 700; color: #334155; }
        .deduction-line > div { display: flex; align-items: center; gap: 8px; }
        .long-term-deduct-box { margin-top: 12px; margin-bottom: 12px; padding: 12px; border-radius: 12px; background: #FFF7ED; border: 1px solid #FED7AA; }
        .receipt-total { display: flex; justify-content: space-between; align-items: center; font-size: 16px; font-weight: 800; color: #0F172A; border-top: 2px dashed #CBD5E1; padding-top: 16px; margin-top: 16px; }
        .long-term-info { background: #FFFBEB; border: 1px solid #FEF3C7; color: #92400E; padding: 12px; border-radius: 12px; font-size: 12px; line-height: 1.5; margin-bottom: 20px; }
        .salary-modal-actions { display: flex; flex-direction: column; gap: 10px; }
      `}</style>
    </div>
  );
}
