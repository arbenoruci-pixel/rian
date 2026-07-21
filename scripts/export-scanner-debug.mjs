import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [
  'components/ScannerLab.jsx',
  'lib/scanner/pipeline.js',
  'lib/scanner/quality.js',
  'lib/scanner/geometry.js',
  'lib/scanner/runtime.js',
  'lib/scanner/session.js',
  'lib/scanner/constants.js',
];

const outDir = path.join(root, 'public', '__scanner_debug');
fs.mkdirSync(outDir, { recursive: true });

for (const relative of files) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) continue;
  const safeName = relative.replaceAll('/', '__');
  fs.copyFileSync(source, path.join(outDir, `${safeName}.txt`));
}

fs.writeFileSync(
  path.join(outDir, 'index.json'),
  `${JSON.stringify({ files: files.map(file => `${file.replaceAll('/', '__')}.txt`) }, null, 2)}\n`,
);

function printFile(relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  console.log(`===== BEGIN ${relative} =====`);
  source.split('\n').forEach((line, index) => {
    console.log(`${String(index + 1).padStart(4, '0')}: ${line}`);
  });
  console.log(`===== END ${relative} =====`);
}

printFile('components/ScannerLab.jsx');
printFile('lib/scanner/session.js');
console.log('Exported scanner debug sources.');
