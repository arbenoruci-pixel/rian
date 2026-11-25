import { getActor } from '@/lib/actorSession';
import { createHandoffReceiptIntentStorage } from './handoffReceiptIntentStorage.js';

const identity = actor => String(actor?.id || actor?.user_id || '');
let intentStorage;
const activeSaves = new Set();
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
  HANDOFF_RECEIPT_STORAGE_UNAVAILABLE: 'Pajisja nuk po mund ta ruajë veprimin në mënyrë të sigurt. Pranimi nuk u dërgua. Kontrollo hapësirën e lirë dhe lejen e ruajtjes për aplikacionin, pastaj riprovo.',
  HANDOFF_RECEIPT_STORAGE_UNCERTAIN: 'Konfirmimi i ruajtur nuk mund të kontrollohet ende. Riprovo kontrollin para se të pranosh para.',
  HANDOFF_RECEIPT_STORAGE_CONFLICT: 'Ka konfirmime të ndryshme të ruajtura për këtë dorëzim. Kontrollo historikun e pranimeve para se të vazhdosh.',
  HANDOFF_RECEIPT_PENDING_INTENT: 'Ka një veprim që pret konfirmimin. Përdor “Riprovo të njëjtin veprim”.',
  HANDOFF_RECEIPT_ALREADY_SAVING: 'Ky dorëzim është duke u konfirmuar. Prit përfundimin e veprimit.',
};

function clientError(code) {
  return Object.assign(new Error(labels[code] || code), { code });
}

function readableError(error) {
  if (labels[error?.code]) error.message = labels[error.code];
  return error;
}

function storage() {
  if (!intentStorage) {
    let localStorage, indexedDB;
    try { localStorage = window.localStorage; } catch {}
    try { indexedDB = window.indexedDB; } catch {}
    intentStorage = createHandoffReceiptIntentStorage({ localStorage, indexedDB });
  }
  return intentStorage;
}

export async function requestHandoffReceipts(payload = {}, { expectedActorId } = {}) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  if (expectedActorId && actorId !== expectedActorId) throw clientError('HANDOFF_RECEIPT_SESSION_CHANGED');
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
      error.definitive = response.status >= 400 && response.status < 500 && ![401, 403].includes(response.status);
      throw error;
    }
    if (identity(getActor()) !== actorId) throw new Error(labels.HANDOFF_RECEIPT_SESSION_CHANGED);
    return result;
  } finally { clearTimeout(timer); }
}

export async function readHandoffReceiptIntent(actorId, handoffId, { serverRecovery = false } = {}) {
  try {
    return await storage().read(actorId, handoffId, { serverRecovery });
  } catch (error) { throw readableError(error); }
}

export async function saveHandoffReceipt(payload, { retry = false, serverRecovery = false } = {}) {
  payload = Object.freeze({ ...payload });
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Pranimi dhe sqarimi i parave kërkojnë internet.');
  const scope = `${actorId}:${payload.handoffId}`;
  if (activeSaves.has(scope)) throw clientError('HANDOFF_RECEIPT_ALREADY_SAVING');
  activeSaves.add(scope);
  const save = async () => {
    let intent = await readHandoffReceiptIntent(actorId, payload.handoffId, { serverRecovery });
    if (intent && !retry) throw clientError('HANDOFF_RECEIPT_PENDING_INTENT');
    if (!intent) {
      if (retry) throw new Error('Nuk ka veprim në pritje. Rifresko dorëzimin.');
      const requestKey = serverRecovery
        ? `HR1:STATE:${Number(payload.handoffId)}:${Math.round(Number(payload.expectedOutstanding)*100)}:${Math.round(Number(payload.amount)*100)}:${payload.action}`
        : 'HR1:' + crypto.randomUUID();
      intent = await storage().persist({ ...payload, actorId, requestKey }, { serverRecovery });
    }
    // The storage fallback is asynchronous. A changed session must never send
    // the previous operator's saved request using a different operator's cookie.
    if (identity(getActor()) !== actorId) throw clientError('HANDOFF_RECEIPT_SESSION_CHANGED');
    try {
      const { actorId: storedActorId, ...request } = intent;
      const result = await requestHandoffReceipts(request, { expectedActorId: actorId });
      // Failed cleanup leaves an exact replay available; it must not turn a
      // confirmed server receipt into a second fresh financial request.
      await storage().remove(intent).catch(() => {});
      return result;
    } catch (error) {
      if (error.definitive && !['HANDOFF_RECEIPT_IDEMPOTENCY_CONFLICT', 'HANDOFF_RECEIPT_FORBIDDEN'].includes(error.code)) {
        await storage().remove(intent).catch(() => {});
      }
      throw error;
    }
  };
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
      return await navigator.locks.request(`tepiha-handoff-receipt:${scope}`, { ifAvailable: true }, lock => {
        if (!lock) throw clientError('HANDOFF_RECEIPT_ALREADY_SAVING');
        return save();
      });
    }
    return await save();
  } catch (error) {
    throw readableError(error);
  } finally { activeSaves.delete(scope); }
}
