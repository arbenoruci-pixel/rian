import fs from 'node:fs';

const PAGE_PATH = 'app/arka/page.jsx';
const MARKER = 'ARKA_WORKER_DAILY_STATUS_V1:PAGE';
const COMPONENT_IMPORT = "import ArkaWorkerDailyStatus from '@/components/ArkaWorkerDailyStatus';";

let source = fs.readFileSync(PAGE_PATH, 'utf8');

if (!source.includes(MARKER)) {
  const preferredImportAnchor = "import ArkaExpenseComposer from '@/components/ArkaExpenseComposer';";
  const fallbackImportAnchor = "import ReadyBonusLiveCard from '@/components/ReadyBonusLiveCard';";
  const importAnchor = source.includes(preferredImportAnchor) ? preferredImportAnchor : fallbackImportAnchor;
  if (!source.includes(importAnchor)) throw new Error('ARKA_DAILY_STATUS_IMPORT_ANCHOR_NOT_FOUND');
  if (!source.includes(COMPONENT_IMPORT)) {
    source = source.replace(importAnchor, `${importAnchor}\n${COMPONENT_IMPORT}`);
  }

  const workerStart = source.indexOf("      {!loading && actor?.pin && isWorker && !canManage && workerSnapshot ? (");
  if (workerStart < 0) throw new Error('ARKA_DAILY_STATUS_WORKER_VIEW_NOT_FOUND');

  const readyBonusAnchor = '          <ReadyBonusLiveCard actor={actor} />';
  const readyBonusIndex = source.indexOf(readyBonusAnchor, workerStart);
  if (readyBonusIndex < 0) throw new Error('ARKA_DAILY_STATUS_READY_BONUS_ANCHOR_NOT_FOUND');

  const insertion = [
    `          {/* ${MARKER} */}`,
    '          <ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} />',
    '',
  ].join('\n');

  source = `${source.slice(0, readyBonusIndex)}${insertion}${source.slice(readyBonusIndex)}`;
  fs.writeFileSync(PAGE_PATH, source, 'utf8');
  console.log('PATCH ARKA worker daily status card');
}

const after = fs.readFileSync(PAGE_PATH, 'utf8');
const required = [
  COMPONENT_IMPORT,
  MARKER,
  '<ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} />',
  '<ReadyBonusLiveCard actor={actor} />',
  'DORËZO TE DISPATCH',
];
for (const token of required) {
  if (!after.includes(token)) throw new Error(`ARKA_DAILY_STATUS_VERIFY_MISSING:${token}`);
}

const componentCount = after.split('<ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} />').length - 1;
if (componentCount !== 1) throw new Error(`ARKA_DAILY_STATUS_EXPECTED_ONE_CARD_FOUND:${componentCount}`);

console.log('PASS ARKA worker daily status remains visible after expenses are approved');
