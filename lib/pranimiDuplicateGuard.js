import { normalizeTransportPhoneKey } from './transport/phone.js';

export const PRANIMI_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

// This is an advisory check: staff can explicitly confirm a separate visit.
// A retry with the same local_oid must continue through the idempotent save path.
export function findRecentPranimiDuplicate(rows, incoming, now = Date.now()) {
  const data = incoming?.data || {};
  const localOid = String(incoming?.local_oid || data.local_oid || '');
  const clientId = String(incoming?.client_id || data.client?.id || '');
  const phone = normalizeTransportPhoneKey(incoming?.client_phone || data.client?.phone || '');
  return (Array.isArray(rows) ? rows : []).find(row => {
    const rd = row?.data || {};
    if (row.table && row.table !== 'orders') return false;
    if (localOid && String(row.local_oid || rd.local_oid || '') === localOid) return false;
    if (!['pastrim', 'gati'].includes(String(row.status || rd.status || '').toLowerCase())) return false;
    const created = new Date(row.created_at || rd.created_at || rd.ts || 0).getTime();
    if (!Number.isFinite(created) || created > now || now - created > PRANIMI_DUPLICATE_WINDOW_MS) return false;
    const otherId = String(row.client_id || rd.client?.id || '');
    const otherPhone = normalizeTransportPhoneKey(row.client_phone || rd.client?.phone || '');
    const sameClient = clientId && otherId ? clientId === otherId : phone.length === 8 && phone === otherPhone;
    if (!sameClient) return false;
    return ['pieces', 'm2_total', 'price_total'].every(key => {
      const a = Number(incoming[key] ?? data[key]);
      const b = Number(row[key] ?? rd[key]);
      return Number.isFinite(a) && Number.isFinite(b) && a > 0 && Math.abs(a - b) < 0.005;
    });
  }) || null;
}
