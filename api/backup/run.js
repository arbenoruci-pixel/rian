import { apiFail, apiOk } from '../_helpers.js';
import { buildLivePayload, detectBackupsTable, getAdmin, requireBackupPinNode } from './_shared.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const auth = requireBackupPinNode(req, { allowCron: true });
    if (!auth.ok) return apiFail(res, auth.error, auth.status || 401);

    const sb = getAdmin();
    const table = await detectBackupsTable(sb);
    const backup = await buildLivePayload(sb);
    const row = {
      created_at: new Date().toISOString(),
      payload: backup.payload,
    };
    if (auth.via === 'pin' && auth.pin) row.pin = auth.pin;

    const { error } = await sb.from(table).insert([row]);
    if (error) throw error;

    return apiOk(res, {
      saved: {
        clients_cnt: backup.clients_count,
        orders_cnt: backup.orders_count,
        open_orders_cnt: backup.open_orders_count,
      },
    });
  } catch (error) {
    return apiFail(res, 'BACKUP_FAILED', 500, { detail: String(error?.message || error) });
  }
}
