import { ADMIN_ROLES } from './roles.js';
import { cleanStaffPin } from './staffIdentityServer.js';
import { buildWorkerBonusAccount, validWorkerBonusMonth, workerBonusMonthKey } from './workerBonusAccount.js';

const MANAGERS = new Set([...ADMIN_ROLES, 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER']);
const STAFF = new Set([...MANAGERS, 'PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE', 'TRANSPORT']);
const BONUS_FIELDS = 'id,order_id,order_code,transport_control_id,arka_payment_id,m2,amount,eligible,status,remaining_amount,reserved_amount,retained_amount,qualification_at,activated_at,ready_at,metadata';
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const BATCH_SIZE = 150;
const upper = value => String(value || '').trim().toUpperCase();

export class WorkerBonusAccountError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status = 400) => { throw new WorkerBonusAccountError(code, status); };

export async function authenticateWorkerBonusActor(supabase, deviceId) {
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 120) fail('AUTH_REQUIRED', 401);
  const { data: device, error: deviceError } = await supabase.from('tepiha_user_devices').select('user_id,is_approved').eq('device_id', deviceId).maybeSingle();
  if (deviceError) fail('WORKER_BONUS_AUTH_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const { data: actor, error } = await supabase.from('users').select('id,name,pin,role,is_active').eq('id', device.user_id).maybeSingle();
  if (error) fail('WORKER_BONUS_AUTH_FAILED', 503);
  if (!actor?.id || actor.is_active !== true || !STAFF.has(upper(actor.role))) fail('WORKER_BONUS_FORBIDDEN', 403);
  return actor;
}

async function pages(query) {
  const result = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await query().order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) fail('WORKER_BONUS_READ_FAILED', 503);
    result.push(...data);
    if (data.length < PAGE_SIZE) return result;
  }
  // Never present a truncated financial total as a complete balance.
  fail('WORKER_BONUS_REPORT_TOO_LARGE', 503);
}

async function batches(ids, query) {
  const result = [];
  const unique = [...new Set(ids.map(String))];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) result.push(...await pages(() => query(unique.slice(i, i + BATCH_SIZE))));
  return result;
}

export async function readWorkerBonusAccount(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active !== true || !STAFF.has(upper(actor.role))) fail('WORKER_BONUS_FORBIDDEN', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('WORKER_BONUS_BODY_INVALID');
  if (body.expectedActorId != null && body.expectedActorId !== actor.id) fail('WORKER_BONUS_SESSION_CHANGED', 403);
  const month = body.month === undefined ? workerBonusMonthKey() : body.month;
  if (!validWorkerBonusMonth(month)) fail('WORKER_BONUS_MONTH_INVALID');
  const targetPin = body.targetPin == null ? String(actor.pin || '') : String(body.targetPin).trim();
  try { cleanStaffPin(targetPin); } catch { fail('WORKER_BONUS_WORKER_INVALID'); }
  if (!MANAGERS.has(upper(actor.role)) && targetPin !== String(actor.pin)) fail('WORKER_BONUS_FORBIDDEN', 403);
  let worker = actor;
  if (targetPin !== String(actor.pin)) {
    const { data, error } = await supabase.from('users').select('id,name,pin,role,is_active').eq('pin', targetPin).maybeSingle();
    if (error) fail('WORKER_BONUS_READ_FAILED', 503);
    if (!data?.id) fail('WORKER_BONUS_WORKER_NOT_FOUND', 404);
    worker = data;
  }
  const [bonuses, pending] = await Promise.all([
    pages(() => supabase.from('base_ready_bonuses').select(BONUS_FIELDS).eq('worker_pin', worker.pin)),
    pages(() => supabase.from('transport_controls').select('id,order_id,status,submitted_at,created_at').eq('worker_id', worker.id).eq('status', 'PENDING')),
  ]);
  const [allocations, orders, bonusPayments] = await Promise.all([
    batches(bonuses.map(b => b.id), ids => supabase.from('base_ready_bonus_allocations').select('id,bonus_id,handoff_id,amount,status,created_at,updated_at').in('bonus_id', ids)),
    batches(pending.map(c => c.order_id), ids => supabase.from('transport_orders').select('id,code_str,status').in('id', ids)),
    batches(bonuses.map(b => b.arka_payment_id).filter(id => id != null), ids => supabase.from('arka_pending_payments').select('id,type,created_at').eq('created_by_pin', worker.pin).eq('type', 'READY_48H_BONUS').in('id', ids)),
  ]);
  const handoffs = await batches(allocations.map(a => a.handoff_id), ids => supabase.from('cash_handoffs').select('id,status,submitted_at,decided_at').eq('worker_pin', worker.pin).in('id', ids));
  const orderMap = new Map(orders.map(o => [String(o.id), o]));
  return buildWorkerBonusAccount({ worker, bonuses, allocations, handoffs, bonusPayments, pendingControls: pending.map(c => ({ ...c, order: orderMap.get(String(c.order_id)) || null })), month });
}

