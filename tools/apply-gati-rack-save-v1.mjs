import fs from 'node:fs';

const GATI_PATH = 'app/gati/page.jsx';
const LIFECYCLE_PATH = 'lib/pranimiOrderLifecycle.js';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const ARKA_INSTALLER_PATH = 'tools/apply-arka-daily-close-v2.mjs';
const ARKA_VERIFY_PATH = 'tools/verify-arka-daily-close-v2.mjs';

const MARKER = 'GATI_RACK_SAVE_V1';
const APP_VERSION = '2.0.131-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1-pranimi-ios-haptic-v1-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1-dispatch-existing-client-guard-v1';
const CACHE_VERSION = 'v57-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1-pranimi-ios-haptic-v1-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1-dispatch-existing-client-guard-v1';
const RELEASE_EPOCH = 'RESET-2026-08-31-TRANSPORT-RECOVERY-V1-ARKA-EXPENSE-SUBMIT-V1-DISPATCH-TIMEOUT-RECONCILE-V1-DEVICE-APPROVAL-TIME-V1-DISPATCH-EXISTING-CLIENT-GUARD-V1';
const RUNTIME_VERSION = '2.0.131-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1-dispatch-existing-client-guard-v1';

function scanBalanced(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_MISSING`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function replaceNamedFunction(source, signature, replacement) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${signature}`);
  const paramsStart = source.indexOf('(', start);
  const paramsEnd = scanBalanced(source, paramsStart, '(', ')', `${signature}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanBalanced(source, bodyStart, '{', '}', `${signature}_BODY`);
  return source.slice(0, start) + replacement + source.slice(bodyEnd + 1);
}

function patchGatiSave() {
  let source = fs.readFileSync(GATI_PATH, 'utf8');
  const replacement = `async function savePlaceCard() {
    // ${MARKER}: one canonical DB write, verified before the modal closes.
    const orderRef = String(
      placeOrderId ||
      placeOrder?.db_id ||
      placeOrder?.server_id ||
      placeOrder?.local_oid ||
      placeOrder?.oid ||
      placeOrder?.id ||
      ''
    ).trim();
    if (!orderRef) {
      setPlaceErr('Mungon identiteti i porosisë. Mbylle dhe hape kartelën përsëri.');
      return;
    }

    const txt = String(placeText || '').trim();
    const concreteSlots = normalizeRackSlots(selectedSlots);
    if (!concreteSlots.length) {
      setPlaceErr(buildConcreteRackRequiredMessage('Nuk u ruajt.'));
      return;
    }

    const actor = readActor() || {};
    const actorPin = String(actor?.pin || actor?.transport_id || actor?.id || '').trim();
    const actorName = String(actor?.name || actor?.pin || actor?.role || 'STAF').trim();
    const nowIso = new Date().toISOString();
    const slotLabel = concreteSlots.map((slot) => formatRackLocationLabel(slot)).join(', ');
    const finalNoteString = txt && txt !== slotLabel
      ? ('📍 [' + slotLabel + '] ' + txt).trim()
      : '📍 [' + slotLabel + ']';

    const baseOrder = placeOrder && typeof placeOrder === 'object' ? placeOrder : {};
    const cleanDraftLifecycle = {
      ...(baseOrder?.draft_lifecycle && typeof baseOrder.draft_lifecycle === 'object' ? baseOrder.draft_lifecycle : {}),
      db_draft: false,
      db_draft_status: 'finalized',
    };
    const cleanCodeLifecycle = {
      ...(baseOrder?.pranimi_code_lifecycle && typeof baseOrder.pranimi_code_lifecycle === 'object' ? baseOrder.pranimi_code_lifecycle : {}),
      db_draft: false,
      db_draft_status: 'finalized',
    };
    const merged = {
      ...baseOrder,
      status: 'gati',
      state: 'gati',
      ready_note: finalNoteString,
      ready_note_text: txt,
      ready_location: slotLabel,
      ready_note_at: nowIso,
      ready_note_by: actorName,
      ready_note_by_pin: actorPin || null,
      ready_slots: concreteSlots,
      pranimi_db_draft: false,
      is_pranimi_incomplete_draft: false,
      draft_lifecycle: cleanDraftLifecycle,
      pranimi_code_lifecycle: cleanCodeLifecycle,
    };

    setPlaceBusy(true);
    setPlaceErr('');
    try {
      const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      let canonicalId = orderRef;
      let canonicalLocalOid = String(baseOrder?.local_oid || baseOrder?.oid || '').trim();
      let canonicalData = merged;

      if (online) {
        const { data: saved, error: saveError } = await supabase.rpc('save_base_order_rack_location_v1', {
          p_order_ref: orderRef,
          p_slots: concreteSlots,
          p_note: txt,
          p_actor_pin: actorPin || null,
          p_actor_name: actorName || null,
        });
        if (saveError) throw saveError;
        if (saved?.ok !== true) throw new Error(saved?.message || 'RACK_SAVE_DB_REJECTED');

        const savedSlots = normalizeRackSlots(saved?.ready_slots || []);
        const expectedKey = concreteSlots.slice().sort().join('|');
        const savedKey = savedSlots.slice().sort().join('|');
        if (expectedKey !== savedKey || String(saved?.ready_location || '').trim() !== slotLabel) {
          throw new Error('RACK_SAVE_DB_VERIFICATION_FAILED');
        }

        canonicalId = String(saved?.order_id || orderRef).trim();
        canonicalLocalOid = String(saved?.local_oid || canonicalLocalOid).trim();
        canonicalData = saved?.order_data && typeof saved.order_data === 'object'
          ? saved.order_data
          : merged;
      } else {
        const offlineRow = {
          ...merged,
          id: String(baseOrder?.id || orderRef),
          local_oid: canonicalLocalOid || String(baseOrder?.id || orderRef),
          _local: true,
          _synced: false,
          _syncPending: true,
        };
        await saveOrderLocal(offlineRow);
        await queueOp('patch_order_data', {
          id: orderRef,
          data: { data: merged, updated_at: nowIso },
        });
      }

      const localRow = {
        ...canonicalData,
        id: canonicalId,
        local_oid: canonicalLocalOid || String(canonicalData?.local_oid || canonicalData?.id || canonicalId),
        status: 'gati',
        state: 'gati',
        ready_note: finalNoteString,
        ready_note_text: txt,
        ready_location: slotLabel,
        ready_slots: concreteSlots,
        table: 'orders',
        _local: !online,
        _synced: online,
        _syncPending: !online,
      };

      try { await saveOrderLocal(localRow); } catch {}
      try { patchBaseMasterRow(localRow); } catch {}
      try { scheduleLocalShadowWrite('order_' + canonicalId, localRow, 150); } catch {}

      setOrders((prev) => (prev || []).map((row) => {
        const rowId = String(row?.id || '').trim();
        if (rowId !== String(placeOrderId || '').trim() && rowId !== canonicalId) return row;
        return {
          ...row,
          id: canonicalId,
          local_oid: canonicalLocalOid || row?.local_oid || '',
          readyNote: finalNoteString,
          ready_location: slotLabel,
          ready_note_text: txt,
          ready_slots: concreteSlots,
          fullOrder: {
            ...(row?.fullOrder || {}),
            ...canonicalData,
            id: canonicalId,
            local_oid: canonicalLocalOid || row?.fullOrder?.local_oid || '',
            ready_note: finalNoteString,
            ready_note_text: txt,
            ready_location: slotLabel,
            ready_slots: concreteSlots,
          },
        };
      }));

      try { await refreshRackMap({ force: true }); } catch {}
      try {
        gatiDbg('gati_rack_save_v1_success', {
          orderRef,
          canonicalId,
          code: normalizeCode(placeOrder?.code || placeOrder?.client?.code || ''),
          slots: concreteSlots,
          online,
        });
      } catch {}
      closePlaceCard();
    } catch (error) {
      const message = String(error?.message || error?.details || error || '').trim();
      try {
        gatiDbg('gati_rack_save_v1_failed', {
          orderRef,
          slots: concreteSlots,
          message,
          online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        });
      } catch {}
      setPlaceErr('Nuk u ruajt në databazë. ' + (message || 'Provo përsëri.'));
    } finally {
      setPlaceBusy(false);
    }
  }`;

  source = replaceNamedFunction(source, 'async function savePlaceCard()', replacement);
  if (!source.includes(MARKER)) throw new Error('GATI_RACK_SAVE_MARKER_MISSING');
  if (!source.includes("supabase.rpc('save_base_order_rack_location_v1'")) throw new Error('GATI_RACK_SAVE_RPC_MISSING');
  fs.writeFileSync(GATI_PATH, source, 'utf8');
}

function patchLifecycleGuard() {
  let source = fs.readFileSync(LIFECYCLE_PATH, 'utf8');
  const replacement = `export function isPranimiDraftFlaggedData(dataInput = {}) {
  const data = pranimiPlainObject(dataInput);
  const codeLife = pranimiPlainObject(data?.pranimi_code_lifecycle);
  const draftLife = pranimiPlainObject(data?.draft_lifecycle);
  const life = { ...codeLife, ...draftLife };
  const source = String(data?.source || data?.pranimi_draft_source || '').toUpperCase();
  const lifeStatus = normalizePranimiLifecycleStatus(life?.db_draft_status || '');
  const verifyState = normalizePranimiLifecycleStatus(codeLife?.db_verify_state || life?.db_verify_state || data?.local_sync_status || '');
  const operationalStatus = data?.status || data?.state || '';

  // ${MARKER}: historical finalized rows may carry draft_lifecycle.db_draft=true.
  // A verified final operational status wins over that stale nested flag.
  const staleFinalizedFlag = isPranimiFinalOrderStatus(operationalStatus)
    && data?.pranimi_db_draft !== true
    && data?.is_pranimi_incomplete_draft !== true
    && !source.includes('DB_DRAFT')
    && !source.includes('DB DRAFT')
    && lifeStatus === 'finalized'
    && (verifyState === 'db_verified' || verifyState === 'finalized');
  if (staleFinalizedFlag) return false;

  return data?.pranimi_db_draft === true
    || data?.is_pranimi_incomplete_draft === true
    || source.includes('DB_DRAFT')
    || source.includes('DB DRAFT')
    || life?.db_draft === true
    || String(life?.db_draft || '').toLowerCase() === 'true'
    || lifeStatus === 'incomplete'
    || verifyState === 'db_draft';
}`;
  source = replaceNamedFunction(source, 'export function isPranimiDraftFlaggedData(dataInput = {})', replacement);
  if (!source.includes(MARKER)) throw new Error('LIFECYCLE_STALE_FINAL_MARKER_MISSING');
  fs.writeFileSync(LIFECYCLE_PATH, source, 'utf8');
}

function patchVersionOwners() {
  let arka = fs.readFileSync(ARKA_INSTALLER_PATH, 'utf8');
  arka = arka
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(ARKA_INSTALLER_PATH, arka, 'utf8');

  let arkaVerify = fs.readFileSync(ARKA_VERIFY_PATH, 'utf8');
  arkaVerify = arkaVerify.replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2(?:-home-search-base-role-v1)?(?:-gati-rack-save-v1)?(?:-pastrimi-payment-touch-v3)?/g, CACHE_VERSION);
  fs.writeFileSync(ARKA_VERIFY_PATH, arkaVerify, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installer = 'node tools/apply-gati-rack-save-v1.mjs';
  const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
  const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';
  const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';
  const pastrimiFastCloseV4Installer = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';
  const homeSearchLocalOidDedupeV1Installer = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';
  const arkaDailyOperationsV3Installer = 'node tools/apply-arka-daily-operations-v3.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer && item !== homeSearchLocalOidDedupeV1Installer && item !== arkaDailyOperationsV3Installer);
  pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, arkaDailyOperationsV3Installer, installer);
  scripts.prebuild = pre.join(' && ');
  scripts['test:gati-rack-save-v1'] = 'node tools/verify-gati-rack-save-v1.mjs';
  const testCommand = 'npm run test:gati-rack-save-v1';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${testCommand} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function patchBuildIdentity() {
  let vite = fs.readFileSync(VITE_PATH, 'utf8');
  vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3513');
  vite = vite.replace(/tepiha-vite-business-routes-[^']+/g, `tepiha-vite-business-routes-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-static-assets-[^']+/g, `tepiha-vite-static-assets-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-media-[^']+/g, `tepiha-vite-media-${CACHE_VERSION}`);
  fs.writeFileSync(VITE_PATH, vite, 'utf8');

  let epoch = fs.readFileSync(EPOCH_PATH, 'utf8');
  epoch = epoch
    .replace(/export const APP_DATA_EPOCH = '[^']+';/, `export const APP_DATA_EPOCH = '${RELEASE_EPOCH}';`)
    .replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${RUNTIME_VERSION}';`);
  if (/export const GATI_RACK_SAVE_BUILD = '[^']+';/.test(epoch)) {
    epoch = epoch.replace(/export const GATI_RACK_SAVE_BUILD = '[^']+';/, `export const GATI_RACK_SAVE_BUILD = '${APP_VERSION}';`);
  } else {
    epoch += `\nexport const GATI_RACK_SAVE_BUILD = '${APP_VERSION}';\n`;
  }
  fs.writeFileSync(EPOCH_PATH, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  index = index.replace(/(<meta name="tepiha-app-epoch" content=")[^"]+(" \/>)/, `$1${RELEASE_EPOCH}$2`);
  index = index.replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${APP_VERSION}$2`);
  index = index.replace(/window\.__TEPIHA_APP_EPOCH = '[^']+';/, `window.__TEPIHA_APP_EPOCH = '${RELEASE_EPOCH}';`);
  index = index.replace(/window\.__TEPIHA_BUILD_ID = '[^']+';/, `window.__TEPIHA_BUILD_ID = '${APP_VERSION}';`);
  fs.writeFileSync(INDEX_PATH, index, 'utf8');
}

patchGatiSave();
patchLifecycleGuard();
patchVersionOwners();
patchPackage();
patchBuildIdentity();
console.log('PASS GATI rack save V1 installer: atomic verified RPC, stale-final lifecycle repair, offline clean queue and cache generation bump.');

// Final operational hotfix owner. This runs after every legacy version owner so
// installed iPhones always receive the ARKA/Dispatch recovery bundle.
await import('./apply-arka-expense-submit-v1.mjs');
