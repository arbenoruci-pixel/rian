import fs from 'node:fs';

const path = 'tools/apply-home-search-local-oid-dedupe-v1.mjs';
let source = fs.readFileSync(path, 'utf8');

const oldCondition = `  if (!source.includes("homeSearchLocalOidDedupeV1Installer, installer'),\\n  'future prebuild ordering")) {`;
const newCondition = `  if (!source.includes('homeSearchLocalOidDedupeV1Installer')) {`;

if (!source.includes(newCondition)) {
  const count = source.split(oldCondition).length - 1;
  if (count !== 1) throw new Error(`HOME_SEARCH_COMPAT_CONDITION_EXPECTED_ONE_FOUND:${count}`);
  source = source.replace(oldCondition, newCondition);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS Home search installer accepts the newer ARKA operations final-owner chain.');
