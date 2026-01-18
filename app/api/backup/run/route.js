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

function checkPinIfProvided(req) {
  const { searchParams } = new URL(req.url);
  const pin = (searchParams.get('pin') || '').trim();
  if (!pin) return { ok: true, pin: '' }; // allow cron / automated calls

  const expected = (process.env.BACKUP_PIN && String(process.env.BACKUP_PIN).trim()) || '654321';
  if (pin !== expected) return { ok: false, error: 'INVALID_PIN' };
  return { ok: true, pin };
}

export async function POST(req) {
  try {
    const pinCheck = checkPinIfProvided(req);
    if (!pinCheck.ok) {
      return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });
    }

    const sb = getSupabaseAdmin();
    const table = await detectBackupsTable(sb);

    // Fetch all clients (permanent codes) + all orders
    const { data: clients, error: cErr } = await sb
      .from('clients')
      .select('id, code, full_name, first_name, last_name, phone, photo_url, created_at, updated_at')
      .order('code', { ascending: true });
    if (cErr) throw cErr;

    const { data: orders, error: oErr } = await sb
      .from('orders')
      .select('*')
      .order('created_at', { ascending: true });
    if (oErr) throw oErr;

    const openOrdersCount = (orders || []).filter((o) => !['dorzim', 'archived'].includes(String(o.status || '').toLowerCase())).length;

    const payload = {
      clients: clients || [],
      orders: orders || [],
      clients_count: (clients || []).length,
      orders_count: (orders || []).length,
      open_orders_count: openOrdersCount,
    };

    const row = {
      created_at: new Date().toISOString(),
      payload,
    };
    if (pinCheck.pin) row.pin = pinCheck.pin;

    const { error: bErr } = await sb.from(table).insert([row]);
    if (bErr) throw bErr;

    return NextResponse.json({ ok: true, saved: { clients_cnt: payload.clients_count, orders_cnt: payload.orders_count, open_orders_cnt: payload.open_orders_count } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'BACKUP_FAILED', detail: String(e?.message || e) }, { status: 500 });
  }
}
