import { NextResponse } from 'next/server';
import { adminClient } from '../_lib/dbdaily';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const sb = adminClient();

    const { error: tErr } = await sb.from('backups_daily').select('id').limit(1);
    const tableOk = !tErr;

    let rpcOk = true;
    const { error: rErr } = await sb.rpc('run_daily_backup');
    if (rErr && !String(rErr.message || '').includes('duplicate key')) {
      // if it fails only because today's row already exists, that's fine
      rpcOk = false;
    }

    return NextResponse.json({ ok: true, backups_daily_ok: tableOk, rpc_ok: rpcOk, table_error: tErr?.message || null, rpc_error: rErr?.message || null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'PING_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}
