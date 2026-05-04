"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { getOrderTable } from "@/lib/orderSource";
import { createOrderRecord, listMixedOrderRecords, updateOrderData, updateOrderRecord } from "@/lib/ordersService";
import { listUsers } from "@/lib/usersDb";
import { bootLog, bootMarkReady } from "@/lib/bootLog";
import { getActor } from "@/lib/actorSession";
import { supabase } from "@/lib/supabaseClient";
import { reserveTransportCode } from "@/lib/transportCodes";
import { findTransportClientByPhoneOnly, isValidTransportPhoneDigits, normTCode, normalizeTransportPhoneKey, sameTransportPhoneDigits, upsertTransportClient } from "@/lib/transport/transportDb";

const TAB_TODAY = "today";
const TAB_TOMORROW = "tomorrow";
const TAB_ONLINE = "online";
const TAB_PHONE = "phone";
const TAB_UPDATES = "updates";
const TAB_CANCELLED = "cancelled";

const DISPATCH_LOAD_LIMIT_ORDERS = 96;
const DISPATCH_LOAD_LIMIT_TRANSPORT = 160;
const DISPATCH_SEARCH_LIMIT_ORDERS = 120;
const DISPATCH_SEARCH_LIMIT_TRANSPORT = 140;

const SLOT_OPTIONS = [
  { value: "morning", label: "PARADITE", window: "09:00 – 13:00" },
  { value: "evening", label: "MBRËMJE", window: "18:00 – 21:00" },
];

const DISPATCH_TIMELINE_STEPS = [
  "PA PLAN",
  "PRANUAR NGA SHOFERI",
  "NË RRUGË PËR PICKUP",
  "U MOR TE KLIENTI",
  "U SHKARKUA NË BAZË",
  "NË PASTRIM / NË BAZË",
  "U BË GATI",
  "NË DËRGESË / PICKUP KTHIMI",
  "U DORËZUA TE KLIENTI",
];

function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}
function s(v) {
  return String(v ?? "").trim();
}
function up(v) {
  return s(v).toUpperCase();
}


const TRANSPORT_PRE_PICKUP_STATUSES = new Set(["", "new", "inbox", "pending", "scheduled", "draft", "pranim", "dispatched", "assigned", "accepted"]);
const DISPATCH_CANCELLED_STATUSES = new Set(["cancelled", "canceled", "anuluar", "annulled", "void", "deleted", "removed"]);
const DISPATCH_CANCEL_VISIBLE_MS = 24 * 60 * 60 * 1000;

function rawStatus(value) {
  return s(value).toLowerCase();
}

function canAssignRewriteTransportStatus(currentStatus) {
  return TRANSPORT_PRE_PICKUP_STATUSES.has(rawStatus(currentStatus));
}

function resolveAssignPlanStatus(currentStatus, hasDriver) {
  const current = rawStatus(currentStatus);
  if (!canAssignRewriteTransportStatus(current)) return undefined;
  return hasDriver ? "assigned" : "inbox";
}

const DISPATCH_ACCESS_ROLES = new Set(["DISPATCH", "ADMIN", "ADMIN_MASTER", "OWNER", "PRONAR", "SUPERADMIN"]);

function canAccessDispatch(actor) {
  return DISPATCH_ACCESS_ROLES.has(up(actor?.role));
}
function toLocalYmd(input) {
  try {
    const d = input ? new Date(input) : new Date();
    if (!Number.isFinite(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  } catch {
    return "";
  }
}
function addDaysYmd(baseYmd, days) {
  try {
    const d = new Date(`${baseYmd}T12:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    return toLocalYmd(d);
  } catch {
    return baseYmd;
  }
}
function uiDate(ymd) {
  try {
    if (!ymd) return "-";
    return new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return ymd || "-";
  }
}
function niceDate(v) {
  try {
    if (!v) return "-";
    return new Date(v).toLocaleString();
  } catch {
    return "-";
  }
}
function getClientName(row) {
  return s(row?.client_name || row?.data?.client?.name || row?.data?.client_name || row?.data?.name || row?.name);
}
function getClientPhone(row) {
  return onlyDigits(row?.client_phone || row?.data?.client?.phone || row?.data?.client_phone || row?.data?.phone || row?.phone || "");
}
function getAddress(row) {
  return s(
    row?.address ||
      row?.pickup_address ||
      row?.delivery_address ||
      row?.data?.address ||
      row?.data?.pickup_address ||
      row?.data?.delivery_address ||
      row?.data?.client?.address ||
      row?.data?.location ||
      ""
  );
}
function getOrderCode(row) {
  return s(row?.client_tcode || row?.tcode || row?.code_str || row?.data?.client_tcode || row?.data?.client?.tcode || row?.data?.client?.code || row?.data?.code_str || row?.code || row?.data?.code || row?.id);
}
function getTransportClientId(row) {
  return s(row?.client_id || row?.data?.client_id || row?.data?.client?.id || (row?.source === "transport_clients" ? row?.id : ""));
}
function getTransportTCode(row) {
  return normTCode(row?.client_tcode || row?.tcode || row?.code_str || row?.data?.client_tcode || row?.data?.client?.tcode || row?.data?.client?.code || "");
}
function getTransportClientSource(row) {
  return s(row?.source || row?._table || row?.data?.source || "");
}
function getDispatchPhoneDigits(value) {
  return normalizeTransportPhoneKey(value);
}
async function ensureDispatchTransportClientLink({ name, phone, address, existingPhoneClient, tcodeOwner }) {
  const cleanName = s(name);
  const cleanPhone = onlyDigits(phone);
  const phoneDigits = getDispatchPhoneDigits(cleanPhone);

  if (!isValidTransportPhoneDigits(phoneDigits)) {
    throw new Error("TELEFONI NUK ËSHTË VALID. SHKRUAJ NUMËR ME SË PAKU 8 SHIFRA.");
  }

  let liveClient = null;
  try {
    liveClient = await findTransportClientByPhoneOnly(cleanPhone, { timeoutMs: 5500 });
  } catch (error) {
    throw new Error(`NUK U VERIFIKUA KLIENTI ME TELEFON. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
  }

  const selectedClient = liveClient && dispatchSamePhone(getClientPhone(liveClient) || liveClient?.phone_digits || liveClient?.phone, cleanPhone)
    ? liveClient
    : (existingPhoneClient && dispatchSamePhone(getClientPhone(existingPhoneClient) || existingPhoneClient?.phone_digits || existingPhoneClient?.phone, cleanPhone) ? existingPhoneClient : null);

  let clientId = selectedClient ? getTransportClientId(selectedClient) : "";
  let tcode = selectedClient ? getTransportTCode(selectedClient) : "";

  if (!tcode) {
    try {
      tcode = normTCode(await reserveTransportCode(tcodeOwner || "DISPATCH", { oid: `dispatch_${Date.now()}` }));
    } catch (error) {
      throw new Error(`NUK U REZERVUA T-CODE. POROSIA NUK U RUAJT. ${error?.message || ''}`.trim());
    }
  }

  if (!tcode) {
    throw new Error("NUK U GJET / KRIJUA T-CODE. POROSIA NUK U RUAJT.");
  }

  const upsertResult = await upsertTransportClient({
    ...(clientId ? { id: clientId } : {}),
    name: cleanName,
    phone: cleanPhone,
    phone_digits: phoneDigits,
    tcode,
    address: s(address),
  });

  if (!upsertResult?.ok || !(upsertResult?.id || clientId)) {
    throw new Error(upsertResult?.error || "TRANSPORT_CLIENT_LINK_FAILED");
  }

  const linkedTcode = normTCode(upsertResult?.tcode || tcode);
  const linkedClientId = upsertResult?.id || clientId;
  if (!linkedClientId || !linkedTcode) {
    throw new Error("TRANSPORT_CLIENT_LINK_INCOMPLETE");
  }

  return {
    clientId: linkedClientId,
    tcode: linkedTcode,
    name: cleanName,
    phone: cleanPhone,
    phoneDigits,
    source: getTransportClientSource(selectedClient) || "transport_clients",
    rowId: selectedClient?.row_id || selectedClient?.id || null,
  };
}
function dispatchSamePhone(a, b) {
  return sameTransportPhoneDigits(a, b);
}
function looksLikeTransportCode(value) {
  return /^T[\s-]*\d+/i.test(s(value));
}
function isDispatchTransportRow(row) {
  if (!row) return false;
  const table = getOrderTable(row);
  if (table === "transport_orders" || row?._table === "transport_orders") return true;
  if (looksLikeTransportCode(getOrderCode(row))) return true;

  const markers = [
    row?.kind,
    row?.type,
    row?.source,
    row?.order_table,
    row?.table,
    row?.__src,
    row?.data?.kind,
    row?.data?.type,
    row?.data?.source,
    row?.data?.order_table,
    row?.data?.table,
    row?.data?.order_origin,
    row?.data?.source_table,
  ];
  return markers.some((marker) => up(marker).includes("TRANSPORT"));
}
function keepDispatchTransportOnly(rows) {
  return mergeById(Array.isArray(rows) ? rows : []).filter(isDispatchTransportRow);
}
function shouldHideDispatchCode(row) {
  if (isDispatchTransportRow(row)) return false;
  const source = rowSource(row);
  if (source !== 'online') return false;
  return row?.data?.defer_dispatch_code !== false;
}
function getDispatchCardCode(row) {
  if (shouldHideDispatchCode(row)) return 'ONLINE';
  return getOrderCode(row) || 'T-NEW';
}
function normalizeStatus(v) {
  const x = s(v).toLowerCase();
  if (["new", "inbox", "pranim", "dispatched", "assigned"].includes(x)) return "PA PLAN";
  if (x === "accepted" || x === "pranuar" || x === "pranu") return "PRANUAR";
  if (x === "pickup") return "PICKUP";
  if (["delivery", "dorzim", "dorëzim", "dorezim", "dorezuar", "dorëzuar", "dorzuar", "marrje"].includes(x)) return "DORZIM";
  if (["failed", "deshtuar", "dështuar", "parealizuar", "no_show", "noshow", "returned", "kthim"].includes(x)) return "DËSHTUAR";
  if (DISPATCH_CANCELLED_STATUSES.has(x)) return "ANULUAR";
  if (x === "loaded" || x === "ngarkim" || x === "ngarkuar") return "NGARKIM";
  if (x === "gati") return "GATI";
  if (x === "done") return "DONE";
  return up(v || "-");
}
function orderAssignedDriver(o) {
  return String(o?.actor || o?.data?.actor || o?.driver_name || o?.data?.driver_name || o?.data?.transport_name || "").trim();
}
function rowSource(row) {
  const rawSource = s(
    row?.source ||
    row?.data?.source ||
    row?.data?.order_origin ||
    row?.order_origin ||
    ''
  ).toLowerCase();

  const isOnline = [
    'online',
    'online_web',
    'facebook_web',
    'web_online',
    'public_form',
  ].includes(rawSource);

  if (isOnline) return 'online';
  if (["phone", "dispatch", "manual"].includes(rawSource)) return "phone";
  if (row?._table === "transport_orders") return "phone";
  return "base";
}
function sourceLabel(row) {
  if (isDispatchTransportRow(row)) return "TRANSPORT";
  const src = rowSource(row);
  if (src === "online") return "ONLINE";
  if (src === "phone") return "TELEFONATË";
  return row?._table === "orders" ? "BAZË" : "TRANSPORT";
}
function rowPickupDate(row) {
  return (
    s(row?.pickup_date) ||
    s(row?.data?.pickup_date) ||
    s(row?.data?.schedule_date) ||
    s(row?.data?.planned_date) ||
    (row?.data?.reschedule_at ? toLocalYmd(row.data.reschedule_at) : "") ||
    toLocalYmd(row?.updated_at || row?.created_at)
  );
}
function rowPickupSlot(row) {
  const raw = s(row?.pickup_slot || row?.data?.pickup_slot || row?.data?.pickup_window || row?.data?.schedule_slot).toLowerCase();
  if (raw.includes("09") || raw.includes("13") || raw.includes("paradite") || raw === "morning") return "morning";
  if (raw.includes("18") || raw.includes("21") || raw.includes("mbr") || raw === "evening") return "evening";
  return "";
}
function slotWindow(slot) {
  const found = SLOT_OPTIONS.find((x) => x.value === slot);
  return found?.window || "-";
}
function rowPlanningBucket(row) {
  return s(row?.planning_bucket || row?.data?.planning_bucket || row?.data?.schedule_bucket).toLowerCase();
}
function lastTs(row) {
  return Date.parse(row?.updated_at || row?.created_at || row?.data?.assigned_at || 0) || 0;
}
function mergeById(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = `${getOrderTable(row) || "x"}:${row?.id || Math.random()}`;
    const prev = map.get(key);
    const prevTs = lastTs(prev);
    const nextTs = lastTs(row);
    if (!prev || nextTs >= prevTs) map.set(key, row);
  });
  return Array.from(map.values());
}
function isDispatchRemovedRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return !!(
    data.dispatch_removed ||
    data.dispatch_hidden ||
    data.dispatch_archived ||
    data.deleted_from_dispatch ||
    data.soft_deleted
  );
}
function isCancelledRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(row?.status || data.status || data.dispatch_status || "");
  return DISPATCH_CANCELLED_STATUSES.has(raw) || !!(data.cancelled || data.canceled || data.cancelled_at || data.canceled_at);
}
function cancelledAtMs(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = data.cancelled_at || data.canceled_at || data.dispatch_removed_at || data.failed_at || data.unsuccessful_at || row?.updated_at || row?.created_at;
  const ms = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}
function isRecentDispatchCancellation(row) {
  if (!row) return false;
  if (!(isCancelledRow(row) || isFailedRow(row) || isDispatchRemovedRow(row))) return false;
  const ms = cancelledAtMs(row);
  if (!ms) return false;
  return Date.now() - ms <= DISPATCH_CANCEL_VISIBLE_MS;
}
function cancelReason(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return s(data.cancellation_reason || data.cancel_reason || data.dispatch_removed_reason || data.failed_note || data.reason || data.unsuccess_reason || data.note || "PA ARSYE");
}
function cancelActor(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return s(data.cancelled_by || data.dispatch_removed_by || data.transport_name || data.driver_name || data.actor || "-");
}
function cancelSource(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const explicit = s(data.cancellation_source);
  if (explicit) return up(explicit);
  if (data.dispatch_removed_by || data.dispatch_removed_at || data.dispatch_hidden) return "DISPATCH";
  return up(data.source || sourceLabel(row));
}
function isFailedRow(row) {
  const st = normalizeStatus(row?.status || row?.data?.status || "");
  if (st === "DËSHTUAR") return true;
  return !!(row?.data?.failed || row?.data?.unsuccessful || row?.data?.not_done || row?.data?.rejected_delivery);
}
function isCompletedRow(row) {
  const st = normalizeStatus(row?.status || row?.data?.status || "");
  return ["DONE", "GATI", "ANULUAR"].includes(st) || isFailedRow(row) || isDispatchRemovedRow(row);
}
function canDispatchRemoveRow(row) {
  if (!isDispatchTransportRow(row)) return false;
  if (isDoneDispatchRow(row)) return false;
  if (isDispatchRemovedRow(row) || isCancelledRow(row) || isFailedRow(row)) return true;
  return TRANSPORT_PRE_PICKUP_STATUSES.has(rawStatus(row?.status || row?.data?.status || ""));
}

const DISPATCH_DONE_STATUSES = new Set([
  "done",
  "delivered",
  "dorzuar",
  "dorezuar",
  "dorëzuar",
]);

function isDoneDispatchRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = String(row?.status || data.status || "").trim().toLowerCase();

  return (
    DISPATCH_DONE_STATUSES.has(raw) ||
    !!data.done_at ||
    !!data.delivered_at ||
    !!data.customer_delivered_at ||
    !!data.delivery_done_at
  );
}

function doneDateYmd(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return toLocalYmd(
    data.done_at ||
      data.delivered_at ||
      data.customer_delivered_at ||
      data.delivery_done_at ||
      row?.updated_at ||
      row?.created_at
  );
}

function isDoneToday(row) {
  if (!isDoneDispatchRow(row)) return false;
  return doneDateYmd(row) === toLocalYmd(new Date());
}

function isLiveBoardRow(row) {
  if (!isDispatchTransportRow(row)) return false;
  if (isDispatchRemovedRow(row) || isCancelledRow(row) || isFailedRow(row)) return false;

  if (isDoneDispatchRow(row)) {
    return isDoneToday(row);
  }

  return true;
}
function transportStageIndex(row) {
  const data = (row?.data && typeof row.data === "object") ? row.data : {};
  const raw = s(row?.status || data.status || data.transport_status || data.dispatch_status).toLowerCase();
  const marker = [raw, s(data.step), s(data.stage), s(data.driver_stage), s(data.timeline_status)].join(" ").toLowerCase();

  if (data.delivered_at || data.customer_delivered_at || data.delivery_done_at || ["done", "delivered", "dorezuar", "dorzuar", "dorëzuar"].includes(raw)) return 8;
  if (data.return_started_at || data.delivery_started_at || ["delivery", "dorzim", "dorëzim", "dorezim", "marrje", "kthim", "return", "returning"].includes(raw)) return 7;
  if (data.ready_at || raw === "gati") return 6;
  if (data.base_processing_at || data.pastrim_started_at || ["pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë"].includes(raw)) return 5;
  if (data.unloaded_at || data.base_unloaded_at || marker.includes("shkark")) return 4;
  if (data.picked_up_at || data.loaded_at || ["loaded", "ngarkim", "ngarkuar"].includes(raw)) return 3;
  if (data.pickup_started_at || data.on_way_pickup_at || raw === "pickup" || marker.includes("pickup")) return 2;
  if (data.accepted_at || data.driver_accepted_at || ["accepted", "pranuar", "pranu"].includes(raw)) return 1;
  return 0;
}
function transportStageLabel(row) {
  return DISPATCH_TIMELINE_STEPS[transportStageIndex(row)] || DISPATCH_TIMELINE_STEPS[0];
}
function timelineStyle(idx, current) {
  if (idx < current) return ui.timelineDone;
  if (idx === current) return ui.timelineNow;
  return ui.timelinePending;
}
function formatMoney(v) {
  const n = Number(v || 0);
  return `€${n.toFixed(2)}`;
}
function getTotals(row) {
  const pieces = Number(row?.pieces ?? row?.data?.pieces ?? row?.data?.totals?.pieces ?? 0) || 0;
  const m2 = Number(row?.m2_total ?? row?.data?.m2_total ?? row?.data?.totals?.m2_total ?? row?.data?.totals?.m2 ?? 0) || 0;
  const total = Number(row?.price_total ?? row?.data?.price_total ?? row?.data?.totals?.grandTotal ?? row?.data?.totals?.total ?? row?.data?.totals?.euro ?? 0) || 0;
  return { pieces, m2, total };
}
function sameCustomer(a, b) {
  const p1 = getClientPhone(a);
  const p2 = getClientPhone(b);
  if (p1 && p2 && p1 === p2) return true;
  const n1 = up(getClientName(a));
  const n2 = up(getClientName(b));
  const a1 = up(getAddress(a));
  const a2 = up(getAddress(b));
  return !!n1 && !!n2 && n1 === n2 && (!!a1 ? a1 === a2 : true);
}

function DispatchCard({ row, onOpen }) {
  const code = getDispatchCardCode(row);
  const driver = orderAssignedDriver(row);
  const planningDate = rowPickupDate(row);
  const planningSlot = rowPickupSlot(row);
  return (
    <button type="button" onClick={() => onOpen(row)} style={ui.orderCardBtn}>
      <div style={ui.orderCard}>
        <div style={ui.codePill}>{code}</div>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 6 }}>
          <div style={ui.compactTop}>
            <div style={{ minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" }}>
              <span style={ui.compactName}>{up(getClientName(row) || "PA EMËR")}</span>
              <span style={ui.badge}>{sourceLabel(row)}</span>
              <span style={normalizeStatus(row?.status) === "DORZIM" ? ui.badgeWarn : ui.badgeOk}>{normalizeStatus(row?.status || row?.data?.status || "-")}</span>
            </div>
            <span style={ui.compactTime}>{planningDate ? uiDate(planningDate) : niceDate(row.updated_at || row.created_at)}</span>
          </div>
          <div style={ui.compactSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
          <div style={ui.planRow}>
            <span style={ui.badgeGhost}>{planningDate ? uiDate(planningDate) : "PA DATË"}</span>
            <span style={ui.badgeGhost}>{planningSlot ? slotWindow(planningSlot) : "PA SLOT"}</span>
            {driver ? <span style={ui.driverChip}>👷 {driver}</span> : <span style={ui.badgeGhost}>PA SHOFER</span>}
            <span style={ui.stageBadge}>{transportStageLabel(row)}</span>
          </div>
          <div style={ui.timelineWrap} aria-label="Transport timeline">
            {DISPATCH_TIMELINE_STEPS.map((step, idx) => (
              <span key={step} style={timelineStyle(idx, transportStageIndex(row))}>{idx + 1}. {step}</span>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <span style={ui.compactOpen}>HAP ➔</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function CancellationRow({ row, onOpen }) {
  const code = getDispatchCardCode(row);
  return (
    <div style={ui.cancelCard}>
      <div style={ui.cancelTop}>
        <div style={ui.cancelCode}>{code}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={ui.cancelName}>{up(getClientName(row) || "PA EMËR")}</div>
          <div style={ui.cancelSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
        </div>
        <span style={ui.badgeBad}>{isFailedRow(row) ? "DËSHTUAR" : "ANULUAR"}</span>
      </div>
      <div style={ui.cancelReason}>ARSYE: {up(cancelReason(row))}</div>
      <div style={ui.cancelMeta}>
        <span>{niceDate(cancelledAtMs(row))}</span>
        <span>BURIMI: {cancelSource(row)}</span>
        <span>NGA: {up(cancelActor(row))}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" style={ui.btnGhostMini} onClick={() => onOpen(row)}>HAP</button>
      </div>
    </div>
  );
}

function DispatchAccessScreen({ checking = false }) {
  return (
    <div style={ui.accessPage}>
      <div style={ui.accessCard}>
        <div style={ui.accessTitle}>{checking ? "DUKE KONTROLLUAR QASJEN" : "NUK KENI QASJE NË DISPATCH"}</div>
        <div style={ui.accessSub}>{checking ? "Ju lutem prisni." : "Ky modul hapet vetëm për DISPATCH / ADMIN."}</div>
        <Link href="/" prefetch={false} style={ui.accessBtn}>KTHEHU NË HOME</Link>
      </div>
    </div>
  );
}

export default function DispatchPage() {
  const todayYmd = useMemo(() => toLocalYmd(new Date()), []);
  const tomorrowYmd = useMemo(() => addDaysYmd(toLocalYmd(new Date()), 1), []);

  const [activeTab, setActiveTab] = useState(TAB_TODAY);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [drivers, setDrivers] = useState([]);
  const [driverId, setDriverId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [allRows, setAllRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [crmQuery, setCrmQuery] = useState("");
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmOpen, setCrmOpen] = useState(false);
  const [crmHits, setCrmHits] = useState([]);
  const [phoneHit, setPhoneHit] = useState(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [planMode, setPlanMode] = useState("today");
  const [customDate, setCustomDate] = useState(todayYmd);
  const [slot, setSlot] = useState("morning");
  const [selectedRow, setSelectedRow] = useState(null);
  const [editDate, setEditDate] = useState(todayYmd);
  const [editSlot, setEditSlot] = useState("morning");
  const [editDriver, setEditDriver] = useState("");
  const [editNote, setEditNote] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusyId, setDeleteBusyId] = useState("");
  const [searchTimer, setSearchTimer] = useState(null);
  const phoneTimer = useRef(null);
  const uiReadyMarkedRef = useRef(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const [accessAllowed, setAccessAllowed] = useState(false);
  const [liveMode, setLiveMode] = useState("POLL");
  const realtimeTimerRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const refreshAccess = () => {
      const actor = getActor() || null;
      const allowed = canAccessDispatch(actor);
      if (!alive) return;
      setAccessAllowed(allowed);
      setAccessChecked(true);
      try { bootLog(allowed ? "dispatch_access_allowed" : "dispatch_access_denied", { role: actor?.role || "", hasPin: !!actor?.pin }); } catch {}
    };
    refreshAccess();
    try { window.addEventListener("tepiha:session-changed", refreshAccess); } catch {}
    try { window.addEventListener("storage", refreshAccess); } catch {}
    return () => {
      alive = false;
      try { window.removeEventListener("tepiha:session-changed", refreshAccess); } catch {}
      try { window.removeEventListener("storage", refreshAccess); } catch {}
    };
  }, []);

  useEffect(() => {
    const markReady = (source = "dispatch_first_paint") => {
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      const path = typeof window !== "undefined" ? String(window.location?.pathname || "/dispatch") : "/dispatch";
      try { bootLog("ui_ready", { page: "dispatch", path, source }); } catch {}
      try { bootMarkReady({ page: "dispatch", path, source }); } catch {}
      try { window.__TEPIHA_UI_READY = true; } catch {}
    };

    let raf1 = 0;
    let raf2 = 0;
    let timer = 0;

    try {
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => markReady("dispatch_first_paint"));
      });
      timer = window.setTimeout(() => markReady("dispatch_ready_fallback"), 1800);
    } catch {
      markReady("dispatch_ready_sync_fallback");
    }

    return () => {
      try { if (raf1) window.cancelAnimationFrame(raf1); } catch {}
      try { if (raf2) window.cancelAnimationFrame(raf2); } catch {}
      try { if (timer) window.clearTimeout(timer); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    (async () => {
      const res = await listUsers();
      if (res?.ok) {
        const ds = (res.items || []).filter((u) => {
          const roleOk = String(u.role || "").toUpperCase() === "TRANSPORT";
          const hybridOk = u?.is_hybrid_transport === true;
          const activeOk = u?.is_active !== false;
          return activeOk && (roleOk || hybridOk);
        });
        setDrivers(ds);
        if (ds.length === 1) setDriverId(String(ds[0].id));
      }
    })();
  }, [accessChecked, accessAllowed]);

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const merged = keepDispatchTransportOnly(
        await listMixedOrderRecords({
          tables: ["transport_orders"],
          byTable: {
            transport_orders: { orderBy: "updated_at", ascending: false, limit: DISPATCH_LOAD_LIMIT_TRANSPORT },
          },
        })
      );
      setAllRows(merged);
    } catch {
      setAllRows([]);
    } finally {
      setLoadingRows(false);
    }
  }, []);

  async function getSearchRows() {
    if (Array.isArray(allRows) && allRows.length) return keepDispatchTransportOnly(allRows);
    return keepDispatchTransportOnly(
      await listMixedOrderRecords({
        tables: ["transport_orders"],
        byTable: {
          transport_orders: { orderBy: "updated_at", ascending: false, limit: DISPATCH_SEARCH_LIMIT_TRANSPORT },
        },
      })
    );
  }

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    const t = setTimeout(() => loadRows(), 350);
    return () => clearTimeout(t);
  }, [accessChecked, accessAllowed, loadRows]);

  useEffect(() => {
    if (!accessChecked || !accessAllowed) return undefined;
    let channel = null;
    let pollTimer = 0;
    const scheduleLiveRefresh = (delay = 450) => {
      try { if (realtimeTimerRef.current) window.clearTimeout(realtimeTimerRef.current); } catch {}
      try { realtimeTimerRef.current = window.setTimeout(() => loadRows(), delay); } catch {}
    };

    try {
      if (supabase && typeof supabase.channel === "function") {
        channel = supabase
          .channel("dispatch-transport-live-v2")
          .on("postgres_changes", { event: "*", schema: "public", table: "transport_orders" }, () => scheduleLiveRefresh(350))
          .subscribe((status) => {
            if (String(status || "").toUpperCase() === "SUBSCRIBED") setLiveMode("REALTIME");
          });
      }
    } catch {
      setLiveMode("POLL");
    }

    pollTimer = window.setInterval(() => {
      try { if (document?.visibilityState === "hidden") return; } catch {}
      loadRows();
    }, 20000);

    return () => {
      try { if (realtimeTimerRef.current) window.clearTimeout(realtimeTimerRef.current); } catch {}
      try { if (pollTimer) window.clearInterval(pollTimer); } catch {}
      try { if (channel && supabase?.removeChannel) supabase.removeChannel(channel); } catch {}
    };
  }, [accessChecked, accessAllowed, loadRows]);

  useEffect(() => {
    const digits = onlyDigits(phone);
    const phoneDigits = getDispatchPhoneDigits(digits);
    if (phoneTimer.current) clearTimeout(phoneTimer.current);
    if (!isValidTransportPhoneDigits(phoneDigits)) {
      setPhoneHit(null);
      return;
    }
    phoneTimer.current = setTimeout(async () => {
      setPhoneBusy(true);
      try {
        const hit = await findTransportClientByPhoneOnly(phone, { timeoutMs: 5500 }).catch(() => null);
        setPhoneHit(hit || null);
        if (hit && !s(name)) setName(getClientName(hit));
        if (hit && !s(address)) setAddress(getAddress(hit));
      } catch {
        setPhoneHit(null);
      } finally {
        setPhoneBusy(false);
      }
    }, 320);
    return () => {
      if (phoneTimer.current) clearTimeout(phoneTimer.current);
    };
  }, [phone]);

  useEffect(() => {
    if (searchTimer) clearTimeout(searchTimer);
    const q = s(crmQuery);
    if (q.length < 2) {
      setCrmHits([]);
      setCrmOpen(false);
      return;
    }
    const t = setTimeout(() => {
      runSmartSearch(q);
    }, 220);
    setSearchTimer(t);
    return () => clearTimeout(t);
  }, [crmQuery]);

  async function runSmartSearch(q) {
    setCrmBusy(true);
    try {
      const rows = await getSearchRows();
      const needle = q.toLowerCase();
      const digits = onlyDigits(q);
      const hits = rows.filter((row) => {
        const hay = [getClientName(row), getClientPhone(row), getAddress(row), getOrderCode(row)].join(" ").toLowerCase();
        if (hay.includes(needle)) return true;
        if (digits && getClientPhone(row).includes(digits)) return true;
        return false;
      });
      const dedup = [];
      const seen = new Set();
      for (const row of hits) {
        const key = `${getClientName(row)}|${getClientPhone(row)}|${getAddress(row)}`.toLowerCase();
        if (!getClientName(row) && !getClientPhone(row)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(row);
        if (dedup.length >= 8) break;
      }
      setCrmHits(dedup);
      setCrmOpen(dedup.length > 0);
    } catch {
      setCrmHits([]);
      setCrmOpen(false);
    } finally {
      setCrmBusy(false);
    }
  }

  function applySuggestion(row, options = {}) {
    setName(getClientName(row));
    setPhone(getClientPhone(row));
    setAddress(getAddress(row));
    setNote(s(row?.data?.note || row?.data?.client_note || note));
    setCrmQuery(getClientName(row) || getClientPhone(row));
    setCrmOpen(false);
    // Search manual mund të gjejë me emër/T-code/adresë.
    // Vendimi “klient ekzistues” vendoset vetëm nga lookup-u i telefonit më lart.
    if (options?.keepPhoneHit) setPhoneHit(row);
    else setPhoneHit(null);
  }


  const plannedDate = useMemo(() => {
    if (planMode === "tomorrow") return tomorrowYmd;
    if (planMode === "custom") return customDate || todayYmd;
    return todayYmd;
  }, [planMode, customDate, todayYmd, tomorrowYmd]);

  const dispatchRows = useMemo(() => keepDispatchTransportOnly(allRows), [allRows]);

  const daySlotCount = useMemo(() => {
    return dispatchRows.filter((row) => {
      if (isCompletedRow(row)) return false;
      return rowPickupDate(row) === plannedDate && rowPickupSlot(row) === slot;
    }).length;
  }, [dispatchRows, plannedDate, slot]);

  const dayTotalCount = useMemo(() => {
    return dispatchRows.filter((row) => {
      if (isCompletedRow(row)) return false;
      return rowPickupDate(row) === plannedDate;
    }).length;
  }, [dispatchRows, plannedDate]);

  const todayRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowPickupDate(row) === todayYmd)
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows, todayYmd]);

  const tomorrowRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowPickupDate(row) === tomorrowYmd)
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows, tomorrowYmd]);

  const onlineRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowSource(row) === "online")
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows]);

  const phoneRows = useMemo(() => {
    return dispatchRows
      .filter((row) => !isCompletedRow(row) && rowSource(row) === "phone")
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [dispatchRows]);

  const liveRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isLiveBoardRow(row))
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 50);
  }, [dispatchRows]);

  const failedRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isFailedRow(row) && !isDispatchRemovedRow(row) && !isCancelledRow(row))
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 20);
  }, [dispatchRows]);

  const cancellationRows = useMemo(() => {
    return dispatchRows
      .filter((row) => isRecentDispatchCancellation(row))
      .sort((a, b) => cancelledAtMs(b) - cancelledAtMs(a))
      .slice(0, 40);
  }, [dispatchRows]);

  const reschedules = useMemo(() => {
    const nowMs = Date.now();
    return dispatchRows
      .filter((r) => {
        const ra = r?.data?.reschedule_at || r?.data?.rescheduleAt || r?.data?.riplanifikim_at;
        const ms = ra ? Date.parse(String(ra)) : NaN;
        return Number.isFinite(ms) && ms > nowMs;
      })
      .sort((a, b) => lastTs(b) - lastTs(a))
      .slice(0, 20);
  }, [dispatchRows]);

  const tabCounts = useMemo(
    () => ({
      [TAB_TODAY]: todayRows.length,
      [TAB_TOMORROW]: tomorrowRows.length,
      [TAB_ONLINE]: onlineRows.length,
      [TAB_PHONE]: phoneRows.length,
      [TAB_UPDATES]: liveRows.length + failedRows.length + reschedules.length,
      [TAB_CANCELLED]: cancellationRows.length,
    }),
    [todayRows.length, tomorrowRows.length, onlineRows.length, phoneRows.length, liveRows.length, failedRows.length, reschedules.length, cancellationRows.length]
  );

  const canSend = useMemo(() => s(name).length >= 2 && isValidTransportPhoneDigits(getDispatchPhoneDigits(phone)), [name, phone]);

  async function send() {
    if (!canSend) {
      setErr("PLOTËSO EMRIN DHE TELEFON VALID");
      return;
    }
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const pickedDriver = drivers.find((d) => String(d?.id || "") === String(driverId || "")) || null;
      const pickedDriverName = String(pickedDriver?.name || pickedDriver?.full_name || "").trim();
      const pickedDriverPin = String(pickedDriver?.pin || pickedDriver?.user_pin || "").trim();
      const cleanName = s(name);
      const cleanPhone = onlyDigits(phone);
      const cleanAddress = s(address);
      const cleanNote = s(note);
      const existingPhoneClient = phoneHit && dispatchSamePhone(getClientPhone(phoneHit) || phoneHit?.phone_digits || phoneHit?.phone, cleanPhone) ? phoneHit : null;
      const actorNow = getActor() || null;
      const clientLink = await ensureDispatchTransportClientLink({
        name: cleanName,
        phone: cleanPhone,
        address: cleanAddress,
        existingPhoneClient,
        tcodeOwner: pickedDriverPin || String(actorNow?.pin || '').trim() || 'DISPATCH',
      });
      const payload = {
        status: driverId ? "assigned" : "inbox",
        client_id: clientLink.clientId,
        client_tcode: clientLink.tcode,
        code_str: clientLink.tcode,
        client_name: clientLink.name,
        client_phone: clientLink.phone,
        data: {
          client: {
            id: clientLink.clientId,
            tcode: clientLink.tcode,
            code: clientLink.tcode,
            name: clientLink.name,
            phone: clientLink.phone,
            phone_digits: clientLink.phoneDigits,
            address: cleanAddress,
          },
          client_id: clientLink.clientId,
          client_tcode: clientLink.tcode,
          code_str: clientLink.tcode,
          phone_digits: clientLink.phoneDigits,
          address: cleanAddress,
          note: cleanNote,
          created_by: "DISPATCH",
          source: "phone",
          pickup_date: plannedDate,
          pickup_slot: slot,
          pickup_window: slotWindow(slot),
          planning_bucket: planMode === "custom" ? "scheduled" : planMode,
          transport_id: driverId || null,
          transport_user_id: driverId || null,
          transport_name: pickedDriverName || null,
          transport_pin: pickedDriverPin || null,
          actor: pickedDriverName || pickedDriverPin || null,
          driver_name: pickedDriverName || null,
          driver_pin: pickedDriverPin || null,
          assigned_driver_id: driverId || null,
          assigned_at: new Date().toISOString(),
          last_customer_hit: {
            id: clientLink.clientId,
            tcode: clientLink.tcode,
            source: clientLink.source || "transport_clients",
            row_id: clientLink.rowId || null,
            matched_by: "phone_digits",
          },
        },
      };

      if (!payload.client_id || !payload.client_tcode || !payload.code_str || !payload.data?.client?.id || !payload.data?.client?.tcode) {
        throw new Error("TRANSPORT_CLIENT_LINK_INCOMPLETE");
      }

      await createOrderRecord("transport_orders", payload);
      setMsg("U DËRGUA ✅");
      setName("");
      setPhone("");
      setAddress("");
      setNote("");
      setCrmQuery("");
      setPhoneHit(null);
      await loadRows();
    } catch (e) {
      setErr(e?.message || "GABIM");
    } finally {
      setBusy(false);
    }
  }

  function openRow(row) {
    setSelectedRow(row);
    setEditDate(rowPickupDate(row) || todayYmd);
    setEditSlot(rowPickupSlot(row) || "morning");
    const pickedDriver = drivers.find((d) => String(d?.id || "") === String(row?.data?.transport_id || row?.data?.transport_user_id || ""));
    setEditDriver(String(pickedDriver?.id || row?.data?.transport_id || row?.data?.transport_user_id || ""));
    setEditNote(s(row?.data?.note || ""));
  }

  async function savePlan() {
    if (!selectedRow?.id) return;
    setSaveBusy(true);
    try {
      const rowTable = getOrderTable(selectedRow);
      if (!rowTable) throw new Error("Burimi i porosisë mungon.");
      const pickedDriver = drivers.find((d) => String(d?.id || "") === String(editDriver || "")) || null;
      const pickedDriverName = s(pickedDriver?.name || pickedDriver?.full_name);
      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);
      const nextData = {
        ...(selectedRow.data || {}),
        note: s(editNote),
        pickup_date: editDate,
        pickup_slot: editSlot,
        pickup_window: slotWindow(editSlot),
        planning_bucket: editDate === todayYmd ? "today" : editDate === tomorrowYmd ? "tomorrow" : "scheduled",
        transport_id: editDriver || null,
        transport_user_id: editDriver || null,
        transport_name: pickedDriverName || null,
        transport_pin: pickedDriverPin || null,
        actor: pickedDriverName || pickedDriverPin || null,
        driver_name: pickedDriverName || null,
        driver_pin: pickedDriverPin || null,
        assigned_driver_id: editDriver || null,
        assigned_at: new Date().toISOString(),
        defer_dispatch_code: false,
      };
      const currentStatus = selectedRow?.status || selectedRow?.data?.status || "";
      const nextStatus = rowTable === "transport_orders"
        ? resolveAssignPlanStatus(currentStatus, !!editDriver)
        : (editDriver ? "assigned" : "inbox");
      const planPatch = { updated_at: new Date().toISOString(), data: nextData };
      if (nextStatus) planPatch.status = nextStatus;
      await updateOrderRecord(rowTable, selectedRow.id, planPatch);
      setSelectedRow(null);
      await loadRows();
    } catch (e) {
      alert(e?.message || "Gabim gjatë ruajtjes.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function removeDispatchRow(row) {
    if (!row?.id) return;
    if (!canDispatchRemoveRow(row)) {
      alert("Kjo porosi nuk fshihet nga Dispatch në këtë fazë. Nëse puna ka nisur, përdor statuset operative që të mos humbin pagesat ose gjurmët.");
      return;
    }
    const code = getDispatchCardCode(row);
    const defaultReason = isFailedRow(row) ? "DËSHTOI / NUK U REALIZUA" : isCancelledRow(row) ? "ANULUAR" : "ANULUAR NGA DISPATCH";
    const reason = window.prompt(`ARSYEJA E FSHIRJES / ANULIMIT PËR ${code}`, defaultReason);
    if (reason === null) return;
    const cleanReason = s(reason) || defaultReason;
    const ok = window.confirm(`A je i sigurt që don me e heq këtë porosi nga Dispatch?\n\n${code} • ${up(getClientName(row) || "PA EMËR")}\nARSYE: ${cleanReason}\n\nKjo është soft-delete: porosia nuk fshihet nga DB, vetëm shënohet ANULUAR dhe largohet nga listat aktive.`);
    if (!ok) return;
    setDeleteBusyId(String(row.id));
    try {
      const rowTable = getOrderTable(row);
      if (!rowTable) throw new Error("Burimi i porosisë mungon.");
      const nowIso = new Date().toISOString();
      const actorNow = getActor() || null;
      const actorName = s(actorNow?.name || actorNow?.full_name || actorNow?.pin || actorNow?.role || "DISPATCH");
      const nextData = {
        ...(row.data || {}),
        status: "cancelled",
        cancelled: true,
        canceled: true,
        cancelled_at: nowIso,
        canceled_at: nowIso,
        cancellation_reason: cleanReason,
        cancel_reason: cleanReason,
        cancelled_by: actorName,
        cancellation_source: "DISPATCH",
        dispatch_removed: true,
        dispatch_hidden: true,
        dispatch_removed_at: nowIso,
        dispatch_removed_by: actorName,
        dispatch_removed_reason: cleanReason,
      };
      await updateOrderRecord(rowTable, row.id, {
        status: "cancelled",
        updated_at: nowIso,
        data: nextData,
      });
      if (selectedRow?.id === row.id) setSelectedRow(null);
      setAllRows((prev) => (Array.isArray(prev) ? prev.filter((x) => String(x?.id || "") !== String(row.id || "")) : prev));
      await loadRows();
    } catch (e) {
      alert(e?.message || "Gabim gjatë fshirjes/anulimit.");
    } finally {
      setDeleteBusyId("");
    }
  }

  async function setDispatchReschedule(row) {
    if (!row?.id) return;
    const date = prompt("RIPLANIFIKIM — DATA (YYYY-MM-DD)", rowPickupDate(row) || todayYmd);
    if (!date) return;
    const time = prompt("RIPLANIFIKIM — ORA (HH:MM)", rowPickupSlot(row) === "evening" ? "18:00" : "09:00");
    if (!time) return;
    const whenLocal = new Date(`${date}T${time}:00`);
    if (!Number.isFinite(whenLocal.getTime())) return alert("DATA/ORA jo valide.");
    const nextData = { ...(row.data || {}) };
    nextData.reschedule_at = whenLocal.toISOString();
    nextData.reschedule_by = "DISPATCH";
    nextData.pickup_date = date;
    nextData.pickup_slot = Number(String(time).slice(0, 2)) >= 17 ? "evening" : "morning";
    nextData.pickup_window = slotWindow(nextData.pickup_slot);
    try {
      await updateOrderData("transport_orders", row.id, () => nextData, { updated_at: new Date().toISOString() });
      await loadRows();
    } catch (error) {
      alert("Gabim: " + (error?.message || error));
    }
  }

  const currentRows = useMemo(() => {
    if (activeTab === TAB_TOMORROW) return tomorrowRows;
    if (activeTab === TAB_ONLINE) return onlineRows;
    if (activeTab === TAB_PHONE) return phoneRows;
    if (activeTab === TAB_CANCELLED) return cancellationRows;
    if (activeTab === TAB_TODAY) return todayRows;
    return [];
  }, [activeTab, todayRows, tomorrowRows, onlineRows, phoneRows, cancellationRows]);

  if (!accessChecked) return <DispatchAccessScreen checking />;
  if (!accessAllowed) return <DispatchAccessScreen />;

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div>
          <div style={ui.title}>DISPATCH</div>
          <div style={ui.sub}>TRANSPORT CONTROL TOWER • {liveMode === "REALTIME" ? "LIVE REALTIME" : "LIVE POLL 20s"}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/transport/board" style={ui.btnGhost}>TEREN</Link>
          <Link href="/" style={ui.btnGhost}>HOME</Link>
        </div>
      </div>

      <div style={ui.statsGrid}>
        <div style={ui.statCard}><div style={ui.statLabel}>SOT</div><div style={ui.statValue}>{tabCounts[TAB_TODAY]}</div></div>
        <div style={ui.statCard}><div style={ui.statLabel}>NESËR</div><div style={ui.statValue}>{tabCounts[TAB_TOMORROW]}</div></div>
        <div style={ui.statCard}><div style={ui.statLabel}>ONLINE</div><div style={ui.statValue}>{tabCounts[TAB_ONLINE]}</div></div>
        <div style={ui.statCard}><div style={ui.statLabel}>LIVE</div><div style={ui.statValue}>{tabCounts[TAB_UPDATES]}</div></div>
        <div style={ui.statCard}><div style={ui.statLabel}>ANULIME 24H</div><div style={ui.statValue}>{tabCounts[TAB_CANCELLED]}</div></div>
      </div>

      <div style={ui.card}>
        <div style={ui.sectionHeadRow}>
          <div style={ui.sectionTitle}>DISPATCH SMART CREATE</div>
          <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "REFRESH"}</button>
        </div>
        <div style={ui.sectionHint}>Telefonata, klientë që kthehen prap dhe planifikim për sot / nesër.</div>

        <div style={{ ...ui.field, marginBottom: 14, position: "relative" }}>
          <div style={ui.label}>SMART SEARCH (CRM)</div>
          <input
            style={ui.input}
            value={crmQuery}
            onChange={(e) => {
              setCrmQuery(e.target.value);
              setCrmOpen(true);
            }}
            placeholder="EMRI OSE TELI"
          />
          {crmBusy ? <div style={ui.mini}>DUKE KËRKUAR…</div> : null}
          {crmOpen && crmHits.length > 0 ? (
            <div style={ui.suggestBox}>
              {crmHits.map((row) => (
                <button key={`${getOrderTable(row)}_${row.id}`} type="button" style={ui.suggestItem} onClick={() => applySuggestion(row)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 900 }}>{up(getClientName(row) || "PA EMËR")}</div>
                    <div style={ui.badge}>{sourceLabel(row)}</div>
                  </div>
                  <div style={ui.suggestSub}>{getClientPhone(row) || "PA TEL"}</div>
                  <div style={ui.suggestSub}>{getAddress(row) || "PA ADRESË"}</div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div style={ui.row2}>
          <div style={ui.field}>
            <div style={ui.label}>EMRI</div>
            <input style={ui.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
          </div>
          <div style={ui.field}>
            <div style={ui.label}>TEL</div>
            <input style={ui.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+383..." inputMode="tel" />
            {phoneBusy ? <div style={ui.mini}>PO KONTROLLOJ KLIENTIN…</div> : null}
          </div>
        </div>

        {phoneHit ? (
          <div style={ui.crmHitBox}>
            <div style={ui.crmHitTitle}>KY KLIENT EKZISTON NË DB. A DON ME SHTU POROSI TË RE TE KY KLIENT?</div>
            <div style={ui.crmHitSub}>EMRI: {up(getClientName(phoneHit) || "PA EMËR")}</div>
            <div style={ui.crmHitSub}>TEL: {getClientPhone(phoneHit) || phoneHit?.phone_digits || "PA TEL"}</div>
            <div style={ui.crmHitSub}>T-CODE: {getTransportTCode(phoneHit) || "PA T-CODE"}</div>
            <div style={ui.crmHitSub}>ADRESA/GPS: {getAddress(phoneHit) || "PA ADRESË"}{phoneHit?.gps_lat && phoneHit?.gps_lng ? ` • ${phoneHit.gps_lat}, ${phoneHit.gps_lng}` : ""}</div>
            <div style={ui.crmHitSub}>BURIMI: {phoneHit?.source === "transport_clients" ? "TRANSPORT_CLIENTS" : "TRANSPORT ORDER HISTORY"} • {niceDate(phoneHit?.updated_at || phoneHit?.created_at)}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={ui.btnGhostMini} onClick={() => applySuggestion(phoneHit, { keepPhoneHit: true })}>PO, PËRDOR KËTË KLIENT</button>
              <button type="button" style={ui.btnGhostMini} onClick={() => setPhoneHit(null)}>JO, VAZHDO PA LIDHJE</button>
            </div>
          </div>
        ) : null}

        <div style={ui.field}>
          <div style={ui.label}>ADRESA</div>
          <input style={ui.input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="RRUGA / LAGJJA" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHËNIM</div>
          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>PLANIFIKIMI</div>
          <div style={ui.pillRow}>
            <button type="button" style={planMode === "today" ? ui.pillOn : ui.pillOff} onClick={() => setPlanMode("today")}>PËR SOT</button>
            <button type="button" style={planMode === "tomorrow" ? ui.pillOn : ui.pillOff} onClick={() => setPlanMode("tomorrow")}>PËR NESËR</button>
            <button type="button" style={planMode === "custom" ? ui.pillOn : ui.pillOff} onClick={() => setPlanMode("custom")}>DATË TJETËR</button>
          </div>
          {planMode === "custom" ? <input type="date" style={ui.input} value={customDate} onChange={(e) => setCustomDate(e.target.value)} /> : null}
          <div style={ui.pillRow}>
            {SLOT_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" style={slot === opt.value ? ui.pillOn : ui.pillOff} onClick={() => setSlot(opt.value)}>
                {opt.label} • {opt.window}
              </button>
            ))}
          </div>
          <div style={ui.capacityBox}>
            <div><strong>{uiDate(plannedDate)}</strong> • {slotWindow(slot)}</div>
            <div>{daySlotCount}/15 në slot • {dayTotalCount}/30 në ditë</div>
            {(daySlotCount >= 15 || dayTotalCount >= 30) ? <div style={ui.capacityWarn}>SLOTI/DITA ËSHTË FULL – DISPATCH MUND TË BËJË OVERRIDE</div> : null}
          </div>
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHOFERI</div>
          <select style={ui.input} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option style={ui.selectOption} value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
            {drivers.map((d) => (
              <option style={ui.selectOption} key={String(d.id)} value={String(d.id)}>{String(d.name || "TRANSPORT").toUpperCase()}</option>
            ))}
          </select>
        </div>

        {err ? <div style={ui.err}>{err}</div> : null}
        {msg ? <div style={ui.ok}>{msg}</div> : null}

        <button style={{ ...ui.btnPrimary, opacity: canSend && !busy ? 1 : 0.5 }} disabled={!canSend || busy} onClick={send}>
          {busy ? "DUKE DËRGU…" : "DËRGO"}
        </button>
      </div>

      <div style={ui.card}>
        <div style={ui.tabRow}>
          <button type="button" style={activeTab === TAB_TODAY ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_TODAY)}>SOT ({tabCounts[TAB_TODAY]})</button>
          <button type="button" style={activeTab === TAB_TOMORROW ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_TOMORROW)}>NESËR ({tabCounts[TAB_TOMORROW]})</button>
          <button type="button" style={activeTab === TAB_ONLINE ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_ONLINE)}>ONLINE ({tabCounts[TAB_ONLINE]})</button>
          <button type="button" style={activeTab === TAB_PHONE ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_PHONE)}>TELEFONATA ({tabCounts[TAB_PHONE]})</button>
          <button type="button" style={activeTab === TAB_UPDATES ? ui.tabOn : ui.tabOff} onClick={() => setActiveTab(TAB_UPDATES)}>LIVE ({tabCounts[TAB_UPDATES]})</button>
          <button type="button" style={activeTab === TAB_CANCELLED ? ui.tabDangerOn : ui.tabDangerOff} onClick={() => setActiveTab(TAB_CANCELLED)}>ANULIME 24H ({tabCounts[TAB_CANCELLED]})</button>
        </div>

        {activeTab === TAB_CANCELLED ? (
          <>
            <div style={ui.sectionHeadRow}>
              <div style={ui.sectionTitle}>ANULIME / DËSHTIME — 24 ORËT E FUNDIT</div>
              <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "REFRESH"}</button>
            </div>
            <div style={ui.sectionHint}>Këtu shihen porositë e anuluara nga Dispatch ose shoferi. Pas 24 orëve nuk shfaqen më në këtë listë, por mbeten të ruajtura në DB si audit.</div>
            {(cancellationRows?.length || 0) === 0 ? (
              <div style={ui.empty}>S'KA ANULIME NË 24 ORËT E FUNDIT.</div>
            ) : (
              <div style={ui.list}>
                {cancellationRows.map((row) => (
                  <CancellationRow key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                ))}
              </div>
            )}
          </>
        ) : activeTab !== TAB_UPDATES ? (
          <>
            <div style={ui.sectionHint}>
              {activeTab === TAB_ONLINE ? "Porositë që vijnë nga forma online." : activeTab === TAB_PHONE ? "Porositë që dispatch i fut manualisht nga telefonatat." : activeTab === TAB_TOMORROW ? "Planifikimi për nesër." : "Planifikimi për sot."}
            </div>
            {(currentRows?.length || 0) === 0 ? (
              <div style={ui.empty}>S'KA POROSI NË KËTË TAB.</div>
            ) : (
              <div style={ui.list}>
                {currentRows.map((row) => {
                  const removable = canDispatchRemoveRow(row);
                  const deleting = deleteBusyId === String(row?.id || "");
                  return (
                    <div key={`${getOrderTable(row)}_${row.id}`} style={{ display: "grid", gap: 8 }}>
                      <DispatchCard row={row} onOpen={openRow} />
                      {removable ? (
                        <div style={ui.inlineDangerRow}>
                          <div style={ui.inlineDangerHint}>Nëse porosia është anuluar, hajgare, ose dështoi me u marrë, largoje nga listat aktive pa e fshirë nga DB.</div>
                          <button type="button" style={ui.btnDangerMini} onClick={() => removeDispatchRow(row)} disabled={deleting}>
                            {deleting ? "DUKE HEQ…" : "FSHI POROSINË"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={ui.sectionHeadRow}>
              <div style={ui.sectionTitle}>LIVE TRANSPORT</div>
              <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "REFRESH"}</button>
            </div>
            <div style={ui.sectionHint}>Vetëm transport orders / T-codes. Përditësim: {liveMode === "REALTIME" ? "Supabase realtime" : "refresh i lehtë çdo 20 sekonda"}.</div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>AKTIVITET</div>
              {(liveRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA AKTIVITET.</div> : <div style={ui.list}>{liveRows.map((row) => <DispatchCard key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />)}</div>}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>POROSITË E DËSHTUARA</div>
              {(failedRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA TË DËSHTUARA.</div> : (
                <div style={ui.list}>
                  {failedRows.map((row) => (
                    <div key={`${getOrderTable(row)}_${row.id}`} style={{ ...ui.compactRow, border: "1px solid rgba(239,68,68,0.22)", background: "linear-gradient(180deg, rgba(239,68,68,0.07), rgba(239,68,68,0.03))" }}>
                      <div style={ui.compactCode}>{getOrderCode(row) || "T-NEW"}</div>
                      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
                        <div style={ui.compactTop}>
                          <div style={{ minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" }}>
                            <span style={ui.compactName}>{up(getClientName(row) || "PA EMËR")}</span>
                            <span style={ui.badgeBad}>DËSHTUAR</span>
                          </div>
                          <span style={ui.compactTime}>{niceDate(row.updated_at || row.created_at)}</span>
                        </div>
                        <div style={ui.compactSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
                        <div style={ui.compactSub}>ARSYE: {up(row?.data?.failed_note || row?.data?.reason || row?.data?.unsuccess_reason || "PA SHËNIM")}</div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" style={ui.btnGhostMini} onClick={() => openRow(row)}>HAP</button>
                          <button type="button" style={ui.btnDangerMini} onClick={() => removeDispatchRow(row)} disabled={deleteBusyId === String(row?.id || "")}>
                            {deleteBusyId === String(row?.id || "") ? "DUKE HEQ…" : "FSHI NGA DISPATCH"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>RIPLANIFIKIME</div>
              {(reschedules?.length || 0) === 0 ? <div style={ui.empty}>S'KA RIPLANIFIKIME.</div> : (
                <div style={ui.list}>
                  {reschedules.map((r) => (
                    <div key={`${getOrderTable(r)}_${r.id}`} style={ui.compactRow}>
                      <div style={ui.compactCode}>{getOrderCode(r) || "T-NEW"}</div>
                      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
                        <div style={ui.compactTop}>
                          <div style={{ minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" }}>
                            <span style={ui.compactName}>{up(getClientName(r) || "PA EMËR")}</span>
                            <span style={ui.badgeWarn}>RIPLAN</span>
                          </div>
                          <span style={ui.compactTime}>{niceDate(r?.data?.reschedule_at)}</span>
                        </div>
                        <div style={ui.compactSub}>{getClientPhone(r) || "PA TEL"} • {getAddress(r) || "PA ADRESË"}</div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                          <button type="button" style={ui.btnGhostMini} onClick={() => openRow(r)}>HAP</button>
                          <button type="button" style={ui.btnGhostMini} onClick={() => setDispatchReschedule(r)}>NDËRRO ORARIN</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {selectedRow ? (
        <div style={ui.modalOverlay} onClick={() => setSelectedRow(null)}>
          <div style={ui.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={ui.sectionHeadRow}>
              <div>
                <div style={ui.sectionTitle}>{up(getClientName(selectedRow) || "PA EMËR")}</div>
                <div style={ui.sectionHint}>{getClientPhone(selectedRow) || "PA TEL"} • {getAddress(selectedRow) || "PA ADRESË"}</div>
              </div>
              <button type="button" style={ui.btnGhostMini} onClick={() => setSelectedRow(null)}>MBYLLE</button>
            </div>

            <div style={ui.timelineWrap}>
              {DISPATCH_TIMELINE_STEPS.map((step, idx) => (
                <span key={step} style={timelineStyle(idx, transportStageIndex(selectedRow))}>{idx + 1}. {step}</span>
              ))}
            </div>

            <div style={ui.field}>
              <div style={ui.label}>DATA</div>
              <input type="date" style={ui.input} value={editDate} onChange={(e) => setEditDate(e.target.value)} />
            </div>
            <div style={ui.field}>
              <div style={ui.label}>SLOTI</div>
              <div style={ui.pillRow}>
                {SLOT_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" style={editSlot === opt.value ? ui.pillOn : ui.pillOff} onClick={() => setEditSlot(opt.value)}>
                    {opt.label} • {opt.window}
                  </button>
                ))}
              </div>
            </div>
            <div style={ui.field}>
              <div style={ui.label}>SHOFERI</div>
              <select style={ui.input} value={editDriver} onChange={(e) => setEditDriver(e.target.value)}>
                <option style={ui.selectOption} value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
                {drivers.map((d) => (
                  <option style={ui.selectOption} key={String(d.id)} value={String(d.id)}>{up(d.name || "TRANSPORT")}</option>
                ))}
              </select>
            </div>
            <div style={ui.field}>
              <div style={ui.label}>SHËNIM</div>
              <textarea style={ui.textarea} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="OPSIONALE" />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={{ ...ui.btnPrimary, flex: 1 }} onClick={savePlan} disabled={saveBusy}>{saveBusy ? "DUKE RUAJT…" : "RUAJ PLANIN"}</button>
              {canDispatchRemoveRow(selectedRow) ? (
                <button
                  type="button"
                  style={ui.btnDanger}
                  onClick={() => removeDispatchRow(selectedRow)}
                  disabled={deleteBusyId === String(selectedRow?.id || "")}
                >
                  {deleteBusyId === String(selectedRow?.id || "") ? "DUKE HEQ…" : "FSHI POROSINË"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ui = {
  accessPage: { minHeight: "100vh", background: "#070b14", color: "#fff", padding: 16, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" },
  accessCard: { width: "min(420px, 100%)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", padding: 18, boxShadow: "0 18px 40px rgba(0,0,0,0.28)", display: "grid", gap: 12, textAlign: "center", boxSizing: "border-box" },
  accessTitle: { fontSize: 18, fontWeight: 1000, letterSpacing: 0.2 },
  accessSub: { fontSize: 13, fontWeight: 800, color: "rgba(255,255,255,0.72)" },
  accessBtn: { height: 46, borderRadius: 14, background: "#fff", color: "#070b14", display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontWeight: 1000, marginTop: 4 },
  page: { minHeight: "100vh", background: "#f5f5f7", color: "#111", padding: 16, width: "100%", maxWidth: "100vw", overflowX: "hidden", boxSizing: "border-box" },
  top: { maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", boxSizing: "border-box" },
  title: { fontSize: 18, fontWeight: 900 },
  sub: { fontSize: 12, opacity: 0.7 },
  card: { maxWidth: 960, width: "100%", margin: "14px auto 0", background: "#fff", borderRadius: 18, border: "1px solid rgba(0,0,0,0.08)", padding: 14, boxShadow: "0 10px 24px rgba(0,0,0,0.06)", boxSizing: "border-box", overflow: "hidden" },
  statsGrid: { maxWidth: 960, width: "100%", margin: "14px auto 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 10, boxSizing: "border-box" },
  statCard: { background: "#fff", borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", padding: 12, boxShadow: "0 8px 18px rgba(0,0,0,0.04)", minWidth: 0, boxSizing: "border-box" },
  statLabel: { fontSize: 11, fontWeight: 900, opacity: 0.65 },
  statValue: { fontSize: 28, fontWeight: 1000, lineHeight: 1.1, marginTop: 4 },
  row2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, minWidth: 0 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, minWidth: 0, maxWidth: "100%" },
  label: { fontSize: 12, fontWeight: 900, opacity: 0.75 },
  input: { height: 44, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: "0 12px", fontWeight: 800, outline: "none", width: "100%", maxWidth: "100%", background: "#fff", color: "#111", WebkitTextFillColor: "#111", caretColor: "#111", boxSizing: "border-box" },
  textarea: { minHeight: 70, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: 12, fontWeight: 800, outline: "none", background: "#fff", color: "#111", WebkitTextFillColor: "#111", caretColor: "#111", width: "100%", maxWidth: "100%", boxSizing: "border-box" },
  selectOption: { background: "#fff", color: "#111" },
  btnGhost: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "10px 12px", borderRadius: 12, fontWeight: 900, textDecoration: "none", color: "#111" },
  btnGhostMini: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "8px 10px", borderRadius: 10, fontWeight: 900, color: "#111", cursor: "pointer" },
  btnPrimary: { height: 48, borderRadius: 14, border: "none", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer", padding: "0 16px" },
  btnDanger: { height: 48, borderRadius: 14, border: "1px solid rgba(185,28,28,0.18)", background: "rgba(185,28,28,0.08)", color: "#991b1b", fontWeight: 1000, cursor: "pointer", padding: "0 16px" },
  btnDangerMini: { height: 38, borderRadius: 12, border: "1px solid rgba(185,28,28,0.18)", background: "rgba(185,28,28,0.08)", color: "#991b1b", fontWeight: 1000, cursor: "pointer", padding: "0 14px", whiteSpace: "nowrap" },
  err: { background: "#fff1f1", border: "1px solid rgba(255,0,0,0.2)", color: "#b00020", padding: 10, borderRadius: 12, fontWeight: 800, marginBottom: 10 },
  ok: { background: "#eefbf0", border: "1px solid rgba(0,160,80,0.25)", color: "#0b6a2b", padding: 10, borderRadius: 12, fontWeight: 900, marginBottom: 10 },
  mini: { fontSize: 11, fontWeight: 800, opacity: 0.65, marginTop: 6 },
  suggestBox: { position: "absolute", left: 0, right: 0, top: 78, background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 14, boxShadow: "0 14px 28px rgba(0,0,0,0.08)", zIndex: 20, overflow: "hidden" },
  suggestItem: { width: "100%", textAlign: "left", background: "#fff", border: "none", borderBottom: "1px solid rgba(0,0,0,0.06)", padding: 12, cursor: "pointer" },
  suggestSub: { fontSize: 12, opacity: 0.72, marginTop: 3 },
  badge: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(0,0,0,0.12)", background: "rgba(0,0,0,0.04)" },
  badgeOk: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(0,160,80,0.2)", background: "rgba(16,185,129,0.12)", color: "#0b6a2b" },
  badgeWarn: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(245,158,11,0.25)", background: "rgba(245,158,11,0.12)", color: "#8a5a00" },
  badgeBad: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.12)", color: "#b00020" },
  badgeGhost: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(0,0,0,0.10)", background: "rgba(0,0,0,0.03)" },
  sectionTitle: { fontWeight: 900, marginBottom: 8 },
  sectionHint: { fontSize: 12, opacity: 0.7, marginBottom: 10 },
  sectionHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap", minWidth: 0 },
  empty: { fontWeight: 800, opacity: 0.75 },
  list: { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" },
  compactRow: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, padding: 10, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 8px 18px rgba(0,0,0,0.05)", boxSizing: "border-box", overflow: "hidden" },
  compactTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0, width: "100%" },
  compactName: { minWidth: 0, maxWidth: "100%", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 900, letterSpacing: 0.2 },
  compactSub: { minWidth: 0, maxWidth: "100%", fontSize: 13, opacity: 0.72, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  compactTime: { fontSize: 11, opacity: 0.6, fontWeight: 900, whiteSpace: "nowrap", flexShrink: 0 },
  compactOpen: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 74, height: 32, padding: "0 12px", borderRadius: 999, background: "linear-gradient(180deg, rgba(59,130,246,0.16), rgba(37,99,235,0.10))", border: "1px solid rgba(96,165,250,0.24)", color: "#1d4ed8", fontSize: 11, fontWeight: 900, letterSpacing: 0.3, flexShrink: 0 },
  codePill: { width: 46, minWidth: 46, height: 46, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: "#39d86f", color: "#03140a", fontSize: 14, fontWeight: 1000, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)" },
  driverChip: { display: "inline-flex", alignItems: "center", gap: 4, justifySelf: "start", borderRadius: 12, padding: "4px 8px", background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.22)", color: "#2563eb", fontSize: 11, fontWeight: 900 },
  orderCardBtn: { display: "block", width: "100%", maxWidth: "100%", minWidth: 0, border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", boxSizing: "border-box", overflow: "hidden" },
  orderCard: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, padding: 12, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 8px 18px rgba(0,0,0,0.05)", background: "#fff", boxSizing: "border-box", overflow: "hidden" },
  tabRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, minWidth: 0, maxWidth: "100%" },
  tabOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(17,24,39,0.18)", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(0,0,0,0.12)", background: "#fff", color: "#111", fontWeight: 900, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, minWidth: 0, maxWidth: "100%" },
  pillOn: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(17,24,39,0.18)", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillOff: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(0,0,0,0.12)", background: "#fff", color: "#111", fontWeight: 900, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  capacityBox: { borderRadius: 14, border: "1px solid rgba(0,0,0,0.08)", background: "rgba(0,0,0,0.03)", padding: 10, fontSize: 12, fontWeight: 800, display: "grid", gap: 6, width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  capacityWarn: { color: "#8a5a00", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.22)", padding: 8, borderRadius: 10 },
  crmHitBox: { borderRadius: 14, border: "1px solid rgba(59,130,246,0.18)", background: "rgba(59,130,246,0.06)", padding: 12, marginBottom: 10 },
  crmHitTitle: { fontSize: 12, fontWeight: 1000, color: "#1d4ed8" },
  crmHitSub: { fontSize: 12, opacity: 0.8, marginTop: 4, fontWeight: 700 },
  planRow: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" },
  inlineDangerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", border: "1px solid rgba(185,28,28,0.10)", borderRadius: 14, padding: "10px 12px", background: "rgba(185,28,28,0.04)", width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  inlineDangerHint: { fontSize: 12, fontWeight: 800, color: "rgba(17,17,17,0.72)", flex: 1, minWidth: 180 },
  updateSection: { marginTop: 12, borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: 12 },
  stageBadge: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(37,99,235,0.24)", background: "rgba(59,130,246,0.12)", color: "#1d4ed8" },
  timelineWrap: { display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", minWidth: 0, maxWidth: "100%", marginTop: 2 },
  timelineDone: { fontSize: 10, fontWeight: 1000, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(16,185,129,0.22)", background: "rgba(16,185,129,0.12)", color: "#047857", lineHeight: 1.15 },
  timelineNow: { fontSize: 10, fontWeight: 1000, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(37,99,235,0.28)", background: "rgba(59,130,246,0.14)", color: "#1d4ed8", lineHeight: 1.15 },
  timelinePending: { fontSize: 10, fontWeight: 900, borderRadius: 999, padding: "4px 7px", border: "1px solid rgba(0,0,0,0.08)", background: "rgba(0,0,0,0.03)", color: "rgba(17,17,17,0.56)", lineHeight: 1.15 },
  tabDangerOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(185,28,28,0.28)", background: "#991b1b", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabDangerOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(185,28,28,0.22)", background: "rgba(185,28,28,0.08)", color: "#991b1b", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  cancelCard: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(185,28,28,0.18)", borderRadius: 16, padding: 12, display: "grid", gap: 8, background: "linear-gradient(180deg, rgba(254,242,242,0.95), rgba(255,255,255,0.96))", boxShadow: "0 8px 18px rgba(0,0,0,0.05)", boxSizing: "border-box", overflow: "hidden" },
  cancelTop: { display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, maxWidth: "100%" },
  cancelCode: { minWidth: 52, height: 42, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(185,28,28,0.10)", color: "#991b1b", fontSize: 13, fontWeight: 1000, border: "1px solid rgba(185,28,28,0.16)" },
  cancelName: { minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 1000 },
  cancelSub: { minWidth: 0, maxWidth: "100%", fontSize: 12, opacity: 0.72, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 800 },
  cancelReason: { borderRadius: 12, background: "rgba(185,28,28,0.07)", border: "1px solid rgba(185,28,28,0.10)", color: "#7f1d1d", padding: "8px 10px", fontSize: 12, fontWeight: 900 },
  cancelMeta: { display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, opacity: 0.68, fontWeight: 900 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.40)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 },
  modalCard: { width: "min(680px, 100%)", maxWidth: "100%", maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 18, border: "1px solid rgba(0,0,0,0.08)", padding: 16, boxShadow: "0 24px 48px rgba(0,0,0,0.18)", boxSizing: "border-box" },
};
