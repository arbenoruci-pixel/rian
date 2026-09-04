import fs from 'node:fs';

const COMPONENT_PATH = 'components/ArkaDailyCloseWizard.jsx';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const INSTALLER = 'node tools/apply-arka-reopenable-daily-wizard-v1.mjs';
const TEST_COMMAND = 'npm run test:arka-reopenable-daily-wizard-v1';
const TAG = 'arka-reopenable-daily-wizard-v1';
const MARKER = 'ARKA_REOPENABLE_DAILY_WIZARD_V1';

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  const first = source.indexOf(oldValue);
  if (first < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  if (source.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`${label}_ANCHOR_NOT_UNIQUE`);
  }
  return `${source.slice(0, first)}${newValue}${source.slice(first + oldValue.length)}`;
}

function appendTag(value, tag = TAG) {
  const clean = String(value || '').trim();
  if (!clean) return tag;
  return clean.includes(tag) ? clean : `${clean}-${tag}`;
}

function patchWizard() {
  let source = fs.readFileSync(COMPONENT_PATH, 'utf8');

  source = replaceOnce(
    source,
    `  const pendingExpenseCount = n(preview?.pending_expenses_count ?? pendingExpenses.length);\n  const dailyOperations = obj(preview?.operations);`,
    `  const pendingExpenseCount = n(preview?.pending_expenses_count ?? pendingExpenses.length);\n  // ${MARKER}: a prior final report never hides later worker handoffs or cash movements.\n  const openCashAtWorkers = rows(preview?.open_cash_at_workers);\n  const receivedTodayTotal = +receivedToday.reduce((sum, row) => sum + n(row?.amount), 0).toFixed(2);\n  const hasUnreflectedClosedTotals = isClosed && (\n    Math.abs(receivedTodayTotal - n(closedCycle?.accepted_handoffs_total)) > 0.01\n    || Math.abs(n(preview?.today_expenses?.total) - n(closedCycle?.posted_expenses_total)) > 0.01\n    || Math.abs(n(preview?.today_advances?.total) - n(closedCycle?.posted_advances_total)) > 0.01\n  );\n  const hasLiveWizardWork = pendingHandoffs.length > 0\n    || pendingExpenseCount > 0\n    || openCashAtWorkers.length > 0\n    || hasUnreflectedClosedTotals;\n  const showClosedReceiptOnly = isClosed && !hasLiveWizardWork;\n  const dailyOperations = obj(preview?.operations);`,
    'LIVE_WORK_FLAGS',
  );

  source = replaceOnce(
    source,
    `  useEffect(() => {\n    if (!preview || isClosed || countedCashManualRef.current) return;\n    const automaticValue = expectedCash.toFixed(2);\n    setCountedCash((current) => current === automaticValue ? current : automaticValue);\n  }, [expectedCash, isClosed, preview?.generated_at]);`,
    `  useEffect(() => {\n    if (!preview || showClosedReceiptOnly || countedCashManualRef.current) return;\n    const automaticValue = expectedCash.toFixed(2);\n    setCountedCash((current) => current === automaticValue ? current : automaticValue);\n  }, [expectedCash, showClosedReceiptOnly, preview?.generated_at]);`,
    'AUTOMATIC_COUNT_REOPEN',
  );

  source = replaceOnce(
    source,
    `      if (!initializedRef.current && !obj(next?.closed_cycle)?.is_closed) {`,
    `      if (!initializedRef.current) {`,
    'INITIAL_SELECTION_REOPEN',
  );

  source = replaceOnce(
    source,
    `        {activeReceiptCycle?.is_closed ? (\n          <Receipt cycle={activeReceiptCycle} items={activeReceiptItems} onRefresh={() => void loadPreview({ force: true })} />\n        ) : preview ? (`,
    `        {showClosedReceiptOnly ? (\n          <Receipt cycle={activeReceiptCycle} items={activeReceiptItems} onRefresh={() => void loadPreview({ force: true })} />\n        ) : preview ? (`,
    'RECEIPT_GATE_REOPEN',
  );

  source = replaceOnce(
    source,
    `        ) : preview ? (\n          <>\n            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6 }}>`,
    `        ) : preview ? (\n          <>\n            {isClosed && hasLiveWizardWork ? (\n              <Alert tone="warn">\n                RAPORTI I DITËS ËSHTË FINALIZUAR MË HERËT, POR KA DORËZIME OSE DALJE TË REJA. WIZARD-I ËSHTË RIHAPUR; PRANOJI DHE FINALIZOJE RAPORTIN PËRSËRI.\n              </Alert>\n            ) : null}\n            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6 }}>`,
    'REOPEN_WARNING',
  );

  if (!source.includes(MARKER)) throw new Error('REOPENABLE_WIZARD_MARKER_MISSING');
  if (source.includes('if (!initializedRef.current && !obj(next?.closed_cycle)?.is_closed)')) {
    throw new Error('CLOSED_CYCLE_INITIALIZATION_GUARD_REMAINS');
  }
  if (source.includes('{activeReceiptCycle?.is_closed ? (')) {
    throw new Error('CLOSED_RECEIPT_GATE_REMAINS');
  }
  if (!source.includes('showClosedReceiptOnly ? (')) throw new Error('LIVE_WIZARD_GATE_MISSING');

  fs.writeFileSync(COMPONENT_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = appendTag(pkg.version);
  const scripts = pkg.scripts || (pkg.scripts = {});

  const prebuildParts = String(scripts.prebuild || '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== INSTALLER);
  const finalVersionOwner = 'node tools/apply-gati-rack-save-v1.mjs';
  const finalOwnerIndex = prebuildParts.lastIndexOf(finalVersionOwner);
  if (finalOwnerIndex >= 0) prebuildParts.splice(finalOwnerIndex, 0, INSTALLER);
  else prebuildParts.push(INSTALLER);
  scripts.prebuild = prebuildParts.join(' && ');

  scripts['test:arka-reopenable-daily-wizard-v1'] = 'node tools/verify-arka-reopenable-daily-wizard-v1.mjs';

  const buildParts = String(scripts.build || '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== TEST_COMMAND);
  const viteIndex = buildParts.findIndex((part) => part === 'vite build');
  if (viteIndex < 0) throw new Error('VITE_BUILD_COMMAND_NOT_FOUND');
  buildParts.splice(viteIndex, 0, TEST_COMMAND);
  scripts.build = buildParts.join(' && ');

  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return pkg.version;
}

function patchViteBuildIdentity() {
  let source = fs.readFileSync(VITE_PATH, 'utf8');
  source = source.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3512');
  source = source.replace(/tepiha-vite-(?:business-routes|static-assets|media)-[A-Za-z0-9._-]+/g, (value) => appendTag(value));
  fs.writeFileSync(VITE_PATH, source, 'utf8');
}

function patchEpoch(buildId) {
  let source = fs.readFileSync(EPOCH_PATH, 'utf8');
  const line = `export const ARKA_REOPENABLE_DAILY_WIZARD_BUILD = '${buildId}';`;
  if (/export const ARKA_REOPENABLE_DAILY_WIZARD_BUILD = '[^']*';/.test(source)) {
    source = source.replace(/export const ARKA_REOPENABLE_DAILY_WIZARD_BUILD = '[^']*';/, line);
  } else {
    source = `${source.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(EPOCH_PATH, source, 'utf8');
}

function patchIndex() {
  let source = fs.readFileSync(INDEX_PATH, 'utf8');
  source = source.replace(/(<meta name="tepiha-build-id" content=")([^"]+)(" \/>)/, (_match, start, value, end) => `${start}${appendTag(value)}${end}`);
  source = source.replace(/(window\.__TEPIHA_BUILD_ID = ')([^']+)(';)/, (_match, start, value, end) => `${start}${appendTag(value)}${end}`);
  fs.writeFileSync(INDEX_PATH, source, 'utf8');
}

patchWizard();
const buildId = patchPackage();
patchViteBuildIdentity();
patchEpoch(buildId);
patchIndex();
console.log(`PASS ${MARKER}: closed reports no longer hide later handoffs; installer runs immediately before the compatible final version owner.`);
