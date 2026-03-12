import { recordCashMove, createPendingCashPayment } from '@/lib/arkaCashSync';

function readActorFromLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
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
 * Centralized CASH payment recorder (ARKA open => cycle move, ARKA closed => pending).
 * - Always records the EXACT amount that should enter the system (not "client gave").
 * - Supports both object style and legacy positional style used by /gati.
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

  const extId =
    input.externalId ||
    input.external_id ||
    `pay_${String(input.orderId || 'no_order')}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const basePayload = {
    externalId: extId,
    orderId: input.orderId || null,
    code: input.code || null,
    name: input.clientName || input.name || null,
    amount: amt,
    note:
      input.note ||
      `PAGESA ${amt}€ • #${input.code || ''} • ${input.clientName || input.name || ''}`.trim(),
    source: input.source || 'ORDER_PAY',
    method: 'cash_pay',
    type: String(input.type || 'IN').toUpperCase(),
    createdByPin: actor?.pin ? String(actor.pin) : null,
    createdByName: actor?.name ? String(actor.name) : null,
    createdByRole: actor?.role ? String(actor.role) : null,
  };

  try {
    return await recordCashMove(basePayload);
  } catch (e) {
    return await createPendingCashPayment({
      external_id: extId,
      orderId: input.orderId || null,
      code: input.code || null,
      name: input.clientName || input.name || null,
      amount: amt,
      note: basePayload.note,
      source: input.source || 'ORDER_PAY',
      type: String(input.type || 'IN').toUpperCase(),
      created_by_pin: actor?.pin ? String(actor.pin) : null,
      created_by_name: actor?.name ? String(actor.name) : null,
      created_by_role: actor?.role ? String(actor.role) : null,
    });
  }
}
