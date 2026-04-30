import { supabase } from '@/lib/supabaseClient';

export async function listClientRecords(options = {}) {
  const select = options?.select || '*';
  let q = supabase.from('clients').select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function fetchClientByPhone(phone, select = '*') {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  const { data, error } = await supabase.from('clients').select(select).eq('phone', raw).maybeSingle();
  if (error) throw error;
  return data || null;
}
