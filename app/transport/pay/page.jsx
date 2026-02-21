"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession } from "@/lib/transportAuth";
import { recordCashMove } from "@/lib/arkaCashSync";

function money(x) {
  const n = Number(x || 0);
  return n.toFixed(2);
}

function getTotals(row) {
  const d = row?.data || {};
  const pay = d.pay || {};
  const total = Number(pay.euro ?? pay.total ?? 0);
  const paid = Number(pay.paid ?? 0);
  const m2 = Number(pay.m2 ?? 0);
  const pieces =
    (Array.isArray(d.tepiha) ? d.tepiha.reduce((a, r) => a + Number(r.qty || 0), 0) : 0) +
    (Array.isArray(d.staza) ? d.staza.reduce((a, r) => a + Number(r.qty || 0), 0) : 0) +
    (Number(d?.shkallore?.qty || 0) > 0 ? 1 : 0);

  return { total, paid, due: Math.max(0, total - paid), m2, pieces };
}

export default function TransportPayPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = String(sp?.get("id") || "").trim();

  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);

  const [payToday, setPayToday] = useState("");
  const [cashGiven, setCashGiven] = useState("");

  const t = useMemo(() => (row ? getTotals(row) : { total: 0, paid: 0, due: 0, m2: 0, pieces: 0 }), [row]);

  const applied = useMemo(() => {
    const p = Number(payToday || 0);
    if (!p || p <= 0) return 0;
    return Math.min(p, t.due);
  }, [payToday, t.due]);

  const change = useMemo(() => {
    const g = Number(cashGiven || 0);
    if (!g || g <= 0) return 0;
    return Math.max(0, g - applied);
  }, [cashGiven, applied]);

  useEffect(() => {
    (async () => {
      const s = getTransportSession();
      if (!s?.transport_id) {
        router.push("/transport/menu");
        return;
      }
      if (!id) {
        router.push("/transport/board");
        return;
      }

      setLoading(true);
      const { data, error } = await supabase
        .from("transport_orders")
        .select("id, code_str, status, client_name, client_phone, transport_id, data, created_at")
        .eq("id", id)
        .maybeSingle();

      if (error || !data?.id) {
        alert("S'po e gjej porosin.");
        router.push("/transport/board");
        return;
      }

      setRow(data);
      setLoading(false);
    })();
  }, [id]);

  async function savePayment() {
    const s = getTransportSession();
    if (!s?.transport_id) return;

    const p = Number(payToday || 0);
    if (!p || p <= 0) return alert("Shkruaj sa paguan sot.");
    if (applied <= 0) return alert("S'ka borxh (0€).");

    const d = row?.data || {};
    const pay = { ...(d.pay || {}) };

    const newPaid = Number((Number(pay.paid || 0) + applied).toFixed(2));
    pay.paid = newPaid;

    // OPTIONAL: keep last cash info for UI
    pay.last_cash_given = Number(cashGiven || 0) || 0;
    pay.last_change = Number(change || 0) || 0;
    pay.last_paid_at = new Date().toISOString();

    const nextData = { ...d, pay };

    const { error } = await supabase.from("transport_orders").update({ data: nextData }).eq("id", row.id);
    if (error) return alert("Gabim gjatë ruajtjes së pagesës: " + error.message);

    // Record as TRANSPORT collected cash (goes to driver's wallet / pending table; NOT auto-applied to daily ARKA)
    try {
      await recordCashMove({
        amount: applied,
        type: "TRANSPORT",
        source: "ORDER_PAY",
        order_id: row.id,
        order_code: String(row.code_str || ""),
        client_name: String(row.client_name || ""),
        created_by_pin: String(s.transport_id),
        created_by_name: String(s.transport_name || "TRANSPORT"),
        note: `TRANSPORT PAGESË ${money(applied)}€ • ${row.client_name || ""} • ${row.code_str || ""}`,
        status: "COLLECTED",
      });
    } catch {}

    router.push("/transport/board");
  }

  if (loading) {
    return (
      <div style={ui.page}>
        <div style={ui.center}>Duke u hapur…</div>
      </div>
    );
  }

  const code = row?.code_str || "";
  const name = row?.client_name || (row?.data?.client?.name || "");
  const phone = row?.client_phone || (row?.data?.client?.phone || "");

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <button style={ui.backBtn} onClick={() => router.back()}>
          ‹
        </button>
        <div style={{ textAlign: "center" }}>
          <div style={ui.title}>PAGESA</div>
          <div style={ui.sub}>{code} • {name}</div>
        </div>
        <button style={ui.closeBtn} onClick={() => router.push("/transport/board")}>
          ✕
        </button>
      </div>

      <div style={ui.body}>
        <div style={ui.card}>
          <div style={ui.line}><span>TOTAL</span><strong>{money(t.total)} €</strong></div>
          <div style={ui.line}><span>PAGUAR</span><strong style={{ color: "#34C759" }}>{money(t.paid)} €</strong></div>
          <div style={ui.line}><span>BORXH</span><strong style={{ color: t.due > 0 ? "#FF3B30" : "#34C759" }}>{money(t.due)} €</strong></div>
          <div style={ui.small}>m²: {t.m2.toFixed(2)} • copë: {t.pieces}</div>
        </div>

        <div style={ui.card}>
          <div style={ui.fieldLabel}>PAGUAN SOT (€)</div>
          <input
            style={ui.input}
            inputMode="decimal"
            placeholder="0"
            value={payToday}
            onChange={(e) => setPayToday(e.target.value)}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            {[5, 10, 20, 30, 50].map((v) => (
              <button key={v} style={ui.chip} onClick={() => setPayToday(String(v))}>
                {v}€
              </button>
            ))}
            <button style={ui.chip} onClick={() => setPayToday(String(t.due))}>
              BORXH
            </button>
            <button style={ui.chip} onClick={() => setPayToday("")}>
              FSHI
            </button>
          </div>

          <div style={{ height: 12 }} />

          <div style={ui.fieldLabel}>KLIENTI DHA (€)</div>
          <input
            style={ui.input}
            inputMode="decimal"
            placeholder="0"
            value={cashGiven}
            onChange={(e) => setCashGiven(e.target.value)}
          />

          <div style={ui.line2}>
            <span>APLIKOHET</span>
            <strong>{money(applied)} €</strong>
          </div>
          <div style={ui.line2}>
            <span>ME IA KTHY</span>
            <strong style={{ color: change > 0 ? "#FFD60A" : "#AAA" }}>{money(change)} €</strong>
          </div>

          {Number(payToday || 0) > t.due && (
            <div style={ui.warn}>Kujdes: ke shkru ma shumë se borxhi. Aplikohet vetëm borxhi.</div>
          )}
        </div>

        <div style={{ height: 90 }} />
      </div>

      <div style={ui.bottom}>
        <button style={ui.btnGhost} onClick={() => router.push("/transport/board")}>
          ANULO
        </button>
        <button style={ui.btnPrimary} onClick={savePayment}>
          RUAJ PAGESËN
        </button>
      </div>
    </div>
  );
}

const ui = {
  page: { background: "#000", minHeight: "100vh", color: "#fff", fontFamily: "-apple-system,BlinkMacSystemFont,Roboto,sans-serif" },
  center: { paddingTop: 60, textAlign: "center", color: "#777" },
  top: { position: "sticky", top: 0, zIndex: 10, background: "#000", borderBottom: "1px solid #111", height: 64, display: "grid", gridTemplateColumns: "52px 1fr 52px", alignItems: "center", padding: "0 10px" },
  backBtn: { width: 44, height: 44, borderRadius: 14, border: "1px solid #222", background: "#111", color: "#fff", fontSize: 22, cursor: "pointer" },
  closeBtn: { width: 44, height: 44, borderRadius: 14, border: "1px solid #222", background: "#111", color: "#fff", fontSize: 18, cursor: "pointer" },
  title: { fontWeight: 900, letterSpacing: 1, fontSize: 16 },
  sub: { fontSize: 12, color: "#888", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  body: { padding: 14, maxWidth: 520, margin: "0 auto" },
  card: { background: "#0b0b0b", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, padding: 14, marginTop: 12 },
  line: { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14, fontWeight: 800 },
  small: { marginTop: 6, fontSize: 12, color: "#777" },
  fieldLabel: { fontSize: 12, fontWeight: 900, letterSpacing: 1, color: "#AAA", marginBottom: 6, marginTop: 4 },
  input: { width: "100%", background: "#111", border: "1px solid #222", borderRadius: 14, padding: "12px 12px", color: "#fff", fontSize: 18, fontWeight: 900, outline: "none" },
  chip: { padding: "10px 12px", borderRadius: 14, border: "1px solid #222", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer" },
  line2: { display: "flex", justifyContent: "space-between", paddingTop: 10, fontSize: 13, color: "#BBB", fontWeight: 900 },
  warn: { marginTop: 10, fontSize: 12, color: "#FF9500", fontWeight: 800 },
  bottom: { position: "fixed", left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.92)", borderTop: "1px solid #111", padding: 14, display: "flex", gap: 10, justifyContent: "space-between", backdropFilter: "blur(10px)" },
  btnGhost: { flex: 1, padding: 14, borderRadius: 16, border: "1px solid #222", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer" },
  btnPrimary: { flex: 1, padding: 14, borderRadius: 16, border: "none", background: "#fff", color: "#000", fontWeight: 900, cursor: "pointer" },
};
