import { ADMIN_ROLES } from './roles.js';
import { authenticateWorkerBonusActor } from './workerBonusAccountServer.js';
import { getHandoffReceiptTotals, validateReceiptAmount } from './handoffReceipts.js';

const MANAGERS = new Set([...ADMIN_ROLES, 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER']);
const upper = value => String(value || '').trim().toUpperCase();
const ID = /^[1-9]\d{0,14}$/;
const REQUEST = /^[A-Za-z0-9:_-]{12,120}$/;
const FIELDS = 'id,worker_pin,worker_name,amount,status,submitted_at,decided_at,receipt_tracking,receipt_worker_id,receipt_received_amount,receipt_resolved_amount,receipt_outstanding_amount,receipt_updated_at,pending_payment_ids';
const EVENT_FIELDS = 'id,handoff_id,event_kind,amount,reason,note,actor_name,created_at,outstanding_before,outstanding_after,ledger_entry_id';

export class HandoffReceiptError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status = 400) => { throw new HandoffReceiptError(code, status); };
export const authenticateHandoffReceiptActor = authenticateWorkerBonusActor;

function safeHandoff(row = {}) {
  const safe = Object.fromEntries(FIELDS.split(',').map(key => [key, row[key]]));
  return { ...safe, ...getHandoffReceiptTotals(row) };
}

export async function handleHandoffReceiptAction(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active !== true) fail('AUTH_REQUIRED', 401);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('HANDOFF_RECEIPT_BODY_INVALID');
  if (body.expectedActorId && body.expectedActorId !== actor.id) fail('HANDOFF_RECEIPT_SESSION_CHANGED', 403);
  const manager = MANAGERS.has(upper(actor.role));
  if (body.action === 'list') {
    if (Object.keys(body).some(key => !['action','expectedActorId','targetPin'].includes(key))) fail('HANDOFF_RECEIPT_BODY_INVALID');
    const targetPin = body.targetPin == null ? (manager ? '' : String(actor.pin)) : String(body.targetPin).trim();
    if (targetPin && !/^\d{4,12}$/.test(targetPin)) fail('HANDOFF_RECEIPT_WORKER_INVALID');
    if (!manager && targetPin !== String(actor.pin)) fail('HANDOFF_RECEIPT_FORBIDDEN', 403);
    const { data, error } = await supabase.rpc('read_cash_handoff_receipts_v1', { p_actor_id:actor.id, p_worker_pin:targetPin || null });
    if (error || data?.ok !== true || !Array.isArray(data.handoffs) || !Array.isArray(data.events) || !Number.isFinite(Number(data.summary?.outstandingTotal)) || !Number.isFinite(Number(data.summary?.receivedToday))) fail('HANDOFF_RECEIPT_READ_FAILED',503);
    // Read the declaration summary only for handovers already authorized by the RPC.
    // One batched query keeps the list cheap; detailed evidence loads on demand.
    let declarations = new Map();
    if (data.handoffs.length) {
      const { data: rows, error: declarationError } = await supabase.from('worker_handoff_submissions')
        .select('handoff_id,physical_cash,projected_cash,difference_amount')
        .in('handoff_id', data.handoffs.map(row => row.id));
      if (declarationError || !Array.isArray(rows)) fail('HANDOFF_RECEIPT_READ_FAILED', 503);
      declarations = new Map(rows.map(row => [String(row.handoff_id), row]));
    }
    return {
      ok:true, manager, actorId:actor.id, generated_at:data.generated_at, summary:data.summary,
      handoffs:data.handoffs.map(row => {
        const declaration = declarations.get(String(row.id));
        return { ...safeHandoff(row), worker_id:row.worker_id, has_bonus_allocations:row.has_bonus_allocations === true,
          pay_ready_bonus_enabled:row.pay_ready_bonus_enabled === true, can_receive:manager && row.can_receive === true,
          has_worker_submission:!!declaration,
          worker_declared_cash:declaration ? Number(declaration.physical_cash) : null,
          worker_projected_cash:declaration ? Number(declaration.projected_cash) : null,
          worker_declared_difference:declaration ? Number(declaration.difference_amount) : null };
      }),
      events:data.events.map(row => Object.fromEntries(EVENT_FIELDS.split(',').map(key => [key,row[key]]))),
    };
  }
  if (!manager) fail('HANDOFF_RECEIPT_FORBIDDEN', 403);
  if (['daily-check','daily-close'].includes(body.action)) {
    if (Object.keys(body).some(key => !['action','expectedActorId','date','countedCash','expectedBudget','reason','note','requestKey'].includes(key))) fail('HANDOFF_RECEIPT_BODY_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) || Number.isNaN(new Date(body.date + 'T12:00:00Z').getTime()) || new Date(body.date + 'T12:00:00Z').toISOString().slice(0,10) !== body.date) fail('HANDOFF_RECEIPT_DATE_INVALID');
    if (!REQUEST.test(String(body.requestKey || ''))) fail('HANDOFF_RECEIPT_KEY_INVALID');
    const countedCash = validateReceiptAmount(body.countedCash, { allowZero:true });
    const expectedBudget = Number(body.expectedBudget);
    if (countedCash == null || !['number','string'].includes(typeof body.expectedBudget) || String(body.expectedBudget).trim() === '' || !Number.isFinite(expectedBudget) || Math.abs(expectedBudget)>10000000 || Math.abs(expectedBudget * 100 - Math.round(expectedBudget * 100))>0.00001) fail('HANDOFF_RECEIPT_AMOUNT_INVALID');
    const reason = String(body.reason || '').trim(), note = String(body.note || '').trim();
    if (reason.length>80 || note.length>1000 || (Math.abs(countedCash-expectedBudget)>0.01 && (reason.length<2 || note.length<4))) fail('HANDOFF_RECEIPT_REASON_REQUIRED');
    const { data, error } = await supabase.rpc('close_arka_day_receipts_v1', {
      p_actor_id:actor.id, p_date:body.date, p_counted_cash:countedCash, p_expected_budget:expectedBudget,
      p_reason:reason, p_note:note, p_request_key:body.requestKey, p_dry_run:body.action === 'daily-check',
    });
    if (error) {
      const code = String(error.message || '').split(/[:\s]/)[0];
      const allowed = new Set(['HANDOFF_RECEIPT_BUDGET_CHANGED','HANDOFF_RECEIPT_IDEMPOTENCY_CONFLICT','HANDOFF_RECEIPT_WORKFLOW_PAUSED','HANDOFF_RECEIPT_FORBIDDEN','PENDING_EXPENSES_MUST_BE_DECIDED','CANNOT_CLOSE_FUTURE_DATE','DISCREPANCY_REASON_AND_NOTE_REQUIRED']);
      fail(allowed.has(code) ? code : 'HANDOFF_RECEIPT_SAVE_FAILED', allowed.has(code) ? 409 : 503);
    }
    if (data?.ok !== true) fail('HANDOFF_RECEIPT_CONFIRMATION_MISSING',503);
    return data;
  }
  if (!['receive', 'resolve'].includes(body.action)) fail('HANDOFF_RECEIPT_ACTION_INVALID');
  if (Object.keys(body).some(key => !['action','expectedActorId','handoffId','requestKey','amount','expectedOutstanding','note','confirmNoCash'].includes(key))) fail('HANDOFF_RECEIPT_BODY_INVALID');
  if (!ID.test(String(body.handoffId))) fail('HANDOFF_RECEIPT_ID_INVALID');
  if (!REQUEST.test(String(body.requestKey || ''))) fail('HANDOFF_RECEIPT_KEY_INVALID');
  const amount = validateReceiptAmount(body.amount, { allowZero: body.action === 'receive' });
  const expected = validateReceiptAmount(body.expectedOutstanding, { allowZero: true });
  if (amount == null || expected == null || expected <= 0 || amount > expected) fail('HANDOFF_RECEIPT_AMOUNT_INVALID');
  const note = String(body.note || '').trim();
  if (note.length > 1000 || ((body.action === 'resolve' || amount < expected) && note.length < 4)) fail('HANDOFF_RECEIPT_REASON_REQUIRED');
  if (body.action === 'resolve' && body.confirmNoCash !== true) fail('HANDOFF_RECEIPT_NONCASH_CONFIRM_REQUIRED');
  const reason = body.action === 'resolve' ? 'NONCASH_RESOLUTION' : amount < expected ? 'SHORT_RECEIPT' : 'FULL_RECEIPT';
  const { data, error } = await supabase.rpc('record_cash_handoff_receipt_v1', {
    p_actor_id: actor.id, p_handoff_id: Number(body.handoffId),
    p_event_kind: body.action === 'receive' ? 'RECEIPT' : 'RESOLUTION', p_amount: amount,
    p_expected_outstanding: expected, p_reason: reason, p_note: note,
    p_request_key: body.requestKey,
  });
  if (error) {
    const code = String(error.message || '').split(/[:\s]/)[0];
    const allowed = new Set(['HANDOFF_RECEIPT_STATE_CHANGED', 'HANDOFF_RECEIPT_IDEMPOTENCY_CONFLICT', 'HANDOFF_RECEIPT_NOT_PENDING', 'HANDOFF_RECEIPT_SELF_APPROVAL', 'HANDOFF_RECEIPT_FORBIDDEN', 'HANDOFF_RECEIPT_AMOUNT_INVALID', 'HANDOFF_RECEIPT_WORKFLOW_PAUSED']);
    fail(allowed.has(code) ? code : 'HANDOFF_RECEIPT_SAVE_FAILED', allowed.has(code) ? 409 : 503);
  }
  if (data?.ok !== true || !data?.handoff || !data?.event) fail('HANDOFF_RECEIPT_CONFIRMATION_MISSING', 503);
  return { ok: true, handoff: safeHandoff(data.handoff), event: Object.fromEntries(EVENT_FIELDS.split(',').map(key => [key, data.event[key]])), replayed: data.replayed === true };
}
