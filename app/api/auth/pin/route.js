import { NextResponse } from 'next/server';
import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';

// PIN AUTH (Server-side)
// - Uses service role key (SUPABASE_SERVICE_ROLE_KEY) on the server
// - Returns only the matched user's role/name for the provided PIN

function normPin(pin) {
  const p = String(pin ?? '').trim();
  if (!/^[0-9]{4,8}$/.test(p)) return null;
  return p;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const pin = normPin(body?.pin);
    if (!pin) return NextResponse.json({ ok: false, error: 'INVALID_PIN' }, { status: 400 });

    const supabase = createAdminClientOrThrow();

    // Prefer base table (users) to avoid VIEW schema mismatch.
    let data = null;
    let error = null;

    {
      const r1 = await supabase
        .from('users')
        .select('pin, role, name, is_active, is_master')
        .eq('pin', pin)
        .limit(1)
        .maybeSingle();
      data = r1.data;
      error = r1.error;
    }

    if (error) {
      const msg = String(error?.message || '').toLowerCase();
      const missingCol = msg.includes('column') && msg.includes('does not exist');
      if (missingCol) {
        const r2 = await supabase
          .from('users')
          .select('pin, role, name')
          .eq('pin', pin)
          .limit(1)
          .maybeSingle();
        data = r2.data ? { ...r2.data, is_active: true, is_master: false } : null;
        error = r2.error;
      }
    }

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (!data) return NextResponse.json({ ok: false, error: 'PIN_NOT_FOUND' }, { status: 404 });
    if (data.is_active === false) return NextResponse.json({ ok: false, error: 'PIN_DISABLED' }, { status: 403 });

    return NextResponse.json({
      ok: true,
      user: {
        pin: String(data.pin),
        role: String(data.role || '').toUpperCase(),
        name: data.name || null,
        is_master: !!data.is_master,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
