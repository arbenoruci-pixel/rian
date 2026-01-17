import { NextResponse } from 'next/server';
import { adminClient, requirePinFromReq, buildPayload } from '../_lib/dbdaily';

export const runtime = 'nodejs';

export async function GET(req) {
  try {
    const pinCheck = requirePinFromReq(req);
    if (!pinCheck.ok) return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });

    const sb = adminClient();
    const url = new URL(req.url);
    const raw = String(url.searchParams.get('raw') || '').trim() === '1';

    const { data, error } = await sb
      .from('backups_daily')
      .select('id, backup_date, created_at, clients_all, orders_all, orders_open')
      .order('backup_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: 'SUPABASE_BACKUPS_QUERY_FAILED', detail: error.message }, { status: 500 });
    }
    if (!data) return NextResponse.json({ ok: false, error: 'NO_BACKUP_FOUND' }, { status: 404 });

    const payload = buildPayload(data);

    if (raw) {
      return NextResponse.json(payload, { status: 200 });
    }

    const item = {
      id: data.backup_date,
      created_at: data.created_at,
      pin: pinCheck.pin || '',
      payload,
    };

    return NextResponse.json({ ok: true, item, source: 'backups_daily' });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'LATEST_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}
