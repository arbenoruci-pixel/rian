import fs from 'node:fs';

const HOME_SEARCH_PATH = 'lib/homeSearch.js';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const FAST_CLOSE_INSTALLER_PATH = 'tools/apply-pastrimi-payment-fast-close-v4.mjs';
const ARKA_VERIFY_PATH = 'tools/verify-arka-daily-close-v2.mjs';

const MARKER = 'HOME_SEARCH_LOCAL_OID_DEDUPE_V1';
const INSTALLER = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';
const TEST_COMMAND = 'npm run test:home-search-local-oid-dedupe-v1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function patchHomeSearch() {
  let source = fs.readFileSync(HOME_SEARCH_PATH, 'utf8');
  if (!source.includes(MARKER)) {
    const anchor = `function getHomeDedupeKey(item) {\n  const kind = String(item?.kind || '').toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';\n`;
    const replacement = `function getHomeDedupeKey(item) {\n  const kind = String(item?.kind || '').toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';\n  // ${MARKER}: DB, IndexedDB, snapshots and localStorage can describe the same\n  // BASE order with different row IDs. local_oid is the shared write identity and\n  // must win before server id, otherwise one physical order appears twice.\n  const localOid = kind === 'BASE'\n    ? safeString(item?.localOid || item?.local_oid).toLowerCase()\n    : '';\n  if (localOid) return [kind, 'LOCAL_OID', localOid].join('|');\n`;
    source = replaceOnce(source, anchor, replacement, 'home local_oid dedupe');
  }
  if (!source.includes("if (localOid) return [kind, 'LOCAL_OID', localOid].join('|');")) {
    throw new Error('HOME_LOCAL_OID_DEDUPE_MISSING');
  }
  fs.writeFileSync(HOME_SEARCH_PATH, source, 'utf8');
}

function patchFastCloseCompatibility() {
  let source = fs.readFileSync(FAST_CLOSE_INSTALLER_PATH, 'utf8');
  const oldCheck = `  if (!gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')) {\n    throw new Error('GATI_FINAL_INSTALLER_ORDER_NOT_PATCHED');\n  }`;
  const newCheck = `  const compatibleGatiFinalOrder =\n    gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')\n    || gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer');\n  if (!compatibleGatiFinalOrder) {\n    throw new Error('GATI_FINAL_INSTALLER_ORDER_NOT_PATCHED');\n  }`;
  if (!source.includes('compatibleGatiFinalOrder')) {
    source = replaceOnce(source, oldCheck, newCheck, 'fast-close compatible final order');
  }
  fs.writeFileSync(FAST_CLOSE_INSTALLER_PATH, source, 'utf8');
}

function patchArkaVerifierCompatibility() {
  let source = fs.readFileSync(ARKA_VERIFY_PATH, 'utf8');
  const oldCheck = "  check(vite.includes('sw-navigation-diag.js?v=3512'), 'service worker import generation not bumped for rack save');";
  const newCheck = "  check(/sw-navigation-diag\\.js\\?v=351[2-9]/.test(vite), 'service worker import generation not bumped for rack save');";
  if (!source.includes("/sw-navigation-diag\\.js\\?v=351[2-9]/.test(vite)")) {
    source = replaceOnce(source, oldCheck, newCheck, 'ARKA compatible SW generation');
  }
  fs.writeFileSync(ARKA_VERIFY_PATH, source, 'utf8');
}

function patchGatiFinalOwner() {
  let source = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`)
    .replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3513');

  if (!source.includes("const homeSearchLocalOidDedupeV1Installer = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';")) {
    source = replaceOnce(
      source,
      "  const pastrimiFastCloseV4Installer = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';",
      "  const pastrimiFastCloseV4Installer = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';\n  const homeSearchLocalOidDedupeV1Installer = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';",
      'gati installer declaration',
    );
    source = replaceOnce(
      source,
      '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer);',
      '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer && item !== homeSearchLocalOidDedupeV1Installer);',
      'gati installer filter',
    );
    source = replaceOnce(
      source,
      '  pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer);',
      '  pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer);',
      'gati installer ordering',
    );
  }

  fs.writeFileSync(GATI_INSTALLER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = pre.indexOf(gatiInstaller);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER, gatiInstaller);
  scripts.prebuild = pre.join(' && ');
  scripts['test:home-search-local-oid-dedupe-v1'] = 'node tools/verify-home-search-local-oid-dedupe-v1.mjs';

  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function patchBuildIdentity() {
  let vite = fs.readFileSync(VITE_PATH, 'utf8');
  vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3513');
  vite = vite.replace(/tepiha-vite-business-routes-[^']+/g, `tepiha-vite-business-routes-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-static-assets-[^']+/g, `tepiha-vite-static-assets-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-media-[^']+/g, `tepiha-vite-media-${CACHE_VERSION}`);
  fs.writeFileSync(VITE_PATH, vite, 'utf8');

  let epoch = fs.readFileSync(EPOCH_PATH, 'utf8');
  if (/export const HOME_SEARCH_LOCAL_OID_DEDUPE_BUILD = '[^']+';/.test(epoch)) {
    epoch = epoch.replace(/export const HOME_SEARCH_LOCAL_OID_DEDUPE_BUILD = '[^']+';/, `export const HOME_SEARCH_LOCAL_OID_DEDUPE_BUILD = '${APP_VERSION}';`);
  } else {
    epoch += `\nexport const HOME_SEARCH_LOCAL_OID_DEDUPE_BUILD = '${APP_VERSION}';\n`;
  }
  fs.writeFileSync(EPOCH_PATH, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  index = index.replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${APP_VERSION}$2`);
  index = index.replace(/window\.__TEPIHA_BUILD_ID = '[^']+';/, `window.__TEPIHA_BUILD_ID = '${APP_VERSION}';`);
  fs.writeFileSync(INDEX_PATH, index, 'utf8');
}

patchHomeSearch();
patchFastCloseCompatibility();
patchArkaVerifierCompatibility();
patchGatiFinalOwner();
patchPackage();
patchBuildIdentity();
console.log('PASS Home Search local_oid dedupe V1: one physical BASE order has one result across DB and all local caches.');
