import fs from 'node:fs';

const FINANCE_FILE = 'lib/corporateFinance.js';
const BONUS_CLIENT_FILE = 'lib/baseReadyBonusClient.js';
const MARKER = 'DISPATCH_OWN_HANDOFF_BONUS_BYPASS_V2';

function replaceOnce(source, search, replacement, errorCode) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(errorCode);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function patchBonusClient() {
  let source = fs.readFileSync(BONUS_CLIENT_FILE, 'utf8');

  if (!source.includes(MARKER)) {
    const signature = 'export async function listOpenBaseReadyBonusPayments(actorPin) {';
    const nextSignature = `// ${MARKER}: non-worker cash collectors receive an empty bonus list.\nexport async function listOpenBaseReadyBonusPayments(actorPin, options = {}) {`;
    source = replaceOnce(
      source,
      signature,
      nextSignature,
      'DISPATCH_BONUS_BYPASS_V2_CLIENT_SIGNATURE_MISSING'
    );

    const functionStart = source.indexOf(nextSignature);
    const errorAnchor = '  if (error) throw error;';
    const errorIndex = source.indexOf(errorAnchor, functionStart);
    if (functionStart < 0 || errorIndex < 0) {
      throw new Error('DISPATCH_BONUS_BYPASS_V2_CLIENT_ERROR_ANCHOR_MISSING');
    }

    const guardedError = `  if (error) {\n    const errorValues = [error?.message, error?.details, error?.hint, error?.code, error];\n    const workerOnly = errorValues.some((value) => String(value || '').trim().toUpperCase().includes('BONUS_WORKER_ONLY'));\n    if (options?.allowNonWorker === true && workerOnly) return [];\n    throw error;\n  }`;
    source = source.slice(0, errorIndex) + guardedError + source.slice(errorIndex + errorAnchor.length);
  }

  if (!source.includes('listOpenBaseReadyBonusPayments(actorPin, options = {})')) {
    throw new Error('DISPATCH_BONUS_BYPASS_V2_CLIENT_OPTIONS_VERIFY_FAILED');
  }
  if (!source.includes("options?.allowNonWorker === true && workerOnly")) {
    throw new Error('DISPATCH_BONUS_BYPASS_V2_CLIENT_GUARD_VERIFY_FAILED');
  }

  fs.writeFileSync(BONUS_CLIENT_FILE, source, 'utf8');
}

function patchCorporateFinance() {
  let source = fs.readFileSync(FINANCE_FILE, 'utf8');

  const directCall = '      listOpenBaseReadyBonusPayments(pin),';
  const v1Call = '      listReadyBonusRowsWithoutBlockingHandoff(pin),';
  const guardedCall = '      listOpenBaseReadyBonusPayments(pin, { allowNonWorker: true }),';

  if (!source.includes(guardedCall)) {
    if (source.includes(directCall)) {
      source = replaceOnce(
        source,
        directCall,
        guardedCall,
        'DISPATCH_BONUS_BYPASS_V2_FINANCE_CALL_MISSING'
      );
    } else if (source.includes(v1Call)) {
      source = replaceOnce(
        source,
        v1Call,
        guardedCall,
        'DISPATCH_BONUS_BYPASS_V2_FINANCE_V1_CALL_MISSING'
      );
    } else {
      throw new Error('DISPATCH_BONUS_BYPASS_V2_FINANCE_CALL_ANCHOR_MISSING');
    }
  }

  const submitStart = source.indexOf('export async function submitWorkerCashToDispatch');
  const submitEnd = source.indexOf('\n\nexport async function acceptDispatchHandoff', submitStart);
  if (submitStart < 0 || submitEnd < 0) {
    throw new Error('DISPATCH_BONUS_BYPASS_V2_SUBMIT_BOUNDARY_MISSING');
  }
  const submitBlock = source.slice(submitStart, submitEnd);
  if (!submitBlock.includes(guardedCall.trim())) {
    throw new Error('DISPATCH_BONUS_BYPASS_V2_SUBMIT_GUARD_VERIFY_FAILED');
  }
  if (submitBlock.includes('listOpenBaseReadyBonusPayments(pin),')) {
    throw new Error('DISPATCH_BONUS_BYPASS_V2_UNGUARDED_CALL_REMAINS');
  }

  if (!source.includes(MARKER)) {
    const importAnchor = "import { BASE_READY_BONUS_TYPE, listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';";
    source = replaceOnce(
      source,
      importAnchor,
      `${importAnchor}\n// ${MARKER}: cash handoff is independent from worker-only bonus eligibility.`,
      'DISPATCH_BONUS_BYPASS_V2_FINANCE_MARKER_ANCHOR_MISSING'
    );
  }

  fs.writeFileSync(FINANCE_FILE, source, 'utf8');
}

patchBonusClient();
patchCorporateFinance();

console.log('PASS: dispatch/admin handoff uses allowNonWorker bonus lookup and cannot be blocked by BONUS_WORKER_ONLY.');
