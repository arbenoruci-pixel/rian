"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  dbCanWork,
  dbGetOpenDay,
  dbListMoves,
  dbAddMove,
  getLocalDay,
  getLocalMoves,
  setLocalMoves,
  calcTotals,
} from "@/lib/arkaDb";

// ARKA • SHPENZIME
// - Supabase master (nëse dbCanWork=true)
// - Local fallback (nëse offline)
// - Shfaq vetëm lëvizjet OUT

export default function ArkaShpenzimePage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("checking"); // checking | db | local
  const [day, setDay] = useState({ isOpen: false, initialCash: 0 });
  const [moves, setMoves] = useState([]);
  const [form, setForm] = useState({ amount: "", note: "" });

  useEffect(() => {
    const u = JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null");
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);

    (async () => {
      const ok = await dbCanWork();
      if (ok) {
        setMode("db");
        const open = await dbGetOpenDay();
        if (open) {
          const ms = await dbListMoves(open.id);
          setDay({
            isOpen: true,
            initialCash: Number(open.initial_cash || 0),
            dayId: open.id,
            openedAt: open.opened_at,
          });
          setMoves(ms);
        } else {
          setDay({ isOpen: false, initialCash: 0 });
          setMoves([]);
        }
      } else {
        setMode("local");
        const lsDay = getLocalDay();
        const lsMoves = getLocalMoves();
        setDay(lsDay);
        setMoves(lsMoves);
      }
    })();
  }, [router]);

  const outMoves = useMemo(() => (moves || []).filter((m) => m.type === "OUT"), [moves]);
  const totals = useMemo(() => calcTotals(day.initialCash, moves), [day.initialCash, moves]);

  const isAdmin = user?.role === "ADMIN" || user?.role === "OWNER";
  const canCash = isAdmin || user?.role === "DISPATCH";

  async function addExpense() {
    if (!day.isOpen) return alert("HAP DITËN NË BUXHETI / CASH");
    if (!canCash) return;

    const amt = Number(form.amount);
    if (!amt || !form.note.trim()) return alert("PLOTËSO SHUMËN DHE SHËNIMIN");

    const payload = {
      type: "OUT",
      amount: amt,
      note: form.note.trim().toUpperCase(),
      source: "CASH",
    };

    if (mode === "db") {
      const m = await dbAddMove({ day_id: day.dayId, ...payload, created_by: user.name });
      setMoves((prev) => [m, ...prev]);
    } else {
      const m = { id: Date.now(), created_at: new Date().toISOString(), created_by: user.name, ...payload };
      const next = [m, ...moves];
      setLocalMoves(next);
      setMoves(next);
    }

    setForm({ amount: "", note: "" });
  }

  if (!user) return null;

  if (user.role === "TRANSPORT") {
    return (
      <div className="min-h-screen bg-black text-gray-200 p-6 uppercase">
        <div className="max-w-xl mx-auto border border-gray-800 rounded p-6 bg-gray-900">
          <p className="text-[11px] text-red-400 font-black tracking-widest">NO ACCESS</p>
          <p className="text-[10px] text-gray-400 mt-2">TRANSPORT NUK KA QASJE NË ARKË.</p>
          <div className="mt-4">
            <Link className="inline-block px-4 py-2 rounded bg-gray-800 text-[10px] font-black" href="/arka">KTHEHU</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="uppercase">
      <div className="max-w-4xl mx-auto">
        <div className="arka-top">
          <div>
            <div className="arka-title">ARKA • SHPENZIME</div>
            <div className="arka-sub">{user?.name} • {user?.role} • {mode === "db" ? "ONLINE" : "LOCAL"}</div>
          </div>
          <Link href="/arka" className="arka-back">KTHEHU</Link>
        </div>

<Link href="/arka" className="text-[10px] font-black px-3 py-2 rounded border border-gray-800 hover:bg-gray-900">KTHEHU</Link>
        </div>

        {!day.isOpen ? (
          <div className="bg-gray-900 border border-gray-800 p-8 rounded text-center">
            <h2 className="text-sm font-black mb-4 text-gray-500 tracking-widest">DITA S’ËSHTË E HAPUR</h2>
            <p className="text-[10px] text-gray-400">HAPE DITËN TE: ARKA → BUXHETI (CASH)</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-4">
              <section className="bg-gray-900 p-4 rounded border border-gray-800">
                <h3 className="text-[10px] font-black mb-3 text-gray-400 tracking-widest">SHTO SHPENZIM</h3>
                {!canCash ? (
                  <p className="text-[10px] text-red-500 font-black tracking-widest bg-red-900/10 p-2 border border-red-900/20 inline-block">
                    VETËM ADMIN/OWNER/DISPATCH
                  </p>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="number"
                      step="any"
                      aria-label="SHUMA €"
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                      className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white"
                      placeholder="SHUMA (€)"
                    />
                    <input
                      type="text"
                      aria-label="SHËNIMI"
                      value={form.note}
                      onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                      className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white"
                      placeholder="ARSYEJA"
                    />
                    <button
                      onClick={addExpense}
                      className="w-full bg-red-600/15 text-red-300 border border-red-900/60 py-2 rounded text-[10px] font-black hover:bg-red-600 hover:text-white transition"
                    >
                      RUAJ
                    </button>
                  </div>
                )}
              </section>

              <div className="p-4 bg-gray-900 border border-gray-800 rounded grid grid-cols-2 gap-2 text-center">
                <div>
                  <p className="text-[8px] text-gray-500 font-black">DALJE SOT</p>
                  <p className="text-xs font-mono font-bold text-red-400">€{totals.out.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[8px] text-gray-500 font-black">TOTAL CASH</p>
                  <p className="text-xs font-mono font-bold text-blue-400">€{totals.total.toFixed(2)}</p>
                </div>
              </div>
            </div>

            <div className="md:col-span-2">
              <div className="bg-gray-900 border border-gray-800 rounded overflow-hidden">
                <div className="p-3 border-b border-gray-800 text-[10px] font-black text-gray-400 tracking-widest">
                  LISTA • OUT
                </div>
                <div className="divide-y divide-gray-800">
                  {outMoves.length === 0 ? (
                    <div className="p-4 text-[10px] text-gray-500">S’KA SHPENZIME SOT.</div>
                  ) : (
                    outMoves.map((m) => (
                      <div key={m.id} className="p-3 flex items-center justify-between">
                        <div>
                          <div className="text-[10px] font-black text-white">{m.note}</div>
                          <div className="text-[9px] text-gray-500">{m.created_by || ""}</div>
                        </div>
                        <div className="text-[10px] font-mono font-bold text-red-400">€{Number(m.amount || 0).toFixed(2)}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
