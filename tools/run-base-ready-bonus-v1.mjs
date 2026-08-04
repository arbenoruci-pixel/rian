import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = path.resolve('tools/apply-base-ready-bonus-v1.mjs');
const tempPath = path.resolve('tools/.apply-base-ready-bonus-v1.generated.mjs');
let source = fs.readFileSync(sourcePath, 'utf8');
let fixed = false;

const fixedLine = "      alert(\\`✅ DORËZIMI U DËRGUA TE DISPATCH.\\${held > 0 ? '\\\\nBONUSI 48H I MBAJTUR NË KËTË DORËZIM: ' + held.toFixed(2) + '€' : ''}\\`);";
source = source.split('\n').map((line) => {
  if (line.includes('alert(\\`✅ DORËZIMI U DËRGUA TE DISPATCH.') && line.includes('held.toFixed(2)')) {
    fixed = true;
    return fixedLine;
  }
  return line;
}).join('\n');

if (!fixed && !source.includes("'\\\\nBONUSI 48H I MBAJTUR NË KËTË DORËZIM: ' + held.toFixed(2)")) {
  throw new Error('BASE_READY_BONUS_PATCH_SYNTAX_FIX_ANCHOR_NOT_FOUND');
}

fs.writeFileSync(tempPath, source, 'utf8');
try {
  await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}`);
} finally {
  try { fs.unlinkSync(tempPath); } catch {}
}
