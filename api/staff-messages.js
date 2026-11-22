import { apiFail, apiOk, createAdminClientOrThrow, readBody } from './_helpers.js';
import { authenticateStaffMessagesActor, handleStaffMessages, StaffMessagesError } from '../lib/staffMessagesServer.js';

export const config = { maxDuration: 20 };
const MAX_BODY_BYTES = 24576;

export function createStaffMessagesHandler({ createClient = createAdminClientOrThrow, authenticate = authenticateStaffMessagesActor, action = handleStaffMessages } = {}) {
  return async (req, res) => {
    res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
    res.setHeader('vary', 'Cookie, Origin');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return apiFail(res, 'METHOD_NOT_ALLOWED', 405); }
      const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim().toLowerCase();
      let origin; try { origin = new URL(req.headers?.origin || ''); } catch {}
      if (!origin || !['https:', 'http:'].includes(origin.protocol) || origin.host.toLowerCase() !== host || req.headers?.['sec-fetch-site'] === 'cross-site') return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
      if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return apiFail(res, 'CONTENT_TYPE_NOT_ALLOWED', 415);
      if (Number(req.headers?.['content-length'] || 0) > MAX_BODY_BYTES) return apiFail(res, 'STAFF_MESSAGE_BODY_TOO_LARGE', 413);
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return apiFail(res, 'STAFF_MESSAGE_BODY_INVALID', 400);
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return apiFail(res, 'STAFF_MESSAGE_BODY_TOO_LARGE', 413);
      const cookie = String(req.headers?.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('tepiha_device_id='));
      let deviceId = ''; try { deviceId = decodeURIComponent(cookie?.slice('tepiha_device_id='.length) || ''); } catch {}
      if (!deviceId) return apiFail(res, 'AUTH_REQUIRED', 401);
      const supabase = createClient();
      const actor = await authenticate(supabase, deviceId);
      return apiOk(res, await action(body, { supabase, actor }));
    } catch (error) {
      return apiFail(res, error instanceof StaffMessagesError ? error.code : 'STAFF_MESSAGE_REQUEST_FAILED', error instanceof StaffMessagesError ? error.httpStatus : 503);
    }
  };
}
export default createStaffMessagesHandler();
