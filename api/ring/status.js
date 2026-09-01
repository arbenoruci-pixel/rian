import { getRingStatus } from '../../lib/ringIntegrationServer.js';
import {
  apiFail,
  apiOk,
  authenticateRingManager,
  requestOriginAllowed,
  safeRingError,
  setPrivateNoStore,
} from './_common.js';

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (String(req?.method || '').toUpperCase() !== 'POST') {
      res.setHeader('allow', 'POST');
      return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    }
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);
    const { supabase } = await authenticateRingManager(req);
    const status = await getRingStatus(req, { supabase, syncDevices: true });
    return apiOk(res, status);
  } catch (error) {
    const safe = safeRingError(error);
    console.error('[ring-status]', { code: safe.code, status: safe.httpStatus });
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
