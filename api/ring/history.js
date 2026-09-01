import { authenticateRingManager, apiFail, apiOk, safeRingError, setPrivateNoStore } from './_common.js';
import { listRingHistory } from '../../lib/ringOneWayServer.js';

export default async function handler(req, res) {
  setPrivateNoStore(res);
  if (String(req.method || '').toUpperCase() !== 'GET') {
    res.setHeader('allow', 'GET');
    return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  }
  try {
    const { supabase } = await authenticateRingManager(req);
    const deviceId = String(req.query?.device_id || '').trim();
    if (!deviceId) return apiFail(res, 'DEVICE_ID_REQUIRED', 400);
    const data = await listRingHistory({
      supabase,
      deviceId,
      limit: Number(req.query?.limit || 50),
      before: String(req.query?.before || ''),
      after: String(req.query?.after || ''),
    });
    return apiOk(res, { deviceId, data });
  } catch (error) {
    const safe = safeRingError(error);
    return apiFail(res, safe.code, safe.httpStatus, safe.extra);
  }
}
