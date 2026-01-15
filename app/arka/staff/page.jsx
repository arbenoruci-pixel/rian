"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ensureDefaultAdminIfEmpty, listUsers, setUserActive, setUserPin, upsertUser } from "@/lib/usersDb";

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

export default function ArkaStaffPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // NOTE: DISPATCH is treated as ADMIN in your business rules.
  const canManage = useMemo(
    () => user?.role === "OWNER" || user?.role === "ADMIN" || user?.role === "DISPATCH",
    [user]
  );

  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", role: "PUNTOR", pin: "", is_active: true });

  useEffect(() => {
    const u = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);

    (async () => {
      setLoading(true);

      // If DB table exists, make sure there is at least 1 admin to log in.
      // (If the table doesn't exist, listUsers will return missingTable=true; this page will show a clear error.)
      try {
        await ensureDefaultAdminIfEmpty({ defaultName: "ADMIN", defaultPin: "0000" });
      } catch {}

      await reload();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function reload() {
    const res = await listUsers();
    if (!res.ok) {
      const msg = res?.missingTable
        ? "MUNGON TABELA 'tepiha_users' (OSE NUK KE PERMISSION).\n\nZgjidhja: Krijo tabelen tepiha_users (id,name,role,pin,is_active,created_at) ose jep anon access (select/insert/update)."
        : String(res?.error?.message || res?.error || "ERROR");
      alert(msg);
      setItems([]);
      return;
    }
    setItems(res.items || []);
  }

  function resetForm() {
    setEditingId(null);
    setForm({ name: "", role: "PUNTOR", pin: "", is_active: true });
  }

  async function save() {
    if (!canManage) return;
    const name = String(form.name || "").trim();
    const pin = onlyDigits(form.pin);

    if (!name) return alert("SHKRUAJ EMRIN");
    if (!editingId && pin.length < 4) return alert("PIN DUHET ME KAN TË PAKTËN 4 SHIFRA");
    if (editingId && form.pin && pin.length < 4) return alert("PIN DUHET ME KAN TË PAKTËN 4 SHIFRA");

    const res = await upsertUser({
      id: editingId || undefined,
      name,
      role: form.role,
      pin: form.pin ? pin : "", // blank on edit = keep existing pin
      is_active: form.is_active !== false,
    });

    if (!res.ok) return alert(String(res?.error?.message || res?.error || "ERROR"));
    await reload();
    resetForm();
  }

  function editRow(row) {
    if (!canManage) return;
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      role: row.role || "PUNTOR",
      pin: "", // DO NOT prefill
      is_active: row.is_active !== false,
    });
  }

  async function toggleActive(row) {
    if (!canManage) return;
    const nextActive = row.is_active === false;
    const res = await setUserActive(row.id, nextActive);
    if (!res.ok) return alert(String(res?.error?.message || res?.error || "ERROR"));
    await reload();
  }

  async function changePin(row) {
    if (!canManage) return;
    const p = onlyDigits(prompt(`PIN I RI për ${String(row.name || "").toUpperCase()} (4+ shifra):`, ""));
    if (!p) return;
    if (p.length < 4) return alert("PIN DUHET ME KAN TË PAKTËN 4 SHIFRA");
    const res = await setUserPin(row.id, p);
    if (!res.ok) return alert(String(res?.error?.message || res?.error || "ERROR"));
    await reload();
    alert("✅ PIN U NDRRUA");
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-4xl mx-auto">
        <div className="arkaTop">
          <div>
            <h1 className="arkaH1">ARKA • PUNTORËT (PIN)</h1>
            <p className="arkaMeta">{user.name} • {user.role} • ONLINE</p>
          </div>
          <Link href="/arka" className="arkaBack">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1">
            <div className="arkaPanel">
              <div className="arkaPanelBody">
                <p className="arkaPanelTitle">SHTO / EDIT</p>
                {!canManage ? (
                  <p className="arkaWarn">VETËM ADMIN/DISPATCH MUND TË MENAXHOJË PUNTORËT</p>
                ) : (
                  <>
                    <input
                      className="arkaInput"
                      aria-label="EMRI"
                      placeholder="EMRI"
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

                    <input
                      className="arkaInput"
                      aria-label="PIN"
                      inputMode="numeric"
                      placeholder={editingId ? "PIN I RI (LËRE BOSH PËR ME E MBAJT PIN-IN)" : "PIN (4+ SHIFRA)"}
                      value={form.pin}
                      onChange={(e) => setForm((f) => ({ ...f, pin: onlyDigits(e.target.value) }))}
                    />

                    <label className="arkaCheck">
                      <input
                        type="checkbox"
                        checked={!!form.is_active}
                        onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                      />
                      AKTIV
                    </label>

                    <div className="flex gap-2 mt-3">
                      <button onClick={save} className="arkaPrimary">
                        {editingId ? "RUAJ" : "SHTO"}
                      </button>
                      <button onClick={resetForm} className="arkaGhost">CLEAR</button>
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
                <p className="arkaCount">{items.length} PUNTORË</p>
              </div>
              <div className="arkaList">
                {loading ? (
                  <p className="arkaEmpty">DUKE NGARKU…</p>
                ) : items.length === 0 ? (
                  <p className="arkaEmpty">NUK KA PUNTORË</p>
                ) : (
                  items.map((r) => (
                    <div key={r.id} className="arkaRow">
                      <div className="arkaRowMain">
                        <div className="arkaRowName">{String(r.name || "").toUpperCase()}</div>
                        <div className="arkaRowMeta">
                          <span className="arkaBadge">{r.role}</span>
                          {r.is_active === false ? (
                            <span className="arkaBadge arkaBadgeRed">PA AKTIV</span>
                          ) : (
                            <span className="arkaBadge arkaBadgeGreen">AKTIV</span>
                          )}
                          <span className="arkaBadge arkaBadgeBlue">PIN: ****</span>
                        </div>
                      </div>

                      {canManage && (
                        <div className="arkaRowActions">
                          <button onClick={() => editRow(r)} className="arkaMini">EDIT</button>
                          <button onClick={() => changePin(r)} className="arkaMini">PIN</button>
                          <button onClick={() => toggleActive(r)} className={`arkaMini ${r.is_active === false ? "" : "arkaMiniDanger"}`}>
                            {r.is_active === false ? "AKTIVO" : "DEAKTIVO"}
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

        .arkaRow{display:flex;justify-content:space-between;gap:10px;align-items:center;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;}
        .arkaRowMain{min-width:0;}
        .arkaRowName{font-size:12px;font-weight:950;letter-spacing:.12em;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52ch;}
        .arkaRowMeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
        .arkaBadge{font-size:9px;font-weight:950;letter-spacing:.14em;padding:6px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);opacity:.9;}
        .arkaBadgeGreen{border-color:rgba(0,255,150,.25);background:rgba(0,255,150,.08);}
        .arkaBadgeRed{border-color:rgba(255,0,80,.25);background:rgba(255,0,80,.08);}
        .arkaBadgeBlue{border-color:rgba(0,150,255,.25);background:rgba(0,150,255,.08);}

        .arkaRowActions{display:flex;gap:6px;align-items:center;}
        .arkaMini{font-size:9px;font-weight:950;letter-spacing:.16em;padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);}
        .arkaMiniDanger{border-color:rgba(255,0,80,.22);background:rgba(255,0,80,.07);}
      `}</style>
    </div>
  );
}
