import { apiFail, apiOk } from '../_helpers.js';
import { buildLivePayload, detectBackupsTable, getAdmin, getQuery, normalizeLatestRow, requireBackupPinNode } from './_shared.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const auth = requireBackupPinNode(req);
    if (!auth.ok) return apiFail(res, auth.error, auth.status || 401);

    const pin = String(getQuery(req, 'pin') || '').trim();
    const raw = String(getQuery(req, 'raw') || '') === '1';
    const live = String(getQuery(req, 'live') || '') === '1';

    const sb = getAdmin();

    if (live) {
      const backup = await buildLivePayload(sb);
      if (raw) {
        const filename = `tepiha_live_${backup.backup_date}.json`;
        const body = JSON.stringify(backup.payload, null, 2);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('cache-control', 'no-store');
        return res.end(body);
      }
      return apiOk(res, { backup, source: 'live' });
    }

    const table = await detectBackupsTable(sb);
    let q = sb.from(table).select('*').order('created_at', { ascending: false }).limit(1);
    if (pin) q = q.eq('pin', pin);
    const { data, error } = await q;
    if (error) return apiFail(res, 'SUPABASE_BACKUPS_QUERY_FAILED', 500, { detail: error.message });

    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (!row) return apiOk(res, { backup: null });
    const backup = normalizeLatestRow(row);

    if (raw) {
      const filename = `tepiha_backup_${backup.backup_date || 'latest'}_${String(backup.id || '').slice(0, 8)}.json`;
      const body = JSON.stringify(backup.payload || { clients: backup.clients, orders: backup.orders }, null, 2);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.setHeader('cache-control', 'no-store');
      return res.end(body);
    }

    return apiOk(res, { backup, source: 'snapshot' });
  } catch (error) {
    return apiFail(res, 'UNEXPECTED', 500, { detail: String(error?.message || error) });
  }
}
