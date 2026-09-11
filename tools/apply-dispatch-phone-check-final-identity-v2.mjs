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
  const intentRelease = 'dispatch-phone-intent-v2-server-recovery-v3-dispatch-durable-send-v1-gati-offline-queue-first-v1';
  return handoff.includes(intentRelease) ? handoff : `${handoff}-${intentRelease}`;
}

const packagePath = 'package.json';
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.version = appendTag(pkg.version);
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
