"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { downloadPdf } from "@/lib/downloadPdf";
import { getActor } from "@/lib/actorSession";
import { getTransportSession } from "@/lib/transportAuth";

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("sq-AL", { day: "2-digit", month: "2-digit" });
  } catch {
    return String(d);
  }
}

function jparse(v, fallback) {
  try {
    if (v && typeof v === "object") return v;
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

function getOrderData(o) {
  return jparse(o?.data, {}) || {};
}

function normPhone(v) {
  return String(v || "").replace(/\D+/g, "");
}

// --- UI helpers (same vibe as baza) ---
function nameOfClient(c) {
  const full = String(c?.full_name || c?.name || c?.client_name || "").trim();
  if (full) return full;
  const fn = String(c?.first_name || "").trim();
  const ln = String(c?.last_name || "").trim();
  return `${fn} ${ln}`.trim() || "-";
}

function phoneOfClient(c) {
  return String(c?.phone || c?.client_phone || "").trim() || "-";
}

function payOfOrder(o) {
  const d = getOrderData(o);
  return d?.pay && typeof d.pay === "object" ? d.pay : {};
}

function piecesSummaryFromOrder(o) {
  const d = getOrderData(o);
  const pieces = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? 0) || 0;
  if (pieces > 0) return `${pieces} COPË`;

  const t = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
  const s = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);
  const sumQty = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.qty) || 0), 0);

  // shkallore te transporti ruhet si objekt (qty, per)
  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const total = sumQty(t) + sumQty(s) + (stairsQty > 0 ? stairsQty : 0);
  return total > 0 ? `${total} COPË` : "";
}

function expandM2Lines(rows, maxLines = 12) {
  const out = [];
  for (const r of rows || []) {
    const m2 = Number(r?.m2) || 0;
    const qty = Number(r?.qty) || 0;
    if (m2 <= 0 || qty <= 0) continue;
    for (let i = 0; i < qty; i++) {
      out.push(m2);
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) break;
  }
  return out;
}

function orderHandLines(o) {
  const d = getOrderData(o);
  const tepiha = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
  const staza = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);

  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const stairsPer = Number(d?.shkallore?.per ?? d?.stairsPer ?? 0.3) || 0.3;

  const lines = [];
  for (const v of expandM2Lines(tepiha, 12)) lines.push(String(v.toFixed(1)));
  for (const v of expandM2Lines(staza, 12 - lines.length)) lines.push(String(v.toFixed(1)));

  const extra = [];
  if (stairsQty > 0) {
    const total = Number((stairsQty * stairsPer).toFixed(2));
    extra.push(`SHKALLË: ${stairsQty} x ${stairsPer} = ${total}m²`);
  }
  return { lines, extra };
}

function totalEurFromOrder(o) {
  const pay = payOfOrder(o);
  const euro = Number(pay?.euro ?? pay?.total ?? NaN);
  if (Number.isFinite(euro)) return Number(euro.toFixed(2));

  const d = getOrderData(o);
  // fallback: rate * m2
  const rate = Number(pay?.price ?? pay?.rate ?? d?.price ?? 0) || 0;
  const m2 = Number(pay?.m2 ?? 0) || 0;
  const v = rate * m2;
  return Number.isFinite(v) ? Number(v.toFixed(2)) : 0;
}

export default function TransportFletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  const actor = useMemo(() => {
    try { return getActor(); } catch { return null; }
  }, []);

  const session = useMemo(() => {
    try { return getTransportSession(); } catch { return null; }
  }, [actor?.pin, actor?.role]);

  const transportId = String(session?.transport_id || "").trim();
  const transportName = String(session?.transport_name || session?.name || actor?.name || "TRANSPORT").trim();

  const ok = useMemo(() => {
    const role = String(actor?.role || "").toUpperCase();
    return role === "TRANSPORT" || role === "OWNER" || role === "ADMIN" || role === "DISPATCH";
  }, [actor?.role]);

  async function load() {
    setError("");
    setNotice("");
    setLoading(true);

    if (!ok) {
      setLoading(false);
      setError("NUK JE I KYÇUR — Shko te LOGIN dhe hyn me PIN.");
      return;
    }
    if (!transportId) {
      setLoading(false);
      setError("TRANSPORT SESSION MUNGON — Hape /TRANSPORT edhe provo prapë.");
      return;
    }

    try {
      const ordersQ = supabase
        .from("transport_orders")
        .select("id,created_at,updated_at,code_str,client_name,client_phone,status,data,transport_id")
        .eq("transport_id", transportId)
        .order("created_at", { ascending: false })
        .limit(5000);

      // Optional clients (nese s'ekziston tabela, vazhdon me orders)
      const clientsQ = supabase
        .from("transport_clients")
        .select("id,full_name,phone,created_at,updated_at")
        .order("created_at", { ascending: true })
        .limit(5000);

      const [ordersRes, clientsRes] = await Promise.all([ordersQ, clientsQ]);
      if (ordersRes?.error) throw ordersRes.error;

      const orders = (ordersRes?.data || []).map((o) => {
        const d = getOrderData(o);
        const c = d?.client && typeof d.client === "object" ? d.client : {};
        return {
          ...o,
          // unify a bit (si baza)
          code: o?.code_str || c?.code || "",
          client_name: String(o?.client_name || c?.name || "").trim(),
          client_phone: String(o?.client_phone || c?.phone || "").trim(),
        };
      });

      // Build clients list (prefer transport_clients, else derive from orders)
      const clients = [];
      const seen = new Set();

      const addClient = (code, full_name, phone) => {
        const k = `${String(code || "").trim()}|${normPhone(phone)}`;
        if (!String(code || "").trim() && !normPhone(phone)) return;
        if (seen.has(k)) return;
        seen.add(k);
        clients.push({ code: String(code || "").trim(), full_name: String(full_name || "-").trim(), phone: String(phone || "-").trim() });
      };

      const clientsOk = clientsRes && !clientsRes.error ? (clientsRes.data || []) : null;

      if (clientsOk && clientsOk.length) {
        // transport_clients doesn't have code in your schema - so we still derive code from orders for grouping,
        // but we use the table mainly for name/phone canonicalization.
        const byPhone = new Map();
        for (const c of clientsOk) {
          const p = normPhone(c?.phone);
          if (!p) continue;
          byPhone.set(p, c);
        }
        for (const o of orders) {
          const d = getOrderData(o);
          const c = d?.client && typeof d.client === "object" ? d.client : {};
          const code = String(o?.code_str || c?.code || "").trim();
          const phone = String(o?.client_phone || c?.phone || "").trim();
          const p = normPhone(phone);
          const cc = byPhone.get(p);
          addClient(code, cc?.full_name || o?.client_name || c?.name, phone);
        }
      } else {
        for (const o of orders) {
          const d = getOrderData(o);
          const c = d?.client && typeof d.client === "object" ? d.client : {};
          addClient(String(o?.code_str || c?.code || "").trim(), o?.client_name || c?.name, o?.client_phone || c?.phone);
        }
        setNotice("KUJDES: transport_clients nuk u lexua (po përdor vetëm orders).");
      }

      setData({
        generated_at: new Date().toISOString(),
        transport: { id: transportId, name: transportName },
        clients,
        orders,
      });
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [transportId, ok]);

  // --- LOGJIKA KRYESORE (si baza): AKTIV vs JO-AKTIV ---
  const { activeClients, inactiveClients } = useMemo(() => {
    const allClients = Array.isArray(data?.clients) ? data.clients : [];
    const allOrders = Array.isArray(data?.orders) ? data.orders : [];
    const search = String(q || "").trim().toLowerCase();

    const doneStatuses = new Set(["dorezuar","dorëzuar","dorzim","dorezim","paguar","anuluar","arkiv","arkivuar","done","completed"]);

    // Map orders by client code (Txx)
    const ordersByCode = new Map();
    allOrders.forEach((o) => {
      const code = String(o?.code_str || o?.code || "").trim();
      if (!code) return;
      if (!ordersByCode.has(code)) ordersByCode.set(code, []);
      ordersByCode.get(code).push(o);
    });

    for (const [k, arr] of ordersByCode.entries()) {
      arr.sort((a, b) => {
        const ta = new Date(a?.created_at || 0).getTime();
        const tb = new Date(b?.created_at || 0).getTime();
        return tb - ta;
      });
      ordersByCode.set(k, arr);
    }

    const activeCodes = new Set();
    const activeOrderByCode = new Map();
    const lastOrderByCode = new Map();

    for (const [code, arr] of ordersByCode.entries()) {
      const last = arr[0];
      if (last) lastOrderByCode.set(code, last);

      const active = arr.find((o) => {
        const s = String(o?.status || "").toLowerCase();
        return !doneStatuses.has(s);
      });
      if (active) {
        activeCodes.add(code);
        activeOrderByCode.set(code, active);
      }
    }

    const active = [];
    const inactive = [];

    allClients.forEach((c) => {
      const codeRaw = c?.code ?? "";
      const code = String(codeRaw ?? "").toLowerCase();
      const name = nameOfClient(c).toLowerCase();
      const phone = phoneOfClient(c).toLowerCase();

      const matches = !search || code.includes(search) || name.includes(search) || phone.includes(search);
      if (!matches) return;

      if (codeRaw && activeCodes.has(String(codeRaw))) {
        const o = activeOrderByCode.get(String(codeRaw)) || null;
        const last = lastOrderByCode.get(String(codeRaw)) || null;
        active.push({ ...c, _activeOrder: o, _lastOrder: last });
      } else {
        const last = codeRaw ? (lastOrderByCode.get(String(codeRaw)) || null) : null;
        inactive.push({ ...c, _lastOrder: last });
      }
    });

    // Hide completed if unchecked
    const inactiveFiltered = showCompleted ? inactive : inactive.filter((c) => {
      const o = c?._lastOrder;
      if (!o) return false;
      const s = String(o?.status || "").toLowerCase();
      return !doneStatuses.has(s) ? true : false; // if last is done, hide unless showCompleted
    });

    return { activeClients: active, inactiveClients: inactiveFiltered };
  }, [data, q, showCompleted]);

  return (
    <main style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto", backgroundColor: "#fff", color: "#000", minHeight: "100vh" }}>

      {/* HEADER & CONTROLS (Nuk printohen) */}
      <div className="no-print">
        <div style={{ borderBottom: "2px solid #000", marginBottom: 20, paddingBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: "900", textTransform: "uppercase" }}>
            SISTEMI BACKUP — TRANSPORT
          </h1>
          <p style={{ margin: "5px 0", fontSize: "14px", color: "#666" }}>
            Transport: <b>{transportName}</b> • ID: <b>{transportId || "-"}</b> • Data e gjenerimit: <b>{data?.generated_at ? fmtDate(data.generated_at) : "—"}</b>
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20, backgroundColor: "#f0f0f0", padding: 15, borderRadius: 8 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Kërko: EMËR / TEL / KOD"
            style={{ padding: "10px", borderRadius: 5, border: "1px solid #ccc", flex: 1 }}
          />

          <button onClick={load} style={{ padding: "10px 15px", cursor: "pointer", fontWeight: "bold" }}>
            REFRESH
          </button>

          <button
            onClick={() => downloadPdf("fletore-root", `fletore-transport-${transportId || ""}-${new Date().toISOString().slice(0, 10)}.pdf`)}
            style={{ padding: "10px 15px", backgroundColor: "#444", color: "#fff", cursor: "pointer" }}
          >
            📄 PDF
          </button>

          <Link href="/transport/menu" style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", textDecoration: "none", fontWeight: "bold" }}>
            MENU TRANSPORT
          </Link>

          <Link href="/transport" style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", textDecoration: "none", fontWeight: "bold" }}>
            TRANSPORT HOME
          </Link>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          <b>SHFAQ EDHE TË DORËZUARA</b>
        </label>

        {notice ? <div style={{ marginBottom: 10, color: "#333" }}>{notice}</div> : null}
        {loading && <div>Duke ngarkuar...</div>}
        {error && <div style={{ color: "crimson", fontWeight: "bold" }}>{error}</div>}
      </div>

      {/* PDF ROOT (vetëm kjo pjesë shkarkohet si PDF) */}
      <div id="fletore-root">

      {/* --- PJESA 1: KLIENTAT AKTIV - FORMA E FLETORES --- */}
      {activeClients.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h2 style={{
            fontSize: "22px",
            borderBottom: "3px solid #000",
            paddingBottom: "5px",
            marginBottom: "15px",
            textTransform: "uppercase"
          }}>
            📋 KLIENTAT NË PROCES ({activeClients.length})
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
                  {String(c.code || "").toUpperCase()}
                </div>

                <div style={{ paddingRight: "90px", marginBottom: "8px" }}>
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
                  const total = totalEurFromOrder(o);
                  const m2 = Number(pay?.m2) || 0;

                  return (
                    <>
                      <div style={{ marginTop: "auto", borderTop: "1px dashed #999", paddingTop: "5px", minHeight: "80px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "baseline" }}>
                          <span style={{ fontSize: "10px", color: "#666", textTransform: "uppercase" }}>
                            POROSIA AKTIVE:
                          </span>
                          <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase" }}>
                            {status} {pieces ? `• ${pieces}` : ""}
                          </span>
                        </div>

                        <div style={{ display: "flex", gap: "12px", marginTop: "6px" }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: "monospace", fontSize: "14px", lineHeight: "1.4" }}>
                              {lines.lines.length > 0 ? (
                                lines.lines.map((v, i) => (
                                  <div key={i}>{v}</div>
                                ))
                              ) : (
                                <div style={{ color: "#999" }}>—</div>
                              )}
                            </div>

                            {lines.extra.length > 0 && (
                              <div style={{ marginTop: "6px", fontSize: "11px", color: "#333" }}>
                                {lines.extra.map((t, i) => (
                                  <div key={i}>{t}</div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div style={{ width: "120px", textAlign: "right" }}>
                            <div style={{ fontSize: "12px", color: "#666", textTransform: "uppercase" }}>M²</div>
                            <div style={{ fontSize: "18px", fontWeight: "900" }}>{m2 ? m2 : "—"}</div>
                            <div style={{ marginTop: "6px", fontSize: "12px", color: "#666", textTransform: "uppercase" }}>€</div>
                            <div style={{ fontSize: "18px", fontWeight: "900" }}>{total ? total : "—"}</div>
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* --- PJESA 2: KLIENTAT TJERË / TË KRYER --- */}
      {inactiveClients.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h2 style={{
            fontSize: "22px",
            borderBottom: "3px solid #000",
            paddingBottom: "5px",
            marginBottom: "15px",
            textTransform: "uppercase"
          }}>
            🗄️ KLIENTAT E TJERË / TË KRYER ({inactiveClients.length})
          </h2>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: "0px",
            borderTop: "2px solid #000",
            borderLeft: "2px solid #000"
          }}>
            {inactiveClients.map((c, idx) => {
              const o = c?._lastOrder;
              const pay = payOfOrder(o);
              const status = String(o?.status || "").toUpperCase() || "-";
              const pieces = piecesSummaryFromOrder(o);
              const total = totalEurFromOrder(o);
              const m2 = Number(pay?.m2) || 0;

              return (
                <div key={idx} style={{
                  borderRight: "2px solid #000",
                  borderBottom: "2px solid #000",
                  padding: "12px",
                  minHeight: "150px",
                  pageBreakInside: "avoid",
                  position: "relative",
                  backgroundColor: "#fafafa"
                }}>
                  <div style={{ position: "absolute", right: 8, top: 4, fontSize: "22px", fontWeight: "900", color: "#555" }}>
                    {String(c.code || "").toUpperCase()}
                  </div>

                  <div style={{ paddingRight: "90px", marginBottom: "8px" }}>
                    <div style={{ fontSize: "16px", fontWeight: "900", textTransform: "uppercase", lineHeight: "1.1" }}>
                      {nameOfClient(c)}
                    </div>
                  </div>

                  <div style={{ fontSize: "14px", fontFamily: "monospace", fontWeight: "600", marginBottom: "10px" }}>
                    {phoneOfClient(c)}
                  </div>

                  <div style={{ borderTop: "1px dashed #bbb", paddingTop: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#666", textTransform: "uppercase" }}>
                      <span>STATUS</span>
                      <span style={{ fontWeight: "800", color: "#111" }}>{status}</span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                      <div style={{ fontSize: "12px", color: "#333" }}>
                        {pieces ? pieces : "—"}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "12px", color: "#666" }}>M²: <b>{m2 || "—"}</b></div>
                        <div style={{ fontSize: "12px", color: "#666" }}>€: <b>{total || "—"}</b></div>
                      </div>
                    </div>

                    <div style={{ marginTop: 8, fontSize: "11px", color: "#444" }}>
                      {o?.created_at ? `DATA: ${fmtDate(o.created_at)}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      </div>

      {/* Print CSS minimal (si baza) */}
      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
        }
      `}</style>
    </main>
  );
}
