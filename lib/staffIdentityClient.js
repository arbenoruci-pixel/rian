export class StaffIdentityApiError extends Error {
  constructor(code, status = 400, payload = {}) {
    super(String(code || 'STAFF_IDENTITY_REQUEST_FAILED'));
    this.name = 'StaffIdentityApiError';
    this.code = String(code || 'STAFF_IDENTITY_REQUEST_FAILED');
    this.status = Number(status) || 400;
    this.existingUser = payload?.existing_user || null;
    this.currentUser = payload?.current_user || null;
    this.canReactivate = payload?.can_reactivate === true;
  }
}

function createMutationRequestId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {}
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function staffIdentityRequest(body = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new StaffIdentityApiError('FETCH_UNAVAILABLE', 500);

  const source = body && typeof body === 'object' ? body : {};
  const requestBody = {
    ...source,
    idempotencyKey: String(source.idempotencyKey || source.idempotency_key || '').trim()
      || createMutationRequestId(),
  };
  const requestJson = JSON.stringify(requestBody);
  let lastNetworkError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl('/api/admin/staff-identity', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: requestJson,
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt === 0) continue;
      throw new StaffIdentityApiError('STAFF_IDENTITY_NETWORK_FAILED', 503);
    }

    let payload = null;
    try { payload = await response.json(); } catch {}
    if (response.ok && payload?.ok === true) return payload;
    if (attempt === 0 && [502, 503, 504].includes(Number(response.status))) continue;
    throw new StaffIdentityApiError(
      payload?.error || `STAFF_IDENTITY_HTTP_${response.status}`,
      response.status,
      payload || {},
    );
  }

  throw new StaffIdentityApiError(
    lastNetworkError ? 'STAFF_IDENTITY_NETWORK_FAILED' : 'STAFF_IDENTITY_REQUEST_FAILED',
    503,
  );
}
