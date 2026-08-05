import fs from 'node:fs';

const PAGE = 'app/arka/page.jsx';
const SERVICE = 'lib/arkaService.js';
const MARKER = 'HANDOFF_WIZARD_V1';

function patchService() {
  let source = fs.readFileSync(SERVICE, 'utf8');
  if (source.includes(`${MARKER}:SERVICE`)) return;

  source = source.replace(
`  staffOptions = [],
  amountPerPerson = 3,
} = {}) {`,
`  staffOptions = [],
  amountPerPerson = 3,
  presetChoice = '',
  presetPayerPin = '',
} = {}) {
  // ${MARKER}:SERVICE`
  );

  source = source.replace(
`  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    return { ok: true, skipped: true, confirmLine: 'USHQIMI NUK U KONFIRMUA NË UI.' };
  }

  const existingChargeLine`,
`  const normalizedPresetChoice = cleanText(presetChoice).toLowerCase();
  if (!normalizedPresetChoice && (typeof window === 'undefined' || typeof window.prompt !== 'function')) {
    return { ok: true, skipped: true, confirmLine: 'USHQIMI NUK U KONFIRMUA NË UI.' };
  }

  const existingChargeLine`
  );

  source = source.replace(
`  const choice = String(window.prompt([`,
`  const choice = normalizedPresetChoice || String(window.prompt([`
  );

  source = source.replace(
`    const payerPin = cleanText(window.prompt([`,
`    const payerPin = cleanText(presetPayerPin) || cleanText(window.prompt([`
  );

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

  const submitStart = source.indexOf('  async function submitHandoff() {', stateEnd);
  if (submitStart < 0) throw new Error('WIZARD_SUBMIT_START_NOT_FOUND');
  const submitEnd = source.indexOf('\n  async function ', submitStart + 10);
  if (submitEnd < 0) throw new Error('WIZARD_SUBMIT_END_NOT_FOUND');
  let submitBlock = source.slice(submitStart, submitEnd);
  submitBlock = submitBlock.replace('  async function submitHandoff() {', '  async function submitHandoff(options = {}) {');
  submitBlock = submitBlock.replace(
`        amountPerPerson: FOOD_DEDUCTION,
      });`,
`        amountPerPerson: FOOD_DEDUCTION,
        presetChoice: options?.mealChoice || '',
        presetPayerPin: options?.mealPayerPin || '',
      });`
  );
  submitBlock = submitBlock.replace('      const ok = confirm(', '      const ok = options?.skipConfirm ? true : confirm(');
  submitBlock = submitBlock.replace(
    /      alert\(`✅ DORËZIMI U DËRGUA TE DISPATCH\.[\s\S]*?`\);/,
    (match) => `      if (!options?.wizard) ${match.trim()}\n      return submitted;`
  );
  submitBlock = submitBlock.replace(
`    } catch (e) {
      alert(\`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}\`);`,
`    } catch (e) {
      if (options?.wizard) throw e;
      alert(\`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}\`);`
  );

  const openFunctions = `  async function openHandoffWizard() {
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

  async function submitHandoffFromWizard(decision = {}) {
    return submitHandoff({ ...decision, skipConfirm: true, wizard: true });
  }

`;
  source = source.slice(0, submitStart) + openFunctions + submitBlock + source.slice(submitEnd);

  const buttonOld = `<button type="button" className="arkaSolidBtn big arkaMainHandoffBtn" disabled={!!busy || workerBaseForDispatchTotal <= 0 || n(workerSnapshot?.cashDuplicateTransportCount) > 0} onClick={submitHandoff}>{busy === 'handoff' ? '...' : \`DORËZO TE DISPATCH — ${euro(workerBaseForDispatchTotal)}\`}</button>`;
  const buttonNew = `<button type="button" className="arkaSolidBtn big arkaMainHandoffBtn" disabled={!!busy || workerBaseForDispatchTotal <= 0 || n(workerSnapshot?.cashDuplicateTransportCount) > 0} onClick={openHandoffWizard}>{busy === 'handoff' ? '...' : \`DORËZO TE DISPATCH — ${euro(workerBaseForDispatchTotal)}\`}</button>`;
  if (!source.includes(buttonOld)) throw new Error('WIZARD_BUTTON_ANCHOR_NOT_FOUND');
  source = source.replace(buttonOld, buttonNew);

  const sectionAnchor = `          <div className="arkaSectionCard" style={{ display: 'grid', gap: 10 }}>`;
  const modal = `          <HandoffWizard
            open={handoffWizard.open}
            actor={actor}
            clientCount={Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows.length : 0}
            grossTotal={workerBaseForDispatchTotal}
            bonusAvailable={handoffWizard.bonusAvailable}
            existingMealCovered={selfMealCoveredToday}
            staffOptions={mealOptions}
            onClose={() => setHandoffWizard((prev) => ({ ...prev, open: false }))}
            onSubmit={submitHandoffFromWizard}
          />

`;
  if (!source.includes(sectionAnchor)) throw new Error('WIZARD_SECTION_ANCHOR_NOT_FOUND');
  source = source.replace(sectionAnchor, modal + sectionAnchor);

  fs.writeFileSync(PAGE, source, 'utf8');
}

patchService();
patchPage();
console.log('[handoff-wizard-v1] installed');
