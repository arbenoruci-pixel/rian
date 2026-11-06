import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';
import { authenticateBaseCodeStatusActor, readBaseCodeStatuses } from '../lib/baseCodeStatusServer.js';

export function createBaseCodeStatusHandler({ createClient = createAdminClientOrThrow, authenticate = authenticateBaseCodeStatusActor, read = readBaseCodeStatuses } = {}) {
  return async (req, res) => {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) return apiFail(res, 'BASE_CODE_STATUS_BODY_INVALID', 400);
      const cookie = String(req.headers?.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tepiha_device_id='));
      let deviceId = ''; try { deviceId = decodeURIComponent(cookie?.slice('tepiha_device_id='.length) || ''); } catch {}
      // Reject missing sessions before accessing the database.
      if (!deviceId || deviceId.length > 120) return apiFail(res, 'AUTH_REQUIRED', 401);
      const supabase = createClient();
      const actor = await authenticate(supabase, deviceId);
      return apiOk(res, await read(body, { supabase, actor }));
    } catch (error) {
      return apiFail(res, /^(BASE_CODE_STATUS_|AUTH_|DEVICE_)/.test(error?.code || '') ? error.code : 'BASE_CODE_STATUS_REQUEST_FAILED', error?.httpStatus || 503);
    }
  };
}
export default createBaseCodeStatusHandler();
