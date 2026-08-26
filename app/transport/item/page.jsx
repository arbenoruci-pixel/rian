"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter, useSearchParams } from "@/lib/routerCompat.jsx";
import RackLocationModal from "@/components/RackLocationModal";
import { fetchRackMapFromDb, normalizeRackSlots } from "@/lib/rackLocations";
import { getTransportSession } from "@/lib/transportAuth";
import { getActor } from '@/lib/actorSession';
import { fetchTransportOrderById, fetchTransportOrderByCode, isTransportOrderPaymentBlocked, updateTransportOrderById } from "@/lib/transportOrdersDb";
import { supabase } from "@/lib/supabaseClient";
import { buildSmsLink, normalizePhoneForWhatsApp } from "@/lib/smartSms";

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
  const s = String(row?.client_tcode || row?.data?.transport_client_tcode || row?.data?.client_tcode || row?.data?.client?.transport_client_tcode || row?.data?.client?.tcode || row?.code_str || row?.data?.code_str || row?.data?.order_code || row?.data?.order_tcode || row?.data?.official_order_code || row?.order_code || row?.code || "").trim();
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
    row?.data?.client_phone ||
    row?.data?.client?.phone ||
    row?.data?.phone ||
    "";
  return normalizePhoneForWhatsApp(p);
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


// HOME_SEARCH_QUERY_AUTHORITY_TRANSPORT_GUARD_V4
function isPlainNumericRouteValue(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function baseStatusRoute(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'gati') return '/gati';
  if (['dorzim', 'dorezim', 'dorëzim', 'dorzuar', 'dorezuar', 'delivered', 'delivery', 'marrje', 'completed', 'kompletuar'].includes(value)) return '/marrje-sot';
  return '/pastrimi';
}

function buildBaseGuardHref(order) {
  const id = String(order?.id || '').trim();
  const code = String(order?.code ?? order?.client_code ?? '').replace(/^#+/, '').trim();
  const params = new URLSearchParams();
  if (code) params.set('q', code);
  if (code) params.set('openCode', code);
  if (id) params.set('openId', id);
  params.set('exact', '1');
  params.set('from', 'transport_numeric_guard');
  return baseStatusRoute(order?.status) + '?' + params.toString();
}

async function findBaseOrderForNumericTransportLink({ id, code }) {
  let row = null;
  const numericId = isPlainNumericRouteValue(id) ? Number(id) : null;
  const numericCode = isPlainNumericRouteValue(code) ? Number(code) : null;

  if (Number.isFinite(numericId) && numericId > 0) {
    const byId = await supabase.from('orders').select('id,code,client_code,status,updated_at').eq('id', numericId).limit(1).maybeSingle();
    if (byId?.error) throw byId.error;
    if (byId?.data) row = byId.data;
  }

  if (!row && Number.isFinite(numericCode) && numericCode > 0) {
    const byCode = await supabase
      .from('orders')
      .select('id,code,client_code,status,updated_at')
      .eq('code', numericCode)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byCode?.error) throw byCode.error;
    if (byCode?.data) row = byCode.data;
  }

  return row;
}

function nextForStatus(st) {
  const s = String(st || "").toLowerCase();
  if (["dispatched", "assigned", "new", "inbox", "pranim", "accepted"].includes(s)) return { label: "PRANO", to: "pickup" };
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
      // A Transport order is identified by a UUID or an explicit T-code. Plain
      // numbers belong to BASE. This destination-side guard protects users even
      // when an older cached Home bundle sends a stale /transport/item link.
      if (isPlainNumericRouteValue(id) || isPlainNumericRouteValue(codeParam)) {
        const baseOrder = await findBaseOrderForNumericTransportLink({ id, code: codeParam });
        if (baseOrder) {
          const href = buildBaseGuardHref(baseOrder);
          try {
            localStorage.setItem('tepiha_transport_numeric_guard_last_v1', JSON.stringify({
              at: new Date().toISOString(),
              id,
              codeParam,
              baseOrderId: baseOrder.id,
              baseCode: baseOrder.code,
              baseStatus: baseOrder.status,
              href,
            }));
          } catch {}
          router.replace(href);
          return;
        }
        setRow(null);
        setErr("KODI PA T I TAKON BAZËS. KËRKOJE NGA HOME ME NUMËR; TRANSPORTI KËRKON T-CODE.");
        return;
      }

      const t = id ? await fetchTransportOrderById(id) : await fetchTransportOrderByCode(codeParam);
      if (t) {
        // TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:ITEM
        if (isTransportOrderPaymentBlocked(t)) throw new Error('TRANSPORT_ORDER_CANCELLED');
        setRow({ ...t, __src: "transport_orders" });
        return;
      }
      setRow(null);
      setErr("NUK U GJET NË TRANSPORT");
    } catch (e) {
      setRow(null);
      setErr(
        String(e?.message || e) === 'TRANSPORT_ORDER_CANCELLED'
          ? 'POROSIA ËSHTË E ANULUAR. KRIJO NJË VIZITË TË RE; MOS REGJISTRO PAGESË NË KËTË POROSI.'
          : (e?.message || "GABIM")
      );
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
   