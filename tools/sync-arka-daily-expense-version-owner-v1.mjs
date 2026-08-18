import fs from 'node:fs';

const FAST_CLOSE_PATH = 'tools/apply-pastrimi-payment-fast-close-v4.mjs';
const GATI_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';

function patch(path) {
  let source = fs.readFileSync(path, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  if (!source.includes(`const APP_VERSION = '${APP_VERSION}';`)) {
    throw new Error(`APP_VERSION_PATCH_FAILED:${path}`);
  }
  if (!source.includes(`const CACHE_VERSION = '${CACHE_VERSION}';`)) {
    throw new Error(`CACHE_VERSION_PATCH_FAILED:${path}`);
  }
  fs.writeFileSync(path, source, 'utf8');
}

patch(FAST_CLOSE_PATH);
patch(GATI_PATH);
console.log('PASS ARKA daily expense version ownership preserved through fast-close and GATI installers.');
