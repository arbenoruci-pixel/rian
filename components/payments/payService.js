import { recordCashMove } from '@/lib/arkaCashSync';

/**
 * Centralized CASH payment recorder (ARKA open => cycle move, ARKA closed => pending).
 * - Always records the EXACT amount that should enter the system (not "client gave").
 * - Generates unique external_id automatically if not provided.
 */
export async function recordOrderCashPayment({
  orderId,
  code,
  clientName,
  amount,
  note,
  source = 'ORDER_PAY',
  type = 'IN',
  user = null, // {pin,name} optional
  externalId = null,
} = {}) {
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'AMOUNT_INVALID' };

  let actor = user;
  if (!actor) {
    try {
      const raw = localStorage.getItem('CURRENT_USER_DATA');
      actor = raw ? JSON.parse(raw) : null;
    } catch {}
  }

  const extId =
    externalId ||
    `pay_${String(orderId || 'no_order')}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  return await recordCashMove({
    externalId: extId,
    orderId: orderId || null,
    code: code || null,
    name: clientName || null,
    amount: amt,
    note: note || `PAGESA ${amt}€ • #${code || ''} • ${clientName || ''}`.trim(),
    source,
    method: 'cash_pay',
    type,
    createdByPin: actor?.pin ? String(actor.pin) : null,
    createdBy: actor?.name ? String(actor.name) : null,
  });
}
