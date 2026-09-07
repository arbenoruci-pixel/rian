import fs from 'node:fs';

const DISPATCH_PATH = 'app/dispatch/page.jsx';
const V2_INSTALLER_PATH = 'tools/apply-dispatch-phone-check-resilience-v2.mjs';
const V2_VERIFIER_PATH = 'tools/verify-dispatch-phone-check-resilience-v2.mjs';
const EXISTING_GUARD_VERIFIER_PATH = 'tools/verify-dispatch-existing-client-guard-v1.mjs';
const VITE_PATH = 'vite.config.js';
const PACKAGE_PATH = 'package.json';
const MARKER = 'DISPATCH_CREATE_NETWORK_RESILIENCE_V3';
const TAG = 'dispatch-create-network-resilience-v3';
const INSTALLER = 'node tools/apply-dispatch-create-network-resilience-v3.mjs';
const TEST_COMMAND = 'npm run test:dispatch-create-network-resilience-v3';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function replaceRange(source, startText, endText, newText, label) {
  if (source.includes(newText)) return source;
  const start = source.indexOf(startText);
  if (start < 0) throw new Error(`${label}: start marker missing`);
  const end = source.indexOf(endText, start);
  if (end < 0) throw new Error(`${label}: end marker missing`);
  return source.slice(0, start) + newText + source.slice(end);
}

function appendTag(value, tag = TAG) {
  const clean = String(value || '').trim();
  if (!clean) return tag;
  return clean.includes(tag) ? clean : `${clean}-${tag}`;
}

function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');

  source = replaceOnce(
    source,
`  const canCreateNewDispatchOrder = canSend
    && phoneCheckReady
    && existingClientConfirmed
    && !activePhoneOrder;`,
`  // ${MARKER}: PHONE_CHECK is advisory CRM help only. The authoritative,
  // idempotent CREATE request owns phone identity, active-order dedupe and T-code
  // allocation, so a slow/broken pre-check can never lock the create button.
  const canCreateNewDispatchOrder = canSend
    && existingClientConfirmed
    && !activePhoneOrder;`,
    'CREATE_BUTTON_ADVISORY_PHONE_CHECK',
  );

  source = replaceOnce(
    source,
`    if (!phoneCheckReady) {
      setErr(phoneCheckError
        ? 'KONTROLLI I TELEFONIT DËSHTOI. PROVO PËRSËRI PARA DËRGIMIT.'
        : 'PRIT PAK — PO KONTROLLOHET TELEFONI NË DB.');
      return;
    }
`,
`    // ${MARKER}: never block CREATE on the advisory phone pre-check. The
    // server CREATE endpoint performs the final phone/client/active-order check.
`,
    'SEND_PHONE_CHECK_GATE',
  );

  source = replaceRange(
    source,
`      let inspection = null;
      let submitPhoneCheckDegraded = false;`,
`      const pickupPlan = buildDispatchPickupPlan`,
`      // ${MARKER}: do not repeat PHONE_CHECK on submit. Reuse only exact local
      // CRM evidence when it is already available; otherwise send no client/T-code
      // hint and let create_transport_order resolve the phone atomically.
      const exactPhoneClient = phoneHit && dispatchSamePhone(
        getClientPhone(phoneHit) || phoneHit?.phone_digits || phoneHit?.phone,
        cleanPhone,
      ) ? phoneHit : null;
      if (exactPhoneClient) {
        cleanName = s(getClientName(exactPhoneClient) || cleanName);
        cleanAddress = s(cleanAddress || getAddress(exactPhoneClient));
      }
`,
    'SEND_SECOND_PHONE_CHECK',
  );

  source = replaceOnce(
    source,
`      const existingPhoneClient = authoritativePhoneClient;
      // A successful approved-device pre-check is authoritative. During a
      // transient pre-check failure, leave this undefined so the existing
      // direct DB lookup gets a chance before the atomic server CREATE.
      const verifiedPhoneClient = submitPhoneCheckDegraded
        ? undefined
        : (authoritativePhoneClient || null);`,
`      const existingPhoneClient = exactPhoneClient;
      // Null is intentional: when the advisory pre-check has no exact result,
      // skip another browser-side lookup and let the atomic CREATE resolve it.
      const verifiedPhoneClient = exactPhoneClient || null;`,
    'SEND_VERIFIED_CLIENT_HINT',
  );

  source = replaceRange(
    source,
`      if (submitPhoneCheckDegraded) {`,
`      pendingReservedTcode = clientLink.reservedNewTcode || '';`,
`      if (phoneCheckError) {
        clientLink.phoneLookupDegraded = true;
        clientLink.phoneLookupError = dispatchPhoneCheckErrorCode(phoneCheckError) || String(phoneCheckError);
      }
`,
    'SEND_DEGRADED_AUDIT',
  );

  source = replaceOnce(
    source,
`                    : "KONTROLLI NË DB DËSHTOI"}`,
`                    : "KONTROLLI PARAPRAK S’U KRYE — MUND TA DËRGOSH; SERVERI E VERIFIKON NË RUAJTJE"}`,
    'PHONE_CHECK_ADVISORY_COPY',
  );

  source = replaceOnce(
    source,
`            {busy ? "DUKE DËRGU…" : phoneBusy ? "DUKE KONTROLLU TELEFONIN…" : (phoneHit && !existingClientConfirmed) ? "ZGJIDH KODIN EKZISTUES" : "DËRGO"}`,
`            {busy ? "DUKE DËRGU…" : (phoneHit && !existingClientConfirmed) ? "ZGJIDH KODIN EKZISTUES" : "DËRGO"}`,
    'CREATE_BUTTON_LABEL',
  );

  fs.writeFileSync(DISPATCH_PATH, source);
}

function patchV2Installer() {
  let source = fs.readFileSync(V2_INSTALLER_PATH, 'utf8');
  source = replaceOnce(
    source,
`function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');
`,
`function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');
  // ${MARKER}: V3 supersedes the V2 submit gate. Keep V2 as a compatibility
  // owner for older source, and leave a V3 source untouched during prebuild.
  if (source.includes('${MARKER}')) return;
`,
    'V2_INSTALLER_V3_COMPAT',
  );
  fs.writeFileSync(V2_INSTALLER_PATH, source);
}

function patchV2Verifier() {
  let source = fs.readFileSync(V2_VERIFIER_PATH, 'utf8');
  source = replaceOnce(
    source,
`check(dispatch.includes('let submitPhoneCheckDegraded = false;'), 'send-time degraded state missing');`,
`check(dispatch.includes('${MARKER}') || dispatch.includes('let submitPhoneCheckDegraded = false;'), 'send-time resilience state missing');`,
    'V2_VERIFY_SUBMIT_STATE',
  );
  source = replaceOnce(
    source,
`check(dispatch.includes('if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;'), 'hard phone-check errors are not kept fail-closed');`,
`check(dispatch.includes('${MARKER}') || dispatch.includes('if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;'), 'submit-time phone-check resilience missing');`,
    'V2_VERIFY_HARD_ERROR',
  );
  source = replaceOnce(
    source,
`check(dispatch.includes('const verifiedPhoneClient = submitPhoneCheckDegraded'), 'degraded send does not re-enable direct DB lookup');`,
`check(dispatch.includes('${MARKER}') || dispatch.includes('const verifiedPhoneClient = submitPhoneCheckDegraded'), 'degraded submit fallback missing');`,
    'V2_VERIFY_CLIENT_HINT',
  );
  fs.writeFileSync(V2_VERIFIER_PATH, source);
}

function patchExistingClientVerifier() {
  let source = fs.readFileSync(EXISTING_GUARD_VERIFIER_PATH, 'utf8');
  source = replaceOnce(
    source,
`assert.match(page, /inspectDispatchTransportPhoneViaApi\\(cleanPhone/, 'send must repeat the authoritative lookup immediately before create');`,
`if (page.includes('${MARKER}')) {
  const sendStart = page.indexOf('async function send()');
  const sendEnd = page.indexOf('\\n\\n  function openRow', sendStart);
  const sendBlock = sendStart >= 0 && sendEnd > sendStart ? page.slice(sendStart, sendEnd) : '';
  assert.doesNotMatch(sendBlock, /inspectDispatchTransportPhoneViaApi\\(cleanPhone/, 'V3 submit must not depend on a second PHONE_CHECK');
  assert.match(sendBlock, /insertTransportOrder/, 'V3 submit must reach the atomic CREATE path directly');
  assert.match(server, /create_transport_order/, 'V3 duplicate/client identity authority must stay in the atomic server RPC');
} else {
  assert.match(page, /inspectDispatchTransportPhoneViaApi\\(cleanPhone/, 'send must repeat the authoritative lookup immediately before create');
}`,
    'EXISTING_CLIENT_VERIFY_V3',
  );
  fs.writeFileSync(EXISTING_GUARD_VERIFIER_PATH, source);
}

function patchViteIdentity() {
  let source = fs.readFileSync(VITE_PATH, 'utf8');
  if (!source.includes(TAG)) {
    const oldSuffix = "dispatch-phone-check-resilience-v2'";
    const count = source.split(oldSuffix).length - 1;
    if (count < 3) throw new Error(`VITE_CACHE_IDENTITY: expected >=3 V2 cache names, found ${count}`);
    source = source.split(oldSuffix).join(`dispatch-phone-check-resilience-v2-${TAG}'`);
  }
  if (source.includes('sw-navigation-diag.js?v=3514')) {
    source = source.replace('sw-navigation-diag.js?v=3514', 'sw-navigation-diag.js?v=3515');
  }
  fs.writeFileSync(VITE_PATH, source);
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = appendTag(pkg.version);
  pkg.scripts ||= {};
  pkg.scripts['test:dispatch-create-network-resilience-v3'] = 'node tools/verify-dispatch-create-network-resilience-v3.mjs';

  const prebuildParts = String(pkg.scripts.prebuild || '').split('&&').map((part) => part.trim()).filter(Boolean);
  pkg.scripts.prebuild = [...prebuildParts.filter((part) => part !== INSTALLER), INSTALLER].join(' && ');

  const buildParts = String(pkg.scripts.build || '').split('&&').map((part) => part.trim()).filter(Boolean).filter((part) => part !== TEST_COMMAND);
  const viteIndex = buildParts.lastIndexOf('vite build');
  if (viteIndex >= 0) buildParts.splice(viteIndex, 0, TEST_COMMAND);
  else buildParts.push(TEST_COMMAND);
  pkg.scripts.build = buildParts.join(' && ');

  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

patchDispatch();
patchV2Installer();
patchV2Verifier();
patchExistingClientVerifier();
patchViteIdentity();
patchPackage();

console.log(`Applied ${MARKER}: advisory PHONE_CHECK, direct atomic CREATE, PWA cache bump and regression guards.`);
