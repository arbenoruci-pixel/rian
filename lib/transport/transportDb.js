'use client';

import { supabase } from '@/lib/supabaseClient';
import { buildTransportClientSearchCode, sanitizeTransportClientPayload as sanitizeSharedTransportClientPayload, sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normalizeTransportPhoneKey(v) {
  let digits = onlyDigits(v);
  if (digits.startsWith('00383')) digits = digits.slice(5);
  else if (digits.startsWith('383') && digits.length >= 10) digits = digits.slice(3);
  if (digits.startsWith('0') && digits.length >= 8) digits = digits.replace(/^0+/, '');
  return digits;
}

export function isValidTransportPhoneDigits(v) {
  const key = normalizeTransportPhoneKey(v);
  return key.length >= 8;
}

export function transportPhoneDigitVariants(v) {
  const raw = onlyDigits(v);
  const key = normalizeTransportPhoneKey(raw);
  const set = new Set();
  if (raw) set.add(raw);
  if (key) {
    set.add(key);
    set.add(`0${key}`);
    set.add(`383${key}`);
    set.add(`00383${key}`);
  }
  return Array.from(set).filter(Boolean);
}

export function sameTransportPhoneDigits(a, b) {
  const aa = normalizeTransportPhoneKey(a);
  const bb = normalizeTransportPhoneKey(b);
  return isValidTransportPhoneDigits(aa) && isValidTransportPhoneDigits(bb) && aa === bb;
}

export function normTCode(v) {
  const s = String(v || '').trim();
  const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '';
  return n ? `T${n}` : '';
}


function normalizeTransportClientCandidate(row = {}, source = '') {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const isOrder = source === 'transport_orders' || row?._table === 'transport_orders';
  const tcode = normTCode(row?.tcode || row?.client_tcode || row?.code_str || data?.client_tcode || client?.tcode || client?.code || data?.code_str || '');
  const phone = String(row?.phone || row?.client_phone || row?.phone_digits || client?.phone || data?.client_phone || data?.phone || '').trim();
  const phone_digits = onlyDigits(row?.phone_digits || phone || '');
  return {
    id: isOrder ? (row?.client_id || data?.client_id || client?.id || null) : (row?.id || row?.client_id || null),
    row_id: row?.id || null,
    source: source || row?.source || (isOrder ? 'transport_orders' : 'transport_clients'),
    tcode,
    client_tcode: tcode,
    code_str: tcode,
    name: String(row?.name || row?.client_name || client?.name || data?.client_name || data?.name || '').trim(),
    phone,
    phone_digits,
    address: String(row?.address || row?.pickup_address || row?.delivery_address || client?.address || data?.address || data?.pickup_address || data?.delivery_address || data?.location || '').trim(),
    gps_lat: row?.gps_lat ?? client?.gps?.lat ?? client?.gps_lat ?? data?.gps_lat ?? data?.lat ?? null,
    gps_lng: row?.gps_lng ?? client?.gps?.lng ?? client?.gps_lng ?? data?.gps_lng ?? data?.lng ?? null,
    updated_at: row?.updated_at || row?.created_at || '',
    row,
  };
}

export async function findTransportClientByPhoneOnly(phoneValue, options = {}) {
  const variants = transportPhoneDigitVariants(phoneValue);
  const phoneKey = normalizeTransportPhoneKey(phoneValue);
  if (!isValidTransportPhoneDigits(phoneKey)) return null;

  const timeoutMs = Number(options?.timeoutMs || 5000);
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (row = {}, source = '') => {
    const c = normalizeTransportClientCandidate(row, source);
    const cPhoneKey = normalizeTransportPhoneKey(c.phone_digits || c.phone || '');
    if (!cPhoneKey || cPhoneKey !== phoneKey) return;
    const key = `${c.id || ''}|${c.tcode || ''}|${cPhoneKey}|${c.source || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  try {
    let query = supabase
      .from('transport_clients')
      .select('id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,updated_at')
      .in('phone_digits', variants)
      .order('updated_at', { ascending: false })
      .limit(8);
    if (typeof query?.timeout === 'function') query = query.timeout(timeoutMs, 'TRANSPORT_CLIENT_PHONE_TIMEOUT');
    const { data, error } = await query;
    if (!error) (Array.isArray(data) ? data : []).forEach((row) => pushCandidate(row, 'transport_clients'));
  } catch {}

  if (!candidates.length) {
    try {
      let query = supabase
        .from('transport_orders')
        .select('id,client_id,client_tcode,code_str,client_name,client_phone,data,created_at,updated_at')
        .in('client_phone', variants)
        .order('updated_at', { ascending: false })
        .limit(12);
      if (typeof query?.timeout === 'function') query = query.timeout(timeoutMs, 'TRANSPORT_ORDER_PHONE_TIMEOUT');
      const { data, error } = await query;
      if (!error) (Array.isArray(data) ? data : []).forEach((row) => pushCandidate(row, 'transport_orders'));
    } catch {}
  }

  if (!candidates.length) {
    try {
      let query = supabase
        .from('transport_orders')
        .select('id,client_id,client_tcode,code_str,client_name,client_phone,data,created_at,updated_at')
        .order('updated_at', { ascending: false })
        .limit(120);
      if (typeof query?.timeout === 'function') query = query.timeout(Math.max(timeoutMs, 6500), 'TRANSPORT_ORDER_PHONE_HISTORY_TIMEOUT');
      const { data, error } = await query;
      if (!error) (Array.isArray(data) ? data : []).forEach((row) => pushCandidate(row, 'transport_orders'));
    } catch {}
  }

  candidates.sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
  return candidates[0] || null;
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

    // Otherwise: phone_digits is the first and strongest identity for transport clients.
    // Never let a newly supplied T-code overwrite an existing client's permanent T-code.
    if (isValidTransportPhoneDigits(phone_digits)) {
      const variants = transportPhoneDigitVariants(phone_digits);
      const { data: found, error: findErr } = await supabase
        .from('transport_clients')
        .select('id,tcode,phone,phone_digits')
        .in('phone_digits', variants)
        .order('updated_at', { ascending: false })
        .limit(5);

      const phoneMatch = !findErr && Array.isArray(found)
        ? found.find((row) => sameTransportPhoneDigits(row?.phone_digits || row?.phone || '', phone_digits))
        : null;

      if (phoneMatch?.id) {
        const id = phoneMatch.id;
        const existingTcode = normTCode(phoneMatch.tcode || '') || normalizedTcode;
        const result = await retryTransportClientWrite(async (forceFallback) => {
          const safePayload = forceFallback
            ? sanitizeSharedTransportClientPayload({ ...input, tcode: existingTcode, search_code: '' }, { mode: 'upsert', tcode: existingTcode, name, phoneDigits: phone_digits || String(Date.now()) })
            : sanitizeTransportClientPayload({ ...input, tcode: existingTcode }, { tcode: existingTcode, name, phoneDigits: phone_digits });
          const { error: updErr } = await supabase
            .from('transport_clients')
            .update(safePayload)
            .eq('id', id);
          return { error: updErr };
        });
        if (result?.error) return { ok: false, error: result.error.message };
        return { ok: true, id, tcode: existingTcode };
      }
    }

    // T-code fallback only applies when no phone_digits client exists.
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
