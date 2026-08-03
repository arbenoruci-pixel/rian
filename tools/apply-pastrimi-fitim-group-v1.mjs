import fs from 'node:fs';

const file = 'lib/pastrimiWorkerGroupingBridge.js';
let source = fs.readFileSync(file, 'utf8');

if (source.includes("fitim: { label: 'FITIM'")) {
  console.log('[pastrimi-fitim-group-v1] already applied');
  process.exit(0);
}

const oldGroups = `const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  blerim: { label: 'BLERIM', order: 200 },
  tapin: { label: 'TAPIN', order: 300 },
  baza: { label: 'BAZA', order: 100 },
};`;
const newGroups = `const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  baza: { label: 'BAZA', order: 100 },
  fitim: { label: 'FITIM', order: 200 },
  blerim: { label: 'BLERIM', order: 300 },
  tapin: { label: 'TAPIN', order: 400 },
};`;
if (!source.includes(oldGroups)) throw new Error('FITIM_GROUPS_ANCHOR_NOT_FOUND');
source = source.replace(oldGroups, newGroups);

source = source.replace(
  'grid-template-columns: 1.18fr repeat(3, minmax(0, 1fr));',
  'grid-template-columns: 1.18fr repeat(4, minmax(0, 1fr));'
);

source = source.replace(
  `    #${'${TOOLBAR_ID}'} button[data-filter="blerim"] { color: #bae6fd; }`,
  `    #${'${TOOLBAR_ID}'} button[data-filter="fitim"] { color: #fde68a; }\n    #${'${TOOLBAR_ID}'} button[data-filter="blerim"] { color: #bae6fd; }`
);

source = source.replace(
  `    #${'${TOOLBAR_ID}'} button[data-active="1"][data-filter="blerim"] {`,
  `    #${'${TOOLBAR_ID}'} button[data-active="1"][data-filter="fitim"] {\n      background: rgba(180,83,9,.42); border-color: rgba(251,191,36,.92); color: #fff;\n    }\n    #${'${TOOLBAR_ID}'} button[data-active="1"][data-filter="blerim"] {`
);

const blerimCss = `    #root .list-item-compact[data-pastrimi-worker-group="blerim"] {
      border-left: 5px solid #38bdf8 !important;`;
const fitimCss = `    #root .list-item-compact[data-pastrimi-worker-group="fitim"] {
      border-left: 5px solid #fbbf24 !important;
      background: linear-gradient(90deg, rgba(180,83,9,.24), rgba(15,23,42,.36)) !important;
      box-shadow: inset 0 0 0 1px rgba(251,191,36,.16);
    }
    #root .list-item-compact[data-pastrimi-worker-group="fitim"]::before {
      content: 'FITIM'; color: #fef3c7; border: 1px solid rgba(251,191,36,.64); background: rgba(180,83,9,.46);
    }
`;
if (!source.includes(blerimCss)) throw new Error('FITIM_CARD_CSS_ANCHOR_NOT_FOUND');
source = source.replace(blerimCss, `${fitimCss}${blerimCss}`);

source = source.replace(
  `    #root .list-item-compact[data-pastrimi-worker-group="blerim"] > div:first-child > div:first-child > div:first-child {`,
  `    #root .list-item-compact[data-pastrimi-worker-group="fitim"] > div:first-child > div:first-child > div:first-child {\n      background: #b45309 !important;\n    }\n    #root .list-item-compact[data-pastrimi-worker-group="blerim"] > div:first-child > div:first-child > div:first-child {`
);

source = source.replace(
  `    if (broughtBy.includes('BLERIM') || broughtBy.includes('KOSUMI') || broughtBy.includes('BELI')) return 'blerim';`,
  `    if (broughtBy.includes('FITIM') || broughtBy.includes('ORUCI')) return 'fitim';\n    if (broughtBy.includes('BLERIM') || broughtBy.includes('KOSUMI') || broughtBy.includes('BELI')) return 'blerim';`
);

source = source.replace(
  `  const counts = { all: cards.length, blerim: 0, tapin: 0, baza: 0 };`,
  `  const counts = { all: cards.length, baza: 0, fitim: 0, blerim: 0, tapin: 0 };`
);

source = source.replace(
  `window.__TEPIHA_PASTRIMI_WORKER_GROUPING__ = { version: 'v2-fullscreen', scheduleApply };`,
  `window.__TEPIHA_PASTRIMI_WORKER_GROUPING__ = { version: 'v3-fitim-group', scheduleApply };`
);

fs.writeFileSync(file, source, 'utf8');
console.log('[pastrimi-fitim-group-v1] applied');
