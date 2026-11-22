// WORKER_HANDOFF_WIZARD_V1: display helpers; financial totals come from the server.
export const HANDOFF_STEPS = ['Klientët', 'Bonuset', 'Ushqimi / shpenzimet', 'Paratë në dorë', 'Konfirmimi'];
export const EXPENSE_CATEGORIES = { FOOD:'Ushqim', FUEL:'Karburant', SUPPLIES:'Materiale', OTHER:'Tjetër' };
export const FUNDING_SOURCES = { WORKER_COLLECTIONS:'Nga paratë e klientëve', DISPATCH_DRAWER:'Nga arka e dispatch-it', OWN_MONEY:'Nga paratë e mia personale' };
export function handoffExpenseDescription(value) {
  // Display-only cleanup for the known legacy expense metadata line. The
  // canonical record and server snapshot keep their original description.
  return String(value ?? '').split(/\r?\n/).filter(line => !/^ARKA_EXPENSE_REQUEST_V1(?:\s|$)/.test(line)).join('\n').trim();
}
export function handoffMoney(value) { return new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR' }).format(Number(value) || 0); }
export function handoffDate(value, withTime = true) {
  if (!value) return 'Data mungon';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return 'Data mungon';
  return new Intl.DateTimeFormat('sq-AL', { timeZone:'Europe/Belgrade', day:'2-digit', month:'2-digit', year:'numeric', ...(withTime ? { hour:'2-digit', minute:'2-digit', hour12:false } : {}) }).format(date);
}
export function parseHandoffCash(value) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= 10000000 ? Math.round(number * 100) / 100 : null;
}
export function handoffDifference(physical, projected) { return physical == null || !Number.isFinite(Number(projected)) ? null : (Math.round(physical * 100) - Math.round(Number(projected) * 100)) / 100; }
export function handoffDifferenceText(difference) {
  if (difference == null) return 'Shkruaje shumën e numëruar.';
  if (difference === 0) return 'Shuma përputhet me llogaritjen.';
  return difference < 0 ? `${handoffMoney(Math.abs(difference))} më pak se llogaritja.` : `${handoffMoney(difference)} më shumë se llogaritja.`;
}
export function handoffClientKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => { const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16); });
}
export function newHandoffExpense(businessDate, existing) {
  return { clientKey:handoffClientKey(), existingPaymentId:existing?.paymentId ?? null, amount:existing ? String(existing.amount) : '', description:handoffExpenseDescription(existing?.description), spentOn:String(existing?.spentOn || businessDate || '').slice(0, 10), category:existing?.category && EXPENSE_CATEGORIES[existing.category] ? existing.category : 'OTHER', recipient:existing?.recipient || '', fundingSource:'', includesOwnMeal:null, ledgerPosted:existing?.ledgerPosted === true };
}
export function normalizeHandoffExpense(form, expenses = []) {
  const amount = parseHandoffCash(form.amount);
  if (amount == null || amount <= 0 || amount > 1000000) throw new Error('Shkruaje shumën e vlefshme të shpenzimit, më të madhe se 0.');
  const description = String(form.description || '').trim();
  if (description.length < 2 || description.length > 500) throw new Error('Shkruaj një përshkrim të qartë të shpenzimit.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.spentOn || ''))) throw new Error('Zgjedhe datën e shpenzimit.');
  if (!EXPENSE_CATEGORIES[form.category]) throw new Error('Zgjedhe llojin e shpenzimit.');
  if (!FUNDING_SOURCES[form.fundingSource]) throw new Error('Trego nga cilat para është paguar shpenzimi.');
  if (form.category === 'FOOD' && form.fundingSource === 'WORKER_COLLECTIONS' && typeof form.includesOwnMeal !== 'boolean') throw new Error('Zgjedh Po ose Jo: a përfshin ky shpenzim edhe ushqimin tënd?');
  const existingPaymentId = form.existingPaymentId ?? null, recipient = String(form.recipient || '').trim();
  const duplicate = expenses.some(row => existingPaymentId != null ? String(row.existingPaymentId) === String(existingPaymentId) : row.existingPaymentId == null && Math.round(Number(row.amount) * 100) === Math.round(amount * 100) && row.spentOn === form.spentOn && row.fundingSource === form.fundingSource && String(row.description || '').trim().toLocaleLowerCase() === description.toLocaleLowerCase() && String(row.recipient || '').trim().toLocaleLowerCase() === recipient.toLocaleLowerCase());
  if (duplicate) throw new Error('Ky shpenzim është përfshirë një herë. Kontrolloje te lista më poshtë.');
  return { clientKey:form.clientKey || handoffClientKey(), existingPaymentId, amount, description, spentOn:form.spentOn, category:form.category, recipient, fundingSource:form.fundingSource, includesOwnMeal:form.category === 'FOOD' && form.includesOwnMeal === true };
}
export function handoffErrorMessage(error) {
  if (error?.userMessage) return error.userMessage;
  const message = String(error?.message || error?.code || '');
  if (/SESSION_CHANGED|ACTOR_CHANGED|AUTH_REQUIRED|DEVICE_NOT_APPROVED/.test(message)) return 'Llogaria ose pajisja ka ndryshuar. Mbylle këtë dritare dhe hape përsëri llogarinë tënde.';
  if (/SNAPSHOT|STALE|REVIEW_CHANGED|STATE_CHANGED/.test(message)) return 'Pagesat ose zbritjet kanë ndryshuar. Rifresko llogaritjen dhe kontrolloji përsëri para konfirmimit.';
  if (/ALREADY_CLAIMED|DUPLICATE_EXPENSE|EXPENSE_DUPLICATE/.test(message)) return 'Ky shpenzim është lidhur tashmë me një dorëzim. Rifresko listën që të mos zbritet dy herë.';
  if (/OWN_MEAL|MEAL_OVERLAP|MEAL_DUPLICATE/.test(message)) return 'Kontrollo ushqimin personal dhe shpenzimin e ekipit që të llogariten një herë.';
  if (/NETWORK|TIMEOUT|Failed to fetch|network|Load failed/.test(message)) return 'Lidhja u ndërpre. Nëse kërkesa është ruajtur, përdor butonin për ta riprovuar të njëjtin dorëzim.';
  if (message && !/^[A-Z0-9_: ]+$/.test(message)) return message;
  return 'Dorëzimi nuk u konfirmua. Kontrollo të dhënat dhe provo përsëri.';
}
export function verifyHandoffPreview(preview) {
  const amounts = ['grossCash','commission','mealDeduction','bonusDeduction','bonusRemaining','expectedCash','claimedCollectionExpenses','projectedCash'];
  if (preview?.ok !== true || !preview.snapshotHash || !preview.businessDate || !preview.mealPolicy || !['payments','bonuses','existingExpenses','expenses','pendingHandoffs'].every(key => Array.isArray(preview[key])) || !amounts.every(key => preview.totals?.[key] != null && Number.isFinite(Number(preview.totals[key])))) throw new Error('Llogaritja nuk u ngarkua plotësisht. Rifresko dhe provo përsëri.');
  return preview;
}
