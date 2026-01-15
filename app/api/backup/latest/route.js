import { NextResponse } from 'next/server';
import { getServiceSupabase } from '../_lib/sbAdmin';
import { BACKUPS_TABLE, getReqPin, requirePinOrBypass } from '../_lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const sb = getServiceSupabase();

    const u = new URL(req.url);
    const raw = u.searchParams.get('raw') === '1';

    const pin = getReqPin(req);
    const pinDecision = requirePinOrBypass(pin);
    if (!pinDecision.ok) {
      return NextResponse.json({ ok: false, error: pinDecision.error }, { status: 401 });
    }

    let q = sb.from(BACKUPS_TABLE).select('id,created_at,device,pin,payload,has_payload').order('created_at', { ascending: false }).limit(1);
    if (pinDecision.pin) q = q.eq('pin', pinDecision.pin);
    // If pinDecision.pin is null (bypass mode), we fetch latest overall.

    const { data, error } = await q.maybeSingle();
    if (error) {
      return NextResponse.json({ ok: false, error: 'SUPABASE_BACKUPS_QUERY_FAILED', detail: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ ok: false, error: 'NO_BACKUP_FOUND' }, { status: 404 });
    }

    if (raw) {
      const body = JSON.stringify(data.payload || {}, null, 2);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="tepiha-backup-${data.id}.json"`,
          'cache-control': 'no-store',
        },
      });
    }

    return NextResponse.json({ ok: true, item: data, table: BACKUPS_TABLE, used_pin: pinDecision.pin || null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
