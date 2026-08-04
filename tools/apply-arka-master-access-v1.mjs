import fs from 'node:fs';

const FILE = 'app/arka/page.jsx';
const MARKER = 'ARKA_MASTER_ACCESS_V1';
let source = fs.readFileSync(FILE, 'utf8');

if (!source.includes(MARKER)) {
  const oldSafeUpper = `function safeUpper(v) {\n  return String(v || '').trim().toUpperCase();\n}`;
  const newSafeUpper = `function safeUpper(v) {\n  return String(v || '').trim().toUpperCase();\n}\n\n// ${MARKER}: normalize all persisted master-role spellings to one permission identity.\nfunction normalizeArkaRole(role) {\n  const raw = safeUpper(role).replace(/[\\s-]+/g, '_');\n  if (['MASTER', 'MASTER_USER', 'MASTERUSER'].includes(raw)) return 'MASTER';\n  return raw;\n}`;
  if (!source.includes(oldSafeUpper)) throw new Error('SAFE_UPPER_ANCHOR_NOT_FOUND');
  source = source.replace(oldSafeUpper, newSafeUpper);

  const oldRoleBlock = `function roleIsWorker(role) {\n  return ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(safeUpper(role));\n}\nfunction roleIsArkaVisibleAccount(role) {\n  return roleIsWorker(role) || safeUpper(role) === 'DISPATCH';\n}\nfunction roleCanManage(role) {\n  return ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(safeUpper(role));\n}`;
  const newRoleBlock = `function roleIsWorker(role) {\n  return ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(normalizeArkaRole(role));\n}\nfunction roleIsArkaVisibleAccount(role) {\n  const normalized = normalizeArkaRole(role);\n  return roleIsWorker(normalized) || normalized === 'DISPATCH' || normalized === 'MASTER';\n}\nfunction roleCanManage(role) {\n  return ['MASTER', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizeArkaRole(role));\n}`;
  if (!source.includes(oldRoleBlock)) throw new Error('ROLE_BLOCK_ANCHOR_NOT_FOUND');
  source = source.replace(oldRoleBlock, newRoleBlock);

  const oldRoleLine = `  const role = safeUpper(actor?.role);`;
  const newRoleLine = `  const role = normalizeArkaRole(actor?.role);`;
  if (!source.includes(oldRoleLine)) throw new Error('ROLE_STATE_ANCHOR_NOT_FOUND');
  source = source.replace(oldRoleLine, newRoleLine);

  const oldKapaku = `  const canOpenKapaku = canManage && (String(actor?.pin || '').trim() === '2380' || ['MASTER', 'ADMIN', 'ADMIN_MASTER', 'SUPERADMIN', 'DISPATCH'].includes(role));`;
  const newKapaku = `  const canOpenKapaku = canManage && (String(actor?.pin || '').trim() === '2380' || ['MASTER', 'ADMIN', 'ADMIN_MASTER', 'SUPERADMIN', 'DISPATCH'].includes(normalizeArkaRole(role)));`;
  if (!source.includes(oldKapaku)) throw new Error('KAPAKU_ANCHOR_NOT_FOUND');
  source = source.replace(oldKapaku, newKapaku);

  fs.writeFileSync(FILE, source, 'utf8');
  console.log('[arka-master-access-v1] installed');
} else {
  console.log('[arka-master-access-v1] already installed');
}
