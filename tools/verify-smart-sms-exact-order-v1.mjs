import { buildOrderTrackUrl, buildSmartSmsText } from '../lib/smartSms.js';

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

const baseReadyText = buildSmartSmsText(baseOrder, 'gati_baze');
check(baseReadyText.includes('Tepihat e juaj janë GATI'), 'Baza customer wording uses “Tepihat e juaj”');
check(!baseReadyText.includes('Porosia juaj'), 'Baza customer wording no longer says “Porosia juaj”');
check(baseReadyText.includes('/k/2505?src=base'), 'Baza Smart SMS contains the exact order link');

const transportAcceptedText = buildSmartSmsText(transportOrder, 'transport_pranimi');
check(transportAcceptedText.includes('Tepihat e juaj u pranuan'), 'Transport customer wording uses “Tepihat e juaj”');
check(!transportAcceptedText.includes('Porosia juaj'), 'Transport customer wording no longer says “Porosia juaj”');
check(transportAcceptedText.includes(`/k/${transportUuid}?src=transport`), 'Transport Smart SMS contains the exact UUID link');

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`\n${failed.length} Smart SMS check(s) failed.`);
  process.exit(1);
}

console.log(`PASS: ${checks.length} Smart SMS exact-order checks passed.`);
