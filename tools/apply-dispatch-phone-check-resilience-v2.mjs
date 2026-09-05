import fs from 'node:fs';

const DISPATCH_PATH = 'app/dispatch/page.jsx';
const GATI_OWNER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const PACKAGE_PATH = 'package.json';
const MARKER = 'DISPATCH_PHONE_CHECK_RESILIENCE_V2';
const TAG = 'dispatch-phone-check-resilience-v2';
const INSTALLER = 'node tools/apply-dispatch-phone-check-resilience-v2.mjs';
const TEST_COMMAND = 'npm run test:dispatch-phone-check-resilience-v2';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
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
`function dispatchPhoneSearchReady(value) {
  return getDispatchPhoneDigits(value).length >= 7;
}

function dispatchExistingClientDecisionKey`,
`function dispatchPhoneSearchReady(value) {
  return getDispatchPhoneDigits(value).length >= 7;
}

// ${MARKER}: a transient iPhone/PWA fetch failure is a degraded pre-check,
// not proof that the phone is new and not a reason to lock the create button.
// The approved-device CREATE endpoint still performs the authoritative phone,
// active-order and permanent T-code checks atomically before it writes anything.
function dispatchPhoneCheckErrorCode(error) {
  return String(error?.code || error?.message || error || '').trim().toUpperCase();
}

function isTransientDispatchPhoneCheckError(error) {
  const code = dispatchPhoneCheckErrorCode(error);
  return code === 'DISPATCH_PHONE_CHECK_NETWORK_FAILED'
    || code === 'DISPATCH_PHONE_CHECK_TIMEOUT'
    || /^DISPATCH_PHONE_CHECK_HTTP_(408|425|429|500|502|503|504)$/.test(code);
}

function dispatchExistingClientDecisionKey`,
    'PHONE_CHECK_HELPERS',
  );

  source = replaceOnce(
    source,
`      } catch (error) {
        if (Number(phoneCheckSeqRef.current || 0) !== checkSeq) return;
        setPhoneHit(null);
        setServerActivePhoneOrder(null);
        setPhoneCheckedKey(phoneDigits);
        setPhoneCheckError(String(error?.code || error?.message || 'DISPATCH_PHONE_CHECK_FAILED'));
        setExistingClientDecision(null);
      } finally {`,
`      } catch (error) {
        if (Number(phoneCheckSeqRef.current || 0) !== checkSeq) return;
        const phoneError = dispatchPhoneCheckErrorCode(error) || 'DISPATCH_PHONE_CHECK_FAILED';
        const transient = isTransientDispatchPhoneCheckError(phoneError);
        setPhoneCheckedKey(phoneDigits);
        setPhoneCheckError(phoneError);
        if (transient) {
          // Keep only exact local evidence. The final CREATE request will recheck
          // everything server-side and will return an existing active order instead
          // of creating a duplicate.
          setPhoneHit((current) => current && dispatchSamePhone(
            getClientPhone(current) || current?.phone_digits || current?.phone,
            phone,
          ) ? current : null);
          setServerActivePhoneOrder((current) => current && dispatchSamePhone(
            getClientPhone(current) || current?.phone_digits || current?.phone,
            phone,
          ) ? current : null);
          setExistingClientDecision((current) => current?.phoneKey === phoneDigits ? current : null);
        } else {
          setPhoneHit(null);
          setServerActivePhoneOrder(null);
          setExistingClientDecision(null);
        }
      } finally {`,
    'PHONE_CHECK_EFFECT_CATCH',
  );

  source = replaceOnce(
    source,
`  const phoneCheckReady = canSend
    && phoneCheckedKey === currentPhoneKey
    && !phoneBusy
    && !phoneCheckError;`,
`  const phoneCheckDegraded = isTransientDispatchPhoneCheckError(phoneCheckError);
  const phoneCheckReady = canSend
    && phoneCheckedKey === currentPhoneKey
    && !phoneBusy
    && (!phoneCheckError || phoneCheckDegraded);`,
    'PHONE_CHECK_READY_GATE',
  );

  source = replaceOnce(
    source,
`      const inspection = await inspectDispatchTransportPhoneViaApi(cleanPhone, { timeoutMs: 15000 });
      setPhoneCheckedKey(inspection.phoneKey || getDispatchPhoneDigits(cleanPhone));
      setPhoneCheckError('');
      setServerActivePhoneOrder(inspection.activeOrder || null);`,
`      let inspection = null;
      let submitPhoneCheckDegraded = false;
      let submitPhoneCheckError = '';
      try {
        inspection = await inspectDispatchTransportPhoneViaApi(cleanPhone, { timeoutMs: 15000 });
        setPhoneCheckedKey(inspection.phoneKey || getDispatchPhoneDigits(cleanPhone));
        setPhoneCheckError('');
        setServerActivePhoneOrder(inspection.activeOrder || null);
      } catch (phoneError) {
        submitPhoneCheckError = dispatchPhoneCheckErrorCode(phoneError) || 'DISPATCH_PHONE_CHECK_FAILED';
        if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;
        submitPhoneCheckDegraded = true;
        const exactCachedClient = phoneHit && dispatchSamePhone(
          getClientPhone(phoneHit) || phoneHit?.phone_digits || phoneHit?.phone,
          cleanPhone,
        ) ? phoneHit : null;
        const exactLocalActiveOrder = activePhoneOrder && dispatchSamePhone(
          getClientPhone(activePhoneOrder) || activePhoneOrder?.phone_digits || activePhoneOrder?.phone,
          cleanPhone,
        ) ? activePhoneOrder : null;
        inspection = {
          phoneKey: getDispatchPhoneDigits(cleanPhone),
          client: exactCachedClient,
          activeOrder: exactLocalActiveOrder,
        };
        setPhoneCheckedKey(getDispatchPhoneDigits(cleanPhone));
        setPhoneCheckError(submitPhoneCheckError);
        setServerActivePhoneOrder(exactLocalActiveOrder);
      }`,
    'SUBMIT_PHONE_CHECK_FALLBACK',
  );

  source = replaceOnce(
    source,
`      // The approved-device phone check above is authoritative for this send.
      // null means the phone was checked and is a genuinely new client.
      const verifiedPhoneClient = authoritativePhoneClient || null;`,
`      // A successful approved-device pre-check is authoritative. During a
      // transient pre-check failure, leave this undefined so the existing
      // direct DB lookup gets a chance before the atomic server CREATE.
      const verifiedPhoneClient = submitPhoneCheckDegraded
        ? undefined
        : (authoritativePhoneClient || null);`,
    'VERIFIED_PHONE_CLIENT_DEGRADED_MODE',
  );

  source = replaceOnce(
    source,
`      const clientLink = await prepareDispatchTransportClientLink({
        name: cleanName,
        phone: cleanPhone,
        address: cleanAddress,
        existingPhoneClient,
        verifiedPhoneClient,
        orderId,
      });
      pendingReservedTcode = clientLink.reservedNewTcode || '';`,
`      const clientLink = await prepareDispatchTransportClientLink({
        name: cleanName,
        phone: cleanPhone,
        address: cleanAddress,
        existingPhoneClient,
        verifiedPhoneClient,
        orderId,
      });
      if (submitPhoneCheckDegraded) {
        clientLink.phoneLookupDegraded = true;
        clientLink.phoneLookupError = [submitPhoneCheckError, clientLink.phoneLookupError]
          .filter(Boolean)
          .join(' | ');
      }
      pendingReservedTcode = clientLink.reservedNewTcode || '';`,
    'PHONE_CHECK_DEGRADED_AUDIT',
  );

  source = replaceOnce(
    source,
`            {phoneCheckError ? (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ ...ui.mini, color: "#b91c1c" }}>KONTROLLI NË DB DËSHTOI</div>
                <button type="button" style={ui.btnGhostMini} onClick={() => setPhoneCheckNonce((value) => Number(value || 0) + 1)}>RIPROVO</button>
              </div>
            ) : null}`,
`            {phoneCheckError ? (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ ...ui.mini, color: phoneCheckDegraded ? "#a16207" : "#b91c1c" }}>
                  {phoneCheckDegraded
                    ? "LIDHJA E KONTROLLIT U NDËRPRE — MUND TA DËRGOSH; SERVERI E VERIFIKON NË RUAJTJE"
                    : "KONTROLLI NË DB DËSHTOI"}
                </div>
                <button type="button" style={ui.btnGhostMini} onClick={() => setPhoneCheckNonce((value) => Number(value || 0) + 1)}>RIPROVO</button>
              </div>
            ) : null}`,
    'PHONE_CHECK_DEGRADED_UI',
  );

  source = replaceOnce(
    source,
`      setErr(e?.message || "GABIM");`,
`      const sendErrorCode = dispatchPhoneCheckErrorCode(e);
      setErr(
        ['DISPATCH_ORDER_API_NETWORK_FAILED', 'DISPATCH_ORDER_API_TIMEOUT'].includes(sendErrorCode)
          ? 'LIDHJA U NDËRPRE. POROSIA NUK U RUAJT. PROVO PRAPË — I NJËJTI TENTIM NUK E DYFISHON POROSINË.'
          : (e?.message || "GABIM"),
      );`,
    'FRIENDLY_FINAL_NETWORK_ERROR',
  );

  for (const token of [
    MARKER,
    'isTransientDispatchPhoneCheckError',
    'const phoneCheckDegraded =',
    'submitPhoneCheckDegraded',
    'const verifiedPhoneClient = submitPhoneCheckDegraded',
    'SERVERI E VERIFIKON NË RUAJTJE',
  ]) {
    if (!source.includes(token)) throw new Error(`DISPATCH_PATCH_VERIFY_MISSING:${token}`);
  }
  if (source.includes('&& !phoneCheckError;')) throw new Error('STRICT_PHONE_CHECK_BUTTON_GATE_REMAINS');
  fs.writeFileSync(DISPATCH_PATH, source, 'utf8');
}

function patchFinalVersionOwner() {
  let source = fs.readFileSync(GATI_OWNER_PATH, 'utf8');
  source = source.replace(/const APP_VERSION = '([^']+)';/, (_match, value) => `const APP_VERSION = '${appendTag(value)}';`);
  source = source.replace(/const CACHE_VERSION = '([^']+)';/, (_match, value) => `const CACHE_VERSION = '${appendTag(value)}';`);
  source = source.replace(/const RUNTIME_VERSION = '([^']+)';/, (_match, value) => `const RUNTIME_VERSION = '${appendTag(value)}';`);
  source = source.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3514');
  const finalIdentityImport = "await import('./apply-dispatch-phone-check-final-identity-v2.mjs');";
  if (!source.includes(finalIdentityImport)) {
    source = `${source.trimEnd()}\n\n// DISPATCH_PHONE_CHECK_FINAL_IDENTITY_V2: run after nested legacy release writers.\n${finalIdentityImport}\n`;
  }
  if (!source.includes(TAG)) throw new Error('FINAL_VERSION_OWNER_TAG_MISSING');
  fs.writeFileSync(GATI_OWNER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const scripts = pkg.scripts || (pkg.scripts = {});
  const finalOwner = 'node tools/apply-gati-rack-save-v1.mjs';
  const prebuildParts = String(scripts.prebuild || '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== INSTALLER);
  const ownerIndex = prebuildParts.lastIndexOf(finalOwner);
  if (ownerIndex >= 0) prebuildParts.splice(ownerIndex, 0, INSTALLER);
  else prebuildParts.push(INSTALLER);
  scripts.prebuild = prebuildParts.join(' && ');

  scripts['test:dispatch-phone-check-resilience-v2'] = 'node tools/verify-dispatch-phone-check-resilience-v2.mjs';
  const buildParts = String(scripts.build || '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== TEST_COMMAND);
  const viteIndex = buildParts.findIndex((part) => part === 'vite build');
  if (viteIndex < 0) throw new Error('VITE_BUILD_ANCHOR_MISSING');
  buildParts.splice(viteIndex, 0, TEST_COMMAND);
  scripts.build = buildParts.join(' && ');
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

patchDispatch();
patchFinalVersionOwner();
patchPackage();
console.log(`PASS ${MARKER}: transient phone pre-check failures no longer block the atomic Dispatch create flow.`);
