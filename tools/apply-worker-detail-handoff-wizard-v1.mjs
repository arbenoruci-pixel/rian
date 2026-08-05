import fs from 'node:fs';

const PAGE = 'app/arka/puntor/[pin]/page.jsx';
const MARKER = 'WORKER_DETAIL_HANDOFF_WIZARD_V1';

let source = fs.readFileSync(PAGE, 'utf8');
if (source.includes(MARKER)) {
  console.log('[worker-detail-handoff-wizard] already installed');
  process.exit(0);
}

const importAnchor = "import useRouteAlive from '@/lib/routeAlive';";
if (!source.includes(importAnchor)) throw new Error('WORKER_WIZARD_IMPORT_ANCHOR_NOT_FOUND');
source = source.replace(importAnchor, `${importAnchor}\nimport HandoffWizard from '@/components/HandoffWizard';\nimport { listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';`);

const stateAnchor = "  const [busy, setBusy] = useState(false);";
if (!source.includes(stateAnchor)) throw new Error('WORKER_WIZARD_STATE_ANCHOR_NOT_FOUND');
source = source.replace(stateAnchor, `${stateAnchor}\n  // ${MARKER}\n  const [handoffWizard, setHandoffWizard] = useState({ open: false, bonusAvailable: 0 });`);

function replaceFunction(input, signature, replacement) {
  const start = input.indexOf(signature);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${signature}`);
  const braceStart = input.indexOf('{', start);
  if (braceStart < 0) throw new Error(`FUNCTION_BRACE_NOT_FOUND:${signature}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let templateDepth = 0;
  for (let i = braceStart; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote === '`' && ch === '$' && next === '{') { templateDepth += 1; i += 1; continue; }
      if (quote === '`' && ch === '}' && templateDepth > 0) { templateDepth -= 1; continue; }
      if (ch === quote && templateDepth === 0) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && next === '/') { const nl = input.indexOf('\n', i + 2); i = nl < 0 ? input.length : nl; continue; }
    if (ch === '/' && next === '*') { const end = input.indexOf('*/', i + 2); i = end < 0 ? input.length : end + 1; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(0, start) + replacement + input.slice(i + 1);
    }
  }
  throw new Error(`FUNCTION_END_NOT_FOUND:${signature}`);
}

const replacement = `  async function openWorkerHandoffWizard() {
    if (!sameWorker || cashRemainingToHandOver <= 0 || busy) return;
    if (n(cashAccount?.duplicateTransportCashCount) > 0) {
      alert('🔴 U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI.');
      return;
    }
    try {
      const rows = await listOpenBaseReadyBonusPayments(pin);
      const bonusAvailable = +(Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + n(row?.remaining_amount), 0).toFixed(2);
      setHandoffWizard({ open: true, bonusAvailable });
    } catch {
      setHandoffWizard({ open: true, bonusAvailable: 0 });
    }
  }

  async function handoffMine(decision = {}) {
    if (!sameWorker || cashRemainingToHandOver <= 0) return;
    if (handoffSubmitLockRef.current || busy) return;
    handoffSubmitLockRef.current = true;
    try {
      if (n(cashAccount?.duplicateTransportCashCount) > 0) throw new Error('U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI.');
      await ensureMealDecisionBeforeHandoff({
        actor,
        workerPin: pin,
        workerName: worker?.name || pin,
        workerRole: worker?.role || 'WORKER',
        staffOptions,
        amountPerPerson: parseAmountInput(mealAmount || '3') || 3,
        presetChoice: decision?.mealChoice || '',
        presetPayerPin: decision?.mealPayerPin || '',
      });
      setBusy(true);
      const submitted = await submitWorkerCashToDispatch({ actor });
      await reload();
      notifyArkaHome();
      return submitted;
    } catch (e) {
      throw e;
    } finally {
      handoffSubmitLockRef.current = false;
      setBusy(false);
    }
  }`;
source = replaceFunction(source, '  async function handoffMine() {', replacement);

source = source.replace(/onClick=\{handoffMine\}/g, 'onClick={openWorkerHandoffWizard}');

const modalAnchor = "      {!loading ? (\n        <>";
if (!source.includes(modalAnchor)) throw new Error('WORKER_WIZARD_MODAL_ANCHOR_NOT_FOUND');
const expenseTotalExpr = `(Array.isArray(cashAccount?.approvedTodayExpenseRows) ? cashAccount.approvedTodayExpenseRows : []).reduce((sum, row) => sum + n(row?.amount), 0)`;
const existingMealExpr = `(Array.isArray(extras) ? extras : []).some((row) => ['MEAL_PAYMENT','MEAL_COVERED'].includes(safeUpper(row?.type)) && isToday(row?.created_at || row?.handed_at))`;
const existingMealDeductExpr = `(Array.isArray(extras) ? extras : []).filter((row) => safeUpper(row?.type) === 'MEAL_PAYMENT' && isToday(row?.created_at || row?.handed_at)).reduce((sum, row) => sum + n(row?.amount), 0)`;
const modal = `      <HandoffWizard
        open={handoffWizard.open}
        actor={{ ...actor, pin, name: worker?.name || pin, role: worker?.role || actor?.role }}
        clientCount={Array.isArray(cashAccount?.dispatchOpenRows) ? cashAccount.dispatchOpenRows.length : 0}
        grossTotal={cashAccount.openGrossTotal}
        baseTotal={cashAccount.totalDueToBase}
        commissionTotal={cashAccount.openTransportCommissionTotal}
        bonusAvailable={handoffWizard.bonusAvailable}
        openExpenseTotal={${expenseTotalExpr}}
        existingMealCovered={${existingMealExpr}}
        existingMealDeduct={${existingMealDeductExpr}}
        staffOptions={staffOptions}
        onClose={() => setHandoffWizard((prev) => ({ ...prev, open: false }))}
        onSubmit={handoffMine}
      />

`;
source = source.replace(modalAnchor, modal + modalAnchor);

fs.writeFileSync(PAGE, source, 'utf8');
console.log('[worker-detail-handoff-wizard] installed');
