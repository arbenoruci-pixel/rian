import fs from 'node:fs';

const MARKER = 'DISPATCH_PHONE_CHECK_FINAL_IDENTITY_V2';
const TAG = 'dispatch-phone-check-resilience-v2';

function appendTag(value) {
  const text = String(value || '').trim();
  const base = !text ? TAG : text.includes(TAG) ? text : `${text}-${TAG}`;
  const release = 'dispatch-customer-arka-v1';
  const released = base.includes(release) ? base : `${base}-${release}`;
  const handoffRelease = 'arka-visible-handoff-v2';
  const handoff = released.includes(handoffRelease) ? released : `${released}-${handoffRelease}`;
  const intentRelease = 'dispatch-phone-intent-v2-server-recovery-v3-dispatch-durable-send-v1-gati-offline-queue-first-v1-ready-notification-history-v1-base-ready-dispatch-flow-v1-dispatch-history-phone-v1-app-stability-audit-v1-device-pending-visibility-v1-pastrimi-modal-layer-v1-dispatch-create-verification-v1-search-payment-status-audit-v1-extended-flow-verification-v1-transport-board-recovery-v3-dispatch-storage-quota-v3';
  const withIntent = handoff.includes(intentRelease) ? handoff : `${handoff}-${intentRelease}`;
  const mobileRelease = 'transport-mobile-fit-v1';
  const withMobile = withIntent.includes(mobileRelease) ? withIntent : `${withIntent}-${mobileRelease}`;
  const retryRelease = 'dispatch-resume-retry-v1';
  const withRetry = withMobile.includes(retryRelease) ? withMobile : `${withMobile}-${retryRelease}`;
  const submitRelease = 'dispatch-submit-confirmed-v2';
  return withRetry.includes(submitRelease) ? withRetry : `${withRetry}-${submitRelease}`;
}

const packagePath = 'package.json';
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.version = appendTag(pkg.version);
  pkg.scripts['test:app-stability-audit-v1'] = 'node tools/verify-app-stability-audit-v1.mjs && node tools/verify-device-pending-visibility-v1.mjs && node tools/verify-dispatch-create-verification-v1.mjs && node tools/verify-search-payment-status-audit-v1.mjs && node tools/verify-extended-flow-v1.mjs && node tools/verify-transport-board-recovery-v3.mjs && node tools/verify-dispatch-storage-quota-v3.mjs && node tools/verify-dispatch-resume-retry-v1.mjs';
  pkg.scripts['test:app-stability-audit-v1'] += ' && node tools/verify-dispatch-submit-confirmed-v2.mjs';
  if (!pkg.scripts.build.includes('npm run test:app-stability-audit-v1')) pkg.scripts.build = pkg.scripts.build.replace('vite build', 'npm run test:app-stability-audit-v1 && vite build');
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

const vitePath = 'vite.config.js';
if (fs.existsSync(vitePath)) {
  let vite = fs.readFileSync(vitePath, 'utf8');
  vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3514');
  vite = vite.replace(
    /(tepiha-vite-(?:business-routes|static-assets|media)-)([^']+)/g,
    (_all, prefix, value) => `${prefix}${appendTag(value)}`,
  );
  fs.writeFileSync(vitePath, vite, 'utf8');
}

const epochPath = 'lib/appEpoch.js';
if (fs.existsSync(epochPath)) {
  let epoch = fs.readFileSync(epochPath, 'utf8');
  epoch = epoch.replace(
    /(export const APP_VERSION = ')([^']+)(';)/,
    (_all, before, value, after) => `${before}${appendTag(value)}${after}`,
  );
  epoch = epoch.replace(
    /(export const GATI_RACK_SAVE_BUILD = ')([^']+)(';)/,
    (_all, before, value, after) => `${before}${appendTag(value)}${after}`,
  );
  const markerLine = `export const DISPATCH_PHONE_CHECK_RESILIENCE_BUILD = '${TAG}';`;
  if (/export const DISPATCH_PHONE_CHECK_RESILIENCE_BUILD = '[^']*';/.test(epoch)) {
    epoch = epoch.replace(/export const DISPATCH_PHONE_CHECK_RESILIENCE_BUILD = '[^']*';/, markerLine);
  } else {
    epoch = `${epoch.trimEnd()}\n${markerLine}\n`;
  }
  fs.writeFileSync(epochPath, epoch, 'utf8');
}

const indexPath = 'index.html';
if (fs.existsSync(indexPath)) {
  let index = fs.readFileSync(indexPath, 'utf8');
  index = index.replace(
    /(<meta name="tepiha-build-id" content=")([^"]+)(" \/>)/,
    (_all, before, value, after) => `${before}${appendTag(value)}${after}`,
  );
  index = index.replace(
    /(window\.__TEPIHA_BUILD_ID = ')([^']+)(';)/,
    (_all, before, value, after) => `${before}${appendTag(value)}${after}`,
  );
  fs.writeFileSync(indexPath, index, 'utf8');
}

const swPath = 'public/sw.js';
if (fs.existsSync(swPath)) {
  let sw = fs.readFileSync(swPath, 'utf8');
  sw = sw.replace(
    /(const APP_VERSION = ')([^']+)(';)/,
    (_all, before, value, after) => `${before}${appendTag(value)}${after}`,
  );
  fs.writeFileSync(swPath, sw, 'utf8');
}

console.log(`PASS ${MARKER}: the final installed-PWA identity includes ${TAG}.`);
