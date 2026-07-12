/*
 SYNC ROUTE — ULTRA SMART VERSION (SLEEP PEACEFULLY)
 - Vret "Fantazmat" heshturazi (kthe ok:true pa e shti ne DB)
 - Shpëton klientët offline (i jep kod emergjence nese perplaset)
 - Nuk bllokon queue-n e pajisjes lokale!
*/

import { createHash } from 'node:crypto';
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';
import { createTransportOrderAtomicServer } from '@/lib/transport/transportServer';
import { runArkaTransaction } from '@/lib/arka/arkaEngine';
export const dynamic = 'force-dynamic';

const PG_DUPLICATE = "23505";

function stableTransportOrderUuid(value) {
  const raw = String(value || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) return raw;
  const hex = createHash('sha256').update(`transport-offline:${raw || 'missing'}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function readTransportOfflineCode(row = {}) {
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const client = data?.client && typeof data.client === 'object' && !Array.isArray(data.client) ? data.client : {};
  return String(
    row?.code_str ||
    row?.client_tcode ||
    data?.code_str ||
    data?.order_code ||
    data?.official_order_code ||
    data?.order_tcode ||
    data?.transport_client_tcode ||
    client?.transport_client_tcode ||
    client?.tcode ||
    client?.code ||
    ''
  ).trim();
}

function pickTable(body) {
  const t = String(
    body?.table ||
      body?.data?.table ||
      body?.payload?.table ||
      body?.payload?.data?.table ||
      body?.payload?.insertRow?.table ||
      ""
  ).trim();
  return t === "transport_orders" ? "transport_orders" : "orders";
}

export async function POST(req) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE) ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  try {
    const body = await req.json();
    const { type, data, id, localId, payload } = body || {};

    const table = pickTable(body || {});

    const stripNonSchemaCols = (row, tableName = "orders") => {
      if (!row || typeof row !== "object") return row;
      const out = { ...row };
      if ("table" in out) delete out.table;
      if ("_table" in out) delete out._table;
      if (tableName !== "transport_orders" && "code_n" in out) delete out.code_n;
      Object.keys(out).forEach((key) => {
        if (String(key || '').startsWith('_')) delete out[key];
      });

      if (tableName !== "transport_orders") {
        if ("client" in out) delete out.client;
        return out;
      }

      return sanitizeTransportOrderPayload(out);
    };

    const isUuid = (v) =>
      typeof v === "string" &&
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v);

    const isDbNumericId = (v) => /^\d+$/.test(String(v || '').trim());
    const isPlainObject = (v) => !!v && Object.prototype.toString.call(v) === '[object Object]';
    const getDbTruthStatus = (row = {}) => {
      const top = String(row?.status ?? '').trim();
      if (top) return top;
      const rowData = isPlainObject(row?.data) ? row.data : {};
      return String(rowData?.status ?? '').trim();
    };
    const fetchBaseRowForWrite = async (target, targetId) => {
      if (target !== 'orders') return null;
      const rawId = String(targetId || '').trim();
      if (!rawId) return null;
      let q = supabase.from('orders').select('id,code,local_oid,status,data');
      q = isDbNumericId(rawId) ? q.eq('id', Number(rawId)) : q.eq('local_oid', rawId);
      const { data: current, error } = await q.maybeSingle();
      if (error) throw error;
      return current || null;
    };
    const normalizeBaseInsertPayload = (row) => {
      const out = { ...(row || {}) };
      const rowData = isPlainObject(out?.data) ? { ...out.data } : {};
      const nextStatus = String(out.status || rowData.status || 'pastrim').trim();
      out.status = nextStatus;
      out.data = { ...rowData, status: nextStatus };
      return out;
    };
    const normalizeBasePatchForWrite = async (target, targetId, patch) => {
      if (target !== 'orders') return patch;
      const out = { ...(patch || {}) };
      const hasStatus = Object.prototype.hasOwnProperty.call(out, 'status') && String(out?.status ?? '').trim() !== '';
      const hasData = isPlainObject(out?.data);
      if (!hasStatus && !hasData) return out;
      const current = await fetchBaseRowForWrite(target, targetId);
      const currentData = isPlainObject(current?.data) ? current.data : {};
      const dbStatus = getDbTruthStatus(current);
      const nextStatus = hasStatus ? String(out.status).trim() : dbStatus;
      const nextData = { ...currentData, ...(hasData ? out.data : {}) };
      if (nextStatus) nextData.status = nextStatus;
      if (hasStatus) out.status = nextStatus;
      out.data = nextData;
      return out;
    };


    const roundMoney = (value) => {
      const n = Number(value || 0);
      return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
    };

    const asObj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const isDeliveredBaseStatus = (value = '') => ['dorzim', 'dorezim', 'delivery', 'delivered', 'completed', 'kompletuar'].includes(String(value || '').trim().toLowerCase().replace('ë', 'e'));

    const readCashPayState = (data = {}, fallbackTotal = 0) => {
      const pay = asObj(data?.pay);
      const paid = roundMoney(Math.max(Number(pay?.paid || 0), Number(data?.paid || 0), Number(data?.paid_eur || 0), Number(data?.clientPaid || 0), Number(data?.paid_cash || 0)));
      const total = roundMoney(pay?.euro ?? pay?.total ?? data?.price_total ?? data?.total ?? fallbackTotal ?? 0);
      const debt = roundMoney(pay?.debt ?? data?.debt ?? Math.max(0, total - paid));
      const method = String(pay?.method || data?.pay_method || data?.method || 'CASH').trim().toUpperCase();
      return { paid, total, debt, method };
    };

    const actorFromPaidOrderPatch = (patch = {}, order = {}) => {
      const data = asObj(patch?.data);
      const pay = asObj(data?.pay);
      const oldData = asObj(order?.data);
      const oldPay = asObj(oldData?.pay);
      return {
        pin: String(patch?.delivered_by || data?.delivered_by || pay?.actorPin || pay?.actor_pin || oldData?.delivered_by || oldPay?.actorPin || '').trim(),
        name: String(data?.delivered_by_name || pay?.actorName || pay?.actor_name || oldData?.delivered_by_name || oldPay?.actorName || '').trim(),
        role: String(pay?.actorRole || pay?.actor_role || oldPay?.actorRole || '').trim(),
      };
    };

    const sumActiveArkaForOrder = async (orderId) => {
      const { data: rows, error } = await supabase
        .from('arka_pending_payments')
        .select('id,amount,status')
        .eq('order_id', orderId)
        .eq('type', 'IN')
        .eq('source_module', 'BASE')
        .in('status', ['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH', 'HANDED'])
        .limit(50);
      if (error) throw error;
      return roundMoney((Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + roundMoney(row?.amount), 0));
    };

    const ensureArkaForPaidCashPatch = async (target, targetId, patch = {}) => {
      if (target !== 'orders' || !isDbNumericId(targetId)) return;
      const { data: order, error } = await supabase
        .from('orders')
        .select('id,code,client_name,client_phone,status,price_total,data')
        .eq('id', Number(targetId))
        .maybeSingle();
      if (error) throw error;
      if (!order?.id) return;
      const oldData = asObj(order.data);
      const patchData = asObj(patch.data);
      const hasPaymentIntent =
        asObj(patchData?.pay) === patchData?.pay ||
        ['paid', 'paid_eur', 'paid_cash', 'debt', 'clientPaid', 'pay_method', 'method'].some((key) => Object.prototype.hasOwnProperty.call(patch, key) || Object.prototype.hasOwnProperty.call(patchData, key));
      if (!hasPaymentIntent) return;
      const mergedData = {
        ...oldData,
        ...patchData,
        paid: patch?.paid ?? patch?.paid_eur ?? patchData?.paid ?? patchData?.paid_eur ?? oldData?.paid,
        paid_eur: patch?.paid_eur ?? patchData?.paid_eur ?? oldData?.paid_eur,
        paid_cash: patch?.paid_cash ?? patchData?.paid_cash ?? oldData?.paid_cash,
        debt: patch?.debt ?? patchData?.debt ?? oldData?.debt,
        price_total: patch?.price_total ?? patchData?.price_total ?? order.price_total ?? oldData?.price_total,
      };
      if (asObj(patchData?.pay) === patchData?.pay || asObj(oldData?.pay) === oldData?.pay) {
        mergedData.pay = { ...asObj(oldData?.pay), ...asObj(patchData?.pay) };
      }
      const status = patch.status || mergedData.status || order.status || oldData.status || '';
      if (!isDeliveredBaseStatus(status)) return;
      const cash = readCashPayState(mergedData, patch.price_total ?? order.price_total ?? 0);
      if (cash.method !== 'CASH' || !(cash.paid > 0) || cash.debt > 0.01) return;
      const activeSum = await sumActiveArkaForOrder(order.id);
      const expectedPaid = roundMoney(Math.min(cash.paid, cash.total || cash.paid));
      const missingAmount = roundMoney(expectedPaid - activeSum);
      if (missingAmount <= 0.005) return;
      const actor = actorFromPaidOrderPatch(patch, order);
      if (!actor.pin) throw new Error('ARKA_OFFLINE_SYNC_ACTOR_PIN_REQUIRED_FOR_PAID_CASH_ORDER');
      const dataObj = asObj(patch.data);
      const code = dataObj.code || patch.code || order.code || asObj(mergedData.client).code || '';
      const clientName = dataObj.client_name || asObj(dataObj.client).name || order.client_name || '';
      const clientPhone = dataObj.client_phone || asObj(dataObj.client).phone || order.client_phone || '';
      const idempotencyKey = ['BASE_ORDER_PAYMENT', order.id, missingAmount.toFixed(2), actor.pin || 'NO_PIN'].join(':');
      await runArkaTransaction({
        action: 'BASE_ORDER_PAYMENT',
        actorPin: actor.pin,
        actorName: actor.name || null,
        actorRole: actor.role || null,
        orderId: order.id,
        amount: missingAmount,
        method: 'CASH',
        orderCode: code,
        clientName,
        clientPhone,
        statusOnFullPayment: 'dorzim',
        note: `PAGESA ${missingAmount.toFixed(2)}€ • #${code || ''} • ${clientName || ''} | OFFLINE_SYNC_GUARD_PAID_CASH_ORDER`,
        idempotencyKey,
        idempotency_key: idempotencyKey,
      }, { supabase });
    };


    const normBaseCode = (value) => {
      const digits = String(value ?? '').replace(/\D+/g, '').replace(/^0+/, '');
      const n = Number(digits || 0);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const baseOrderCodeMatches = (existing = {}, row = {}) => {
      const existingCode = normBaseCode(existing?.code ?? existing?.data?.code ?? existing?.data?.client?.code);
      const incomingCode = normBaseCode(row?.code ?? row?.data?.code ?? row?.data?.client?.code);
      if (!existingCode || !incomingCode) return true;
      return existingCode === incomingCode;
    };

    const updateExistingBaseOrderFromNumericLocalOid = async (localOid, insertRow) => {
      const rawId = String(localOid || '').trim();
      if (!rawId || !isDbNumericId(rawId)) return null;

      const existing = await fetchBaseRowForWrite('orders', rawId);
      if (!existing?.id) return null;
      if (!baseOrderCodeMatches(existing, insertRow)) {
        return { ok: false, error: `NUMERIC_LOCAL_OID_CODE_MISMATCH:${rawId}` };
      }

      const patch = await normalizeBasePatchForWrite('orders', rawId, {
        ...(insertRow || {}),
        updated_at: new Date().toISOString(),
      });
      delete patch.local_oid;
      await ensureArkaForPaidCashPatch('orders', rawId, patch);

      const { error } = await supabase
        .from('orders')
        .update(patch)
        .eq('id', Number(rawId));

      if (error) return { ok: false, error: error.message };
      return { ok: true, updatedExisting: true, id: Number(rawId) };
    };

    const ensureArkaForInsertedBaseOrder = async (insertRow = {}) => {
      if (table !== 'orders') return;
      const localOid = String(insertRow?.local_oid || '').trim();
      if (!localOid) return;
      const { data: existing, error } = await supabase
        .from('orders')
        .select('id')
        .eq('local_oid', localOid)
        .maybeSingle();
      if (error) throw error;
      if (existing?.id) await ensureArkaForPaidCashPatch('orders', existing.id, insertRow);
    };

    // ==========================================
    // 1. INSERT ORDER (Porositë e reja / Offline)
    // ==========================================
    if (type === "insert_order") {
      const raw = data || payload?.insertRow || payload?.data || payload;
      const row = { ...(raw || {}) };

      // ------------------------------------------
      // TRANSPORT: exact UUID + atomic permanent-T-code save.
      // This route must never bypass the same phone lookup used by Self Entry.
      // ------------------------------------------
      if (table === "transport_orders") {
        const rawLocalId = String(row.id || row.local_oid || localId || "").trim();
        const orderId = stableTransportOrderUuid(rawLocalId);
        const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
        const rowClient = rowData?.client && typeof rowData.client === 'object' && !Array.isArray(rowData.client) ? rowData.client : {};
        const clientName = String(row.client_name || rowData.client_name || rowClient.name || 'Offline').trim();
        const clientPhone = String(row.client_phone || rowData.client_phone || rowClient.phone || '').trim();
        const suppliedCode = readTransportOfflineCode(row);
        const owner = String(
          row.code_owner ||
          rowData.created_by_pin ||
          rowData.transport_pin ||
          rowData.driver_pin ||
          'OFFLINE_SYNC'
        ).trim() || 'OFFLINE_SYNC';

        try {
          const created = await createTransportOrderAtomicServer(supabase, {
            id: orderId,
            code_str: suppliedCode,
            client_tcode: suppliedCode,
            client_name: clientName,
            client_phone: clientPhone,
            address: rowData.address || rowClient.address || '',
            gps_lat: rowData.gps_lat ?? rowClient.gps_lat ?? rowClient.gps?.lat ?? null,
            gps_lng: rowData.gps_lng ?? rowClient.gps_lng ?? rowClient.gps?.lng ?? null,
            status: row.status || rowData.status || 'pickup',
            owner,
            data: {
              ...rowData,
              ...row,
              id: undefined,
              local_oid: rawLocalId || orderId,
              order_id: orderId,
              public_order_id: orderId,
              client: {
                ...rowClient,
                name: clientName,
                phone: clientPhone,
              },
            },
          });
          if (!created?.ok || !created?.data?.id) throw new Error('TRANSPORT_OFFLINE_ORDER_NOT_VERIFIED');
          return NextResponse.json({
            ok: true,
            localId: rawLocalId || orderId,
            id: created.data.id,
            client_id: created.data.client_id,
            client_tcode: created.data.client_tcode,
            visit_nr: created.data.visit_nr,
            table,
          }, { status: 200 });
        } catch (transportError) {
          return NextResponse.json({ ok: false, error: String(transportError?.message || transportError) }, { status: 200 });
        }
      }

      // Normalizimi i ID-ve
      if (row.id && !row.local_oid) row.local_oid = String(row.id);
      if (row.id) delete row.id;
      if (!row.local_oid && localId) row.local_oid = String(localId);

      const orderData = row.data || {};

      // 🔥 SHTRESA 1: VRASËSI I FANTAZMAVE
      // Nëse s'ka klient, s'ka artikuj dhe s'ka para -> Është mbeturinë (Ghost).
      const hasClient = (row.client_name?.trim() || orderData.client?.name?.trim() || row.client_phone?.trim() || orderData.client?.phone?.trim());
      const hasItems = (orderData.tepiha?.length > 0 || orderData.staza?.length > 0 || orderData.shkallore?.qty > 0);
      const hasMoney = ((row.total || 0) > 0 || (orderData.pay?.euro || 0) > 0);

      if (!hasClient && !hasItems && !hasMoney) {
         // I themi telefonit "U krye", qe ta fshije pergjithmone nga queue, por NUK e ruajme.
         return NextResponse.json({ ok: true, localId, ghost_killed: true }, { status: 200 });
      }

      // 🔥 SHTRESA 2: MBROJTJA E KODIT (Nga Offline)
      let finalCode = 0;
      if (row.code != null) {
        const parsed = Number(row.code);
        finalCode = isNaN(parsed) ? 0 : parsed;
      }
      if (row.code_n != null) {
        const parsedN = Number(row.code_n);
        if (!isNaN(parsedN)) finalCode = parsedN;
      }
      row.code = finalCode;

      // Sigurohemi qe fusha JSON 'data' te mos jete bosh
      if (!row.data) {
          row.data = {
              client: { name: row.client_name || 'Offline', phone: row.client_phone || '' },
              status: row.status || 'pastrim',
              pay: { euro: row.total || 0, paid: row.paid || 0, debt: Math.max(0, (row.total || 0) - (row.paid || 0)) }
          };
      }

      const insertRow = stripNonSchemaCols(normalizeBaseInsertPayload(row), table);

      // If a stale local/offline payload uses a numeric DB id as local_oid,
      // update that DB row instead of inserting a duplicate row with local_oid = id.
      const numericLocalOidResult = await updateExistingBaseOrderFromNumericLocalOid(row.local_oid, insertRow);
      if (numericLocalOidResult?.ok) {
        return NextResponse.json({
          ok: true,
          localId,
          updated_existing: true,
          duplicate_guard: 'NUMERIC_LOCAL_OID_UPDATED_DB_ID',
          id: numericLocalOidResult.id,
        }, { status: 200 });
      }
      if (numericLocalOidResult?.ok === false) {
        return NextResponse.json({
          ok: false,
          error: numericLocalOidResult.error || 'NUMERIC_LOCAL_OID_UPDATE_FAILED',
          duplicate_guard: 'NUMERIC_LOCAL_OID_BLOCKED',
        }, { status: 200 });
      }

      // Funksion i vogel per ta tentu insertimin
      const tryInsert = async (r) => await supabase.from("orders").insert(r);

      let { error } = await tryInsert(insertRow);

      // 🔥 SHTRESA 3: ZGJIDHJA E KONFLIKTEVE (Duplicates)
      if (error) {
        if (error.code === PG_DUPLICATE || /duplicate key/i.test(error.message || "")) {
          // Kontrollojme a eshte fiks e njejta porosi (Dyfishim nga rrjeti i dobet)
          const oid = row.local_oid || null;
          if (oid) {
            const { data: existing } = await supabase.from('orders').select('id, local_oid').eq('local_oid', oid).limit(1);
            if (Array.isArray(existing) && existing.length) {
              await ensureArkaForInsertedBaseOrder(insertRow);
              return NextResponse.json({ ok: true, localId, existed: true }, { status: 200 });
            }
          }
          
          // NËSE VJEN KËTU: Kodi është zënë nga dikush tjetër! (Psh kodi 0 ose 105).
          // Për të mos humbur klientin e malit, i japim një kod emergjence te madh (psh 99000 + diçka)
          insertRow.code = 990000 + Math.floor(Math.random() * 9999);
          
          const retry = await tryInsert(insertRow);
          
          if (retry.error) {
             // Nese prap deshton (gabim i rralle DB), kthejme error qe mos ta fshije nga telefoni
             return NextResponse.json({ ok: false, error: retry.error.message }, { status: 200 });
          } else {
             // U ruajt me kod emergjence! Telefoni e fshin nga radha.
             await ensureArkaForInsertedBaseOrder(insertRow);
             return NextResponse.json({ ok: true, localId, code_changed: true }, { status: 200 });
          }
        }
        
        // Gabime te tjera te databazes (jo duplicate)
        return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      }

      // Sukses!
      await ensureArkaForInsertedBaseOrder(insertRow);
      return NextResponse.json({ ok: true, localId }, { status: 200 });
    }

    // ==========================================
    // 2. PATCH ORDER DATA (Ndryshime ekzistuese)
    // ==========================================
    if (type === "patch_order_data") {
      let patch = stripNonSchemaCols({
        ...(data || {}),
        updated_at: new Date().toISOString(),
      }, table);

      const target = table === "transport_orders" ? "transport_orders" : "orders";
      patch = await normalizeBasePatchForWrite(target, id, patch);
      await ensureArkaForPaidCashPatch(target, id, patch);
      const q = supabase.from(target).update(patch);
      const useLocalOid = target === "orders" && !isDbNumericId(String(id || ""));
      const { error } = await (useLocalOid ? q.eq("local_oid", String(id)) : q.eq("id", id));

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // ==========================================
    // 3. SET STATUS (Ndryshim statusi)
    // ==========================================
    if (type === "set_status") {
      const target = table === "transport_orders" ? "transport_orders" : "orders";
      const patch = await normalizeBasePatchForWrite(target, id, {
        status: data?.status,
        updated_at: new Date().toISOString(),
      });
      const q = supabase
        .from(target)
        .update(patch);

      const useLocalOid = target === "orders" && !isDbNumericId(String(id || ""));
      const { error } = await (useLocalOid ? q.eq("local_oid", String(id)) : q.eq("id", id));

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    return NextResponse.json({ ok: false, error: "UNKNOWN_OP_TYPE" }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}
