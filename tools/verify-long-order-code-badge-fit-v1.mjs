import { getOrderCodeBadgeStyle, getOrderCodeCircleStyle } from '../lib/orderCodeBadge.js';
import fs from 'node:fs';

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`PASS ${label}`); };
const short = getOrderCodeBadgeStyle('T931');
const long = getOrderCodeBadgeStyle('T1202');
const future = getOrderCodeBadgeStyle('T123456789');
const observedBaseCodes = ['T1089', 'T1152', 'T1183', 'T1202'].map(getOrderCodeBadgeStyle);
const transportShort = getOrderCodeCircleStyle('T84');
const transportLong = getOrderCodeCircleStyle('T1183');
const transportCompact = getOrderCodeCircleStyle('T1152', { diameter: 34, fontSize: 11 });
const transportModal = getOrderCodeCircleStyle('T1040', { diameter: 48, fontSize: 14 });
check(short.width >= 40, 'short code keeps the minimum badge width');
check(long.width >= 67 && long.width > short.width, 'T1202 keeps safe iPhone glyph padding');
check(long.maxWidth <= 76 && future.width <= 76, 'badge width stays inside the row frame');
check(long.padding === '0 8px' && long.textAlign === 'center', 'both code edges keep explicit inner clearance');
check(long.fontSize < short.fontSize, 'five-character Pastrimi and Gati codes shrink before clipping');
check(observedBaseCodes.every((style) => style.width === 67 && style.fontSize === 12), 'observed T#### codes use the safe rectangular fit');
check(JSON.stringify(getOrderCodeBadgeStyle(' T1183 ')) === JSON.stringify(getOrderCodeBadgeStyle('T1183')), 'whitespace does not change code fitting');
check(future.fontSize < long.fontSize, 'future longer codes shrink before overflowing');
for (const file of ['app/pastrimi/page.jsx','app/gati/page.jsx']) {
  const source = fs.readFileSync(file, 'utf8');
  check(source.includes('getOrderCodeBadgeStyle'), `${file} uses responsive code badges`);
}
check(transportLong.fontSize < transportShort.fontSize, 'five-character Transport codes shrink inside the circle');
check(transportLong.width === 36 && transportLong.maxWidth === 36, 'Transport code circle keeps a fixed 36px frame');
check(transportCompact.fontSize <= transportLong.fontSize, 'compact Transport row gets the stricter 34px fit');
check(transportModal.fontSize > transportLong.fontSize && transportModal.width === 48, 'larger Transport modal circle remains readable');
check(transportLong.padding === '0 3px' && transportLong.overflow === 'hidden', 'Transport circle reserves both edge clearances');
for (const file of [
  'app/transport/board/modules/dorzim.jsx',
  'app/transport/board/modules/ngarkim.jsx',
  'app/transport/board/modules/inbox.jsx',
  'app/transport/board/modules/depo.jsx',
  'app/transport/board/modules/dorezimet.jsx',
  'app/transport/board/modules/gati.jsx',
]) {
  const source = fs.readFileSync(file, 'utf8');
  check(source.includes('getOrderCodeCircleStyle'), `${file} uses responsive Transport code circles`);
}
const deliverySource = fs.readFileSync('app/transport/board/modules/dorzim.jsx', 'utf8');
check(deliverySource.includes('...transportCodeCircle, ...getOrderCodeCircleStyle(transportCode(getCode(item)))'), 'Pikapi PËR KLIENT applies fitting after its fixed circle style');
check(!deliverySource.includes('style={transportCodeCircle}>{transportCode(getCode(item))}'), 'Pikapi PËR KLIENT no longer uses the overflowing fixed style alone');
const inboxSource = fs.readFileSync('app/transport/board/modules/inbox.jsx', 'utf8');
check(inboxSource.includes("getOrderCodeCircleStyle(displayCode, { diameter: 32, fontSize: 9.5 })"), 'TË REJA keeps its compact 32px responsive circle');
if (failures.length) { failures.forEach((x, i) => console.error(`${i + 1}. ${x}`)); process.exit(1); }
console.log('PASS: long order codes remain inside Pastrimi, Gati, and Transport frames.');
