"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession } from "@/lib/transportAuth";
import { fetchTransportOrderById, updateTransportOrderById } from "@/lib/transportOrdersDb";
import { reserveTransportCode } from "@/lib/transportCodes";

// ---------------- utils ----------------
function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}
function getCode(row) {
  return String(row?.code || row?.code_str || row?.order_code || "").trim();
}
function getName(row) {
  return (
    row?.client_name ||
    row?.name ||
    row?.emri ||
    row?.full_name ||
    row?.data?.client?.name ||
    "PA EMËR"
  );
}
function getPhone(row) {
  const p =
    row?.client_phone ||
    row?.phone ||
    row?.telefoni ||
    row?.data?.client?.phone ||
    "";
  return onlyDigits(p);
}
function getAddress(row) {
  return (
    row?.address ||
    row?.adresa ||
    row?.pickup_address ||
    row?.data?.address ||
    row?.data?.pickup_address ||
    row?.note ||
    ""
  );
}
function getTotals(row) {
  const data = row?.data || row?.order || row || {};
  const pay = data?.pay || row?.pay || {};

  let pieces = Number(
    data?.pieces ?? data?.cope ?? data?.copë ?? pay?.pieces ?? row?.pieces ?? row?.cope ?? 0
  );
  if (!Number.isFinite(pieces)) pieces = 0;

  let m2 = Number(
    data?.m2_total ?? data?.total_m2 ?? data?.m2 ?? pay?.m2_total ?? pay?.m2 ?? row?.m2_total ?? row?.m2 ?? 0
  );
  if (!Number.isFinite(m2)) m2 = 0;

  const m2List = Array.isArray(data?.m2_list) ? data.m2_list : Array.isArray(data?.m2s) ? data.m2s : null;
  if (m2List && m2List.length) {
    const sum = m2List.reduce((acc, v) => acc + (Number(v) || 0), 0);
    if (!m2 || m2 < 0.0001) m2 = sum;
    if (!pieces) pieces = m2List.length;
  }

  let total = Number(
    data?.total ?? data?.sum ?? data?.amount ?? pay?.euro ?? pay?.total ?? pay?.sum ?? row?.total ?? row?.amount ?? 0
  );
  if (!Number.isFinite(total)) total = 0;

  let debt = Number(data?.debt ?? data?.borxh ?? pay?.debt ?? row?.debt ?? 0);
  if (!Number.isFinite(debt)) debt = 0;

  return { pieces, m2, total, debt };
}
function money0(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(0) : "0";
}
function m2fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(1) : "0.0";
}
function pickLatLng(row) {
  const d = row?.data || row?.order || row || {};
  const lat = Number(
    d?.gps_lat ?? d?.lat ?? d?.latitude ?? row?.gps_lat ?? row?.lat ?? row?.latitude
  );
  const lng = Number(
    d?.gps_lng ??
      d?.lng ??
      d?.lon ??
      d?.longitude ??
      row?.gps_lng ??
      row?.lng ??
      row?.lon ??
      row?.longitude
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function buildMsg(type, row) {
  const name = getName(row);
  const code = getCode(row);
  if (type === "pickup_default") {
    return `Përshëndetje ${name}, unë jam shoferi që vij sot me i marrë tepihat (${code}). Ju lutem konfirmo orarin që ju përshtatet.`;
  }
  if (type === "home_now") {
    return `Përshëndetje ${name}, a jeni në shtëpi tani për me i marrë tepihat (${code})? Ju lutem konfirmo.`;
  }
  if (type === "eta_10") {
    return `Përshëndetje ${name}, u nisa me tepihat (${code}). Jam aty për rreth 10 minuta. Ju lutem konfirmo që jeni në shtëpi.`;
  }
  return `Përshëndetje ${name}.`;
}

function openChannel(kind, row, msgType = "pickup_default") {
  const phone = getPhone(row);
  const txt = encodeURIComponent(buildMsg(msgType, row));
  if (kind === "sms") {
    window.location.href = `sms:${phone}?&body=${txt}`;
    return;
  }
  if (kind === "wa") {
    window.open(`https://wa.me/${phone}?text=${txt}`, "_blank");
    return;
  }
  // viber
  window.open(`viber://chat?number=%2B${phone}&text=${txt}`, "_blank");
}

function nextForStatus(st) {
  const s = String(st || "").toLowerCase();
  if (s === "dispatched") return { label: "PRANO", to: "pickup" };
  if (s === "pickup") return { label: "LOADED", to: "loaded" };
  if (s === "loaded") return { label: "NË BAZË", to: "pastrim" };
  // ✅ BAZA (PASTRIM) -> GATI (te shoferi)
  if (s === "pastrim") return null; // BASE e bën GATI (shared PASRTRIM)
  return null;
}

export default function TransportItemPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const id = sp?.get("id") || "";
  const tab = (sp?.get("tab") || "inbox").toLowerCase();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [row, setRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [baseNote, setBaseNote] = useState('');

  
  useEffect(() => {
    try {
      const v = String(row?.data?.base_note ?? row?.data?.base_location ?? row?.data?.baza_note ?? '');
      setBaseNote(v);
    } catch {}
  }, [row?.id]);

async function load() {
    if (!id) {
      setErr("MUNGON ID");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      try {
        const t = await fetchTransportOrderById(id);
        if (t) {
          setRow({ ...t, __src: "transport_orders" });
          return;
        }
      } catch {}
      const b = await supabase.from("orders").select("*").eq("id", id).maybeSingle();
      if (!b.error && b.data) {
        setRow({ ...b.data, __src: "orders" });
        return;
      }
      setErr(b.error?.message || "NUK U GJET");
    } catch (e) {
      setErr(e?.message || "GABIM");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const meta = useMemo(() => {
    const code = getCode(row) || "—";
    const name = getName(row);
    const phone = getPhone(row);
    const addr = getAddress(row);
    const t = getTotals(row);
    const ll = pickLatLng(row);
    return { code, name, phone, addr, t, ll };
  }, [row]);

  async function setStatus(next) {
    if (!row?.id || !row?.__src) return;
    setBusy(true);
    setErr("");
    try {
      // If this is a DISPATCHED transport order, accepting must reserve a REAL T-code from the pool.
      if (String(row.status || "").toLowerCase() === "dispatched" && row.__src === "transport_orders") {
        const me = getTransportSession();
        const tid = String(me?.transport_id || "");
        if (!tid) throw new Error("NUK JE LOGUAR SI TRANSPORT");

        const code = await reserveTransportCode(tid);
        if (!code) throw new Error("NUK U REZERVU T-KODI");
        const code_n = Number(String(code).replace(/\D+/g, "")) || null;

        await updateTransportOrderById(row.id, { status: next, code_str: String(code), code_n });
      } else {
        if (row.__src === 'transport_orders') {
          await updateTransportOrderById(row.id, { status: next });
        } else {
          const { error } = await supabase.from(row.__src).update({ status: next }).eq("id", row.id);
          if (error) throw error;
        }
      }
      await load();
    } catch (e) {
      setErr(e?.message || "NUK U RUAJ");
    } finally {
      setBusy(false);
    }
  }

  
  async function saveBaseNote() {
    if (!row?.id) return;
    setBusy(true);
    setErr('');
    try {
      const cur = row?.data || {};
      const nextData = { ...cur, base_note: String(baseNote || '').trim() };
      if (row.__src === 'transport_orders') {
        await updateTransportOrderById(row.id, { data: nextData });
      } else {
        const { error } = await supabase.from(row.__src).update({ data: nextData }).eq("id", row.id);
        if (error) throw error;
      }
      await load();
    } catch (e) {
      setErr(e?.message || "NUK U RUAJ SHËNIMI");
    } finally {
      setBusy(false);
    }
  }

function goBack() {
    router.push(`/transport/board?tab=${encodeURIComponent(tab)}`);
  }

  function openPranimi(focus = "") {
    if (!row?.id) return;
    const url = `/transport/pranimi?id=${encodeURIComponent(row.id)}${focus ? `&focus=${encodeURIComponent(focus)}` : ""}`;
    router.push(url);
  }

  function openMaps() {
    if (meta.ll) {
      const q = encodeURIComponent(`${meta.ll.lat},${meta.ll.lng}`);
      window.open(`https://www.google.com/maps?q=${q}`, "_blank");
      return;
    }
    if (meta.addr) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(meta.addr)}`, "_blank");
      return;
    }
  }

  const next = useMemo(() => nextForStatus(row?.status), [row]);

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <button style={ui.backBtn} onClick={goBack}>‹ BACK</button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link href="/transport/menu" style={ui.menuBtn}>MENU</Link>
        </div>
      </div>

      {err ? <div style={ui.err}>{err}</div> : null}

      <div style={ui.card}>
        <div style={ui.headRow}>
          <div style={ui.codePill}>{meta.code}</div>
          <div style={{ textAlign: "right" }}>
            <div style={ui.total}>€{money0(meta.t.total)}</div>
            <div style={ui.sub}>{meta.t.pieces} copë • {m2fmt(meta.t.m2)} m²</div>
          </div>
        </div>

        <div style={ui.name}>{meta.name}</div>
        <div style={ui.sub}>{meta.phone ? `+${meta.phone}` : "—"}</div>

        <div style={ui.addrBox}>
          <div style={ui.addrTitle}>ADRESA</div>
          <div style={ui.addrText}>{meta.addr || "—"}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button style={ui.btnSoft} onClick={() => window.location.href = `tel:${meta.phone}`} disabled={!meta.phone}>
              📞 THIRR
            </button>
            <button style={ui.btnSoft} onClick={openMaps}>
              🧭 GO
            </button>
          </div>
        </div>

        <div style={ui.actionsRow}>
          <button style={ui.iconBtn} onClick={() => openChannel("sms", row, "pickup_default")}>✉️</button>
          <button style={ui.iconBtn} onClick={() => openChannel("wa", row, "pickup_default")}>🟢</button>
          <button style={ui.iconBtn} onClick={() => openChannel("viber", row, "pickup_default")}>🟣</button>
          <button style={ui.smallBtn} onClick={() => openChannel("sms", row, "home_now")}>A JE N’SHTËPI?</button>
          <button style={ui.smallBtn} onClick={() => openChannel("sms", row, "eta_10")}>JAM ATY 10 MIN</button>
        </div>

        
        <div style={ui.noteBox}>
          <div style={ui.addrTitle}>SHËNIM BAZA (KU I LA TEPIHAT)</div>
          <textarea
            style={ui.textarea}
            value={baseNote}
            onChange={(e) => setBaseNote(e.target.value)}
            placeholder="p.sh. RAFTI 2 • DHOMA THARJES • ANASH DJATHTAS…"
            rows={3}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button style={ui.btnSoft} disabled={busy} onClick={saveBaseNote}>
              {busy ? "..." : "RUAJ SHËNIMIN"}
            </button>
          </div>
        </div>

<div style={ui.hr} />

        <div style={ui.footerRow}>
          <button style={ui.btnSoft} onClick={() => openPranimi("")}>DET / EDIT</button>
          <button style={ui.btnSoft} onClick={() => openPranimi("pay")}>€ PAGESA</button>

          {next ? (
            <button style={ui.btnPrimary} disabled={busy} onClick={() => setStatus(next.to)}>
              {busy ? "..." : next.label}
            </button>
          ) : (
            <button style={ui.btnPrimary} disabled>
              OK
            </button>
          )}
        </div>
      </div>

      {loading ? <div style={ui.muted}>DUKE NGARKU…</div> : null}
    </div>
  );
}

// ---------------- UI ----------------
const ui = {
  page: { minHeight: "100vh", background: "#f2f2f7", color: "#111", padding: 14 },
  top: { maxWidth: 820, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center" },
  backBtn: { border: "none", background: "transparent", fontWeight: 900, fontSize: 14, cursor: "pointer", padding: 6 },
  menuBtn: { textDecoration: "none", color: "#111", fontWeight: 900, border: "1px solid rgba(0,0,0,0.10)", background: "#fff", padding: "8px 10px", borderRadius: 12 },
  err: { maxWidth: 820, margin: "10px auto 0", background: "#fff", border: "1px solid rgba(255,0,0,0.18)", color: "#b42318", borderRadius: 12, padding: 10, fontWeight: 800 },
  muted: { maxWidth: 820, margin: "10px auto 0", color: "#6b7280", fontWeight: 800 },
  card: { maxWidth: 820, margin: "10px auto 0", background: "#fff", border: "1px solid rgba(0,0,0,0.10)", borderRadius: 16, padding: 14 },
  headRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  codePill: { border: "1px solid rgba(0,0,0,0.10)", borderRadius: 999, padding: "6px 10px", fontWeight: 900, fontSize: 12, background: "#fff" },
  total: { fontWeight: 900, fontSize: 18 },
  name: { marginTop: 10, fontWeight: 900, fontSize: 18 },
  sub: { marginTop: 4, color: "#6b7280", fontWeight: 700, fontSize: 13 },
  addrBox: { marginTop: 12, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, background: "#fafafa" },
  addrTitle: { fontWeight: 900, fontSize: 12, letterSpacing: 1.2, color: "#6b7280" },
  addrText: { marginTop: 6, fontWeight: 800, fontSize: 14 },
  actionsRow: { marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  iconBtn: { border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 12, padding: "8px 10px", fontWeight: 900, cursor: "pointer" },
  smallBtn: { border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 999, padding: "8px 10px", fontWeight: 900, cursor: "pointer", fontSize: 12 },
  hr: { height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" },
  footerRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  btnSoft: { flex: "1 1 160px", border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 12, padding: "12px 10px", fontWeight: 900, cursor: "pointer" },
  btnPrimary: { flex: "1 1 160px", border: "1px solid #111", background: "#111", color: "#fff", borderRadius: 12, padding: "12px 10px", fontWeight: 900, cursor: "pointer" },
};
