import fs from 'node:fs';

const path = 'tools/apply-arka-daily-operations-v3.mjs';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  ['${m2(dailyIncoming?.base?.m2)}', '\\${m2(dailyIncoming?.base?.m2)}'],
  ['${m2(dailyIncoming?.transport?.m2)}', '\\${m2(dailyIncoming?.transport?.m2)}'],
  ['${m2(dailyOutgoing?.base?.m2)}', '\\${m2(dailyOutgoing?.base?.m2)}'],
  ['${m2(dailyOutgoing?.transport?.m2)}', '\\${m2(dailyOutgoing?.transport?.m2)}'],
  ['${n(dailyCurrent?.pastrim?.count)}', '\\${n(dailyCurrent?.pastrim?.count)}'],
  ['${n(dailyCurrent?.gati?.count)}', '\\${n(dailyCurrent?.gati?.count)}'],
];

for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  if (!source.includes(from)) throw new Error(`INSTALLER_LITERAL_NOT_FOUND:${from}`);
  source = source.replaceAll(from, to);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS ARKA daily operations installer literal JSX fix.');
