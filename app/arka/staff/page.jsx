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
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-black text-white tracking-tighter">ARKA • PUNTORËT</h1>
            <p className="text-[10px] text-gray-500 tracking-widest">{user.name} • {user.role} • {mode === "db" ? "ONLINE" : "LOCAL"}</p>
          </div>
          <Link href="/arka" className="text-[10px] font-black px-3 py-2 rounded border border-gray-800 hover:bg-gray-900">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <div className="bg-gray-900 border border-gray-800 rounded p-4">
              <p className="text-[10px] font-black text-gray-400 tracking-widest mb-3">SHTO / EDIT</p>
              {!canManage ? (
                <p className="text-[10px] text-red-400 font-black tracking-widest bg-red-900/10 p-2 border border-red-900/20 rounded">
                  VETËM OWNER/ADMIN MUND TË MENAXHOJË PUNTORËT
                </p>
              ) : (
                <>
                  <input
                    className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white mb-2"
                    aria-label="EMRI"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                  <select
                    className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white mb-2"
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-[10px] text-gray-300 mb-2">
                    <input type="checkbox" checked={!!form.is_admin} onChange={(e) => setForm((f) => ({ ...f, is_admin: e.target.checked }))} />
                    ADMIN ACCESS
                  </label>
                  <label className="flex items-center gap-2 text-[10px] text-gray-300 mb-4">
                    <input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                    AKTIV
                  </label>
                  <div className="flex gap-2">
                    <button onClick={save} className="flex-1 bg-blue-600/20 text-blue-300 border border-blue-900/60 py-2 rounded text-[10px] font-black hover:bg-blue-600 hover:text-white transition">
                      {editingId ? "RUAJ" : "SHTO"}
                    </button>
                    <button onClick={resetForm} className="px-3 py-2 rounded border border-gray-800 text-[10px] font-black text-gray-400 hover:bg-gray-900">
                      CLEAR
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="md:col-span-2">
            <div className="bg-gray-900 border border-gray-800 rounded">
              <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                <p className="text-[10px] font-black text-gray-400 tracking-widest">LISTA</p>
                <p className="text-[9px] text-gray-600">{items.length} RRESHTA</p>
              </div>
              <div className="divide-y divide-gray-800">
                {items.length === 0 ? (
                  <p className="p-10 text-center text-[10px] text-gray-600 tracking-widest italic">NUK KA PUNTORË</p>
                ) : (
                  items.map((r) => (
                    <div key={r.id} className="p-3 flex items-center justify-between hover:bg-black/20">
                      <div>
                        <p className="text-[11px] font-black text-gray-200">{String(r.name || "").toUpperCase()}</p>
                        <p className="text-[8px] text-gray-500 tracking-widest">{r.role} {r.is_admin ? "• ADMIN" : ""} {r.is_active === false ? "• PA AKTIV" : ""}</p>
                      </div>
                      {canManage && (
                        <div className="flex gap-2">
                          <button onClick={() => editRow(r)} className="px-2 py-1 rounded border border-gray-800 text-[8px] font-black text-gray-300 hover:bg-gray-900">EDIT</button>
                          <button onClick={() => removeRow(r)} className="px-2 py-1 rounded border border-red-900/50 text-[8px] font-black text-red-300 hover:bg-red-900/20">FSHI</button>
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
