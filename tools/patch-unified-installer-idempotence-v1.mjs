import fs from 'node:fs';

const PATH = 'tools/apply-unified-arka-payroll-v1.mjs';
const MARKER = 'UNIFIED_INSTALLER_IDEMPOTENCE_V1';
let source = fs.readFileSync(PATH, 'utf8');

if (!source.includes(MARKER)) {
  const oldText = `function hideFirstAfter(source, startIndex, opening, label) {
  const index = source.indexOf(opening, startIndex);
  if (index < 0) throw new Error(\`${'${label}'}: opening missing\`);
  if (source.slice(index, index + opening.length).includes("display:'none'")) return source;
  const replacement = opening.replace(/>$/, " style={{ display:'none' }} aria-hidden=\\"true\\">");
  return replaceAt(source, index, opening, replacement, label);
}`;

  const newText = `function hideFirstAfter(source, startIndex, opening, label) {
  // ${MARKER}: the installer runs once before build and once inside prebuild.
  // Accept an already-hidden opening or a superseding installer that changed the legacy block.
  const plainIndex = source.indexOf(opening, startIndex);
  if (plainIndex >= 0) {
    const replacement = opening.replace(/>$/, " style={{ display:'none' }} aria-hidden=\\"true\\">");
    return replaceAt(source, plainIndex, opening, replacement, label);
  }
  const prefix = opening.endsWith('>') ? opening.slice(0, -1) : opening;
  const existingIndex = source.indexOf(prefix, startIndex);
  if (existingIndex >= 0) {
    const tagEnd = source.indexOf('>', existingIndex);
    const tag = tagEnd >= 0 ? source.slice(existingIndex, tagEnd + 1) : '';
    if (tag.includes("display:'none'") || tag.includes("display: 'none'")) return source;
  }
  return source;
}`;

  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`hideFirstAfter compatibility anchor count=${count}`);
  source = source.replace(oldText, newText);
  fs.writeFileSync(PATH, source, 'utf8');
}

console.log('PASS unified installer idempotence patch');
