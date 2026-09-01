import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { authenticateStaffManager } from '../../lib/staffIdentityServer.js';
import { RingIntegrationError } from '../../lib/ringIntegrationServer.js';

export function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie');
}

export function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || '');
  const prefix = `${String(name || '')}=`;
  for (const part of raw.split(';')) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

export function requestOriginAllowed(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host.toLowerCase() === forwardedHost;
  } catch {
    return false;
  }
}

export async function authenticateRingManager(req) {
  const supabase = createAdminClientOrThrow();
  const deviceId = readCookie(req, 'tepiha_device_id');
  const authUser = await authenticateStaffManager(supabase, deviceId);
  return { supabase, authUser };
}

export function safeRingError(error) {
  if (error instanceof RingIntegrationError) return error;
  const code = String(error?.code || error?.message || 'RING_REQUEST_FAILED');
  const status = Number(error?.httpStatus || error?.status || 500);
  return new RingIntegrationError(code, Number.isFinite(status) ? status : 500);
}

export { apiFail, apiOk, readBody };
