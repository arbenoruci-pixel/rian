import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';
import { authenticateDispatchOrderActor } from '../lib/transport/dispatchOrderServer.js';
import { inventoryAuditAction } from '../lib/inventoryAuditServer.js';

export const config = { maxDuration: 60 };
export function createInventoryAuditHandler({ createClient = createAdminClientOrThrow, authenticate = authenticateDispatchOrderActor } = {}) {
  return async function handler(req, res) {
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('vary', 'Cookie, Origin');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
      const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim().toLowerCase();
      let origin; try { origin = new URL(req.headers?.origin || ''); } catch {}
      if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host.toLowerCase() !== host || req.headers?.['sec-fetch-site'] === 'cross-site') return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
      if (!String(req.headers?.['content-type'] || '').includes('application/json')) return apiFail(res, 'CONTENT_TYPE_NOT_ALLOWED', 415);
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 16384) return apiFail(res, 'AUDIT_BODY_INVALID', 400);
      const cookie = String(req.headers?.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tepiha_device_id='));
      let deviceId = ''; try { deviceId = decodeURIComponent(cookie?.slice('tepiha_device_id='.length) || ''); } catch {}
      const supabase = createClient();
      const authUser = await authenticate(supabase, deviceId);
      return apiOk(res, await inventoryAuditAction(body, { supabase, authUser }));
    } catch (error) {
      const code = /^(AUDIT_|AUTH_|DEVICE_|DISPATCH_ORDER_ACTOR_)/.test(error?.code || '') ? error.code : 'AUDIT_REQUEST_FAILED';
      return apiFail(res, code, error?.httpStatus || 503);
    }
  };
}
export default createInventoryAuditHandler();
