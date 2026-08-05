import fs from 'node:fs';

const PAGE = 'app/arka/puntor/[pin]/page.jsx';
const MARKER = 'WORKER_DETAIL_HANDOFF_WIZARD_V2';
let source = fs.readFileSync(PAGE, 'utf8');

if (source.includes(MARKER)) {
  console.log('[worker-detail-handoff-wizard-v2] already installed');
  process.exit(0);
}

const oldBlock = `      await ensureMealDecisionBeforeHandoff({
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
      const submitted = await submitWorkerCashToDispatch({ actor });`;

const newBlock = `      // ${MARKER}: wizard is the only meal decision UI.
      // Choice 3 means no meal and must continue without another confirm.
      const mealChoice = String(decision?.mealChoice || '').trim();
      if (mealChoice === '1' || mealChoice === '2') {
        await ensureMealDecisionBeforeHandoff({
          actor: { ...actor, pin, name: worker?.name || pin, role: 'WORKER' },
          workerPin: pin,
          workerName: worker?.name || pin,
          workerRole: 'WORKER',
          staffOptions,
          amountPerPerson: parseAmountInput(mealAmount || '3') || 3,
          presetChoice: mealChoice,
          presetPayerPin: decision?.mealPayerPin || '',
          skipFinalConfirm: true,
          wizardOnly: true,
        });
      }
      setBusy(true);
      const handoffActor = { ...actor, pin, name: worker?.name || pin, role: 'WORKER' };
      const submitted = await submitWorkerCashToDispatch({ actor: handoffActor });`;

if (!source.includes(oldBlock)) {
  throw new Error('WORKER_DETAIL_HANDOFF_V2_SUBMIT_ANCHOR_NOT_FOUND');
}
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(PAGE, source, 'utf8');
console.log('[worker-detail-handoff-wizard-v2] installed');
