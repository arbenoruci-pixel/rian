import fs from 'node:fs';

const PATH = 'app/arka/page.jsx';
const MARKER = 'ARKA_MASTER_PERSONAL_V1';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[arka-master-personal-v1] already installed');
  process.exit(0);
}

const roleMatch = source.match(/function roleCanManage\(role\) \{[\s\S]*?\n\}/);
if (!roleMatch) throw new Error('ROLE_ANCHOR_NOT_FOUND');
const roleAnchor = roleMatch[0];
const roleReplacement = `${roleAnchor}

// ${MARKER}
function actorIsWorkerAccount(actor = {}) {
  const pin = String(actor?.pin || '').trim();
  return roleIsWorker(actor?.role) || pin === '1126';
}

function isMasterPersonalArkaMode(actor = {}) {
  const pin = String(actor?.pin || '').trim();
  if (pin !== '4563') return false;
  try {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search || '').get('personal') === '1';
  } catch {
    return false;
  }
}`;
source = source.replace(roleAnchor, roleReplacement);

const actorMatch = source.match(/  const role = safeUpper\(actor\?\.role\);\n  const isWorker = roleIsWorker\(role\);\n  const canManage = roleCanManage\(role\);\n  const canOpenKapaku = [^\n]+;/);
if (!actorMatch) throw new Error('ACTOR_ANCHOR_NOT_FOUND');
const actorAnchor = actorMatch[0];
const actorReplacement = `  const role = safeUpper(actor?.role);
  const masterPersonalMode = isMasterPersonalArkaMode(actor);
  const isWorker = actorIsWorkerAccount(actor) || masterPersonalMode;
  const canManage = roleCanManage(role) && !masterPersonalMode;
  const canOpenKapaku = canManage && (String(actor?.pin || '').trim() === '2380' || String(actor?.pin || '').trim() === '4563' || ['MASTER', 'ADMIN', 'ADMIN_MASTER', 'SUPERADMIN', 'DISPATCH'].includes(role));`;
source = source.replace(actorAnchor, actorReplacement);

source = source.replaceAll(
  `roleIsWorker(act?.role) && !roleCanManage(act?.role)`,
  `actorIsWorkerAccount(act) && !roleCanManage(act?.role)`
);

const navAnchor = `          <Link href="/arka/bonuset" prefetch={false} className="arkaTopBtn">BONUSI 48H</Link>`;
if (!source.includes(navAnchor)) throw new Error('NAV_ANCHOR_NOT_FOUND');
source = source.replace(navAnchor, `${navAnchor}
          {String(actor?.pin || '').trim() === '4563' && canManage ? <Link href="/arka?personal=1" prefetch={false} className="arkaTopBtn">ARKA IME</Link> : null}
          {String(actor?.pin || '').trim() === '4563' && masterPersonalMode ? <Link href="/arka" prefetch={false} className="arkaTopBtn">ADMIN ARKA</Link> : null}`);

fs.writeFileSync(PATH, source, 'utf8');
console.log('[arka-master-personal-v1] installed');
