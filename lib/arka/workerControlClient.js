const ENDPOINT = '/api/arka/worker-control';

async function postWorkerControl(payload = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });

  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.ok === false) {
    const error = new Error(String(body?.error || `WORKER_CONTROL_HTTP_${response.status}`));
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body || { ok: true };
}

function uniqueKey(prefix, workerPin, amount = 0) {
  let token = '';
  try { token = globalThis.crypto?.randomUUID?.() || ''; } catch { token = ''; }
  if (!token) token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${String(workerPin || '').trim()}:${Number(amount || 0).toFixed(2)}:${token}`.slice(0, 240);
}

export async function createWorkerAdvance({ workerPin, amount, note = 'AVANS' } = {}) {
  return postWorkerControl({
    action: 'CREATE_ADVANCE',
    workerPin: String(workerPin || '').trim(),
    amount: Number(amount || 0),
    note: String(note || 'AVANS').trim() || 'AVANS',
    idempotencyKey: uniqueKey('WORKER_ADVANCE_UI_V3', workerPin, amount),
  });
}

export async function resolveWorkerExpense({
  expensePaymentId,
  resolution,
  beneficiaryPin = null,
  beneficiaryName = null,
  note = '',
} = {}) {
  return postWorkerControl({
    action: 'RESOLVE_EXPENSE',
    expensePaymentId: Number(expensePaymentId || 0),
    resolution: String(resolution || '').trim().toUpperCase(),
    beneficiaryPin,
    beneficiaryName,
    note: String(note || '').trim(),
  });
}
