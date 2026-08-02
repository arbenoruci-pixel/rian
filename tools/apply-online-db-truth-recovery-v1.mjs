import fs from 'node:fs';

const mainPath = 'src/main.jsx';
const importLine = "import { installOnlineDbTruthRecovery } from '../lib/onlineDbTruthRecovery.js';";
const importAnchor = "import { installTransportMultiLocationBridge } from '../lib/transportMultiLocationBridge.js';";
const callLine = 'installOnlineDbTruthRecovery();';
const callAnchor = 'installTransportMultiLocationBridge();';

let source = fs.readFileSync(mainPath, 'utf8');
let changed = false;

if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('ONLINE_DB_TRUTH_IMPORT_ANCHOR_NOT_FOUND');
  source = source.replace(importAnchor, `${importLine}\n${importAnchor}`);
  changed = true;
}

if (!source.includes(callLine)) {
  if (!source.includes(callAnchor)) throw new Error('ONLINE_DB_TRUTH_CALL_ANCHOR_NOT_FOUND');
  source = source.replace(callAnchor, `${callLine}\n${callAnchor}`);
  changed = true;
}

if (changed) fs.writeFileSync(mainPath, source, 'utf8');
console.log(`[online-db-truth-recovery-v1] ${changed ? 'installed' : 'already installed'}`);
