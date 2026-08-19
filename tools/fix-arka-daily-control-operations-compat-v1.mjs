import fs from 'node:fs';

const path = 'tools/verify-arka-daily-control-v1.mjs';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    `check(wizard.includes("get_arka_daily_close_preview_v3"), 'Canonical daily preview RPC missing');`,
    `check(wizard.includes("get_arka_daily_close_preview_v4"), 'Canonical daily preview V4 RPC missing');`,
  ],
  [
    `check(wizard.includes('SA PARA I NUMËROVE FIZIKISHT?'), 'Physical cash metric missing');`,
    `check(wizard.includes('SHUMA U VENDOS AUTOMATIKISHT'), 'Automatic physical cash metric missing');`,
  ],
];

for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`ARKA_DAILY_CONTROL_COMPAT_EXPECTED_ONE_FOUND:${count}:${from}`);
  source = source.replace(from, to);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS ARKA daily-control verifier accepts preview V4 and automatic physical cash.');
