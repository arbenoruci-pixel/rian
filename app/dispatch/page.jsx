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

function finiteMoneyValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function moneyDash(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} €`;
}
function getPaymentInfo(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const pay = data?.pay && typeof data.pay === "object" ? data.pay : {};
  const totals = data?.totals && typeof data.totals === "object" ? data.totals : {};
  const payment = data?.payment && typeof data.payment === "object" ? data.payment : {};
  const paymentSnapshot = data?.payment_snapshot && typeof data.payment_snapshot === "object" ? data.payment_snapshot : {};
  const total = finiteMoneyValue(
    row?.price_total,
    row?.total_price,
    row?.total,
    data?.price_total,
    data?.total_price,
    data?.total,
    pay?.euro,
    pay?.total,
    totals?.grandTotal,
    totals?.grand_total,
    totals?.total,
    totals?.euro,
    payment?.total,
    paymentSnapshot?.total
  );
  let paid = finiteMoneyValue(
    row?.paid_amount,
    row?.paid_cash,
    row?.clientPaid,
    row?.paid,
    data?.paid_amount,
    data?.paid_cash,
    data?.clientPaid,
    data?.paid,
    pay?.paid,
    payment?.paid,
    payment?.amount_taken,
    paymentSnapshot?.amount_taken
  );
  let debt = finiteMoneyValue(
    row?.debt,
    row?.debt_remaining,
    data?.debt,
    data?.debt_remaining,
    pay?.debt,
    payment?.debt,
    payment?.debt_remaining,
    paymentSnapshot?.debt_remaining
  );
  if (debt === null && total !== null && paid !== null) debt = Math.max(0, Number((total - paid).toFixed(2)));
  if (paid === null && total !== null && debt !== null) paid = Math.max(0, Number((total - debt).toFixed(2)));
  return { total, paid, debt };
}
function getRowPieces(row) {
  const totals = getTotals(row);
  return totals.pieces || Number(row?.data?.qty || row?.data?.items_count || row?.data?.["copë"] || row?.data?.cope || 0) || 0;
}
function getScheduleText(row) {
  const date = rowPickupDate(row);
  const slot = rowPickupSlot(row);
  const slotText = slot ? slotWindow(slot) : "";
  if (date && slotText) return `${uiDate(date)} • ${slotText}`;
  if (date) return uiDate(date);
  if (slotText) return slotText;
  return "—";
}
function dispatchStatusLabel(rowOrStatus) {
  const row = typeof rowOrStatus === "object" ? rowOrStatus : null;
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(row ? (row?.status || data.status || data.transport_status || data.dispatch_status) : rowOrStatus);
  if (["assigned", "inbox", "new", "pranim", "dispatched", "scheduled", "pending", "draft", "accepted", "pranuar", "pranu"].includes(raw)) return "E PLANIFIKUAR";
  if (raw === "pickup") return "SHOFERI PO SHKON ME I MARRË";
  if (["loaded", "ngarkim", "ngarkuar"].includes(raw)) return "U MORËN, JANË RRUGËS PËR BAZË";
  if (["pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë"].includes(raw)) return "NË PASTRIM";
  if (raw === "gati") return "GATI PËR DORËZIM";
  if (["delivery", "dorzim", "dorëzim", "dorezim", "marrje", "kthim", "return", "returning"].includes(raw)) return "SHOFERI ËSHTË RRUGËS TE KLIENTI";
  if (["done", "delivered", "dorzuar", "dorezuar", "dorëzuar"].includes(raw)) return "E DORËZUAR";
  if (["ne_depo", "në_depo", "depo", "depot"].includes(raw)) return "NË DEPO";
  if (["cancelled", "canceled", "anuluar", "annulled", "void", "deleted", "removed"].includes(raw)) return "ANULUAR";
  if (["failed", "deshtuar", "dështuar", "parealizuar", "no_show", "noshow", "returned"].includes(raw)) return "DËSHTUAR";
  return normalizeStatus(raw || "-");
}
function shortStatusLabel(row) {
  const label = dispatchStatusLabel(row);
  if (label === "SHOFERI PO SHKON ME I MARRË") return "PICKUP";
  if (label === "U MORËN, JANË RRUGËS PËR BAZË") return "PËR BAZË";
  if (label === "SHOFERI ËSHTË RRUGËS TE KLIENTI") return "PËR KLIENT";
  return label;
}
function rowNeedsDriver(row) {
  return !s(orderAssignedDriver(row) || row?.data?.transport_name || row?.data?.driver_name || row?.data?.actor || row?.data?.transport_id || row?.data?.transport_user_id || row?.data?.assigned_driver_id);
}
function driverDisplayName(driver) {
  return up(driver?.name || driver?.full_name || driver?.username || driver?.pin || "SHOFER");
}
function driverStableId(driver) {
  return String(driver?.id || driver?.user_id || driver?.pin || driver?.user_pin || "").trim();
}
function driverStablePin(driver) {
  return String(driver?.pin || driver?.user_pin || driver?.transport_pin || "").trim();
}
function rowDriverTokens(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return [
    row?.driver_id,
    row?.driver_pin,
    row?.driver_name,
    row?.transport_id,
    row?.transport_pin,
    row?.transport_name,
    row?.assigned_driver_id,
    data.transport_id,
    data.transport_user_id,
    data.assigned_driver_id,
    data.driver_id,
    data.driver_pin,
    data.driver_name,
    data.transport_pin,
    data.transport_name,
    data.actor,
  ].map((x) => s(x)).filter(Boolean);
}
function rowMatchesDriver(row, driver) {
  if (!driver) return false;
  const id = driverStableId(driver);
  const pin = driverStablePin(driver);
  const name = driverDisplayName(driver);
  const tokens = rowDriverTokens(row);
  return tokens.some((token) => {
    const raw = String(token || "").trim();
    if (!raw) return false;
    if (id && raw === id) return true;
    if (pin && raw === pin) return true;
    return up(raw) === name;
  });
}
function isBaseSideRow(row) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const raw = rawStatus(row?.status || data.status || data.transport_status || data.dispatch_status || "");
  if (["loaded", "ngarkim", "ngarkuar", "pastrim", "pastrimi", "base", "in_base", "ne_baze", "në_bazë", "gati", "ne_depo", "në_depo", "depo", "depot"].includes(raw)) return true;
  const idx = transportStageIndex(row);
  return idx >= 3 && idx <= 6;
}
function rowHasDebt(row) {
  const pay = getPaymentInfo(row);
  if (pay.debt !== null) return Number(pay.debt) > 0.009;
  if (pay.total !== null && pay.paid !== null) return Number(pay.total) > Number(pay.paid) + 0.009;
  return false;
}
function isDepotRow(row) {
  const raw = rawStatus(row?.status || row?.data?.status || row?.data?.transport_status || row?.data?.dispatch_status || "");
  return ["ne_depo", "në_depo", "depo", "depot"].includes(raw);
}
function isReadyRow(row) {
  const raw = rawStatus(row?.status || row?.data?.status || row?.data?.transport_status || row?.data?.dispatch_status || "");
  return raw === "gati" || !!row?.data?.ready_at;
}
function commandSearchText(row) {
  return [
    getDispatchCardCode(row),
    getOrderCode(row),
    getTransportTCode(row),
    getClientName(row),
    getClientPhone(row),
    getAddress(row),
    row?.status,
    row?.data?.status,
    dispatchStatusLabel(row),
    orderAssignedDriver(row),
    rowPickupDate(row),
    rowPickupSlot(row),
  ].join(" ").toLowerCase();
}
function matchesCommandSearch(row, query) {
  const q = s(query).toLowerCase();
  if (!q) return true;
  const digits = onlyDigits(q);
  if (digits && getClientPhone(row).includes(digits)) return true;
  return commandSearchText(row).includes(q);
}
function matchesCommandFilter(row, filter) {
  if (!filter) return true;
  if (filter === "no_driver") return rowNeedsDriver(row);
  if (filter === "no_address") return !getAddress(row);
  if (filter === "depo") return isDepotRow(row);
  if (filter === "gati") return isReadyRow(row);
  if (filter === "debt") return rowHasDebt(row);
  if (filter === "done_today") return isDoneToday(row);
  return true;
}
function matchesCommandDriverFilter(row, filter, drivers) {
  if (!filter || filter === "all") return true;
  if (filter === "base") return isBaseSideRow(row);
  const driver = (drivers || []).find((d) => driverStableId(d) === String(filter));
  return rowMatchesDriver(row, driver);
}
function sortCommandRows(a, b, filter) {
  if (filter === "debt") return (rowHasDebt(b) ? 1 : 0) - (rowHasDebt(a) ? 1 : 0) || lastTs(b) - lastTs(a);
  if (filter === "gati") return transportStageIndex(a) - transportStageIndex(b) || lastTs(a) - lastTs(b);
  if (filter === "done_today") return lastTs(b) - lastTs(a);
  return lastTs(b) - lastTs(a);
}
function getCopyReplyText(row) {
  const pay = getPaymentInfo(row);
  const code = getDispatchCardCode(row);
  const name = getClientName(row) || "klient";
  const address = getAddress(row) || "—";
  const driver = orderAssignedDriver(row) || "—";
  const schedule = getScheduleText(row);
  return `Përshëndetje ${name},\nPorosia juaj ${code} është në statusin: ${dispatchStatusLabel(row)}.\nTotali është ${moneyDash(pay.total)}, paguar ${moneyDash(pay.paid)}, borxhi ${moneyDash(pay.debt)}.\nAdresa: ${address}.\nShoferi/orari: ${driver} ${schedule}.`;
}
function phoneHref(row) {
  const phone = getClientPhone(row);
  return phone ? `tel:${phone}` : "";
}
function whatsappHref(row) {
  const phone = getClientPhone(row);
  if (!phone) return "";
  const text = encodeURIComponent(getCopyReplyText(row));
  return `https://wa.me/${phone}?text=${text}`;
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
  const driver = orderAssignedDriver(row) || "PA SHOFER";
  const pay = getPaymentInfo(row);
  const pieces = getRowPieces(row);
  const address = getAddress(row);
  const status = shortStatusLabel(row);
  const hasPaymentInfo = [pay.total, pay.paid, pay.debt].some((value) => value !== null && value !== undefined);
  const piecesText = Number(pieces || 0) > 0 ? `${pieces} copë` : "COPË: PA REGJISTRUAR";
  return (
    <button type="button" onClick={() => onOpen(row)} style={ui.orderCardBtn}>
      <div style={ui.orderCard}>
        <div style={ui.codePill}>{code}</div>
        <div style={ui.cardBody}>
          <div style={ui.compactTop}>
            <div style={ui.cardNameWrap}>
              <span style={ui.compactName}>{up(getClientName(row) || "PA EMËR")}</span>
            </div>
            <span style={normalizeStatus(row?.status) === "DORZIM" ? ui.badgeWarn : ui.badgeOk}>{status}</span>
          </div>

          <div style={ui.cardLabel}>ADRESA</div>
          <div style={address ? ui.addressStrong : ui.addressWarn}>{address || "PA ADRESË"}</div>

          {hasPaymentInfo ? (
            <div style={ui.moneyGrid}>
              <div><span style={ui.moneyLabel}>TOTALI:</span> <strong>{moneyDash(pay.total)}</strong></div>
              <div><span style={ui.moneyLabel}>PAGUAR:</span> <strong>{moneyDash(pay.paid)}</strong></div>
              <div><span style={rowHasDebt(row) ? ui.debtStrong : ui.moneyLabel}>BORXH:</span> <strong>{moneyDash(pay.debt)}</strong></div>
            </div>
          ) : (
            <div style={ui.moneyLine}><span style={ui.moneyLabel}>TOTALI:</span> <strong>PA LLOGARITUR</strong></div>
          )}

          <div style={ui.cardFooterRow}>
            <span style={ui.compactSub}>{piecesText}{hasPaymentInfo && pay.total !== null ? ` • ${moneyDash(pay.total)}` : ""}</span>
            <span style={ui.compactSub}>Shoferi: {driver}</span>
            <span style={ui.compactSub}>Orari: {getScheduleText(row)}</span>
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandFilter, setCommandFilter] = useState("");
  const [commandDriverFilter, setCommandDriverFilter] = useState("all");
  const [copyMsg, setCopyMsg] = useState("");
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

  function prefillCreateFromCommandSearch() {
    const q = s(commandQuery);
    if (!q) return;
    const digits = onlyDigits(q);
    if (digits.length >= 7) {
      setPhone(digits);
      setCrmQuery(digits);
    } else if (looksLikeTransportCode(q)) {
      setCrmQuery(q);
      setNote((prev) => s(prev) || `Kërkuar nga dispatch: ${q}`);
    } else {
      setName((prev) => s(prev) || q);
      setCrmQuery(q);
    }
    setMsg("SEARCH U KALUA TE SMART CREATE ✅");
    window.setTimeout(() => setMsg(""), 2200);
  }

  const plannedDate = useMemo(() => {
    if (planMode === "tomorrow") return tomorrowYmd;
    if (planMode === "custom") return customDate || todayYmd;
    return todayYmd;
  }, [planMode, customDate, todayYmd, tomorrowYmd]);

  const dispatchRows = useMemo(() => keepDispatchTransportOnly(allRows), [allRows]);

  const quickFilters = useMemo(() => ([
    { key: "no_driver", label: "PA SHOFER", count: dispatchRows.filter((row) => !isCompletedRow(row) && rowNeedsDriver(row)).length },
    { key: "no_address", label: "PA ADRESË", count: dispatchRows.filter((row) => !isCompletedRow(row) && !getAddress(row)).length },
    { key: "depo", label: "DEPO", count: dispatchRows.filter((row) => !isCompletedRow(row) && isDepotRow(row)).length },
    { key: "gati", label: "GATI", count: dispatchRows.filter((row) => !isCompletedRow(row) && isReadyRow(row)).length },
    { key: "debt", label: "BORXH", count: dispatchRows.filter((row) => rowHasDebt(row)).length },
    { key: "done_today", label: "DORËZUAR SOT", count: dispatchRows.filter((row) => isDoneToday(row)).length },
  ]), [dispatchRows]);

  const commandDriverFilters = useMemo(() => {
    const activeRows = dispatchRows.filter((row) => !isCompletedRow(row));
    return [
      { key: "all", label: "TË GJITHA", count: activeRows.length },
      { key: "base", label: "BAZA", count: activeRows.filter((row) => isBaseSideRow(row)).length },
      ...drivers.map((driver) => {
        const key = driverStableId(driver);
        return {
          key,
          label: driverDisplayName(driver),
          count: activeRows.filter((row) => rowMatchesDriver(row, driver)).length,
        };
      }).filter((x) => !!x.key),
    ];
  }, [dispatchRows, drivers]);

  const commandActive = s(commandQuery).length > 0 || !!commandFilter || commandDriverFilter !== "all";
  const commandRows = useMemo(() => {
    if (!commandActive) return [];
    return dispatchRows
      .filter((row) => matchesCommandSearch(row, commandQuery))
      .filter((row) => matchesCommandFilter(row, commandFilter))
      .filter((row) => matchesCommandDriverFilter(row, commandDriverFilter, drivers))
      .sort((a, b) => sortCommandRows(a, b, commandFilter))
      .slice(0, 50);
  }, [dispatchRows, commandQuery, commandFilter, commandDriverFilter, drivers, commandActive]);

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

  async function copyReply(row) {
    const text = getCopyReplyText(row);
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyMsg("PËRGJIGJJA U KOPJUA ✅");
      window.setTimeout(() => setCopyMsg(""), 2200);
    } catch {
      setCopyMsg("NUK U KOPJUA — PROVO PRAP");
      window.setTimeout(() => setCopyMsg(""), 2200);
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

  const showCommandDetails = commandOpen || commandActive;
  const activeQuickFilterLabel = quickFilters.find((filter) => filter.key === commandFilter)?.label || "";
  const activeDriverFilterLabel = commandDriverFilters.find((filter) => String(filter.key) === String(commandDriverFilter))?.label || "TË GJITHA";

  function toggleCommandPanel() {
    const next = !commandOpen;
    setCommandOpen(next);
    if (next) {
      setCreateOpen(false);
      setLiveOpen(false);
    }
  }

  function toggleCreatePanel() {
    const next = !createOpen;
    setCreateOpen(next);
    if (next) {
      setCommandOpen(false);
      setLiveOpen(false);
    }
  }

  function toggleLivePanel() {
    const next = !liveOpen;
    setLiveOpen(next);
    if (next) {
      setCommandOpen(false);
      setCreateOpen(false);
    }
  }

  const selectedPay = selectedRow ? getPaymentInfo(selectedRow) : { total: null, paid: null, debt: null };
  const selectedPhone = selectedRow ? getClientPhone(selectedRow) : "";
  const selectedPhoneLink = selectedRow ? phoneHref(selectedRow) : "";
  const selectedWhatsappLink = selectedRow ? whatsappHref(selectedRow) : "";
  const selectedTransportHref = selectedRow?.id ? `/transport/board` : "/transport/board";

  if (!accessChecked) return <DispatchAccessScreen checking />;
  if (!accessAllowed) return <DispatchAccessScreen />;

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div style={ui.headerLeft}>
          <div style={ui.title}>DISPATCH</div>
          <button type="button" style={ui.liveChip} onClick={toggleLivePanel}>
            {liveMode === "REALTIME" ? "LIVE REALTIME" : "LIVE 20s"} {liveOpen ? "▴" : "▾"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/transport/board" style={ui.btnGhost}>TEREN</Link>
          <Link href="/" style={ui.btnGhost}>HOME</Link>
        </div>
      </div>

      <div style={ui.statsStrip}>
        <button type="button" style={activeTab === TAB_TODAY ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_TODAY)}>SOT <strong>{tabCounts[TAB_TODAY]}</strong></button>
        <button type="button" style={activeTab === TAB_TOMORROW ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_TOMORROW)}>NESËR <strong>{tabCounts[TAB_TOMORROW]}</strong></button>
        <button type="button" style={activeTab === TAB_ONLINE ? ui.statChipOn : ui.statChip} onClick={() => setActiveTab(TAB_ONLINE)}>ONLINE <strong>{tabCounts[TAB_ONLINE]}</strong></button>
        <button type="button" style={liveOpen ? ui.statChipOn : ui.statChip} onClick={toggleLivePanel}>LIVE <strong>{tabCounts[TAB_UPDATES]}</strong></button>
        <button type="button" style={activeTab === TAB_CANCELLED ? ui.statChipDangerOn : ui.statChipDanger} onClick={() => setActiveTab(TAB_CANCELLED)}>ANULIME <strong>{tabCounts[TAB_CANCELLED]}</strong></button>
      </div>

      <div style={ui.commandCard}>
        <div style={ui.field}>
          <div style={ui.searchHeadRow}>
            <div>
              <div style={ui.label}>KËRKO KLIENTIN</div>
              <div style={ui.searchHint}>Tel / T-code / emër / adresë</div>
            </div>
            <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "↻"}</button>
          </div>
          <input
            style={ui.commandInput}
            value={commandQuery}
            onChange={(e) => setCommandQuery(e.target.value)}
            placeholder="Tel / T-code / emër / adresë"
            inputMode="search"
          />
        </div>

        <div style={ui.topActions}>
          <button type="button" style={showCommandDetails ? ui.topActionOn : ui.topActionOff} onClick={toggleCommandPanel}>COMMAND {showCommandDetails ? "▴" : "▾"}</button>
          <button type="button" style={createOpen ? ui.topActionOn : ui.topActionOff} onClick={toggleCreatePanel}>+ SMART CREATE</button>
          <button type="button" style={liveOpen ? ui.topActionOn : ui.topActionOff} onClick={toggleLivePanel}>{liveMode === "REALTIME" ? "LIVE" : "LIVE 20s"} {liveOpen ? "▴" : "▾"}</button>
        </div>

        {showCommandDetails ? (
          <div style={ui.commandDetails}>
            <div style={ui.compactToggleRow}>
              <button type="button" style={ui.panelToggle} onClick={() => setDriversOpen(!driversOpen)}>
                Shoferë/Baza: {activeDriverFilterLabel} {driversOpen ? "▴" : "▾"}
              </button>
              <button type="button" style={ui.panelToggle} onClick={() => setAdvancedFiltersOpen(!advancedFiltersOpen)}>
                Advanced filters{activeQuickFilterLabel ? `: ${activeQuickFilterLabel}` : ""} {advancedFiltersOpen ? "▴" : "▾"}
              </button>
              {(commandFilter || commandDriverFilter !== "all" || s(commandQuery)) ? (
                <button type="button" style={ui.panelToggleDanger} onClick={() => { setCommandQuery(""); setCommandFilter(""); setCommandDriverFilter("all"); }}>PASTRO</button>
              ) : null}
            </div>

            {driversOpen ? (
              <div style={ui.smartChipRow}>
                {commandDriverFilters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    style={commandDriverFilter === filter.key ? ui.smartChipOn : ui.smartChipOff}
                    onClick={() => setCommandDriverFilter(filter.key)}
                  >
                    <span>{filter.label}</span>
                    <strong>{filter.count}</strong>
                  </button>
                ))}
              </div>
            ) : null}

            {advancedFiltersOpen ? (
              <div style={ui.quickChipRow}>
                {quickFilters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    style={commandFilter === filter.key ? ui.quickChipOn : ui.quickChipOff}
                    onClick={() => setCommandFilter(commandFilter === filter.key ? "" : filter.key)}
                  >
                    <span>{filter.label}</span>
                    <strong>{filter.count}</strong>
                  </button>
                ))}
              </div>
            ) : null}

            {commandActive ? (
              <div style={ui.commandResults}>
                <div style={ui.sectionHeadRow}>
                  <div style={ui.sectionTitle}>REZULTATET ({commandRows.length})</div>
                </div>
                {commandRows.length === 0 ? (
                  <div style={ui.emptyBox}>
                    <div>NUK U GJET KLIENT. HAPE + SMART CREATE PËR POROSI TË RE.</div>
                    {s(commandQuery) ? <button type="button" style={ui.btnGhostMini} onClick={() => { prefillCreateFromCommandSearch(); setCreateOpen(true); setCommandOpen(false); }}>KRIJO ME KËTË SEARCH</button> : null}
                  </div>
                ) : (
                  <div style={ui.list}>
                    {commandRows.map((row) => (
                      <DispatchCard key={`command_${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={ui.sectionHint}>Shkruaj tel/T-code/emër/adresë ose hap një filter për me i nxjerrë rezultatet.</div>
            )}
          </div>
        ) : (
          <div style={ui.sectionHint}>Search-i qëndron gjithmonë hapur. Hape COMMAND për shoferë/bazë, filtra dhe rezultate të detajuara.</div>
        )}
      </div>

      {createOpen ? (
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
          <div style={ui.smartChipRow}>
            <button type="button" style={!driverId ? ui.smartChipOn : ui.smartChipOff} onClick={() => setDriverId("")}>BAZA / PA SHOFER</button>
            {drivers.map((d) => (
              <button
                key={`create_driver_${String(d.id)}`}
                type="button"
                style={String(driverId || "") === String(d.id || "") ? ui.smartChipOn : ui.smartChipOff}
                onClick={() => setDriverId(String(d.id || ""))}
              >
                {driverDisplayName(d)}
              </button>
            ))}
          </div>
          <select style={ui.input} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option style={ui.selectOption} value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
            {drivers.map((d) => (
              <option style={ui.selectOption} key={String(d.id)} value={String(d.id)}>{driverDisplayName(d)}</option>
            ))}
          </select>
        </div>

        {err ? <div style={ui.err}>{err}</div> : null}
        {msg ? <div style={ui.ok}>{msg}</div> : null}

        <button style={{ ...ui.btnPrimary, opacity: canSend && !busy ? 1 : 0.5 }} disabled={!canSend || busy} onClick={send}>
          {busy ? "DUKE DËRGU…" : "DËRGO"}
        </button>
      </div>
      ) : null}

      {liveOpen ? (
        <div style={ui.card}>
          <div style={ui.sectionHeadRow}>
            <div>
              <div style={ui.sectionTitle}>LIVE / TRANSPORT CONTROL TOWER</div>
              <div style={ui.sectionHint}>{liveMode === "REALTIME" ? "Supabase realtime" : "Refresh i lehtë çdo 20 sekonda"}</div>
            </div>
            <button type="button" style={ui.btnGhostMini} onClick={loadRows}>{loadingRows ? "DUKE…" : "↻"}</button>
          </div>
          {(liveRows?.length || 0) === 0 ? <div style={ui.empty}>S'KA AKTIVITET LIVE.</div> : <div style={ui.list}>{liveRows.map((row) => <DispatchCard key={`live_panel_${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />)}</div>}
        </div>
      ) : null}

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
                {currentRows.map((row) => (
                  <DispatchCard key={`${getOrderTable(row)}_${row.id}`} row={row} onOpen={openRow} />
                ))}
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
                <div style={ui.modalKicker}>KLIENTI</div>
                <div style={ui.sectionTitle}>{getDispatchCardCode(selectedRow)} • {up(getClientName(selectedRow) || "PA EMËR")}</div>
                <div style={ui.sectionHint}>{selectedPhone || "PA TEL"}</div>
              </div>
              <button type="button" style={ui.btnGhostMini} onClick={() => setSelectedRow(null)}>MBYLLE</button>
            </div>

            <div style={ui.detailGrid}>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>STATUSI AKTUAL</div>
                <div style={ui.detailValue}>{dispatchStatusLabel(selectedRow)}</div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>SA I BËHEN</div>
                <div style={ui.paymentRows}>
                  <div><span>TOTALI</span><strong>{moneyDash(selectedPay.total)}</strong></div>
                  <div><span>PAGUAR</span><strong>{moneyDash(selectedPay.paid)}</strong></div>
                  <div><span>BORXH</span><strong style={rowHasDebt(selectedRow) ? ui.debtInline : undefined}>{moneyDash(selectedPay.debt)}</strong></div>
                </div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>ADRESA</div>
                <div style={getAddress(selectedRow) ? ui.detailValue : ui.addressWarn}>{getAddress(selectedRow) || "PA ADRESË"}</div>
              </div>
              <div style={ui.detailBox}>
                <div style={ui.detailLabel}>SHOFERI / ORARI</div>
                <div style={ui.detailValue}>Shoferi: {orderAssignedDriver(selectedRow) || "PA SHOFER"}</div>
                <div style={ui.detailSub}>Data/sloti: {getScheduleText(selectedRow)}</div>
              </div>
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>TIMELINE</div>
              <div style={ui.timelineWrap}>
                {DISPATCH_TIMELINE_STEPS.map((step, idx) => (
                  <span key={step} style={timelineStyle(idx, transportStageIndex(selectedRow))}>{idx + 1}. {step}</span>
                ))}
              </div>
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>VEPRIME</div>
              <div style={ui.actionGrid}>
                {selectedPhoneLink ? <a href={selectedPhoneLink} style={ui.actionBtn}>THIRR</a> : null}
                {selectedWhatsappLink ? <a href={selectedWhatsappLink} target="_blank" rel="noreferrer" style={ui.actionBtn}>WHATSAPP</a> : null}
                <button type="button" style={ui.actionBtn} onClick={() => copyReply(selectedRow)}>KOPJO PËRGJIGJEN</button>
                <button type="button" style={ui.actionBtn} onClick={() => setDispatchReschedule(selectedRow)}>RIPLAN</button>
                <a href={selectedTransportHref} style={ui.actionBtn}>HAP NË TRANSPORT</a>
                <button type="button" style={ui.actionBtnDisabled} disabled>EDITO ADRESËN</button>
              </div>
              {copyMsg ? <div style={ui.ok}>{copyMsg}</div> : null}
            </div>

            <div style={ui.updateSection}>
              <div style={ui.sectionTitle}>NDËRRO SHOFERIN / ORARIN</div>
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
            </div>

            {canDispatchRemoveRow(selectedRow) ? (
              <div style={ui.adminRiskBox}>
                <div>
                  <div style={ui.sectionTitle}>ADMIN / RREZIK</div>
                  <div style={ui.sectionHint}>Përdore vetëm kur porosia është anuluar ose duhet larguar nga listat aktive. Kërkon confirm.</div>
                </div>
                <button
                  type="button"
                  style={ui.btnDanger}
                  onClick={() => removeDispatchRow(selectedRow)}
                  disabled={deleteBusyId === String(selectedRow?.id || "")}
                >
                  {deleteBusyId === String(selectedRow?.id || "") ? "DUKE HEQ…" : "FSHI POROSINË"}
                </button>
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={{ ...ui.btnPrimary, flex: 1 }} onClick={savePlan} disabled={saveBusy}>{saveBusy ? "DUKE RUAJT…" : "RUAJ PLANIN"}</button>
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

  // Dispatch Command Center dark UI overrides / additions
  page: { minHeight: "100vh", background: "#070b14", color: "#f8fafc", padding: 16, width: "100%", maxWidth: "100vw", overflowX: "hidden", boxSizing: "border-box" },
  top: { maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", boxSizing: "border-box" },
  title: { fontSize: 18, fontWeight: 1000, letterSpacing: 0.5, color: "#f8fafc" },
  sub: { fontSize: 12, color: "rgba(226,232,240,0.68)", fontWeight: 800 },
  card: { maxWidth: 960, width: "100%", margin: "14px auto 0", background: "rgba(15,23,42,0.96)", borderRadius: 18, border: "1px solid rgba(148,163,184,0.18)", padding: 14, boxShadow: "0 18px 36px rgba(0,0,0,0.28)", boxSizing: "border-box", overflow: "hidden" },
  commandCard: { maxWidth: 960, width: "100%", margin: "14px auto 0", background: "linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))", borderRadius: 20, border: "1px solid rgba(96,165,250,0.28)", padding: 14, boxShadow: "0 22px 44px rgba(0,0,0,0.34)", boxSizing: "border-box", overflow: "hidden" },
  statsGrid: { maxWidth: 960, width: "100%", margin: "14px auto 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 10, boxSizing: "border-box" },
  statCard: { background: "rgba(15,23,42,0.92)", borderRadius: 16, border: "1px solid rgba(148,163,184,0.16)", padding: 12, boxShadow: "0 12px 24px rgba(0,0,0,0.22)", minWidth: 0, boxSizing: "border-box" },
  statLabel: { fontSize: 11, fontWeight: 1000, color: "rgba(203,213,225,0.72)" },
  statValue: { fontSize: 28, fontWeight: 1000, lineHeight: 1.1, marginTop: 4, color: "#f8fafc" },
  label: { fontSize: 12, fontWeight: 1000, color: "rgba(203,213,225,0.82)" },
  sectionTitle: { fontWeight: 1000, marginBottom: 8, color: "#f8fafc", letterSpacing: 0.2 },
  sectionHint: { fontSize: 12, color: "rgba(203,213,225,0.70)", marginBottom: 10, fontWeight: 700 },
  empty: { fontWeight: 900, color: "rgba(203,213,225,0.72)" },
  input: { height: 44, borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", padding: "0 12px", fontWeight: 900, outline: "none", width: "100%", maxWidth: "100%", background: "rgba(2,6,23,0.72)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", boxSizing: "border-box" },
  commandInput: { height: 52, borderRadius: 16, border: "1px solid rgba(96,165,250,0.34)", padding: "0 14px", fontWeight: 1000, outline: "none", width: "100%", maxWidth: "100%", background: "rgba(2,6,23,0.86)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", boxSizing: "border-box", fontSize: 16 },
  textarea: { minHeight: 70, borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", padding: 12, fontWeight: 900, outline: "none", background: "rgba(2,6,23,0.72)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", width: "100%", maxWidth: "100%", boxSizing: "border-box" },
  selectOption: { background: "#0f172a", color: "#f8fafc" },
  btnGhost: { border: "1px solid rgba(148,163,184,0.24)", background: "rgba(15,23,42,0.92)", padding: "10px 12px", borderRadius: 12, fontWeight: 1000, textDecoration: "none", color: "#f8fafc" },
  btnGhostMini: { border: "1px solid rgba(148,163,184,0.24)", background: "rgba(15,23,42,0.92)", padding: "8px 10px", borderRadius: 10, fontWeight: 1000, color: "#f8fafc", cursor: "pointer" },
  btnPrimary: { height: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.32)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", padding: "0 16px" },
  btnDanger: { height: 48, borderRadius: 14, border: "1px solid rgba(248,113,113,0.28)", background: "rgba(127,29,29,0.62)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", padding: "0 16px" },
  btnDangerMini: { height: 38, borderRadius: 12, border: "1px solid rgba(248,113,113,0.28)", background: "rgba(127,29,29,0.52)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", padding: "0 14px", whiteSpace: "nowrap" },
  err: { background: "rgba(127,29,29,0.30)", border: "1px solid rgba(248,113,113,0.25)", color: "#fecaca", padding: 10, borderRadius: 12, fontWeight: 900, marginBottom: 10 },
  ok: { background: "rgba(6,78,59,0.32)", border: "1px solid rgba(52,211,153,0.24)", color: "#bbf7d0", padding: 10, borderRadius: 12, fontWeight: 1000, marginBottom: 10 },
  suggestBox: { position: "absolute", left: 0, right: 0, top: 78, background: "#0f172a", border: "1px solid rgba(148,163,184,0.22)", borderRadius: 14, boxShadow: "0 14px 28px rgba(0,0,0,0.32)", zIndex: 20, overflow: "hidden" },
  suggestItem: { width: "100%", textAlign: "left", background: "#0f172a", color: "#f8fafc", border: "none", borderBottom: "1px solid rgba(148,163,184,0.12)", padding: 12, cursor: "pointer" },
  badge: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(148,163,184,0.22)", background: "rgba(148,163,184,0.10)", color: "#e2e8f0" },
  badgeOk: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(52,211,153,0.24)", background: "rgba(16,185,129,0.14)", color: "#86efac" },
  badgeWarn: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(251,191,36,0.28)", background: "rgba(245,158,11,0.14)", color: "#fde68a" },
  badgeBad: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "5px 9px", border: "1px solid rgba(248,113,113,0.30)", background: "rgba(239,68,68,0.14)", color: "#fecaca" },
  badgeGhost: { fontSize: 11, fontWeight: 1000, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(148,163,184,0.18)", background: "rgba(148,163,184,0.08)", color: "#cbd5e1" },
  tabOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(96,165,250,0.34)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabDangerOn: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(248,113,113,0.30)", background: "#991b1b", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  tabDangerOff: { height: 40, padding: "0 14px", borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.18)", color: "#fecaca", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillOn: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(96,165,250,0.34)", background: "#2563eb", color: "#fff", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  pillOff: { minHeight: 38, padding: "0 12px", borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", fontWeight: 1000, cursor: "pointer", maxWidth: "100%", boxSizing: "border-box" },
  quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8, margin: "8px 0 12px", minWidth: 0 },
  quickFilterOn: { minHeight: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.42)", background: "rgba(37,99,235,0.88)", color: "#fff", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 1000, cursor: "pointer" },
  quickFilterOff: { minHeight: 48, borderRadius: 14, border: "1px solid rgba(148,163,184,0.18)", background: "rgba(2,6,23,0.45)", color: "#e2e8f0", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontWeight: 1000, cursor: "pointer" },
  smartFilterBlock: { borderRadius: 16, border: "1px solid rgba(148,163,184,0.12)", background: "rgba(2,6,23,0.24)", padding: 10, marginTop: 10, minWidth: 0, overflow: "hidden" },
  smartFilterTitle: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.8, color: "rgba(147,197,253,0.88)", marginBottom: 8 },
  smartChipRow: { display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%", marginBottom: 8 },
  smartChipOn: { minHeight: 38, borderRadius: 999, border: "1px solid rgba(96,165,250,0.42)", background: "rgba(37,99,235,0.92)", color: "#fff", padding: "0 12px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  smartChipOff: { minHeight: 38, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.82)", color: "#e2e8f0", padding: "0 12px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  emptyBox: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderRadius: 14, border: "1px solid rgba(148,163,184,0.14)", background: "rgba(2,6,23,0.28)", padding: 12, fontWeight: 900, color: "rgba(226,232,240,0.82)" },
  commandResults: { borderTop: "1px solid rgba(148,163,184,0.14)", marginTop: 12, paddingTop: 12 },
  capacityBox: { borderRadius: 14, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(2,6,23,0.36)", padding: 10, fontSize: 12, fontWeight: 900, display: "grid", gap: 6, width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  crmHitBox: { borderRadius: 14, border: "1px solid rgba(96,165,250,0.26)", background: "rgba(37,99,235,0.14)", padding: 12, marginBottom: 10 },
  crmHitTitle: { fontSize: 12, fontWeight: 1000, color: "#bfdbfe" },
  inlineDangerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", border: "1px solid rgba(248,113,113,0.18)", borderRadius: 14, padding: "10px 12px", background: "rgba(127,29,29,0.16)", width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" },
  inlineDangerHint: { fontSize: 12, fontWeight: 800, color: "rgba(254,202,202,0.86)", flex: 1, minWidth: 180 },
  updateSection: { marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.14)", paddingTop: 12 },
  compactRow: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(148,163,184,0.14)", borderRadius: 16, padding: 10, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 10px 22px rgba(0,0,0,0.18)", background: "rgba(2,6,23,0.42)", boxSizing: "border-box", overflow: "hidden" },
  compactCode: { minWidth: 52, height: 42, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(57,216,111,0.16)", color: "#86efac", fontSize: 13, fontWeight: 1000, border: "1px solid rgba(57,216,111,0.22)" },
  compactSub: { minWidth: 0, maxWidth: "100%", fontSize: 13, color: "rgba(203,213,225,0.74)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 800 },
  compactTime: { fontSize: 11, color: "rgba(203,213,225,0.58)", fontWeight: 1000, whiteSpace: "nowrap", flexShrink: 0 },
  orderCard: { width: "100%", maxWidth: "100%", minWidth: 0, border: "1px solid rgba(148,163,184,0.16)", borderRadius: 18, padding: 12, display: "flex", alignItems: "flex-start", gap: 10, boxShadow: "0 14px 30px rgba(0,0,0,0.22)", background: "linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.92))", boxSizing: "border-box", overflow: "hidden" },
  cardBody: { flex: 1, minWidth: 0, display: "grid", gap: 8 },
  cardNameWrap: { minWidth: 0, maxWidth: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 180px", overflow: "hidden" },
  codePill: { width: 50, minWidth: 50, height: 50, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", background: "#39d86f", color: "#03140a", fontSize: 14, fontWeight: 1000, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), 0 10px 20px rgba(57,216,111,0.20)" },
  compactName: { minWidth: 0, maxWidth: "100%", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 1000, letterSpacing: 0.2, color: "#f8fafc" },
  cardLabel: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.7, color: "rgba(147,197,253,0.82)", marginTop: 2 },
  addressStrong: { fontSize: 14, fontWeight: 1000, color: "#f8fafc", lineHeight: 1.25, overflowWrap: "anywhere" },
  addressWarn: { fontSize: 13, fontWeight: 1000, color: "#fde68a", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.22)", borderRadius: 12, padding: "7px 9px", lineHeight: 1.25, overflowWrap: "anywhere" },
  moneyGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px, 1fr))", gap: 6, borderRadius: 14, background: "rgba(15,23,42,0.74)", border: "1px solid rgba(148,163,184,0.12)", padding: 8, fontSize: 12, color: "#e2e8f0" },
  moneyLabel: { color: "rgba(203,213,225,0.70)", fontWeight: 900 },
  debtStrong: { color: "#fecaca", fontWeight: 1000 },
  debtInline: { color: "#fecaca" },
  cardFooterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0 },
  compactOpen: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 74, height: 32, padding: "0 12px", borderRadius: 999, background: "rgba(59,130,246,0.20)", border: "1px solid rgba(96,165,250,0.30)", color: "#bfdbfe", fontSize: 11, fontWeight: 1000, letterSpacing: 0.3, flexShrink: 0 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(2,6,23,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 },
  modalCard: { width: "min(720px, 100%)", maxWidth: "100%", maxHeight: "90vh", overflow: "auto", background: "#0f172a", color: "#f8fafc", borderRadius: 20, border: "1px solid rgba(148,163,184,0.22)", padding: 16, boxShadow: "0 24px 48px rgba(0,0,0,0.42)", boxSizing: "border-box" },
  modalKicker: { fontSize: 11, fontWeight: 1000, color: "#93c5fd", letterSpacing: 0.7, marginBottom: 4 },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 10 },
  detailBox: { borderRadius: 16, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(2,6,23,0.42)", padding: 12, display: "grid", gap: 6, minWidth: 0 },
  detailLabel: { fontSize: 10, fontWeight: 1000, letterSpacing: 0.7, color: "rgba(147,197,253,0.86)" },
  detailValue: { fontSize: 14, fontWeight: 1000, color: "#f8fafc", overflowWrap: "anywhere" },
  detailSub: { fontSize: 12, fontWeight: 800, color: "rgba(203,213,225,0.72)" },
  paymentRows: { display: "grid", gap: 6, fontSize: 13 },
  actionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 },
  actionBtn: { minHeight: 42, borderRadius: 12, border: "1px solid rgba(96,165,250,0.28)", background: "rgba(37,99,235,0.18)", color: "#dbeafe", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 12px", fontWeight: 1000, textDecoration: "none", cursor: "pointer", boxSizing: "border-box" },
  actionBtnDisabled: { minHeight: 42, borderRadius: 12, border: "1px solid rgba(148,163,184,0.14)", background: "rgba(148,163,184,0.08)", color: "rgba(203,213,225,0.42)", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 12px", fontWeight: 1000, cursor: "not-allowed", boxSizing: "border-box" },

  // Dispatch compact mobile command-center overrides
  page: { minHeight: "100vh", background: "#070b14", color: "#f8fafc", padding: "16px 16px calc(120px + env(safe-area-inset-bottom))", width: "100%", maxWidth: "100vw", overflowX: "hidden", boxSizing: "border-box" },
  headerLeft: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 },
  liveChip: { minHeight: 30, borderRadius: 999, border: "1px solid rgba(96,165,250,0.32)", background: "rgba(37,99,235,0.18)", color: "#dbeafe", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", letterSpacing: 0.2 },
  statsStrip: { maxWidth: 960, width: "100%", margin: "10px auto 0", display: "flex", gap: 8, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 2, boxSizing: "border-box" },
  statChip: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.88)", color: "#e2e8f0", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipOn: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(96,165,250,0.38)", background: "#2563eb", color: "#fff", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipDanger: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.18)", color: "#fecaca", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  statChipDangerOn: { minHeight: 32, borderRadius: 999, border: "1px solid rgba(248,113,113,0.34)", background: "#991b1b", color: "#fff", padding: "0 11px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 1000, whiteSpace: "nowrap", cursor: "pointer" },
  searchHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 },
  searchHint: { fontSize: 11, color: "rgba(203,213,225,0.64)", fontWeight: 800, marginTop: 2 },
  topActions: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 8, minWidth: 0 },
  topActionOn: { minHeight: 38, borderRadius: 12, border: "1px solid rgba(96,165,250,0.38)", background: "#2563eb", color: "#fff", padding: "0 8px", fontSize: 12, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  topActionOff: { minHeight: 38, borderRadius: 12, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(2,6,23,0.42)", color: "#e2e8f0", padding: "0 8px", fontSize: 12, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  commandDetails: { marginTop: 10, borderTop: "1px solid rgba(148,163,184,0.12)", paddingTop: 10, display: "grid", gap: 10 },
  compactToggleRow: { display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 },
  panelToggle: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(148,163,184,0.20)", background: "rgba(15,23,42,0.82)", color: "#e2e8f0", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  panelToggleDanger: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(248,113,113,0.22)", background: "rgba(127,29,29,0.22)", color: "#fecaca", padding: "0 10px", fontSize: 11, fontWeight: 1000, cursor: "pointer", maxWidth: "100%" },
  quickChipRow: { display: "flex", gap: 7, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" },
  quickChipOn: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(96,165,250,0.40)", background: "#2563eb", color: "#fff", padding: "0 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  quickChipOff: { minHeight: 34, borderRadius: 999, border: "1px solid rgba(148,163,184,0.18)", background: "rgba(2,6,23,0.36)", color: "#e2e8f0", padding: "0 10px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, fontWeight: 1000, cursor: "pointer", whiteSpace: "nowrap" },
  commandCard: { maxWidth: 960, width: "100%", margin: "10px auto 0", background: "linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))", borderRadius: 18, border: "1px solid rgba(96,165,250,0.24)", padding: 12, boxShadow: "0 18px 34px rgba(0,0,0,0.30)", boxSizing: "border-box", overflow: "hidden" },
  commandInput: { height: 48, borderRadius: 14, border: "1px solid rgba(96,165,250,0.34)", padding: "0 13px", fontWeight: 1000, outline: "none", width: "100%", maxWidth: "100%", background: "rgba(2,6,23,0.86)", color: "#f8fafc", WebkitTextFillColor: "#f8fafc", caretColor: "#93c5fd", boxSizing: "border-box", fontSize: 15 },
  moneyLine: { borderRadius: 12, background: "rgba(15,23,42,0.54)", border: "1px solid rgba(148,163,184,0.10)", padding: "7px 9px", fontSize: 12, color: "#e2e8f0", fontWeight: 1000 },
  adminRiskBox: { marginTop: 12, borderTop: "1px solid rgba(248,113,113,0.18)", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderRadius: 14 },
};
