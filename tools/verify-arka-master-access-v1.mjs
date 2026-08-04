import fs from 'node:fs';

const source = fs.readFileSync('app/arka/page.jsx', 'utf8');
const checks = [
  ['marker', source.includes('ARKA_MASTER_ACCESS_V1')],
  ['normalizer', source.includes("function normalizeArkaRole(role)")],
  ['master user alias', source.includes("['MASTER', 'MASTER_USER', 'MASTERUSER'].includes(raw)")],
  ['manager permission', source.includes("['MASTER', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizeArkaRole(role))")],
  ['visible account', source.includes("normalized === 'DISPATCH' || normalized === 'MASTER'")],
  ['actor role normalized', source.includes("const role = normalizeArkaRole(actor?.role)")],
];
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('[verify-arka-master-access-v1] failed:', failed.map(([name]) => name).join(', '));
  process.exit(1);
}
console.log(`[verify-arka-master-access-v1] ${checks.length} checks passed`);
