import { ARKA_ACTION } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';

function readActorFromLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function queueOptimisticDeliveryPatch(input = {}) {
  const rawOrder = input.rawOrder && typeof input.rawOrder === 'object' ? input.rawOrder : null;
  const orderId = input.orderId || input.order_id || rawOrder?.id || null;
  if (!rawOrder || !orderId) return false;
  const status = String(rawOrder?.status || rawOrder?.state || '').trim().toLowerCase();
  if (!['dorzim', 'delivery', 'delivered'].includes(status)) return false;
  try {
    const { queueOp } = await import('@/lib/offlineSyncClient');
    await queueOp('patch_order_data', {
      id: orderId,
      table: 'orders',
      status: 'dorzim',
      data: {
        status: 'dorzim',
        data: rawOrder,
        updated_at: rawOrder?.updated_at || rawOrder?.delivered_at || new Date().toISOString(),
        delivered_at: rawOrder?.delivered_at || new Date().toISOString(),
        picked_up_at: rawOrder?.picked_up_at || rawOrder?.delivered_at || new Date().toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeLegacyArgs(args) {
  // Supports BOTH call styles:
  // 1) recordOrderCashPayment({ orderId, code, clientName, amount, ... })
  // 2) recordOrderCashPayment(orderPayload, amount, pinData, payMethod)
  if (
    args.length >= 2 &&
    args[0] &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    typeof args[1] !== 'undefined'
  ) {
    const order = args[0] || {};
    const amount = Number(args[1] || 0);
    const pinData = args[2] || null;
    const payMethod = String(args[3] || order?.payMethod || order?.pay?.method || 'CASH').toUpperCase();

    return {
      rawOrder: order,
      orderId: order?.id || order?.orderId || order?.order_id || null,
      code: order?.code || order?.order_code || order?.codeRaw || null,
      clientName:
        order?.clientName ||
        order?.name ||
        order?.client_name ||
        order?.customer_name ||
        null,
      amount,
      note:
        order?.payment_note ||
        `PAGESA ${amount}€ • #${order?.code || order?.order_code || ''} • ${order?.clientName || order?.name || order?.client_name || ''}`.trim(),
      source: order?.source || 'ORDER_PAY',
      type: 'IN',
      user: pinData || null,
      payMethod,
      externalId: order?.payment_external_id || null,
    };
  }

  return args[0] || {};
}

/**
 * Centralized CASH payment recorder.
 * The only live money write path is /api/arka/transaction -> arkaEngine.
 */
export async function recordOrderCashPayment(...args) {
  const input = normalizeLegacyArgs(args);
  const amt = Number(input.amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'AMOUNT_INVALID' };

  const payMethod = String(input.payMethod || input.method || 'CASH').toUpperCase();
  if (payMethod !== 'CASH') {
    return { ok: true, skipped: true, reason: 'NON_CASH_PAYMENT' };
  }

  const actor = input.user || readActorFromLocalStorage() || null;
  const orderId = input.orderId || input.order_id || null;
  if (!orderId) return { ok: false, error: 'ORDER_ID_INVALID' };
  if (!actor?.pin) return { ok: false, error: 'ACTOR_PIN_REQUIRED' };

  const note =
    input.note ||
    `PAGESA ${amt}€ • #${input.code || ''} • ${input.clientName || input.name || ''}`.trim();

  const result = await arkaTransaction({
    action: ARKA_ACTION.BASE_ORDER_PAYMENT,
    actorPin: String(actor.pin),
    actorName: actor?.name ? String(actor.name) : null,
    actorRole: actor?.role ? String(actor.role) : null,
    orderId,
    amount: amt,
    method: 'CASH',
    note,
    orderCode: input.code || input.orderCode || input.order_code || null,
    clientName: input.clientName || input.name || input.client_name || null,
    clientPhone: input.clientPhone || input.client_phone || input.phone || null,
    idempotencyKey:
      input.idempotencyKey ||
      input.idempotency_key ||
      input.externalId ||
      input.external_id ||
      buildArkaIdempotencyKey(ARKA_ACTION.BASE_ORDER_PAYMENT, [orderId, amt, actor.pin]),
  });

  if (result?.offlineQueued || result?.queued || result?.localOnly) {
    // SAFETY V501: never mark an order paid/dorzim from the client when the
    // ARKA row exists only as an outbox item. The queued ARKA transaction will
    // update the order atomically after it reaches /api/arka/transaction.
    const optimisticPayment = {
      id: result?.queuedOpId || result?.idempotencyKey || null,
      status: 'OFFLINE_QUEUED',
      amount: amt,
      order_id: orderId,
      type: 'IN',
      source_module: 'BASE',
      idempotency_key: result?.idempotencyKey || null,
    };
    return {
      ok: false,
      ...(result || {}),
      queued: true,
      offlineQueued: true,
      pending: true,
      direct: false,
      payment: optimisticPayment,
      row: optimisticPayment,
      error: 'ARKA_PAYMENT_QUEUED_NOT_MARKED_PAID',
      mode: 'ARKA_ENGINE_BASE_ORDER_PAYMENT_OFFLINE_QUEUED_SAFE',
    };
  }

  const payment = result?.payment || result?.row || null;
  const order = result?.order || null;
  if (!payment?.id || !order?.id) {
    return {
      ok: false,
      ...(result || {}),
      pending: false,
      direct: false,
      row: payment,
      payment,
      order,
      error: 'ARKA_PAYMENT_OR_ORDER_VERIFY_FAILED',
      mode: 'ARKA_ENGINE_BASE_ORDER_PAYMENT_VERIFY_FAILED',
    };
  }

  return {
    ok: true,
    ...(result || {}),
    pending: true,
    direct: false,
    payment,
    row: payment,
    order,
    mode: 'ARKA_ENGINE_BASE_ORDER_PAYMENT',
  };
}
