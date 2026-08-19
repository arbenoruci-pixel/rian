import fs from 'node:fs';

const path = 'tools/verify-arka-daily-close-v2.mjs';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    `check(component.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v3'"), 'daily preview RPC missing');`,
    `check(component.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v4'"), 'daily preview V4 RPC missing');`,
  ],
  [
    `check(component.includes('SA PARA I NUMËROVE FIZIKISHT?'), 'physical cash count input missing');`,
    `check(component.includes('SHUMA U VENDOS AUTOMATIKISHT'), 'automatic physical cash count input missing');`,
  ],
];

for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`ARKA_DAILY_CLOSE_COMPAT_EXPECTED_ONE_FOUND:${count}:${from}`);
  source = source.replace(from, to);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS ARKA daily-close verifier accepts preview V4 and automatic physical cash.');
