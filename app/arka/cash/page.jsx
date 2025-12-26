"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  dbCanWork,
  dbGetOpenDay,
  dbOpenDay,
  dbCloseDay,
  dbListMoves,
  dbAddMove,
  getLocalDay,
  setLocalDay,
  getLocalMoves,
  setLocalMoves,
  calcTotals,
} from "@/lib/arkaDb";

export default function ArkaCashPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState("checking"); // checking | db | local
  const [day, setDay] = useState({ isOpen: false, initialCash: 0 });
  const [moves, setMoves] = useState([]);
  const [form, setForm] = useState({ amount: "", note: "", type: "IN" });

  useEffect(() => {
    const u = JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null");
    if (!u) {
      router.push("/login");
      return;
    }
    // Do NOT auto-redirect to /transport. Just block in-page.
    setUser(u);

    (async () => {
      const ok = await dbCanWork();
      if (ok) {
        setMode("db");
        const open = await dbGetOpenDay();
        if (open) {
          const ms = await dbListMoves(open.id);
          setDay({ isOpen: true, initialCash: Number(open.initial_cash || 0), dayId: open.id, openedAt: open.opened_at });
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

  const totals = useMemo(() => calcTotals(day.initialCash, moves), [day.initialCash, moves]);

  const isAdmin = user?.role === "ADMIN" || user?.role === "OWNER";
  const canCash = isAdmin || user?.role === "DISPATCH";

  async function openDay(e) {
    e.preventDefault();
    if (!canCash) return;
    const initialCash = Number(e.target.initial_cash.value || 0);
    if (mode === "db") {
      const opened = await dbOpenDay({ initial_cash: initialCash, opened_by: user.name });
      setDay({ isOpen: true, initialCash, dayId: opened.id, openedAt: opened.opened_at });
      setMoves([]);
    } else {
      const nextDay = { isOpen: true, initialCash, openedAt: new Date().toISOString(), openedBy: user.name };
      setLocalDay(nextDay);
      setLocalMoves([]);
      setDay(nextDay);
      setMoves([]);
    }
  }

  async function closeDay() {
    if (!canCash) return;
    if (!confirm("MBYLL DITËN?")) return;
    if (mode === "db") {
      await dbCloseDay({ day_id: day.dayId, closed_by: user.name });
      setDay({ isOpen: false, initialCash: 0 });
      setMoves([]);
    } else {
      setLocalDay({ isOpen: false, initialCash: 0 });
      setLocalMoves([]);
      setDay({ isOpen: false, initialCash: 0 });
      setMoves([]);
    }
  }

  async function addMove() {
    if (!day.isOpen) return alert("HAP DITËN SË PARI");
    const amt = Number(form.amount);
    if (!amt || !form.note.trim()) return alert("PLOTËSO SHUMËN DHE SHËNIMIN");
    const payload = {
      type: form.type,
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
    setForm({ amount: "", note: "", type: "IN" });
  }

  if (!user) return null;

  // Transport should never land here; but if it does, keep it safe.
  if (user.role === "TRANSPORT") {
    return (
      <div className="min-h-screen bg-black text-gray-200 p-6 uppercase">
        <div className="max-w-xl mx-auto border border-gray-800 rounded p-6 bg-gray-900">
          <p className="text-[11px] text-red-400 font-black tracking-widest">NO ACCESS</p>
          <p className="text-[10px] text-gray-400 mt-2">TRANSPORT NUK KA QASJE NË ARKË.</p>
          <div className="mt-4">
            <Link className="inline-block px-4 py-2 rounded bg-gray-800 text-[10px] font-black" href="/arka">
              KTHEHU
            </Link>
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
            <div className="arka-title">ARKA • CASH</div>
            <div className="arka-sub">{user.name} • {user.role} • {mode === "db" ? "ONLINE" : "LOCAL"}</div>
          </div>
          <Link href="/arka" className="arka-back">KTHEHU</Link>
        </div>

        </div>

        {!day.isOpen ? (
          <div className="arka-card">
            <h2 className="text-sm font-black mb-4 text-gray-500 tracking-widest">ARKA E MBYLLUR</h2>
            {canCash ? (
              <form onSubmit={openDay} className="flex flex-col items-center gap-2">
                <input
                  name="initial_cash"
                  type="number"
                  step="any"
                  aria-label="EURO FILLIMI"
                  className="bg-black border border-gray-700 p-2 rounded w-48 text-center text-sm text-white"
                  required
                />
                <button type="submit" className="bg-blue-600 px-8 py-2 rounded text-xs font-black">
                  HAP DITËN
                </button>
              </form>
            ) : (
              <p className="text-[10px] text-red-500 font-black tracking-widest bg-red-900/10 p-2 border border-red-900/20 inline-block">
                VETËM ADMIN/OWNER/DISPATCH MUND TË HAPË ARKËN
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-4">
              <section className="arka-card">
                <h3 className="text-[10px] font-black mb-3 text-gray-400 tracking-widest">SHTO LËVIZJE</h3>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setForm((f) => ({ ...f, type: "IN" }))}
                      className={`py-2 rounded text-[10px] font-black border ${form.type === "IN" ? "bg-green-600/30 text-green-300 border-green-900/70" : "bg-black text-gray-400 border-gray-800"}`}
                    >
                      PAGESË
                    </button>
                    <button
                      onClick={() => setForm((f) => ({ ...f, type: "OUT" }))}
                      className={`py-2 rounded text-[10px] font-black border ${form.type === "OUT" ? "bg-red-600/30 text-red-300 border-red-900/70" : "bg-black text-gray-400 border-gray-800"}`}
                    >
                      SHPENZIM
                    </button>
                  </div>
                  <input
                    type="number"
                    step="any"
                    aria-label="SHUMA €"
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white"
                  />
                  <input
                    type="text"
                    aria-label="SHËNIMI"
                    value={form.note}
                    onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    className="w-full bg-black border border-gray-700 p-2 rounded text-sm text-white"
                  />
                  <button onClick={addMove} className="w-full bg-blue-600/20 text-blue-300 border border-blue-900/60 py-2 rounded text-[10px] font-black hover:bg-blue-600 hover:text-white transition">
                    RUAJ
                  </button>
                </div>
              </section>

              {canCash && (
                <button onClick={closeDay} className="w-full border border-gray-800 text-gray-400 py-2 rounded text-[10px] font-black hover:bg-gray-900 transition">
                  MBYLL DITËN
                </button>
              )}
            </div>

            <div className="md:col-span-2 space-y-4">
              <div className="p-4 bg-gray-900 border border-gray-800 rounded grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-[8px] text-gray-500 font-black">FILLIMI</p>
                  <p className="text-xs font-mono font-bold">€{totals.initial.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[8px] text-gray-500 font-black">HYRJE</p>
                  <p className="text-xs font-mono font-bold text-green-400">€{totals.in.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[8px] text-gray-500 font-black">DALJE</p>
                  <p className="text-xs font-mono font-bold text-red-400">€{totals.out.toFixed(2)}</p>
                </div>
                <div className="bg-blue-500/5 rounded">
                  <p className="text-[8px] text-blue-400 font-black">TOTALI</p>
                  <p className="text-xs font-mono font-bold text-blue-400">€{totals.total.toFixed(2)}</p>
                </div>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded">
                <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                  <p className="text-[10px] font-black text-gray-400 tracking-widest">LËVIZJET</p>
                  <p className="text-[9px] text-gray-600">{moves.length} RRESHTA</p>
                </div>
                <div className="divide-y divide-gray-800">
                  {moves.length === 0 ? (
                    <p className="p-10 text-center text-[10px] text-gray-600 tracking-widest italic">NUK KA LËVIZJE</p>
                  ) : (
                    moves.map((m) => (
                      <div key={m.id} className="p-3 flex justify-between items-center hover:bg-black/20">
                        <div>
                          <p className="text-[10px] font-black text-gray-200">{String(m.note || "").toUpperCase()}</p>
                          <p className="text-[8px] text-gray-500 tracking-tighter">
                            {new Date(m.created_at || m.at || Date.now()).toLocaleTimeString()} • {m.created_by || m.user}
                          </p>
                        </div>
                        <span className={`font-mono text-[11px] font-black ${m.type === "IN" ? "text-green-400" : "text-red-400"}`}>
                          {m.type === "IN" ? "+" : "-"}€{Number(m.amount || 0).toFixed(2)}
                        </span>
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
