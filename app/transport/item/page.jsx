"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter, useSearchParams } from "@/lib/routerCompat.jsx";
import RackLocationModal from "@/components/RackLocationModal";
import { fetchRackMapFromDb, normalizeRackSlots } from "@/lib/rackLocations";
import { getTransportSession } from "@/lib/transportAuth";
import { getActor } from '@/lib/actorSession';
import { fetchTransportOrderById, fetchTransportOrderByCode, updateTransportOrderById } from "@/lib/transportOrdersDb";
import { reserveTransportCode } from "@/lib/transportCodes";
import { buildSmsLink } from "@/lib/smartSms";

function V33PageOpenFallback() {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#fff', display: 'grid', placeItems: 'center', padding: 24, fontFamily: '-apple-system,BlinkMacSystemFont,Roboto,sans-serif' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 20, background: 'rgba(255,255,255,0.06)', padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>DUKE HAPUR…</div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>HOME</a>
          <a href="/diag-raw" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>DIAG RAW</a>
        </div>
      </div>
    </div>
  );
}

function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}

function getOrderData(row) {
  return row?.data || row?.order || row || {};
}

function readActor() {
  return getActor();
}

function getCode(row) {
  const s = String(row?.code || row?.code_str || row?.order_code || row?.client_tcode || "").trim();
  if (s) return s;
  const v = row?.visit_nr ?? row?.visit_no ?? null;
  if (Number.isFinite(Number(v)) && Number(v) > 0) return `T${Number(v)}`;
  return "";
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
  const data = getOrderData(row);
  const pay = data?.pay || row?.pay || {};

  const tepiha = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  const staza = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  const shkalloreQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;

  const countRows = (rows) => rows.reduce((acc, item) => {
    const qty = Number(item?.qty ?? item?.pieces ?? 0);
    return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
  }, 0);

  let pieces = Number(
    data?.pieces ?? data?.cope ?? data?.copë ?? pay?.pieces ?? row?.pieces ?? row?.cope ?? 0
  );
  if (!Number.isFinite(pieces) || pieces <= 0) {
    pieces = countRows(tepiha) + countRows(staza) + shkalloreQty;
  }

  let m2 = Number(
    data?.m2_total ?? data?.total_m2 ?? data?.m2 ?? pay?.m2_total ?? pay?.m2 ?? row?.m2_total ?? row?.m2 ?? 0
  );
  if (!Number.isFinite(m2)) m2 = 0;

  if (!m2 || m2 < 0.0001) {
    const sumRows = (rows) => rows.reduce((acc, item) => {
      const qty = Number(item?.qty ?? item?.pieces ?? 0);
      const area = Number(item?.m2 ?? item?.size ?? item?.area ?? item?.sqm ?? 0);
      if (!Number.isFinite(area) || area <= 0) return acc;
      return acc + (qty > 0 ? qty : 1) * area;
    }, 0);
    const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
    m2 = sumRows(tepiha) + sumRows(staza) + (shkalloreQty > 0 && stairsPer > 0 ? shkalloreQty * stairsPer : 0);
  }

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
  const d = getOrderData(row);
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

function getWhoBrought(row) {
  const data = getOrderData(row);
  const candidates = [
    data?.transport_name,
    row?.transport_name,
    data?.driver_name,
    row?.driver_name,
    data?.created_by_name,
    row?.created_by_name,
    data?._audit?.created_by_name,
    row?._audit?.created_by_name,
    data?.created_by,
    row?.created_by,
    data?.created_by_pin,
    row?.created_by_pin,
    data?.transport_id,
    row?.transport_id,
  ].map((v) => String(v || '').trim()).filter(Boolean);

  for (const value of candidates) {
    if (/^\d+$/.test(value)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(value)) continue;
    return value;
  }
  return '';
}

function getTransporterNote(row) {
  const data = getOrderData(row);
  return String(
    data?.notes ||
    data?.driver_note ||
    data?.transport_note ||
    row?.notes ||
    row?.driver_note ||
    row?.transport_note ||
    ""
  ).trim();
}

function getBaseNote(row) {
  const data = getOrderData(row);
  return String(
    data?.base_note ||
    data?.base_location ||
    data?.baza_note ||
    data?.ready_note_text ||
    row?.ready_note_text ||
    ""
  ).trim();
}

function getReadyMeta(row) {
  const data = getOrderData(row);
  const slots = normalizeRackSlots(row?.ready_slots || data?.ready_slots || row?.ready_location || data?.ready_location || row?.ready_note || data?.ready_note || []);
  const noteText = String(row?.ready_note_text || data?.ready_note_text || "").trim();
  const display = slots.length ? `${slots.join(", ")}${noteText ? ` • ${noteText}` : ""}` : (noteText || String(row?.ready_location || data?.ready_location || row?.ready_note || data?.ready_note || "").trim());
  return {
    slots,
    noteText,
    display,
  };
}

function extractDetailRows(row) {
  const data = getOrderData(row);
  const out = [];

  const tepiha = Array.isArray(data?.tepiha) ? data.tepiha : (Array.isArray(data?.tepihaRows) ? data.tepihaRows : []);
  tepiha.forEach((item, idx) => {
    const qty = Number(item?.qty ?? item?.pieces ?? 0) || 0;
    const m2 = Number(item?.m2 ?? item?.size ?? item?.area ?? item?.sqm ?? 0) || 0;
    const parts = [];
    if (qty > 0) parts.push(`${qty} copë`);
    if (m2 > 0) parts.push(`${m2fmt(m2)} m²`);
    if (item?.note) parts.push(String(item.note).trim());
    out.push({ label: `TEPIH ${idx + 1}`, value: parts.join(" • ") || "—" });
  });

  const staza = Array.isArray(data?.staza) ? data.staza : (Array.isArray(data?.stazaRows) ? data.stazaRows : []);
  staza.forEach((item, idx) => {
    const qty = Number(item?.qty ?? item?.pieces ?? 0) || 0;
    const m2 = Number(item?.m2 ?? item?.size ?? item?.area ?? item?.sqm ?? 0) || 0;
    const parts = [];
    if (qty > 0) parts.push(`${qty} copë`);
    if (m2 > 0) parts.push(`${m2fmt(m2)} m²`);
    if (item?.note) parts.push(String(item.note).trim());
    out.push({ label: `STAZË ${idx + 1}`, value: parts.join(" • ") || "—" });
  });

  const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
  const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
  if (stairsQty > 0) {
    const parts = [`${stairsQty} copë`];
    if (stairsPer > 0) parts.push(`${m2fmt(stairsPer)} m²/copë`);
    out.push({ label: "SHKALLORE", value: parts.join(" • ") });
  }

  return out;
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
  const message = buildMsg(msgType, row);
  const txt = encodeURIComponent(message);
  if (kind === "sms") {
    const smsHref = buildSmsLink(phone, message);
    if (smsHref) window.location.href = smsHref;
    return;
  }
  if (kind === "wa") {
    window.open(`https://wa.me/${phone}?text=${txt}`, "_blank");
    return;
  }
  window.open(`viber://chat?number=%2B${phone}&text=${txt}`, "_blank");
}

function nextForStatus(st) {
  const s = String(st || "").toLowerCase();
  if (s === "dispatched") return { label: "PRANO", to: "pickup" };
  if (s === "pickup") return { label: "LOADED", to: "loaded" };
  if (s === "loaded") return { label: "NË BAZË", to: "pastrim" };
  if (s === "pastrim") return null;
  return null;
}

function TransportItemPageInner() {
  const router = useRouter();
  const sp = useSearchParams();

  const id = sp?.get("id") || "";
  const codeParam = String(sp?.get("code") || "").trim().toUpperCase();
  const tab = (sp?.get("tab") || "inbox").toLowerCase();
  const from = String(sp?.get("from") || "").trim();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [row, setRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [baseNote, setBaseNote] = useState("");
  const [rackModal, setRackModal] = useState({
    open: false,
    busy: false,
    error: "",
    markReady: false,
    selectedSlots: [],
    placeText: "",
    slotMap: {},
  });

  useEffect(() => {
    try {
      setBaseNote(getBaseNote(row));
    } catch {}
  }, [row?.id, row?.updated_at]);

  async function load() {
    if (!id && !codeParam) {
      setErr("MUNGON ID / KODI");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const t = id ? await fetchTransportOrderById(id) : await fetchTransportOrderByCode(codeParam);
      if (t) {
        setRow({ ...t, __src: "transport_orders" });
        return;
      }
      setRow(null);
      setErr("NUK U GJET NË TRANSPORT");
    } catch (e) {
      setRow(null);
      setErr(e?.message || "GABIM");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, codeParam]);

  const meta = useMemo(() => {
    const code = getCode(row) || "—";
    const name = getName(row);
    const phone = getPhone(row);
    const addr = getAddress(row);
    const t = getTotals(row);
    const ll = pickLatLng(row);
    return { code, name, phone, addr, t, ll };
  }, [row]);

  const readyMeta = useMemo(() => getReadyMeta(row), [row]);
  const detailRows = useMemo(() => extractDetailRows(row), [row]);
  const transporterNote = useMemo(() => getTransporterNote(row), [row]);
  const broughtBy = useMemo(() => getWhoBrought(row), [row]);
  const next = useMemo(() => nextForStatus(row?.status), [row]);
  const isBaseStage = ["pastrim", "gati"].includes(String(row?.status || "").toLowerCase());

  async function setStatus(nextStatus) {
    if (!row?.id || !row?.__src) return;
    setBusy(true);
    setErr("");
    try {
      if (String(row.status || "").toLowerCase() === "dispatched" && row.__src === "transport_orders") {
        const me = getTransportSession();
        const tid = String(me?.transport_id || "");
        if (!tid) throw new Error("NUK JE LOGUAR SI TRANSPORT");

        const code = await reserveTransportCode(tid);
        if (!code) throw new Error("NUK U REZERVU T-KODI");
        await updateTransportOrderById(row.id, { status: nextStatus, code_str: String(code) });
        setRow((prev) => prev ? { ...prev, status: nextStatus, code_str: String(code) } : prev);
      } else {
        await updateTransportOrderById(row.id, { status: nextStatus });
        setRow((prev) => prev ? { ...prev, status: nextStatus } : prev);
      }
    } catch (e) {
      setErr(e?.message || "NUK U RUAJ");
    } finally {
      setBusy(false);
    }
  }

  async function saveBaseNote() {
    if (!row?.id) return;
    setBusy(true);
    setErr("");
    try {
      const cur = getOrderData(row);
      const nextData = { ...cur, base_note: String(baseNote || "").trim() };
      await updateTransportOrderById(row.id, { data: nextData, updated_at: new Date().toISOString() });
      setRow((prev) => prev ? { ...prev, data: nextData, updated_at: new Date().toISOString() } : prev);
    } catch (e) {
      setErr(e?.message || "NUK U RUAJ SHËNIMI");
    } finally {
      setBusy(false);
    }
  }

  async function openRackPicker(markReady = false) {
    if (!row?.id) return;
    try {
      let text = String(row?.ready_note_text || row?.data?.ready_note_text || row?.ready_note || row?.data?.ready_note || row?.ready_location || row?.data?.ready_location || "");
      text = text.replace(/^📍\s*(\[[^\]]+\]\s*)?/, "").trim();
      setRackModal({
        open: true,
        busy: true,
        error: "",
        markReady,
        selectedSlots: normalizeRackSlots(row?.ready_slots || row?.data?.ready_slots || row?.ready_location || row?.data?.ready_location || row?.ready_note || row?.data?.ready_note || []),
        placeText: text,
        slotMap: {},
      });
      const map = await fetchRackMapFromDb();
      setRackModal((prev) => ({ ...prev, busy: false, slotMap: map }));
    } catch {
      setRackModal((prev) => ({ ...prev, busy: false, error: "NUK U NGARKUAN RAFTAT. PROVO PËRSËRI." }));
    }
  }

  function closeRackPicker() {
    setRackModal({
      open: false,
      busy: false,
      error: "",
      markReady: false,
      selectedSlots: [],
      placeText: "",
      slotMap: {},
    });
  }

  function toggleRackSlot(slot) {
    setRackModal((prev) => {
      const arr = Array.isArray(prev.selectedSlots) ? prev.selectedSlots : [];
      return {
        ...prev,
        selectedSlots: arr.includes(slot) ? arr.filter((x) => x !== slot) : [...arr, slot],
      };
    });
  }

  async function saveRackPicker() {
    if (!row?.id) return;
    const selectedSlots = Array.isArray(rackModal.selectedSlots) ? rackModal.selectedSlots : [];
    const txt = String(rackModal.placeText || '').trim();
    const actor = readActor() || getTransportSession() || {};
    const actorName = String(actor?.name || actor?.full_name || actor?.role || '').trim() || 'UNKNOWN';
    const now = new Date().toISOString();
    const readyNote = selectedSlots.length ? `📍 [${selectedSlots.join(', ')}] ${txt}`.trim() : (txt ? `📍 ${txt}` : '');
    const readyLocation = selectedSlots.length ? selectedSlots.join(', ') : txt;
    const currentData = getOrderData(row) || {};
    const nextData = {
      ...currentData,
      ready_slots: selectedSlots,
      ready_note_text: txt,
      ready_note: readyNote,
      ready_location: readyLocation,
      ready_note_at: now,
      ready_note_by: actorName,
      base_note: txt,
    };
    const patch = {
      data: nextData,
      ready_slots: selectedSlots,
      ready_note_text: txt,
      ready_note: readyNote,
      ready_location: readyLocation,
      ready_note_at: now,
      ready_note_by: actorName,
      updated_at: now,
    };
    if (rackModal.markReady && String(row?.status || '').toLowerCase() === 'pastrim') {
      patch.status = 'gati';
      patch.ready_at = now;
      nextData.status = 'gati';
      nextData.ready_at = now;
    }

    try {
      setRackModal((prev) => ({ ...prev, busy: true, error: '' }));
      await updateTransportOrderById(row.id, patch);
      setRow((prev) => prev ? {
        ...prev,
        data: nextData,
        ready_slots: selectedSlots,
        ready_note_text: txt,
        ready_note: readyNote,
        ready_location: readyLocation,
        ready_note_at: now,
        ready_note_by: actorName,
        status: patch.status || prev.status,
        ready_at: patch.ready_at || prev.ready_at,
        updated_at: now,
      } : prev);
      closeRackPicker();
    } catch (e) {
      setRackModal((prev) => ({ ...prev, busy: false, error: e?.message || 'NUK U RUAJT POZICIONI.' }));
    }
  }

  function goBack() {
    if (from === 'home_search' || from === 'search_redirect') {
      router.push('/');
      return;
    }
    if (from === 'search') {
      router.push(`/search?code=${encodeURIComponent(meta.code || "")}`);
      return;
    }
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
    }
  }

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

        <div style={ui.badgeRow}>
          <div style={ui.infoBadge}>{String(row?.status || "pa status").toUpperCase()}</div>
          {broughtBy ? <div style={ui.infoBadge}>PRU NGA: {String(broughtBy).toUpperCase()}</div> : null}
          {readyMeta.display ? <div style={ui.infoBadge}>📍 {readyMeta.display}</div> : null}
        </div>

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

        {detailRows.length ? (
          <div style={ui.sectionBox}>
            <div style={ui.addrTitle}>MASAT / PËRMBAJTJA</div>
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {detailRows.map((item, idx) => (
                <div key={`${item.label}-${idx}`} style={ui.detailRow}>
                  <div style={ui.detailLabel}>{item.label}</div>
                  <div style={ui.detailValue}>{item.value || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {transporterNote ? (
          <div style={ui.sectionBox}>
            <div style={ui.addrTitle}>SHËNIM NGA TRANSPORTI</div>
            <div style={ui.noteText}>{transporterNote}</div>
          </div>
        ) : null}

        <div style={ui.noteBox}>
          <div style={ui.addrTitle}>SHËNIM PËR TRANSPORTIN</div>
          <textarea
            style={ui.textarea}
            value={baseNote}
            onChange={(e) => setBaseNote(e.target.value)}
            placeholder="p.sh. I LASHË 2 COPË MBRAPA, 1 TEPIH U SHTUA SOT…"
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
          {isBaseStage ? (
            <button style={ui.btnPrimary} disabled={busy} onClick={() => openRackPicker(String(row?.status || "").toLowerCase() === "pastrim")}>
              {String(row?.status || "").toLowerCase() === "pastrim" ? "QIT NË GATI / RAFTI" : "RAFTI / SHËNIMI"}
            </button>
          ) : null}

          <button style={ui.btnSoft} onClick={() => openPranimi("")}>DET / EDIT / + COPË</button>
          <button style={ui.btnSoft} onClick={() => openPranimi("pay")}>€ PAGESA</button>

          {next ? (
            <button style={ui.btnPrimary} disabled={busy} onClick={() => setStatus(next.to)}>
              {busy ? "..." : next.label}
            </button>
          ) : null}
        </div>
      </div>

      {loading ? <div style={ui.muted}>DUKE NGARKU…</div> : null}

      <RackLocationModal
        open={rackModal.open}
        busy={rackModal.busy}
        orderCode={meta.code}
        currentOrderId={row?.id || ""}
        subtitle={String(row?.status || "").toLowerCase() === "pastrim" ? "Përdor raftat ekzistuese të bazës dhe bëje GATI" : "Përdor raftat ekzistuese të bazës"}
        slotMap={rackModal.slotMap}
        selectedSlots={rackModal.selectedSlots}
        placeText={rackModal.placeText}
        onTextChange={(value) => setRackModal((prev) => ({ ...prev, placeText: value }))}
        onToggleSlot={toggleRackSlot}
        onClose={closeRackPicker}
        onClear={() => setRackModal((prev) => ({ ...prev, selectedSlots: [], placeText: "" }))}
        onSave={saveRackPicker}
        error={rackModal.error}
      />
    </div>
  );
}

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
  badgeRow: { marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" },
  infoBadge: { border: "1px solid rgba(0,0,0,0.08)", background: "#fafafa", borderRadius: 999, padding: "7px 10px", fontWeight: 800, fontSize: 12 },
  addrBox: { marginTop: 12, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, background: "#fafafa" },
  addrTitle: { fontWeight: 900, fontSize: 12, letterSpacing: 1.2, color: "#6b7280" },
  addrText: { marginTop: 6, fontWeight: 800, fontSize: 14 },
  actionsRow: { marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  iconBtn: { border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 12, padding: "8px 10px", fontWeight: 900, cursor: "pointer" },
  smallBtn: { border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 999, padding: "8px 10px", fontWeight: 900, cursor: "pointer", fontSize: 12 },
  sectionBox: { marginTop: 12, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, background: "#fafafa" },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: 8 },
  detailLabel: { fontWeight: 900, fontSize: 13 },
  detailValue: { color: "#374151", fontWeight: 700, fontSize: 13, textAlign: "right" },
  noteBox: { marginTop: 12, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, background: "#fafafa" },
  noteText: { marginTop: 8, whiteSpace: "pre-wrap", fontWeight: 700, fontSize: 14, color: "#111" },
  textarea: { width: "100%", marginTop: 8, borderRadius: 12, border: "1px solid rgba(0,0,0,0.10)", padding: 12, minHeight: 88, outline: "none", resize: "none", background: "#fff" },
  hr: { height: 1, background: "rgba(0,0,0,0.08)", margin: "14px 0" },
  footerRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  btnSoft: { flex: "1 1 160px", border: "1px solid rgba(0,0,0,0.10)", background: "#fff", borderRadius: 12, padding: "12px 10px", fontWeight: 900, cursor: "pointer" },
  btnPrimary: { flex: "1 1 180px", border: "1px solid #111", background: "#111", color: "#fff", borderRadius: 12, padding: "12px 10px", fontWeight: 900, cursor: "pointer" },
};

export default function TransportItemPage() {
  return (
    <Suspense fallback={null}>
      <TransportItemPageInner />
    </Suspense>
  );
}
