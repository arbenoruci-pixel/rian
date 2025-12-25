"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const LS_OWNERS = "ARKA_OWNERS";
const LS_MONTHS = "ARKA_MONTH_CLOSES";

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

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export default function ArkaOwnersPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [owners, setOwners] = useState([]);
  const [monthCloses, setMonthCloses] = useState([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({ name: "", percent: "" });

  const currentMonth = useMemo(() => monthKey(), []);

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
      await loadAll();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    // Supabase
    try {
      const { data: o, error: oe } = await supabase.from("arka_owners").select("*").order("id", { ascending: true });
      const { data: m, error: me } = await supabase.from("arka_month_close").select("*").order("month", { ascending: false });
      if (!oe && !me) {
        setOwners(o || []);
        setMonthCloses(m || []);
        return;
      }
    } catch {}

    setOwners(jparse(localStorage.getItem(LS_OWNERS), []));
    setMonthCloses(jparse(localStorage.getItem(LS_MONTHS), []));
  }

  const percentSum = useMemo(() => owners.reduce((a, o) => a + (Number(o.percent) || 0), 0), [owners]);

  async function addOwner() {
    const p = Number(form.percent);
    if (!form.name || !p) return alert("Plotëso EMRI dhe %.");
    const row = { name: form.name.toUpperCase(), percent: p };

    try {
      const { error } = await supabase.from("arka_owners").insert(row);
      if (!error) {
        setForm({ name: "", percent: "" });
        await loadAll();
        return;
      }
    } catch {}

    const local = jparse(localStorage.getItem(LS_OWNERS), []);
    const next = [...local, { id: Date.now(), ...row }];
    jstore(LS_OWNERS, next);
    setOwners(next);
    setForm({ name: "", percent: "" });
  }

  async function removeOwner(o) {
    if (!confirm("ME FSHI OWNER?")) return;
    if (typeof o.id === "number") {
      try {
        const { error } = await supabase.from("arka_owners").delete().eq("id", o.id);
        if (!error) {
          await loadAll();
          return;
        }
      } catch {}
    }
    const next = owners.filter((x) => x.id !== o.id);
    jstore(LS_OWNERS, next);
    setOwners(next);
  }

  async function closeMonth() {
    if (!confirm(`ME E MBYLL MUJIN ${currentMonth}?`)) return;

    // Pull totals from arka_moves (Supabase) if available.
    let inTotal = 0;
    let outTotal = 0;
    try {
      const start = `${currentMonth}-01T00:00:00.000Z`;
      const endD = new Date();
      // compute next month start
      const [yy, mm] = currentMonth.split("-").map(Number);
      const nextMonth = new Date(Date.UTC(yy, mm, 1, 0, 0, 0));
      const end = nextMonth.toISOString();
      const { data, error } = await supabase
        .from("arka_moves")
        .select("type,amount,created_at")
        .gte("created_at", start)
        .lt("created_at", end);
      if (!error && data) {
        inTotal = data.filter((m) => m.type === "IN").reduce((a, m) => a + (Number(m.amount) || 0), 0);
        outTotal = data.filter((m) => m.type === "OUT").reduce((a, m) => a + (Number(m.amount) || 0), 0);
      }
    } catch {}

    const net = inTotal - outTotal;

    const splits = owners.map((o) => ({ name: o.name, percent: Number(o.percent) || 0, amount: net * ((Number(o.percent) || 0) / 100) }));
    const row = {
      month: currentMonth,
      total_in: inTotal,
      total_out: outTotal,
      net,
      splits,
      closed_by: user?.name || "",
      closed_at: new Date().toISOString(),
    };

    try {
      const { error } = await supabase.from("arka_month_close").insert(row);
      if (!error) {
        await loadAll();
        alert("MUJI U MBYLL.");
        return;
      }
    } catch {}

    const local = jparse(localStorage.getItem(LS_MONTHS), []);
    const next = [{ id: Date.now(), ...row }, ...local];
    jstore(LS_MONTHS, next);
    setMonthCloses(next);
    alert("MUJI U MBYLL (LOCAL).\nNËSE DO SUPABASE, KRIJO TABELAT.");
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tighter">ARKA • OWNER SPLIT</h1>
            <p className="text-[10px] text-gray-500 tracking-widest">{user?.name} • {user?.role}</p>
          </div>
          <Link href="/arka" className="text-[10px] font-black tracking-widest text-gray-400 hover:text-white">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded p-4">
            <h3 className="text-[10px] font-black text-gray-400 mb-3 tracking-widest">OWNERS</h3>
            <div className="space-y-2">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="EMRI" className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white" />
              <input value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} aria-label="% PROFIT" type="number" step="any" className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white" />
              <button onClick={addOwner} className="w-full bg-blue-600 px-4 py-2 rounded text-[10px] font-black">SHTO</button>
              <div className="p-3 bg-black/40 border border-gray-800 rounded text-center">
                <p className="text-[9px] text-gray-500 font-black">TOTAL %</p>
                <p className={("text-lg font-mono font-black " + (Math.abs(percentSum - 100) < 0.001 ? "text-green-500" : "text-orange-500"))}>{percentSum.toFixed(2)}%</p>
                <p className="text-[9px] text-gray-500">(Syno 100%)</p>
              </div>
              <p className="text-[9px] text-gray-500">DB: <span className={"font-black " + (loading ? "text-gray-500" : "text-green-500")}>{loading ? "DUKE NGARKUAR" : "GATI"}</span></p>
            </div>
          </div>

          <div className="md:col-span-2 bg-gray-900 border border-gray-800 rounded">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-black text-gray-400 tracking-widest">Mbyllja mujore</p>
                <p className="text-[9px] text-gray-600">Kjo llogarit IN/OUT nga ARKA dhe i ndan sipas %.</p>
              </div>
              <button onClick={closeMonth} className="bg-green-600/20 text-green-500 border border-green-900/50 px-3 py-2 rounded text-[10px] font-black">MBYLLE {currentMonth}</button>
            </div>

            <div className="divide-y divide-gray-800">
              {owners.length === 0 ? (
                <div className="p-10 text-center text-[10px] text-gray-600 tracking-widest italic">SHTO OWNERS</div>
              ) : (
                owners.map((o) => (
                  <div key={o.id} className="p-3 flex items-center justify-between hover:bg-black/20">
                    <div>
                      <p className="text-[10px] font-black text-gray-200">{o.name}</p>
                      <p className="text-[8px] text-gray-500">% {Number(o.percent || 0).toFixed(2)}</p>
                    </div>
                    <button onClick={() => removeOwner(o)} className="px-2 py-1 rounded text-[9px] font-black border border-red-900/50 text-red-500 bg-red-900/10">FSHI</button>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-gray-800 p-4">
              <h4 className="text-[10px] font-black text-gray-400 tracking-widest mb-2">HISTORIK MUJOR</h4>
              <div className="divide-y divide-gray-800">
                {monthCloses.length === 0 ? (
                  <div className="p-6 text-center text-[10px] text-gray-600 tracking-widest italic">S’KA HISTORIK</div>
                ) : (
                  monthCloses.map((m) => (
                    <div key={m.id || m.month} className="p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-black text-blue-400">{m.month}</p>
                        <p className="text-[10px] font-mono font-black text-white">NET €{Number(m.net || 0).toFixed(2)}</p>
                      </div>
                      <p className="text-[8px] text-gray-500">IN €{Number(m.total_in || 0).toFixed(2)} • OUT €{Number(m.total_out || 0).toFixed(2)} • {m.closed_by || ""}</p>
                      {Array.isArray(m.splits) && m.splits.length > 0 && (
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {m.splits.map((s, idx) => (
                            <div key={idx} className="bg-black/30 border border-gray-800 rounded p-2 flex items-center justify-between">
                              <p className="text-[9px] font-black text-gray-300">{s.name}</p>
                              <p className="text-[9px] font-mono font-black text-green-500">€{Number(s.amount || 0).toFixed(2)}</p>
                            </div>
                          ))}
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
