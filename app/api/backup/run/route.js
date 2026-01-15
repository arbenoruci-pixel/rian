import { NextResponse } from 'next/server';
import { getServiceSupabase } from '../_lib/sbAdmin';
import { BACKUPS_TABLE, getReqPin, requirePinOrBypass, buildSnapshot } from '../_lib/utils';

export const dynamic = 'force-dynamic';

async function runBackup(req) {
  const sb = getServiceSupabase();

  const pin = getReqPin(req);
  const pinDecision = requirePinOrBypass(pin);
  if (!pinDecision.ok) {
    return { ok: false, status: 401, error: pinDecision.error };
  }

  // Build snapshot from DB (orders table)
  const snapshot = await buildSnapshot(sb);

  const insertRow = {
    pin: pinDecision.pin || null,
    device: req.headers.get('user-agent') || '',
    has_payload: true,
    payload: snapshot,
  };

  const { data, error } = await sb.from(BACKUPS_TABLE).insert(insertRow).select('id,created_at,pin').single();
  if (error) {
    return {
      ok: false,
      status: 500,
      error: 'BACKUP_INSERT_FAILED',
      detail: { message: error.message, code: error.code },
    };
  }

  return { ok: true, id: data?.id, created_at: data?.created_at, pin: data?.pin || null, snapshot_meta: snapshot?.meta };
}

export async function POST(req) {
  try {
    const out = await runBackup(req);
    if (!out.ok) return NextResponse.json(out, { status: out.status || 500 });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

// Convenience: allow opening /api/backup/run in the browser (avoids HTTP 405).
export async function GET(req) {
  return POST(req);
}
