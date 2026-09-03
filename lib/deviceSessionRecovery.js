// Keep the browser device cookie and the approved worker session aligned before
// protected money writes. Unknown devices still fail closed at /api/auth/login.

import { cacheApprovedLogin, canLoginOffline } from './deviceApprovalsCache.js';
import { getDeviceId } from './deviceId.js';
import { rolesCompatible } from './roles.js';
import { persistMainSession, readBestActor } from './sessionStore.js';

const DEFAULT_TIMEOUT_MS = 5500;
const DEFAULT_FRESH_MS = 5 * 60 * 1000;
const OFFLINE_APPROVAL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let lastVerified = null;
let inFlight = null;

function clean(value) {
  return String(value ?? '').trim();
}

function sessionKey(actor, deviceId) {
  return [clean(actor?.pin), clean(actor?.role).toUpperCase(), clean(deviceId)].join(':');
}

function makeSessionError(code, details = {}) {
  const error = new Error(clean(code) || 'DEVICE_SESSION_VERIFY_FAILED');
  error.code = clean(code) || 'DEVICE_SESSION_VERIFY_FAILED';
  Object.assign(error, details || {});
  return error;
}

function isNetworkFailure(error) {
  const text = clean(error?.message || error).toLowerCase();
  return error?.network === true
    || String(error?.name || '').toLowerCase() === 'aborterror'
    || text.includes('failed to fetch')
    || text.includes('load failed')
    || text.includes('network')
    || text.includes('timeout')
    || text.includes('aborted');
}

export function isDeviceSessionError(error) {
  const code = clean(error?.response?.error || error?.code || error?.message || error).toUpperCase();
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 401
    || status === 403
    || code.includes('DEVICE_NOT_APPROVED')
    || code.includes('DEVICE_LINKED_TO_OTHER_USER')
    || code.includes('AUTH_REQUIRED')
    || code.includes('ACTOR_SESSION_MISMATCH')
    || code.includes('ROLE_MISMATCH')
    || code.includes('PIN_RETIRED_USE_CURRENT_PIN')
    || code.includes('USER_DISABLED');
}

function readOfflineApproval(actor, deviceId) {
  const approval = canLoginOffline({
    pin: clean(actor?.pin),
    role: clean(actor?.role),
    deviceId: clean(deviceId),
  });
  // A payment may rely on offline trust only when a successful online login
  // explicitly cached this exact PIN/role/device tuple during the current
  // working day. Old, unbounded approvals are never enough for money intake.
  const verifiedAt = Number(approval?.verifiedAt || 0);
  const fresh = verifiedAt > 0 && (Date.now() - verifiedAt) <= OFFLINE_APPROVAL_MAX_AGE_MS;
  return approval?.ok && approval?.source === 'approval-cache' && fresh ? approval : null;
}

async function requestApprovedSession({ actor, deviceId, timeoutMs }) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  try {
    if (controller) {
      timer = setTimeout(() => {
        try { controller.abort(); } catch {}
      }, Math.max(1200, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));
    }

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: clean(actor?.pin),
        role: clean(actor?.role),
        deviceId: clean(deviceId),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok || data?.ok !== true) {
      throw makeSessionError(data?.error || data?.message || `DEVICE_SESSION_HTTP_${response.status}`, {
        status: response.status,
        response: data,
        server: true,
      });
    }
    const verifiedPin = clean(data?.actor?.pin);
    const verifiedRole = clean(data?.actor?.role).toUpperCase();
    const verifiedDeviceId = clean(data?.actor?.device_id || data?.actor?.deviceId);
    if (
      verifiedPin !== clean(actor?.pin)
      || !verifiedRole
      || (clean(actor?.role) && !rolesCompatible(actor.role, verifiedRole))
      || verifiedDeviceId !== clean(deviceId)
    ) {
      throw makeSessionError('DEVICE_SESSION_INVALID_RESPONSE', {
        status: response.status,
        server: true,
      });
    }
    return data || { ok: true, actor };
  } catch (error) {
    if (isNetworkFailure(error)) {
      throw makeSessionError('DEVICE_SESSION_NETWORK_UNREACHABLE', {
        cause: error,
        name: error?.name || 'NetworkError',
        network: true,
        status: 0,
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureApprovedDeviceSession(options = {}) {
  if (typeof window === 'undefined') return { ok: true, server: true };

  const actor = options?.actor?.pin ? options.actor : readBestActor({ allowTransportFallback: true });
  const deviceId = getDeviceId(); // Also rewrites the cookie from the stable local ID.
  if (!actor?.pin || !deviceId || deviceId === 'unknown') {
    throw makeSessionError('AUTH_REQUIRED', { status: 401 });
  }

  const key = sessionKey(actor, deviceId);
  const freshMs = Math.max(0, Number(options?.freshMs ?? DEFAULT_FRESH_MS));
  if (
    options?.force !== true
    && lastVerified?.key === key
    && Date.now() - Number(lastVerified?.at || 0) <= freshMs
  ) {
    return { ok: true, cached: true, actor: lastVerified.actor || actor, deviceId };
  }

  const offlineApproval = readOfflineApproval(actor, deviceId);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!online) {
    if (offlineApproval) return { ok: true, offline: true, locallyApproved: true, actor, deviceId };
    throw makeSessionError('DEVICE_APPROVAL_OFFLINE_UNVERIFIED', { status: 403 });
  }

  if (inFlight?.key === key) return inFlight.promise;

  const promise = (async () => {
    try {
      const result = await requestApprovedSession({
        actor,
        deviceId,
        timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      const verifiedActor = result?.actor || actor;
      try {
        persistMainSession({ ...actor, ...verifiedActor, device_id: deviceId }, {
          device_verified_at: new Date().toISOString(),
          device_id: deviceId,
        });
      } catch {}
      try {
        cacheApprovedLogin({
          pin: verifiedActor?.pin || actor.pin,
          role: verifiedActor?.role || actor.role,
          deviceId,
          actor: { ...actor, ...verifiedActor, device_id: deviceId },
        });
      } catch {}
      lastVerified = { key, at: Date.now(), actor: verifiedActor };
      return { ok: true, repaired: true, actor: verifiedActor, deviceId };
    } catch (error) {
      // A temporary connection failure may use the explicit approval cache and
      // hand the idempotent payment to the durable outbox. Explicit 401/403
      // responses never receive this fallback.
      if (isNetworkFailure(error) && offlineApproval) {
        return { ok: true, offline: true, locallyApproved: true, actor, deviceId };
      }
      throw error;
    } finally {
      if (inFlight?.key === key) inFlight = null;
    }
  })();

  inFlight = { key, promise };
  return promise;
}

export function invalidateApprovedDeviceSession() {
  lastVerified = null;
}
