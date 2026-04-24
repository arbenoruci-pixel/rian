import { NextResponse } from 'next/server';
import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

const SLOT_WINDOWS = {
  morning: '09:00 – 13:00',
  evening: '18:00 – 21:00',
};

function cleanText(value) {
  return String(value || '').trim();
}

function safeNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function redirectWith(req, params = {}) {
  const url = new URL('/porosit', req.url);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return NextResponse.redirect(url, { status: 303 });
}

function withTimeout(promise, ms = 12000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('PUBLIC_BOOKING_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function POST(req) {
  try {
    const form = await req.formData();

    const name = cleanText(form.get('name'));
    const phone = cleanText(form.get('phone'));
    const address = cleanText(form.get('address'));
    const pieces = safeNumberOrNull(form.get('pieces'));
    const note = cleanText(form.get('note'));
    const pickupDate = cleanText(form.get('pickupDate'));
    const pickupSlot = cleanText(form.get('pickupSlot')).toLowerCase();
    const pickupWindow = cleanText(form.get('pickupWindow')) || SLOT_WINDOWS[pickupSlot] || '';
    const lat = safeNumberOrNull(form.get('lat'));
    const lng = safeNumberOrNull(form.get('lng'));

    if (!name || !phone || !address || !pickupDate || !pickupSlot) {
      return redirectWith(req, { err: 'Ju lutem plotësoni fushat e detyrueshme dhe zgjidhni orarin.' });
    }

    if (!SLOT_WINDOWS[pickupSlot]) {
      return redirectWith(req, { err: 'Orari i zgjedhur nuk është valid.' });
    }

    const admin = createAdminClientOrThrow();
    const submittedAt = new Date().toISOString();

    const rawPayload = {
      client_name: name,
      client_phone: phone,
      status: 'inbox',
      data: {
        client: {
          name,
          phone,
          address,
          gps_lat: lat,
          gps_lng: lng,
          gps: lat != null && lng != null ? { lat, lng } : null,
        },
        pieces: pieces || 0,
        note,
        source: 'facebook_web',
        created_by: 'ONLINE',
        order_origin: 'ONLINE_WEB',
        submitted_at: submittedAt,
        gps_lat: lat,
        gps_lng: lng,
        defer_dispatch_code: true,
        pickup_date: pickupDate,
        pickup_slot: pickupSlot,
        pickup_window: pickupWindow,
      },
    };

    const payload = sanitizeTransportOrderPayload(rawPayload);
    const { error } = await withTimeout(
      admin.from('transport_orders').insert(payload).select('id').maybeSingle(),
      12000
    );
    if (error) throw error;

    return redirectWith(req, {
      ok: '1',
      name,
      phone,
      pickupDate,
      pickupSlot,
      pickupWindow,
    });
  } catch (error) {
    console.error('public-booking POST failed', error);
    return redirectWith(req, { err: 'Ndodhi një problem me serverin. Ju lutem provoni përsëri.' });
  }
}
