import { getOrderCodeBadgeStyle } from '../lib/orderCodeBadge.js';
import fs from 'node:fs';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`PASS ${label}`); };
const short = getOrderCodeBadgeStyle('T931');
const long = getOrderCodeBadgeStyle('T1202');
const future = getOrderCodeBadgeStyle('T123456789');
check(short.width >= 40, 'short code keeps the minimum badge width');
check(long.width > short.width, 'T1202 badge grows to fit its content');
check(long.maxWidth <= 72 && future.width <= 72, 'badge width stays inside the row frame');
check(future.fontSize < long.fontSize, 'future longer codes shrink before overflowing');
for (const file of ['app/pastrimi/page.jsx','app/gati/page.jsx']) {
  const source = fs.readFileSync(file, 'utf8');
  check(source.includes('getOrderCodeBadgeStyle'), `${file} uses responsive code badges`);
}
if (failures.length) { failures.forEach((x, i) => console.error(`${i + 1}. ${x}`)); process.exit(1); }
console.log('PASS: long order-code badges remain inside Pastrimi and Gati frames.');
