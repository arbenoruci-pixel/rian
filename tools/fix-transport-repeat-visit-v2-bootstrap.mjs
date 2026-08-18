import fs from 'node:fs';

const path = 'tools/apply-gati-rack-save-v1.mjs';
let source = fs.readFileSync(path, 'utf8');
source = source.replace(
  "const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';\\n  const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';",
  "const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';\n  const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';"
);
fs.writeFileSync(path, source, 'utf8');
console.log('PASS repeat-visit V2 bootstrap compatibility fix');
