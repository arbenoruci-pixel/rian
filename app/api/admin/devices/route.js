export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

import { apiOk, apiFail, createServiceClientOrThrow, logApiError, readBody } from '@/lib/apiService';
import {
  StaffIdentityMutationError,
  authenticateStaffManager,
} from '@/lib/staffIdentityServer';
import {
  DeviceAdminError,
  runDeviceAdminAction,
} from '@/lib/deviceAdminServer';

function withPrivateNoStore(response) {
  response.headers.set('cache-control', 'private, no-store, max-age=0, must-revalidate');
  response.headers.set('pragma', 'no-cache');
  response.headers.set('expires', '0');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('vary', 'Cookie');
  return response;
}

function readCookie(req, name) {
  const raw = String(req?.headers?.get?.('cookie') || '');
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
  const origin = String(req?.headers?.get?.('origin') || '').trim();
  if (!origin) return true;
  const forwardedHost = String(
    req?.headers?.get?.('x-forwarded-host') || req?.headers?.get?.('host') || '',
  ).split(',')[0].trim().toLowerCase();
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

export async function POST(req) {
  try {
    if (!requestOriginAllowed(req)) return withPrivateNoStore(apiFail('ORIGIN_NOT_ALLOWED', 403));

    const supabase = createServiceClientOrThrow();
    const body = await readBody(req);
    const deviceId = readCookie(req, 'tepiha_device_id');
    const authUser = await authenticateStaffManager(supabase, deviceId);
    const output = await runDeviceAdminAction(body, { supabase, authUser });
    return withPrivateNoStore(apiOk(output));
  } catch (error) {
    const safe = safeError(error);
    logApiError('api.admin.devices', safe, { code: safe.code, status: safe.httpStatus });
    return withPrivateNoStore(apiFail(safe.code, safe.httpStatus, safe.extra));
  }
}
