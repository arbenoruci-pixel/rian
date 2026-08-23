import { buildOrderTrackUrl, buildSmartSmsText } from '../lib/smartSms.js';
import { rewriteCustomerTrackingText } from '../lib/customerTrackingCopy.js';
import fs from 'node:fs';

const checks = [];

function check(condition, message) {
  const ok = Boolean(condition);
  checks.push({ ok, message });
  if (!ok) console.error(`FAIL: ${message}`);
}

const baseOrder = {
  id: 2505,
  code: 427,
  client_name: 'valon berisha',
  client_phone: '+38349665253',
  status: 'dorzim',
  pieces: 3,
  total_euro: 24,
  data: {
    code: '427',
    client_code: '427',
  },
};

check(
  buildOrderTrackUrl(baseOrder) === 'https://tepiha.vercel.app/k/2505?src=base',
  'Baza uses the exact orders.id instead of the reusable client code',
);

check(
  buildOrderTrackUrl({
    id: 427,
    code: 427,
    fullOrder: baseOrder,
  }) === 'https://tepiha.vercel.app/k/2505?src=base',
  'A full DB row outranks a modal/list wrapper id',
);

check(
  buildOrderTrackUrl({
    id: 'cd17f12e-74eb-44ee-b5ef-3c9c91e38c38',
    order_id: 3106,
    code: 1032,
    client_name: 'taulant imeri',
  }) === 'https://tepiha.vercel.app/k/3106?src=base',
  'Base acceptance SMS uses the verified DB id even when its local UUID and client code differ',
);

check(
  buildOrderTrackUrl({ code: 1032, client_name: 'taulant imeri' }) === 'https://tepiha.vercel.app/k/',
  'Base fails safe when only a reusable client code is available',
);
check(
  !buildSmartSmsText({ code: 1032, client_name: 'taulant imeri' }, 'pranimi_baze').includes('Ndiqni statusin LIVE:'),
  'Base acceptance SMS omits tracking when a verified exact id is unavailable',
);

const transportUuid = '7e826204-6aca-4c84-9804-a6e3c525d3b3';
const transportOrder = {
  id: 'wrapper-row-9',
  client_tcode: 'T9',
  code_str: 'T9',
  client_name: 'hashim thaqi',
  pieces: 2,
  data: {
    order_id: transportUuid,
    public_order_id: transportUuid,
    client_tcode: 'T9',
    tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1',
  },
};

check(
  buildOrderTrackUrl(transportOrder) === `https://tepiha.vercel.app/k/${transportUuid}?src=transport`,
  'Transport uses the exact transport_orders UUID instead of the permanent T-code',
);

check(
  buildOrderTrackUrl({
    client_tcode: 'T9',
    data: { tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1' },
  }) === 'https://tepiha.vercel.app/k/',
  'Transport fails safe when an exact UUID is missing',
);
check(
  !buildSmartSmsText({
    client_tcode: 'T9',
    data: { tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1' },
  }, 'transport_pranimi').includes('Për të ndjekur statusin live'),
  'Transport acceptance SMS omits tracking when an exact UUID is unavailable',
);

const baseReadyText = buildSmartSmsText(baseOrder, 'gati_baze');
check(baseReadyText.includes('Tepihat e juaj janë GATI'), 'Baza customer wording uses “Tepihat e juaj”');
check(!baseReadyText.includes('Porosia juaj'), 'Baza customer wording no longer says “Porosia juaj”');
check(baseReadyText.includes('/k/2505?src=base'), 'Baza Smart SMS contains the exact order link');

const transportAcceptedText = buildSmartSmsText(transportOrder, 'transport_pranimi');
check(transportAcceptedText.includes('Tepihat e juaj u pranuan'), 'Transport customer wording uses “Tepihat e juaj”');
check(!transportAcceptedText.includes('Porosia juaj'), 'Transport customer wording no longer says “Porosia juaj”');
check(transportAcceptedText.includes(`/k/${transportUuid}?src=transport`), 'Transport Smart SMS contains the exact UUID link');

check(
  rewriteCustomerTrackingText('Ndiqeni progresin e porosisë suaj në kohë reale.') ===
    'Tepihat e juaj – ndiqeni progresin në kohë reale.',
  'Public tracking subtitle says “Tepihat e juaj”',
);

check(
  rewriteCustomerTrackingText('Po marrim të dhënat e porosisë suaj.') ===
    'Po marrim të dhënat për tepihat e juaj.',
  'Public tracking loading copy refers to the customer rugs',
);

check(
  rewriteCustomerTrackingText('Statusi i Porosisë') === 'Statusi i Tepihave',
  'Public tracking status title says “Statusi i Tepihave”',
);

check(
  rewriteCustomerTrackingText('🚐 Marrja e Porosisë') === '🚐 Marrja e Tepihave',
  'Transport timeline says “Marrja e Tepihave”',
);

check(
  rewriteCustomerTrackingText('Porosia ndodhet në Depo!') === 'Tepihat ndodhen në Depo!',
  'Depot notice refers to the customer rugs',
);

const trackingSource = fs.readFileSync(new URL('../app/k/[id]/page.jsx', import.meta.url), 'utf8');
const ordersServiceSource = fs.readFileSync(new URL('../lib/ordersService.js', import.meta.url), 'utf8');
const pranimiSource = fs.readFileSync(new URL('../app/pranimi/page.jsx', import.meta.url), 'utf8');
check(
  trackingSource.includes("if (srcHint === 'base')") &&
    trackingSource.includes("resolved = await resolveOrderById(rawId, 'base', '*')"),
  'Tracking resolves an explicit Base source only through the Base resolver',
);
check(
  /if \(srcHint === 'base'\)[\s\S]*?} else \{[\s\S]*?if \(!resolved && \(isTransportCode \|\| isShortNumeric\)\)/.test(trackingSource),
  'The legacy Transport numeric fallback is outside the explicit Base branch',
);
check(
  ordersServiceSource.includes("if (hint === 'base' || hint === 'orders')") &&
    ordersServiceSource.includes('return (await tryBase()) || (await tryBaseByCode())'),
  'Legacy Base code links stay inside public.orders',
);
check(
  pranimiSource.includes('order_id: verifiedOrderIdForDraftCleanup') &&
    pranimiSource.includes('public_order_id: verifiedOrderIdForDraftCleanup'),
  'Normal Base acceptance SMS carries the verified persisted order id',
);
check(
  pranimiSource.includes('order_id: verifiedSmsOrderId') &&
    pranimiSource.includes('warning?.retry_result?.server_id'),
  'Recovered Base acceptance SMS also carries the verified persisted order id',
);

const customerPageCopy = rewriteCustomerTrackingText([
  'Ndiqeni progresin e porosisë suaj në kohë reale.',
  'Po marrim të dhënat e porosisë suaj.',
  'Statusi i Porosisë',
  'Porosia ndodhet në Depo!',
  'Sipas rregullores, porosia është kthyer në depo.',
  'Keni zgjedhur rikthimin e porosisë.',
].join('\n'));

check(customerPageCopy.includes('Tepihat e juaj'), 'Combined public page copy includes “Tepihat e juaj”');
check(!/porosi/i.test(customerPageCopy), 'Combined public page copy contains no customer-facing “porosi” wording');

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`\n${failed.length} Smart SMS/tracking check(s) failed.`);
  process.exit(1);
}

console.log(`PASS: ${checks.length} Smart SMS/tracking exact-order checks passed.`);
