import { fetchJsonWithDeadline } from './boundedRequest.js';
import { ensureApprovedDeviceSession } from './deviceSessionRecovery.js';

export async function approvedApiRequest(url, body, { timeoutMs = 15000, signal } = {}) {
  const init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await fetchJsonWithDeadline(url, init, timeoutMs);
    // Repair only a missing/mismatched cookie. Explicit device/role denial stays closed.
    if (attempt === 0 && result.response.status === 401 && result.body?.error === 'AUTH_REQUIRED') {
      const session = await ensureApprovedDeviceSession({ force: true, timeoutMs: 5500 });
      if (session?.offline) throw Object.assign(new Error('DEVICE_SESSION_NETWORK_UNREACHABLE'), { code: 'DEVICE_SESSION_NETWORK_UNREACHABLE' });
      continue;
    }
    if (!result.response.ok || result.body?.ok !== true) {
      const code = String(result.body?.error || 'REQUEST_FAILED');
      throw Object.assign(new Error(code), { code, httpStatus: result.response.status });
    }
    return result.body;
  }
}
