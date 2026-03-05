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

export default function StaffAndDevicesDashboard() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [masterPin, setMasterPin] = useState("");

  // States
  const [pending, setPending] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Create / Approve Form
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [createForm, setCreateForm] = useState({ name: "", role: "PUNTOR", pin: "", label: "" });
  const [actionBusy, setActionBusy] = useState(false);

  // Edit Staff Form
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", role: "PUNTOR", pin: "", is_active: true });

  useEffect(() => {
    const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!a) return router.push("/login");
    setActor(a);
    
    const savedPin = localStorage.getItem("MASTER_ADMIN_PIN") || "";
    if (savedPin) setMasterPin(savedPin);
    
    reloadAll(savedPin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function api(action, payload = {}) {
    const pinToUse = payload.master_pin || masterPin;
    if (!pinToUse) {
      alert("Ju lutem vendosni Master PIN-in e Adminit lart!");
      return null;
    }
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, master_pin: pinToUse, ...payload }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "GABIM NË SERVER");
      return json;
    } catch (e) {
      alert("ERROR: " + String(e?.message || e));
      return null;
    }
  }

  async function reloadAll(pinOverride = null) {
    setLoading(true);
    try {
      // 1. Lexo Stafin
      const { data: st } = await supabase.from("tepiha_users").select("*").order("created_at", { ascending: false });
      setStaff(st || []);

      // 2. Lexo Pajisjet
      const p = pinOverride !== null ? pinOverride : masterPin;
      if (p) {
        const json = await api("list", { master_pin: p });
        if (json?.items) setPending(json.items.filter(x => !x.is_approved));
      }
    } finally {
      setLoading(false);
    }
  }

  // --- ACTIONS: APROVIMI ---
  async function handleCreateAndApprove() {
    if (!selectedDevice) return alert("Zgjidh një pajisje!");
    if (!createForm.name) return alert("Shkruaj emrin e punëtorit!");
    if (createForm.pin.length < 4) return alert("PIN duhet të ketë së paku 4 shifra!");

    setActionBusy(true);
    const r = await api("create_user_and_approve", {
      device_id: selectedDevice.device_id,
      name: createForm.name,
      role: createForm.role,
      pin: createForm.pin,
      label: createForm.label
    });
    if (r) {
      alert("✅ Punëtori u krijua dhe pajisja u aprovua!");
      cancelCreate();
      reloadAll();
    }
    setActionBusy(false);
  }

  async function handleLinkAndApprove() {
    if (!selectedDevice) return alert("Zgjidh një pajisje!");
    if (createForm.pin.length < 4) return alert("Shkruaj PIN-in e punëtorit ekzistues!");

    setActionBusy(true);
    const r = await api("link_user_and_approve", {
      device_id: selectedDevice.device_id,
      pin: createForm.pin,
      label: createForm.label
    });
    if (r) {
      alert("✅ Pajisja u lidh me sukses!");
      cancelCreate();
      reloadAll();
    }
    setActionBusy(false);
  }

  function pickPending(d) {
    setSelectedDevice(d);
    setCreateForm({
      name: d?.tepiha_users?.name || "",
      role: safeUpper(d?.requested_role, "PUNTOR"),
      pin: onlyDigits(d?.requested_pin || ""),
      label: d?.label || ""
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelCreate() {
    setSelectedDevice(null);
    setCreateForm({ name: "", role: "PUNTOR", pin: "", label: "" });
  }

  // --- ACTIONS: STAFI ---
  function startEdit(u) {
    setEditingId(u.id);
    setEditForm({ name: u.name || "", role: safeUpper(u.role), pin: "", is_active: u.is_active !== false });
  }

  async function saveStaffEdit() {
    setActionBusy(true);
    const payload = {
      name: editForm.name,
      role: editForm.role,
      is_active: editForm.is_active
    };
    if (editForm.pin.length >= 4) payload.pin = editForm.pin;

    const { error } = await supabase.from("tepiha_users").update(payload).eq("id", editingId);
    if (error) alert("GABIM: " + error.message);
    else {
      setEditingId(null);
      reloadAll();
    }
    setActionBusy(false);
  }

  async function toggleBlock(u) {
    const { error } = await supabase.from("tepiha_users").update({ is_active: !u.is_active }).eq("id", u.id);
    if (!error) reloadAll();
  }

  return (
    <div className="proDashboard">
      <div className="container">
        
        {/* HEADER & MASTER PIN */}
        <div className="headerArea">
          <div className="flex-between">
            <div>
              <h1 className="title">MENAXHIMI I STAFIT</h1>
              <p className="subtitle">Mirësevini, {actor?.name} ({actor?.role})</p>
            </div>
            <Link href="/arka" className="btn-outline">KTHEHU NË ARKË</Link>
          </div>

          <div className="masterPinBox">
            <div className="pinInfo">
              <span className="icon">🔒</span>
              <div>
                <strong>Master PIN i Mjeshtrit</strong>
                <p>E domosdoshme për të aprovuar pajisje.</p>
              </div>
            </div>
            <div className="pinInputGroup">
              <input
                type="password"
                className="input shadow-sm"
                placeholder="****"
                value={masterPin}
                onChange={(e) => {
                  const val = onlyDigits(e.target.value);
                  setMasterPin(val);
                  localStorage.setItem("MASTER_ADMIN_PIN", val);
                }}
              />
              <button className="btn-primary" onClick={() => reloadAll()}>REFRESH</button>
            </div>
          </div>
        </div>

        <div className="grid-layout">
          
          {/* KOLONA E MAJTË: PAJISJET NË PRITJE & KRIJIMI */}
          <div className="col">
            
            {/* FORMULARI I APROVIMIT (Shfaqet vetëm kur klikon një pajisje) */}
            {selectedDevice && (
              <div className="card highlightCard mb-4">
                <div className="card-header flex-between">
                  <h3 className="card-title text-blue">Aprovo: {shortDevice(selectedDevice.device_id)}</h3>
                  <button className="btn-close" onClick={cancelCreate}>✕</button>
                </div>
                <div className="card-body form-stack">
                  <div className="field">
                    <label>Emri Mbiemri</label>
                    <input className="input" value={createForm.name} onChange={e => setCreateForm({...createForm, name: e.target.value})} placeholder="Emri..." />
                  </div>
                  <div className="grid-2">
                    <div className="field">
                      <label>Roli</label>
                      <select className="input" value={createForm.role} onChange={e => setCreateForm({...createForm, role: e.target.value})}>
                        {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>PIN (4+ numra)</label>
                      <input className="input" value={createForm.pin} onChange={e => setCreateForm({...createForm, pin: onlyDigits(e.target.value)})} placeholder="****" />
                    </div>
                  </div>
                  <div className="field">
                    <label>Emri i Telefonit (Opsionale)</label>
                    <input className="input" value={createForm.label} onChange={e => setCreateForm({...createForm, label: e.target.value})} placeholder="p.sh. iPhone Bujari" />
                  </div>
                  <div className="grid-2 mt-2">
                    <button className="btn-success" onClick={handleCreateAndApprove} disabled={actionBusy}>
                      KRIJO TË RI
                    </button>
                    <button className="btn-outline" onClick={handleLinkAndApprove} disabled={actionBusy}>
                      LIDH EKZISTUES
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* LISTA E PAJISJEVE NË PRITJE */}
            <div className="card">
              <div className="card-header">
                <h3 className="card-title text-orange">Pajisjet në Pritje ({pending.length})</h3>
              </div>
              <div className="card-body p-0">
                {pending.length === 0 ? (
                  <div className="empty-state">Nuk ka asnjë pajisje të re që pret aprovim.</div>
                ) : (
                  pending.map(d => (
                    <div key={d.id} className={`list-item ${selectedDevice?.id === d.id ? 'selected' : ''}`} onClick={() => pickPending(d)}>
                      <div className="item-info">
                        <span className="badge badge-orange">E RE</span>
                        <div>
                          <strong>{d.label || "Telefon i Panjohur"}</strong>
                          <p className="text-muted text-sm mono">{shortDevice(d.device_id)}</p>
                        </div>
                      </div>
                      <div className="item-meta text-right">
                        <span className="text-xs text-muted">PIN i kërkuar:</span>
                        <br/><strong>{d.requested_pin || "S'ka"}</strong>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* KOLONA E DJATHTË: LISTA E STAFIT DHE EDITIMI */}
          <div className="col">
            
            {/* FORMULARI I EDITIMIT TË STAFIT */}
            {editingId && (
              <div className="card mb-4 border-blue">
                <div className="card-header flex-between">
                  <h3 className="card-title text-blue">Edito Punëtorin</h3>
                  <button className="btn-close" onClick={() => setEditingId(null)}>✕</button>
                </div>
                <div className="card-body form-stack">
                  <div className="grid-2">
                    <div className="field">
                      <label>Emri</label>
                      <input className="input" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} />
                    </div>
                    <div className="field">
                      <label>Roli</label>
                      <select className="input" value={editForm.role} onChange={e => setEditForm({...editForm, role: e.target.value})}>
                        {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid-2 align-center">
                    <div className="field">
                      <label>Ndrysho PIN (Opsionale)</label>
                      <input className="input" placeholder="Lëre bosh për të mos ndryshuar" value={editForm.pin} onChange={e => setEditForm({...editForm, pin: onlyDigits(e.target.value)})} />
                    </div>
                    <label className="checkbox-wrap mt-4">
                      <input type="checkbox" checked={editForm.is_active} onChange={e => setEditForm({...editForm, is_active: e.target.checked})} />
                      <span>Punëtor Aktiv</span>
                    </label>
                  </div>
                  <button className="btn-primary w-full mt-2" onClick={saveStaffEdit} disabled={actionBusy}>RUAJ NDRYSHIMET</button>
                </div>
              </div>
            )}

            {/* LISTA E STAFIT */}
            <div className="card">
              <div className="card-header flex-between">
                <h3 className="card-title">Lista e Stafit</h3>
                <span className="badge badge-gray">{staff.length} TOTAL</span>
              </div>
              <div className="card-body p-0">
                {loading ? <div className="empty-state">Po ngarkohet...</div> : staff.map(u => (
                  <div key={u.id} className="list-item staff-item">
                    <div className="item-info">
                      <div className={`status-dot ${u.is_active ? 'active' : 'blocked'}`}></div>
                      <div>
                        <strong>{u.name}</strong>
                        <p className="text-muted text-xs mt-1">{u.role} • PIN: ****</p>
                      </div>
                    </div>
                    <div className="item-actions">
                      <button className="btn-small btn-light" onClick={() => startEdit(u)}>✏️ EDIT</button>
                      <button className={`btn-small ${u.is_active ? 'btn-danger-light' : 'btn-success-light'}`} onClick={() => toggleBlock(u)}>
                        {u.is_active ? '⛔ BLLOKO' : '✅ HAP'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>

      <style jsx>{`
        /* TEMË E NDRITSHME DHE MODERNE */
        .proDashboard { background-color: #F8FAFC; min-height: 100vh; padding: 24px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0F172A; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        .headerArea { margin-bottom: 32px; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .title { font-size: 24px; font-weight: 800; color: #1E293B; margin: 0; letter-spacing: -0.5px; }
        .subtitle { font-size: 14px; color: #64748B; margin-top: 4px; font-weight: 500; }
        
        .masterPinBox { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; margin-top: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); flex-wrap: wrap; gap: 16px; }
        .pinInfo { display: flex; align-items: center; gap: 12px; }
        .pinInfo .icon { font-size: 24px; background: #F1F5F9; padding: 10px; border-radius: 10px; }
        .pinInfo strong { font-size: 15px; color: #0F172A; }
        .pinInfo p { font-size: 13px; color: #64748B; margin: 2px 0 0 0; }
        .pinInputGroup { display: flex; gap: 12px; flex: 1; max-width: 300px; }

        .grid-layout { display: grid; grid-template-columns: 1fr; gap: 24px; }
        @media(min-width: 900px) { .grid-layout { grid-template-columns: 1fr 1.2fr; } }
        
        .card { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #F1F5F9; background: #FAFAF9; }
        .card-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 0; color: #334155; }
        .card-body { padding: 20px; }
        .p-0 { padding: 0 !important; }
        .mb-4 { margin-bottom: 24px; }
        .mt-2 { margin-top: 12px; }
        .mt-4 { margin-top: 24px; }
        .w-full { width: 100%; }

        .text-blue { color: #2563EB; }
        .text-orange { color: #EA580C; }
        .text-muted { color: #64748B; }
        .text-sm { font-size: 13px; }
        .text-xs { font-size: 11px; }
        .text-right { text-align: right; }
        .mono { font-family: monospace; }
        
        .highlightCard { border: 2px solid #BFDBFE; background: #EFF6FF; }
        .highlightCard .card-header { background: #DBEAFE; border-bottom-color: #BFDBFE; }
        .border-blue { border-color: #BFDBFE; }

        .form-stack { display: flex; flex-direction: column; gap: 16px; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .align-center { align-items: center; }
        
        .field label { display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; }
        .input { width: 100%; padding: 12px 14px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 14px; color: #0F172A; background: #FFFFFF; transition: 0.2s; box-sizing: border-box; }
        .input:focus { outline: none; border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
        .shadow-sm { box-shadow: inset 0 1px 2px rgba(0,0,0,0.05); }

        .btn-primary { background: #2563EB; color: white; border: none; padding: 12px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.2s; }
        .btn-primary:hover { background: #1D4ED8; }
        .btn-success { background: #10B981; color: white; border: none; padding: 12px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.2s; }
        .btn-success:hover { background: #059669; }
        .btn-outline { background: #FFFFFF; border: 1px solid #CBD5E1; color: #334155; padding: 12px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.2s; text-decoration: none; }
        .btn-outline:hover { background: #F8FAFC; border-color: #94A3B8; }
        .btn-close { background: none; border: none; font-size: 16px; color: #64748B; cursor: pointer; }
        .btn-close:hover { color: #0F172A; }

        .btn-small { padding: 8px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; border: 1px solid transparent; transition: 0.2s; }
        .btn-light { background: #F1F5F9; color: #475569; border-color: #E2E8F0; }
        .btn-light:hover { background: #E2E8F0; color: #0F172A; }
        .btn-danger-light { background: #FEF2F2; color: #EF4444; border-color: #FEE2E2; }
        .btn-danger-light:hover { background: #FEE2E2; }
        .btn-success-light { background: #F0FDF4; color: #10B981; border-color: #DCFCE7; }
        .btn-success-light:hover { background: #DCFCE7; }

        .list-item { padding: 16px 20px; border-bottom: 1px solid #F1F5F9; display: flex; justify-content: space-between; align-items: center; transition: 0.2s; cursor: pointer; }
        .list-item:hover { background: #F8FAFC; }
        .list-item:last-child { border-bottom: none; }
        .list-item.selected { background: #EFF6FF; border-left: 3px solid #3B82F6; }
        .staff-item { cursor: default; }

        .item-info { display: flex; align-items: center; gap: 14px; }
        .item-info strong { font-size: 15px; color: #0F172A; }
        .item-actions { display: flex; gap: 8px; }

        .badge { padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 800; letter-spacing: 0.5px; }
        .badge-orange { background: #FFF7ED; color: #EA580C; border: 1px solid #FFEDD5; }
        .badge-gray { background: #F1F5F9; color: #475569; border: 1px solid #E2E8F0; }

        .status-dot { width: 10px; height: 10px; border-radius: 50%; }
        .status-dot.active { background: #10B981; box-shadow: 0 0 0 3px #D1FAE5; }
        .status-dot.blocked { background: #EF4444; box-shadow: 0 0 0 3px #FEE2E2; }

        .empty-state { padding: 40px; text-align: center; color: #94A3B8; font-size: 14px; font-weight: 500; }
        
        .checkbox-wrap { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; font-weight: 600; color: #334155; }
        .checkbox-wrap input { width: 18px; height: 18px; cursor: pointer; accent-color: #2563EB; }
      `}</style>
    </div>
  );
}
