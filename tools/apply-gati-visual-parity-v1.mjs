import fs from 'node:fs';

const mainPath = 'src/main.jsx';
const importLine = "import { installGatiVisualParityBridge } from '../lib/gatiVisualParityBridge.js';";
const importAnchor = "import { installTransportMultiLocationBridge } from '../lib/transportMultiLocationBridge.js';";
const callLine = 'installGatiVisualParityBridge();';
const callAnchor = 'installTransportMultiLocationBridge();';

let source = fs.readFileSync(mainPath, 'utf8');
let changed = false;

if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('GATI_VISUAL_IMPORT_ANCHOR_NOT_FOUND');
  source = source.replace(importAnchor, `${importLine}\n${importAnchor}`);
  changed = true;
}

if (!source.includes(callLine)) {
  if (!source.includes(callAnchor)) throw new Error('GATI_VISUAL_CALL_ANCHOR_NOT_FOUND');
  source = source.replace(callAnchor, `${callLine}\n${callAnchor}`);
  changed = true;
}

if (changed) fs.writeFileSync(mainPath, source, 'utf8');
console.log(`[gati-visual-parity-v1] ${changed ? 'installed' : 'already installed'}`);
