import fs from 'node:fs';

const WIZARD_PATH = 'components/ArkaDailyCloseWizard.jsx';
const LAYOUT_PATH = 'app/arka/layout.jsx';
const SHORTCUT_PATH = 'components/ArkaDailyCloseShortcut.jsx';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const FAST_CLOSE_INSTALLER_PATH = 'tools/apply-pastrimi-payment-fast-close-v4.mjs';
const FAST_CLOSE_VERIFY_PATH = 'tools/verify-pastrimi-payment-fast-close-v4.mjs';
const ARKA_VERIFY_PATH = 'tools/verify-arka-daily-close-v2.mjs';

const MARKER = 'ARKA_DAILY_OPERATIONS_V3';
const INSTALLER = 'node tools/apply-arka-daily-operations-v3.mjs';
const TEST_COMMAND = 'npm run test:arka-daily-operations-v3';
const APP_VERSION = '2.0.123-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1';
const CACHE_VERSION = 'v49-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1-arka-daily-operations-v3-arka-salary-only-handoff-v1-canonical-staff-identity-v1-client-profile-v1-client-profile-smart-sms-v1-responsive-tcode-fit-v2-pranimi-client-edit-v1-pranimi-existing-client-repeat-save-v1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function patchWizard() {
  let source = fs.readFileSync(WIZARD_PATH, 'utf8');

  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      "const TIME_ZONE = 'Europe/Belgrade';\nconst PREVIEW_RPC = 'get_arka_daily_close_preview_v3';",
      "const TIME_ZONE = 'Europe/Belgrade';\nconst BUSINESS_DAY_CUTOFF_HOUR = 4; // ARKA_DAILY_OPERATIONS_V3\nconst PREVIEW_RPC = 'get_arka_daily_close_preview_v4';",
      'preview v4 and operational cutoff',
    );

    source = replaceOnce(
      source,
      "function money(value) {\n  return `€${MONEY.format(n(value))}`;\n}\n",
      "function money(value) {\n  return `€${MONEY.format(n(value))}`;\n}\n\nfunction m2(value) {\n  return `${MONEY.format(n(value))} m²`;\n}\n",
      'm2 formatter',
    );

    source = replaceOnce(
      source,
      "    const d = value instanceof Date ? value : new Date(value || Date.now());\n    const parts = new Intl.DateTimeFormat('en-CA', {",
      "    const rawDate = value instanceof Date ? value : new Date(value || Date.now());\n    const d = new Date(rawDate.getTime() - BUSINESS_DAY_CUTOFF_HOUR * 60 * 60 * 1000);\n    const parts = new Intl.DateTimeFormat('en-CA', {",
      'operational day key',
    );

    source = replaceOnce(
      source,
      '  const expenseMutationLockRef = useRef(false);',
      '  const expenseMutationLockRef = useRef(false);\n  const countedCashManualRef = useRef(false);',
      'manual counted cash ref',
    );

    source = replaceOnce(
      source,
      '  const pendingExpenseCount = n(preview?.pending_expenses_count ?? pendingExpenses.length);',
      `  const pendingExpenseCount = n(preview?.pending_expenses_count ?? pendingExpenses.length);
  const dailyOperations = obj(preview?.operations);
  const dailyIncoming = obj(dailyOperations?.incoming);
  const dailyOutgoing = obj(dailyOperations?.outgoing);
  const dailyCurrent = obj(dailyOperations?.current);
  const dailyIncomingM2 = n(dailyIncoming?.total?.m2);
  const dailyOutgoingM2 = n(dailyOutgoing?.total?.m2);
  const dailyNetM2 = n(dailyOperations?.net_m2);
  const dailyPastrimM2 = n(dailyCurrent?.pastrim?.m2);
  const dailyGatiM2 = n(dailyCurrent?.gati?.m2);

  useEffect(() => {
    if (!preview || isClosed || countedCashManualRef.current) return;
    const automaticValue = expectedCash.toFixed(2);
    setCountedCash((current) => current === automaticValue ? current : automaticValue);
  }, [expectedCash, isClosed, preview?.generated_at]);`,
      'daily operations and automatic cash',
    );

    source = replaceOnce(
      source,
      `  function toggleSelected(id) {
    const value = Number(id);`,
      `  function toggleSelected(id) {
    countedCashManualRef.current = false;
    setCountedCash('');
    const value = Number(id);`,
      'selected handoff automatic recalc',
    );

    source = replaceOnce(
      source,
      `    setError('');
    setStep(3);
  }

  async function resolvePendingExpense`,
      `    setError('');
    countedCashManualRef.current = false;
    setCountedCash(expectedCash.toFixed(2));
    setStep(3);
  }

  async function resolvePendingExpense`,
      'step three automatic value',
    );

    source = source.replaceAll(
      "    setCountedCash('');",
      "    countedCashManualRef.current = false;\n    setCountedCash('');",
    );
    // The toggleSelected patch already placed the reset immediately before its clear.
    source = source.replace(
      "    countedCashManualRef.current = false;\n    countedCashManualRef.current = false;\n    setCountedCash('');",
      "    countedCashManualRef.current = false;\n    setCountedCash('');",
    );

    source = replaceOnce(
      source,
      "{formatDate(date)} • {upper(actor?.name || actor?.pin || 'PA LOGIN')}",
      "{formatDate(date)} • DITA OPERATIVE 04:00–04:00 • {upper(actor?.name || actor?.pin || 'PA LOGIN')}",
      'operational date header',
    );

    source = replaceOnce(
      source,
      `        {loading && !preview ? <Card tone="info"><div style={{ textAlign: 'center', padding: 22, color: palette.info, fontWeight: 1000 }}>DUKE NGARKUAR KONTROLLIN E ARKËS...</div></Card> : null}

        {activeReceiptCycle?.is_closed ? (`,
      `        {loading && !preview ? <Card tone="info"><div style={{ textAlign: 'center', padding: 22, color: palette.info, fontWeight: 1000 }}>DUKE NGARKUAR KONTROLLIN E ARKËS...</div></Card> : null}

        {preview ? (
          <Card tone="info">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: palette.info, fontSize: 10.5, fontWeight: 1000, letterSpacing: '.10em' }}>PASQYRA E DITËS</div>
                <div style={{ marginTop: 5, fontSize: 15, fontWeight: 1000 }}>HYRJE / DALJE • 04:00–04:00</div>
              </div>
              <div style={{ color: palette.muted, fontSize: 10.5, fontWeight: 800 }}>{formatDate(date)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(135px,1fr))', gap: 8 }}>
              <Metric label="m² HYRË SOT" value={m2(dailyIncomingM2)} tone="ok" sub={\`BAZA \${m2(dailyIncoming?.base?.m2)} • TRANSPORT \${m2(dailyIncoming?.transport?.m2)}\`} />
              <Metric label="m² DALË SOT" value={m2(dailyOutgoingM2)} tone="bad" sub={\`BAZA \${m2(dailyOutgoing?.base?.m2)} • TRANSPORT \${m2(dailyOutgoing?.transport?.m2)}\`} />
              <Metric label="NETO m²" value={m2(dailyNetM2)} tone={dailyNetM2 < 0 ? 'bad' : 'info'} sub="Hyrë minus dalë" />
              <Metric label="NË PASTRIM" value={m2(dailyPastrimM2)} tone="warn" sub={\`\${n(dailyCurrent?.pastrim?.count)} porosi\`} />
              <Metric label="GATI" value={m2(dailyGatiM2)} tone="ok" sub={\`\${n(dailyCurrent?.gati?.count)} porosi\`} />
            </div>
          </Card>
        ) : null}

        {activeReceiptCycle?.is_closed ? (`,
      'daily m2 overview card',
    );

    source = replaceOnce(
      source,
      '<span style={{ fontSize: 11, fontWeight: 1000, color: palette.info }}>SA PARA I NUMËROVE FIZIKISHT?</span>',
      '<span style={{ fontSize: 11, fontWeight: 1000, color: palette.info }}>SHUMA U VENDOS AUTOMATIKISHT — NDRYSHOJE VETËM NËSE CASH-I FIZIK NUK PËRPUTHET</span>',
      'automatic cash label',
    );

    source = replaceOnce(
      source,
      'onChange={(event) => { setCountedCash(event.target.value); setDryRun(null); setFinalConfirm(false); }}',
      'onChange={(event) => { countedCashManualRef.current = true; setCountedCash(event.target.value); setDryRun(null); setFinalConfirm(false); }}',
      'manual cash override',
    );

    source = replaceOnce(
      source,
      '                      placeholder="0.00"\n                      style={{ width: \'100%\', boxSizing: \'border-box\', border: \'1px solid rgba(96,165,250,.48)\'',
      '                      placeholder={expectedCash.toFixed(2)}\n                      style={{ width: \'100%\', boxSizing: \'border-box\', border: \'1px solid rgba(96,165,250,.48)\'',
      'automatic cash placeholder',
    );
  }

  const required = [
    MARKER,
    "const PREVIEW_RPC = 'get_arka_daily_close_preview_v4'",
    'BUSINESS_DAY_CUTOFF_HOUR * 60 * 60 * 1000',
    'm² HYRË SOT',
    'm² DALË SOT',
    'countedCashManualRef.current = true',
    'setCountedCash(expectedCash.toFixed(2))',
  ];
  for (const token of required) {
    if (!source.includes(token)) throw new Error(`WIZARD_PATCH_MISSING:${token}`);
  }
  fs.writeFileSync(WIZARD_PATH, source, 'utf8');
}

function patchShortcutAndLayout() {
  if (!fs.existsSync(SHORTCUT_PATH)) throw new Error('ARKA_DAILY_CLOSE_SHORTCUT_FILE_MISSING');
  let layout = fs.readFileSync(LAYOUT_PATH, 'utf8');
  if (!layout.includes('ArkaDailyCloseShortcut')) {
    layout = replaceOnce(
      layout,
      "import './arka.css';",
      "import './arka.css';\nimport ArkaDailyCloseShortcut from '@/components/ArkaDailyCloseShortcut.jsx';",
      'layout shortcut import',
    );
    layout = replaceOnce(layout, '        {children}', '        {children}\n        <ArkaDailyCloseShortcut />', 'layout shortcut render');
  }
  if (!layout.includes('<ArkaDailyCloseShortcut />')) throw new Error('ARKA_SHORTCUT_NOT_RENDERED');
  fs.writeFileSync(LAYOUT_PATH, layout, 'utf8');
}

function patchArkaVerifierCompatibility() {
  let source = fs.readFileSync(ARKA_VERIFY_PATH, 'utf8');
  const oldCheck = `check(component.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v3'"), 'daily preview RPC missing');`;
  const newCheck = `check(component.includes("const PREVIEW_RPC = 'get_arka_daily_close_preview_v4'"), 'daily preview V4 RPC missing');`;
  if (!source.includes(newCheck)) source = replaceOnce(source, oldCheck, newCheck, 'ARKA verifier preview V4');
  fs.writeFileSync(ARKA_VERIFY_PATH, source, 'utf8');
}

function patchFastCloseCompatibility() {
  let source = fs.readFileSync(FAST_CLOSE_INSTALLER_PATH, 'utf8');
  const oldBlock = `  const compatibleGatiFinalOrder =
    gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')
    || gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer');`;
  const newBlock = `  const compatibleGatiFinalOrder =
    gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')
    || gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer')
    || gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, arkaDailyOperationsV3Installer, installer');`;
  if (!source.includes('arkaDailyOperationsV3Installer, installer')) {
    source = replaceOnce(source, oldBlock, newBlock, 'fast-close new final-owner chain');
  }
  fs.writeFileSync(FAST_CLOSE_INSTALLER_PATH, source, 'utf8');

  source = fs.readFileSync(FAST_CLOSE_VERIFY_PATH, 'utf8');
  const oldVerify = `  gatiInstaller.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')
    || gatiInstaller.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer'),`;
  const newVerify = `  gatiInstaller.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')
    || gatiInstaller.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer')
    || gatiInstaller.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, arkaDailyOperationsV3Installer, installer'),`;
  if (!source.includes('arkaDailyOperationsV3Installer, installer')) {
    source = replaceOnce(source, oldVerify, newVerify, 'fast-close verifier new final-owner chain');
  }
  fs.writeFileSync(FAST_CLOSE_VERIFY_PATH, source, 'utf8');
}

function patchGatiFinalOwner() {
  let source = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`)
    .replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3513');

  const homeDecl = "  const homeSearchLocalOidDedupeV1Installer = 'node tools/apply-home-search-local-oid-dedupe-v1.mjs';";
  const opsDecl = "  const arkaDailyOperationsV3Installer = 'node tools/apply-arka-daily-operations-v3.mjs';";
  if (!source.includes(opsDecl)) {
    source = replaceOnce(source, homeDecl, `${homeDecl}\n${opsDecl}`, 'GATI operations installer declaration');
  }

  const oldFilter = '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer && item !== homeSearchLocalOidDedupeV1Installer);';
  const newFilter = '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer && item !== homeSearchLocalOidDedupeV1Installer && item !== arkaDailyOperationsV3Installer);';
  if (!source.includes(newFilter)) source = replaceOnce(source, oldFilter, newFilter, 'GATI operations installer filter');

  const oldPush = 'pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer);';
  const newPush = 'pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, arkaDailyOperationsV3Installer, installer);';
  if (!source.includes(newPush)) source = replaceOnce(source, oldPush, newPush, 'GATI operations installer ordering');

  fs.writeFileSync(GATI_INSTALLER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gati = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = pre.lastIndexOf(gati);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER, gati);
  scripts.prebuild = pre.join(' && ');
  scripts['test:arka-daily-operations-v3'] = 'node tools/verify-arka-daily-operations-v3.mjs';

  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function patchBuildIdentity() {
  let vite = fs.readFileSync(VITE_PATH, 'utf8');
  vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3513');
  vite = vite.replace(/tepiha-vite-business-routes-[^']+/g, `tepiha-vite-business-routes-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-static-assets-[^']+/g, `tepiha-vite-static-assets-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-media-[^']+/g, `tepiha-vite-media-${CACHE_VERSION}`);
  fs.writeFileSync(VITE_PATH, vite, 'utf8');

  let epoch = fs.readFileSync(EPOCH_PATH, 'utf8');
  if (/export const ARKA_DAILY_OPERATIONS_BUILD = '[^']+';/.test(epoch)) {
    epoch = epoch.replace(/export const ARKA_DAILY_OPERATIONS_BUILD = '[^']+';/, `export const ARKA_DAILY_OPERATIONS_BUILD = '${APP_VERSION}';`);
  } else {
    epoch += `\nexport const ARKA_DAILY_OPERATIONS_BUILD = '${APP_VERSION}';\n`;
  }
  fs.writeFileSync(EPOCH_PATH, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  index = index.replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${APP_VERSION}$2`);
  index = index.replace(/window\.__TEPIHA_BUILD_ID = '[^']+';/, `window.__TEPIHA_BUILD_ID = '${APP_VERSION}';`);
  fs.writeFileSync(INDEX_PATH, index, 'utf8');
}

patchWizard();
patchShortcutAndLayout();
patchArkaVerifierCompatibility();
patchFastCloseCompatibility();
patchGatiFinalOwner();
patchPackage();
patchBuildIdentity();
console.log('PASS ARKA daily operations V3: 04:00 operational day, m² overview, persistent wizard entry and automatic cash value.');
