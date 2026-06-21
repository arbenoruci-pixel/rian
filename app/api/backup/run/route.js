import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';
import { backupUnauthorized, requireBackupPin } from '../_lib/auth';
export const dynamic = 'force-dynamic';

export const runtime = 'nodejs';

async function detectBackupsTable(sb) {
  for (const t of ['app_backups', 'backups']) {
    const { error } = await sb.from(t).select('id').limit(1);
    if (!error) return t;
  }
  throw new Error('NO_BACKUPS_TABLE_ACCESS');
}

function normalizeClient(c) {
  const first = String(c?.first_name || '').trim();
  const last = String(c?.last_name || '').trim();
  const full = String(c?.full_name || '').trim();
  const name = (full || `${first} ${last}`.trim()).trim();
  return {
    ...c,
    name: name || null,
  };
}

export async function POST(req) {
  try {
    const auth = requireBackupPin(req, { allowCron: true });
    if (!auth.ok) return backupUnauthorized(auth);

    const sb = getSupabaseAdmin();
    const table = await detectBackupsTable(sb);

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

    const clientsN = (clients || []).map(normalizeClient);
    const byCode = new Map(clientsN.map((c) => [String(c.code ?? ''), c]));

    const ordersN = (orders || []).map((o) => {
      const cc = String(o?.client_code ?? o?.clientCode ?? '');
      const c = byCode.get(cc);
      const client_name = c ? (c.name || c.full_name || '') : String(o?.client_name || o?.clientName || '');
      const client_phone = c ? String(c.phone || '') : String(o?.client_phone || o?.clientPhone || '');
      return {
        ...o,
        client_name: client_name || null,
        client_phone: client_phone || null,
      };
    });

    const openOrdersCount = ordersN.filter((o) => !['dorzim', 'archived'].includes(String(o.status || '').toLowerCase())).length;

    const payload = {
      clients: clientsN,
      orders: ordersN,
      clients_count: (clients || []).length,
      orders_count: (orders || []).length,
      open_orders_count: openOrdersCount,
    };

    const row = {
      created_at: new Date().toISOString(),
      payload,
    };
    if (auth.via === 'pin' && auth.pin) row.pin = auth.pin;

    const { error: bErr } = await sb.from(table).insert([row]);
    if (bErr) throw bErr;

    return NextResponse.json({ ok: true, saved: { clients_cnt: payload.clients_count, orders_cnt: payload.orders_count, open_orders_cnt: payload.open_orders_count } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'BACKUP_FAILED', detail: String(e?.message || e) }, { status: 500 });
  }
}
