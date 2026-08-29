import { getOrderCodeBadgeStyle } from '../lib/orderCodeBadge.js';
import fs from 'node:fs';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`PASS ${label}`); };
const short = getOrderCodeBadgeStyle('T931');
const long = getOrderCodeBadgeStyle('T1202');
const future = getOrderCodeBadgeStyle('T123456789');
check(short.width >= 40, 'short code keeps the minimum badge width');
check(long.width >= 67 && long.width > short.width, 'T1202 keeps safe iPhone glyph padding');
check(long.maxWidth <= 76 && future.width <= 76, 'badge width stays inside the row frame');
check(long.padding === '0 7px' && long.textAlign === 'center', 'both code edges keep explicit inner clearance');
check(future.fontSize < long.fontSize, 'future longer codes shrink before overflowing');
for (const file of ['app/pastrimi/page.jsx','app/gati/page.jsx']) {
  const source = fs.readFileSync(file, 'utf8');
  check(source.includes('getOrderCodeBadgeStyle'), `${file} uses responsive code badges`);
}
if (failures.length) { failures.forEach((x, i) => console.error(`${i + 1}. ${x}`)); process.exit(1); }
console.log('PASS: long order-code badges remain inside Pastrimi and Gati frames.');
