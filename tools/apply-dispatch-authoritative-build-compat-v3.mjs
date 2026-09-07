import fs from 'node:fs';

const INSTALLER_PATH = 'tools/apply-dispatch-phone-check-resilience-v2.mjs';
const VERIFIER_PATH = 'tools/verify-dispatch-phone-check-resilience-v2.mjs';
const AUTHORITATIVE = 'DISPATCH_CREATE_SERVER_AUTHORITATIVE_V3';
const COMPAT = 'DISPATCH_AUTHORITATIVE_BUILD_COMPAT_V3';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

let installer = fs.readFileSync(INSTALLER_PATH, 'utf8');
installer = replaceOnce(
  installer,
`function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');`,
`function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');

  // ${COMPAT}: the server-authoritative V3 flow supersedes the older V2
  // submit-time pre-check patch. Keep V2's version/PWA ownership work, while
  // leaving the stronger V3 create path untouched on every future build.
  if (source.includes('${AUTHORITATIVE}')) {
    for (const token of [
      '${AUTHORITATIVE}',
      'const canCreateNewDispatchOrder = canSend;',
      'server_atomic_create',
      'const createResult = await insertTransportOrder',
    ]) {
      if (!source.includes(token)) throw new Error('AUTHORITATIVE_DISPATCH_VERIFY_MISSING:' + token);
    }
    if (source.includes('if (!phoneCheckReady)')) throw new Error('AUTHORITATIVE_PHONE_GATE_REGRESSED');
    if (source.includes('if (phoneHit && !existingClientConfirmed)')) throw new Error('AUTHORITATIVE_CLIENT_CONFIRM_GATE_REGRESSED');
    console.log('SKIP Dispatch phone-check V2 source rewrite: server-authoritative V3 is active');
    return;
  }`,
  'INSTALLER_AUTHORITATIVE_COMPAT',
);
fs.writeFileSync(INSTALLER_PATH, installer, 'utf8');

let verifier = fs.readFileSync(VERIFIER_PATH, 'utf8');
const oldBlock = `check(dispatch.includes('DISPATCH_PHONE_CHECK_RESILIENCE_V2'), 'resilience marker missing');
check(dispatch.includes('function isTransientDispatchPhoneCheckError'), 'transient classifier missing');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_NETWORK_FAILED'"), 'network failure is not classified');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_TIMEOUT'"), 'timeout is not classified');
check(dispatch.includes('const phoneCheckDegraded = isTransientDispatchPhoneCheckError(phoneCheckError);'), 'degraded state missing');
check(dispatch.includes('&& (!phoneCheckError || phoneCheckDegraded);'), 'create button is still hard-blocked by a transient phone check');
check(!dispatch.includes('&& !phoneCheckError;'), 'strict phone-check gate remains');
check(dispatch.includes('let submitPhoneCheckDegraded = false;'), 'send-time degraded state missing');
check(dispatch.includes('if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;'), 'hard phone-check errors are not kept fail-closed');
check(dispatch.includes('const verifiedPhoneClient = submitPhoneCheckDegraded'), 'degraded send does not re-enable direct DB lookup');
check(dispatch.includes('clientLink.phoneLookupDegraded = true;'), 'degraded audit marker missing');
check(dispatch.includes('SERVERI E VERIFIKON NË RUAJTJE'), 'friendly degraded warning missing');
check(dispatch.includes('I NJËJTI TENTIM NUK E DYFISHON POROSINË'), 'final network retry guidance missing');
check(dispatch.includes('const createResult = await insertTransportOrder'), 'atomic create path missing');
check(dispatch.includes('const deduplicatedActive = createResult?.deduplicatedActive === true;'), 'active-order server dedupe handling missing');`;

const newBlock = `const authoritativeV3 = dispatch.includes('${AUTHORITATIVE}');
check(dispatch.includes('function isTransientDispatchPhoneCheckError'), 'transient classifier missing');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_NETWORK_FAILED'"), 'network failure is not classified');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_TIMEOUT'"), 'timeout is not classified');
check(dispatch.includes('const phoneCheckDegraded = isTransientDispatchPhoneCheckError(phoneCheckError);'), 'degraded state missing');
check(!dispatch.includes('&& !phoneCheckError;'), 'strict phone-check gate remains');
check(dispatch.includes('SERVERI E VERIFIKON NË RUAJTJE'), 'friendly degraded warning missing');
check(dispatch.includes('I NJËJTI TENTIM NUK E DYFISHON POROSINË'), 'final network retry guidance missing');
check(dispatch.includes('const createResult = await insertTransportOrder'), 'atomic create path missing');
check(dispatch.includes('const deduplicatedActive = createResult?.deduplicatedActive === true;'), 'active-order server dedupe handling missing');

if (authoritativeV3) {
  check(dispatch.includes('const canCreateNewDispatchOrder = canSend;'), 'V3 create button is not form-validity only');
  check(dispatch.includes('server_atomic_create'), 'V3 server-atomic create marker missing');
  check(!dispatch.includes('if (!phoneCheckReady)'), 'V3 send is still blocked by phone pre-check');
  check(!dispatch.includes('if (phoneHit && !existingClientConfirmed)'), 'V3 send is still blocked by client confirmation');
  check(!dispatch.includes('let submitPhoneCheckDegraded = false;'), 'V3 still performs redundant submit-time phone pre-check');
} else {
  check(dispatch.includes('DISPATCH_PHONE_CHECK_RESILIENCE_V2'), 'resilience marker missing');
  check(dispatch.includes('&& (!phoneCheckError || phoneCheckDegraded);'), 'create button is still hard-blocked by a transient phone check');
  check(dispatch.includes('let submitPhoneCheckDegraded = false;'), 'send-time degraded state missing');
  check(dispatch.includes('if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;'), 'hard phone-check errors are not kept fail-closed');
  check(dispatch.includes('const verifiedPhoneClient = submitPhoneCheckDegraded'), 'degraded send does not re-enable direct DB lookup');
  check(dispatch.includes('clientLink.phoneLookupDegraded = true;'), 'degraded audit marker missing');
}`;

verifier = replaceOnce(verifier, oldBlock, newBlock, 'VERIFIER_AUTHORITATIVE_COMPAT');
verifier = verifier.replace(
  "console.log('PASS Dispatch phone-check resilience V2: transient iPhone/PWA pre-check failures warn instead of blocking, while server create remains atomic and deduplicated.');",
  "console.log(authoritativeV3 ? 'PASS Dispatch server-authoritative V3: pre-check is advisory and CREATE is atomic/idempotent.' : 'PASS Dispatch phone-check resilience V2: transient iPhone/PWA pre-check failures warn instead of blocking, while server create remains atomic and deduplicated.');",
);
fs.writeFileSync(VERIFIER_PATH, verifier, 'utf8');

console.log(`${COMPAT}: applied`);
