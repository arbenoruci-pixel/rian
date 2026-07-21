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
  /BoundaryEditor|boundaryHandles|updateBoundaryPoint|reviewBoundary|Auto-fix|edge points/i,
  12,
  28,
);
printMatches(
  'lib/scanner/curvedBoundary.js',
  /SIDE|SIDES|boundaryFromCorners|boundaryHandles|boundaryPathPoints|updateBoundaryPoint|export function|extractCurvedDocument|refineBoundaryFromImage/i,
  18,
  64,
);
printMatches(
  'lib/scanner/qualityBot.js',
  /export|auto|quality|enhance|filter/i,
  5,
  12,
);
