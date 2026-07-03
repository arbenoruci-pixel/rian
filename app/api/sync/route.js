/*
 SYNC ROUTE — HARDENED VERSION
 - original insert_order behavior preserved
 - validation + logger added
 - set_status now uses status engine through ordersService
*/
import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { transitionOrderStatus, updateOrderRecord } from '@/lib/ordersService';
import { validateOrderStatus } from '@/lib/validation';
import { runArkaTransaction } from '@/lib/arka/arkaEngine';
export const dynamic = 'force-dynamic';

function stripNonSchemaCols(row = {}) {
  const out = { ...(row || {}) };
  delete out.table;
  delete out._table;
  delete out.localOnly;
  delete out.kind;
  delete out.op;
  delete out.op_id;
  delete out.attempts;
  delete out.lastError;
  delete out.nextRetryAt;
  delete out.server_id;
  delete out.client;
  delete out.code_n;
  delete out.data_patch;
  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });
  return out;
}

function normalizeInsertOrderPayload(body) {
  const data = stripNonSchemaCols({ ...(body?.data || {}) });
  if (typeof data.id === 'string') delete data.id;
  if (!data.local_oid) {
    data.local_oid = body?.localId || data.local_id || null;
  }
  delete data.local_id;
  if (data.is_offline === undefined) data.is_offline = true;
  const jsonData = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? { ...data.data } : {};
  const nextStatus = String(data.status || jsonData.status || 'pastrim').trim();
  data.status = nextStatus;
  data.data = { ...jsonData, status: nextStatus };
  return stripNonSchemaCols(data);
}

function isDbNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function normBaseCode(value) {
  const digits = String(value ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function baseOrderCodeMatches(existing = {}, row = {}) {
  const existingData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data) ? existing.data : {};
  const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const existingCode = normBaseCode(existing?.code ?? existingData?.code ?? existingData?.client?.code);
  const incomingCode = normBaseCode(row?.code ?? rowData?.code ?? rowData?.client?.code);
  if (!existingCode || !incomingCode) return true;
  return existingCode === incomingCode;
}

function mergeExistingBaseRowForUpdate(existing = {}, row = {}) {
  const existingData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data) ? existing.data : {};
  const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const nextStatus = String(row?.status || rowData?.status || existing?.status || existingData?.status || 'pastrim').trim();
  const patch = {
    ...row,
    status: nextStatus,
    data: {
      ...existingData,
      ...rowData,
      status: nextStatus,
    },
    updated_at: new Date().toISOString(),
  };
  delete patch.local_oid;
  return stripNonSchemaCols(patch);
}


function roundMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function isDeliveredBaseStatus(value = '') {
  const status = String(value || '').trim().toLowerCase().replace('ë', 'e');
  return ['dorzim', 'dorezim', 'delivery', 'delivered', 'completed', 'kompletuar'].includes(status);
}

function asObj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readCashPayState(data = {}, fallbackTotal = 0) {
  const pay = asObj(data?.pay);
  const paid = roundMoney(Math.max(
    Number(pay?.paid || 0),
    Number(data?.paid || 0),
    Number(data?.paid_eur || 0),
    Number(data?.clientPaid || 0),
    Number(data?.paid_cash || 0)
  ));
  const total = roundMoney(pay?.euro ?? pay?.total ?? data?.price_total ?? data?.total ?? fallbackTotal ?? 0);
  const debt = roundMoney(pay?.debt ?? data?.debt ?? Math.max(0, total - paid));
  const method = String(pay?.method || data?.pay_method || data?.method || 'CASH').trim().toUpperCase();
  return { paid, total, debt, method };
}

function actorFromPaidOrderPatch(patch = {}, order = {}) {
  const data = asObj(patch?.data);
  const pay = asObj(data?.pay);
  const oldData = asObj(order?.data);
  const oldPay = asObj(oldData?.pay);
  return {
    pin: String(patch?.delivered_by || data?.delivered_by || pay?.actorPin || pay?.actor_pin || oldData?.delivered_by || oldPay?.actorPin || '').trim(),
    name: String(data?.delivered_by_name || pay?.actorName || pay?.actor_name || oldData?.delivered_by_name || oldPay?.actorName || '').trim(),
    role: String(pay?.actorRole || pay?.actor_role || oldPay?.actorRole || '').trim(),
  };
}

async function sumActiveArkaForOrder(supabase, orderId) {
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('id,amount,status')
    .eq('order_id', orderId)
    .eq('type', 'IN')
    .eq('source_module', 'BASE')
    .in('status', ['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH', 'HANDED'])
    .limit(50);
  if (error) throw error;
  return roundMoney((Array.isArray(data) ? data : []).reduce((sum, row) => sum + roundMoney(row?.amount), 0));
}

function arkaPaidOrderKey(orderId, amount, actorPin) {
  return ['BASE_ORDER_PAYMENT', orderId, roundMoney(amount).toFixed(2), actorPin || 'NO_PIN'].join(':');
}

async function ensureArkaForPaidCashPatch(supabase, id, patch = {}) {
  const rawId = String(id || '').trim();
  if (!/^\d+$/.test(rawId)) return;
  const { data: order, error } = await supabase
    .from('orders')
    .select('id,code,client_name,client_phone,status,price_total,data')
    .eq('id', Number(rawId))
    .maybeSingle();
  if (error) throw error;
  if (!order?.id) return;

  const oldData = asObj(order.data);
  const patchData = asObj(patch.data);
  const hasPaymentIntent = asObj(patchData?.pay) === patchData?.pay;
  const cashPatchIntent =
    hasPaymentIntent ||
    ['paid', 'paid_eur', 'paid_cash', 'debt', 'clientPaid', 'pay_method', 'method'].some((key) => Object.prototype.hasOwnProperty.call(patch, key) || Object.prototype.hasOwnProperty.call(patchData, key));
  if (!cashPatchIntent) return;
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
  const payState = readCashPayState(mergedData, patch.price_total ?? order.price_total ?? 0);
  if (payState.method !== 'CASH' || !(payState.paid > 0) || payState.debt > 0.01) return;

  const activeSum = await sumActiveArkaForOrder(supabase, order.id);
  const expectedPaid = roundMoney(Math.min(payState.paid, payState.total || payState.paid));
  const missingAmount = roundMoney(expectedPaid - activeSum);
  if (missingAmount <= 0.005) return;

  const actor = actorFromPaidOrderPatch(patch, order);
  if (!actor.pin) throw new Error('ARKA_SYNC_API_ACTOR_PIN_REQUIRED_FOR_PAID_CASH_ORDER');

  const code = patchData.code || patch.code || order.code || asObj(mergedData.client).code || '';
  const clientName = patchData.client_name || asObj(patchData.client).name || order.client_name || '';
  const clientPhone = patchData.client_phone || asObj(patchData.client).phone || order.client_phone || '';
  const idempotencyKey = arkaPaidOrderKey(order.id, missingAmount, actor.pin);
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
    note: `PAGESA ${missingAmount.toFixed(2)}€ • #${code || ''} • ${clientName || ''} | API_SYNC_GUARD_PAID_CASH_ORDER`,
    idempotencyKey,
    idempotency_key: idempotencyKey,
  }, { supabase });
}

export async function POST(req) {
  try {
    const supabase = createServiceClientOrThrow();
    const body = await readBody(req);
    const { type, data, id } = body || {};

    if (type === 'insert_order') {
      const row = normalizeInsertOrderPayload(body);

      if (row.local_oid && isDbNumericId(row.local_oid)) {
        const numericId = Number(row.local_oid);
        const { data: existing, error: lookupError } = await supabase
          .from('orders')
          .select('id,code,local_oid,status,data')
          .eq('id', numericId)
          .maybeSingle();

        if (lookupError) return apiFail(lookupError.message, 500);

        if (existing?.id) {
          if (!baseOrderCodeMatches(existing, row)) {
            return apiFail(`NUMERIC_LOCAL_OID_CODE_MISMATCH:${row.local_oid}`, 409);
          }

          const patch = mergeExistingBaseRowForUpdate(existing, row);
          await ensureArkaForPaidCashPatch(supabase, numericId, patch);
          const { error: updateError } = await supabase
            .from('orders')
            .update(patch)
            .eq('id', numericId);

          if (updateError) return apiFail(updateError.message, 500);
          return apiOk({
            localId: body.localId,
            updated_existing: true,
            duplicate_guard: 'NUMERIC_LOCAL_OID_UPDATED_DB_ID',
            id: numericId,
          });
        }
      }

      const q = row.local_oid
        ? supabase.from('orders').upsert(row, { onConflict: 'local_oid', ignoreDuplicates: true })
        : supabase.from('orders').insert(row);
      const { error } = await q;
      if (error) return apiFail(error.message, 500);

      if (row.local_oid) {
        const { data: inserted, error: lookupAfterInsertError } = await supabase
          .from('orders')
          .select('id')
          .eq('local_oid', row.local_oid)
          .maybeSingle();
        if (lookupAfterInsertError) return apiFail(lookupAfterInsertError.message, 500);
        if (inserted?.id) await ensureArkaForPaidCashPatch(supabase, inserted.id, row);
      }

      return apiOk({ localId: body.localId });
    }

    if (type === 'patch_order_data') {
      const payload = stripNonSchemaCols({ ...(data || {}) });
      delete payload.data_patch;
      await ensureArkaForPaidCashPatch(supabase, id, payload);
      await updateOrderRecord('orders', id, payload);
      return apiOk();
    }

    if (type === 'set_status') {
      const nextStatus = validateOrderStatus('orders', data?.status, ['pranim', 'pastrim', 'gati', 'dispatched', 'marrje', 'dorzim']);
      if (!nextStatus) return apiFail('INVALID_STATUS', 400);
      await transitionOrderStatus('orders', id, nextStatus);
      await updateOrderRecord('orders', id, { updated_at: new Date().toISOString() });
      return apiOk();
    }

    return apiFail('UNKNOWN_OP_TYPE', 400);
  } catch (e) {
    logApiError('api.sync', e);
    const msg = String(e?.message || e);
    if (msg.includes('STATUS_TRANSITION_NOT_ALLOWED')) return apiFail(msg, 400);
    return apiFail(msg, 500);
  }
}
