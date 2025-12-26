// Shared ARKA cash recorder used by PRANIMI / PASTRIMI / GATI.
// Supabase is master (arka_days + arka_moves). localStorage remains an optional cache.

import { dbCanWork, dbGetOpenDay, dbAddMove } from '@/lib/arkaDb';

function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function getCurrentUserName() {
  if (typeof window === 'undefined') return 'SYSTEM';
  const u = safeParse(localStorage.getItem('CURRENT_USER_DATA') || 'null', null);
  return (u?.name || u?.username || 'SYSTEM').toString();
}

export function pushArkaLocal(record) {
  if (typeof window === 'undefined') return;
  let list = safeParse(localStorage.getItem('arka_list_v1') || '[]', []);
  if (!Array.isArray(list)) list = [];
  list.unshift(record);
  // keep last 500 for speed
  if (list.length > 500) list = list.slice(0, 500);
  localStorage.setItem('arka_list_v1', JSON.stringify(list));
}

/**
 * Record a CASH movement for the currently open ARKA day.
 * - Always writes local cache (arka_list_v1)
 * - If DB tables exist + day is open, inserts into arka_moves with external_id for idempotency.
 */
export async function recordCashMove({
  externalId,
  amount,
  note,
  source = 'ORDER',
  createdBy,
  // local cache fields
  orderId,
  code,
  name,
  method = 'cash_pay',
  type = 'IN',
}) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'invalid_amount' };

  const by = (createdBy || getCurrentUserName()).toString();
  const now = Date.now();

  // local cache (optional)
  const localRec = {
    id: externalId || `pay_${orderId || 'x'}_${now}`,
    ts: now,
    orderId: orderId || null,
    code: code || null,
    name: name || null,
    paid: amt,
    method,
  };
  try {
    pushArkaLocal(localRec);
  } catch {}

  // DB write (preferred)
  try {
    const ok = await dbCanWork();
    if (!ok) return { ok: true, online: false };

    const open = await dbGetOpenDay();
    if (!open?.id) return { ok: true, online: false, reason: 'day_closed' };

    await dbAddMove({
      day_id: open.id,
      type,
      amount: amt,
      note: (note || '').toString().toUpperCase(),
      source,
      created_by: by,
      external_id: externalId || localRec.id,
    });

    return { ok: true, online: true };
  } catch (e) {
    // do NOT block workflow if DB fails
    return { ok: true, online: false, reason: 'db_error' };
  }
}
