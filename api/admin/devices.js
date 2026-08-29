import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import {
  StaffIdentityMutationError,
  authenticateStaffManager,
} from '../../lib/staffIdentityServer.js';
import {
  DeviceAdminError,
  runDeviceAdminAction,
} from '../../lib/deviceAdminServer.js';

function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie');
}

function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || '');
  const prefix = `${String(name || '')}=`;
  for (const part of raw.split(';')) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      return '';
    }
  }
  return '';
}

function requestOriginAllowed(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.host.toLowerCase() === forwardedHost;
  } catch {
    return false;
  }
}

function safeError(error) {
  if (error instanceof DeviceAdminError || error instanceof StaffIdentityMutationError) return error;
  return new DeviceAdminError('DEVICE_ADMIN_REQUEST_FAILED', 500);
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (String(req?.method || '').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST');
      return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    }
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);

    const body = await readBody(req);
    const supabase = createAdminClientOrThrow();
    const deviceId = readCookie(req, 'tepiha_device_id');
    const authUser = await authenticateStaffManager(supabase, deviceId);
    const output = await runDeviceAdminAction(body, { supabase, authUser });
    return apiOk(res, output);
  } catch (error) {
    const safe = safeError(error);
    console.error('[admin-devices]', {
      code: safe.code,
      status: safe.httpStatus,
    });
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
