import { getActor } from '@/lib/actorSession';

const PREFIX = 'tepiha_handoff_receipt_intent_v1:';
const identity = actor => String(actor?.id || actor?.user_id || '');
const labels = {
  HANDOFF_RECEIPT_STATE_CHANGED: 'Shuma ka ndryshuar. Rifresko dorëzimin dhe kontrollo përsëri paratë.',
  HANDOFF_RECEIPT_SELF_APPROVAL: 'Dorëzimin tënd duhet ta pranojë një person tjetër i autorizuar.',
  HANDOFF_RECEIPT_NONCASH_CONFIRM_REQUIRED: 'Konfirmo se ky sqarim nuk është pranim parash.',
  HANDOFF_RECEIPT_WORKFLOW_PAUSED: 'Pranimi është pezulluar përkohësisht. Gjendja e regjistruar është ruajtur.',
  HANDOFF_RECEIPT_SESSION_CHANGED: 'Llogaria ka ndryshuar. Hape përsëri faqen.',
  HANDOFF_RECEIPT_FORBIDDEN: 'Nuk ke të drejtë ta kryesh këtë veprim.',
  HANDOFF_RECEIPT_BUDGET_CHANGED: 'Gjendja e arkës ka ndryshuar. Rifresko dhe numëro përsëri para mbylljes.',
  PENDING_EXPENSES_MUST_BE_DECIDED: 'Vendosi shpenzimet në pritje para mbylljes së arkës.',
  HANDOFF_RECEIPT_AMOUNT_INVALID: 'Shkruaj një shumë të vlefshme me më së shumti dy shifra pas presjes.',
  HANDOFF_RECEIPT_REASON_REQUIRED: 'Shkruaje arsyen e diferencës para konfirmimit.',
};

export async function requestHandoffReceipts(payload = {}) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Pranimi dhe sqarimi i parave kërkojnë internet.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/handoff-receipts', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, expectedActorId: actorId }),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      const error = new Error(labels[result?.error] || (response.status === 401 ? 'Hyr përsëri në aplikacion.' : 'Veprimi nuk u konfirmua. Kontrollo gjendjen dhe provo përsëri.'));
      error.code = result?.error;
      error.definitive = response.status >= 400 && response.status < 500;
      throw error;
    }
    if (identity(getActor()) !== actorId) throw new Error(labels.HANDOFF_RECEIPT_SESSION_CHANGED);
    return result;
  } finally { clearTimeout(timer); }
}

export function readHandoffReceiptIntent(actorId, handoffId) {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + actorId + ':' + handoffId) || 'null');
    return value && value.actorId === actorId && Number(value.handoffId) === Number(handoffId) && typeof value.requestKey === 'string' ? value : null;
  } catch { return null; }
}

function clearIntent(actorId, handoffId) {
  try { localStorage.removeItem(PREFIX + actorId + ':' + handoffId); } catch {}
}

export async function saveHandoffReceipt(payload, { retry = false } = {}) {
  const actorId = identity(getActor());
  const key = PREFIX + actorId + ':' + payload.handoffId;
  let intent = readHandoffReceiptIntent(actorId, payload.handoffId);
  if (intent && !retry) throw new Error('Ka një veprim që pret konfirmimin. Përdor “Riprovo të njëjtin veprim”.');
  if (!intent) {
    if (retry) throw new Error('Nuk ka veprim në pritje. Rifresko dorëzimin.');
    intent = { ...payload, actorId, requestKey: 'HR1:' + crypto.randomUUID() };
    try { localStorage.setItem(key, JSON.stringify(intent)); } catch { throw new Error('Pajisja nuk mund ta ruajë konfirmimin. Provo pasi ta hapësh përsëri aplikacionin.'); }
  }
  try {
    const { actorId: storedActorId, ...request } = intent;
    const result = await requestHandoffReceipts(request);
    clearIntent(actorId, payload.handoffId);
    return result;
  } catch (error) {
    if (error.definitive) clearIntent(actorId, payload.handoffId);
    throw error;
  }
}
