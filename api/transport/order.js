import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { editDispatchOrderServer } from '../../lib/transport/dispatchEditServer.js';
import {
  DispatchOrderServerError,
  authenticateDispatchOrderActor,
  createDispatchTransportPranimiOrderServer,
  createDispatchTransportOrderServer,
  inspectDispatchTransportPhoneServer,
  listDispatchTransportOrdersServer,
  editDispatchTransportClientServer,
} from '../../lib/transport/dispatchOrderServer.js';

function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie, Origin');
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
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost) return false;

  const origin = String(req?.headers?.origin || '').trim();
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== forwardedHost) return false;
    } catch {
      return false;
    }
  }

  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite === 'cross-site') return false;
  return !!origin || ['same-origin', 'same-site', 'none'].includes(fetchSite);
}

function contentTypeAllowed(req) {
  return String(req?.headers?.['content-type'] || '').toLowerCase().includes('application/json');
}

function safeError(error) {
  if (error instanceof DispatchOrderServerError) return error;
  return new DispatchOrderServerError('DISPATCH_ORDER_REQUEST_FAILED', 500);
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  let requestAction = 'CREATE';
  setPrivateNoStore(res);
  try {
    if (String(req?.method || '').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST');
      return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    }
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
    if (!contentTypeAllowed(req)) return apiFail(res, 'CONTENT_TYPE_NOT_ALLOWED', 415);

    const body = await readBody(req);
    const bodySize = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');
    if (bodySize > 96 * 1024) return apiFail(res, 'DISPATCH_ORDER_BODY_TOO_LARGE', 413);

    const supabase = createAdminClientOrThrow();
    const deviceId = readCookie(req, 'tepiha_device_id');
    const action = String(body?.action || '').trim().toUpperCase();
    requestAction = ['LIST', 'PHONE_CHECK', 'EDIT_ORDER', 'CLIENT_ADMIN_EDIT'].includes(action) ? action : 'CREATE';
    console.info('[transport-order]', { action: requestAction, stage: 'received' });
    const authUser = await authenticateDispatchOrderActor(supabase, deviceId);
    if (action === 'LIST') {
      const output = await listDispatchTransportOrdersServer(body, { supabase, authUser });
      console.info('[transport-order]', { action: requestAction, ok: true, count: output.items.length, durationMs: Date.now() - startedAt });
      return apiOk(res, output);
    }
    if (action === 'EDIT_ORDER') return apiOk(res, await editDispatchOrderServer(body, { supabase, authUser }));
    if (action === 'PHONE_CHECK') {
      const inspection = await inspectDispatchTransportPhoneServer(body, { supabase, authUser });
      console.info('[transport-order]', { action: requestAction, ok: true, durationMs: Date.now() - startedAt });
      return apiOk(res, inspection);
    }
    if (action === 'CLIENT_ADMIN_EDIT') {
      // Older installed clients send a second unguarded JSON write after this call.
      // Require the new atomic edit contract before allowing a client edit.
      return apiFail(res, 'DISPATCH_EDIT_REFRESH_APP_REQUIRED', 409);
    }
    const flow = String(body?.flow || '').trim().toUpperCase();
    const output = flow === 'PRANIMI'
      ? await createDispatchTransportPranimiOrderServer(body, { supabase, authUser })
      : await createDispatchTransportOrderServer(body, { supabase, authUser });
    console.info('[transport-order]', { action: requestAction, ok: true,
      recoveredStaleIntent: output?.recoveredStaleIntent === true,
      idempotent: output?.idempotent === true, durationMs: Date.now() - startedAt });
    return apiOk(res, output);
  } catch (error) {
    const safe = safeError(error);
    console.error('[transport-order]', { code: safe.code, status: safe.httpStatus,
      action: requestAction, durationMs: Date.now() - startedAt });
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
