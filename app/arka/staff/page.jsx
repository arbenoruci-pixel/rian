"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const LS_KEY = "ARKA_USERS";
const ROLES = ["OWNER", "ADMIN", "DISPATCH", "PUNTOR", "TRANSPORT"];

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export default function ArkaStaffPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("checking"); // db|local
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ name: "", role: "PUNTOR", is_admin: false, is_active: true });
  const [editingId, setEditingId] = useState(null);

  const canManage = useMemo(() => user?.role === "OWNER" || user?.role === "ADMIN", [user]);

  useEffect(() => {
    const u = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);
    (async () => {
      // Try DB (table might not exist yet)
      const { error } = await supabase.from("arka_staff").select("id").limit(1);
      if (!error) {
        setMode("db");
        await reloadDb();
      } else {
        setMode("local");
        setItems(jparse(localStorage.getItem(LS_KEY), []));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function reloadDb() {
    const { data, error } = await supabase
      .from("arka_staff")
      .select("id,name,role,is_admin,is_active,created_at")
      .order("created_at", { ascending: false });
    if (!error) setItems(data || []);
  }

  function resetForm() {
    setForm({ name: "", role: "PUNTOR", is_admin: false, is_active: true });
    setEditingId(null);
  }

  async function save() {
    if (!canManage) return;
    if (!form.name.trim()) return alert("SHKRUAJ EMRIN");

    if (mode === "db") {
      if (editingId) {
        const { error } = await supabase
          .from("arka_staff")
          .update({ name: form.name.trim(), role: form.role, is_admin: !!form.is_admin, is_active: !!form.is_active })
          .eq("id", editingId);
        if (error) return alert(error.message);
      } else {
        const { error } = await supabase
          .from("arka_staff")
          .insert([{ name: form.name.trim(), role: form.role, is_admin: !!form.is_admin, is_active: !!form.is_active }]);
        if (error) return alert(error.message);
      }
      await reloadDb();
      resetForm();
      return;
    }

    // local fallback
    const next = [...items];
    if (editingId) {
      const idx = next.findIndex((x) => x.id === editingId);
      if (idx >= 0) next[idx] = { ...next[idx], ...form };
    } else {
      next.unshift({ id: Date.now(), created_at: new Date().toISOString(), ...form });
    }
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    setItems(next);
    resetForm();
  }

  async function editRow(row) {
    if (!canManage) return;
    setEditingId(row.id);
    setForm({ name: row.name || "", role: row.role || "PUNTOR", is_admin: !!row.is_admin, is_active: row.is_active !== false });
  }

  async function removeRow(row) {
    if (!canManage) return;
    if (!confirm("FSHI PUNTORIN?")) return;

    if (mode === "db") {
      const { error } = await supabase.from("arka_staff").delete().eq("id", row.id);
      if (error) return alert(error.message);
      await reloadDb();
      return;
    }

    const next = items.filter((x) => x.id !== row.id);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    setItems(next);
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-4xl mx-auto">
        <div className="arkaTop">
          <div>
            <h1 className="arkaH1">ARKA • PUNTORËT</h1>
            <p className="arkaMeta">{user.name} • {user.role} • {mode === "db" ? "ONLINE" : "LOCAL"}</p>
          </div>
          <Link href="/arka" className="arkaBack">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1">
            <div className="arkaPanel">
              <div className="arkaPanelBody">
                <p className="arkaPanelTitle">SHTO / EDIT</p>
                {!canManage ? (
                  <p className="arkaWarn">
                    VETËM OWNER/ADMIN MUND TË MENAXHOJË PUNTORËT
                  </p>
                ) : (
                  <>
                  <input
                    className="arkaInput"
                    aria-label="EMRI"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                  <select
                    className="arkaInput"
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <label className="arkaCheck">
                    <input type="checkbox" checked={!!form.is_admin} onChange={(e) => setForm((f) => ({ ...f, is_admin: e.target.checked }))} />
                    ADMIN ACCESS
                  </label>
                  <label className="arkaCheck">
                    <input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                    AKTIV
                  </label>
                  <div className="flex gap-2 mt-3">
                    <button onClick={save} className="arkaPrimary">
                      {editingId ? "RUAJ" : "SHTO"}
                    </button>
                    <button onClick={resetForm} className="arkaGhost">
                      CLEAR
                    </button>
                  </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="md:col-span-2">
            <div className="arkaPanel">
              <div className="arkaPanelHead">
                <p className="arkaPanelTitle">LISTA</p>
                <p className="arkaCount">{items.length} RRESHTA</p>
              </div>
              <div className="arkaList">
                {items.length === 0 ? (
                  <p className="arkaEmpty">NUK KA PUNTORË</p>
                ) : (
                  items.map((r) => (
                    <div key={r.id} className="arkaRow">
                      <div className="arkaRowMain">
                        <div className="arkaRowName">{String(r.name || "").toUpperCase()}</div>
                        <div className="arkaRowMeta">
                          <span className="arkaBadge">{r.role}</span>
                          {r.is_admin ? <span className="arkaBadge arkaBadgeBlue">ADMIN</span> : null}
                          {r.is_active === false ? <span className="arkaBadge arkaBadgeRed">PA AKTIV</span> : <span className="arkaBadge arkaBadgeGreen">AKTIV</span>}
                        </div>
                      </div>
                      {canManage && (
                        <div className="arkaRowActions">
                          <button onClick={() => editRow(r)} className="arkaMini">EDIT</button>
                          <button onClick={() => removeRow(r)} className="arkaMini arkaMiniDanger">FSHI</button>
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
        .arkaTop{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:14px;gap:12px;}
        .arkaH1{font-size:18px;font-weight:950;letter-spacing:.06em;line-height:1.1;color:#fff;}
        .arkaMeta{font-size:10px;letter-spacing:.18em;opacity:.62;margin-top:6px;}
        .arkaBack{font-size:10px;font-weight:950;letter-spacing:.16em;padding:9px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);text-decoration:none;}

        .arkaPanel{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;}
        .arkaPanelBody{padding:12px;}
        .arkaPanelTitle{font-size:10px;font-weight:950;letter-spacing:.18em;opacity:.75;}
        .arkaPanelHead{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);}
        .arkaCount{font-size:10px;letter-spacing:.12em;opacity:.5;}

        .arkaWarn{font-size:10px;font-weight:950;letter-spacing:.16em;color:#ff6b6b;background:rgba(255,0,0,.06);border:1px solid rgba(255,0,0,.18);padding:10px;border-radius:12px;}

        .arkaInput{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:10px 10px;border-radius:12px;font-size:12px;color:#fff;margin-top:8px;outline:none;}
        .arkaInput:focus{border-color:rgba(130,200,255,.45);box-shadow:0 0 0 3px rgba(0,150,255,.10);}
        .arkaCheck{display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:.14em;opacity:.85;margin-top:10px;}

        .arkaPrimary{flex:1;background:rgba(0,150,255,.12);border:1px solid rgba(0,150,255,.35);color:rgba(190,230,255,.95);padding:10px;border-radius:12px;font-size:10px;font-weight:950;letter-spacing:.16em;}
        .arkaGhost{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:.85;}

        .arkaList{padding:8px;display:flex;flex-direction:column;gap:8px;}
        .arkaEmpty{padding:28px 12px;text-align:center;font-size:10px;letter-spacing:.18em;opacity:.55;font-style:italic;}

        .arkaRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 10px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);}
        .arkaRowMain{min-width:0;}
        .arkaRowName{font-size:12px;font-weight:950;letter-spacing:.08em;}
        .arkaRowMeta{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;}
        .arkaBadge{font-size:9px;font-weight:950;letter-spacing:.14em;padding:4px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);opacity:.92;}
        .arkaBadgeGreen{border-color:rgba(0,255,170,.25);background:rgba(0,255,170,.08);}
        .arkaBadgeRed{border-color:rgba(255,80,80,.28);background:rgba(255,80,80,.08);}
        .arkaBadgeBlue{border-color:rgba(0,150,255,.30);background:rgba(0,150,255,.10);}

        .arkaRowActions{display:flex;gap:8px;flex-shrink:0;}
        .arkaMini{padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);font-size:10px;font-weight:950;letter-spacing:.14em;}
        .arkaMiniDanger{border-color:rgba(255,80,80,.35);background:rgba(255,80,80,.08);color:#ffd1d1;}

        @media (min-width: 768px){
          .arkaH1{font-size:20px;}
          .arkaRow{padding:12px 12px;}
        }
      `}</style>
    </div>
  );
}
