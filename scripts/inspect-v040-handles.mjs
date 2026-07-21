import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function printMatches(relative, pattern, before = 10, after = 24) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) {
    console.log(`MISSING ${relative}`);
    return;
  }
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  const indexes = lines
    .map((line, index) => pattern.test(line) ? index : -1)
    .filter(index => index >= 0);
  const wanted = new Set();
  for (const index of indexes) {
    for (let cursor = Math.max(0, index - before); cursor <= Math.min(lines.length - 1, index + after); cursor += 1) {
      wanted.add(cursor);
    }
  }
  console.log(`\n===== ${relative} =====`);
  [...wanted]
    .sort((a, b) => a - b)
    .forEach(index => console.log(`${String(index + 1).padStart(4, '0')}: ${lines[index]}`));
}

printMatches(
  'components/ScannerLab.jsx',
  /Boundary|boundary|curve|Curve|handle|Handle|reviewBoundary|CornerEditor|Auto-fix|six|16-point/i,
  16,
  34,
);
printMatches(
  'lib/scanner/curveModel.js',
  /BOUNDARY|boundary|handle|curve|point|Coons|export/i,
  8,
  20,
);
printMatches(
  'lib/scanner/qualityBot.js',
  /export|auto|quality|enhance|filter/i,
  5,
  12,
);
