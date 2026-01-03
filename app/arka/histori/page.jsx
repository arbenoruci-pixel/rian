"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

import { dbGetHistoryDay, dbListHistoryDays } from "@/lib/arkaDb";

const euro = (n) => `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

export default function ArkaHistoriPage() {
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);

  async function loadDays() {
    setBusy(true);
    try {
      const list = await dbListHistoryDays(30);
      setDays(list || []);
      const firstKey = (list || [])[0]?.day_key || null;
      setSelectedKey((prev) => prev || firstKey);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Gabim në histori");
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(day_key) {
    if (!day_key) return;
    setBusy(true);
    try {
      const d = await dbGetHistoryDay(day_key);
      setDetail(d);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Gabim në detaje");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadDays();
  }, []);

  useEffect(() => {
    if (selectedKey) loadDetail(selectedKey);
  }, [selectedKey]);

  const totals = detail?.totals || null;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 20, color: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: 2 }}>ARKA</div>
          <div style={{ fontSize: 12, opacity: 0.8, fontWeight: 800 }}>HISTORI</div>
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

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12 }}>
        <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 900, opacity: 0.6, marginBottom: 8 }}>DITËT</div>
          <button
            onClick={loadDays}
            disabled={busy}
            style={{ width: "100%", marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "none", fontWeight: 900, cursor: "pointer" }}
          >
            {busy ? "DUKE NGARKU..." : "REFRESH"}
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 520, overflow: "auto" }}>
            {days.length === 0 ? (
              <div style={{ opacity: 0.7, fontWeight: 700 }}>S’ka të dhëna.</div>
            ) : (
              days.map((d) => (
                <button
                  key={d.id || d.day_key}
                  onClick={() => setSelectedKey(d.day_key)}
                  style={{
                    textAlign: "left",
                    padding: "10px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: selectedKey === d.day_key ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  {d.day_key}
                </button>
              ))
            )}
          </div>
        </div>

        <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 14 }}>
          {!detail ? (
            <div style={{ opacity: 0.7, fontWeight: 800 }}>Zgjedh një ditë…</div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{detail.day?.day_key || selectedKey}</div>
                {totals ? (
                  <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800 }}>
                    CIKLE: {totals.cycles} · IN: {euro(totals.ins)} · OUT: {euro(totals.outs)}
                  </div>
                ) : null}
              </div>

              {totals ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
                  <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                    <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>PRITET</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(totals.expected)}</div>
                  </div>
                  <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                    <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>NUMRUAR</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(totals.counted)}</div>
                  </div>
                  <div style={{ background: "rgba(0,0,0,0.25)", padding: 12, borderRadius: 12 }}>
                    <div style={{ fontSize: 10, opacity: 0.6, fontWeight: 900 }}>DIFERENCA</div>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{euro(totals.discrepancy)}</div>
                  </div>
                </div>
              ) : null}

              <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 900, marginBottom: 8 }}>CIKLET</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(detail.cycles || []).length === 0 ? (
                  <div style={{ opacity: 0.7, fontWeight: 700 }}>S’ka cikle për këtë ditë.</div>
                ) : (
                  (detail.cycles || []).map((c) => (
                    <div key={c.id} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <div style={{ fontWeight: 900 }}>CIKLI #{c.cycle_no}</div>
                        <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800 }}>
                          OPEN: {euro(c.opening_cash)} · PRITET: {euro(c._expected)}
                        </div>
                      </div>

                      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.6, fontWeight: 900 }}>LËVIZJE</div>
                      {(c._moves || []).length === 0 ? (
                        <div style={{ opacity: 0.7, fontWeight: 700, marginTop: 6 }}>S’ka lëvizje.</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                          {(c._moves || []).slice(0, 30).map((m) => (
                            <div
                              key={m.id}
                              style={{
                                display: "flex",
                                gap: 10,
                                alignItems: "center",
                                background: "rgba(255,255,255,0.03)",
                                borderRadius: 10,
                                padding: "8px 10px",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 10,
                                  fontWeight: 900,
                                  padding: "2px 6px",
                                  borderRadius: 6,
                                  background: String(m.type || "").toUpperCase() === "IN" ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)",
                                  color: String(m.type || "").toUpperCase() === "IN" ? "#86efac" : "#fca5a5",
                                }}
                              >
                                {String(m.type || "").toUpperCase()}
                              </div>
                              <div style={{ flex: 1, fontWeight: 700, opacity: 0.95 }}>{m.note}</div>
                              <div style={{ fontWeight: 900 }}>{euro(m.amount)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
