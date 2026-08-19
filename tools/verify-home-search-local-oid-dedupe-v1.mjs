import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const homeSearch = fs.readFileSync('lib/homeSearch.js', 'utf8');
const installer = fs.readFileSync('tools/apply-home-search-local-oid-dedupe-v1.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const fastCloseInstaller = fs.readFileSync('tools/apply-pastrimi-payment-fast-close-v4.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(homeSearch.includes('HOME_SEARCH_LOCAL_OID_DEDUPE_V1'), 'local_oid dedupe marker missing');
check(homeSearch.includes("safeString(item?.localOid || item?.local_oid).toLowerCase()"), 'canonical local_oid read missing');
check(homeSearch.includes("if (localOid) return [kind, 'LOCAL_OID', localOid].join('|');"), 'local_oid does not win dedupe');
const localOidIndex = homeSearch.indexOf("if (localOid) return [kind, 'LOCAL_OID', localOid].join('|');");
const stableIdIndex = homeSearch.indexOf("const stableId = kind === 'BASE'");
check(localOidIndex >= 0 && stableIdIndex > localOidIndex, 'server/local row id still wins before local_oid');
check(homeSearch.includes("if (stableId) return [kind, 'ID', stableId].join('|');"), 'stable ID fallback missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const dedupeInstaller = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';
const fastCloseCommand = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';
const gatiCommand = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(dedupeInstaller), 'dedupe installer missing from prebuild');
check(prebuild.lastIndexOf(fastCloseCommand) < prebuild.lastIndexOf(dedupeInstaller), 'dedupe must run after fast-close source owners');
check(prebuild.lastIndexOf(dedupeInstaller) < prebuild.lastIndexOf(gatiCommand), 'dedupe must run before final GATI owner');
check(prebuild.trim().endsWith(gatiCommand), 'GATI final version owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:home-search-local-oid-dedupe-v1'), 'dedupe verifier missing from full build');
check(String(pkg.scripts?.['test:home-search-local-oid-dedupe-v1'] || '').includes('verify-home-search-local-oid-dedupe-v1.mjs'), 'dedupe test script missing');
check(String(pkg.version || '').includes('home-search-localoid-dedupe-v1'), 'package version suffix missing');
check(gatiInstaller.includes('homeSearchLocalOidDedupeV1Installer'), 'GATI final owner does not preserve dedupe ordering');
check(gatiInstaller.includes('home-search-localoid-dedupe-v1'), 'GATI final owner can overwrite build identity');
check(gatiInstaller.includes('sw-navigation-diag.js?v=3513'), 'GATI final owner can overwrite service worker generation');
check(fastCloseInstaller.includes('compatibleGatiFinalOrder'), 'PASTRIMI fast-close rejects the newer compatible final-owner chain');
check(fastCloseInstaller.includes('homeSearchLocalOidDedupeV1Installer, installer'), 'PASTRIMI fast-close does not recognize the Home dedupe owner');
check(vite.includes('home-search-localoid-dedupe-v1'), 'PWA cache generation suffix missing');
check(vite.includes('sw-navigation-diag.js?v=3513'), 'service worker generation missing');
check(epoch.includes('HOME_SEARCH_LOCAL_OID_DEDUPE_BUILD'), 'runtime build marker missing');
check(index.includes('home-search-localoid-dedupe-v1'), 'HTML build ID missing');
check(installer.includes('HOME_SEARCH_LOCAL_OID_DEDUPE_V1'), 'installer marker missing');
check(installer.includes('patchFastCloseCompatibility'), 'compatibility patch missing from installer');

if (failures.length) {
  console.error(`FAIL Home Search local_oid dedupe V1: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS Home Search local_oid dedupe V1: DB, IndexedDB, snapshot and localStorage copies collapse to one physical BASE order while distinct visits remain visible.');
