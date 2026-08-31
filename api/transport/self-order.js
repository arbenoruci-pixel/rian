import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import {
  TransportSelfEntryError,
  authenticateTransportSelfEntryActor,
  createTransportSelfEntryOrderServer,
} from '../../lib/transport/transportSelfEntryServer.js';

function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie, Origin');
}

function readCookie(req, name) {
  const prefix = `${String(name || '')}=`;
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

function requestOriginAllowed(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!host) return false;
  const origin = String(req?.headers?.origin || '').trim();
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host) return false;
    } catch { return false; }
  }
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite === 'cross-site') return false;
  return !!origin || ['same-origin', 'same-site', 'none'].includes(fetchSite);
}

function safeError(error) {
  if (error instanceof TransportSelfEntryError) return error;
  return new TransportSelfEntryError('TRANSPORT_SELF_ENTRY_REQUEST_FAILED', 500);
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (String(req?.method || '').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST');
      return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    }
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
    if (!String(req?.headers?.['content-type'] || '').toLowerCase().includes('application/json')) {
      return apiFail(res, 'CONTENT_TYPE_NOT_ALLOWED', 415);
    }
    const body = await readBody(req);
    if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > 128 * 1024) {
      return apiFail(res, 'TRANSPORT_SELF_ENTRY_BODY_TOO_LARGE', 413);
    }
    const supabase = createAdminClientOrThrow();
    const authUser = await authenticateTransportSelfEntryActor(supabase, readCookie(req, 'tepiha_device_id'));
    const output = await createTransportSelfEntryOrderServer(body, { supabase, authUser });
    return apiOk(res, output);
  } catch (error) {
    const safe = safeError(error);
    console.error('[transport-self-order]', { code: safe.code, status: safe.httpStatus });
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
