import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean : '';
}

function cleanKey(value) {
  return String(value || '').trim().slice(0, 240);
}

async function callRpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || error.code || name + '_FAILED');
  if (!data || data.ok !== true) throw new Error(name + '_NOT_VERIFIED');
  return data;
}

export default async function handler(req, res) {
  let action = '';
  let orderId = '';
  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);

    const body = typeof readBody === 'function' ? await readBody(req) : (req.body || {});
    action = String(body?.action || '').trim().toUpperCase();
    orderId = cleanUuid(body?.orderId || body?.order_id);
    const clientId = cleanUuid(body?.clientId || body?.client_id);
    const supabase = createAdminClientOrThrow();

    if (action === 'SUMMARY') {
      if (!orderId && !clientId) return apiFail(res, 'ORDER_OR_CLIENT_ID_REQUIRED', 400);
      const result = await callRpc(supabase, 'transport_client_receivable_summary_v1', {
        p_order_id: orderId || null,
        p_client_id: clientId || null,
      });
      return apiOk(res, result);
    }

    if (action === 'DELIVER_WITH_DEBT') {
      if (!orderId) return apiFail(res, 'ORDER_ID_INVALID', 400);
      const actorPin = String(body?.actorPin || body?.actor_pin || '').replace(/\D/g, '').slice(0, 12);
      const dueDate = String(body?.dueDate || body?.due_date || '').trim();
      const idempotencyKey = cleanKey(body?.idempotencyKey || body?.idempotency_key);
      if (!actorPin) return apiFail(res, 'ACTOR_PIN_REQUIRED', 400);
      if (dueDate && !DATE_RE.test(dueDate)) return apiFail(res, 'DUE_DATE_INVALID', 400);
      if (!idempotencyKey) return apiFail(res, 'IDEMPOTENCY_KEY_REQUIRED', 400);

      const result = await callRpc(supabase, 'transport_deliver_with_debt_v1', {
        p_order_id: orderId,
        p_actor_pin: actorPin,
        p_due_date: dueDate || null,
        p_note: String(body?.note || '').trim().slice(0, 500) || null,
        p_idempotency_key: idempotencyKey,
      });
      return apiOk(res, result);
    }

    if (action === 'COLLECT_CLIENT_PAYMENT') {
      if (!orderId) return apiFail(res, 'ORDER_ID_INVALID', 400);
      const actorPin = String(body?.actorPin || body?.actor_pin || '').replace(/\D/g, '').slice(0, 12);
      const amountReceived = Number(body?.amountReceived ?? body?.amount_received);
      const method = String(body?.method || 'CASH').trim().toUpperCase();
      const idempotencyKey = cleanKey(body?.idempotencyKey || body?.idempotency_key);
      if (!actorPin) return apiFail(res, 'ACTOR_PIN_REQUIRED', 400);
      if (!Number.isFinite(amountReceived) || amountReceived <= 0) return apiFail(res, 'AMOUNT_INVALID', 400);
      if (method !== 'CASH') return apiFail(res, 'ONLY_CASH_SUPPORTED', 400);
      if (!idempotencyKey) return apiFail(res, 'IDEMPOTENCY_KEY_REQUIRED', 400);

      const result = await callRpc(supabase, 'transport_collect_client_payment_v1', {
        p_order_id: orderId,
        p_actor_pin: actorPin,
        p_amount_received: Math.round((amountReceived + Number.EPSILON) * 100) / 100,
        p_method: method,
        p_note: String(body?.note || '').trim().slice(0, 500) || null,
        p_idempotency_key: idempotencyKey,
      });
      return apiOk(res, result);
    }

    return apiFail(res, 'ACTION_INVALID', 400);
  } catch (error) {
    console.error('[transport-receivables]', {
      action,
      orderId: orderId || null,
      code: String(error?.code || ''),
      message: String(error?.message || error || 'UNKNOWN_ERROR').slice(0, 300),
    });
    return apiFail(res, error, 400);
  }
}
