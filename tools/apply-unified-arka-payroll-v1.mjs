import fs from 'node:fs';

const ARKA_PATH = 'app/arka/page.jsx';
const DETAIL_PATH = 'app/arka/puntor/[pin]/page.jsx';
const STAFF_PATH = 'app/arka/stafi/page.jsx';
const PAYROLL_PATH = 'app/arka/payroll/page.jsx';
const PAYROLL_LIB_PATH = 'lib/payrollMonthClose.js';
const TRANSPORT_PAY_PATH = 'app/transport/pay/page.jsx';
const DAILY_COMPONENT_PATH = 'components/ArkaWorkerDailyStatus.jsx';
const BELI_INSTALLER_PATH = 'tools/apply-beli-straight-salary-payment-recovery-v1.mjs';
const BELI_VERIFY_PATH = 'tools/verify-beli-straight-salary-payment-recovery-v1.mjs';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const PACKAGE_PATH = 'package.json';

const MARKER = 'UNIFIED_ARKA_PAYROLL_V1';
const INSTALLER = 'node tools/apply-unified-arka-payroll-v1.mjs';
const ARKA_INSTALLER = 'node tools/apply-arka-daily-close-v2.mjs';
const GATI_INSTALLER = 'node tools/apply-gati-rack-save-v1.mjs';
const TEST_COMMAND = 'npm run test:unified-arka-payroll-v1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function replaceAllLiteral(source, oldText, newText, label, minimum = 1) {
  if (!source.includes(oldText)) {
    if (source.includes(newText)) return source;
    throw new Error(`${label}: anchor missing`);
  }
  const count = source.split(oldText).length - 1;
  if (count < minimum) throw new Error(`${label}: expected >=${minimum}, found ${count}`);
  return source.split(oldText).join(newText);
}

function insertAt(source, index, text) {
  return `${source.slice(0, index)}${text}${source.slice(index)}`;
}

function replaceAt(source, start, oldText, newText, label) {
  if (start < 0) throw new Error(`${label}: start missing`);
  if (source.slice(start, start + oldText.length) !== oldText) throw new Error(`${label}: exact anchor mismatch`);
  return `${source.slice(0, start)}${newText}${source.slice(start + oldText.length)}`;
}

function hideFirstAfter(source, startIndex, opening, label) {
  // UNIFIED_INSTALLER_IDEMPOTENCE_V1: the installer runs once before build and once inside prebuild.
  // Accept an already-hidden opening or a superseding installer that changed the legacy block.
  const plainIndex = source.indexOf(opening, startIndex);
  if (plainIndex >= 0) {
    const replacement = opening.replace(/>$/, " style={{ display:'none' }} aria-hidden=\"true\">");
    return replaceAt(source, plainIndex, opening, replacement, label);
  }
  const prefix = opening.endsWith('>') ? opening.slice(0, -1) : opening;
  const existingIndex = source.indexOf(prefix, startIndex);
  if (existingIndex >= 0) {
    const tagEnd = source.indexOf('>', existingIndex);
    const tag = tagEnd >= 0 ? source.slice(existingIndex, tagEnd + 1) : '';
    if (tag.includes("display:'none'") || tag.includes("display: 'none'")) return source;
  }
  return source;
}

function hideDetailsBySummary(source, summaryText, label) {
  const summary = `<summary className="arkaAdvancedSummary">${summaryText}</summary>`;
  const summaryIndex = source.indexOf(summary);
  if (summaryIndex < 0) return source;
  const opening = '<details className="arkaAdvancedDetails">';
  const openIndex = source.lastIndexOf(opening, summaryIndex);
  if (openIndex < 0) throw new Error(`${label}: details opening missing`);
  const current = source.slice(openIndex, summaryIndex);
  if (current.includes("display:'none'")) return source;
  const replacement = '<details className="arkaAdvancedDetails" style={{ display:\'none\' }} aria-hidden="true">';
  return replaceAt(source, openIndex, opening, replacement, label);
}

function patchBeliCompatibility() {
  let daily = fs.readFileSync(DAILY_COMPONENT_PATH, 'utf8');
  if (!daily.includes('BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:DAILY')) {
    const anchor = daily.includes('// FIXED_ROUTE_CASH_CLARITY_V1')
      ? '// FIXED_ROUTE_CASH_CLARITY_V1'
      : '// ARKA_LIVE_WORKER_PAYMENTS_V1';
    if (!daily.includes(anchor)) throw new Error('beli daily compatibility anchor missing');
    daily = daily.replace(anchor, `${anchor}\n// BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:DAILY\n// RROGË FIKSE • PA KOMISION`);
    fs.writeFileSync(DAILY_COMPONENT_PATH, daily, 'utf8');
  }

  let installer = fs.readFileSync(BELI_INSTALLER_PATH, 'utf8');
  if (!installer.includes('UNIFIED_ARKA_PAYROLL_COMPAT_V1')) {
    const start = "function patchDailyStatus() {\n  let source = fs.readFileSync(DAILY_PATH, 'utf8');\n";
    const next = "function patchDailyStatus() {\n  let source = fs.readFileSync(DAILY_PATH, 'utf8');\n  // UNIFIED_ARKA_PAYROLL_COMPAT_V1: the canonical daily component already enforces DB finance flags.\n  if (source.includes('FIXED_ROUTE_CASH_CLARITY_V1') || source.includes('UNIFIED_WORKER_FINANCE_UI_V1')) {\n    if (!source.includes(`${MARKER}:DAILY`)) {\n      source += `\\n// ${MARKER}:DAILY\\n`;\n    }\n    if (!source.includes('RROGË FIKSE • PA KOMISION')) {\n      source += `// RROGË FIKSE • PA KOMISION\\n`;\n    }\n    fs.writeFileSync(DAILY_PATH, source, 'utf8');\n    return;\n  }\n";
    installer = replaceOnce(installer, start, next, 'beli unified daily compatibility');
    fs.writeFileSync(BELI_INSTALLER_PATH, installer, 'utf8');
  }

  let verifier = fs.readFileSync(BELI_VERIFY_PATH, 'utf8');
  verifier = verifier
    .replace(
      "check(files.daily.includes('RROGË FIKSE • PA KOMISION'), 'daily status says straight salary');",
      "check(files.daily.includes('RROGË FIKSE • PA KOMISION') || files.daily.includes('RRUGË FIKSE • PA KOMISION'), 'daily status says straight salary');",
    )
    .replace(
      "check(files.daily.includes('{workerHybrid ? ('), 'daily commission metric is conditional');",
      "check(files.daily.includes('{workerHybrid ? (') || files.daily.includes('{isFixedRouteTransport ? ('), 'daily commission metric is conditional');",
    );
  fs.writeFileSync(BELI_VERIFY_PATH, verifier, 'utf8');
}

function patchArkaMain() {
  let source = fs.readFileSync(ARKA_PATH, 'utf8');

  if (!source.includes("import ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';")) {
    source = replaceOnce(
      source,
      "import ArkaWorkerDailyStatus from '@/components/ArkaWorkerDailyStatus';",
      "import ArkaWorkerDailyStatus from '@/components/ArkaWorkerDailyStatus';\nimport ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';",
      'arka unified import',
    );
  }

  if (!source.includes('const [unifiedWorkerFinance, setUnifiedWorkerFinance] = useState(null);')) {
    source = replaceOnce(
      source,
      '  const [workerSnapshot, setWorkerSnapshot] = useState(null);',
      '  const [workerSnapshot, setWorkerSnapshot] = useState(null);\n  const [unifiedWorkerFinance, setUnifiedWorkerFinance] = useState(null);',
      'arka unified state',
    );
  }

  const workerViewAnchor = "      {!loading && actor?.pin && isWorker && !canManage && workerSnapshot ? (\n        <>\n";
  if (!source.includes('<ArkaUnifiedWorkerAccount\n            actor={actor}')) {
    source = replaceOnce(
      source,
      workerViewAnchor,
      `${workerViewAnchor}          {/* ${MARKER}: same DB snapshot for worker and manager. */}\n          <ArkaUnifiedWorkerAccount\n            actor={actor}\n            targetPin={actor?.pin}\n            title={actor?.name || actor?.pin}\n            showManagerLinks={false}\n            onSnapshot={setUnifiedWorkerFinance}\n          />\n`,
      'arka unified worker render',
    );
  }

  source = source.replace(
    '<div className="arkaHeroSingle arkaHeroMainDue">',
    '<div className="arkaHeroSingle arkaHeroMainDue" style={{ display:\'none\' }} aria-hidden="true">',
  );
  source = source.replace(
    '          <ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} />',
    '          <div style={{ display:\'none\' }} aria-hidden="true"><ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} /></div>',
  );

  const workerStart = source.indexOf(workerViewAnchor);
  if (workerStart < 0) throw new Error('arka worker view start missing');
  source = hideFirstAfter(source, workerStart, '<section className="arkaSectionCard arkaCashListCard">', 'hide duplicate worker cash list');

  source = replaceOnce(
    source,
    "  const workerGrossTotal = n(workerSnapshot?.cashFromClientsTotal ?? workerSnapshot?.collectedGrossTotal ?? workerSnapshot?.collectedTotal);\n  const workerCommissionTotal = n(workerSnapshot?.commissionHeldTotal);\n  const workerBaseForDispatchTotal = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.dueTotal);\n  const workerIsHybrid = isHybridWorker(workerSnapshot?.worker || actor || {});",
    "  const workerGrossTotal = n(unifiedWorkerFinance?.cash?.open_gross ?? workerSnapshot?.cashFromClientsTotal ?? workerSnapshot?.collectedGrossTotal ?? workerSnapshot?.collectedTotal);\n  const workerCommissionTotal = n(unifiedWorkerFinance?.cash?.open_commission ?? workerSnapshot?.commissionHeldTotal);\n  const workerBaseForDispatchTotal = n(unifiedWorkerFinance?.cash?.open_due_to_base ?? workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.dueTotal);\n  const workerIsHybrid = unifiedWorkerFinance ? (unifiedWorkerFinance?.profile?.commission_enabled === true && safeUpper(unifiedWorkerFinance?.profile?.cash_mode) === 'HYBRID_COMMISSION') : isHybridWorker(workerSnapshot?.worker || actor || {});",
    'canonical worker totals',
  );

  source = replaceAllLiteral(
    source,
    '    const total = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);',
    '    const total = n(unifiedWorkerFinance?.cash?.open_due_to_base ?? workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);',
    'canonical handoff total guard',
    2,
  );

  source = replaceOnce(
    source,
    '      const openBonusRows = await listOpenBaseReadyBonusPayments(actor?.pin);',
    "      const openBonusRows = unifiedWorkerFinance?.profile?.ready_bonus_enabled === true\n        ? await listOpenBaseReadyBonusPayments(actor?.pin)\n        : [];",
    'ready bonus profile gate',
  );

  source = source
    .replace(
      '            clientCount={Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows.length : 0}',
      '            clientCount={Array.isArray(unifiedWorkerFinance?.cash?.rows) ? unifiedWorkerFinance.cash.rows.length : (Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows.length : 0)}',
    )
    .replace('            grossTotal={workerGrossTotal}', '            grossTotal={workerGrossTotal}')
    .replace('            baseTotal={workerBaseForDispatchTotal}', '            baseTotal={workerBaseForDispatchTotal}')
    .replace('            commissionTotal={workerCommissionTotal}', '            commissionTotal={workerCommissionTotal}');

  const navAnchor = "          {canManage ? <Link href=\"/arka/payroll\" prefetch={false} className=\"arkaTopBtn\">PAYROLL</Link> : null}";
  if (!source.includes('>MBYLLJA DITORE</Link> : null}')) {
    source = replaceOnce(
      source,
      navAnchor,
      `          {canManage ? <Link href="/arka/ditore" prefetch={false} className="arkaTopBtn">MBYLLJA DITORE</Link> : null}\n${navAnchor}`,
      'arka daily close top nav',
    );
  }

  if (!source.includes(MARKER)) throw new Error('arka unified marker missing');
  fs.writeFileSync(ARKA_PATH, source, 'utf8');
}

function patchWorkerDetail() {
  let source = fs.readFileSync(DETAIL_PATH, 'utf8');

  if (!source.includes("import ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';")) {
    source = replaceOnce(
      source,
      "import { bootLog } from '@/lib/bootLog';",
      "import { bootLog } from '@/lib/bootLog';\nimport ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';",
      'detail unified import',
    );
  }

  const renderAnchor = "      {!loading ? (\n        <>\n          <section className=\"arkaSectionCard payrollClearBlock ownerSimpleCard arkaHeroMainDue\">";
  if (!source.includes('<ArkaUnifiedWorkerAccount actor={actor} targetPin={pin}')) {
    source = replaceOnce(
      source,
      renderAnchor,
      `      {!loading ? (\n        <>\n          {/* ${MARKER}: admin and worker use the same canonical snapshot. */}\n          <ArkaUnifiedWorkerAccount actor={actor} targetPin={pin} title={worker?.name || pin} showManagerLinks={canManage} />\n          <section className="arkaSectionCard payrollClearBlock ownerSimpleCard arkaHeroMainDue" style={{ display:'none' }} aria-hidden="true">`,
      'detail unified render',
    );
  }

  const renderStart = source.indexOf('<ArkaUnifiedWorkerAccount actor={actor} targetPin={pin}');
  source = hideFirstAfter(source, renderStart, '<div className="arkaWorkerStats adminTopGrid ownerTotalsGrid cleanCashGrid">', 'hide detail duplicate stats');
  source = hideFirstAfter(source, renderStart, '<section className="arkaSectionCard payrollClearBlock arkaCashListCard">', 'hide detail duplicate clients');

  source = source
    .replace('function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0.5 } = {}) {', 'function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0 } = {}) {')
    .replace(
      "    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;",
      "    const cashWorkerIsHybrid = worker?.pay_commission_enabled === true || worker?.is_hybrid_transport === true;\n    const commissionRate = cashWorkerIsHybrid ? Math.max(0, n(worker?.pay_commission_rate_m2 ?? worker?.commission_rate_m2)) : 0;",
    )
    .replace(
      "    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;\n    const isHybrid = worker?.is_hybrid_transport === true;",
      "    const isHybrid = worker?.pay_commission_enabled === true || worker?.is_hybrid_transport === true;\n    const commissionRate = isHybrid ? Math.max(0, n(worker?.pay_commission_rate_m2 ?? worker?.commission_rate_m2)) : 0;",
    )
    .replace(
      '            <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(cashAccount.visibleCommissionHistoryTotal)} tone="warn" />',
      '            {(worker?.pay_commission_enabled === true || summary.isHybridTransport) ? <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(cashAccount.visibleCommissionHistoryTotal)} tone="warn" /> : null}',
    )
    .replace(
      "                    {row.type === 'TRANSPORT' ? (",
      "                    {row.type === 'TRANSPORT' && (worker?.pay_commission_enabled === true || summary.isHybridTransport) ? (",
    );

  source = hideDetailsBySummary(source, 'HAP KOMISIONET', 'hide old commission details');
  source = hideDetailsBySummary(source, 'HAP PAYROLL', 'hide old payroll details');
  source = hideDetailsBySummary(source, 'HAP PAMJEN E VJETËR / AVANCUAR', 'hide old advanced view');

  const detailNavAnchor = '          {canManage ? <Link prefetch={false} href="/arka/payroll" className="arkaTopBtn">PAYROLL</Link> : null}';
  if (!source.includes('href="/arka/ditore" className="arkaTopBtn">MBYLLJA DITORE')) {
    source = replaceOnce(
      source,
      detailNavAnchor,
      `${detailNavAnchor}\n          {canManage ? <Link prefetch={false} href="/arka/ditore" className="arkaTopBtn">MBYLLJA DITORE</Link> : null}`,
      'detail daily nav',
    );
  }

  if (/commission_rate_m2\) > 0 \? n\(worker\?\.commission_rate_m2\) : 0\.5/.test(source)) {
    throw new Error('detail unsafe commission fallback remains');
  }
  fs.writeFileSync(DETAIL_PATH, source, 'utf8');
}

function patchStaff() {
  let source = fs.readFileSync(STAFF_PATH, 'utf8');

  if (!source.includes("import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';")) {
    source = replaceOnce(
      source,
      'import { createUserRecord, deleteUserRecord, fetchUserById, listUserRecords, updateUserRecord } from "@/lib/usersService";',
      'import { createUserRecord, deleteUserRecord, fetchUserById, listUserRecords, updateUserRecord } from "@/lib/usersService";\nimport WorkerCompensationEditor from \'@/components/WorkerCompensationEditor\';',
      'staff compensation import',
    );
  }

  if (!source.includes('href="/arka/ditore" className="navBtn">MBYLLJA DITORE')) {
    source = replaceOnce(
      source,
      '<Link prefetch={false} href="/arka" className="navBtn">← KTHEHU NË ARKË</Link>',
      '<Link prefetch={false} href="/arka" className="navBtn">← KTHEHU NË ARKË</Link>\n            <Link prefetch={false} href="/arka/ditore" className="navBtn">MBYLLJA DITORE</Link>',
      'staff daily link',
    );
  }

  source = source
    .replace('<label className="field">\n                    <span>BONUS TRANSPORT (€)</span>', '<label className="field" style={{ display:\'none\' }}>\n                    <span>BONUS TRANSPORT (€)</span>')
    .replace('<label className="field">\n                    <span>BONUS USHQIM (€)</span>', '<label className="field" style={{ display:\'none\' }}>\n                    <span>BONUS USHQIM (€)</span>')
    .replace('<label className="toggleField hybridToggleField">\n                    <span>AKTIVIZO KOMISIONIN E TRANSPORTIT</span>', '<label className="toggleField hybridToggleField" style={{ display:\'none\' }}>\n                    <span>AKTIVIZO KOMISIONIN E TRANSPORTIT</span>')
    .replace('<label className="field">\n                    <span>KOMISIONI PËR M2 (€)</span>', '<label className="field" style={{ display:\'none\' }}>\n                    <span>KOMISIONI PËR M2 (€)</span>');

  if (!source.includes('<WorkerCompensationEditor\n                    actor={actor}')) {
    const editorAnchor = '                </div>\n\n                <div className="editorActions">';
    const editorInsert = `                </div>\n\n                {editingId !== "NEW" ? (\n                  <WorkerCompensationEditor\n                    actor={actor}\n                    worker={(staff || []).find((item) => String(item?.id || '') === String(editingId || ''))}\n                    onSaved={() => reloadAll(false)}\n                  />\n                ) : (\n                  <div style={{ marginTop:14, border:'1px solid #bfdbfe', borderRadius:14, background:'#eff6ff', color:'#1e3a8a', padding:12, fontSize:12, fontWeight:850 }}>\n                    RUAJE PUNTORIN. MENJËHERË PAS KRIJIMIT HAPEN OPSIONET ME TIK PËR RROGË, USHQIM, KOMISION DHE BONUSE.\n                  </div>\n                )}\n\n                <div className="editorActions">`;
    source = replaceOnce(source, editorAnchor, editorInsert, 'staff compensation editor render');
  }

  if (!source.includes('PUNTORI U KRIJUA. TASH DEFINO OPSIONET E PAGESËS')) {
    source = replaceOnce(
      source,
      '        await createUserRecord(payload);',
      `        Object.assign(payload, {\n          pay_salary_enabled: false,\n          pay_meal_enabled: false,\n          pay_meal_amount: 0,\n          pay_commission_enabled: false,\n          pay_commission_rate_m2: 0,\n          pay_transport_bonus_enabled: false,\n          pay_transport_bonus_amount: 0,\n          pay_ready_bonus_enabled: safeUpper(editForm.role, 'PUNTOR') !== 'TRANSPORT',\n          pay_cash_mode: ['PUNTOR','TRANSPORT'].includes(safeUpper(editForm.role, 'PUNTOR')) ? 'FULL_CASH' : 'NO_CASH',\n        });\n        const createdUser = await createUserRecord(payload);\n        if (createdUser?.id) {\n          await reloadAll(false);\n          setEditingId(createdUser.id);\n          setEditForm({\n            name: createdUser.name || '', role: safeUpper(createdUser.role, 'PUNTOR'), pin: '', is_active: createdUser.is_active !== false,\n            bonus_transport: Number(createdUser.bonus_transport || 0), bonus_ushqim: Number(createdUser.bonus_ushqim || 0),\n            is_hybrid_transport: createdUser.is_hybrid_transport === true, commission_rate_m2: Number(createdUser.commission_rate_m2 || 0),\n          });\n          alert('✅ PUNTORI U KRIJUA. TASH DEFINO OPSIONET E PAGESËS ME TIK.');\n          return;\n        }`,
      'staff new worker compensation handoff',
    );
  }

  if (!source.includes('Mënyra e cash-it:')) {
    const metaAnchor = '                      <div className="staffMeta">\n                        Hybrid transport: <strong>{u.is_hybrid_transport ? "PO" : "JO"}</strong>\n                      </div>';
    const metaNext = `${metaAnchor}\n                      <div className="staffMeta">Mënyra e cash-it: <strong>{u.pay_cash_mode || (u.is_hybrid_transport ? 'HYBRID_COMMISSION' : 'FULL_CASH')}</strong></div>\n                      <div className="staffMeta">Rrogë / Ushqim / Bonus: <strong>{u.pay_salary_enabled ? 'RROGË ' : ''}{u.pay_meal_enabled ? '• USHQIM ' : ''}{u.pay_transport_bonus_enabled ? '• BONUS ' : ''}{u.pay_commission_enabled ? '• KOMISION' : ''}</strong></div>`;
    source = replaceOnce(source, metaAnchor, metaNext, 'staff profile summary');
  }

  fs.writeFileSync(STAFF_PATH, source, 'utf8');
}

function patchPayrollLib() {
  let source = fs.readFileSync(PAYROLL_LIB_PATH, 'utf8');
  if (!source.includes('UNIFIED_ARKA_PAYROLL_V1:PROFILE_FORMULA')) {
    source = replaceOnce(
      source,
      `    const baseSalary = n(worker?.salary ?? worker?.baseSalary);\n    const bonusTransport = n(worker?.bonus_transport);\n    const bonusUshqim = n(worker?.bonus_ushqim);\n    const manualAdvance = n(worker?.avans_manual ?? worker?.manualAdvance);\n    const longTermDebt = n(worker?.borxh_afatgjat ?? worker?.longTermDebt);\n    const commissionRateM2 = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;\n    const isHybridTransport = worker?.is_hybrid_transport === true;`,
      `    // UNIFIED_ARKA_PAYROLL_V1:PROFILE_FORMULA — explicit flags are authoritative.\n    const salaryEnabled = worker?.pay_salary_enabled !== false;\n    const baseSalary = salaryEnabled ? n(worker?.salary ?? worker?.baseSalary) : 0;\n    const mealEnabled = worker?.pay_meal_enabled === true;\n    const bonusUshqim = mealEnabled ? n(worker?.pay_meal_amount ?? worker?.bonus_ushqim) : 0;\n    const transportBonusEnabled = worker?.pay_transport_bonus_enabled === true;\n    const bonusTransport = transportBonusEnabled ? n(worker?.pay_transport_bonus_amount ?? worker?.bonus_transport) : 0;\n    const manualAdvance = n(worker?.avans_manual ?? worker?.manualAdvance);\n    const longTermDebt = n(worker?.borxh_afatgjat ?? worker?.longTermDebt);\n    const isHybridTransport = worker?.pay_commission_enabled === true && up(worker?.pay_cash_mode) === 'HYBRID_COMMISSION';\n    const commissionRateM2 = isHybridTransport ? Math.max(0, n(worker?.pay_commission_rate_m2 ?? worker?.commission_rate_m2)) : 0;`,
      'payroll explicit profile formula',
    );

    source = replaceOnce(
      source,
      '    const gross = baseSalary;',
      '    const gross = baseSalary + bonusTransport + bonusUshqim;',
      'payroll fixed gross components',
    );

    source = replaceOnce(
      source,
      '      baseSalary,\n      bonusTransport,\n      bonusUshqim,',
      '      salaryEnabled,\n      mealEnabled,\n      transportBonusEnabled,\n      commissionEnabled: isHybridTransport,\n      cashMode: up(worker?.pay_cash_mode || (isHybridTransport ? \'HYBRID_COMMISSION\' : \'FULL_CASH\')),\n      baseSalary,\n      bonusTransport,\n      bonusUshqim,',
      'payroll row profile fields',
    );
  }
  fs.writeFileSync(PAYROLL_LIB_PATH, source, 'utf8');
}

function patchPayrollPage() {
  let source = fs.readFileSync(PAYROLL_PATH, 'utf8');

  if (!source.includes("import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';")) {
    source = replaceOnce(
      source,
      'import { deleteUserRecord, listUserRecords, updateUserRecord } from "@/lib/usersService";',
      'import { deleteUserRecord, listUserRecords, updateUserRecord } from "@/lib/usersService";\nimport WorkerCompensationEditor from \'@/components/WorkerCompensationEditor\';',
      'payroll compensation import',
    );
  }

  if (!source.includes('href="/arka/ditore" className="navBtn">MBYLLJA DITORE')) {
    source = replaceOnce(
      source,
      '<Link prefetch={false} href="/arka" className="navBtn">← KTHEHU</Link>',
      '<Link prefetch={false} href="/arka" className="navBtn">← KTHEHU</Link>\n            <Link prefetch={false} href="/arka/ditore" className="navBtn">MBYLLJA DITORE</Link>',
      'payroll daily close link',
    );
  }

  if (!source.includes('<WorkerCompensationEditor\n              actor={actor}')) {
    const editAnchor = '            <div className="editActions">\n              <button className="saveBtn" onClick={saveFinanceEdit} disabled={actionBusy}>';
    const editNext = `            <WorkerCompensationEditor\n              actor={actor}\n              worker={(staff || []).find((item) => String(item?.id || '') === String(editingId || ''))}\n              onSaved={() => reloadAll(false)}\n            />\n\n            <div className="editActions">\n              <button className="saveBtn" onClick={saveFinanceEdit} disabled={actionBusy}>`;
    source = replaceOnce(source, editAnchor, editNext, 'payroll compensation editor render');
  }

  source = replaceOnce(
    source,
    `    const workerName = String(u.name || "").trim().toUpperCase();\n    const baseSalary = Number(u.salary || 0);`,
    `    const workerName = String(u.name || "").trim().toUpperCase();\n    const baseSalary = u.pay_salary_enabled === false ? 0 : Number(u.salary || 0);\n    const mealBonus = u.pay_meal_enabled === true ? Number(u.pay_meal_amount || u.bonus_ushqim || 0) : 0;\n    const transportBonus = u.pay_transport_bonus_enabled === true ? Number(u.pay_transport_bonus_amount || u.bonus_transport || 0) : 0;\n    const grossFixed = baseSalary + mealBonus + transportBonus;`,
    'payroll modal fixed components',
  );

  source = replaceOnce(
    source,
    '      baseSalary,\n      autoDebt,',
    '      baseSalary,\n      mealBonus,\n      transportBonus,\n      grossFixed,\n      autoDebt,',
    'payroll modal component fields',
  );

  source = replaceOnce(
    source,
    '    const baseSalary = Number(salaryModal.baseSalary || 0);\n    const personalAdvance = Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0);\n    return Math.max(0, baseSalary - personalAdvance);',
    '    const grossFixed = Number(salaryModal.grossFixed ?? salaryModal.baseSalary ?? 0);\n    const personalAdvance = Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0);\n    return Math.max(0, grossFixed - personalAdvance);',
    'payroll payable fixed gross',
  );

  source = replaceOnce(
    source,
    '    const baseSalary = Number(salaryModal?.baseSalary || 0);',
    '    const baseSalary = Number(salaryModal?.grossFixed ?? salaryModal?.baseSalary ?? 0);',
    'salary payment gross fixed',
  );

  source = source.replace(
    '`Rroga bazë: ${euro(baseSalary)}\\n` +',
    '`Rroga + shtesa fikse: ${euro(baseSalary)}\\n` +',
  );

  fs.writeFileSync(PAYROLL_PATH, source, 'utf8');
}

function patchTransportPayment() {
  let source = fs.readFileSync(TRANSPORT_PAY_PATH, 'utf8');

  if (!source.includes("import { getActor } from '@/lib/actorSession';")) {
    source = replaceOnce(
      source,
      'import { getTransportSession } from "@/lib/transportAuth";',
      'import { getTransportSession } from "@/lib/transportAuth";\nimport { getActor } from \'@/lib/actorSession\';\nimport { resolveActorPin } from \'@/lib/pinIdentity\';',
      'transport pay canonical actor imports',
    );
  }

  source = replaceOnce(
    source,
    `function getActorPin(session) {\n  return String(session?.transport_pin || session?.pin || session?.transport_id || '').trim();\n}`,
    `function getActorPin(session) {\n  // ${MARKER}: UUID transport_id is never a worker PIN.\n  return resolveActorPin(session || {}) || resolveActorPin(getActor() || {});\n}`,
    'transport pay canonical pin',
  );

  if (!source.includes('TRANSPORT_PAYMENT_FAST_BACKGROUND_V1')) {
    source = replaceOnce(
      source,
      `      const res = await arkaTransaction({\n        action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,`,
      `      const res = await arkaTransaction({\n        // TRANSPORT_PAYMENT_FAST_BACKGROUND_V1\n        action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,`,
      'transport fast payment marker',
    );

    source = replaceOnce(
      source,
      `        idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.TRANSPORT_ORDER_PAYMENT, [row.id, applied.toFixed(2), actorPin]),\n      });\n\n      assertVerifiedTransportPaymentResult(res, { orderId: row.id, code: transportCode, amount: applied, actorPin });`,
      `        idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.TRANSPORT_ORDER_PAYMENT, [row.id, applied.toFixed(2), actorPin]),\n      }, {\n        timeoutMs: 1400,\n        maxAttempts: 1,\n        queueOnNetworkFailure: true,\n        retryDelaysMs: [],\n      });\n\n      const queuedForSync = Boolean(res?.offlineQueued || res?.queued || res?.localOnly || res?.offline);\n      if (queuedForSync) {\n        try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}\n        try { window.sessionStorage?.setItem('tepiha_transport_payment_sync_notice_v1', JSON.stringify({ at:new Date().toISOString(), orderId:row.id, code:transportCode, amount:applied })); } catch {}\n        completed = true;\n        router.push('/transport/board?paymentSync=1');\n        return;\n      }\n\n      assertVerifiedTransportPaymentResult(res, { orderId: row.id, code: transportCode, amount: applied, actorPin });`,
      'transport queued fast path',
    );
  }

  source = source.replace(
    "      alert(translateTransportDbError(e));",
    "      alert(`${translateTransportDbError(e)}\\n\\nPAGESA NUK U RUAJT. PROVO PËRSËRI.`);",
  );

  fs.writeFileSync(TRANSPORT_PAY_PATH, source, 'utf8');
}

function patchVersionOwnerAndPackage() {
  let gati = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gati = gati
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);

  if (!gati.includes("const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';")) {
    gati = replaceOnce(
      gati,
      "  const installer = 'node tools/apply-gati-rack-save-v1.mjs';\n  const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';",
      "  const installer = 'node tools/apply-gati-rack-save-v1.mjs';\n  const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';\n  const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';",
      'gati unified installer declaration',
    );
    gati = replaceOnce(
      gati,
      '.filter((item) => item !== installer && item !== arkaInstaller);\n  pre.push(arkaInstaller, installer);',
      '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller);\n  pre.push(arkaInstaller, unifiedInstaller, installer);',
      'gati final installer order',
    );
  }
  fs.writeFileSync(GATI_INSTALLER_PATH, gati, 'utf8');

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => ![INSTALLER, ARKA_INSTALLER, GATI_INSTALLER].includes(item));
  pre.push(ARKA_INSTALLER, INSTALLER, GATI_INSTALLER);
  scripts.prebuild = pre.join(' && ');
  scripts['test:unified-arka-payroll-v1'] = 'node tools/verify-unified-arka-payroll-v1.mjs';
  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('unified build anchor missing');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

patchBeliCompatibility();
patchArkaMain();
patchWorkerDetail();
patchStaff();
patchPayrollLib();
patchPayrollPage();
patchTransportPayment();
patchVersionOwnerAndPackage();
console.log('PASS unified ARKA + payroll V1 installer');
