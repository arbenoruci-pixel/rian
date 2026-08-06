import fs from 'node:fs';

const GATI_FILE = 'app/gati/page.jsx';
const INDEX_FILE = 'index.html';
const EPOCH_FILE = 'lib/appEpoch.js';
const VITE_FILE = 'vite.config.js';
const MARKER = 'GATI_CLEAR_RACK_LOCATION_VISUAL_V1';
const BUILD_VERSION = '2.0.98-gati-clear-rack-location-visual-v1';
const CACHE_GENERATION = 'v42-gati-rack-visual';

function replaceOnce(source, search, replacement, code) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(code);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function patchGati() {
  let source = fs.readFileSync(GATI_FILE, 'utf8');

  if (!source.includes(MARKER)) {
    const oldFormatter = `function formatConcreteReadyRack(row = {}) {\n  const slots = getConcreteReadySlots(row);\n  return slots.length ? slots.map((slot) => formatRackLocationLabel(slot)).join(', ') : '';\n}`;

    const newFormatter = `// ${MARKER}: group deep-room and main-rack locations for fast worker reading.\nfunction formatConcreteReadyRack(row = {}) {\n  const slots = getConcreteReadySlots(row);\n  if (!slots.length) return '';\n\n  const groups = {\n    FURRA_POSHT: [],\n    FURRA_NALT: [],\n    MAIN_A: [],\n    MAIN_B: [],\n  };\n\n  for (const rawSlot of slots) {\n    const slot = String(rawSlot || '').trim().toUpperCase();\n    let match = slot.match(/^FURRA_POSHT_A(\\d{1,2})$/);\n    if (match) {\n      groups.FURRA_POSHT.push(\`A\${Number(match[1])}\`);\n      continue;\n    }\n    match = slot.match(/^FURRA_NALT_A(\\d{1,2})$/);\n    if (match) {\n      groups.FURRA_NALT.push(\`A\${Number(match[1])}\`);\n      continue;\n    }\n    match = slot.match(/^A(\\d{1,2})$/);\n    if (match) {\n      groups.MAIN_A.push(\`A\${Number(match[1])}\`);\n      continue;\n    }\n    match = slot.match(/^B(\\d{1,2})$/);\n    if (match) groups.MAIN_B.push(\`B\${Number(match[1])}\`);\n  }\n\n  const sortSlots = (list) => Array.from(new Set(list)).sort((a, b) => {\n    const an = Number(String(a).replace(/\\D/g, '')) || 0;\n    const bn = Number(String(b).replace(/\\D/g, '')) || 0;\n    return an - bn;\n  });\n\n  const parts = [];\n  const posht = sortSlots(groups.FURRA_POSHT);\n  const nalt = sortSlots(groups.FURRA_NALT);\n  const main = sortSlots([...groups.MAIN_A, ...groups.MAIN_B]);\n  if (posht.length) parts.push(\`FURRA POSHT — \${posht.join(', ')}\`);\n  if (nalt.length) parts.push(\`FURRA NALT — \${nalt.join(', ')}\`);\n  if (main.length) parts.push(\`RAFTI KRYESOR — \${main.join(', ')}\`);\n\n  return parts.join('  •  ') || slots.map((slot) => formatRackLocationLabel(slot)).join(', ');\n}\n\nfunction getReadyRackVisual(row = {}) {\n  const concrete = formatConcreteReadyRack(row);\n  if (concrete) return { label: \`📍 \${concrete}\`, valid: true, warning: false };\n\n  const raw = String(\n    row?.ready_location\n      || row?.readyNote\n      || row?.ready_note\n      || row?.fullOrder?.ready_location\n      || row?.fullOrder?.ready_note\n      || ''\n  ).trim();\n  const plain = raw.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toUpperCase();\n  if (plain.includes('FURRA POSHT')) {\n    return { label: '📍 FURRA POSHT — PA NUMËR RAFI', valid: false, warning: true };\n  }\n  if (plain.includes('FURRA NALT') || plain.includes('FURRA LART')) {\n    return { label: '📍 FURRA NALT — PA NUMËR RAFI', valid: false, warning: true };\n  }\n  return { label: '📍 PA RAFT', valid: false, warning: true };\n}`;

    source = replaceOnce(source, oldFormatter, newFormatter, 'GATI_RACK_VISUAL_FORMATTER_ANCHOR_MISSING');

    const oldLogic = `            const concreteReadyRack = formatConcreteReadyRack(o);\n            const hasReadyRack = !!concreteReadyRack;\n            const readyLocationLabel = hasReadyRack ? \`📍 \${concreteReadyRack}\` : '📍 PA RAFT';`;
    const newLogic = `            const rackVisual = getReadyRackVisual(o);\n            const hasReadyRack = rackVisual.valid;\n            const readyLocationLabel = rackVisual.label;`;
    source = replaceOnce(source, oldLogic, newLogic, 'GATI_RACK_VISUAL_ROW_LOGIC_ANCHOR_MISSING');

    const oldButton = `                      {readyLocationLabel.slice(0, 48)}\n                      {!hasReadyRack ? <span style={{ marginLeft: 6, color: '#bfdbfe' }}>VENDOS RAFTIN</span> : null}`;
    const newButton = `                      <span style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.3 }}>\n                        {readyLocationLabel}\n                      </span>\n                      {!hasReadyRack ? <span style={{ display: 'inline-block', marginTop: 4, color: '#bfdbfe' }}>VENDOS RAFTIN KONKRET</span> : null}`;
    source = replaceOnce(source, oldButton, newButton, 'GATI_RACK_VISUAL_BUTTON_ANCHOR_MISSING');
  }

  if (!source.includes(MARKER)) throw new Error('GATI_RACK_VISUAL_MARKER_VERIFY_FAILED');
  if (!source.includes("parts.join('  •  ')")) throw new Error('GATI_RACK_VISUAL_GROUP_VERIFY_FAILED');
  if (source.includes('readyLocationLabel.slice(0, 48)')) throw new Error('GATI_RACK_VISUAL_TRUNCATION_REMAINS');
  fs.writeFileSync(GATI_FILE, source, 'utf8');
}

function patchBuildIdentity() {
  let epoch = fs.readFileSync(EPOCH_FILE, 'utf8');
  epoch = epoch.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${BUILD_VERSION}';`);
  fs.writeFileSync(EPOCH_FILE, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_FILE, 'utf8');
  index = index
    .replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${BUILD_VERSION}$2`)
    .replace(/window\.__TEPIHA_BUILD_ID\s*=\s*'[^']+';/, `window.__TEPIHA_BUILD_ID = '${BUILD_VERSION}';`);
  fs.writeFileSync(INDEX_FILE, index, 'utf8');

  let vite = fs.readFileSync(VITE_FILE, 'utf8');
  vite = vite
    .replace(/sw-navigation-diag\.js\?v=\d+/, 'sw-navigation-diag.js?v=3506')
    .replace(/tepiha-vite-business-routes-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-business-routes-${CACHE_GENERATION}`)
    .replace(/tepiha-vite-static-assets-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-static-assets-${CACHE_GENERATION}`)
    .replace(/tepiha-vite-media-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-media-${CACHE_GENERATION}`);
  fs.writeFileSync(VITE_FILE, vite, 'utf8');
}

patchGati();
patchBuildIdentity();
console.log('PASS: GATI rack locations are grouped by FURRA POSHT, FURRA NALT, and RAFTI KRYESOR without truncation.');
