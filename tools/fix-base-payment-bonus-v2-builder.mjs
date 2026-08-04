import fs from 'node:fs';

const path = 'tools/apply-base-payment-bonus-v2.mjs';
let source = fs.readFileSync(path, 'utf8');
const startNeedle = `  source = source.replace(\n    \`{canManage ? \\\``;
const start = source.indexOf(startNeedle);
if (start < 0) {
  console.log('[fix-base-payment-bonus-v2-builder] already fixed or anchor absent');
  process.exit(0);
}
const end = source.indexOf(`  );`, start);
if (end < 0) throw new Error('BROKEN_BONUS_PAGE_REPLACE_END_NOT_FOUND');
const replacement = `  // Builder safety: the bonus row timestamp JSX already works. Avoid evaluating\n  // JSX template expressions while this Node patch builder is running.\n`;
source = source.slice(0, start) + replacement + source.slice(end + 5);
fs.writeFileSync(path, source, 'utf8');
console.log('[fix-base-payment-bonus-v2-builder] fixed');
