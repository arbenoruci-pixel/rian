import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

async function detectBackupsTable(sb) {
  const { error: e1 } = await sb.from('app_backups').select('id').limit(1);
  if (!e1) return 'app_backups';
  const { error: e2 } = await sb.from('backups').select('id').limit(1);
  if (!e2) return 'backups';
  return 'app_backups';
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

async function buildLivePayload(sb) {
  const { data: clients, error: cErr } = await sb
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, created_at, updated_at')
    .order('code', { ascending: true });
  if (cErr) throw cErr;

  const { data: orders, error: oErr } = await sb
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
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

  return {
    id: 'live',
    created_at: new Date().toISOString(),
    generated_at: new Date().toISOString(),
    pin: null,
    backup_date: new Date().toISOString().slice(0, 10),
    clients_count: clientsN.length,
    orders_count: ordersN.length,
    open_orders_count: openOrdersCount,
    clients: clientsN,
    orders: ordersN,
    payload: {
      live: true,
      clients: clientsN,
      orders: ordersN,
      clients_count: clientsN.length,
      orders_count: ordersN.length,
      open_orders_count: openOrdersCount,
      generated_at: new Date().toISOString(),
    },
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const pin = (searchParams.get('pin') || '').trim();
    const raw = (searchParams.get('raw') || '') === '1';
    const live = (searchParams.get('live') || '') === '1';

    const sb = getSupabaseAdmin();
    if (!sb) {
      return NextResponse.json(
        { ok: false, error: 'MISSING_SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500 }
      );
    }

    if (live) {
      const backup = await buildLivePayload(sb);
      if (raw) {
        const filename = `tepiha_live_${backup.backup_date}.json`;
        const body = JSON.stringify(backup.payload, null, 2);
        return new NextResponse(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
          },
        });
      }
      return NextResponse.json({ ok: true, backup, source: 'live' });
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

    return NextResponse.json({ ok: true, backup, source: 'snapshot' });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'UNEXPECTED', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
