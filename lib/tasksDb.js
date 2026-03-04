import { supabase } from '@/lib/supabaseClient';
import { updateOrderInDb } from '@/lib/ordersDb';

const TABLE = 'tepiha_tasks';

function nowIso() {
  return new Date().toISOString();
}

export async function listMyOpenTasks(toUserId, limit = 10) {
  if (!toUserId) return { ok: true, items: [] };
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      'id,to_user_id,from_user_id,type,status,title,body,related_order_id,order_code,priority,created_at,responded_at,done_at,outcome,meta'
    )
    .eq('to_user_id', toUserId)
    .in('status', ['SENT', 'ACCEPTED'])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) return { ok: false, error };
  return { ok: true, items: data || [] };
}

export async function createTask(row) {
  const payload = {
    to_user_id: row.to_user_id,
    from_user_id: row.from_user_id || null,
    type: row.type || 'OTHER',
    status: 'SENT',
    title: row.title || null,
    body: row.body || null,
    related_order_id: row.related_order_id || null,
    order_code: row.order_code || null,
    priority: row.priority || 'MED',
    meta: row.meta || null,
    created_at: nowIso(),
  };

  const { data, error } = await supabase.from(TABLE).insert(payload).select('id').single();
  if (error) return { ok: false, error };
  return { ok: true, id: data?.id };
}

export async function acceptTask(taskId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ status: 'ACCEPTED', responded_at: nowIso() })
    .eq('id', taskId);

  if (error) return { ok: false, error };
  return { ok: true };
}

export async function rejectTask(taskId, reason) {
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'REJECTED',
      responded_at: nowIso(),
      reject_reason: String(reason || '').trim().slice(0, 500),
    })
    .eq('id', taskId);

  if (error) return { ok: false, error };
  return { ok: true };
}

export async function completeTask(task, outcome, note) {
  const out = String(outcome || '').toUpperCase();

  const patch = {
    status: 'DONE',
    done_at: nowIso(),
    outcome: out || null,
    done_note: note ? String(note).trim().slice(0, 800) : null,
  };

  const { error } = await supabase.from(TABLE).update(patch).eq('id', task.id);
  if (error) return { ok: false, error };

  // OPTION 2 (approved): READY -> auto set order status to 'gati'
  if (out === 'READY' && task.related_order_id) {
    try {
      await updateOrderInDb(task.related_order_id, { status: 'gati', ready_at: nowIso() });
    } catch {
      // keep tasks stable even if order update fails
    }
  }

  return { ok: true };
}
