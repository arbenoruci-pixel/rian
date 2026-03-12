"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("sq-AL", { day: '2-digit', month: '2-digit' });
  } catch {
    return String(d);
  }
}

function codeLabel(o){
  const s = String(o?.code ?? "").trim();
  if (s) return s;
  return "";
}

// 🔥 PDF DOWNLOAD DIREKT PA PRINT DIALOG
function doPdfDownload() {
  if (typeof window === "undefined") return;
  const oldTitle = document.title;
  document.title = `Fletore_${new Date().toISOString().slice(0, 10)}`;
  window.print(); // Në mobile hap menu-në për "Save as PDF", në PC hapet direkt
  document.title = oldTitle;
}

export default function FletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [pin, setPin] = useState("");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  // Helper për emrin
  const nameOfClient = (c) => {
    const full = String(c?.full_name || c?.name || "").trim();
    if (full) return full;
    const fn = String(c?.first_name || "").trim();
    const ln = String(c?.last_name || "").trim();
    return `${fn} ${ln}`.trim() || "-";
  };

  const phoneOfClient = (c) => String(c?.phone || c?.client_phone || "").trim() || "-";

  // --- Helpers for orders ---
  const normCode = (v) => String(v ?? "").trim().replace(/\D+/g, "").replace(/^0+/, "");

  function getOrderData(o) {
    const d = o?.data;
    if (!d) return {};
    if (typeof d === "object") return d;
    try { return JSON.parse(String(d)); } catch { return {}; }
  }

  function payOfOrder(o) {
    const d = getOrderData(o);
    return d?.pay && typeof d.pay === "object" ? d.pay : {};
  }

  function piecesSummaryFromOrder(o) {
    const d = getOrderData(o);
    const t = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
    const s = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);
    
    let total = 0;
    for (const r of t) total += Number(r.qty) || 0;
    for (const r of s) total += Number(r.qty) || 0;
    total += Number(d?.shkallore?.qty || d?.stairsQty) > 0 ? 1 : 0;
    
    if (total > 0) return `${total} COPË`;
    const pieces = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? 0) || 0;
    return pieces > 0 ? `${pieces} COPË` : "";
  }

  // 🔥 LEXUESI I SAKTË I MATJEVE (I PASTRUAR NGA BARAZIMI "=")
  function orderHandLines(o) {
    const d = getOrderData(o);
    const tepiha = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
    const staza = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);
    
    const stairsQty = Number(d?.shkallore?.qty || d?.stairsQty) || 0;
    const stairsPer = Number(d?.shkallore?.per || d?.stairsPer) || 0.3;

    const lines = [];

    // Tepiha
    if (tepiha.length > 0) {
      for (const r of tepiha) {
        const qty = Number(r.qty) || 0;
        const m2 = Number(r.m2) || 0;
        if (qty > 0 && m2 > 0) lines.push(`TEPIHA: ${qty} copë ${m2.toFixed(2)}m²`);
      }
    }

    // Staza
    if (staza.length > 0) {
      for (const r of staza) {
        const qty = Number(r.qty) || 0;
        const m2 = Number(r.m2) || 0;
        if (qty > 0 && m2 > 0) lines.push(`STAZA: ${qty} copë ${m2.toFixed(2)}m²`);
      }
    }

    // Shkallë
    if (stairsQty > 0) {
      lines.push(`SHKALLË: ${stairsQty} copë ${stairsPer}m²`);
    }

    return lines;
  }

  async function loadLiveData() {
    const [cRes, oRes] = await Promise.all([
      supabase.from("clients").select("*").order("code", { ascending: true }),
      supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(3000),
    ]);

    if (cRes.error) throw new Error(cRes.error.message);
    if (oRes.error) throw new Error(oRes.error.message);

    const clients = (cRes.data || []).map((c) => ({
      ...c,
      code: c.code,
      full_name: nameOfClient(c),
      phone: phoneOfClient(c),
    }));

    const orders = (oRes.data || []).map((o) => ({
      ...o,
      client_name: String(o?.client_full_name || o?.client_name || "").trim(),
      client_phone: String(o?.client_phone || o?.phone || "").trim(),
    }));

    setMeta({ mode: "LIVE" });
    setData({ clients, orders, live: true });
  }

  async function loadLatest(pinOverride) {
    setLoading(true);
    setError(""); 
    setNotice("");
    try {
      const qs = new URLSearchParams();
      const usePin = String(pinOverride ?? pin ?? "").trim();
      if (usePin) qs.set("pin", usePin);
      
      const r = await fetch(`/api/backup/latest?${qs.toString()}`, { cache: "no-store" });
      const j = await r.json();
      
      if (!r.ok || !j?.ok) throw new Error(j?.error || "FAILED");
      const item = j.item;
      
      if (!item || !item?.payload) {
        await loadLiveData();
        setMeta(null);
        return;
      }
      setMeta({ id: item.id, created_at: item.created_at, pin: item.pin });
      setData(item.payload);
    } catch (e) {
      await loadLiveData();
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      await fetch(`/api/backup/run?${qs.toString()}`, { method: "POST" });
      await loadLatest();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => { loadLatest(); }, []);
  
  useEffect(() => {
    if (pin && pin.length >= 6) loadLatest(pin);
  }, [pin]);


  const { activeClients, inactiveClients } = useMemo(() => {
    const allClients = Array.isArray(data?.clients) ? data.clients : [];
    const allOrders = Array.isArray(data?.orders) ? data.orders : [];
    const search = String(q || "").trim().toLowerCase();

    const doneStatuses = new Set(["dorezuar", "dorëzuar", "dorzim", "dorezim", "paguar", "anuluar", "arkiv", "arkivuar"]);

    const ordersByClient = new Map();
    allOrders.forEach((o) => {
      const ccode = normCode(o?.code ?? o?.client_code);
      if (!ccode) return;
      if (!ordersByClient.has(ccode)) ordersByClient.set(ccode, []);
      ordersByClient.get(ccode).push(o);
    });

    for (const [k, arr] of ordersByClient.entries()) {
      arr.sort((a, b) => {
        const ta = new Date(a?.created_at || 0).getTime();
        const tb = new Date(b?.created_at || 0).getTime();
        return tb - ta;
      });
      ordersByClient.set(k, arr);
    }

    const activeClientCodes = new Set();
    const activeOrderByCode = new Map();
    const lastOrderByCode = new Map();

    for (const [ccode, arr] of ordersByClient.entries()) {
      const last = arr[0];
      if (last) lastOrderByCode.set(ccode, last);

      const active = arr.find((o) => {
        const s = String(o?.status || "").toLowerCase();
        return !doneStatuses.has(s);
      });
      if (active) {
        activeClientCodes.add(ccode);
        activeOrderByCode.set(ccode, active);
      }
    }

    const active = [];
    const inactive = [];

    allClients.forEach(c => {
      const codeRaw = c?.code ?? "";
      const code = String(codeRaw ?? "").toLowerCase();
      const name = nameOfClient(c).toLowerCase();
      const phone = phoneOfClient(c).toLowerCase();
      
      const matches = !search || code.includes(search) || name.includes(search) || phone.includes(search);
      
      if (matches) {
        const ccode = normCode(codeRaw);
        if (ccode && activeClientCodes.has(ccode)) {
           const o = activeOrderByCode.get(ccode) || null;
           const last = lastOrderByCode.get(ccode) || null;
           active.push({ ...c, _activeOrder: o, _lastOrder: last });
        } else {
           const ccode = normCode(codeRaw);
           const last = ccode ? (lastOrderByCode.get(ccode) || null) : null;
           inactive.push({ ...c, _lastOrder: last });
        }
      }
    });

    return { activeClients: active, inactiveClients: inactive };
  }, [data, q]);


  return (
    <main style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto", backgroundColor: "#fff", color: "#000", minHeight: "100vh" }}>
      
      <div className="no-print">
        <div style={{ borderBottom: "2px solid #000", marginBottom: 20, paddingBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: "900", textTransform: "uppercase" }}>SISTEMI BACKUP</h1>
          <p style={{ margin: "5px 0", fontSize: "14px", color: "#666" }}>
            Data e gjenerimit: <b>{data?.generated_at ? fmtDate(data.generated_at) : "LIVE TANI"}</b>
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20, backgroundColor: "#f0f0f0", padding: 15, borderRadius: 8 }}>
           <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Kërko klientin..."
            style={{ padding: "10px", borderRadius: 5, border: "1px solid #ccc", flex: 1 }}
          />
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            style={{ padding: "10px", width: "80px", borderRadius: 5, border: "1px solid #ccc" }}
          />
          <button onClick={loadLatest} style={{ padding: "10px 15px", cursor: "pointer", fontWeight: "bold" }}>RIFRESKO</button>
          <button onClick={runNow} disabled={running} style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", cursor: "pointer", fontWeight: "bold", border: "none", borderRadius: 4 }}>
            {running ? "..." : "RUAJ TANI"}
          </button>
          <button
            onClick={doPdfDownload}
            style={{ padding: "10px 15px", backgroundColor: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: "bold", border: "none", borderRadius: 4 }}
          >
            📄 PDF / PRINT
          </button>
        </div>
        
        {loading && <div>Duke ngarkuar...</div>}
      </div>

      <div id="fletore-root">
      {activeClients.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h2 style={{ 
            fontSize: "22px", 
            borderBottom: "3px solid #000", 
            paddingBottom: "5px", 
            marginBottom: "15px",
            textTransform: "uppercase" 
          }}>
            📋 Klientat në Proces ({activeClients.length})
          </h2>
          
          <div style={{ 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", 
            gap: "0px", 
            borderTop: "2px solid #000",
            borderLeft: "2px solid #000" 
          }}>
            {activeClients.map((c, idx) => (
              <div key={idx} style={{ 
                borderRight: "2px solid #000",
                borderBottom: "2px solid #000",
                padding: "12px", 
                minHeight: "180px",
                pageBreakInside: "avoid",
                position: "relative"
              }}>
                <div style={{ position: "absolute", right: 8, top: 4, fontSize: "24px", fontWeight: "900", color: "#333" }}>
                  #{codeLabel(c)}
                </div>
                
                <div style={{ paddingRight: "50px", marginBottom: "8px" }}>
                  <div style={{ fontSize: "18px", fontWeight: "900", textTransform: "uppercase", lineHeight: "1.1" }}>
                    {nameOfClient(c)}
                  </div>
                </div>

                <div style={{ fontSize: "16px", fontFamily: "monospace", fontWeight: "600", marginBottom: "12px" }}>
                  {phoneOfClient(c)}
                </div>

                {(() => {
                  const o = c?._activeOrder;
                  const pay = payOfOrder(o);
                  const status = String(o?.status || "").toUpperCase() || "-";
                  const pieces = piecesSummaryFromOrder(o);
                  const lines = orderHandLines(o);
                  const total = Number(pay?.euro) || Number(o?.total) || 0;
                  const m2 = Number(pay?.m2) || 0;

                  return (
                    <>
                      <div
                        style={{
                          marginTop: "auto",
                          borderTop: "1px dashed #999",
                          paddingTop: "5px",
                          minHeight: "80px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "8px",
                            alignItems: "baseline",
                          }}
                        >
                          <span style={{ fontSize: "10px", color: "#666", textTransform: "uppercase" }}>POROSIA AKTIVE:</span>
                          <span style={{ fontSize: "11px", fontWeight: "800" }}>{status}{pieces ? ` • ${pieces}` : ""}</span>
                        </div>

                        {/* 🔥 KETU DALIN MATJET E PASTRUARA PA "=" */}
                        <div
                          style={{
                            fontFamily: "monospace",
                            fontSize: "13px",
                            lineHeight: "1.3",
                            marginTop: "6px",
                            whiteSpace: "pre-wrap",
                            fontWeight: "600",
                            color: "#333"
                          }}
                        >
                          {lines.length > 0 ? lines.join("\n") : "(PA MATJE AKOMA)"}
                        </div>
                      </div>

                      <div
                        style={{
                          marginTop: "8px",
                          fontWeight: "bold",
                          textAlign: "right",
                          fontSize: "18px",
                        }}
                      >
                        Total: {total ? total.toFixed(2) : "____"} €
                        {m2 ? (
                          <div style={{ fontSize: "12px", color: "#555", fontWeight: "700" }}>
                            M²: {m2.toFixed(2)}
                          </div>
                        ) : null}
                      </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </section>
      )}


      {inactiveClients.length > 0 && (
        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
            <h2 style={{ 
              fontSize: "18px", 
              borderBottom: "2px solid #000", 
              paddingBottom: "5px", 
              marginBottom: "10px",
              marginTop: "20px",
              color: "#444",
              textTransform: "uppercase",
              flex: 1
            }}>
              🗄️ Klientat e Tjerë / Të kryer ({inactiveClients.length})
            </h2>

            <button
              onClick={() => setShowCompleted(v => !v)}
              className="no-print"
              style={{
                padding: "8px 10px",
                fontSize: "12px",
                borderRadius: "8px",
                border: "1px solid rgba(0,0,0,0.35)",
                background: "transparent",
                color: "#000",
                textTransform: "uppercase",
                cursor: "pointer",
                whiteSpace: "nowrap"
              }}
            >
              {showCompleted ? "FSHIH LISTËN" : "HAP LISTËN"}
            </button>
          </div>

          {showCompleted && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #000", textAlign: "left" }}>
                <th style={{ padding: "5px", width: "80px" }}>KODI</th>
                <th style={{ padding: "5px" }}>EMRI MBIEMRI</th>
                <th style={{ padding: "5px" }}>TELEFONI</th>
                <th style={{ padding: "5px", textAlign: "right" }}>E FUNDIT</th>
              </tr>
            </thead>
            <tbody>
              {inactiveClients.map((c, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid #ccc" }}>
                  <td style={{ padding: "4px 5px", fontWeight: "bold" }}>{codeLabel(c)}</td>
                  <td style={{ padding: "4px 5px" }}>{nameOfClient(c)}</td>
                  <td style={{ padding: "4px 5px" }}>{phoneOfClient(c)}</td>
                  <td style={{ padding: "4px 5px", textAlign: "right", fontSize: "12px" }}>
                    {c?._lastOrder?.created_at ? fmtDate(c._lastOrder.created_at) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </section>
      )}

      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          .no-print { display: none !important; }
          body { background: white; -webkit-print-color-adjust: exact; }
          main { width: 100%; margin: 0; padding: 0; }
          h2 { page-break-after: avoid; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
    </main>
  );
}
