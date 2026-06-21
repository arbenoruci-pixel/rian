import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';
export const dynamic = 'force-dynamic';

function normalizeNote(value) {
  const text = String(value || '').trim();
  return text || null;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.orderId || '').trim();
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const note = normalizeNote(body?.note);

    if (!orderId) {
      return NextResponse.json({ ok: false, error: 'ORDER_ID_REQUIRED' }, { status: 400 });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ ok: false, error: 'INVALID_COORDS' }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('transport_orders')
      .select('id, data')
      .eq('id', orderId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ ok: false, error: fetchError.message || 'FETCH_FAILED' }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'ORDER_NOT_FOUND' }, { status: 404 });
    }

    const oldData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data)
      ? existing.data
      : {};

    const payload = {
      data: {
        ...oldData,
        gps_lat: lat,
        gps_lng: lng,
      },
      client_notes: note,
    };

    const { error: updateError } = await supabase
      .from('transport_orders')
      .update(payload)
      .eq('id', orderId);

    if (updateError) {
      return NextResponse.json({ ok: false, error: updateError.message || 'UPDATE_FAILED' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err || 'UNKNOWN_ERROR') },
      { status: 500 }
    );
  }
}
