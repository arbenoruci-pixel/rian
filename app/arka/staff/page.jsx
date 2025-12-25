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

function RoleBadge({ role, isAdmin }) {
  const label = String(role || "PUNTOR").toUpperCase();
  const extra = isAdmin ? " • ADMIN" : "";
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-gray-800 bg-black/40 text-[10px] font-black tracking-widest text-gray-200">
      {label}
      {extra}
    </span>
  );
}

export default function ArkaStaffPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("checking"); // db|local
  const [items, setItems] = useState([]);

  // modal
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", role: "PUNTOR", is_admin: false, is_active: true });

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

  function openCreate() {
    if (!canManage) return;
    setEditingId(null);
    setForm({ name: "", role: "PUNTOR", is_admin: false, is_active: true });
    setIsOpen(true);
  }

  function openEdit(row) {
    if (!canManage) return;
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      role: row.role || "PUNTOR",
      is_admin: !!row.is_admin,
      is_active: row.is_active !== false,
    });
    setIsOpen(true);
  }

  function closeModal() {
    setIsOpen(false);
    setEditingId(null);
    setForm({ name: "", role: "PUNTOR", is_admin: false, is_active: true });
  }

  async function save() {
    if (!canManage) return;
    if (!form.name.trim()) return alert("SHKRUAJ EMRIN");

    if (mode === "db") {
      if (editingId) {
        const { error } = await supabase
          .from("arka_staff")
          .update({
            name: form.name.trim(),
            role: form.role,
            is_admin: !!form.is_admin,
            is_active: !!form.is_active,
          })
          .eq("id", editingId);
        if (error) return alert(error.message);
      } else {
        const { error } = await supabase
          .from("arka_staff")
          .insert([
            {
              name: form.name.trim(),
              role: form.role,
              is_admin: !!form.is_admin,
              is_active: !!form.is_active,
            },
          ]);
        if (error) return alert(error.message);
      }
      await reloadDb();
      closeModal();
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
    closeModal();
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
            <h1 className="text-2xl font-black text-white tracking-tighter">ARKA • PUNTORËT</h1>
            <p className="text-[10px] text-gray-500 tracking-widest">
              {user.name} • {user.role} • {mode === "db" ? "ONLINE" : "LOCAL"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/arka"
              className="text-[10px] font-black px-3 py-2 rounded border border-gray-800 hover:bg-gray-900"
            >
              KTHEHU
            </Link>
            {canManage && (
              <button
                onClick={openCreate}
                className="text-[10px] font-black px-3 py-2 rounded border border-blue-900/60 bg-blue-600/20 text-blue-200 hover:bg-blue-600 hover:text-white transition"
              >
                + SHTO PUNTOR
              </button>
            )}
          </div>
        </div>

        {!canManage && (
          <div className="mb-4 text-[10px] text-red-300 font-black tracking-widest bg-red-900/10 p-3 border border-red-900/20 rounded">
            VETËM OWNER/ADMIN MUND TË MENAXHOJË PUNTORËT
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.length === 0 ? (
            <div className="col-span-full bg-gray-900 border border-gray-800 rounded p-10 text-center">
              <p className="text-[10px] text-gray-600 tracking-widest italic">NUK KA PUNTORË</p>
            </div>
          ) : (
            items.map((r) => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-black text-white tracking-tight truncate">
                      {String(r.name || "").toUpperCase()}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <RoleBadge role={r.role} isAdmin={!!r.is_admin} />
                      {r.is_active === false ? (
                        <span className="inline-flex items-center px-3 py-1 rounded-full border border-red-900/50 bg-red-900/20 text-[10px] font-black tracking-widest text-red-200">
                          PA AKTIV
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-3 py-1 rounded-full border border-green-900/40 bg-green-900/10 text-[10px] font-black tracking-widest text-green-200">
                          AKTIV
                        </span>
                      )}
                    </div>
                  </div>

                  {canManage && (
                    <div className="flex flex-col gap-2 shrink-0">
                      <button
                        onClick={() => openEdit(r)}
                        className="px-3 py-2 rounded border border-gray-800 text-[10px] font-black text-gray-200 hover:bg-gray-950"
                      >
                        EDIT
                      </button>
                      <button
                        onClick={() => removeRow(r)}
                        className="px-3 py-2 rounded border border-red-900/50 text-[10px] font-black text-red-200 hover:bg-red-900/20"
                      >
                        FSHI
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {isOpen && (
          <div className="fixed inset-0 z-50">
            <button aria-label="CLOSE" onClick={closeModal} className="absolute inset-0 bg-black/70" />
            <div className="absolute inset-x-0 bottom-0 md:inset-y-0 md:right-0 md:left-auto md:w-[420px] bg-gray-950 border-t md:border-t-0 md:border-l border-gray-800 p-4">
              <div className="flex items-center justify-between pb-3 border-b border-gray-800">
                <p className="text-[10px] text-gray-500 tracking-widest font-black">
                  {editingId ? "EDIT PUNTOR" : "SHTO PUNTOR"}
                </p>
                <button
                  onClick={closeModal}
                  className="px-3 py-2 rounded border border-gray-800 text-[10px] font-black text-gray-300 hover:bg-gray-900"
                >
                  MBYLLE
                </button>
              </div>

              <div className="pt-4 space-y-3">
                <div>
                  <p className="text-[9px] text-gray-500 tracking-widest font-black mb-2">EMRI</p>
                  <input
                    className="w-full bg-black border border-gray-700 p-3 rounded text-sm text-white"
                    aria-label="EMRI"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="EMRI I PUNTORIT"
                  />
                </div>

                <div>
                  <p className="text-[9px] text-gray-500 tracking-widest font-black mb-2">ROLI</p>
                  <select
                    className="w-full bg-black border border-gray-700 p-3 rounded text-sm text-white"
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

                <div className="flex items-center justify-between gap-3 border border-gray-800 rounded p-3 bg-black/30">
                  <div>
                    <p className="text-[10px] font-black text-gray-200 tracking-widest">ADMIN ACCESS</p>
                    <p className="text-[9px] text-gray-500 tracking-widest">VETËM KUR DUHET</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!form.is_admin}
                    onChange={(e) => setForm((f) => ({ ...f, is_admin: e.target.checked }))}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 border border-gray-800 rounded p-3 bg-black/30">
                  <div>
                    <p className="text-[10px] font-black text-gray-200 tracking-widest">AKTIV</p>
                    <p className="text-[9px] text-gray-500 tracking-widest">NËSE ËSHTË NË PUNË</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                  />
                </div>

                <div className="pt-2 flex gap-2">
                  <button
                    onClick={save}
                    className="flex-1 bg-blue-600/20 text-blue-200 border border-blue-900/60 py-3 rounded text-[10px] font-black hover:bg-blue-600 hover:text-white transition"
                  >
                    {editingId ? "RUAJ" : "SHTO"}
                  </button>
                  <button
                    onClick={closeModal}
                    className="px-4 py-3 rounded border border-gray-800 text-[10px] font-black text-gray-400 hover:bg-gray-900"
                  >
                    ANULO
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {canManage && (
          <div className="fixed bottom-4 left-0 right-0 px-4 md:hidden z-40">
            <button
              onClick={openCreate}
              className="w-full bg-blue-600 text-white py-3 rounded font-black text-[11px] tracking-widest shadow-lg"
            >
              + SHTO PUNTOR
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
