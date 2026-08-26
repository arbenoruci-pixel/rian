import fs from 'node:fs';

// TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:INSTALLER
// The guard is intentionally committed in the source files. This final
// prebuild step makes generated-source regressions fail before deployment.
const requiredMarkers = new Map([
  ['lib/transportOrdersDb.js', [
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:DB',
    'export function isTransportOrderPaymentBlocked',
    '.limit(25)',
  ]],
  ['app/transport/item/page.jsx', [
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:ITEM',
  ]],
  ['app/transport/pranimi/page.jsx', [
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PRANIMI_LOAD',
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PRANIMI_PAY',
  ]],
  ['app/transport/pay/page.jsx', [
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PAY_LOAD',
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:PAY_SAVE',
  ]],
  ['api/transport/receivables.js', [
    'TRANSPORT_CANCELLED_PAYMENT_GUARD_V1:API',
    "apiFail(res, 'TRANSPORT_ORDER_CANCELLED', 409)",
  ]],
]);

const missing = [];
for (const [path, markers] of requiredMarkers) {
  const source = fs.readFileSync(path, 'utf8');
  for (const marker of markers) {
    if (!source.includes(marker)) missing.push(`${path}: ${marker}`);
  }
}

if (missing.length) {
  throw new Error(`transport cancelled-payment guard was overwritten:\n${missing.join('\n')}`);
}

// Keep this preservation check last even when older one-way installers move
// themselves to the end of prebuild.
const packagePath = 'package.json';
const installerCommand = 'node tools/apply-transport-cancelled-payment-guard-v1.mjs';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const prebuild = String(pkg?.scripts?.prebuild || '')
  .split('&&')
  .map((part) => part.trim())
  .filter(Boolean)
  .filter((part) => part !== installerCommand);
prebuild.push(installerCommand);
pkg.scripts.prebuild = prebuild.join(' && ');
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log('transport cancelled-payment guard v1 preserved');
