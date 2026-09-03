import fs from 'node:fs';

const TAG = 'gati-payment-fast-receipt-v1';

function appendTag(value) {
  const text = String(value || '').trim();
  return text.includes(TAG) ? text : `${text}-${TAG}`;
}

function requireMarker(path, marker) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(marker)) throw new Error(`MISSING_MARKER:${path}:${marker}`);
  return source;
}

requireMarker('app/gati/page.jsx', 'GATI_PAYMENT_FAST_RECEIPT_V1');
requireMarker('app/gati/page.jsx', 'DËRGO SMS TË PAGESËS');
requireMarker('lib/deviceSessionRecovery.js', 'ensureApprovedDeviceSession');
requireMarker('lib/arka/arkaNetwork.js', 'repairApprovedDeviceSession');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = appendTag(pkg.version);
pkg.scripts ||= {};
const installerCommand = 'node tools/apply-gati-payment-fast-receipt-v1.mjs';
const finalVersionOwner = 'node tools/apply-gati-rack-save-v1.mjs';
const prebuildSteps = String(pkg.scripts.prebuild || '')
  .split('&&')
  .map((step) => step.trim())
  .filter(Boolean)
  .filter((step) => step !== installerCommand && step !== finalVersionOwner);
// Keep the established GATI release owner as the outermost/final prebuild step.
// It imports this hotfix again after its legacy version writers have finished.
prebuildSteps.push(installerCommand, finalVersionOwner);
pkg.scripts.prebuild = prebuildSteps.join(' && ');
pkg.scripts['test:gati-payment-fast-receipt-v1'] = 'node tools/verify-gati-payment-fast-receipt-v1.mjs';
const verifyCommand = 'npm run test:gati-payment-fast-receipt-v1';
if (!String(pkg.scripts.build || '').includes(verifyCommand)) {
  pkg.scripts.build = String(pkg.scripts.build || '').replace(' && vite build', ` && ${verifyCommand} && vite build`);
}
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

let epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
epoch = epoch.replace(/(export const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
epoch = epoch.replace(/(export const GATI_RACK_SAVE_BUILD = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
fs.writeFileSync('lib/appEpoch.js', epoch, 'utf8');

let index = fs.readFileSync('index.html', 'utf8');
index = index.replace(/(<meta name="tepiha-build-id" content=")([^"]+)(" \/>)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
index = index.replace(/(window\.__TEPIHA_BUILD_ID = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
fs.writeFileSync('index.html', index, 'utf8');

let sw = fs.readFileSync('public/sw.js', 'utf8');
sw = sw.replace(/(const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
fs.writeFileSync('public/sw.js', sw, 'utf8');

let vite = fs.readFileSync('vite.config.js', 'utf8');
vite = vite.replace(/(cacheName:\s*'tepiha-vite-(?:business-routes|static-assets|media)-)([^']+)(')/g, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
fs.writeFileSync('vite.config.js', vite, 'utf8');

console.log('PASS GATI payment fast receipt V1 installer: version/cache identity and required safety markers are active.');

// Final Dispatch/Boss operational edit layer. Running here keeps it after the
// legacy release/version owners while preserving the established GATI flow.
await import('./apply-dispatch-boss-controls-v1.mjs');
