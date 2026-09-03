// Low-level ARKA HTTP transport. Keep this file dependency-light so both the
// live client and the offline sync engine can use the same request behavior.

export const ARKA_HTTP_TIMEOUT_MS = 15000;
export const ARKA_SYNC_HTTP_TIMEOUT_MS = 10000;

function makeAbortError(message = 'ARKA_HTTP_TIMEOUT') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.network = true;
  return err;
}

export function isArkaNetworkError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status || 0);
  return (
    error?.network === true ||
    name === 'aborterror' ||
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('ark_http_timeout') ||
    msg.includes('arka_http_timeout') ||
    msg.includes('aborted') ||
    status === 0
  );
}

export function normalizeArkaHttpError(error) {
  if (!isArkaNetworkError(error)) return error;
  const err = new Error('ARKA_NETWORK_UNREACHABLE');
  err.cause = error;
  err.network = true;
  err.status = 0;
  return err;
}

function isDeviceAuthorizationError(error) {
  const code = String(error?.response?.error || error?.code || error?.message || error || '').trim().toUpperCase();
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 401
    || code.includes('DEVICE_NOT_APPROVED')
    || code.includes('DEVICE_LINKED_TO_OTHER_USER')
    || code.includes('AUTH_REQUIRED')
    || code.includes('ACTOR_SESSION_MISMATCH')
    || code.includes('ROLE_MISMATCH')
    || code.includes('PIN_RETIRED_USE_CURRENT_PIN')
    || code.includes('USER_DISABLED');
}

async function syncStableDeviceCookie() {
  if (typeof window === 'undefined') return;
  try {
    const mod = await import('../deviceId.js');
    if (typeof mod?.getDeviceId === 'function') mod.getDeviceId();
  } catch {}
}

async function repairApprovedDeviceSession(payload = {}, opts = {}) {
  const mod = await import('../deviceSessionRecovery.js');
  if (typeof mod?.ensureApprovedDeviceSession !== 'function') throw new Error('DEVICE_SESSION_RECOVERY_UNAVAILABLE');
  const actorPin = String(payload?.actorPin || payload?.actor_pin || '').trim();
  const actor = actorPin ? {
    pin: actorPin,
    name: payload?.actorName || payload?.actor_name || '',
    role: payload?.actorRole || payload?.actor_role || '',
  } : undefined;
  const timeoutMs = Math.min(4000, Math.max(1200, Number(opts?.recoveryTimeoutMs || 4000)));
  return mod.ensureApprovedDeviceSession({ actor, force: true, timeoutMs });
}

async function postArkaTransactionOnce(payload = {}, opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Math.max(1000, Number(opts.timeoutMs)) : ARKA_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout = null;
  let externalAbort = null;

  try {
    timeout = setTimeout(() => {
      try { controller.abort(makeAbortError('ARKA_HTTP_TIMEOUT')); } catch { controller.abort(); }
    }, timeoutMs);

    if (opts?.signal) {
      externalAbort = () => {
        try { controller.abort(opts.signal.reason || makeAbortError('ARKA_HTTP_ABORTED')); } catch { controller.abort(); }
      };
      if (opts.signal.aborted) externalAbort();
      else opts.signal.addEventListener('abort', externalAbort, { once: true });
    }

    const res = await fetch('/api/arka/transaction', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok || data?.ok === false) {
      const err = new Error(data?.error || data?.message || `ARKA_HTTP_${res.status}`);
      err.response = data;
      err.status = res.status;
      err.server = true;
      throw err;
    }

    return data || { ok: true };
  } catch (error) {
    if (isArkaNetworkError(error)) throw normalizeArkaHttpError(error);
    throw error;
  } finally {
    try { if (timeout) clearTimeout(timeout); } catch {}
    try { if (opts?.signal && externalAbort) opts.signal.removeEventListener('abort', externalAbort); } catch {}
  }
}

export async function postArkaTransaction(payload = {}, opts = {}) {
  // iOS can retain localStorage while dropping/replacing the request cookie.
  // Re-emit the stable device ID before every protected ARKA request.
  const startedAt = Date.now();
  await syncStableDeviceCookie();
  try {
    return await postArkaTransactionOnce(payload, opts);
  } catch (error) {
    if (opts?.repairDeviceSession === false || !isDeviceAuthorizationError(error)) throw error;

    // Re-authenticating with the already stored worker PIN only repairs an
    // existing approved device. /api/auth/login still rejects unknown devices.
    await repairApprovedDeviceSession(payload, opts);
    const totalBudgetMs = Math.max(3000, Number(opts?.totalTimeoutMs || 11000));
    const remainingMs = Math.max(1000, totalBudgetMs - (Date.now() - startedAt));
    const retryTimeoutMs = Math.min(
      Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : ARKA_HTTP_TIMEOUT_MS,
      remainingMs,
    );
    return postArkaTransactionOnce(payload, {
      ...opts,
      timeoutMs: retryTimeoutMs,
      repairDeviceSession: false,
    });
  }
}
