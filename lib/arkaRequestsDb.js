// lib/arkaRequestsDb.js
// Expense/advance requests with admin/dispatch approval.
// Cleaned for Corporate 4-Levels:
// - no legacy cycle writes
// - no company_budget_moves writes
// - approvals now spend directly from company_budget_summary/company_budget_ledger

import { supabase } from '@/lib/supabaseClient';
import { spendFromCompanyBudget } from '@/lib/corporateFinance';
import { listUsers } from '@/lib/usersDb';

const TABLE = 'arka_expense_requests';

export function isAdminRole(role) {
  const r = String(role || '').toUpperCase();
  return r === 'ADMIN' || r === 'ADMIN_MASTER' || r === 'DISPATCH' || r === 'OWNER';
}

export async function listApprovers() {
  const res = await listUsers();
  if (!res?.ok) throw (res?.error || new Error('S’MUND T’I LEXOJ USERS'));
  const items = (res.items || []).filter((u) => isAdminRole(u.role) && u.is_active !== false);
  return items;
}

export async function createExpenseRequest({
  amount,
  req_type = 'SHPENZIM', // SHPENZIM | AVANS
  source = 'ARKA', // ARKA | BUXHETI (kept for UI compatibility / labeling)
  reason = '',
  requested_by_pin,
  requested_by_name = '',
  target_approver_pin,
  target_approver_name = '',
}) {
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('SHUMA DUHET > 0');

  const payload = {
    status: 'PENDING',
    amount: amt,
    req_type: String(req_type || 'SHPENZIM').toUpperCase(),
    source: String(source || 'ARKA').toUpperCase(),
    reason: String(reason || '').trim(),
    requested_by_pin: String(requested_by_pin || '').trim(),
    requested_by_name: String(requested_by_name || '').trim(),
    target_approver_pin: String(target_approver_pin || '').trim(),
    target_approver_name: String(target_approver_name || '').trim(),
  };

  if (!payload.requested_by_pin) throw new Error('PIN I PUNTORIT MUNGON');
  if (!payload.target_approver_pin) throw new Error('ZGJIDH KUSH PO E APROVON');
  if (!['ARKA', 'BUXHETI'].includes(payload.source)) throw new Error('BURIMI DUHET: ARKA ose BUXHETI');
  if (!['SHPENZIM', 'AVANS'].includes(payload.req_type)) throw new Error('TIPI DUHET: SHPENZIM ose AVANS');

  const { data, error } = await supabase
    .from(TABLE)
    .insert([payload])
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listPendingRequestsForApprover(approver_pin, limit = 50) {
  const pin = String(approver_pin || '').trim();
  if (!pin) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'PENDING')
    .eq('target_approver_pin', pin)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit || 50), 200)));
  if (error) throw error;
  return data || [];
}

export async function listMyRequests(requested_by_pin, limit = 50) {
  const pin = String(requested_by_pin || '').trim();
  if (!pin) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('requested_by_pin', pin)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit || 50), 200)));
  if (error) throw error;
  return data || [];
}

function buildMoveNote(req) {
  const who = req?.requested_by_name ? String(req.requested_by_name).trim() : 'PUNTOR';
  const pin = req?.requested_by_pin ? String(req.requested_by_pin).trim() : '';
  const t = String(req?.req_type || '').toUpperCase();
  const src = String(req?.source || '').toUpperCase();
  const r = String(req?.reason || '').trim();
  const parts = [];
  parts.push(`${t}`);
  parts.push(`${who}${pin ? ` (${pin})` : ''}`);
  parts.push(`BURIMI ${src || 'ARKA'}`);
  if (r) parts.push(r);
  return parts.join(' · ');
}

function mapRequestToCorporateCategory(req) {
  const type = String(req?.req_type || '').toUpperCase();
  const source = String(req?.source || '').toUpperCase();
  if (type === 'AVANS') return 'WORKER_ADVANCE';
  if (source === 'ARKA') return 'EXPENSE_REQUEST_ARKA';
  return 'EXPENSE_REQUEST';
}

export async function approveRequest({ request_id, approver_pin, approver_name = '', approver_role = '' }) {
  const rid = String(request_id || '').trim();
  if (!rid) throw new Error('request_id mungon');
  const apin = String(approver_pin || '').trim();
  if (!apin) throw new Error('approver PIN mungon');

  // Lock row by updating status (optimistic).
  const { data: req, error: upErr } = await supabase
    .from(TABLE)
    .update({
      status: 'APPROVED',
      approved_at: new Date().toISOString(),
      approved_by_pin: apin,
      approved_by_name: String(approver_name || '').trim(),
      approved_by_role: String(approver_role || '').toUpperCase(),
    })
    .eq('id', rid)
    .eq('status', 'PENDING')
    .select('*')
    .single();
  if (upErr) throw upErr;

  const note = buildMoveNote(req);
  const amt = Number(req.amount || 0);

  try {
    await spendFromCompanyBudget({
      actor: {
        pin: apin,
        name: String(approver_name || '').trim() || null,
        role: String(approver_role || '').toUpperCase() || null,
      },
      amount: amt,
      category: mapRequestToCorporateCategory(req),
      description: note,
    });
  } catch (e) {
    // Roll back request status so UI doesn't show a false APPROVED.
    try {
      await supabase
        .from(TABLE)
        .update({
          status: 'PENDING',
          approved_at: null,
          approved_by_pin: null,
          approved_by_name: null,
          approved_by_role: null,
        })
        .eq('id', rid);
    } catch {}
    throw e;
  }

  // external_move_id intentionally left null in the new architecture.
  // Source of truth is company_budget_ledger / company_budget_summary.
  return { ok: true, req };
}

export async function rejectRequest({ request_id, approver_pin, approver_name = '', approver_role = '', reject_note = '' }) {
  const rid = String(request_id || '').trim();
  if (!rid) throw new Error('request_id mungon');
  const apin = String(approver_pin || '').trim();
  if (!apin) throw new Error('approver PIN mungon');

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'REJECTED',
      rejected_at: new Date().toISOString(),
      approved_by_pin: apin,
      approved_by_name: String(approver_name || '').trim(),
      approved_by_role: String(approver_role || '').toUpperCase(),
      reject_note: String(reject_note || '').trim(),
    })
    .eq('id', rid)
    .eq('status', 'PENDING')
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, req: data };
}
