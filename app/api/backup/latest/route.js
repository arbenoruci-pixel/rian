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

    // Pin is optional. If provided, return latest backup for that pin.
    let q = sb.from(table).select('id, created_at, payload, pin').order('created_at', { ascending: false }).limit(1);
    if (pin) q = q.eq('pin', pin);

    const { data, error } = await q;
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return NextResponse.json({ ok: true, backup: null });

    const payload = row?.payload;
    return NextResponse.json({
      ok: true,
      backup: {
        id: row?.id,
        created_at: row?.created_at,
        pin: row?.pin ?? null,
        clients: payload?.clients || [],
        orders: payload?.orders || [],
        clients_count: payload?.clients_count ?? 0,
        orders_count: payload?.orders_count ?? 0,
        open_orders_count: payload?.open_orders_count ?? 0,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'LATEST_FAILED', detail: String(e?.message || e) }, { status: 500 });
  }
}
