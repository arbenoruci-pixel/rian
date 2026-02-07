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

export default function FletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [pin, setPin] = useState("");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);

  // --- PDF (DOWNLOAD, JO PRINT) ---
  function pdfEscape(s) {
    return String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  // Minimal text-only PDF generator (pa libra extra). Qëllimi: "DOWNLOAD" direkt në iPhone,
  // jo me të çu te Print dialog.
  function buildSimplePdfBytes(pages) {
    // pages: Array<Array<string>> (each page is array of lines)
    const objects = [];
    const offsets = [0];
    const pushObj = (s) => {
      objects.push(s);
    };

    // 1) Catalog
    pushObj("<< /Type /Catalog /Pages 2 0 R >>");

    // 2) Pages container (kids filled later)
    // placeholder, we'll replace after kids are known
    pushObj("__PAGES__");

    // Font object
    const fontObjNum = 3;
    pushObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    // For each page: content stream + page object
    const pageObjs = [];
    const contentObjs = [];
    const firstContentObjNum = 4;
    let objNum = firstContentObjNum;

    const makeStream = (lines) => {
      // A4: 595 x 842 pts. Margins.
      const left = 40;
      let y = 800;
      const lineH = 14;
      const fontSize = 11;
      let content = "BT\n";
      content += `/F1 ${fontSize} Tf\n`;
      content += `${left} ${y} Td\n`;
      for (const raw of lines) {
        const t = pdfEscape(raw);
        content += `(${t}) Tj\n`;
        content += `0 -${lineH} Td\n`;
      }
      content += "ET\n";
      return content;
    };

    for (const lines of pages) {
      const stream = makeStream(lines);
      const bytesLen = new TextEncoder().encode(stream).length;
      const contentObj = `<< /Length ${bytesLen} >>\nstream\n${stream}endstream`;
      contentObjs.push({ num: objNum, body: contentObj });
      objNum += 1;

      const pageObjNum = objNum;
      const pageObj = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjs[contentObjs.length - 1].num} 0 R >>`;
      pageObjs.push({ num: pageObjNum, body: pageObj });
      objNum += 1;
    }

    // Insert content + page objects
    for (const c of contentObjs) pushObj(c.body);
    for (const p of pageObjs) pushObj(p.body);

    // Now replace Pages object (#2)
    const kids = pageObjs.map((p) => `${p.num} 0 R`).join(" ");
    objects[1] = `<< /Type /Pages /Count ${pageObjs.length} /Kids [ ${kids} ] >>`;

    // Build xref
    let out = "%PDF-1.4\n";
    for (let i = 0; i < objects.length; i++) {
      offsets.push(new TextEncoder().encode(out).length);
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefStart = new TextEncoder().encode(out).length;
    out += `xref\n0 ${objects.length + 1}\n`;
    out += `0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      const off = offsets[i] || 0;
      out += `${String(off).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return new TextEncoder().encode(out);
  }

  function buildBackupPdfLines() {
    const lines = [];
    const gen = data?.generated_at ? fmtDate(data.generated_at) : "LIVE TANI";
    lines.push("SISTEMI BACKUP");
    lines.push(`DATA E GJENERIMIT: ${gen}`);
    lines.push(" ");

    const act = Array.isArray(activeClients) ? activeClients : [];
    const ina = Array.isArray(inactiveClients) ? inactiveClients : [];

    lines.push(`KLIENTAT NE PROCES (${act.length})`);
    lines.push("----------------------------------------");
    for (const c of act) {
      const o = c?._activeOrder || c?._lastOrder || null;
      const st = String(o?.status || "").toUpperCase();
      const pieces = piecesSummaryFromOrder(o);
      const hand = orderHandLines(o);
      const pay = payOfOrder(o);

      const m2FromPay = Number(pay?.m2);
      const m2FromLines = (hand?.lines || []).reduce((s, v) => s + (Number(String(v).replace(",", ".")) || 0), 0);
      const m2 = Number.isFinite(m2FromPay) && m2FromPay > 0 ? m2FromPay : (m2FromLines > 0 ? Number(m2FromLines.toFixed(2)) : 0);
      const total = Number(pay?.total);

      lines.push(`#${c.code}  ${nameOfClient(c)}`);
      lines.push(`TEL: ${phoneOfClient(c)}   STATUS: ${st || "-"}   ${pieces || ""}`.trim());
      if (hand?.lines?.length) {
        lines.push("COPET / MATJET:");
        for (const v of hand.lines) lines.push(`  - ${v} m2`);
      } else {
        lines.push("(PA MATJE AKOMA)");
      }
      if (hand?.extra?.length) {
        for (const ex of hand.extra) lines.push(`  ${ex}`);
      }
      if (m2 > 0) lines.push(`M2 TOTAL: ${m2}`);
      if (Number.isFinite(total)) lines.push(`TOTAL: ${total.toFixed(2)} EUR`);
      lines.push(" ");
    }

    lines.push(" ");
    lines.push(`KLIENTAT E TJERE / TE KRYER (${ina.length})`);
    lines.push("----------------------------------------");
    for (const c of ina) {
      const o = c?._lastOrder || null;
      const st = String(o?.status || "").toUpperCase();
      const pay = payOfOrder(o);
      const total = Number(pay?.total);
      lines.push(`#${c.code}  ${nameOfClient(c)}  TEL: ${phoneOfClient(c)}  ${st || "-"}`);
      if (Number.isFinite(total)) lines.push(`  TOTAL: ${total.toFixed(2)} EUR`);
    }

    return lines;
  }

  function splitLinesToPages(lines, maxPerPage = 52) {
    const pages = [];
    let buf = [];
    for (const ln of lines) {
      buf.push(ln);
      if (buf.length >= maxPerPage) {
        pages.push(buf);
        buf = [];
      }
    }
    if (buf.length) pages.push(buf);
    return pages.length ? pages : [["SISTEMI BACKUP"]];
  }

  async function downloadPdf() {
    try {
      const lines = buildBackupPdfLines();
      const pages = splitLinesToPages(lines);
      const pdfBytes = buildSimplePdfBytes(pages);
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      a.href = url;
      a.download = `TEPIHA_BACKUP_${y}${m}${da}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      alert("S'MUN U KRIJU PDF. PROVO PRAP.");
      console.error(e);
    }
  }

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
    // Prefer explicit counts if present
    const pieces = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? 0) || 0;
    if (pieces > 0) return `${pieces} COPË`;

    // Fallback: sum row quantities
    const t = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
    const s = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);
    const sumQty = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.qty) || 0), 0);
    const total = sumQty(t) + sumQty(s) + (Number(d?.stairsQty) || 0);
    return total > 0 ? `${total} COPË` : "";
  }

  function expandM2Lines(rows, maxLines = 10) {
    const out = [];
    for (const r of rows || []) {
      const m2 = Number(r?.m2) || 0;
      const qty = Number(r?.qty) || 0;
      if (m2 <= 0 || qty <= 0) continue;
      // Expand like handwritten list (one number per line), but cap for readability
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
    const stairsQty = Number(d?.stairsQty) || 0;
    const stairsPer = Number(d?.stairsPer) || 0.3;

    const lines = [];
    // Teppih list
    for (const v of expandM2Lines(tepiha, 12)) lines.push(String(v.toFixed(1)));
    // Staza list
    for (const v of expandM2Lines(staza, 12 - lines.length)) lines.push(String(v.toFixed(1)));

    const extra = [];
    if (stairsQty > 0) {
      const total = Number((stairsQty * stairsPer).toFixed(2));
      extra.push(`SHKALLË: ${stairsQty} x ${stairsPer} = ${total}m²`);
    }

    return { lines, extra };
  }

  function m2LinesFromOrder(o, maxLines = 12) {
    const d = getOrderData(o);
    const rows = [];

    const expand = (arr) => {
      (arr || []).forEach((r) => {
        const m2 = Number(r?.m2);
        const qty = Math.max(1, Number(r?.qty) || 1);
        if (!Number.isFinite(m2) || m2 <= 0) return;
        for (let i = 0; i < qty; i++) rows.push(m2);
      });
    };

    expand(Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []));
    expand(Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []));

    // SHKALLË (stairs)
    const stairsQty = Number(d?.stairsQty) || 0;
    const stairsPer = Number(d?.stairsPer) || 0.3;
    if (stairsQty > 0 && stairsPer > 0) {
      const total = Number((stairsQty * stairsPer).toFixed(2));
      rows.push(`SHKALLË: ${stairsQty} x ${stairsPer} = ${total}`);
    }

    if (rows.length <= maxLines) return rows;
    // Too many lines: show first N and a compact tail.
    const head = rows.slice(0, maxLines);
    const more = rows.length - maxLines;
    head.push(`+${more} TJERA`);
    return head;
  }

  // --- Funksionet e ngarkimit (loadLiveData, loadLatest, runNow) ---
  // (Këto mbesin të njejta siç i ke pasur, po i shkruaj shkurt për kontekst)
  async function loadLiveData() {
    const [cRes, oRes] = await Promise.all([
      supabase.from("clients").select("*").order("code", { ascending: true }),
      // Pull a generous window so last-order lookup works reliably.
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

    // Mapping Orders
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


  // --- LOGJIKA KRYESORE PËR NDARJEN AKTIV vs JO-AKTIV ---
  const { activeClients, inactiveClients } = useMemo(() => {
    const allClients = Array.isArray(data?.clients) ? data.clients : [];
    const allOrders = Array.isArray(data?.orders) ? data.orders : [];
    const search = String(q || "").trim().toLowerCase();

    // Build order maps by client code.
    const doneStatuses = new Set([
      "dorezuar",
      "dorëzuar",
      "dorzim",
      "dorezim",
      "paguar",
      "anuluar",
      "arkiv",
      "arkivuar",
    ]);

    const ordersByClient = new Map();
    allOrders.forEach((o) => {
      const ccode = normCode(o?.code ?? o?.client_code);
      if (!ccode) return;
      if (!ordersByClient.has(ccode)) ordersByClient.set(ccode, []);
      ordersByClient.get(ccode).push(o);
    });

    // Sort per client desc by created_at
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

    // 2. Filtrojmë listën kryesore
    const active = [];
    const inactive = [];

    allClients.forEach(c => {
      // Logic kërkimi (Search)
      const codeRaw = c?.code ?? "";
      const code = String(codeRaw ?? "").toLowerCase();
      const name = nameOfClient(c).toLowerCase();
      const phone = phoneOfClient(c).toLowerCase();
      
      const matches = !search || code.includes(search) || name.includes(search) || phone.includes(search);
      
      if (matches) {
        // Kontrollojmë nëse është aktiv apo jo
        // Nëse kodi i klientit gjendet te lista e porosive aktive
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
      
      {/* HEADER & CONTROLS (Nuk printohen) */}
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
          <button onClick={runNow} disabled={running} style={{ padding: "10px 15px", backgroundColor: "#000", color: "#fff", cursor: "pointer" }}>
            {running ? "..." : "RUAJ TANI"}
          </button>
          <button onClick={downloadPdf} style={{ padding: "10px 15px", backgroundColor: "#444", color: "#fff", cursor: "pointer" }}>
            ⬇️ PDF
          </button>
        </div>
        
        {loading && <div>Duke ngarkuar...</div>}
      </div>


      {/* --- PJESA 1: KLIENTAT AKTIV (NË PROCES) - FORMA E FLETORES --- */}
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
                pageBreakInside: "avoid", // Mos e lejo printerin ta ndajë kutinë në gjys
                position: "relative"
              }}>
                <div style={{ position: "absolute", right: 8, top: 4, fontSize: "24px", fontWeight: "900", color: "#333" }}>
                  #{c.code}
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
                      {/* Zona "me dorë" */}
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
                          <span
                            style={{
                              fontSize: "10px",
                              color: "#666",
                              textTransform: "uppercase",
                            }}
                          >
                            POROSIA AKTIVE:
                          </span>
                          <span style={{ fontSize: "11px", fontWeight: "800" }}>
                            {status}
                            {pieces ? ` • ${pieces}` : ""}
                          </span>
                        </div>

                        <div
                          style={{
                            fontFamily: "monospace",
                            fontSize: "14px",
                            lineHeight: "1.15",
                            marginTop: "6px",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {lines.length ? lines.join("\n") : "(PA MATJE AKOMA)"}
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


      {/* --- PJESA 2: KLIENTAT E TJERË (TË KRYER) - LISTË KOMPAKTE --- */}
      {inactiveClients.length > 0 && (
        <section>
          <h2 style={{ 
            fontSize: "18px", 
            borderBottom: "2px solid #000", 
            paddingBottom: "5px", 
            marginBottom: "10px",
            marginTop: "20px",
            color: "#444",
            textTransform: "uppercase"
          }}>
            🗄️ Klientat e Tjerë / Të kryer ({inactiveClients.length})
          </h2>
          
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
                  <td style={{ padding: "4px 5px", fontWeight: "bold" }}>{c.code}</td>
                  <td style={{ padding: "4px 5px" }}>{nameOfClient(c)}</td>
                  <td style={{ padding: "4px 5px" }}>{phoneOfClient(c)}</td>
                  <td style={{ padding: "4px 5px", textAlign: "right", fontSize: "12px" }}>
                    {c?._lastOrder?.created_at ? fmtDate(c._lastOrder.created_at) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* STILI PER PRINTIM */}
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
