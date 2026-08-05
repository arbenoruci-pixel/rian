import fs from 'node:fs';

const PAGE = 'app/arka/page.jsx';
const SERVICE = 'lib/arkaService.js';
const MARKER = 'HANDOFF_WIZARD_V2_SINGLE_FLOW';

function replaceFunction(source, signature, replacement) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${signature}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`FUNCTION_BRACE_NOT_FOUND:${signature}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let templateExprDepth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote === '`' && ch === '$' && next === '{') { templateExprDepth += 1; i += 1; continue; }
      if (quote === '`' && ch === '}' && templateExprDepth > 0) { templateExprDepth -= 1; continue; }
      if (ch === quote && templateExprDepth === 0) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && next === '/') { const nl = source.indexOf('\n', i + 2); i = nl < 0 ? source.length : nl; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(0, start) + replacement + source.slice(i + 1);
    }
  }
  throw new Error(`FUNCTION_END_NOT_FOUND:${signature}`);
}

function patchService() {
  let source = fs.readFileSync(SERVICE, 'utf8');
  if (source.includes(`${MARKER}:SERVICE`)) return;

  const paramsOld = `  staffOptions = [],\n  amountPerPerson = 3,\n} = {}) {`;
  const paramsNew = `  staffOptions = [],\n  amountPerPerson = 3,\n  presetChoice = '',\n  presetPayerPin = '',\n} = {}) {\n  // ${MARKER}:SERVICE`;
  if (!source.includes(paramsOld)) throw new Error('WIZARD_SERVICE_PARAMS_ANCHOR_NOT_FOUND');
  source = source.replace(paramsOld, paramsNew);

  const windowOld = `  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {\n    return { ok: true, skipped: true, confirmLine: 'USHQIMI NUK U KONFIRMUA NË UI.' };\n  }\n\n  const existingChargeLine`;
  const windowNew = `  const rawPresetChoice = cleanText(presetChoice).toLowerCase();\n  const normalizedPresetChoice = ({ self: '1', other: '2', none: '3' }[rawPresetChoice] || rawPresetChoice);\n  if (!normalizedPresetChoice && (typeof window === 'undefined' || typeof window.prompt !== 'function')) {\n    return { ok: true, skipped: true, confirmLine: 'USHQIMI NUK U KONFIRMUA NË UI.' };\n  }\n\n  const existingChargeLine`;
  if (!source.includes(windowOld)) throw new Error('WIZARD_SERVICE_WINDOW_ANCHOR_NOT_FOUND');
  source = source.replace(windowOld, windowNew);

  const choiceOld = `  const choice = String(window.prompt([`;
  const choiceNew = `  const choice = normalizedPresetChoice || String(window.prompt([`;
  if (!source.includes(choiceOld)) throw new Error('WIZARD_SERVICE_CHOICE_ANCHOR_NOT_FOUND');
  source = source.replace(choiceOld, choiceNew);

  const payerOld = `    const payerPin = cleanText(window.prompt([`;
  const payerNew = `    const payerPin = cleanText(presetPayerPin) || cleanText(window.prompt([`;
  if (!source.includes(payerOld)) throw new Error('WIZARD_SERVICE_PAYER_ANCHOR_NOT_FOUND');
  source = source.replace(payerOld, payerNew);

  fs.writeFileSync(SERVICE, source, 'utf8');
}

function patchPage() {
  let source = fs.readFileSync(PAGE, 'utf8');
  if (source.includes(`${MARKER}:PAGE`)) return;

  const importAnchor = `import ReadyBonusLiveCard from '@/components/ReadyBonusLiveCard';`;
  if (!source.includes(importAnchor)) throw new Error('WIZARD_IMPORT_ANCHOR_NOT_FOUND');
  source = source.replace(importAnchor, `${importAnchor}\nimport HandoffWizard from '@/components/HandoffWizard';`);

  const stateAnchor = `  const [busy, setBusy] = useState('');`;
  const statePos = source.lastIndexOf(stateAnchor);
  if (statePos < 0) throw new Error('WIZARD_STATE_ANCHOR_NOT_FOUND');
  const stateEnd = statePos + stateAnchor.length;
  source = source.slice(0, stateEnd) + `\n  // ${MARKER}:PAGE\n  const [handoffWizard, setHandoffWizard] = useState({ open: false, bonusAvailable: 0 });` + source.slice(stateEnd);

  const replacement = `  async function openHandoffWizard() {
    if (busyRef.current) return;
    const rows = Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows : [];
    const total = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);
    if (!workerSnapshot || total <= 0 || !rows.length) return alert('🔴 NUK KE KLIENTË ME CASH I MARRË PËR DORËZIM.');
    if (n(workerSnapshot?.cashDuplicateTransportCount) > 0) return alert('🔴 U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI.');
    try {
      const openBonusRows = await listOpenBaseReadyBonusPayments(actor?.pin);
      const bonusAvailable = +(openBonusRows.reduce((sum, row) => sum + n(row?.remaining_amount), 0)).toFixed(2);
      setHandoffWizard({ open: true, bonusAvailable });
    } catch {
      setHandoffWizard({ open: true, bonusAvailable: 0 });
    }
  }

  async function submitHandoff(options = {}) {
    if (busyRef.current) return;
    busyRef.current = 'handoff';
    try {
      const rows = Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows : [];
      const total = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);
      if (!workerSnapshot || total <= 0 || !rows.length) throw new Error('NUK KE KLIENTË ME CASH I MARRË PËR DORËZIM.');
      if (n(workerSnapshot?.cashDuplicateTransportCount) > 0) throw new Error('U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI.');

      await ensureMealDecisionBeforeHandoff({
        actor,
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
        staffOptions: mealOptions,
        amountPerPerson: FOOD_DEDUCTION,
        presetChoice: options?.mealChoice || '',
        presetPayerPin: options?.mealPayerPin || '',
      });

      setBusy('handoff');
      const submitted = await submitWorkerCashToDispatch({ actor });
      await scheduleManagerMutationRefresh(actor);
      return submitted;
    } catch (e) {
      if (options?.wizard) throw e;
      alert(\`🔴 \${e?.message || 'NUK U DËRGUA DORËZIMI.'}\`);
      return null;
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }

  async function submitHandoffFromWizard(decision = {}) {
    return submitHandoff({ ...decision, wizard: true });
  }`;

  source = replaceFunction(source, '  async function submitHandoff() {', replacement);

  const buttonOld = /<button type="button" className="arkaSolidBtn big arkaMainHandoffBtn"([^>]*?)onClick=\{submitHandoff\}([^>]*)>\{busy === 'handoff' \? '\.\.\.' : `DORËZO TE DISPATCH — \$\{euro\(workerBaseForDispatchTotal\)\}`}<\/button>/;
  if (!buttonOld.test(source)) throw new Error('WIZARD_BUTTON_ANCHOR_NOT_FOUND');
  source = source.replace(buttonOld, `<button type="button" className="arkaSolidBtn big arkaMainHandoffBtn"$1onClick={openHandoffWizard}$2>{busy === 'handoff' ? '...' : \`DORËZO TE DISPATCH — \${euro(workerBaseForDispatchTotal)}\`}</button>`);

  const sectionAnchor = `          <div className="arkaSectionCard" style={{ display: 'grid', gap: 10 }}>`;
  if (!source.includes(sectionAnchor)) throw new Error('WIZARD_SECTION_ANCHOR_NOT_FOUND');
  const modal = `          <HandoffWizard
            open={handoffWizard.open}
            actor={actor}
            clientCount={Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows.length : 0}
            grossTotal={workerGrossTotal}
            baseTotal={workerBaseForDispatchTotal}
            commissionTotal={workerCommissionTotal}
            bonusAvailable={handoffWizard.bonusAvailable}
            openExpenseTotal={workerOpenExpenseRows.filter((row) => typeOf(row) === 'EXPENSE').reduce((sum, row) => sum + amountOf(row), 0)}
            existingMealCovered={selfMealCoveredToday}
            existingMealDeduct={workerOpenExpenseRows.filter((row) => typeOf(row) === 'MEAL_PAYMENT').reduce((sum, row) => sum + amountOf(row), 0)}
            staffOptions={mealOptions}
            onClose={() => setHandoffWizard((prev) => ({ ...prev, open: false }))}
            onSubmit={submitHandoffFromWizard}
          />

`;
  source = source.replace(sectionAnchor, modal + sectionAnchor);

  fs.writeFileSync(PAGE, source, 'utf8');
}

patchService();
patchPage();
console.log('[handoff-wizard-v2] single-flow installed');
