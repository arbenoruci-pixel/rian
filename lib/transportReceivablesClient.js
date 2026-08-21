const ENDPOINT = '/api/transport/receivables';

function randomSuffix() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {}
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

export function newTransportFinanceIdempotencyKey(prefix, orderId) {
  return [String(prefix || 'TRANSPORT_FINANCE').trim(), String(orderId || '').trim(), randomSuffix()]
    .filter(Boolean)
    .join(':')
    .slice(0, 240);
}

async function postReceivableAction(payload, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 12000)));
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok !== true) {
      throw new Error(result?.error || 'TRANSPORT_RECEIVABLE_REQUEST_FAILED');
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('TRANSPORT_RECEIVABLE_NETWORK_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function getTransportReceivableSummary({ orderId = '', clientId = '' } = {}) {
  return postReceivableAction({
    action: 'SUMMARY',
    orderId: String(orderId || '').trim() || null,
    clientId: String(clientId || '').trim() || null,
  });
}

export function deliverTransportOrderWithDebt({
  orderId,
  actorPin,
  dueDate,
  note = '',
  idempotencyKey,
} = {}) {
  return postReceivableAction({
    action: 'DELIVER_WITH_DEBT',
    orderId,
    actorPin,
    dueDate,
    note,
    idempotencyKey,
  });
}

export function collectTransportClientPayment({
  orderId,
  actorPin,
  amountReceived,
  method = 'CASH',
  note = '',
  idempotencyKey,
} = {}) {
  return postReceivableAction({
    action: 'COLLECT_CLIENT_PAYMENT',
    orderId,
    actorPin,
    amountReceived,
    method,
    note,
    idempotencyKey,
  });
}
