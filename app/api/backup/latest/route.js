import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

async function detectBackupsTable(sb) {
  // Prefer new table name if it exists
  const { error: e1 } = await sb.from('app_backups').select('id').limit(1);
  if (!e1) return 'app_backups';
  const { error: e2 } = await sb.from('backups').select('id').limit(1);
  if (!e2) return 'backups';
  return 'app_backups'; // fallback
}

function normalizeRow(row) {
  const payload = row?.payload || null;
  const clients = Array.isArray(payload?.clients) ? payload.clients : [];
  const orders = Array.isArray(payload?.orders) ? payload.orders : [];
  const generatedAt = row?.generated_at || row?.created_at || null;
  const backupDate = payload?.backup_date || (generatedAt ? String(generatedAt).slice(0, 10) : null);

  return {
    id: row?.id,
    created_at: row?.created_at || null,
    generated_at: generatedAt,
    pin: row?.pin || null,
    backup_date: backupDate,
    clients_count: row?.clients_count ?? payload?.clients_cnt ?? clients.length,
    orders_count: row?.orders_count ?? payload?.orders_cnt ?? orders.length,
    open_orders_count: row?.open_orders_count ?? payload?.open_orders_cnt ?? null,
    clients,
    orders,
    payload,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const pin = (searchParams.get('pin') || '').trim();
    const raw = (searchParams.get('raw') || '') === '1';

    const sb = getSupabaseAdmin();
    if (!sb) {
      return NextResponse.json(
        { ok: false, error: 'MISSING_SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500 }
      );
    }

    const table = await detectBackupsTable(sb);

    let q = sb
      .from(table)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    if (pin) q = q.eq('pin', pin);

    const { data, error } = await q;
    if (error) {
      return NextResponse.json(
        { ok: false, error: 'SUPABASE_BACKUPS_QUERY_FAILED', detail: error.message },
        { status: 500 }
      );
    }

    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (!row) {
      return NextResponse.json({ ok: true, backup: null });
    }

    const backup = normalizeRow(row);

    if (raw) {
      const filename = `tepiha_backup_${backup.backup_date || 'latest'}_${String(backup.id || '').slice(0, 8)}.json`;
      const body = JSON.stringify(backup.payload || { clients: backup.clients, orders: backup.orders }, null, 2);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    }

    return NextResponse.json({ ok: true, backup });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'UNEXPECTED', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
