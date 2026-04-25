"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter } from "@/lib/routerCompat.jsx";
import { supabase } from "@/lib/supabaseClient";
import { createUserRecord, deleteUserRecord, fetchUserById, listUserRecords, updateUserRecord } from "@/lib/usersService";

function jparse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function safeUpper(v, fallback = "") { return String(v || "").trim().toUpperCase() || fallback; }
function shortDevice(did) {
  const raw = String(did || "");
  if (!raw) return "—";
  return raw.length <= 14 ? raw : raw.slice(0, 10) + "...";
}
function normalizeDbError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || "");
  const low = msg.toLowerCase();

  if (low.includes("duplicate key") && low.includes("pin")) {
    return "⚠️ Ky PIN po përdoret nga një anëtar tjetër i stafit. Zgjidhni një PIN unik.";
  }
  if (low.includes("schema cache") || low.includes("could not find")) {
    return "⏳ Sistemi po përditësohet. Prisni pak dhe provoni përsëri.";
  }
  return msg || "Ndodhi një gabim i panjohur.";
}

const AUTH_REPAIR_WAIT_MS = 1800;

export default function StaffPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [masterPin, setMasterPin] = useState("");

  const [pending, setPending] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    role: "PUNTOR",
    pin: "",
    is_active: true,
    bonus_transport: 0,
    bonus_ushqim: 0,
    is_hybrid_transport: false,
    commission_rate_m2: 0.5,
  });

  const normalizedRole = String(actor?.role || '').toUpperCase();
  const canManageStaff = ['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizedRole);

  const pendingCount = pending.length;
  const activeCount = useMemo(
    () => (staff || []).filter((u) => u.is_active !== false).length,
    [staff]
  );

  useEffect(() => {
    let cancelled = false;

    const boot = () => {
      const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
      if (!a) return false;

      setActor(a);
      try { localStorage.removeItem("MASTER_ADMIN_PIN"); } catch {}

      const role = String(a?.role || '').toUpperCase();
      if (!["ADMIN", "ADMIN_MASTER", "DISPATCH", "OWNER", "PRONAR", "SUPERADMIN"].includes(role)) {
        router.push('/arka');
        return true;
      }

      void reloadAll(false);
      return true;
    };

    if (boot()) return undefined;

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (boot()) return;
      router.push("/login");
    }, AUTH_REPAIR_WAIT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router]);

  async function reloadAll(isSilent = false) {
    if (!isSilent) setLoading(true);

    try {
      const st = await listUserRecords({ orderBy: "name", ascending: true, eq: { is_active: true } });
      setStaff((st || []).filter((u) => u?.is_active !== false));

      const { data: rawDevices, error: devErr } = await supabase
        .from("tepiha_user_devices")
        .select("*")
        .eq("is_approved", false)
        .order("created_at", { ascending: false });

      if (devErr) throw devErr;

      const usersMap = {};
      (st || []).forEach((u) => {
        usersMap[u.id] = u;
        if (u.pin) usersMap[u.pin] = u;
      });

      const hydrated = (rawDevices || []).map((d) => ({
        ...d,
        tepiha_users: d.requested_pin ? usersMap[d.requested_pin] : usersMap[d.user_id],
      }));
      setPending(hydrated);
    } catch (err) {
      console.error("Gabim sinkronizimi:", err);
      alert("GABIM: " + normalizeDbError(err));
    } finally {
      if (!isSilent) setLoading(false);
    }
  }

  async function handleOneClickApprove(device) {
    if (!masterPin) return alert("Shkruaj Master PIN-in për ta aprovuar pajisjen.");
    setActionBusy(true);
    try {
      const { error } = await supabase
        .from("tepiha_user_devices")
        .update({
          is_approved: true,
          approved_at: new Date().toISOString(),
        })
        .eq("device_id", device.device_id);

      if (error) throw error;

      alert("✅ Pajisja u aprovua me sukses.");
      await reloadAll(false);
    } catch (e) {
      alert("GABIM: " + normalizeDbError(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReject(device) {
    if (!confirm("A dëshironi ta fshini këtë kërkesë pajisjeje?")) return;
    setActionBusy(true);
    try {
      const { error } = await supabase
        .from("tepiha_user_devices")
        .delete()
        .eq("device_id", device.device_id);

      if (error) throw error;
      await reloadAll(false);
    } catch (e) {
      alert("GABIM: " + normalizeDbError(e));
    } finally {
      setActionBusy(false);
    }
  }


  async function handleDeleteStaff(u) {
    if (!u?.id && !u?.pin) return;
    if (String(u?.id || '') === String(actor?.id || '')) {
      alert('Nuk mund ta fshini vetveten nga ky ekran.');
      return;
    }
    const ok = window.confirm(`A jeni i sigurt që dëshironi ta fshini ${u?.name || 'këtë përdorues'}?`);
    if (!ok) return;
    setActionBusy(true);
    try {
      const res = await deleteUserRecord(u);
      if (editingId === u.id) setEditingId(null);
      setStaff((prev) => (prev || []).filter((row) => {
        const sameId = String(row?.id || '') && String(row?.id || '') === String(u?.id || '');
        const samePin = String(row?.pin || '') && String(row?.pin || '') === String(u?.pin || '');
        return !(sameId || samePin);
      }));
      await reloadAll(false);

      if (res?.mode === 'deleted') {
        alert(`✅ ${u?.name || 'Përdoruesi'} u fshi me sukses.`);
        return;
      }
      if (res?.mode === 'deactivated') {
        alert(`✅ ${u?.name || 'Përdoruesi'} u çaktivizua dhe u hoq nga lista aktive.`);
        return;
      }
      if (res?.mode === 'not_found') {
        alert(`✅ ${u?.name || 'Përdoruesi'} nuk u gjet më në DB dhe u hoq nga lista lokale.`);
        return;
      }
      alert(`✅ Veprimi u krye për ${u?.name || 'përdoruesin'}.`);
    } catch (e) {
      console.error('DELETE STAFF ERROR', e, u);
      alert('GABIM: ' + normalizeDbError(e));
    } finally {
      setActionBusy(false);
    }
  }

  function startCreateStaff() {
    setEditingId("NEW");
    setEditForm({
      name: "",
      role: "PUNTOR",
      pin: "",
      is_active: true,
      bonus_transport: 0,
      bonus_ushqim: 0,
      is_hybrid_transport: false,
      commission_rate_m2: 0.5,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(u) {
    setEditingId(u.id);
    setEditForm({
      name: u.name || "",
      role: safeUpper(u.role, "PUNTOR"),
      pin: "",
      is_active: u.is_active !== false,
      bonus_transport: Number(u.bonus_transport || 0),
      bonus_ushqim: Number(u.bonus_ushqim || 0),
      is_hybrid_transport: u.is_hybrid_transport === true,
      commission_rate_m2: Number(u.commission_rate_m2 ?? 0.5),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveStaffEdit() {
    if (!String(editForm.name || "").trim()) return alert("Ju lutem shkruani emrin.");
    setActionBusy(true);

    const payload = {
      name: String(editForm.name || "").trim(),
      role: safeUpper(editForm.role, "PUNTOR"),
      is_active: !!editForm.is_active,
      bonus_transport: Number(editForm.bonus_transport || 0),
      bonus_ushqim: Number(editForm.bonus_ushqim || 0),
      is_hybrid_transport: !!editForm.is_hybrid_transport,
      commission_rate_m2: Number(editForm.commission_rate_m2 || 0),
    };

    try {
      if (editingId === "NEW") {
        if (String(editForm.pin || "").trim().length < 4) {
          alert("PIN duhet të ketë të paktën 4 shifra.");
          setActionBusy(false);
          return;
        }
        payload.pin = onlyDigits(editForm.pin);

        await createUserRecord(payload);
      } else {
        if (String(editForm.pin || "").trim().length >= 4) {
          const currentUser = await fetchUserById(editingId, "pin");
          const nextPin = onlyDigits(editForm.pin);
          if (nextPin && nextPin !== String(currentUser?.pin || "")) {
            payload.pin = nextPin;
          }
        }

        await updateUserRecord(editingId, payload);
      }

      setEditingId(null);
      await reloadAll(false);
    } catch (err) {
      alert("GABIM: " + normalizeDbError(err));
    } finally {
      setActionBusy(false);
    }
  }

  if (actor && !canManageStaff) return null;

  return (
    <div className="staffPage">
      <div className="shell">
        <div className="topbar">
          <div>
            <div className="eyebrow">Arka / Stafi</div>
            <h1 className="title">Menaxhimi i Stafit & Pajisjeve</h1>
            <p className="subtitle">
              Pamje e lehtë dhe e qartë për aprovime, krijim dhe editim të stafit.
            </p>
          </div>

          <div className="topActions">
            <Link prefetch={false} href="/arka" className="navBtn">← KTHEHU NË ARKË</Link>
            <Link prefetch={false} href="/arka/payroll" className="navBtn primaryGhost">FINANCAT / PAYROLL</Link>
          </div>
        </div>

        <div className="stats">
          <div className="statCard">
            <span className="statLabel">Kërkesa Pajisjesh</span>
            <strong className="statValue">{pendingCount}</strong>
          </div>
          <div className="statCard">
            <span className="statLabel">Staf Aktiv</span>
            <strong className="statValue">{activeCount}</strong>
          </div>
          <div className="statCard pinCard">
            <div>
              <span className="statLabel">Master PIN</span>
              <div className="pinHint">Kërkohet për aprovime pajisjesh</div>
            </div>
            <input
              type="password"
              className="pinInput"
              placeholder="****"
              value={masterPin}
              onChange={(e) => {
                const val = onlyDigits(e.target.value);
                setMasterPin(val);
              }}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="grid">
          <section className="panel">
            <div className="panelTop">
              <div>
                <div className="panelEyebrow">Pending Devices</div>
                <h2 className="panelTitle">Aprovimet e Pajisjeve</h2>
              </div>
              <button className="miniBtn" onClick={() => reloadAll(false)} disabled={actionBusy}>
                REFRESH
              </button>
            </div>

            {loading ? (
              <div className="empty">Po lexohen pajisjet...</div>
            ) : pending.length === 0 ? (
              <div className="empty">Nuk ka kërkesa të reja për aprovime.</div>
            ) : (
              <div className="stack">
                {pending.map((d) => (
                  <div className="deviceCard" key={d.device_id}>
                    <div className="deviceMain">
                      <div className="deviceName">{d.tepiha_users?.name || "Përdorues i panjohur"}</div>
                      <div className="deviceMeta">
                        PIN: <strong>{d.requested_pin || "—"}</strong> · Pajisja: {shortDevice(d.device_id)}
                      </div>
                      <div className="deviceMeta">
                        Kërkuar më: {d.created_at ? new Date(d.created_at).toLocaleString("sq-AL") : "—"}
                      </div>
                    </div>

                    <div className="deviceActions">
                      <button
                        className="rejectBtn"
                        onClick={() => handleReject(d)}
                        disabled={actionBusy}
                      >
                        REFUZO / FSHIJ
                      </button>
                      <button
                        className="approveBtn"
                        onClick={() => handleOneClickApprove(d)}
                        disabled={actionBusy}
                      >
                        ✅ APROVO PAJISJEN
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panelTop">
              <div>
                <div className="panelEyebrow">Staff Manager</div>
                <h2 className="panelTitle">Stafi</h2>
              </div>
              <button className="addBtn" onClick={startCreateStaff}>
                + SHTO STAF
              </button>
            </div>

            {editingId && (
              <div className="editorCard">
                <div className="editorTop">
                  <div>
                    <div className="panelEyebrow">Editor</div>
                    <div className="editorTitle">
                      {editingId === "NEW" ? "Shto Anëtar të Ri" : "Edito Anëtarin"}
                    </div>
                  </div>
                  <button className="closeBtn" onClick={() => setEditingId(null)}>✕</button>
                </div>

                <div className="formGrid">
                  <label className="field">
                    <span>Emri i plotë</span>
                    <input
                      className="fieldInput"
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      placeholder="P.sh. Arben Oruci"
                    />
                  </label>

                  <label className="field">
                    <span>Roli</span>
                    <select
                      className="fieldInput"
                      value={editForm.role}
                      onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                    >
                      {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span>{editingId === "NEW" ? "PIN i qasjes" : "Ndrysho PIN (opsionale)"}</span>
                    <input
                      className="fieldInput"
                      value={editForm.pin}
                      onChange={(e) => setEditForm({ ...editForm, pin: onlyDigits(e.target.value) })}
                      placeholder="****"
                      inputMode="numeric"
                    />
                  </label>

                  <label className="toggleField">
                    <span>Llogari aktive</span>
                    <input
                      type="checkbox"
                      checked={editForm.is_active}
                      onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                    />
                  </label>

                  <label className="field">
                    <span>BONUS TRANSPORT (€)</span>
                    <input
                      className="fieldInput"
                      value={editForm.bonus_transport}
                      onChange={(e) => setEditForm({ ...editForm, bonus_transport: e.target.value })}
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </label>

                  <label className="field">
                    <span>BONUS USHQIM (€)</span>
                    <input
                      className="fieldInput"
                      value={editForm.bonus_ushqim}
                      onChange={(e) => setEditForm({ ...editForm, bonus_ushqim: e.target.value })}
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </label>

                  <label className="toggleField hybridToggleField">
                    <span>AKTIVIZO KOMISIONIN E TRANSPORTIT</span>
                    <input
                      type="checkbox"
                      checked={editForm.is_hybrid_transport}
                      onChange={(e) => setEditForm({ ...editForm, is_hybrid_transport: e.target.checked })}
                    />
                  </label>

                  <label className="field">
                    <span>KOMISIONI PËR M2 (€)</span>
                    <input
                      className="fieldInput"
                      value={editForm.commission_rate_m2}
                      onChange={(e) => setEditForm({ ...editForm, commission_rate_m2: e.target.value })}
                      placeholder="0.50"
                      inputMode="decimal"
                    />
                  </label>
                </div>

                <div className="editorActions">
                  <button className="saveBtn" onClick={saveStaffEdit} disabled={actionBusy}>
                    RUAJ TË DHËNAT
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="empty">Po lexohet stafi...</div>
            ) : staff.length === 0 ? (
              <div className="empty">Nuk ka asnjë anëtar stafi.</div>
            ) : (
              <div className="stack">
                {staff.map((u) => (
                  <div className="staffCard" key={u.id} style={{ opacity: u.is_active === false ? 0.62 : 1 }}>
                    <div className="staffMain">
                      <div className="staffNameRow">
                        <div className="staffName">{u.name || "Pa emër"}</div>
                        <span className={`statusPill ${u.is_active === false ? "off" : "on"}`}>
                          {u.is_active === false ? "JOAKTIV" : "AKTIV"}
                        </span>
                      </div>
                      <div className="staffMeta">
                        Roli: <strong>{u.role || "—"}</strong>
                      </div>
                      <div className="staffMeta">
                        PIN: <strong>{u.pin || "—"}</strong>
                      </div>
                      <div className="staffMeta">
                        Hybrid transport: <strong>{u.is_hybrid_transport ? "PO" : "JO"}</strong>
                      </div>
                      {u.is_hybrid_transport ? (
                        <div className="staffMeta">
                          Komisioni / m²: <strong>{Number(u.commission_rate_m2 || 0).toFixed(2)}€</strong>
                        </div>
                      ) : null}
                    </div>

                    <div className="staffActions">
                      <button className="editBtn" onClick={() => startEdit(u)}>
                        ✏️ EDITO
                      </button>
                      <button className="deleteBtn" onClick={() => handleDeleteStaff(u)} disabled={actionBusy}>
                        🗑️ FSHI
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <style jsx>{`
        .staffPage {
          min-height: 100vh;
          background: #f8fafc;
          color: #0f172a;
          padding: 28px 16px 40px;
          font-family: Inter, system-ui, -apple-system, sans-serif;
        }
        .shell { max-width: 1220px; margin: 0 auto; }
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }
        .eyebrow {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: .14em;
          color: #64748b;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .title {
          margin: 0;
          font-size: clamp(28px, 3vw, 40px);
          line-height: 1.03;
          letter-spacing: -.04em;
          font-weight: 900;
          color: #0f172a;
        }
        .subtitle {
          margin: 10px 0 0;
          color: #475569;
          font-size: 15px;
          max-width: 720px;
        }
        .topActions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .navBtn {
          text-decoration: none;
          background: #fff;
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 12px 16px;
          font-weight: 800;
          box-shadow: 0 4px 6px rgba(0,0,0,.05);
        }
        .primaryGhost {
          color: #0f766e;
          border-color: #ccfbf1;
          background: #f0fdfa;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
          margin-bottom: 18px;
        }
        .statCard {
          background: #fff;
          border-radius: 20px;
          padding: 20px;
          box-shadow: 0 4px 6px rgba(0,0,0,.05);
          border: 1px solid #eef2f7;
          min-height: 108px;
        }
        .statLabel {
          display: block;
          color: #64748b;
          font-size: 12px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .12em;
          margin-bottom: 10px;
        }
        .statValue {
          font-size: 34px;
          line-height: 1;
          letter-spacing: -.05em;
          font-weight: 900;
          color: #0f172a;
        }
        .pinCard {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }
        .pinHint {
          color: #64748b;
          font-size: 13px;
          margin-top: 4px;
        }
        .pinInput {
          min-width: 120px;
          border: 1px solid #dbe4ef;
          background: #fff;
          border-radius: 14px;
          padding: 14px 16px;
          font-size: 16px;
          font-weight: 800;
          outline: none;
        }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1.2fr;
          gap: 18px;
        }
        .panel {
          background: #fff;
          border-radius: 24px;
          box-shadow: 0 4px 6px rgba(0,0,0,.05);
          border: 1px solid #eef2f7;
          padding: 20px;
        }
        .panelTop {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .panelEyebrow {
          font-size: 11px;
          font-weight: 900;
          color: #94a3b8;
          letter-spacing: .14em;
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .panelTitle {
          margin: 0;
          font-size: 24px;
          font-weight: 900;
          letter-spacing: -.03em;
          color: #111827;
        }
        .miniBtn, .addBtn, .approveBtn, .rejectBtn, .editBtn, .deleteBtn, .saveBtn, .closeBtn {
          border: none;
          cursor: pointer;
          transition: .18s ease;
        }
        .miniBtn {
          background: #f8fafc;
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 10px 12px;
          font-weight: 800;
        }
        .addBtn {
          background: #0f172a;
          color: #fff;
          border-radius: 14px;
          padding: 12px 16px;
          font-weight: 900;
          box-shadow: 0 10px 20px rgba(15,23,42,.08);
        }
        .stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .deviceCard, .staffCard, .editorCard {
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 20px;
          box-shadow: 0 4px 6px rgba(0,0,0,.05);
        }
        .deviceCard {
          padding: 16px;
        }
        .deviceMain, .staffMain {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .deviceName, .staffName {
          font-size: 20px;
          font-weight: 900;
          letter-spacing: -.03em;
          color: #111827;
        }
        .deviceMeta, .staffMeta {
          color: #64748b;
          font-size: 14px;
        }
        .deviceActions, .staffActions {
          display: flex;
          gap: 10px;
          margin-top: 14px;
          flex-wrap: wrap;
        }
        .approveBtn {
          flex: 1.2;
          min-height: 52px;
          border-radius: 16px;
          background: linear-gradient(180deg, #22c55e 0%, #16a34a 100%);
          color: #fff;
          font-weight: 900;
          font-size: 15px;
          box-shadow: 0 10px 18px rgba(34,197,94,.18);
        }
        .rejectBtn {
          flex: 1;
          min-height: 52px;
          border-radius: 16px;
          background: #fff1f2;
          color: #be123c;
          border: 1px solid #fecdd3;
          font-weight: 900;
          font-size: 14px;
        }
        .staffNameRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .statusPill {
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: .08em;
        }
        .statusPill.on {
          color: #166534;
          background: #dcfce7;
        }
        .statusPill.off {
          color: #991b1b;
          background: #fee2e2;
        }
        .editBtn {
          min-height: 46px;
          border-radius: 14px;
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
          font-weight: 900;
          padding: 0 16px;
        }
        .deleteBtn {
          min-height: 46px;
          border-radius: 14px;
          background: #fff1f2;
          color: #be123c;
          border: 1px solid #fecdd3;
          font-weight: 900;
          padding: 0 16px;
        }
        .editorCard {
          padding: 18px;
          margin-bottom: 14px;
          background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
        }
        .editorTop {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 14px;
        }
        .editorTitle {
          font-size: 22px;
          line-height: 1.1;
          font-weight: 900;
          color: #111827;
          letter-spacing: -.03em;
        }
        .closeBtn {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: #f8fafc;
          color: #334155;
          border: 1px solid #e2e8f0;
          font-weight: 900;
        }
        .formGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .field span, .toggleField span {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: .12em;
          color: #64748b;
          font-weight: 900;
        }
        .fieldInput {
          width: 100%;
          border: 1px solid #dbe4ef;
          background: #fff;
          border-radius: 16px;
          padding: 16px;
          font-size: 15px;
          font-weight: 700;
          color: #0f172a;
          outline: none;
          box-sizing: border-box;
        }
        .toggleField {
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          gap: 12px;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 16px;
        }
        .toggleField input {
          width: 22px;
          height: 22px;
        }
        .editorActions {
          display: flex;
          justify-content: flex-end;
          margin-top: 16px;
        }
        .saveBtn {
          min-height: 52px;
          padding: 0 18px;
          border-radius: 16px;
          background: #0f172a;
          color: #fff;
          font-weight: 900;
          box-shadow: 0 10px 18px rgba(15,23,42,.10);
        }
        .empty {
          border: 1px dashed #dbe4ef;
          border-radius: 18px;
          padding: 30px 16px;
          text-align: center;
          color: #64748b;
          font-weight: 700;
          background: #f8fafc;
        }
        @media (max-width: 1024px) {
          .grid, .stats {
            grid-template-columns: 1fr;
          }
          .pinCard {
            align-items: stretch;
            flex-direction: column;
          }
          .pinInput {
            width: 100%;
          }
        }
        @media (max-width: 640px) {
          .staffPage { padding: 18px 12px 30px; }
          .panel, .statCard { border-radius: 18px; }
          .formGrid { grid-template-columns: 1fr; }
          .topActions { width: 100%; }
          .navBtn { flex: 1; text-align: center; }
          .approveBtn, .rejectBtn, .editBtn, .deleteBtn, .saveBtn { width: 100%; }
          .deviceActions, .staffActions, .editorActions { flex-direction: column; }
        }
      `}</style>
    </div>
  );
}
