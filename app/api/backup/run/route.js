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

function normalizeClient(c) {
  const first = String(c?.first_name || '').trim();
  const last = String(c?.last_name || '').trim();
  const full = String(c?.full_name || '').trim();
  const name = (full || `${first} ${last}`.trim()).trim();
  return {
    ...c,
    // for UI/search compatibility
    name: name || null,
  };
}

function normalizeOrder(o, clientByCode) {
  const code = o?.client_code;
  const c = clientByCode.get(String(code));
  const client_name = c?.name || c?.full_name || null;
  const client_phone = c?.phone || null;
  return {
    ...o,
    client_name,
    client_phone,
  };
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

    // Normalize names so UI can always display/search properly
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
    if (pinCheck.pin) row.pin = pinCheck.pin;

    const { error: bErr } = await sb.from(table).insert([row]);
    if (bErr) throw bErr;

    return NextResponse.json({ ok: true, saved: { clients_cnt: payload.clients_count, orders_cnt: payload.orders_count, open_orders_cnt: payload.open_orders_count } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'BACKUP_FAILED', detail: String(e?.message || e) }, { status: 500 });
  }
}
