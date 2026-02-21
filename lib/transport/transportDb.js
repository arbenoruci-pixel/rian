'use client';

import { supabase } from '@/lib/supabaseClient';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

function normTCode(v) {
  const s = String(v || '').trim();
  const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '';
  return n ? `T${n}` : '';
}

// NOTE:
// We intentionally DO NOT use .single() in selects, because PostgREST will throw
// "Cannot coerce the result to a single JSON object" if 0 or >1 rows match.
// Instead we always limit(1) and then take the first row.

export async function upsertTransportClient(input) {
  try {
    const name = String(input?.name || '').trim();
    const phone = String(input?.phone || '').trim();
    const phone_digits = onlyDigits(phone);

    const payload = {
      name,
      phone,
      phone_digits,
      address: input?.address ?? null,
      gps_lat: input?.gps_lat ?? null,
      gps_lng: input?.gps_lng ?? null,
      notes: input?.notes ?? null,
      updated_at: new Date().toISOString(),
      ...(input?.tcode ? { tcode: normTCode(input.tcode) } : {}),
    };

    // If caller provides an ID, update that exact row.
    if (input?.id) {
      const { data, error } = await supabase
        .from('transport_clients')
        .update(payload)
        .eq('id', input.id)
        .select('id')
        .limit(1);

      if (error) return { ok: false, error: error.message };
      const row = Array.isArray(data) ? data[0] : null;
      return { ok: true, id: row?.id || input.id };
    }

    // Otherwise: try to find an existing client by phone_digits.
    // If duplicates exist, we take the newest updated.
    if (phone_digits) {
      const { data: found, error: findErr } = await supabase
        .from('transport_clients')
        .select('id')
        .eq('phone_digits', phone_digits)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (!findErr && Array.isArray(found) && found[0]?.id) {
        const id = found[0].id;
        const { error: updErr } = await supabase
          .from('transport_clients')
          .update(payload)
          .eq('id', id);
        if (updErr) return { ok: false, error: updErr.message };
        return { ok: true, id };
      }
    }

    // Insert new
    const { data, error } = await supabase
      .from('transport_clients')
      .insert(payload)
      .select('id')
      .limit(1);

    if (error) return { ok: false, error: error.message };
    const row = Array.isArray(data) ? data[0] : null;
    return { ok: true, id: row?.id || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- ORDERS ---
export async function insertTransportOrder(input) {
  try {
    // Accept both the old "orderData" shape and the new direct payload.
    const dataObj = input?.data ?? input?.dataObj ?? input?.payload?.data ?? null;

    const codeStr =
      input?.code_str ||
      input?.codeStr ||
      input?.order_code ||
      input?.data?.client?.code ||
      input?.dataObj?.client?.code ||
      '';

    const code_str = normTCode(codeStr);

    const client_tcode = normTCode(
      input?.client_tcode ?? input?.clientTcode ?? input?.data?.client?.tcode ?? input?.dataObj?.client?.tcode ?? ''
    ) || null;
    const code_n =
      Number(input?.code_n ?? input?.codeN ?? input?.code ?? input?.codeNum ?? 0) ||
      Number(code_str.replace(/\D+/g, '')) ||
      null;

    // IMPORTANT:
    // In some setups `transport_orders.transport_id` is a GENERATED column
    // derived from `data->>'transport_id'`. In that case, inserting a non-default
    // value into `transport_id` will fail.
    // So we ONLY store transport_id inside `data.transport_id`.
    const tid = String(input?.transport_id ?? input?.transportId ?? dataObj?.transport_id ?? dataObj?.transportId ?? '').trim();
    const safeData = {
      ...(dataObj || input?.data || {}),
      ...(tid ? { transport_id: tid } : {}),
    };

    const payload = {
      id: input?.id,
      code_str,
      code_n,
      client_tcode,
      visit_nr: Number(input?.visit_nr ?? input?.visitNr ?? input?.data?.visit_nr ?? input?.dataObj?.visit_nr ?? null) || null,
      client_id: input?.client_id ?? input?.clientId ?? null,
      client_name:
        input?.client_name ||
        input?.clientName ||
        input?.data?.client?.name ||
        input?.dataObj?.client?.name ||
        '',
      client_phone:
        input?.client_phone ||
        input?.clientPhone ||
        input?.data?.client?.phone ||
        input?.dataObj?.client?.phone ||
        '',
      status: input?.status || input?.data?.status || input?.dataObj?.status || 'loaded',
      data: safeData,
      created_at: input?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(input?.tcode ? { tcode: normTCode(input.tcode) } : {}),
    };

    const { error } = await supabase
      .from('transport_orders')
      .insert(payload);

    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { id: payload.id, code_str: payload.code_str, code_n: payload.code_n, status: payload.status } };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function saveOfflineTransportOrder(order) {
  try {
    const key = 'transport_orders_offline_v1';
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(order);
    if (list.length > 200) list.length = 200;
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
