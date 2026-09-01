import { createAdminClientOrThrow } from '../_helpers.js';
import { getOneWayRingStatus, listRingHistory } from '../../lib/ringOneWayServer.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    const supabase = createAdminClientOrThrow();
    const status = await getOneWayRingStatus({ supabase, syncDevices: true });
    const after = String(req.query.after || '');
    const before = String(req.query.before || '');
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 100)));
    const devices = Array.isArray(status.devices) ? status.devices : [];
    const histories = [];
    for (const device of devices) {
      try {
        const history = await listRingHistory({ supabase, deviceId: device.id, limit, after, before });
        histories.push({ device, history });
      } catch (error) {
        histories.push({ device, error: String(error?.code || error?.message || 'HISTORY_FAILED'), extra: error?.extra || null });
      }
    }
    return res.status(200).json({ ok: true, status, after, before, histories });
  } catch (error) {
    return res.status(Number(error?.httpStatus || 500)).json({ ok: false, error: String(error?.code || error?.message || 'DEBUG_FAILED'), extra: error?.extra || null });
  }
}
