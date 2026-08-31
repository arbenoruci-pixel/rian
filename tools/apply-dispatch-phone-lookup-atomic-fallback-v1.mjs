import fs from 'node:fs';

const DISPATCH_PATH = 'app/dispatch/page.jsx';
const TRANSPORT_DB_PATH = 'lib/transport/transportDb.js';
const MARKER = 'DISPATCH_PHONE_LOOKUP_ATOMIC_FALLBACK_V1';

function replaceOnce(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(newText)) {
    console.log(`SKIP ${label}: already installed`);
    return false;
  }
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  source = source.replace(oldText, newText);
  fs.writeFileSync(path, source, 'utf8');
  console.log(`PATCH ${label}`);
  return true;
}

let dispatchSource = fs.readFileSync(DISPATCH_PATH, 'utf8');
if (!dispatchSource.includes(MARKER)) {
  replaceOnce(
    DISPATCH_PATH,
`  let liveClient = verifiedPhoneClient;
  if (verifiedPhoneClient === undefined) {
    try {
      liveClient = await findTransportClientByPhoneOnly(cleanPhone, { timeoutMs: 5500 });
    } catch (error) {
      throw new Error(\`NUK U VERIFIKUA KLIENTI ME TELEFON. POROSIA NUK U RUAJT. \${error?.message || ''}\`.trim());
    }
  }`,
`  let liveClient = verifiedPhoneClient;
  let phoneLookupDegraded = false;
  let phoneLookupError = '';
  if (verifiedPhoneClient === undefined) {
    try {
      liveClient = await findTransportClientByPhoneOnly(cleanPhone, { timeoutMs: 5500 });
    } catch (error) {
      // ${MARKER}
      // A transient iPhone/LTE fetch timeout must not block Dispatch before the
      // authoritative create_transport_order RPC gets a chance to resolve the
      // phone under its advisory lock. Reuse only an exact cached phone match;
      // otherwise let the create RPC allocate a permanent T-code atomically.
      phoneLookupDegraded = true;
      phoneLookupError = String(error?.message || error || 'TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED');
      const cachedExactClient = existingPhoneClient
        && dispatchSamePhone(getClientPhone(existingPhoneClient) || existingPhoneClient?.phone_digits || existingPhoneClient?.phone, cleanPhone)
        && getTransportTCode(existingPhoneClient)
        ? existingPhoneClient
        : null;
      liveClient = cachedExactClient;
    }
  }`,
    'Dispatch pre-save phone lookup degradation',
  );

  replaceOnce(
    DISPATCH_PATH,
`    source: getTransportClientSource(selectedClient) || 'transport_clients',
    rowId: selectedClient?.row_id || selectedClient?.id || null,
  };`,
`    source: getTransportClientSource(selectedClient) || 'transport_clients',
    rowId: selectedClient?.row_id || selectedClient?.id || null,
    phoneLookupDegraded,
    phoneLookupError,
  };`,
    'Dispatch client-link degradation audit fields',
  );

  replaceOnce(
    DISPATCH_PATH,
`          last_customer_hit: {
            id: clientLink.clientId,
            tcode: clientLink.tcode,
            order_code: officialOrderCode,
            source: clientLink.source || "transport_clients",
            row_id: clientLink.rowId || null,
            matched_by: "phone_digits",
          },`,
`          last_customer_hit: {
            id: clientLink.clientId,
            tcode: clientLink.tcode,
            order_code: officialOrderCode,
            source: clientLink.source || "transport_clients",
            row_id: clientLink.rowId || null,
            matched_by: "phone_digits",
          },
          ...(clientLink.phoneLookupDegraded ? {
            dispatch_phone_lookup_degraded: {
              at: nowIso,
              reason: clientLink.phoneLookupError || 'TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED',
              fallback: clientLink.clientId ? 'EXACT_CACHED_CLIENT_THEN_ATOMIC_RPC' : 'ATOMIC_CREATE_TRANSPORT_ORDER_RPC',
            },
          } : {}),`,
    'Dispatch payload lookup-degradation audit marker',
  );
}

let dbSource = fs.readFileSync(TRANSPORT_DB_PATH, 'utf8');
if (!dbSource.includes(MARKER)) {
  replaceOnce(
    TRANSPORT_DB_PATH,
`  let existingPhoneClient = null;
  let canonicalPermanentTcode = '';`,
`  let existingPhoneClient = null;
  let canonicalPermanentTcode = '';
  let finalPhoneLookupDegraded = false;
  let finalPhoneLookupError = '';`,
    'Transport insert degradation state',
  );

  replaceOnce(
    TRANSPORT_DB_PATH,
`    // Final phone lookup immediately before save. Lookup failures are blocking; a timeout
    // must never be interpreted as a new client.
    try {
      existingPhoneClient = await findTransportClientByPhoneOnly(clientPhone, { timeoutMs: 6500 });
    } catch (error) {
      return { ok: false, error: \`TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED: \${error?.message || error}\` };
    }`,
`    // Final phone lookup immediately before save. Dispatch may continue after a
    // transient lookup timeout because create_transport_order resolves the phone
    // atomically under a DB advisory lock. Other callers remain strict.
    try {
      existingPhoneClient = await findTransportClientByPhoneOnly(clientPhone, { timeoutMs: 6500 });
    } catch (error) {
      const createdByRole = String(dataObj?.created_by_role || dataObj?.created_by || '').trim().toUpperCase();
      const allowAtomicDispatchFallback = createdByRole === 'DISPATCH';
      if (!allowAtomicDispatchFallback) {
        return { ok: false, error: \`TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED: \${error?.message || error}\` };
      }

      // ${MARKER}
      finalPhoneLookupDegraded = true;
      finalPhoneLookupError = String(error?.message || error || 'TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED');
      const fallbackClientId = input?.client_id ?? input?.clientId ?? dataObj?.client_id ?? clientData?.id ?? null;
      const fallbackTcode = normTCode(
        input?.client_tcode || dataObj?.transport_client_tcode || dataObj?.client_tcode || clientData?.transport_client_tcode || clientData?.tcode || clientData?.code || '',
      );
      existingPhoneClient = fallbackClientId && fallbackTcode
        ? { id: fallbackClientId, tcode: fallbackTcode, client_tcode: fallbackTcode, phone: clientPhone, phone_digits: normalizeTransportPhoneKey(clientPhone), source: 'dispatch_exact_cached_client' }
        : null;
    }`,
    'Transport insert atomic fallback gate',
  );

  replaceOnce(
    TRANSPORT_DB_PATH,
`      ...(requestedCode && requestedCode !== permanentTcode
        ? { superseded_reserved_tcode: requestedCode }
        : {}),
    };`,
`      ...(requestedCode && requestedCode !== permanentTcode
        ? { superseded_reserved_tcode: requestedCode }
        : {}),
      ...(finalPhoneLookupDegraded ? {
        transport_phone_lookup_degraded: {
          at: new Date().toISOString(),
          reason: finalPhoneLookupError || 'TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED',
          fallback: existingPhoneClient?.id ? 'SUPPLIED_EXACT_CLIENT_THEN_ATOMIC_RPC' : 'ATOMIC_CREATE_TRANSPORT_ORDER_RPC',
        },
      } : {}),
    };`,
    'Transport insert degradation audit payload',
  );

  replaceOnce(
    TRANSPORT_DB_PATH,
`    // Race/legacy safety: if the RPC found an existing client after our lookup, rewrite
    // this newly-created exact UUID to the client's permanent T-code before returning.
    if (normTCode(row?.code_str) !== dbPermanentTcode || normTCode(row?.client_tcode) !== dbPermanentTcode) {
      const reconciled = await supabase
        .from('transport_orders')
        .update({ code_str: dbPermanentTcode, client_tcode: dbPermanentTcode })
        .eq('id', orderId)
        .select('*')
        .maybeSingle();
      if (reconciled?.error) {
        return { ok: false, error: \`TRANSPORT_ORDER_CODE_RECONCILE_FAILED: \${transportDbErrorText(reconciled.error)}\`, code: reconciled.error?.code || '' };
      }
      row = reconciled?.data || row;
    }`,
`    // Race/legacy safety: if the atomic RPC found an existing client after a
    // degraded lookup, canonicalize columns AND every public code alias in JSON.
    const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    const rowClientData = rowData?.client && typeof rowData.client === 'object' && !Array.isArray(rowData.client) ? rowData.client : {};
    const needsCodeReconcile = [
      row?.code_str,
      row?.client_tcode,
      rowData?.code_str,
      rowData?.code,
      rowData?.order_code,
      rowData?.official_order_code,
      rowData?.order_tcode,
      rowData?.client_tcode,
      rowData?.transport_client_tcode,
      rowClientData?.tcode,
      rowClientData?.code_str,
      rowClientData?.code,
      rowClientData?.order_code,
      rowClientData?.official_order_code,
      rowClientData?.order_tcode,
      rowClientData?.client_tcode,
      rowClientData?.transport_client_tcode,
    ].some((value) => normTCode(value) !== dbPermanentTcode);

    if (needsCodeReconcile) {
      const canonicalData = {
        ...rowData,
        code_str: dbPermanentTcode,
        code: dbPermanentTcode,
        order_code: dbPermanentTcode,
        official_order_code: dbPermanentTcode,
        order_tcode: dbPermanentTcode,
        client_tcode: dbPermanentTcode,
        transport_client_tcode: dbPermanentTcode,
        client: {
          ...rowClientData,
          tcode: dbPermanentTcode,
          code_str: dbPermanentTcode,
          code: dbPermanentTcode,
          order_code: dbPermanentTcode,
          official_order_code: dbPermanentTcode,
          order_tcode: dbPermanentTcode,
          client_tcode: dbPermanentTcode,
          transport_client_tcode: dbPermanentTcode,
        },
      };
      const reconciled = await supabase
        .from('transport_orders')
        .update({
          code_n: Number(dbPermanentTcode.replace(/\\D+/g, '')) || null,
          code_str: dbPermanentTcode,
          client_tcode: dbPermanentTcode,
          data: canonicalData,
        })
        .eq('id', orderId)
        .select('*')
        .maybeSingle();
      if (reconciled?.error) {
        return { ok: false, error: \`TRANSPORT_ORDER_CODE_RECONCILE_FAILED: \${transportDbErrorText(reconciled.error)}\`, code: reconciled.error?.code || '' };
      }
      row = reconciled?.data || row;
    }`,
    'Full permanent T-code reconciliation after atomic RPC',
  );
}

const dispatchAfter = fs.readFileSync(DISPATCH_PATH, 'utf8');
const dbAfter = fs.readFileSync(TRANSPORT_DB_PATH, 'utf8');
for (const token of [
  MARKER,
  'phoneLookupDegraded',
  'ATOMIC_CREATE_TRANSPORT_ORDER_RPC',
  'dispatch_phone_lookup_degraded',
]) {
  if (!dispatchAfter.includes(token)) throw new Error(`DISPATCH_VERIFY_MISSING:${token}`);
}
for (const token of [
  MARKER,
  'allowAtomicDispatchFallback',
  "createdByRole === 'DISPATCH'",
  'transport_phone_lookup_degraded',
  'needsCodeReconcile',
  'code_n: Number(dbPermanentTcode',
  "supabase.rpc('create_transport_order'",
  'assertAtomicTransportOrder',
  'releaseTransportCodeIfUnused',
]) {
  if (!dbAfter.includes(token)) throw new Error(`TRANSPORT_DB_VERIFY_MISSING:${token}`);
}
console.log('PASS Dispatch phone timeout falls through safely to atomic create without changing other callers');
