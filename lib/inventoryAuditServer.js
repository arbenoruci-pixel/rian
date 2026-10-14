import { AUDIT_ACTIVE, canAuditInventory, summarizeAuditOrder } from './inventoryAudit.js';

export class InventoryAuditError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status) => { throw new InventoryAuditError(code, status); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function inventoryAuditAction(body, { supabase, authUser, now = Date.now() } = {}) {
  if (!authUser?.id || authUser.is_active === false || !canAuditInventory(authUser.role)) fail('AUDIT_FORBIDDEN', 403);
  if (body?.action === 'LIST') {
    const items = [];
    for (const table of ['orders', 'transport_orders']) {
      let cursor = null, complete = false;
      for (let page = 0; page < 50; page++) {
        let q = supabase.from(table).select('*').in('status', AUDIT_ACTIVE).order('id', { ascending: true }).limit(200);
        if (cursor !== null) q = q.gt('id', cursor);
        const { data, error } = await q;
        if (error) fail('AUDIT_LIST_FAILED', 503);
        const rows = data || [];
        items.push(...rows.map(row => summarizeAuditOrder(row, table, now)));
        if (rows.length < 200) { complete = true; break; }
        cursor = rows.at(-1).id;
      }
      if (!complete) fail('AUDIT_LIST_INCOMPLETE', 503);
    }
    return { items, complete: true, fetchedAt: new Date(now).toISOString() };
  }
  if (!['MOVE_READY', 'VERIFY', 'FOUND_READY'].includes(body?.action)) fail('AUDIT_ACTION_INVALID');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) fail('AUDIT_BATCH_INVALID');
  if (body.action === 'FOUND_READY') {
    if (body.items.length !== 1) fail('AUDIT_SINGLE_ORDER_REQUIRED');
    if (body.confirmed !== true) fail('AUDIT_CONFIRMATION_REQUIRED');
    if (body.result !== 'seen_in_depot') fail('AUDIT_RESULT_INVALID');
  }
  const seen = new Set();
  for (const item of body.items) {
    if (!['orders', 'transport_orders'].includes(item?.table) || !uuid.test(item?.operationId || '')) fail('AUDIT_ITEM_INVALID');
    if (item.table === 'orders' ? !/^[1-9]\d{0,15}$/.test(String(item.id)) : !uuid.test(item.id || '')) fail('AUDIT_ITEM_INVALID');
    const key = `${item.table}:${item.id}`;
    if (seen.has(key)) fail('AUDIT_DUPLICATE_ITEM');
    seen.add(key);
    if (item.revision != null && (typeof item.revision !== 'string' || !Number.isFinite(Date.parse(item.revision)))) fail('AUDIT_REVISION_INVALID');
  }
  if (body.action === 'VERIFY' && !['seen_in_depot', 'not_found', 'unverified'].includes(body.result)) fail('AUDIT_RESULT_INVALID');
  const note = String(body.note || '').trim();
  if (note.length > 500) fail('AUDIT_NOTE_TOO_LONG');
  const results = [];
  // Each item commits independently and returns its own outcome. A failed item
  // cannot hide successful peers or turn the entire selection into false success.
  for (const item of body.items) {
    const { data, error } = await supabase.rpc('inventory_audit_write_v1', {
      p_table: item.table, p_order_id: String(item.id), p_actor_id: authUser.id,
      p_action: body.action, p_result: body.action === 'MOVE_READY' ? 'unverified' : body.result,
      p_expected_updated_at: item.revision ?? null, p_operation_id: item.operationId, p_note: note,
    });
    if (error) {
      const code = /^AUDIT_[A-Z_]+$/.test(error.message || '') ? error.message : 'AUDIT_SAVE_FAILED';
      results.push({ key: `${item.table}:${item.id}`, ok: false, error: code });
    } else if (data?.row) {
      results.push({ key: `${item.table}:${item.id}`, ok: true, item: summarizeAuditOrder(data.row, item.table, now), replayed: !!data.replayed });
    } else results.push({ key: `${item.table}:${item.id}`, ok: false, error: 'AUDIT_SAVE_NOT_VERIFIED' });
  }
  return { results };
}
