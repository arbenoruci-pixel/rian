import fs from 'node:fs';
const file = 'app/pastrimi/page.jsx';
const src = fs.readFileSync(file, 'utf8');
const checks = [
  ['PASTRIM_DELAY_REVIEW_ENABLED false', /const\s+PASTRIM_DELAY_REVIEW_ENABLED\s*=\s*false\s*;/.test(src)],
  ['warning gated by enabled flag', /const\s+warning\s*=\s*PASTRIM_DELAY_REVIEW_ENABLED\s*&&/.test(src)],
  ['due gated by enabled flag', /due:\s*PASTRIM_DELAY_REVIEW_ENABLED\s*&&/.test(src)],
  ['auto-enter effect exits when disabled', src.includes('if (!PASTRIM_DELAY_REVIEW_ENABLED) return;') && src.includes("openPastrimDelayReview(dueRow, 'auto_enter_pastrim')")],
  ['review alert panel hidden when disabled', src.includes('{PASTRIM_DELAY_REVIEW_ENABLED ? (() => {') && src.includes('ALERTE PËR REVIEW')],
  ['delay chips removed from rendered list', !/\{\s*key:\s*'over4'/.test(src) && !/\{\s*key:\s*'snooze'/.test(src) && !/\{\s*key:\s*'due'/.test(src)],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) ok = false;
}
if (!ok) process.exit(1);
