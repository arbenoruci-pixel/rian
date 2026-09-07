import fs from 'node:fs';

const PATH = 'app/dispatch/page.jsx';
const MARKER = 'DISPATCH_CREATE_SERVER_AUTHORITATIVE_V3';

function replaceOnce(source, regex, replacement, label) {
  if (source.includes(MARKER) && label === 'EXISTING_CONFIRM') return source;
  const matches = source.match(regex);
  if (!matches) throw new Error(`${label}: pattern not found`);
  return source.replace(regex, replacement);
}

let source = fs.readFileSync(PATH, 'utf8');
if (source.includes(MARKER)) {
  console.log(`${MARKER}: already applied`);
  process.exit(0);
}

source = replaceOnce(
  source,
  /function isTransientDispatchPhoneCheckError\(error\) \{[\s\S]*?\n\}/,
`function isTransientDispatchPhoneCheckError(error) {
  const code = dispatchPhoneCheckErrorCode(error);
  return code === 'DISPATCH_PHONE_CHECK_NETWORK_FAILED'
    || code === 'DISPATCH_PHONE_CHECK_TIMEOUT'
    || code === 'DISPATCH_PHONE_CHECK_FAILED'
    || code === 'AUTH_DEVICE_LOOKUP_FAILED'
    || code === 'AUTH_USER_LOOKUP_FAILED'
    || /^DISPATCH_PHONE_CHECK_HTTP_(408|425|429|500|502|503|504)$/.test(code);
}`,
  'TRANSIENT_PHONE_ERRORS',
);

source = replaceOnce(
  source,
  /const existingClientConfirmed = !phoneHit \|\| \([\s\S]*?\n  \);/,
`// ${MARKER}: exact-phone identity is finalized by the approved-device server CREATE.
  // A successful pre-check can enrich the form, but it never gates order creation.
  const existingClientConfirmed = true;`,
  'EXISTING_CONFIRM',
);

source = replaceOnce(
  source,
  /const canCreateNewDispatchOrder = canSend[\s\S]*?&& !activePhoneOrder;/,
`const canCreateNewDispatchOrder = canSend;`,
  'CREATE_READY_GATE',
);

source = replaceOnce(
  source,
  /    if \(activePhoneOrder\) \{[\s\S]*?    if \(phoneHit && !existingClientConfirmed\) \{[\s\S]*?\n    \}/,
`    // ${MARKER}: local/pre-check state is advisory only. The server CREATE
    // atomically resolves the exact phone, reuses the permanent T-code, and
    // deduplicates an already-active order. This avoids blocking Dispatch on
    // flaky iPhone/PWA pre-check requests or stale local rows.`,
  'REMOVE_CLIENT_SIDE_CREATE_GATES',
);

source = replaceOnce(
  source,
  /      let inspection = null;[\s\S]*?      const pickupPlan = buildDispatchPickupPlan/,
`      // ${MARKER}: submit goes straight to the authoritative server CREATE.
      // Keep an exact cached phone hit only for harmless form enrichment.
      const exactCachedClient = phoneHit && dispatchSamePhone(
        getClientPhone(phoneHit) || phoneHit?.phone_digits || phoneHit?.phone,
        cleanPhone,
      ) ? phoneHit : null;
      if (exactCachedClient) {
        cleanName = s(getClientName(exactCachedClient) || cleanName);
        cleanAddress = s(cleanAddress || getAddress(exactCachedClient));
      }
      const pickupPlan = buildDispatchPickupPlan`,
  'REMOVE_SUBMIT_PHONE_PRECHECK',
);

// Drop browser-side phone/client authority, while deliberately preserving the
// actor + create-intent UUID journal between this block and the final CREATE.
source = replaceOnce(
  source,
  /      const existingPhoneClient = authoritativePhoneClient;[\s\S]*?        : \(authoritativePhoneClient \|\| null\);/,
`      // ${MARKER}: browser-side phone lookup is advisory only.`,
  'REMOVE_BROWSER_PHONE_AUTHORITY',
);

source = replaceOnce(
  source,
  /      const clientLink = await prepareDispatchTransportClientLink\(\{[\s\S]*?      pendingReservedTcode = clientLink\.reservedNewTcode \|\| '';/,
`      // The browser deliberately sends no client id/T-code authority here.
      // /api/transport/order resolves the normalized phone under the DB lock,
      // reuses the permanent client/T-code when present, allocates atomically
      // for a new phone, and returns the committed canonical row.
      const clientLink = {
        clientId: null,
        tcode: '',
        reservedNewTcode: '',
        reservationOid: orderId,
        name: cleanName,
        phone: cleanPhone,
        phoneDigits: getDispatchPhoneDigits(cleanPhone),
        address: cleanAddress,
        source: exactCachedClient ? (getTransportClientSource(exactCachedClient) || 'cached_exact_phone') : 'server_atomic_create',
        rowId: exactCachedClient?.row_id || exactCachedClient?.id || null,
        atomicDbTcodeAllocation: true,
        phoneLookupDegraded: !!phoneCheckError,
        phoneLookupError: phoneCheckError || '',
      };
      pendingReservedTcode = '';`,
  'REMOVE_DIRECT_PHONE_LOOKUP_BEFORE_CREATE',
);

for (const token of [
  MARKER,
  'const orderId = await createIntentJournalRef.current.acquire(',
  'pendingOrderId = orderId;',
  "source: exactCachedClient ? (getTransportClientSource(exactCachedClient) || 'cached_exact_phone') : 'server_atomic_create'",
  'const createResult = await insertTransportOrder',
]) {
  if (!source.includes(token)) throw new Error(`V3_VERIFY_MISSING:${token}`);
}
if (source.includes('if (!phoneCheckReady)')) throw new Error('V3_PHONE_CHECK_GATE_REMAINS');
if (source.includes('if (phoneHit && !existingClientConfirmed)')) throw new Error('V3_EXISTING_CLIENT_GATE_REMAINS');
if (source.includes('let submitPhoneCheckDegraded = false;')) throw new Error('V3_REDUNDANT_SUBMIT_PHONE_CHECK_REMAINS');

fs.writeFileSync(PATH, source);
console.log(`${MARKER}: applied`);
