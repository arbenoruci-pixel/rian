import { ADMIN_ROLES } from './roles.js';
import { authenticateWorkerBonusActor } from './workerBonusAccountServer.js';
import { validateReceiptAmount } from './handoffReceipts.js';

const MANAGERS = new Set([...ADMIN_ROLES, 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[1-9]\d{0,14}$/;
const KEY = /^[A-Za-z0-9:_-]{12,120}$/;
const HASH = /^[a-f0-9]{32,64}$/i;
const CHOICES = new Set(['self', 'other', 'none', 'existing', 'monthly']);
const SOURCES = new Set(['WORKER_COLLECTIONS', 'DISPATCH_DRAWER', 'OWN_MONEY']);
const CATEGORIES = new Set(['FOOD', 'FUEL', 'SUPPLIES', 'OTHER']);
export const authenticateWorkerHandoffActor = authenticateWorkerBonusActor;

export class WorkerHandoffError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status = 400) => { throw new WorkerHandoffError(code, status); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => Object.keys(value).every(key => fields.includes(key));

function textValue(value, max, { required = false, min = 4 } = {}) {
  if (value != null && typeof value !== 'string') fail('WORKER_HANDOFF_BODY_INVALID');
  const text = String(value || '').trim();
  if (text.length > max || (required && text.length < min)) fail('WORKER_HANDOFF_DESCRIPTION_REQUIRED');
  return text;
}

export function validateWorkerHandoffOptions(value = {}) {
  if (!object(value) || !only(value, ['mealChoice', 'mealPayerId', 'expenses'])) fail('WORKER_HANDOFF_OPTIONS_INVALID');
  const options = {};
  if (value.mealChoice != null && value.mealChoice !== '') {
    if (!CHOICES.has(value.mealChoice)) fail('WORKER_HANDOFF_MEAL_INVALID');
    options.mealChoice = value.mealChoice;
  }
  if (value.mealPayerId != null && value.mealPayerId !== '') {
    if (!UUID.test(String(value.mealPayerId)) || options.mealChoice !== 'other') fail('WORKER_HANDOFF_MEAL_INVALID');
    options.mealPayerId = value.mealPayerId;
  }
  if (value.expenses != null && (!Array.isArray(value.expenses) || value.expenses.length > 20)) fail('WORKER_HANDOFF_EXPENSE_INVALID');
  const keys = new Set(), payments = new Set();
  options.expenses = (value.expenses || []).map(row => {
    if (!object(row) || !only(row, ['clientKey', 'existingPaymentId', 'amount', 'description', 'spentOn', 'category', 'recipient', 'fundingSource', 'includesOwnMeal'])) fail('WORKER_HANDOFF_EXPENSE_INVALID');
    if (!UUID.test(String(row.clientKey || '')) || keys.has(row.clientKey)) fail('WORKER_HANDOFF_EXPENSE_DUPLICATE');
    keys.add(row.clientKey);
    const amount = validateReceiptAmount(row.amount);
    if (amount == null || amount <= 0 || !SOURCES.has(row.fundingSource) || !CATEGORIES.has(row.category)) fail('WORKER_HANDOFF_EXPENSE_INVALID');
    const date = String(row.spentOn || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + 'T12:00:00Z').getTime()) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) fail('WORKER_HANDOFF_DATE_INVALID');
    const paymentId = row.existingPaymentId == null || row.existingPaymentId === '' ? null : String(row.existingPaymentId);
    if (paymentId && (!ID.test(paymentId) || payments.has(paymentId))) fail('WORKER_HANDOFF_EXPENSE_DUPLICATE');
    if (paymentId) payments.add(paymentId);
    if (row.includesOwnMeal != null && typeof row.includesOwnMeal !== 'boolean') fail('WORKER_HANDOFF_EXPENSE_INVALID');
    if (row.category === 'FOOD' && row.fundingSource === 'WORKER_COLLECTIONS' && typeof row.includesOwnMeal !== 'boolean') fail('WORKER_HANDOFF_MEAL_SCOPE_REQUIRED');
    return {
      clientKey: row.clientKey, existingPaymentId: paymentId ? Number(paymentId) : null,
      amount, description: textValue(row.description, 500, { required: true, min: 2 }), spentOn: date,
      category: row.category, recipient: textValue(row.recipient, 160),
      fundingSource: row.fundingSource, includesOwnMeal: row.includesOwnMeal === true,
    };
  });
  return options;
}

function rpcError(error) {
  const code = String(error?.message || '').split(/[:\s]/)[0];
  if (/^(WHW|WORKER_HANDOFF|HANDOFF_WIZARD|HANDOFF_RECEIPT|MEAL_POLICY)_[A-Z0-9_]+$/.test(code)) {
    const status = /AUTH_REQUIRED/.test(code) ? 401 : /FORBIDDEN|SELF_APPROVAL|ACTOR|NOT_OWNER/.test(code) ? 403
      : /STALE|CHANGED|CONFLICT|ALREADY|PAUSED|USED|NOT_PENDING/.test(code) ? 409 : 400;
    fail(code, status);
  }
  fail('WORKER_HANDOFF_REQUEST_FAILED', 503);
}

export async function handleWorkerHandoffAction(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active !== true) fail('AUTH_REQUIRED', 401);
  if (!object(body)) fail('WORKER_HANDOFF_BODY_INVALID');
  if (body.expectedActorId !== actor.id) fail('WORKER_HANDOFF_SESSION_CHANGED', 403);
  let name, args;
  if (body.action === 'preview') {
    if (!only(body, ['action', 'expectedActorId', 'options'])) fail('WORKER_HANDOFF_BODY_INVALID');
    name = 'preview_worker_handoff_v1';
    args = { p_actor_id: actor.id, p_options: validateWorkerHandoffOptions(body.options) };
  } else if (body.action === 'submit') {
    if (!only(body, ['action', 'expectedActorId', 'options', 'snapshotHash', 'requestKey', 'physicalCash', 'differenceReason'])) fail('WORKER_HANDOFF_BODY_INVALID');
    if (!HASH.test(String(body.snapshotHash || '')) || !KEY.test(String(body.requestKey || ''))) fail('WORKER_HANDOFF_REVIEW_INVALID');
    const amount = validateReceiptAmount(body.physicalCash, { allowZero: true });
    if (amount == null) fail('WORKER_HANDOFF_PHYSICAL_CASH_REQUIRED');
    name = 'submit_worker_handoff_v1';
    args = {
      p_actor_id: actor.id, p_snapshot_hash: body.snapshotHash, p_request_key: body.requestKey,
      p_options: validateWorkerHandoffOptions(body.options), p_physical_cash: amount,
      p_difference_reason: textValue(body.differenceReason, 1000),
    };
  } else if (body.action === 'read') {
    if (!only(body, ['action', 'expectedActorId', 'handoffId']) || !ID.test(String(body.handoffId))) fail('WORKER_HANDOFF_BODY_INVALID');
    name = 'read_worker_handoff_submission_v1';
    args = { p_actor_id: actor.id, p_handoff_id: Number(body.handoffId) };
  } else if (body.action === 'decide-expense') {
    if (!MANAGERS.has(String(actor.role || '').trim().toUpperCase())) fail('WORKER_HANDOFF_FORBIDDEN', 403);
    if (!only(body, ['action', 'expectedActorId', 'claimId', 'approve', 'note', 'requestKey', 'confirmFunding'])
      || !ID.test(String(body.claimId)) || typeof body.approve !== 'boolean' || !KEY.test(String(body.requestKey || ''))) fail('WORKER_HANDOFF_BODY_INVALID');
    if (body.approve && body.confirmFunding !== true) fail('WORKER_HANDOFF_FUNDING_CONFIRM_REQUIRED');
    name = 'decide_worker_handoff_expense_v1';
    args = { p_actor_id: actor.id, p_claim_id: Number(body.claimId), p_approve: body.approve, p_note: textValue(body.note, 1000, { required: true }), p_request_key: body.requestKey };
  } else if (body.action === 'reimburse-expense') {
    if (!MANAGERS.has(String(actor.role || '').trim().toUpperCase())) fail('WORKER_HANDOFF_FORBIDDEN', 403);
    if (!only(body, ['action', 'expectedActorId', 'claimId', 'amount', 'note', 'requestKey', 'confirmPaid'])
      || !ID.test(String(body.claimId)) || !KEY.test(String(body.requestKey || ''))) fail('WORKER_HANDOFF_BODY_INVALID');
    if (body.confirmPaid !== true) fail('WORKER_HANDOFF_PAID_CONFIRM_REQUIRED');
    const amount = validateReceiptAmount(body.amount);
    if (amount == null) fail('WORKER_HANDOFF_EXPENSE_INVALID');
    name = 'reimburse_worker_handoff_expense_v1';
    args = { p_actor_id:actor.id, p_claim_id:Number(body.claimId), p_amount:amount,
      p_note:textValue(body.note, 1000, { required:true }), p_request_key:body.requestKey };
  } else fail('WORKER_HANDOFF_ACTION_INVALID');
  const { data, error } = await supabase.rpc(name, args);
  if (error) rpcError(error);
  if (data?.ok !== true) fail('WORKER_HANDOFF_CONFIRMATION_MISSING', 503);
  if (body.action === 'preview' && (!HASH.test(String(data.snapshotHash || '')) || !Array.isArray(data.payments) || !Array.isArray(data.bonuses) || !Array.isArray(data.existingExpenses) || !object(data.totals))) fail('WORKER_HANDOFF_PREVIEW_INCOMPLETE', 503);
  if (body.action === 'submit' && (!ID.test(String(data.handoffId)) || !object(data.submission))) fail('WORKER_HANDOFF_CONFIRMATION_MISSING', 503);
  if (['decide-expense', 'reimburse-expense'].includes(body.action) && (!ID.test(String(data.handoffId)) || !object(data.claim) || String(data.claim.id) !== String(body.claimId))) fail('WORKER_HANDOFF_CONFIRMATION_MISSING', 503);
  if (body.action === 'reimburse-expense' && (data.claim.status !== 'REIMBURSED' || !ID.test(String(data.claim.expenseLedgerId)))) fail('WORKER_HANDOFF_CONFIRMATION_MISSING', 503);
  return data;
}
