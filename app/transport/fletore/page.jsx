"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { downloadPdf } from "@/lib/downloadPdf";
import { getActor } from "@/lib/actorSession";
import { getTransportSession } from "@/lib/transportAuth";
import { canAccessTransportAdmin } from "@/lib/roles";

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
  const rate = Number(pay?.price ?? pay?.rate ?? d?.price ?? 0) || 0;
  const m2 = Number(pay?.m2 ?? 0) || 0;
  const v = rate * m2;
  return Number.isFinite(v) ? Number(v.toFixed(2)) : 0;
}

function buildClientBuckets(clients, orders, q, showCompleted) {
  const allClients = Array.isArray(clients) ? clients : [];
  const allOrders = Array.isArray(orders) ? orders : [];
  const search = String(q || "").trim().toLowerCase();
  const doneStatuses = new Set(["dorezuar", "dorëzuar", "dorzim", "dorezim", "paguar", "anuluar", "arkiv", "arkivuar", "done", "completed"]);

  const ordersByCode = new Map();
  allOrders.forEach((o) => {
    const code = String(o?.code_str || o?.code || "").trim();
    if (!code) return;
    if (!ordersByCode.has(code)) ordersByCode.set(code, []);
    ordersByCode.get(code).push(o);
  });

  for (const [k, arr] of ordersByCode.entries()) {
    arr.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    ordersByCode.set(k, arr);
  }

  const activeCodes = new Set();
  const activeOrderByCode = new Map();
  const lastOrderByCode = new Map();

  for (const [code, arr] of ordersByCode.entries()) {
    const last = arr[0];
    if (last) lastOrderByCode.set(code, last);
    const active = arr.find((o) => !doneStatuses.has(String(o?.status || "").toLowerCase()));
    if (active) {
      activeCodes.add(code);
      activeOrderByCode.set(code, active);
    }
  }

  const active = [];
  const inactive = [];

  allClients.forEach((c) => {
    const codeRaw = String(c?.code || "").trim();
    const hay = `${nameOfClient(c)} ${phoneOfClient(c)} ${codeRaw}`.toLowerCase();
    if (search && !hay.includes(search)) return;

    if (codeRaw && activeCodes.has(codeRaw)) {
      const o = activeOrderByCode.get(codeRaw) || null;
      const last = lastOrderByCode.get(codeRaw) || null;
      active.push({ ...c, _activeOrder: o, _lastOrder: last });
    } else {
      const last = codeRaw ? (lastOrderByCode.get(codeRaw) || null) : null;
      inactive.push({ ...c, _lastOrder: last });
    }
  });

  const inactiveFiltered = showCompleted ? inactive : inactive.filter((c) => {
    const o = c?._lastOrder;
    if (!o) return false;
    const s = String(o?.status || "").toLowerCase();
    return !doneStatuses.has(s);
  });

  return { activeClients: active, inactiveClients: inactiveFiltered };
}

function TransportSection({ group, q, showCompleted }) {
  const { activeClients, inactiveClients } = useMemo(
    () => buildClientBuckets(group?.clients, group?.orders, q, showCompleted),
    [group, q, showCompleted]
  );

  return (
    <section style={{ marginBottom: "48px" }}>
      <div style={{ borderBottom: "2px solid #000", marginBottom: 18, paddingBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: "22px", fontWeight: 900, textTransform: "uppercase" }}>{String(group?.name || "TRANSPORT").toUpperCase()}</h2>
        <div style={{ marginTop: 4, fontSize: 13, color: "#444" }}>
          ID: <b>{group?.id || "-"}</b> • Porosi: <b>{Array.isArray(group?.orders) ? group.orders.length : 0}</b> • Klientë: <b>{Array.isArray(group?.clients) ? group.clients.length : 0}</b>
        </div>
      </div>

      {activeClients.length > 0 && (
        <section style={{ marginBottom: "34px" }}>
          <h3 style={{ fontSize: "20px", borderBottom: "3px solid #000", paddingBottom: 5, marginBottom: 15, textTransform: "uppercase" }}>📋 KLIENTAT NË PROCES ({activeClients.length})</h3>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0px", borderTop: "2px solid #000", borderLeft: "2px solid #000" }}>
            {activeClients.map((c, idx) => (
              <div key={`${group?.id || 'g'}-a-${idx}`} style={{ borderRight: "2px solid #000", borderBottom: "2px solid #000", padding: "12px", minHeight: "180px", pageBreakInside: "avoid", position: "relative" }}>
                <div style={{ position: "absolute", right: 8, top: 4, fontSize: "24px", fontWeight: "900", color: "#333" }}>{String(c.code || "").toUpperCase()}</div>

                <div style={{ paddingRight: "90px", marginBottom: "8px" }}>
                  <div style={{ fontSize: "18px", fontWeight: "900", textTransform: "uppercase", lineHeight: "1.1" }}>{nameOfClient(c)}</div>
                </div>

                <div style={{ fontSize: "16px", fontFamily: "monospace", fontWeight: "600", marginBottom: "12px" }}>{phoneOfClient(c)}</div>

                {(() => {
                  const o = c?._activeOrder;
                  const pay = payOfOrder(o);
                  const status = String(o?.status || "").toUpperCase() || "-";
                  const pieces = piecesSummaryFromOrder(o);
                  const lines = orderHandLines(o);
                  const total = totalEurFromOrder(o);
                  const m2 = Number(pay?.m2) || 0;

                  return (
                    <div style={{ marginTop: "auto", borderTop: "1px dashed #999", paddingTop: "5px", minHeight: "80px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "baseline" }}>
                        <span style={{ fontSize: "10px", color: "#666", textTransform: "uppercase" }}>POROSIA AKTIVE:</span>
                        <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase" }}>{status} {pieces ? `• ${pieces}` : ""}</span>
                      </div>

                      <div style={{ display: "flex", gap: "12px", marginTop: "6px" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: "monospace", fontSize: "14px", lineHeight: "1.4" }}>
                            {lines.lines.length > 0 ? lines.lines.map((v, i) => <div key={i}>{v}</div>) : <div style={{ color: "#999" }}>—</div>}
                          </div>

                          {lines.extra.length > 0 && (
                            <div style={{ marginTop: "6px", fontSize: "11px", color: "#333" }}>
                              {lines.extra.map((t, i) => <div key={i}>{t}</div>)}
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
                  );
                })()}
              </div>
            ))}
          </div>
        </section>
      )}

      {inactiveClients.length > 0 && (
        <section style={{ marginBottom: "34px" }}>
          <h3 style={{ fontSize: "20px", borderBottom: "3px solid #000", paddingBottom: 5, marginBottom: 15, textTransform: "uppercase" }}>🗄️ KLIENTAT E TJERË / TË KRYER ({inactiveClients.length})</h3>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0px", borderTop: "2px solid #000", borderLeft: "2px solid #000" }}>
            {inactiveClients.map((c, idx) => {
              const o = c?._lastOrder;
              const pay = payOfOrder(o);
              const status = String(o?.status || "").toUpperCase() || "-";
              const pieces = piecesSummaryFromOrder(o);
              const total = totalEurFromOrder(o);
              const m2 = Number(pay?.m2) || 0;

              return (
                <div key={`${group?.id || 'g'}-i-${idx}`} style={{ borderRight: "2px solid #000", borderBottom: "2px solid #000", padding: "12px", minHeight: "150px", pageBreakInside: "avoid", position: "relative", backgroundColor: "#fafafa" }}>
                  <div style={{ position: "absolute", right: 8, top: 4, fontSize: "22px", fontWeight: "900", color: "#555" }}>{String(c.code || "").toUpperCase()}</div>

                  <div style={{ paddingRight: "90px", marginBottom: "8px" }}>
                    <div style={{ fontSize: "16px", fontWeight: "900", textTransform: "uppercase", lineHeight: "1.1" }}>{nameOfClient(c)}</div>
                  </div>

                  <div style={{ fontSize: "15px", fontFamily: "monospace", marginBottom: "10px" }}>{phoneOfClient(c)}</div>

                  <div style={{ marginTop: "auto", borderTop: "1px dashed #bbb", paddingTop: "6px" }}>
                    <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase" }}>POROSIA E FUNDIT</div>
                    <div style={{ fontWeight: "800", marginTop: 4 }}>{status} {pieces ? `• ${pieces}` : ""}</div>
                    <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 12, color: "#666", textTransform: "uppercase" }}>M²</div>
                        <div style={{ fontSize: 17, fontWeight: 900 }}>{m2 ? m2 : "—"}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 12, color: "#666", textTransform: "uppercase" }}>€</div>
                        <div style={{ fontSize: 17, fontWeight: 900 }}>{total ? total : "—"}</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}

export default function TransportFletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [data, setData] = useState({ generated_at: null, transports: [] });
  const [q, setQ] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  const actor = useMemo(() => {
    try { return getActor(); } catch { return null; }
  }, []);

  const session = useMemo(() => {
    try { return getTransportSession(); } catch { return null; }
  }, [actor?.pin, actor?.role]);

  const actorRole = String(actor?.role || "").toUpperCase();
  const transportId = String(session?.transport_id || "").trim();
  const allowAll = canAccessTransportAdmin(actorRole);

  async function load() {
    setError("");
    setNotice("");
    setLoading(true);

    try {
      const qs = new URLSearchParams();
      if (allowAll) qs.set("all", "1");
      else if (transportId) qs.set("transport_id", transportId);

      const res = await fetch(`/api/transport/fletore?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.detail || json?.error || "TRANSPORT_FLETORE_LOAD_FAILED");

      setData({
        generated_at: json?.generated_at || new Date().toISOString(),
        transports: Array.isArray(json?.transports) ? json.transports : [],
      });

      if (json?.clients_warning) {
        setNotice("KUJDES: transport_clients nuk u lexua plotësisht. Fletorja po përdor transport_orders si burim kryesor live.");
      }
    } catch (e) {
      setError(String(e?.message || e));
      setData({ generated_at: null, transports: [] });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [transportId, allowAll]);

  const visibleGroups = useMemo(() => {
    const groups = Array.isArray(data?.transports) ? data.transports : [];
    if (!q.trim()) return groups;
    const search = q.trim().toLowerCase();
    return groups
      .map((group) => {
        const filteredClients = (group?.clients || []).filter((c) => `${nameOfClient(c)} ${phoneOfClient(c)} ${String(c?.code || "")}`.toLowerCase().includes(search));
        const allowedCodes = new Set(filteredClients.map((c) => String(c?.code || "").trim()));
        const filteredOrders = (group?.orders || []).filter((o) => {
          const code = String(o?.code || o?.code_str || "").trim();
          const hay = `${String(o?.client_name || "")} ${String(o?.client_phone || "")} ${code} ${String(o?.status || "")} ${String(group?.name || "")}`.toLowerCase();
          return hay.includes(search) || (code && allowedCodes.has(code));
        });
        if (!filteredClients.length && !filteredOrders.length && !String(group?.name || "").toLowerCase().includes(search)) return null;
        return {
          ...group,
          clients: filteredClients.length ? filteredClients : group?.clients || [],
          orders: filteredOrders.length ? filteredOrders : group?.orders || [],
        };
      })
      .filter(Boolean);
  }, [data?.transports, q]);

  return (
    <main style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto", backgroundColor: "#fff", color: "#000", minHeight: "100vh" }}>
      <div className="no-print">
        <div style={{ borderBottom: "2px solid #000", marginBottom: 20, paddingBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: "900", textTransform: "uppercase" }}>SISTEMI BACKUP — TRANSPORT</h1>
          <p style={{ margin: "5px 0", fontSize: "14px", color: "#666" }}>
            Live nga databaza • Gjeneruar: <b>{data?.generated_at ? fmtDate(data.generated_at) : "—"}</b> • Transportues: <b>{visibleGroups.length}</b>
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20, backgroundColor: "#f0f0f0", padding: 15, borderRadius: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Kërko: EMËR / TEL / KOD / STATUS / TRANSPORT" style={{ padding: "10px", borderRadius: 5, border: "1px solid #ccc", flex: 1 }} />
          <button onClick={load} style={{ padding: "10px 15px", cursor: "pointer", fontWeight: "bold" }}>REFRESH</button>
          <button onClick={() => downloadPdf("fletore-root", `fletore-transport-${new Date().toISOString().slice(0, 10)}.pdf`)} style={{ padding: "10px 15px", backgroundColor: "#444", color: "#fff", cursor: "pointer" }}>📄 PDF</button>
          <Link href="/transport/menu" style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", textDecoration: "none", fontWeight: "bold" }}>MENU TRANSPORT</Link>
          <Link href="/transport" style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", textDecoration: "none", fontWeight: "bold" }}>TRANSPORT HOME</Link>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          <b>SHFAQ EDHE TË DORËZUARA</b>
        </label>

        {notice ? <div style={{ marginBottom: 10, color: "#333" }}>{notice}</div> : null}
        {loading && <div>Duke ngarkuar...</div>}
        {error && <div style={{ color: "crimson", fontWeight: "bold" }}>{error}</div>}
      </div>

      <div id="fletore-root">
        {visibleGroups.map((group) => (
          <TransportSection key={String(group?.id || group?.name || Math.random())} group={group} q={q} showCompleted={showCompleted} />
        ))}

        {!loading && visibleGroups.length === 0 && (
          <div style={{ padding: "24px", border: "2px dashed #999", textAlign: "center", fontWeight: 700 }}>
            NUK KA TË DHËNA LIVE PËR TË SHFAQUR.
          </div>
        )}
      </div>
    </main>
  );
}
