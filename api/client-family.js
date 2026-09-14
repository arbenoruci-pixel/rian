import { apiFail, apiOk, createAdminClientOrThrow, pickEnv, readBody } from './_helpers.js';
import { authenticateClientProfileViewer } from '../lib/clientProfileServer.js';
import { familyAction } from '../lib/clientFamilyServer.js';

export function createFamilyHandler({ createClient = createAdminClientOrThrow, authenticate = authenticateClientProfileViewer, getSecret = () => pickEnv('FAMILY_LINK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE') } = {}) {
  return async function handler(req, res) {
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
      const origin = req.headers?.origin;
      const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim().toLowerCase();
      if (origin) {
        let parsed; try { parsed = new URL(origin); } catch { return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403); }
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return apiFail(res, 'FAMILY_BODY_INVALID', 400);
      if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024) return apiFail(res, 'BODY_TOO_LARGE', 413);
      const supabase = createClient();
      let authUser;
      if (!['PUBLIC_INFO', 'PUBLIC_ADD', 'RESOLVE_LINK'].includes(body.action)) {
        const cookie = String(req.headers?.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tepiha_device_id='));
        let device = ''; try { device = decodeURIComponent(cookie?.slice('tepiha_device_id='.length) || ''); } catch {}
        authUser = await authenticate(supabase, device);
      }
      return apiOk(res, await familyAction(body, { supabase, authUser, secret: getSecret() }));
    } catch (error) {
      return apiFail(res, /^FAMILY_|^AUTH_|^DEVICE_/.test(error?.code || '') ? error.code : 'FAMILY_REQUEST_FAILED', error?.httpStatus || 503);
    }
  };
}
export default createFamilyHandler();
