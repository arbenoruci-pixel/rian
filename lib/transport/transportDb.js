'use client';

import { supabase } from '@/lib/supabaseClient';
import { buildTransportClientSearchCode, sanitizeTransportClientPayload as sanitizeSharedTransportClientPayload, sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normTCode(v) {
  const s = String(v || '').trim();
  const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '';
  return n ? `T${n}` : '';
}


function ensureTransportClientSearchCode(payload = {}, { tcode = '', name = '', phoneDigits = '' } = {}) {
  return sanitizeSharedTransportClientPayload({ ...(payload || {}) }, { mode: 'patch', tcode, name, phoneDigits });
}

function sanitizeTransportClientPayload(input = {}, { tcode = '', name = '', phoneDigits = '' } = {}) {
  return sanitizeSharedTransportClientPayload(input, { mode: 'upsert', tcode, name, phoneDigits });
}

async function retryTransportClientWrite(run, fallbackCtx = {}) {
  const first = await run(false);
  if (!first?.error) return first;
  const msg = String(first.error?.message || first.error || '');
  const code = String(first.error?.code || '');
  const searchCodeIssue = /search_code/i.test(msg) || (/bigint/i.test(msg) && /invalid input syntax/i.test(msg));
  if ((code === '23502' || code === '22P02') && searchCodeIssue) {
    return run(true);
  }
  return first;
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

    const normalizedTcode = input?.tcode ? normTCode(input.tcode) : '';
    const payload = sanitizeTransportClientPayload(input, { tcode: normalizedTcode, name, phoneDigits: phone_digits });

    // If caller provides an ID, update that exact row.
    if (input?.id) {
      const result = await retryTransportClientWrite(async (forceFallback) => {
        const safePayload = forceFallback
          ? sanitizeTransportClientPayload({ ...input, search_code: '' }, { tcode: normalizedTcode, name, phoneDigits: phone_digits || String(Date.now()) })
          : payload;
        const { data, error } = await supabase
          .from('transport_clients')
          .update(safePayload)
          .eq('id', input.id)
          .select('id')
          .limit(1);
        return { data, error };
      });

      if (result?.error) return { ok: false, error: result.error.message };
      const row = Array.isArray(result?.data) ? result.data[0] : null;
      return { ok: true, id: row?.id || input.id };
    }

    // Otherwise: try to find an existing client by tcode first, then by phone_digits.
    if (normalizedTcode) {
      const { data: foundByTcode, error: findByTcodeErr } = await supabase
        .from('transport_clients')
        .select('id')
        .eq('tcode', normalizedTcode)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (!findByTcodeErr && Array.isArray(foundByTcode) && foundByTcode[0]?.id) {
        const id = foundByTcode[0].id;
        const result = await retryTransportClientWrite(async (forceFallback) => {
          const safePayload = forceFallback
            ? sanitizeSharedTransportClientPayload({ ...payload, search_code: '' }, { mode: 'upsert', tcode: normalizedTcode, name, phoneDigits: phone_digits || String(Date.now()) })
            : payload;
          const { error: updErr } = await supabase
            .from('transport_clients')
            .update(safePayload)
            .eq('id', id);
          return { error: updErr };
        });
        if (result?.error) return { ok: false, error: result.error.message };
        return { ok: true, id };
      }
    }

    if (phone_digits) {
      const { data: found, error: findErr } = await supabase
        .from('transport_clients')
        .select('id')
        .eq('phone_digits', phone_digits)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (!findErr && Array.isArray(found) && found[0]?.id) {
        const id = found[0].id;
        const result = await retryTransportClientWrite(async (forceFallback) => {
          const safePayload = forceFallback
            ? sanitizeSharedTransportClientPayload({ ...payload, search_code: '' }, { mode: 'upsert', tcode: normalizedTcode, name, phoneDigits: phone_digits || String(Date.now()) })
            : payload;
          const { error: updErr } = await supabase
            .from('transport_clients')
            .update(safePayload)
            .eq('id', id);
          return { error: updErr };
        });
        if (result?.error) return { ok: false, error: result.error.message };
        return { ok: true, id };
      }
    }

    // Insert new
    const result = await retryTransportClientWrite(async (forceFallback) => {
      const safePayload = forceFallback
        ? sanitizeSharedTransportClientPayload({ ...payload, search_code: '' }, { mode: 'upsert', tcode: normalizedTcode, name, phoneDigits: phone_digits || String(Date.now()) })
        : payload;
      const { data, error } = await supabase
        .from('transport_clients')
        .insert(safePayload)
        .select('id')
        .limit(1);
      return { data, error };
    });

    if (result?.error) return { ok: false, error: result.error.message };
    const row = Array.isArray(result?.data) ? result.data[0] : null;
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
    // Legacy mirror only: derive numeric code from code_str, never use incoming code_n as a source of truth.
    const code_n = Number(code_str.replace(/\D+/g, '')) || null;

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

    const payload = sanitizeTransportOrderPayload({
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
    });

    const { error } = await supabase
      .from('transport_orders')
      .insert(payload);

    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { id: payload.id, code_str: payload.code_str, status: payload.status } };
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
