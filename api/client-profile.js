import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';
import {
  ClientProfileError,
  authenticateClientProfileViewer,
  buildClientProfile,
  updateBaseClientProfileServer,
} from '../lib/clientProfileServer.js';

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
    try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
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
  if (error instanceof ClientProfileError) return error;
  return new ClientProfileError('CLIENT_PROFILE_REQUEST_FAILED', 500);
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
    const body = await readBody(req);
    const supabase = createAdminClientOrThrow();
    const deviceId = readCookie(req, 'tepiha_device_id');
    const authUser = await authenticateClientProfileViewer(supabase, deviceId);
    const action = String(body?.action || 'GET_PROFILE').trim().toUpperCase();
    const output = action === 'UPDATE_BASE_CLIENT'
      ? await updateBaseClientProfileServer(body, { supabase, authUser })
      : await buildClientProfile(body, { supabase, authUser });
    return apiOk(res, output);
  } catch (error) {
    const safe = safeError(error);
    console.error('[client-profile]', { code: safe.code, status: safe.httpStatus });
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
