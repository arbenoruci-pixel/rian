import fs from 'node:fs';
const src = fs.readFileSync('components/ArkaWorkerDailyStatus.jsx','utf8');
const checks = [
  ['marker','ARKA_LIVE_WORKER_PAYMENTS_V1'],
  ['live query',"from('arka_pending_payments')"],
  ['worker pin filter',".eq('created_by_pin', pin)"],
  ['15s refresh','window.setInterval(load, 15000)'],
  ['focus refresh',"window.addEventListener('focus', load)"],
  ['pageshow refresh',"window.addEventListener('pageshow', load)"],
  ['payment list','PAGESAT E SOTME'],
  ['transport code','row?.transport_code_str'],
  ['status','statusLabel(row?.status)'],
  ['gross from live activity','cashGross: sum(paymentActivityRows'],
];
let passed=0;
for (const [name, token] of checks) {
  if (!src.includes(token)) throw new Error(`FAIL ${name}`);
  console.log(`PASS ${name}`); passed++;
}
console.log(`PASS — ${passed} live worker payment checks.`);
