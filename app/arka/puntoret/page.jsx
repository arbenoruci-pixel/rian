"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

// ✅ VARIANT A (SINGLE SOURCE OF TRUTH)
// - KRIJIMI I PËRDORUESVE + APROVIMI I PAJISJES: vetëm /admin/devices
// - KJO FAQE: vetëm MENAXHIM (edit / pin / aktiv)

const READ_VIEW = "tepiha_users"; // VIEW (lexim)
const WRITE_TABLE = "users"; // TABLE (update)

const ROLES = ["OWNER", "ADMIN", "DISPATCH", "PUNTOR", "TRANSPORT"];

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

export default function PuntoretPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const formRef = useRef(null);

  const canManage = useMemo(
    () => actor?.role === "OWNER" || actor?.role === "ADMIN" || actor?.role === "DISPATCH",
    [actor]
  );

  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", role: "PUNTOR", pin: "", is_active: true });

  useEffect(() => {
    const u = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!u) {
      router.push("/login");
      return;
    }
    setActor(u);
    void (async () => {
      setLoading(true);
      await reload();
      setLoading(false);
    })();
  }, [router]);

  async function reload() {
    try {
      const { data, error } = await supabase
        .from(READ_VIEW)
        .select("id,name,role,is_active,created_at")
        .order("created_at", { ascending: true });

      if (error) throw error;
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      alert("ERROR: " + String(e?.message || e));
      setItems([]);
    }
  }

  function resetForm() {
    setEditingId(null);
    setForm({ name: "", role: "PUNTOR", pin: "", is_active: true });
  }

  function editRow(row) {
    if (!canManage) return;
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      role: row.role || "PUNTOR",
      pin: "", // opsionale: vetëm kur do me ndrru
      is_active: row.is_active !== false,
    });

    if (formRef.current) {
      formRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function saveEdit() {
    if (!canManage) return;
    if (!editingId) return;

    const name = String(form.name || "").trim();
    const pin = onlyDigits(form.pin);

    if (!name) return alert("SHKRUAJ EMRIN");
    if (form.pin && pin.length < 4) return alert("PIN DUHET TË KETË MINIMUM 4 SHIFRA");

    try {
      const payload = {
        name,
        role: form.role || "PUNTOR",
        is_active: form.is_active !== false,
        ...(form.pin ? { pin } : {}),
      };

      const { error } = await supabase.from(WRITE_TABLE).update(payload).eq("id", editingId);
      if (error) throw error;

      await reload();
      resetForm();
    } catch (e) {
      alert("ERROR: " + String(e?.message || e));
    }
  }

  async function toggleActive(row) {
    if (!canManage) return;
    const nextActive = row.is_active === false;
    try {
      const { error } = await supabase.from(WRITE_TABLE).update({ is_active: nextActive }).eq("id", row.id);
      if (error) throw error;
      await reload();
    } catch (e) {
      alert("ERROR: " + String(e?.message || e));
    }
  }

  async function changePin(row) {
    if (!canManage) return;
    const p = onlyDigits(prompt(`PIN I RI për ${row.name}? (4 shifra):`, ""));
    if (!p) return;
    if (p.length < 4) return alert("PIN PREJ 4 SHIFRAVE OBLIGATIV");
    try {
      const { error } = await supabase.from(WRITE_TABLE).update({ pin: p }).eq("id", row.id);
      if (error) throw error;
      await reload();
      alert("✅ PIN U NDRYSHUA");
    } catch (e) {
      alert("ERROR: " + String(e?.message || e));
    }
  }

  if (!actor) return null;

  return (
    <div className="pageContainer">
      <div className="maxWidth">
        {/* HEADER */}
        <div className="topHeader">
          <div>
            <h1 className="h1">ARKA • PUNËTORËT</h1>
            <p className="meta">
              LOGGED: {actor.name} ({actor.role})
            </p>
          </div>
          <Link href="/arka" className="backBtn">
            KTHEHU
          </Link>
        </div>

        {/* ✅ SINGLE SOURCE OF TRUTH CTA */}
        <div className="ctaWrap">
          <Link href="/admin/devices" className="ctaBtn">
            ➕ KRIJO PUNËTOR TË RI (APROVO PAJISJEN)
          </Link>
          <div className="ctaHint">KRIJIMI + APROVIMI BËHET VETËM TE /ADMIN/DEVICES.</div>
        </div>

        <div className="mainGrid">
          {/* EDIT PANEL */}
          <div className="formSection" ref={formRef}>
            <div className={`panel ${editingId ? "panelActive" : ""}`}>
              <div className="panelHead">
                <span className="panelTitle">
                  {editingId ? "EDITO PUNTORIN" : "ZGJIDH NJË PUNTOR NGA LISTA PËR EDIT"}
                </span>
                {editingId && (
                  <button onClick={resetForm} className="cancelBtn">
                    ANULO
                  </button>
                )}
              </div>

              <div className="panelBody">
                {!canManage ? (
                  <div className="warnBox">S&apos;KE AKSES PËR MENAXHIM</div>
                ) : !editingId ? (
                  <div className="emptyState" style={{ padding: 18 }}>
                    KLIKO “EDIT” NË LISTË PËR ME NDRYSHU EMRIN/ROLIN/PIN-IN.
                  </div>
                ) : (
                  <div className="formStack">
                    <div className="field">
                      <label className="label">EMRI MBIEMRI</label>
                      <input
                        className="input"
                        placeholder="Emri..."
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    </div>

                    <div className="field">
                      <label className="label">ROLI</label>
                      <select
                        className="input"
                        value={form.role}
                        onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
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
                        placeholder="**** (Lëre bosh nëse s'do me ndrru)"
                        value={form.pin}
                        onChange={(e) => setForm((f) => ({ ...f, pin: onlyDigits(e.target.value) }))}
                      />
                    </div>

                    <label className="switchRow">
                      <div className={`switchTrack ${form.is_active ? "trackActive" : ""}`}>
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={!!form.is_active}
                          onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                        />
                        <div className="switchThumb" />
                      </div>
                      <span className={`switchLabel ${form.is_active ? "textGreen" : "textGray"}`}>
                        {form.is_active ? "USER AKTIV" : "JO-AKTIV (I BLLOKUAR)"}
                      </span>
                    </label>

                    <button onClick={saveEdit} className="primaryBtn">
                      RUAJ NDRYSHIMET
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* LIST */}
          <div className="listSection">
            <div className="panel">
              <div className="panelHead">
                <span className="panelTitle">LISTA E STAFIT</span>
                <span className="badge">{items.length} TOTAL</span>
              </div>

              <div className="listBody">
                {loading ? (
                  <div className="emptyState">DUKE LEXUAR TË DHËNAT...</div>
                ) : items.length === 0 ? (
                  <div className="emptyState">NUK KA ASNJË PUNTOR NË SISTEM</div>
                ) : (
                  items.map((r) => (
                    <div key={r.id} className={`userRow ${editingId === r.id ? "rowEditing" : ""}`}>
                      <div className="userInfo">
                        <div className="userHeader">
                          <span className={`statusDot ${r.is_active ? "dotGreen" : "dotRed"}`} />
                          <span className="userName">{r.name}</span>
                        </div>
                        <div className="userMeta">
                          <span className="roleTag">{r.role}</span>
                          <span className="pinTag">PIN: ****</span>
                        </div>
                      </div>

                      {canManage && (
                        <div className="userActions">
                          <Link href={`/arka/puntoret/${r.id}`} className="btnKartela">
                            KARTELA
                          </Link>
                          <button onClick={() => editRow(r)} className="actionBtn btnEdit">
                            EDIT
                          </button>
                          <button onClick={() => changePin(r)} className="actionBtn btnPin">
                            PIN
                          </button>
                          <button
                            onClick={() => toggleActive(r)}
                            className={`actionBtn ${r.is_active ? "btnStop" : "btnActivate"}`}
                          >
                            {r.is_active ? "NDAL" : "HAP"}
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

      <style jsx>{`
        .pageContainer { min-height:100vh; background:#000; color:#eee; padding:20px; font-family:sans-serif; text-transform:uppercase; }
        .maxWidth { max-width:1200px; margin:0 auto; }

        .topHeader { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:1px solid #222; padding-bottom:20px; margin-bottom:18px; }
        .h1 { font-size:20px; font-weight:900; letter-spacing:0.05em; margin:0; color:#fff; }
        .meta { font-size:10px; letter-spacing:0.1em; color:#666; margin-top:5px; font-weight:700; }
        .backBtn { background:#111; border:1px solid #333; color:#ccc; font-size:10px; font-weight:800; padding:10px 16px; border-radius:8px; text-decoration:none; transition:0.2s; }
        .backBtn:hover { background:#222; color:#fff; border-color:#555; }

        .ctaWrap { display:flex; flex-direction:column; gap:10px; margin:18px 0 22px; }
        .ctaBtn { display:flex; align-items:center; justify-content:center; background: linear-gradient(90deg, rgba(0,112,243,0.85), rgba(59,130,246,0.65)); border:1px solid rgba(59,130,246,0.5); color:#fff; text-decoration:none; padding:14px 14px; border-radius:14px; font-weight:900; letter-spacing:0.08em; font-size:12px; box-shadow: 0 10px 25px rgba(0,0,0,0.35); }
        .ctaBtn:hover { filter:brightness(1.05); transform: translateY(-1px); }
        .ctaHint { font-size:10px; color:#6b7280; letter-spacing:0.08em; font-weight:800; text-align:center; }

        .mainGrid { display:grid; grid-template-columns:1fr; gap:24px; }
        @media (min-width: 1024px) { .mainGrid { grid-template-columns: 350px 1fr; } .formSection { position:sticky; top:20px; height:fit-content; } }

        .panel { background:#0a0a0a; border:1px solid #222; border-radius:16px; overflow:hidden; }
        .panelActive { border-color:#0070f3; box-shadow:0 0 0 1px rgba(0,112,243,0.3); }
        .panelHead { background:rgba(255,255,255,0.03); padding:12px 16px; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center; }
        .panelTitle { font-size:10px; font-weight:900; letter-spacing:0.15em; color:#888; }
        .panelBody { padding:16px; }

        .warnBox { background:rgba(255,0,0,0.1); color:#ff6b6b; padding:12px; text-align:center; font-size:10px; border-radius:8px; font-weight:700; }
        .cancelBtn { background:#330000; color:#ff8888; border:1px solid #550000; font-size:9px; padding:4px 8px; border-radius:4px; cursor:pointer; font-weight:800; }

        .formStack { display:flex; flex-direction:column; gap:12px; }
        .field { display:flex; flex-direction:column; gap:6px; }
        .label { font-size:9px; font-weight:800; letter-spacing:0.1em; color:#555; margin-left:2px; }
        .input { background:#000; border:1px solid #333; color:#fff; padding:12px; font-size:13px; border-radius:10px; outline:none; font-weight:600; transition:0.2s; }
        .input:focus { border-color:#0070f3; background:#050505; }

        .switchRow { display:flex; align-items:center; gap:10px; cursor:pointer; background:#050505; border:1px solid #222; padding:10px; border-radius:10px; }
        .switchTrack { width:36px; height:20px; background:#222; border-radius:99px; position:relative; transition:0.3s; }
        .trackActive { background:#15803d; }
        .switchThumb { width:14px; height:14px; background:#fff; border-radius:50%; position:absolute; top:3px; left:3px; transition:0.3s; }
        .trackActive .switchThumb { left:19px; }
        .switchLabel { font-size:10px; font-weight:800; letter-spacing:0.05em; }
        .textGreen { color:#4ade80; }
        .textGray { color:#666; }

        .primaryBtn { background:#0070f3; color:#fff; border:none; padding:14px; border-radius:10px; font-size:11px; font-weight:900; letter-spacing:0.1em; cursor:pointer; margin-top:4px; }
        .primaryBtn:hover { background:#0060df; }

        .listBody { display:flex; flex-direction:column; }
        .emptyState { padding:40px; text-align:center; opacity:0.4; font-size:11px; letter-spacing:0.1em; font-style:italic; }
        .badge { background:#222; color:#aaa; font-size:9px; padding:2px 6px; border-radius:4px; font-weight:800; }

        .userRow { padding:14px 16px; border-bottom:1px solid #1a1a1a; display:flex; flex-direction:column; gap:12px; transition:0.2s; }
        @media (min-width: 768px) { .userRow { flex-direction:row; align-items:center; justify-content:space-between; } }
        .userRow:last-child { border-bottom:none; }
        .userRow:hover { background:rgba(255,255,255,0.02); }
        .rowEditing { background:rgba(0,112,243,0.05); border-left:2px solid #0070f3; }

        .userInfo { display:flex; flex-direction:column; gap:4px; }
        .userHeader { display:flex; align-items:center; gap:8px; }
        .userName { font-size:14px; font-weight:800; color:#fff; letter-spacing:0.02em; }
        .statusDot { width:6px; height:6px; border-radius:50%; }
        .dotGreen { background:#4ade80; box-shadow:0 0 8px rgba(74,222,128,0.4); }
        .dotRed { background:#f87171; }
        .userMeta { display:flex; gap:6px; }
        .roleTag { background:#222; color:#888; font-size:9px; padding:2px 6px; border-radius:4px; font-weight:700; }
        .pinTag { border:1px solid #222; color:#555; font-size:9px; padding:1px 6px; border-radius:4px; font-weight:700; }

        .userActions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .btnKartela { display:inline-flex; align-items:center; justify-content:center; background:#0070f3; color:white; padding:0 16px; height:32px; border-radius:8px; font-size:10px; font-weight:800; text-decoration:none; letter-spacing:0.05em; border:1px solid #005bb5; transition:0.2s; box-shadow:0 2px 5px rgba(0,0,0,0.2); }
        .btnKartela:hover { background:#0060df; transform: translateY(-1px); }

        .actionBtn { display:inline-flex; align-items:center; justify-content:center; padding:0 12px; height:32px; border-radius:8px; font-size:10px; font-weight:800; cursor:pointer; text-decoration:none; border:1px solid transparent; transition:0.2s; }
        .btnEdit { background:rgba(255,255,255,0.08); color:#ddd; border-color:rgba(255,255,255,0.1); }
        .btnEdit:hover { background:rgba(255,255,255,0.15); color:#fff; }
        .btnPin { background:rgba(255,255,255,0.08); color:#aaa; border-color:rgba(255,255,255,0.05); }
        .btnPin:hover { background:rgba(255,255,255,0.15); color:#ccc; }
        .btnStop { background:rgba(239,68,68,0.15); color:#f87171; border-color:rgba(239,68,68,0.25); }
        .btnStop:hover { background:rgba(239,68,68,0.25); }
        .btnActivate { background:rgba(34,197,94,0.15); color:#4ade80; border-color:rgba(34,197,94,0.25); }
        .btnActivate:hover { background:rgba(34,197,94,0.25); }
      `}</style>
    </div>
  );
}
