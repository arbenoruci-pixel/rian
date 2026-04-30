import { supabase } from '@/lib/supabaseClient';
import { spendFromCompanyBudget } from '@/lib/corporateFinance';
import { createExpenseRequest, listApprovers, listMyRequests, listPendingRequestsForApprover, approveRequest, rejectRequest } from '@/lib/arkaRequestsDb';
import { listUserRecords } from '@/lib/usersService';

const todayKey = () => new Date().toISOString().slice(0, 10);
const n = (v) => {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
};

function esc(v) {
  return encodeURIComponent(String(v || '').trim());
}
function dec(v) {
  try { return decodeURIComponent(String(v || '')); } catch { return String(v || ''); }
}

export function buildWorkerTimaDescription({ workerPin, workerName = '', note = '', assignedByPin = '', assignedByName = '' }) {
  return [
    'WORKER_TIMA',
    `worker_pin=${esc(workerPin)}`,
    `worker_name=${esc(workerName)}`,
    `note=${esc(note)}`,
    `assigned_by_pin=${esc(assignedByPin)}`,
    `assigned_by_name=${esc(assignedByName)}`,
  ].join('|');
}

export function parseWorkerTimaDescription(description = '') {
  const raw = String(description || '');
  if (!raw.startsWith('WORKER_TIMA|')) return null;
  const out = {};
  raw.split('|').slice(1).forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx)] = dec(part.slice(idx + 1));
  });
  return {
    worker_pin: String(out.worker_pin || '').trim(),
    worker_name: String(out.worker_name || '').trim(),
    note: String(out.note || '').trim(),
    assigned_by_pin: String(out.assigned_by_pin || '').trim(),
    assigned_by_name: String(out.assigned_by_name || '').trim(),
  };
}

export async function assignWorkerTima({ actor, workerPin, workerName = '', amount, note = '' }) {
  const amt = n(amount);
  if (amt <= 0) throw new Error('SHUMA E TIMËS DUHET MBI 0€');
  const pin = String(workerPin || '').trim();
  if (!pin) throw new Error('ZGJIDH PUNTORIN');
  return spendFromCompanyBudget({
    actor,
    amount: amt,
    category: 'WORKER_TIMA',
    description: buildWorkerTimaDescription({
      workerPin: pin,
      workerName,
      note,
      assignedByPin: actor?.pin || '',
      assignedByName: actor?.name || '',
    }),
  });
}

export async function listWorkerTimaAssignments(workerPin, limit = 30) {
  const pin = String(workerPin || '').trim();
  if (!pin) return [];
  const { data, error } = await supabase
    .from('company_budget_ledger')
    .select('id, amount, category, description, created_at, direction, created_by_pin')
    .eq('category', 'WORKER_TIMA')
    .eq('direction', 'OUT')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row) => {
      const parsed = parseWorkerTimaDescription(row.description);
      return parsed ? { ...row, ...parsed } : null;
    })
    .filter((row) => row && row.worker_pin === pin && String(row.created_at || '').slice(0, 10) === todayKey());
}

export async function listTodayWorkers() {
  const users = await listUserRecords({
    select: 'id,name,pin,role,is_active',
    orderBy: 'name',
    ascending: true,
  });
  return users.filter((u) => ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(String(u?.role || '').toUpperCase()) && u?.is_active !== false);
}

export async function createWorkerExpenseApproval({ actor, title, amount }) {
  const amt = n(amount);
  if (amt <= 0) throw new Error('SHUMA E SHPENZIMIT DUHET MBI 0€');
  const approvers = await listApprovers();
  const preferred = approvers.find((a) => String(a?.role || '').toUpperCase() === 'DISPATCH') || approvers[0];
  if (!preferred?.pin) throw new Error('NUK U GJET ASNJË APROVUES');
  return createExpenseRequest({
    amount: amt,
    req_type: 'SHPENZIM',
    source: 'ARKA',
    reason: String(title || '').trim() || 'Shpenzim',
    requested_by_pin: actor?.pin,
    requested_by_name: actor?.name,
    target_approver_pin: preferred.pin,
    target_approver_name: preferred.name || '',
  });
}

export async function listWorkerExpenseRequests(pin) {
  return listMyRequests(pin, 50);
}

export async function listApproverExpenseRequests(pin) {
  return listPendingRequestsForApprover(pin, 100);
}

export async function approveWorkerExpense({ requestId, actor }) {
  return approveRequest({ request_id: requestId, approver_pin: actor?.pin, approver_name: actor?.name, approver_role: actor?.role });
}

export async function rejectWorkerExpense({ requestId, actor, note = '' }) {
  return rejectRequest({ request_id: requestId, approver_pin: actor?.pin, approver_name: actor?.name, approver_role: actor?.role, reject_note: note });
}
