import multer from 'multer';
import { createAdminClientOrThrow, cleanText, safeNumberOrNull, sanitizeTransportOrderPayload, redirect } from './_helpers.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const upload = multer();
const SLOT_WINDOWS = {
  morning: '09:00 – 13:00',
  evening: '18:00 – 21:00',
};

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

function redirectWith(res, params = {}) {
  const url = new URL('/porosit', 'http://local');
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return redirect(res, `${url.pathname}${url.search}`, 303);
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return redirectWith(res, { err: 'METHOD_NOT_ALLOWED' });

  try {
    await runMiddleware(req, res, upload.none());
    const form = req.body || {};

    const name = cleanText(form.name);
    const phone = cleanText(form.phone);
    const address = cleanText(form.address);
    const pieces = safeNumberOrNull(form.pieces);
    const note = cleanText(form.note);
    const pickupDate = cleanText(form.pickupDate);
    const pickupSlot = cleanText(form.pickupSlot).toLowerCase();
    const pickupWindow = cleanText(form.pickupWindow) || SLOT_WINDOWS[pickupSlot] || '';
    const lat = safeNumberOrNull(form.lat);
    const lng = safeNumberOrNull(form.lng);

    if (!name || !phone || !address || !pickupDate || !pickupSlot) {
      return redirectWith(res, { err: 'Ju lutem plotësoni fushat e detyrueshme dhe zgjidhni orarin.' });
    }
    if (!SLOT_WINDOWS[pickupSlot]) {
      return redirectWith(res, { err: 'Orari i zgjedhur nuk është valid.' });
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
    const { error } = await admin.from('transport_orders').insert(payload).select('id').maybeSingle();
    if (error) throw error;

    return redirectWith(res, {
      ok: '1',
      name,
      phone,
      pickupDate,
      pickupSlot,
      pickupWindow,
    });
  } catch (error) {
    console.error('public-booking failed', error);
    return redirectWith(res, { err: 'Ndodhi një problem me serverin. Ju lutem provoni përsëri.' });
  }
}
