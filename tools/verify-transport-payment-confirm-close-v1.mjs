import fs from 'node:fs';

const page = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const requiredPage = [
  'TRANSPORT_PAYMENT_CONFIRM_CLOSE_V1:PAGE',
  'currentOrderOverride = null',
  "statusOnFullPayment: shouldFinalizeDelivery ? 'done' : undefined",
  'recoveredAfterResponseLoss: true',
  "window.location.replace(paymentReturnUrl)",
  "confirmText={paymentBusy ? 'DUKE RUAJTUR...' : 'KRYEJ PAGESËN'}",
];
for (const token of requiredPage) {
  if (!page.includes(token)) throw new Error('missing page token: ' + token);
}

const requiredEngine = [
  'TRANSPORT_PAYMENT_CONFIRM_CLOSE_V1:ENGINE',
  'normalizeTransportPaymentFullStatus',
  'statusOnFullPayment:',
  "const nextStatus = debt <= 0.01 && requestedFullStatus ? requestedFullStatus : currentStatus;",
];
for (const token of requiredEngine) {
  if (!engine.includes(token)) throw new Error('missing engine token: ' + token);
}

if (!String(pkg.scripts?.prebuild || '').includes('apply-transport-payment-confirm-close-v1.mjs')) {
  throw new Error('installer missing from prebuild');
}
console.log('transport payment confirmation/close verification passed');
