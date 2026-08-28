import { supabase } from '@/lib/supabaseClient';

export async function listClientRecords(options = {}) {
  const select = options?.select || '*';
  const makeQuery = () => {
    let q = supabase.from('clients').select(select);
    const eq = options?.eq || {};
    for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
    if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
    const tieBreakBy = options?.tieBreakBy || (options?.fetchAll ? 'id' : '');
    if (tieBreakBy && tieBreakBy !== options?.orderBy) {
      q = q.order(tieBreakBy, { ascending: !!options?.tieBreakAscending });
    }
    return q;
  };

  if (options?.fetchAll) {
    const pageSize = Math.max(1, Math.min(Number(options?.pageSize) || 1000, 1000));
    const maxRows = Math.max(pageSize, Number(options?.maxRows) || 50_000);
    const rows = [];
    while (rows.length < maxRows) {
      const from = rows.length;
      const to = Math.min(from + pageSize, maxRows) - 1;
      const { data, error } = await makeQuery().range(from, to);
      if (error) throw error;
      const page = Array.isArray(data) ? data : [];
      rows.push(...page);
      if (page.length < (to - from + 1)) return rows;
    }
    throw new Error(`CLIENT_FETCH_ALL_LIMIT_REACHED_${maxRows}`);
  }

  let q = makeQuery();
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
