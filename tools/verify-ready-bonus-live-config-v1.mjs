import fs from 'node:fs';
const attention = fs.readFileSync('components/ReadyBonusAttention.jsx','utf8');
const live = fs.readFileSync('components/ReadyBonusLiveCard.jsx','utf8');
const checks = [
  ['attention uses live RPC', attention.includes("get_base_bonus_opportunities_v1")],
  ['attention reads live window', attention.includes('window_hours')],
  ['attention has no hardcoded 48h window ms', !attention.includes('48 * 60 * 60 * 1000')],
  ['live card reads summary config', live.includes('summary?.config')],
  ['live card uses dynamic window label', live.includes('windowHours')],
];
for (const [label, ok] of checks) { if (!ok) throw new Error(`FAIL ${label}`); console.log(`PASS ${label}`); }
console.log(`PASS — ${checks.length} live bonus config checks.`);
