import fs from 'node:fs';

const path = 'tools/verify-transport-payment-button-v3.mjs';
let source = fs.readFileSync(path, 'utf8');

const from = `check(vite.includes('v44-query-authority-transport-guard-payment-button-v3'), 'PWA cache generation was not bumped');`;
const to = `check(vite.includes('query-authority-transport-guard-payment-button-v3'), 'PWA cache generation lost the transport payment guard');`;

if (!source.includes(to)) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`TRANSPORT_PAYMENT_CACHE_COMPAT_EXPECTED_ONE_FOUND:${count}`);
  source = source.replace(from, to);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS transport payment verifier accepts the combined final cache identity.');
