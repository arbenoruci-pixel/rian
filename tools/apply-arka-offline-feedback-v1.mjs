import fs from 'node:fs';

const pagePath = 'app/arka/page.jsx';
let source = fs.readFileSync(pagePath, 'utf8');
let changed = false;

const oldExpense = `      await createExpenseEntry({
        actor,
        amount,
        note: buildExpenseRequestNote(title, request),
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
      });
      setExpenseTitle('');`;

const newExpense = `      const expenseResult = await createExpenseEntry({
        actor,
        amount,
        note: buildExpenseRequestNote(title, request),
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
      });
      const expenseQueuedOffline = Boolean(expenseResult?.offlineQueued || expenseResult?.queued || expenseResult?.localOnly || expenseResult?.offline);
      setExpenseTitle('');`;

if (!source.includes('const expenseResult = await createExpenseEntry({')) {
  if (!source.includes(oldExpense)) throw new Error('ARKA_OFFLINE_EXPENSE_SUBMIT_ANCHOR_NOT_FOUND');
  source = source.replace(oldExpense, newExpense);
  changed = true;
}

const oldRefresh = `      setExpenseFormOpen(false);
      await scheduleManagerMutationRefresh(actor);
      alert('✅ SHPENZIMI U REGJISTRUA SI KËRKESË NË PRITJE.');`;

const newRefresh = `      setExpenseFormOpen(false);
      if (!expenseQueuedOffline) await scheduleManagerMutationRefresh(actor);
      else {
        try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}
      }
      alert(expenseQueuedOffline
        ? '✅ SHPENZIMI U RUAJT OFFLINE. DO TË SINKRONIZOHET AUTOMATIKISHT KUR TË KETË RRJET.'
        : '✅ SHPENZIMI U REGJISTRUA SI KËRKESË NË PRITJE.');`;

const compatibleOfflineFlow =
  source.includes('expenseQueuedOffline') &&
  (source.includes("window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'))") ||
   source.includes('ARKA_EXPENSE_MOBILE_PRO_V2:PAGE'));

if (!source.includes('SHPENZIMI U RUAJT OFFLINE. DO TË SINKRONIZOHET') && !compatibleOfflineFlow) {
  if (!source.includes(oldRefresh)) throw new Error('ARKA_OFFLINE_EXPENSE_REFRESH_ANCHOR_NOT_FOUND');
  source = source.replace(oldRefresh, newRefresh);
  changed = true;
}

if (changed) fs.writeFileSync(pagePath, source, 'utf8');
console.log(`[arka-offline-feedback-v1] ${changed ? 'installed' : 'already installed / compatible'}`);
