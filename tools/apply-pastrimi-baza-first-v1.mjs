import fs from 'node:fs';

const file = 'lib/pastrimiWorkerGroupingBridge.js';
let source = fs.readFileSync(file, 'utf8');

const oldBlock = `const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  blerim: { label: 'BLERIM', order: 100 },
  tapin: { label: 'TAPIN', order: 200 },
  baza: { label: 'BAZA', order: 300 },
};`;

const newBlock = `const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  blerim: { label: 'BLERIM', order: 200 },
  tapin: { label: 'TAPIN', order: 300 },
  baza: { label: 'BAZA', order: 100 },
};`;

const currentFitimBlock = `const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  baza: { label: 'BAZA', order: 100 },
  fitim: { label: 'FITIM', order: 200 },
  blerim: { label: 'BLERIM', order: 300 },
  tapin: { label: 'TAPIN', order: 400 },
};`;

if (source.includes(newBlock) || source.includes(currentFitimBlock)) {
  console.log('[pastrimi-baza-first-v1] already applied');
  process.exit(0);
}
if (!source.includes(oldBlock)) throw new Error('PASTRIMI_GROUP_ORDER_BLOCK_NOT_FOUND');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(file, source, 'utf8');
console.log('[pastrimi-baza-first-v1] applied');
