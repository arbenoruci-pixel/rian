"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchTransportOrderById, updateTransportOrderById } from '@/lib/transportOrdersDb';
import { getTransportSession } from "@/lib/transportAuth";
import { recordCashMove } from "@/lib/arkaCashSync";
import { getErrorMessage } from "@/lib/uiSafety";

function translateTransportDbError(errLike) {
  const msg = String(errLike?.message || errLike?.error || errLike || '').toLowerCase();
  if (!msg) return 'Gabim i panjohur gjatë ruajtjes në databazë.';
  if (msg.includes('nuk ekziston ose perdoruesi nuk eshte aktiv') || msg.includes('nuk ekziston ose përdoruesi nuk është aktiv')) {
    return 'GABIM: PIN-i nuk ekziston ose llogaria nuk është aktive!';
  }
  if ((msg.includes('foreign key') && msg.includes('applied_cycle_id')) || msg.includes('cikli i arkës nuk është valid')) {
    return 'GABIM: Cikli i arkës nuk është valid. Rifresko faqen dhe provo përsëri!';
  }
  if (msg.includes('uuid')) {
    return 'GABIM: ID e ciklit nuk është UUID valide.';
  }
  return errLike?.message || errLike?.error || String(errLike || 'Gabim i panjohur');
}

function getActorPin(session) {
  return String(session?.transport_pin || session?.pin || session?.transport_id || '').trim();
}

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

function TransportPayPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = String(sp?.get("id") || "").trim();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
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

  async function loadOrder() {
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
    setLoadError('');
    try {
      const data = await fetchTransportOrderById(id);
      if (!data?.id) throw new Error("S'po e gjej porosinë.");
      setRow(data);
    } catch (e) {
      setRow(null);
      setLoadError(getErrorMessage(e, "S'po e gjej porosinë."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOrder();
  }, [id]);

  async function savePayment() {
    if (saving) return;
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

    setSaving(true);
    try {
      await updateTransportOrderById(row.id, { data: nextData });
    } catch (error) {
      setSaving(false);
      return alert('Gabim gjatë ruajtjes së pagesës: ' + getErrorMessage(error));
    }

    // Record as TRANSPORT collected cash (goes to driver's wallet / pending table; NOT auto-applied to daily ARKA)
    try {
      const actorPin = getActorPin(s);
      if (!actorPin) {
        alert('GABIM: PIN-i nuk ekziston ose llogaria nuk është aktive!');
        setSaving(false);
        return;
      }

      const transportCode = String(row.code_str || row.client_tcode || row?.data?.client?.tcode || "").trim().toUpperCase();
      const transportM2 = Number(row?.data?.pay?.m2 ?? row?.data?.m2_total ?? row?.data?.totals?.m2 ?? 0) || 0;
      const transportNote = `TRANSPORT PAGESË ${money(applied)}€ • ${row.client_name || ""} • ${transportCode || "T-KOD"} • ${transportM2.toFixed(2)} m²`;

      const moveRes = await recordCashMove({
        amount: applied,
        type: "TRANSPORT",
        source: "ORDER_PAY",
        order_id: row.id,
        order_code: transportCode,
        client_name: String(row.client_name || ""),
        note: transportNote,
        actor: {
          pin: actorPin,
          name: s?.name || s?.full_name || s?.username || null,
          role: s?.role || null,
        },
        created_by_pin: actorPin,
        created_by_name: s?.name || s?.full_name || s?.username || null,
        status: "COLLECTED",
      });

      if (moveRes && moveRes.ok === false) {
        alert(translateTransportDbError(moveRes.error || moveRes.db_error || moveRes.raw_error));
        setSaving(false);
        return;
      }
    } catch (e) {
      alert(translateTransportDbError(e));
      setSaving(false);
      return;
    }

    router.push("/transport/board");
  }

  if (loadError && !loading) {
    return (
      <div style={ui.page}>
        <div style={ui.center}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>⚠️</div>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>NUK U NGARKUA PAGESA</div>
          <div style={{ color: '#999', maxWidth: 360, margin: '0 auto 14px' }}>{loadError}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', padding: '0 16px' }}>
            <button style={ui.btnGhost} onClick={() => router.push('/transport/board')}>MBYLL</button>
            <button style={ui.btnPrimary} onClick={loadOrder}>RIPROVO</button>
          </div>
        </div>
      </div>
    );
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
        <button style={ui.btnGhost} onClick={() => router.push("/transport/board")} disabled={saving}>
          ANULO
        </button>
        <button style={ui.btnPrimary} onClick={savePayment} disabled={saving}>
          {saving ? 'DUKE RUJTUR...' : 'RUAJ PAGESËN'}
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
export default function TransportPayPage() {
  return (
    <Suspense fallback={null}>
      <TransportPayPageInner />
    </Suspense>
  );
}
