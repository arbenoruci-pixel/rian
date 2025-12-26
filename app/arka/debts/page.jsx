"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const LS_KEY = "ARKA_DEBTS";

function jparse(s, fallback) {
  try {
    return JSON.parse(s || "");
  } catch {
    return fallback;
  }
}

function jstore(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null");
  } catch {
    return null;
  }
}

export default function ArkaDebtsPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    direction: "WE_OWE", // WE_OWE | OWED_TO_US
    party: "",
    amount: "",
    note: "",
  });

  const totalWeOwe = useMemo(
    () => items.filter((i) => i.status !== "PAID" && i.direction === "WE_OWE").reduce((a, i) => a + (Number(i.amount) || 0), 0),
    [items]
  );
  const totalOwedToUs = useMemo(
    () => items.filter((i) => i.status !== "PAID" && i.direction === "OWED_TO_US").reduce((a, i) => a + (Number(i.amount) || 0), 0),
    [items]
  );

  useEffect(() => {
    const u = getUser();
    if (!u) {
      router.push("/login");
      return;
    }
    if (u.role === "TRANSPORT") {
      router.push("/");
      return;
    }
    setUser(u);
    (async () => {
      await load();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    // Try Supabase first; fallback to local.
    try {
      const { data, error } = await supabase
        .from("arka_debts")
        .select("*")
        .order("created_at", { ascending: false });
      if (!error && data) {
        setItems(data);
        return;
      }
    } catch {}

    setItems(jparse(localStorage.getItem(LS_KEY), []));
  }

  async function addDebt() {
    const amt = Number(form.amount);
    if (!form.party || !amt) return alert("Plotëso PARTY dhe SHUMA.");

    const row = {
      direction: form.direction,
      party: form.party.toUpperCase(),
      amount: amt,
      note: (form.note || "").toUpperCase(),
      status: "OPEN",
      created_by: user?.name || "",
    };

    // Supabase
    try {
      const { error } = await supabase.from("arka_debts").insert(row);
      if (!error) {
        setForm({ direction: "WE_OWE", party: "", amount: "", note: "" });
        await load();
        return;
      }
    } catch {}

    // Local fallback
    const local = jparse(localStorage.getItem(LS_KEY), []);
    const newRow = { id: Date.now(), created_at: new Date().toISOString(), ...row };
    const next = [newRow, ...local];
    jstore(LS_KEY, next);
    setItems(next);
    setForm({ direction: "WE_OWE", party: "", amount: "", note: "" });
  }

  async function markPaid(it) {
    if (!confirm("ME E SHËNU SI PAID?")) return;
    // Supabase
    if (typeof it.id === "number") {
      try {
        const { error } = await supabase.from("arka_debts").update({ status: "PAID", paid_at: new Date().toISOString(), paid_by: user?.name || "" }).eq("id", it.id);
        if (!error) {
          await load();
          return;
        }
      } catch {}
    }
    // Local
    const next = items.map((x) => (x.id === it.id ? { ...x, status: "PAID", paid_at: new Date().toISOString(), paid_by: user?.name || "" } : x));
    jstore(LS_KEY, next);
    setItems(next);
  }

  async function removeItem(it) {
    if (!confirm("ME FSHI?")) return;
    // Supabase
    if (typeof it.id === "number") {
      try {
        const { error } = await supabase.from("arka_debts").delete().eq("id", it.id);
        if (!error) {
          await load();
          return;
        }
      } catch {}
    }
    // Local
    const next = items.filter((x) => x.id !== it.id);
    jstore(LS_KEY, next);
    setItems(next);
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tighter">ARKA • BORXHET</h1>
            <p className="text-[10px] text-gray-500 tracking-widest">{user?.name} • {user?.role}</p>
          </div>
          <Link href="/arka" className="text-[10px] font-black tracking-widest text-gray-400 hover:text-white">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded p-4">
            <h3 className="text-[10px] font-black text-gray-400 mb-3 tracking-widest">SHTO BORXH</h3>
            <div className="space-y-2">
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} className="w-full bg-black border border-gray-700 p-2 rounded text-[10px] font-black text-white">
                <option value="WE_OWE">NE I KEM BORXH</option>
                <option value="OWED_TO_US">NA KANË BORXH</option>
              </select>
              <input value={form.party} onChange={(e) => setForm({ ...form, party: e.target.value })} aria-label="KUSH" className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white" />
              <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} aria-label="SHUMA €" type="number" step="any" className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white" />
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="SHËNIM" className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white" />
              <button onClick={addDebt} className="w-full bg-blue-600 px-4 py-2 rounded text-[10px] font-black">RUAJ</button>
              <p className="text-[9px] text-gray-500">DB: <span className={"font-black " + (loading ? "text-gray-500" : "text-green-500")}>{loading ? "DUKE NGARKUAR" : "GATI"}</span></p>
            </div>
          </div>

          <div className="md:col-span-2 bg-gray-900 border border-gray-800 rounded">
            <div className="p-4 border-b border-gray-800 grid grid-cols-2 gap-3 text-center">
              <div className="bg-black/30 rounded p-3">
                <p className="text-[9px] text-gray-500 font-black">NE I KEM BORXH</p>
                <p className="text-lg font-mono font-black text-red-500">€{totalWeOwe.toFixed(2)}</p>
              </div>
              <div className="bg-black/30 rounded p-3">
                <p className="text-[9px] text-gray-500 font-black">NA KANË BORXH</p>
                <p className="text-lg font-mono font-black text-green-500">€{totalOwedToUs.toFixed(2)}</p>
              </div>
            </div>

            <div className="divide-y divide-gray-800">
              {items.length === 0 ? (
                <div className="p-10 text-center text-[10px] text-gray-600 tracking-widest italic">S’KA BORXHE</div>
              ) : (
                items.map((it) => (
                  <div key={it.id} className="p-3 flex items-center justify-between hover:bg-black/20">
                    <div>
                      <p className="text-[10px] font-black text-gray-200">
                        {it.direction === "WE_OWE" ? "NE I KEM BORXH" : "NA KANË BORXH"} • {it.party}
                      </p>
                      <p className="text-[8px] text-gray-500 tracking-tighter">
                        {it.note || "-"} • {new Date(it.created_at || Date.now()).toLocaleString()} • {it.created_by || ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={"font-mono text-[12px] font-black " + (it.direction === "WE_OWE" ? "text-red-500" : "text-green-500")}>€{Number(it.amount || 0).toFixed(2)}</span>
                      {it.status !== "PAID" ? (
                        <button onClick={() => markPaid(it)} className="px-2 py-1 rounded text-[9px] font-black border border-green-900/50 text-green-500 bg-green-900/10">PAID</button>
                      ) : (
                        <span className="px-2 py-1 rounded text-[9px] font-black border border-gray-800 text-gray-500">PAID</span>
                      )}
                      <button onClick={() => removeItem(it)} className="px-2 py-1 rounded text-[9px] font-black border border-red-900/50 text-red-500 bg-red-900/10">FSHI</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
