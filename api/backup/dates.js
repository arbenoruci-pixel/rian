import { apiFail, apiOk } from '../_helpers.js';
import { getAdmin, getQuery, requireBackupPinNode } from './_shared.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const auth = requireBackupPinNode(req);
    if (!auth.ok) return apiFail(res, auth.error, auth.status || 401);

    const sb = getAdmin();
    const limit = Math.min(Math.max(Number(getQuery(req, 'limit') || 30), 1), 365);
    const { data, error } = await sb
      .from('backups_daily')
      .select('backup_date, clients_cnt, orders_cnt, open_orders_cnt, created_at')
      .order('backup_date', { ascending: false })
      .limit(limit);

    if (error) return apiFail(res, 'SUPABASE_BACKUPS_DAILY_QUERY_FAILED', 500, { detail: error.message });
    return apiOk(res, { items: data || [] });
  } catch (error) {
    return apiFail(res, 'DATES_FAILED', 500, { detail: String(error?.message || error) });
  }
}
