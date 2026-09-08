import { ADMIN_ROLES } from '../roles.js';
import { DispatchOrderServerError } from './dispatchOrderServer.js';
import { normalizeTransportPranimiBusinessData } from './transportSelfEntryServer.js';

const ADMINS = new Set([...ADMIN_ROLES, 'MASTER']);
const PRE_PICKUP = new Set(['', 'new', 'inbox', 'pending', 'scheduled', 'draft', 'pranim', 'dispatched', 'assigned', 'accepted']);
const CLOSED = new Set(['done', 'completed', 'delivered', 'dorezuar', 'dorëzuar', 'cancelled', 'canceled', 'anuluar', 'archived', 'deleted', 'void']);
const uuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
const fail = (code, status = 400) => { throw new DispatchOrderServerError(code, status); };
const clean = (v, max = 1000) => String(v ?? '').trim().slice(0, max);

// Pure, explicit edit contract. Status/ownership changes require a separate choice.
export function buildDispatchEdit(row, input, actor, driver = null) {
  if (!ADMINS.has(clean(actor?.role).toUpperCase())) fail('DISPATCH_ORDER_ACTOR_NOT_ALLOWED', 403);
  if (!input.expectedUpdatedAt || input.expectedUpdatedAt !== row.updated_at) fail('DISPATCH_EDIT_CONFLICT', 409);
  const status = clean(row.status || row.data?.status).toLowerCase();
  if (CLOSED.has(status)) fail('DISPATCH_EDIT_ORDER_CLOSED', 409);
  const old = row.data || {};
  const data = { ...old, client: { ...(old.client || {}) } };
  const name = clean(input.name, 160);
  if (!name) fail('TRANSPORT_CLIENT_NAME_REQUIRED');
  data.client_name = name;
  data.address = data.pickup_address = clean(input.address);
  data.client.name = name;
  data.client.address = data.address;
  const note = clean(input.note, 4000);
  if (note !== clean(old.note || old.notes, 4000)) {
    data.note = note;
    data.notes = note;
  }
  if (input.plan) {
    for (const key of ['pickup_plan', 'planned_tepiha', 'planned_pieces', 'planned_m2_total', 'pickup_measurements_text', 'pickup_date', 'pickup_slot', 'pickup_window', 'planning_bucket']) {
      if (Object.hasOwn(input.plan, key)) data[key] = input.plan[key];
    }
  }
  let nextStatus = row.status;
  if (input.changeAssignment === true) {
    if (input.driverId && (!driver?.id || driver.id !== input.driverId || driver.is_active === false
      || !(driver.role === 'TRANSPORT' || driver.is_hybrid_transport === true))) fail('DISPATCH_DRIVER_INVALID', 409);
    const id = driver?.id || null;
    for (const key of ['transport_id', 'transport_user_id', 'assigned_driver_id', 'driver_id']) data[key] = id;
    for (const key of ['transport_name', 'driver_name']) data[key] = driver?.name || null;
    for (const key of ['transport_pin', 'driver_pin', 'assigned_driver_pin']) data[key] = driver?.pin || null;
    data.actor = driver?.name || driver?.pin || null;
    data.assigned_at = new Date().toISOString();
    if (PRE_PICKUP.has(status)) nextStatus = id ? 'assigned' : 'inbox';
  }
  if (input.measurements) {
    // Existing receipts/ledger allocations must be corrected through finance.
    if (Math.max(Number(old.pay?.paid || 0), Number(old.pay?.arkaRecordedPaid || 0), Number(old.clientPaid || 0), Number(old.paid || 0)) > 0) {
      fail('DISPATCH_EDIT_PAID_MEASUREMENTS', 409);
    }
    let measured;
    try {
      measured = normalizeTransportPranimiBusinessData({ ...old, ...input.measurements, pay: { ...(old.pay || {}), rate: old.pay?.rate ?? old.price_per_m2 ?? 1.8 } });
    } catch { fail('DISPATCH_MEASUREMENTS_INVALID'); }
    if (!measured.totals.pieces || measured.totals.m2 <= 0) fail('DISPATCH_MEASUREMENTS_INVALID');
    for (const kind of ['tepiha', 'staza']) {
      const previousRows = old[kind] || old[`${kind}Rows`] || [];
      data[kind] = measured[kind].map((item) => ({ ...previousRows.find((previous) => previous.id === item.id), ...item }));
      if (Object.hasOwn(old, `${kind}Rows`)) data[`${kind}Rows`] = data[kind];
    }
    data.shkallore = { ...(old.shkallore || {}), ...measured.shkallore };
    for (const key of ['price_per_m2', 'debt', 'isPaid']) data[key] = measured[key];
    data.pay = { ...(old.pay || {}), ...measured.pay };
    data.totals = { ...(old.totals || {}), ...measured.totals };
    data.m2_total = measured.totals.m2;
    data.total_euro = measured.totals.euro;
    data.pieces = measured.totals.pieces;
    // Older screens prefer these aliases over pay/totals. Keep existing aliases in sync.
    for (const key of ['totalM2', 'total_m2', 'm2']) if (Object.hasOwn(old, key)) data[key] = measured.totals.m2;
    for (const key of ['totalEuro', 'total_eur', 'price_total', 'total_price', 'total', 'sum', 'amount']) if (Object.hasOwn(old, key)) data[key] = measured.totals.euro;
    for (const key of ['grandTotal', 'grand_total']) if (Object.hasOwn(old.totals || {}, key)) data.totals[key] = measured.totals.euro;
    if (Object.hasOwn(old.totals || {}, 'm2_total')) data.totals.m2_total = measured.totals.m2;
  }
  // A plan edit never normalizes or regresses an in-progress lifecycle.
  if (nextStatus !== row.status) data.status = nextStatus;
  data.dispatch_edit = { at: new Date().toISOString(), by_id: actor.id, by_name: actor.name, by_role: actor.role,
    assignment_changed: input.changeAssignment === true, measurements_changed: !!input.measurements };
  return { data, status: nextStatus, clientPatch: { name, address: data.address } };
}

export async function editDispatchOrderServer(input, { supabase, authUser }) {
  if (!authUser?.id || !ADMINS.has(clean(authUser.role).toUpperCase())) fail('DISPATCH_ORDER_ACTOR_NOT_ALLOWED', 403);
  if (!uuid(input.orderId)) fail('DISPATCH_ORDER_ID_INVALID');
  const { data: row, error } = await supabase.from('transport_orders').select('*').eq('id', input.orderId).maybeSingle();
  if (error) fail('DISPATCH_EDIT_LOOKUP_FAILED', 503);
  if (!row?.id) fail('DISPATCH_ORDER_NOT_FOUND', 404);
  if (!row.client_id) fail('DISPATCH_ORDER_CLIENT_MISMATCH', 409);
  const { data: client, error: clientError } = await supabase.from('transport_clients').select('id,updated_at').eq('id', row.client_id).maybeSingle();
  if (clientError || !client) fail('DISPATCH_CLIENT_LOOKUP_FAILED', 503);
  let driver = null;
  if (input.changeAssignment === true && input.driverId) {
    if (!uuid(input.driverId)) fail('DISPATCH_DRIVER_INVALID');
    const result = await supabase.from('users').select('id,name,pin,role,is_active,is_hybrid_transport').eq('id', input.driverId).maybeSingle();
    if (result.error) fail('DISPATCH_DRIVER_LOOKUP_FAILED', 503);
    driver = result.data;
  }
  const patch = buildDispatchEdit(row, input, authUser, driver);
  const result = await supabase.rpc('edit_dispatch_order_v1', {
    p_order_id: row.id, p_expected_updated_at: row.updated_at,
    p_client_id: client.id, p_client_expected_updated_at: client.updated_at,
    p_client_patch: patch.clientPatch, p_order_data: patch.data, p_next_status: patch.status,
  });
  if (result.error) {
    if (String(result.error.message).includes('DISPATCH_EDIT_CONFLICT')) fail('DISPATCH_EDIT_CONFLICT', 409);
    if (String(result.error.message).includes('DISPATCH_EDIT_PAID_MEASUREMENTS')) fail('DISPATCH_EDIT_PAID_MEASUREMENTS', 409);
    fail('DISPATCH_EDIT_SAVE_FAILED', 503);
  }
  if (!result.data?.id || result.data.id !== row.id) fail('DISPATCH_EDIT_VERIFY_FAILED', 503);
  return { ok: true, order: result.data };
}
