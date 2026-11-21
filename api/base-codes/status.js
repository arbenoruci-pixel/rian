import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import {
  BaseCodeStatusError,
  authenticateBaseCodeStatusActor,
  readBaseCodeStatuses,
} from '../../lib/baseCodeStatusServer.js';

const MAX_BODY_BYTES = 8192;

function originAllowed(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0].trim().toLowerCase();
  if (!host || String(req?.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  try {
    const origin = new URL(String(req?.headers?.origin || ''));
    return ['https:', 'http:'].includes(origin.protocol) && origin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function readDeviceCookie(req) {
  const prefix = 'tepiha_device_id=';
  for (const value of String(req?.headers?.cookie || '').split(';')) {
    const cookie = value.trim();
    if (!cookie.startsWith(prefix)) continue;
    try { return decodeURIComponent(cookie.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

export function createBaseCodeStatusHandler({ createClient = createAdminClientOrThrow } = {}) {
  return async function handler(req, res) {
    res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('expires', '0');
    res.setHeader('vary', 'Cookie, Origin');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (String(req?.method || '').toUpperCase() !== 'POST') {
        res.setHeader('allow', 'POST');
        return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
      }
      if (!originAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
      if (String(req?.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return apiFail(res, 'CONTENT_TYPE_NOT_ALLOWED', 415);
      }
      if (Number(req?.headers?.['content-length'] || 0) > MAX_BODY_BYTES) {
        return apiFail(res, 'BASE_CODE_STATUS_BODY_TOO_LARGE', 413);
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return apiFail(res, 'BASE_CODE_STATUS_BODY_INVALID', 400);
      }
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
        return apiFail(res, 'BASE_CODE_STATUS_BODY_TOO_LARGE', 413);
      }
      const deviceId = readDeviceCookie(req);
      if (!deviceId) return apiFail(res, 'AUTH_REQUIRED', 401);
      const supabase = createClient();
      const authUser = await authenticateBaseCodeStatusActor(supabase, deviceId);
      return apiOk(res, await readBaseCodeStatuses(body, { supabase, authUser }));
    } catch (error) {
      if (error instanceof BaseCodeStatusError) return apiFail(res, error.code, error.httpStatus);
      return apiFail(res, 'BASE_CODE_STATUS_REQUEST_FAILED', 503);
    }
  };
}

export default createBaseCodeStatusHandler();
