import fs from 'node:fs';

const path = 'tools/apply-base-payment-bonus-v2.mjs';
let source = fs.readFileSync(path, 'utf8');
const startNeedle = '  source = source.replace(\n    `{canManage ? \\`';
const start = source.indexOf(startNeedle);
if (start < 0) {
  console.log('[fix-base-payment-bonus-v2-builder] already fixed or anchor absent');
  process.exit(0);
}
const end = source.indexOf('  );', start);
if (end < 0) throw new Error('BROKEN_BONUS_PAGE_REPLACE_END_NOT_FOUND');
const replacement = [
  '  source = source.replace(',
  '    "{canManage ? `${String(row.worker_name || row.worker_pin || \'\').toUpperCase()} • PIN ${row.worker_pin || \'—\'} • ` : \'\'}{stamp(row.ready_at)}",',
  '    "{canManage ? `${String(row.worker_name || row.worker_pin || \'\').toUpperCase()} • PIN ${row.worker_pin || \'—\'} • ` : \'\'}PAGESA ${stamp(row.activated_at || row.ready_at)}"',
  '  );',
  '',
].join('\n');
source = source.slice(0, start) + replacement + source.slice(end + 5);
fs.writeFileSync(path, source, 'utf8');
console.log('[fix-base-payment-bonus-v2-builder] fixed');
