"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

import { dbListPendingHanded, dbReceiveCycle } from "@/lib/arkaDb";

const euro = (n) => `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

export default function ArkaDispatchPage() {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState([]);

  async function refresh() {
    setBusy(true);
    try {
      const list = await dbListPendingHanded();
      setRows(list || []);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Gabim");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function acceptOne(cycle_id) {
    if (!cycle_id) return;
    setBusy(true);
    try {
      await dbReceiveCycle({ cycle_id, received_by: "DISPATCH" });
      await refresh();
    } catch (e) {
      console.error(e);
      alert(e?.message || "S’u pranua");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 20, color: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: 2 }}>ARKA</div>
          <div style={{ fontSize: 12, opacity: 0.8, fontWeight: 800 }}>DISPATCH · PRANO (RECEIVED)</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Link href="/arka" style={{ textDecoration: "none", color: "#fff", fontWeight: 800, opacity: 0.85 }}>
            KTHEHU
          </Link>
          <Link href="/" style={{ textDecoration: "none", color: "#fff", fontWeight: 800, opacity: 0.85 }}>
            HOME
          </Link>
        </div>
      </div>

      <button
        onClick={refresh}
        disabled={busy}
        style={{ width: "100%", marginBottom: 12, padding: "12px 14px", borderRadius: 12, border: "none", fontWeight: 900, cursor: "pointer" }}
      >
        {busy ? "DUKE NGARKU..." : "REFRESH"}
      </button>

      {rows.length === 0 ? (
        <div style={{ opacity: 0.8, fontWeight: 800, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", padding: 14, borderRadius: 14 }}>
          S’KA DORËZIME (HANDED) PËR PRANIM.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((c) => (
            <div
              key={c.id}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", padding: 14, borderRadius: 14 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 900 }}>
                  {c.day_key} · CIKLI #{c.cycle_no}
                </div>
                <button
                  onClick={() => acceptOne(c.id)}
                  disabled={busy}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "none", fontWeight: 900, cursor: "pointer" }}
                >
                  PRANO
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
                <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                  <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>OPEN</div>
                  <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(c.opening_cash)}</div>
                </div>
                <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                  <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>PRITET</div>
                  <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(c.expected_cash)}</div>
                </div>
                <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                  <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>NUMRUAR</div>
                  <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(c.cash_counted)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
