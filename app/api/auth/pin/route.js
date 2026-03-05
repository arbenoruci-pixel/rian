import { NextResponse } from 'next/server';
import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';

// PIN AUTH (Server-side)
// - Uses service role key (SUPABASE_SERVICE_ROLE_KEY) on the server
// - Does NOT expose the full users list
// - Returns only the matched user's role/name for the provided PIN

function normPin(pin) {
  const p = String(pin ?? '').trim();
  // allow digits only (4-8)
  if (!/^[0-9]{4,8}$/.test(p)) return null;
  return p;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const pin = normPin(body?.pin);
    if (!pin) return NextResponse.json({ ok: false, error: 'INVALID_PIN' }, { status: 400 });

    const supabase = createAdminClientOrThrow();

    const { data, error } = await supabase
      .from('tepiha_users')
      .select('pin, role, name')
      .eq('pin', pin)
      .limit(1);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const user = Array.isArray(data) && data.length ? data[0] : null;
    if (!user) return NextResponse.json({ ok: false, error: 'PIN_NOT_FOUND' }, { status: 404 });

    return NextResponse.json({ ok: true, user: { pin: user.pin, role: String(user.role || '').toUpperCase(), name: user.name } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
