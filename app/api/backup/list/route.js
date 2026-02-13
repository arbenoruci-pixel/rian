import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';

export const runtime = 'nodejs';

async function detectBackupsTable(sb) {
  for (const t of ['app_backups', 'backups']) {
    const { error } = await sb.from(t).select('id').limit(1);
    if (!error) return t;
  }
  throw new Error('NO_BACKUPS_TABLE_ACCESS');
}

export async function GET(req) {
  try {
    const sb = getSupabaseAdmin();
    const table = await detectBackupsTable(sb);

    const { searchParams } = new URL(req.url);
    const pin = (searchParams.get('pin') || '').trim();

    // Pin is optional. If provided, filter to that pin.
    let q = sb.from(table).select('id, created_at, payload, pin').order('created_at', { ascending: false }).limit(20);
    if (pin) q = q.eq('pin', pin);

    const { data, error } = await q;
    if (error) throw error;

    const items = (data || []).map((r) => {
      const payload = r?.payload;
      return {
        id: r?.id,
        created_at: r?.created_at,
        pin: r?.pin ?? null,
        clients_cnt: payload?.clients_count ?? null,
        orders_cnt: payload?.orders_count ?? null,
        open_orders_cnt: payload?.open_orders_count ?? null,
      };
    });

    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'LIST_FAILED', detail: String(e?.message || e) }, { status: 500 });
  }
}
