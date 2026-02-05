"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const LS_KEYS = {
  day: "ARKA_STATE",
  moves: "ARKA_MOVES",
  approvals: "ARKA_APPROVALS",
  users: "ARKA_USERS",
  debts: "ARKA_DEBTS",
  owners: "ARKA_OWNERS",
  months: "ARKA_MONTH_CLOSES",
  counters: "code_counter",
};

export default function ArkaSettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [dbStatus, setDbStatus] = useState({ ok: false, msg: "" });

  useEffect(() => {
    const u = (() => {
      try {
        return JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "");
      } catch {
        return null;
      }
    })();
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);
    (async () => {
      // quick check: can we query arka_days?
      const { error } = await supabase.from("arka_days").select("id").limit(1);
      if (error) {
        setDbStatus({ ok: false, msg: error.message });
      } else {
        setDbStatus({ ok: true, msg: "OK" });
      }
    })();
  }, [router]);

  if (!user) return null;
  const isAdmin = user.role === "ADMIN" || user.role === "OWNER";

  const wipeLocal = (which) => {
    if (!isAdmin) return;
    if (!confirm(`A JENI TË SIGURT? (${which})`)) return;
    if (which === "ALL") {
      Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
    } else {
      localStorage.removeItem(LS_KEYS[which]);
    }
    alert("U FSHI LOCAL CACHE.");
  };

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tighter">ARKA • SETTINGS</h1>
            <p className="text-[10px] text-gray-500 tracking-widest">{user.name} • {user.role}</p>
          </div>
          <Link href="/arka" className="text-[10px] font-black text-gray-400 hover:text-white">KTHEHU</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <section className="bg-gray-900 border border-gray-800 rounded p-4">
            <h2 className="text-[10px] font-black tracking-widest text-gray-400">SUPABASE STATUS</h2>
            <div className="mt-3 text-[10px]">
              {dbStatus.ok ? (
                <p className="text-green-400 font-black">LIDHJA: OK</p>
              ) : (
                <p className="text-orange-400 font-black">LIDHJA: JO (DUHET TABLET/SETUP)</p>
              )}
              <p className="text-gray-500 mt-1 normal-case">{dbStatus.msg}</p>
            </div>
            <div className="mt-4 text-[10px] text-gray-500 normal-case">
              Nëse LIDHJA është JO, ekzekuto SQL-në: <span className="font-mono">/supabase/arka_schema.sql</span>.
            </div>
          </section>

          <section className="bg-gray-900 border border-gray-800 rounded p-4">
            <h2 className="text-[10px] font-black tracking-widest text-gray-400">LOCAL CACHE</h2>
            <p className="text-[9px] text-gray-600 mt-2 normal-case">
              Këto butona fshijnë vetëm cache-in lokal. Nuk prekin Supabase.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                onClick={() => wipeLocal("moves")}
                disabled={!isAdmin}
                className="py-2 rounded border border-gray-800 text-[10px] font-black text-gray-300 hover:bg-black/30 disabled:opacity-40"
              >
                WIPE MOVES
              </button>
              <button
                onClick={() => wipeLocal("users")}
                disabled={!isAdmin}
                className="py-2 rounded border border-gray-800 text-[10px] font-black text-gray-300 hover:bg-black/30 disabled:opacity-40"
              >
                WIPE STAFF
              </button>
              <button
                onClick={() => wipeLocal("debts")}
                disabled={!isAdmin}
                className="py-2 rounded border border-gray-800 text-[10px] font-black text-gray-300 hover:bg-black/30 disabled:opacity-40"
              >
                WIPE DEBTS
              </button>
              <button
                onClick={() => wipeLocal("ALL")}
                disabled={!isAdmin}
                className="py-2 rounded border border-red-900/50 text-[10px] font-black text-red-300 hover:bg-red-900/10 disabled:opacity-40"
              >
                WIPE ALL
              </button>
            </div>
          </section>
        </div>

        <section className="bg-gray-900 border border-gray-800 rounded p-4 mt-4">
          <h2 className="text-[10px] font-black tracking-widest text-gray-400">README</h2>
          <p className="text-[9px] text-gray-600 mt-2 normal-case">
            Dokumentacioni i moduleve:
          </p>
          <ul className="mt-3 space-y-2 text-[10px]">
            <li className="text-gray-300"><span className="font-mono">/docs/arka/01-cash.md</span></li>
            <li className="text-gray-300"><span className="font-mono">/docs/arka/02-staff.md</span></li>
            <li className="text-gray-300"><span className="font-mono">/docs/arka/03-debts.md</span></li>
            <li className="text-gray-300"><span className="font-mono">/docs/arka/04-owners.md</span></li>
          </ul>
        </section>
      </div>
    </div>
  );
}
