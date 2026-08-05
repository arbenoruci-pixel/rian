import fs from 'node:fs';

const FILE = 'lib/corporateFinance.js';
const MARKER = 'DISPATCH_OWN_HANDOFF_BONUS_BYPASS_V1';
let source = fs.readFileSync(FILE, 'utf8');

if (source.includes(MARKER)) {
  console.log('[dispatch-own-handoff-bonus-bypass-v1] already installed');
  process.exit(0);
}

const anchor = `const nowIso = () => new Date().toISOString();`;
if (!source.includes(anchor)) throw new Error('DISPATCH_BONUS_BYPASS_HELPER_ANCHOR_MISSING');
source = source.replace(anchor, `${anchor}\n\n// ${MARKER}\nasync function listReadyBonusRowsWithoutBlockingHandoff(pin) {\n  try {\n    return await listOpenBaseReadyBonusPayments(pin);\n  } catch (error) {\n    const message = String(error?.message || error || '').trim().toUpperCase();\n    // DISPATCH/ADMIN users can collect client cash under their own PIN.\n    // They are not eligible for the worker-only 48H bonus, so zero bonus must\n    // never block a valid cash handoff. Other errors remain strict.\n    if (message.includes('BONUS_WORKER_ONLY')) return [];\n    throw error;\n  }\n}`);

const oldCall = `      listOpenBaseReadyBonusPayments(pin),`;
const newCall = `      listReadyBonusRowsWithoutBlockingHandoff(pin),`;
if (!source.includes(oldCall)) throw new Error('DISPATCH_BONUS_BYPASS_CALL_ANCHOR_MISSING');
source = source.replace(oldCall, newCall);

fs.writeFileSync(FILE, source, 'utf8');
console.log('[dispatch-own-handoff-bonus-bypass-v1] installed');
