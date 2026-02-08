"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession, clearTransportSession } from "@/lib/transportAuth";

// --- KAPACITETI ---
function m2ToLevel(m2) {
  const v = Number(m2) || 0;
  if (v >= 140) return "HIGH";
  if (v >= 80) return "MID";
  return "LOW";
}

function safeJson(raw) {
  try {
    if (typeof raw === "string") return JSON.parse(raw);
    return raw || {};
  } catch {
    return {};
  }
}

function calculateM2(rows) {
  let m2 = 0;
  for (const r of rows || []) {
    const o = safeJson(r?.data);

    const tepiha = Array.isArray(o.tepiha)
      ? o.tepiha
      : (o.tepihaRows || []).map((x) => ({
          m2: Number(x?.m2) || 0,
          qty: Number(x?.qty ?? x?.pieces) || 0,
        }));
    const staza = Array.isArray(o.staza)
      ? o.staza
      : (o.stazaRows || []).map((x) => ({
          m2: Number(x?.m2) || 0,
          qty: Number(x?.qty ?? x?.pieces) || 0,
        }));

    for (const x of tepiha) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);
    for (const x of staza) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);
    if (o?.shkallore) m2 += (Number(o?.shkallore?.qty) || 0) * (Number(o?.shkallore?.per) || 0);
  }
  return Number(m2.toFixed(1));
}

async function loadStats(transportId) {
  // 1) BAZA (PASTRIMI): porositë në pastrim (baza + transport)
  const [bazaNormal, bazaTrans] = await Promise.all([
    supabase.from("orders").select("data").eq("status", "pastrim").limit(500),
    supabase.from("transport_orders").select("data").eq("status", "pastrim").limit(500),
  ]);

  const bazaRows = [...(bazaNormal.data || []), ...(bazaTrans.data || [])];
  const bazaM2 = calculateM2(bazaRows);

  // 2) KAMIONI (PICKUP + LOADED): porositë e mia në rrugë
  let truckRows = [];
  if (transportId) {
    const statuses = ["pickup", "loaded", "transport"]; // fallback
    const [truckNormal, truckTrans] = await Promise.all([
      supabase
        .from("orders")
        .select("data")
        .eq("transport_id", transportId)
        .in("status", statuses)
        .limit(500),
      supabase
        .from("transport_orders")
        .select("data")
        .eq("transport_id", transportId)
        .in("status", statuses)
        .limit(500),
    ]);
    truckRows = [...(truckNormal.data || []), ...(truckTrans.data || [])];
  }
  const truckM2 = calculateM2(truckRows);
  const truckCount = truckRows.length;

  // 3) TË PA PLOTSUARA (vetëm transport_orders)
  let draftsCount = 0;
  if (transportId) {
    const d = await supabase
      .from("transport_orders")
      .select("id", { count: "exact", head: true })
      .eq("transport_id", transportId)
      .eq("status", "draft");
    draftsCount = d.count || 0;
  }

  return {
    baza: { m2: bazaM2, level: m2ToLevel(bazaM2) },
    truck: { m2: truckM2, count: truckCount },
    draftsCount,
  };
}

function readActor() {
  try {
    const s = getTransportSession();
    if (!s?.transport_id) return null;
    return {
      role: s.role || "TRANSPORT",
      name: s.transport_name || "TRANSPORT",
      id: s.transport_id,
    };
  } catch {
    return null;
  }
}

export default function TransportHome() {
  const [me, setMe] = useState(null);
  const [stats, setStats] = useState({
    baza: { m2: 0, level: "..." },
    truck: { m2: 0, count: 0 },
    draftsCount: 0,
  });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshData() {
    setRefreshing(true);
    try {
      const actor = readActor();
      const v = await loadStats(actor?.id || null);
      setStats(v);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const actor = readActor();
    setMe(actor);
    loadStats(actor?.id || null).then(setStats).catch(() => {});

    const t = setInterval(() => {
      const currentActor = readActor();
      if (currentActor?.id) loadStats(currentActor.id).then(setStats).catch(() => {});
    }, 30000);

    return () => clearInterval(t);
  }, []);

  const truckPercent = useMemo(() => Math.min(((stats.truck.m2 || 0) / 200) * 100, 100), [stats.truck.m2]);
  const basePercent = useMemo(() => Math.min(((stats.baza.m2 || 0) / 150) * 100, 100), [stats.baza.m2]);

  const truckColor = useMemo(() => {
    if (truckPercent > 95) return "#ef4444";
    if (truckPercent > 80) return "#f59e0b";
    return "#3b82f6";
  }, [truckPercent]);

  const { baseColor, baseText } = useMemo(() => {
    if (stats.baza.level === "HIGH") return { baseColor: "#ef4444", baseText: "FULL" };
    if (stats.baza.level === "MID") return { baseColor: "#f59e0b", baseText: "MESATAR" };
    return { baseColor: "#10b981", baseText: "LIRË" };
  }, [stats.baza.level]);

  function logout() {
    try {
      clearTransportSession();
    } catch {}
    window.location.href = "/transport/login";
  }

  return (
    <div style={{ backgroundColor: "#f0f2f5", minHeight: "100vh", padding: "20px 16px", fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#111827", margin: 0 }}>TRANSPORT</h1>
            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>
              {me ? `HYRJE ME PIN • ${me.name}` : "HYRJE"}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Link href="/transport/menu" style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", textDecoration: "none" }}>
              MENU
            </Link>
            {me ? (
              <button onClick={logout} style={{ border: "none", background: "#111827", color: "#fff", fontWeight: 700, fontSize: 12, padding: "10px 12px", borderRadius: 999, cursor: "pointer" }}>
                LOG OUT
              </button>
            ) : (
              <Link href="/transport/login" style={{ fontSize: 12, fontWeight: 800, color: "#111827", textDecoration: "none" }}>
                HYRJE
              </Link>
            )}
          </div>
        </header>

        {!me ? (
          <div style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 4px 10px rgba(0,0,0,0.06)" }}>
            <div style={{ fontWeight: 800, color: "#111827", marginBottom: 8 }}>HYRJE</div>
            <div style={{ fontSize: 13, color: "#475569" }}>Shko te HYRJE me PIN për të vazhduar.</div>
            <div style={{ marginTop: 12 }}>
              <Link href="/transport/login" style={{ display: "inline-block", background: "#2563eb", color: "#fff", padding: "10px 14px", borderRadius: 12, fontWeight: 800, textDecoration: "none" }}>
                HYRJE
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* STATISTIKA */}
            <div style={{ backgroundColor: "#fff", borderRadius: 16, padding: "16px 20px", boxShadow: "0 4px 10px rgba(0,0,0,0.06)", marginBottom: 18 }}>
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "flex-end" }}>
                  <span style={{ fontSize: 12, color: "#475569", fontWeight: 800 }}>KAMIONI IM (PICKUP + LOADED)</span>
                  <span style={{ fontSize: 12, color: "#334155", fontWeight: 700 }}>
                    {stats.truck.count} Porosi <span style={{ color: "#cbd5e1" }}>|</span> {Math.round(stats.truck.m2)} m²
                  </span>
                </div>
                <div style={{ height: 12, width: "100%", backgroundColor: "#f1f5f9", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${truckPercent}%`, backgroundColor: truckColor, borderRadius: 10, transition: "width 0.25s ease" }} />
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "flex-end" }}>
                  <span style={{ fontSize: 12, color: "#475569", fontWeight: 800 }}>NGARKESA NË BAZË (PASTRIM)</span>
                  <span style={{ fontSize: 12, color: baseColor, fontWeight: 900 }}>{baseText}</span>
                </div>
                <div style={{ height: 10, width: "100%", backgroundColor: "#f8fafc", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${basePercent}%`, backgroundColor: baseColor, borderRadius: 10, opacity: 0.85, transition: "width 0.25s ease" }} />
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "#475569", fontWeight: 800 }}>
                  TË PA PLOTSUARA: <span style={{ color: "#111827" }}>{stats.draftsCount}</span>
                </div>
                <button onClick={refreshData} style={{ background: "none", border: "none", fontSize: 12, color: "#2563eb", fontWeight: 800, cursor: "pointer" }}>
                  {refreshing ? "DUKE LLOGARITUR..." : "REFRESH"}
                </button>
              </div>
            </div>

            {/* VEPRIMET KRYESORE */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
              <Link href="/transport/pranimi" style={{ textDecoration: "none" }}>
                <div style={primaryCardStyle("#2563eb")}>
                  <span style={{ fontSize: 28, marginBottom: 8 }}>📥</span>
                  <span style={{ fontWeight: 900, fontSize: 15, letterSpacing: 0.2 }}>PRANIMI</span>
                </div>
              </Link>
              <Link href="/transport/pickup" style={{ textDecoration: "none" }}>
                <div style={primaryCardStyle("#4f46e5")}>
                  <span style={{ fontSize: 28, marginBottom: 8 }}>🚚</span>
                  <span style={{ fontWeight: 900, fontSize: 15, letterSpacing: 0.2 }}>PICKUP</span>
                </div>
              </Link>
            </div>

            {/* VEPRIMET TJERA */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Link href="/transport/loaded" style={secondaryCardStyle}>
                <span>📦 LOADED</span>
              </Link>
              <Link href="/transport/offload" style={secondaryCardStyle}>
                <span>🏁 SHKARKO NË BAZË</span>
              </Link>
              <Link href="/transport/te-pa-plotsuara" style={secondaryCardStyle}>
                <span>🧾 TË PA PLOTSUARA</span>
              </Link>
              <Link href="/transport/arka" style={secondaryCardStyle}>
                <span>💰 ARKA</span>
              </Link>
              <Link href="/transport/fletore" style={secondaryCardStyle}>
                <span>📝 FLETORJA</span>
              </Link>
              <Link href="/pastrimi" style={secondaryCardStyle}>
                <span>🧼 PASTRIMI</span>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const primaryCardStyle = (bg) => ({
  backgroundColor: bg,
  color: "white",
  padding: "22px 16px",
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: `0 10px 18px -6px ${bg}40`,
  height: 120,
});

const secondaryCardStyle = {
  backgroundColor: "#ffffff",
  color: "#111827",
  borderRadius: 12,
  padding: "16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 900,
  fontSize: 12,
  textDecoration: "none",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  height: 56,
  letterSpacing: 0.2,
};
