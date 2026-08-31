import fs from 'node:fs';

const COMPOSER_PATH = 'components/ArkaExpenseComposer.jsx';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const SW_PATH = 'public/sw.js';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';

const INSTALLER = 'node tools/apply-arka-expense-submit-v1.mjs';
const APP_VERSION = '2.0.130-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1-pranimi-ios-haptic-v1-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1';
const CACHE_VERSION = 'v56-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1-pranimi-ios-haptic-v1-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1';
const RELEASE_EPOCH = 'RESET-2026-08-31-TRANSPORT-RECOVERY-V1-ARKA-EXPENSE-SUBMIT-V1-DISPATCH-TIMEOUT-RECONCILE-V1-DEVICE-APPROVAL-TIME-V1';
const RUNTIME_VERSION = '2.0.130-pastrimi-purpose-click-v1-dispatch-atomic-tcode-v2-transport-recovery-v1-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1';

function patchComposer() {
  let source = fs.readFileSync(COMPOSER_PATH, 'utf8');

  if (!source.includes('onSubmit={(event) => {')) {
    source = source.replace(
      `      <section\n        className="arkaExpenseComposer"\n        role="dialog"\n        aria-modal="true"\n        aria-labelledby="arka-expense-composer-title"\n      >`,
      `      <form\n        className="arkaExpenseComposer"\n        role="dialog"\n        aria-modal="true"\n        aria-labelledby="arka-expense-composer-title"\n        onSubmit={(event) => {\n          event.preventDefault();\n          if (!busy) onSubmit?.();\n        }}\n      >`,
    );
    source = source.replace(
      `            type="button"\n            className="primary"\n            onClick={onSubmit}\n            disabled={busy || !canSubmit}`,
      `            type="submit"\n            className="primary"\n            disabled={busy}\n            aria-disabled={!canSubmit ? 'true' : undefined}`,
    );
    source = source.replace(`      </section>\n    </div>\n  );\n}`, `      </form>\n    </div>\n  );\n}`);
  }

  for (const token of ['<form', 'onSubmit={(event) => {', 'type="submit"', 'disabled={busy}']) {
    if (!source.includes(token)) throw new Error(`ARKA_EXPENSE_SUBMIT_MISSING:${token}`);
  }
  if (source.includes('disabled={busy || !canSubmit}')) throw new Error('ARKA_EXPENSE_SUBMIT_STILL_SILENTLY_DISABLED');
  fs.writeFileSync(COMPOSER_PATH, source, 'utf8');
}

function patchBuildIdentity() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const prebuild = String(pkg.scripts?.prebuild || '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== INSTALLER && part !== 'node tools/apply-gati-rack-save-v1.mjs');
  prebuild.push(INSTALLER, 'node tools/apply-gati-rack-save-v1.mjs');
  pkg.scripts.prebuild = prebuild.join(' && ');
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  let vite = fs.readFileSync(VITE_PATH, 'utf8');
  vite = vite.replace(/tepiha-vite-business-routes-[^']+/g, `tepiha-vite-business-routes-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-static-assets-[^']+/g, `tepiha-vite-static-assets-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-media-[^']+/g, `tepiha-vite-media-${CACHE_VERSION}`);
  fs.writeFileSync(VITE_PATH, vite, 'utf8');

  let epoch = fs.readFileSync(EPOCH_PATH, 'utf8');
  epoch = epoch
    .replace(/export const APP_DATA_EPOCH = '[^']+';/, `export const APP_DATA_EPOCH = '${RELEASE_EPOCH}';`)
    .replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${RUNTIME_VERSION}';`);
  fs.writeFileSync(EPOCH_PATH, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  index = index.replace(/(<meta name="tepiha-app-epoch" content=")[^"]+(" \/>)/, `$1${RELEASE_EPOCH}$2`);
  index = index.replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${APP_VERSION}$2`);
  index = index.replace(/window\.__TEPIHA_APP_EPOCH = '[^']+';/, `window.__TEPIHA_APP_EPOCH = '${RELEASE_EPOCH}';`);
  index = index.replace(/window\.__TEPIHA_BUILD_ID = '[^']+';/, `window.__TEPIHA_BUILD_ID = '${APP_VERSION}';`);
  fs.writeFileSync(INDEX_PATH, index, 'utf8');

  let sw = fs.readFileSync(SW_PATH, 'utf8');
  sw = sw
    .replace(/const APP_DATA_EPOCH = '[^']+';/, `const APP_DATA_EPOCH = '${RELEASE_EPOCH}';`)
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '2.0.130-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1-legacy-bridge';`)
    .replace(/const SW_BUILD_LABEL = '[^']+';/, `const SW_BUILD_LABEL = 'sw-pwa-auto-update-v4-arka-expense-submit-v1-dispatch-timeout-reconcile-v1-device-approval-time-v1-legacy-bridge';`);
  fs.writeFileSync(SW_PATH, sw, 'utf8');

  let gatiInstaller = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gatiInstaller = gatiInstaller
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`)
    .replace(/const RELEASE_EPOCH = '[^']+';/, `const RELEASE_EPOCH = '${RELEASE_EPOCH}';`)
    .replace(/const RUNTIME_VERSION = '[^']+';/, `const RUNTIME_VERSION = '${RUNTIME_VERSION}';`);
  fs.writeFileSync(GATI_INSTALLER_PATH, gatiInstaller, 'utf8');
}

patchComposer();
patchBuildIdentity();
console.log('PASS ARKA expense submit V1: actionable validation, keyboard submit and fresh PWA identity');
