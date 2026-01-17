import { NextResponse } from 'next/server';
import { adminClient, requirePinFromReq } from '../_lib/dbdaily';

export const runtime = 'nodejs';

export async function GET(req) {
  try {
    const pinCheck = requirePinFromReq(req);
    if (!pinCheck.ok) return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });

    const sb = adminClient();
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 30)));

    const { data, error } = await sb
      .from('backups_daily')
      .select('backup_date, created_at')
      .order('backup_date', { ascending: false })
      .limit(limit);

    if (error) return NextResponse.json({ ok: false, error: 'LIST_FAILED', detail: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, items: data || [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'LIST_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}
