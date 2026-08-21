const ENDPOINT = '/api/transport/receivables';

function randomSuffix() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {}
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

function requestError(message, { status = 0, ambiguous = false } = {}) {
  const error = new Error(String(message || 'TRANSPORT_RECEIVABLE_REQUEST_FAILED'));
  error.status = Number(status || 0);
  error.requestAmbiguous = ambiguous === true;
  return error;
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
  let responseReceived = false;

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    responseReceived = true;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw requestError(result?.error || 'TRANSPORT_RECEIVABLE_REQUEST_FAILED', {
        status: response.status,
        ambiguous: false,
      });
    }
    if (result?.ok !== true) {
      throw requestError(result?.error || 'TRANSPORT_RECEIVABLE_RESPONSE_NOT_VERIFIED', {
        status: response.status,
        ambiguous: true,
      });
    }
    return result;
  } catch (error) {
    if (error?.requestAmbiguous === true || error?.requestAmbiguous === false) throw error;
    if (error?.name === 'AbortError') {
      throw requestError('TRANSPORT_RECEIVABLE_NETWORK_TIMEOUT', { ambiguous: true });
    }
    throw requestError(error?.message || 'TRANSPORT_RECEIVABLE_NETWORK_ERROR', {
      ambiguous: !responseReceived,
    });
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
