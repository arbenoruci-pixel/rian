import { apiFail, apiOk } from '../_helpers.js';
import { getAdmin, getQuery, getTableColumns, pickKnown, requireBackupPinNode, upsertInChunks } from './_shared.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const auth = requireBackupPinNode(req);
    if (!auth.ok) return apiFail(res, auth.error, auth.status || 401);

    const date = String(getQuery(req, 'date') || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return apiFail(res, 'DATE_REQUIRED', 400, { hint: 'Use YYYY-MM-DD' });
    }
    const dry = String(getQuery(req, 'dry') || '').trim() === '1';
    const sb = getAdmin();

    const { data: snap, error: snapErr } = await sb
      .from('backups_daily')
      .select('backup_date, clients_all, orders_all, clients_cnt, orders_cnt')
      .eq('backup_date', date)
      .maybeSingle();

    if (snapErr) return apiFail(res, 'SUPABASE_BACKUP_SNAPSHOT_FAILED', 500, { detail: snapErr.message });
    if (!snap) return apiFail(res, 'BACKUP_NOT_FOUND', 404, { date });

    const clientsAll = Array.isArray(snap.clients_all) ? snap.clients_all : [];
    const ordersAll = Array.isArray(snap.orders_all) ? snap.orders_all : [];

    const clientCols = await getTableColumns(sb, 'clients');
    const orderCols = await getTableColumns(sb, 'orders');

    const clientsRows = clientsAll.map((c) => pickKnown(c, clientCols)).filter((r) => Object.keys(r).length);
    const ordersRows = ordersAll.map((o) => pickKnown(o, orderCols)).filter((r) => Object.keys(r).length);

    const clientConflict = clientCols.has('id') ? 'id' : (clientCols.has('code') ? 'code' : null);
    const orderConflict = orderCols.has('id') ? 'id' : null;
    if (!clientConflict || !orderConflict) {
      return apiFail(res, 'MISSING_CONFLICT_KEYS', 500, { detail: { clientConflict, orderConflict } });
    }

    if (dry) {
      return apiOk(res, {
        dry: true,
        date,
        snapshot: { clients_cnt: snap.clients_cnt, orders_cnt: snap.orders_cnt },
        will_upsert: { clients: clientsRows.length, orders: ordersRows.length },
      });
    }

    const restoredClients = await upsertInChunks(sb, 'clients', clientsRows, clientConflict);
    const restoredOrders = await upsertInChunks(sb, 'orders', ordersRows, orderConflict);
    return apiOk(res, { date, restored: { clients: restoredClients, orders: restoredOrders } });
  } catch (error) {
    return apiFail(res, 'RESTORE_FAILED', 500, { detail: String(error?.message || error) });
  }
}
