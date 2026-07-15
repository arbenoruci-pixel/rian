'use client';

import { supabase } from '@/lib/supabaseClient';
import { buildTransportClientSearchCode, sanitizeTransportClientPayload as sanitizeSharedTransportClientPayload, sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';
import { releaseTransportCodeIfUnused } from '@/lib/transportCodes';
import {
  isValidTransportPhoneDigits,
  normalizeTransportPhoneKey,
  sameTransportPhoneDigits,
  transportPhoneDigitVariants,
} from '@/lib/transport/phone';

export {
  isValidTransportPhoneDigits,
  normalizeTransportPhoneKey,
  sameTransportPhoneDigits,
  transportPhoneDigitVariants,
} from '@/lib/transport/phone';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normTCode(v) {
  const s = String(v || '').trim();
  const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '';
  return n ? `T${n}` : '';
}

function tCodeDigits(v) {
  return String(v || '').replace(/\D+/g, '').replace(/^0+/, '');
}

function assertTransportCodePairMatches({ codeStr = '', codeN = null } = {}) {
  const codeDigits = tCodeDigits(codeStr);
  const nDigits = tCodeDigits(codeN);
  if (!codeDigits || !nDigits) return;
  if (codeDigits !== nDigits) {
    throw new Error(`TRANSPORT_CODE_MISMATCH: code_str ${normTCode(codeStr)} nuk përputhet me code_n ${nDigits}`);
  }
}


function normalizeTransportClientCandidate(row = {}, source = '') {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const isOrder = source === 'transport_orders' || row?._table === 'transport_orders';
  const tcode = normTCode(isOrder
    ? (data?.transport_client_tcode || client?.transport_client_tcode || row?.tcode || data?.client_tcode || client?.tcode || client?.code || row?.client_tcode || '')
    : (row?.tcode || row?.client_tcode || data?.client_tcode || client?.tcode || client?.code || row?.code_str || data?.code_str || '')
  );
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
  // TRANSPORT_PHONE_FAST_RPC_V2
  const phoneKey = normalizeTransportPhoneKey(phoneValue);
  if (!isValidTransportPhoneDigits(phoneKey)) return null;

  const requestedTimeoutMs = Number(options?.timeoutMs || 0);
  const timeoutMs = Math.max(requestedTimeoutMs > 0 ? requestedTimeoutMs : 0, 15000);
  const signal = options?.signal || null;

  const runLookup = async (ms, label) => {
    let query = supabase.rpc('find_transport_client_by_phone_fast', { p_phone: phoneValue });
    if (typeof query?.timeout === 'function') query = query.timeout(ms, label);
    if (signal && typeof query?.abortSignal === 'function') query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    return data && typeof data === 'object' ? data : null;
  };

  const isAbortError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    return error?.name === 'AbortError' || code === 'ABORT_ERR' || /abort/i.test(String(error?.message || ''));
  };

  let payload = null;
  let firstError = null;
  try {
    payload = await runLookup(timeoutMs, 'TRANSPORT_CLIENT_PHONE_TIMEOUT');
  } catch (error) {
    firstError = error;
    if (isAbortError(error) && signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      payload = await runLookup(Math.max(timeoutMs, 20000), 'TRANSPORT_CLIENT_PHONE_RETRY_TIMEOUT');
    } catch (retryError) {
      const firstMessage = String(firstError?.message || firstError || '').trim();
      const retryMessage = String(retryError?.message || retryError || 'UNKNOWN').trim();
      throw new Error('TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED: ' + retryMessage + (firstMessage && firstMessage !== retryMessage ? ' | FIRST: ' + firstMessage : ''));
    }
  }

  const status = String(payload?.status || '').trim().toUpperCase();
  if (!payload || status === 'NOT_FOUND') return null;

  if (status === 'CONFLICT') {
    const clientIds = Array.isArray(payload?.client_ids) ? payload.client_ids.filter(Boolean) : [];
    const tcodes = Array.isArray(payload?.tcodes) ? payload.tcodes.filter(Boolean) : [];
    throw new Error('TRANSPORT_PHONE_IDENTITY_CONFLICT:' + phoneKey + ':clients=' + (clientIds.join(',') || '-') + ':tcodes=' + (tcodes.join(',') || '-'));
  }

  if (status !== 'FOUND' || !payload?.candidate) {
    throw new Error('TRANSPORT_CLIENT_PHONE_LOOKUP_INVALID_RESPONSE:' + (status || 'EMPTY'));
  }

  const candidate = normalizeTransportClientCandidate(
    payload.candidate,
    payload?.candidate?.source || (payload?.source_mode === 'MASTER' ? 'transport_clients' : 'transport_orders'),
  );
  const candidatePhoneKey = normalizeTransportPhoneKey(candidate?.phone_digits || candidate?.phone || '');
  if (!candidatePhoneKey || candidatePhoneKey !== phoneKey) {
    throw new Error('TRANSPORT_CLIENT_PHONE_RPC_MISMATCH:' + phoneKey + ':' + (candidatePhoneKey || '-'));
  }

  return candidate;
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

    // If caller provides an ID, update that exact row only when the phone still matches.
    // This blocks the T-code/client mix-up where a stale selected client ID is reused
    // for a different name/phone/address. Existing transport clients keep their
    // permanent T-code; a different phone must create a new client instead.
    if (input?.id) {
      let current = null;
      try {
        const { data: cur, error: curErr } = await supabase
          .from('transport_clients')
          .select('id,tcode,phone,phone_digits,name')
          .eq('id', input.id)
          .limit(1)
          .maybeSingle();
        if (curErr) throw curErr;
        current = cur || null;
      } catch (error) {
        return { ok: false, error: `TRANSPORT_CLIENT_ID_LOOKUP_FAILED: ${error?.message || error || 'UNKNOWN'}` };
      }

      if (current?.id) {
        const incomingPhoneKey = normalizeTransportPhoneKey(phone_digits || phone || '');
        const currentPhoneKey = normalizeTransportPhoneKey(current?.phone_digits || current?.phone || '');
        if (isValidTransportPhoneDigits(incomingPhoneKey) && isValidTransportPhoneDigits(currentPhoneKey) && incomingPhoneKey !== currentPhoneKey) {
          return {
            ok: false,
            error: `TRANSPORT_CLIENT_PHONE_MISMATCH: ${normTCode(current?.tcode || normalizedTcode) || 'KLIENTI'} i takon telefonit ${current?.phone || current?.phone_digits || '-'}, jo ${phone || phone_digits || '-'}. Krijo klient të ri.`
          };
        }
      }

      const existingTcode = normTCode(current?.tcode || '') || normalizedTcode;
      const result = await retryTransportClientWrite(async (forceFallback) => {
        const safePayload = forceFallback
          ? sanitizeTransportClientPayload({ ...input, tcode: existingTcode, search_code: '' }, { tcode: existingTcode, name, phoneDigits: phone_digits || String(Date.now()) })
          : sanitizeTransportClientPayload({ ...input, tcode: existingTcode }, { tcode: existingTcode, name, phoneDigits: phone_digits });
        const { data, error } = await supabase
          .from('transport_clients')
          .update(safePayload)
          .eq('id', input.id)
          .select('id,tcode')
          .limit(1);
        return { data, error };
      });

      if (result?.error) return { ok: false, error: result.error.message };
      const row = Array.isArray(result?.data) ? result.data[0] : null;
      return { ok: true, id: row?.id || input.id, tcode: normTCode(row?.tcode || existingTcode) };
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

      if (findErr) return { ok: false, error: `TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED: ${findErr.message || findErr}` };
      const phoneMatch = Array.isArray(found)
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

    // T-code fallback only applies when no phone_digits client exists AND the
    // existing T-code row belongs to the same phone. This prevents a free/available
    // pool bug from assigning T201/T257 to another customer.
    if (normalizedTcode) {
      const { data: foundByTcode, error: findByTcodeErr } = await supabase
        .from('transport_clients')
        .select('id,tcode,phone,phone_digits,name')
        .eq('tcode', normalizedTcode)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (findByTcodeErr) return { ok: false, error: `TRANSPORT_CLIENT_TCODE_LOOKUP_FAILED: ${findByTcodeErr.message || findByTcodeErr}` };
      const tcodeRow = Array.isArray(foundByTcode) ? foundByTcode[0] : null;
      if (tcodeRow?.id) {
        const incomingPhoneKey = normalizeTransportPhoneKey(phone_digits || phone || '');
        const ownerPhoneKey = normalizeTransportPhoneKey(tcodeRow?.phone_digits || tcodeRow?.phone || '');
        if (isValidTransportPhoneDigits(incomingPhoneKey) && isValidTransportPhoneDigits(ownerPhoneKey) && incomingPhoneKey !== ownerPhoneKey) {
          return {
            ok: false,
            error: `T-CODE ${normalizedTcode} ËSHTË I ZËNË NGA ${tcodeRow?.name || 'KLIENT TJETËR'} (${tcodeRow?.phone || tcodeRow?.phone_digits || '-'}). Krijo klient të ri me T-code tjetër.`
          };
        }

        const id = tcodeRow.id;
        const result = await retryTransportClientWrite(async (forceFallback) => {
          const safePayload = forceFallback
            ? sanitizeSharedTransportClientPayload({ ...payload, tcode: normalizedTcode, search_code: '' }, { mode: 'upsert', tcode: normalizedTcode, name, phoneDigits: phone_digits || String(Date.now()) })
            : payload;
          const { error: updErr } = await supabase
            .from('transport_clients')
            .update(safePayload)
            .eq('id', id);
          return { error: updErr };
        });
        if (result?.error) return { ok: false, error: result.error.message };
        return { ok: true, id, tcode: normalizedTcode };
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
    return { ok: true, id: row?.id || null, tcode: normalizedTcode || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- ORDERS ---
function createTransportOrderUuid() {
  try {
    if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function isTransportOrderUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function transportDbErrorText(error, fallback = 'TRANSPORT_DB_ERROR') {
  return [error?.message, error?.details, error?.hint].filter(Boolean).join(' | ') || String(error || fallback);
}

function assertAtomicTransportOrder(row = {}, expected = {}) {
  const wantedId = String(expected?.id || '').trim();
  if (!row?.id || String(row.id) !== wantedId) throw new Error('TRANSPORT_ORDER_VERIFY_ID_MISMATCH');
  if (!row?.client_id) throw new Error('TRANSPORT_ORDER_VERIFY_CLIENT_ID_MISSING');

  const wantedPhone = normalizeTransportPhoneKey(expected?.phone || '');
  const rowPhone = normalizeTransportPhoneKey(row?.client_phone || row?.data?.client_phone || row?.data?.client?.phone || '');
  if (!wantedPhone || wantedPhone !== rowPhone) throw new Error('TRANSPORT_ORDER_VERIFY_PHONE_MISMATCH');

  const permanentTcode = normTCode(
    row?.client_tcode || row?.data?.transport_client_tcode || row?.data?.client_tcode || row?.data?.client?.transport_client_tcode || row?.data?.client?.tcode || '',
  );
  const publicCode = normTCode(row?.code_str || row?.data?.code_str || row?.data?.order_code || '');
  if (!permanentTcode) throw new Error('TRANSPORT_ORDER_VERIFY_CLIENT_TCODE_MISSING');
  if (!publicCode || publicCode !== permanentTcode) {
    throw new Error(`TRANSPORT_ORDER_VERIFY_CODE_NOT_PERMANENT:${publicCode || '-'}:${permanentTcode}`);
  }
  if (!(Number(row?.visit_nr) > 0)) throw new Error('TRANSPORT_ORDER_VERIFY_VISIT_NR_MISSING');

  const dataOrderId = String(row?.data?.order_id || row?.data?.public_order_id || '').trim();
  if (dataOrderId && dataOrderId !== wantedId) throw new Error('TRANSPORT_ORDER_VERIFY_DATA_UUID_MISMATCH');
  return { row, permanentTcode };
}

export async function insertTransportOrder(input) {
  let requestedCode = '';
  let requestedOwner = '';
  let existingPhoneClient = null;
  let canonicalPermanentTcode = '';
  try {
    const dataObj = input?.data ?? input?.dataObj ?? input?.payload?.data ?? {};
    const clientData = dataObj?.client && typeof dataObj.client === 'object' && !Array.isArray(dataObj.client) ? dataObj.client : {};
    const orderId = String(input?.id || '').trim() || createTransportOrderUuid();
    if (!isTransportOrderUuid(orderId)) {
      return { ok: false, error: 'TRANSPORT_ORDER_UUID_INVALID' };
    }

    const clientName = String(
      input?.client_name || input?.clientName || clientData?.name || dataObj?.client_name || '',
    ).trim();
    const clientPhone = String(
      input?.client_phone || input?.clientPhone || clientData?.phone || dataObj?.client_phone || '',
    ).trim();
    if (!clientName) return { ok: false, error: 'TRANSPORT_CLIENT_NAME_REQUIRED' };
    if (!isValidTransportPhoneDigits(clientPhone)) return { ok: false, error: 'TRANSPORT_PHONE_INVALID' };

    requestedOwner = String(
      input?.code_owner || input?.reserved_by || dataObj?.created_by_pin || dataObj?.transport_pin || dataObj?.driver_pin || '',
    ).trim();
    requestedCode = normTCode(
      input?.code_str || input?.codeStr || input?.order_code || input?.order_tcode || input?.official_order_code ||
      dataObj?.code_str || dataObj?.order_code || dataObj?.order_tcode || dataObj?.official_order_code || '',
    );
    assertTransportCodePairMatches({
      codeStr: requestedCode,
      codeN: input?.code_n ?? input?.codeN ?? dataObj?.code_n ?? null,
    });

    // Idempotent retry: return the exact existing UUID only after strict identity checks.
    const existingOrderQuery = await supabase
      .from('transport_orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (existingOrderQuery?.error) {
      return { ok: false, error: `TRANSPORT_ORDER_IDEMPOTENCY_LOOKUP_FAILED: ${transportDbErrorText(existingOrderQuery.error)}`, code: existingOrderQuery.error?.code || '' };
    }
    if (existingOrderQuery?.data) {
      try {
        assertAtomicTransportOrder(existingOrderQuery.data, { id: orderId, phone: clientPhone });
        return { ok: true, data: existingOrderQuery.data, idempotent: true };
      } catch (error) {
        return { ok: false, error: `TRANSPORT_ORDER_IDEMPOTENCY_CONFLICT: ${error?.message || error}` };
      }
    }

    // Final phone lookup immediately before save. Lookup failures are blocking; a timeout
    // must never be interpreted as a new client.
    try {
      existingPhoneClient = await findTransportClientByPhoneOnly(clientPhone, { timeoutMs: 6500 });
    } catch (error) {
      return { ok: false, error: `TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED: ${error?.message || error}` };
    }

    const masterTcode = normTCode(existingPhoneClient?.tcode || existingPhoneClient?.client_tcode || '');
    const permanentTcode = masterTcode || requestedCode;
    canonicalPermanentTcode = permanentTcode;
    if (!permanentTcode) return { ok: false, error: 'TRANSPORT_TCODE_REQUIRED_FOR_NEW_CLIENT' };

    const suppliedClientId = input?.client_id ?? input?.clientId ?? dataObj?.client_id ?? clientData?.id ?? null;
    const canonicalClientId = existingPhoneClient?.id || suppliedClientId || null;
    const tid = String(input?.transport_id ?? input?.transportId ?? dataObj?.transport_id ?? dataObj?.transportId ?? '').trim();
    const safeData = {
      ...(dataObj || {}),
      ...(tid ? { transport_id: tid } : {}),
      order_id: orderId,
      public_order_id: orderId,
      code_str: permanentTcode,
      code: permanentTcode,
      order_code: permanentTcode,
      official_order_code: permanentTcode,
      order_tcode: permanentTcode,
      client_tcode: permanentTcode,
      transport_client_tcode: permanentTcode,
      client_id: canonicalClientId,
      client: {
        ...clientData,
        id: canonicalClientId,
        name: clientName,
        phone: clientPhone,
        tcode: permanentTcode,
        code: permanentTcode,
        client_tcode: permanentTcode,
        transport_client_tcode: permanentTcode,
        order_code: permanentTcode,
        official_order_code: permanentTcode,
      },
      ...(requestedCode && requestedCode !== permanentTcode
        ? { superseded_reserved_tcode: requestedCode }
        : {}),
    };

    const payload = sanitizeTransportOrderPayload({
      id: orderId,
      code_str: permanentTcode,
      code_n: Number(permanentTcode.replace(/\D+/g, '')) || null,
      client_tcode: permanentTcode,
      client_id: canonicalClientId,
      client_name: clientName,
      client_phone: clientPhone,
      status: input?.status || dataObj?.status || 'pickup',
      data: safeData,
      created_at: input?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const rpcPhone = existingPhoneClient?.source === 'transport_clients' && existingPhoneClient?.phone
      ? String(existingPhoneClient.phone)
      : clientPhone;
    const rpc = await supabase.rpc('create_transport_order', {
      p_id: orderId,
      p_code_n: payload.code_n,
      p_code_str: permanentTcode,
      p_client_name: clientName,
      p_client_phone: rpcPhone,
      p_address: clientData?.address || safeData?.address || '',
      p_gps_lat: safeData?.gps_lat == null ? null : String(safeData.gps_lat),
      p_gps_lng: safeData?.gps_lng == null ? null : String(safeData.gps_lng),
      p_data: payload.data || {},
      p_status: payload.status || 'pickup',
    });

    if (rpc?.error) {
      if (requestedCode && (!existingPhoneClient || requestedCode !== canonicalPermanentTcode)) {
        try { await releaseTransportCodeIfUnused(requestedCode, requestedOwner); } catch {}
      }
      return { ok: false, error: transportDbErrorText(rpc.error, 'TRANSPORT_ORDER_INSERT_FAILED'), code: rpc.error?.code || '' };
    }

    let verify = await supabase
      .from('transport_orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (verify?.error) {
      return { ok: false, error: transportDbErrorText(verify.error, 'TRANSPORT_ORDER_VERIFY_FAILED'), code: verify.error?.code || '' };
    }
    let row = verify?.data || null;
    if (!row) return { ok: false, error: 'TRANSPORT_ORDER_NOT_FOUND_AFTER_RPC' };

    const dbPermanentTcode = normTCode(
      row?.client_tcode || rpc?.data?.client_tcode || row?.data?.transport_client_tcode || row?.data?.client?.tcode || permanentTcode,
    );
    if (!dbPermanentTcode) return { ok: false, error: 'TRANSPORT_DB_PERMANENT_TCODE_MISSING' };

    // Race/legacy safety: if the RPC found an existing client after our lookup, rewrite
    // this newly-created exact UUID to the client's permanent T-code before returning.
    if (normTCode(row?.code_str) !== dbPermanentTcode || normTCode(row?.client_tcode) !== dbPermanentTcode) {
      const reconciled = await supabase
        .from('transport_orders')
        .update({ code_str: dbPermanentTcode, client_tcode: dbPermanentTcode })
        .eq('id', orderId)
        .select('*')
        .maybeSingle();
      if (reconciled?.error) {
        return { ok: false, error: `TRANSPORT_ORDER_CODE_RECONCILE_FAILED: ${transportDbErrorText(reconciled.error)}`, code: reconciled.error?.code || '' };
      }
      row = reconciled?.data || row;
    }

    try {
      assertAtomicTransportOrder(row, { id: orderId, phone: clientPhone });
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    if (requestedCode && requestedCode !== dbPermanentTcode) {
      // Superseded codes are released without an owner restriction. The DB RPC still
      // refuses release when any client/order/payment references the code.
      try { await releaseTransportCodeIfUnused(requestedCode, ''); } catch {}
    }

    return { ok: true, data: row, idempotent: false };
  } catch (e) {
    if (requestedCode && (!existingPhoneClient || requestedCode !== canonicalPermanentTcode)) {
      try { await releaseTransportCodeIfUnused(requestedCode, requestedOwner); } catch {}
    }
    return { ok: false, error: String(e?.message || e), code: String(e?.code || '') };
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
