import { NextResponse } from 'next/server';
import { adminClient, requirePinFromReq, buildPayload } from '../_lib/dbdaily';

export const runtime = 'nodejs';

export async function GET(req) {
  try {
    const pinCheck = requirePinFromReq(req);
    if (!pinCheck.ok) return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });

    const sb = adminClient();
    const url = new URL(req.url);
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return NextResponse.json({ ok: false, error: 'MISSING_ID' }, { status: 400 });

    const { data, error } = await sb
      .from('backups_daily')
      .select('id, backup_date, created_at, clients_all, orders_all, orders_open')
      .eq('backup_date', id)
      .maybeSingle();

    if (error) return NextResponse.json({ ok: false, error: 'BLOB_FAILED', detail: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });

    const payload = buildPayload(data);
    return NextResponse.json({ ok: true, item: { id: data.backup_date, created_at: data.created_at, payload } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'BLOB_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}
