import { getActor } from '@/lib/actorSession';
import { createDurableHandoffIntentStorage } from './handoffReceiptIntentStorage.js';

const PREFIX = 'tepiha_worker_handoff_intent_v1:';
const DECISION_PREFIX = 'tepiha_worker_handoff_expense_intent_v1:';
const REIMBURSEMENT_PREFIX = 'tepiha_worker_handoff_reimbursement_intent_v1:';
const identity = actor => String(actor?.id || actor?.user_id || '');
const activeWorkerSubmissions = new Set();
let workerIntentStorage;
const workerStorageFailure = code => Object.assign(new Error(code), { code, storageCorrupt: true });

function normalizeWorkerIntent(raw, expectedActorId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.actorId !== 'string' || !raw.actorId
    || (expectedActorId !== undefined && raw.actorId !== String(expectedActorId))
    || typeof raw.requestKey !== 'string' || !/^WH1:[A-Za-z0-9:_-]{8,116}$/.test(raw.requestKey)
    || typeof raw.snapshotHash !== 'string' || !/^[a-f0-9]{32,64}$/i.test(raw.snapshotHash)
    || !raw.options || typeof raw.options !== 'object' || Array.isArray(raw.options)
    || typeof raw.physicalCash !== 'number' || !Number.isFinite(raw.physicalCash) || raw.physicalCash < 0
    || (raw.differenceReason !== undefined && typeof raw.differenceReason !== 'string')) {
    throw workerStorageFailure('HANDOFF_RECEIPT_STORAGE_UNCERTAIN');
  }
  // Store exactly the JSON payload which the server will receive, including
  // the original snapshot, options and cash count, without mutable references.
  return { actorId:raw.actorId, requestKey:raw.requestKey, snapshotHash:raw.snapshotHash,
    options:JSON.parse(JSON.stringify(raw.options)), physicalCash:raw.physicalCash,
    differenceReason:raw.differenceReason ?? '' };
}

function submissionStorage() {
  if (!workerIntentStorage) {
    let localStorage, indexedDB;
    try { localStorage = window.localStorage; } catch {}
    try { indexedDB = window.indexedDB; } catch {}
    workerIntentStorage = createDurableHandoffIntentStorage({ localStorage, indexedDB }, {
      normalize: normalizeWorkerIntent,
      keyFor: actorId => PREFIX + actorId,
      database: 'tepiha-worker-handoff-intents-v1',
    });
  }
  return workerIntentStorage;
}

function submissionStorageError(error) {
  const messages = {
    HANDOFF_RECEIPT_STORAGE_UNAVAILABLE: 'Pajisja nuk mund ta ruajë konfirmimin në mënyrë të sigurt. Dorëzimi nuk u dërgua. Kontrollo hapësirën e lirë dhe riprovo.',
    HANDOFF_RECEIPT_STORAGE_UNCERTAIN: 'Konfirmimi i ruajtur nuk mund të kontrollohet ende. Hape përsëri dorëzimin dhe riprovo pa fshirë të dhënat.',
    HANDOFF_RECEIPT_STORAGE_CONFLICT: 'Ka konfirmime të ndryshme të ruajtura. Kontrollo Dorëzimet e mia me dispatch-in para se të vazhdosh.',
    HANDOFF_RECEIPT_PENDING_INTENT: 'Ka një dorëzim që pret përgjigjen. Përdor “Riprovo të njëjtin dorëzim”.',
  };
  return messages[error?.code] ? Object.assign(new Error(messages[error.code]), { code:error.code }) : error;
}
const labels = {
  WHW_SNAPSHOT_CHANGED: 'Pagesat, bonuset ose shpenzimet kanë ndryshuar. Rifresko llogaritjen dhe kontrolloje përsëri.',
  WHW_NO_READY_PAYMENTS: 'Nuk ka pagesa të reja për dorëzim. Dorëzimet e mëparshme gjenden te “Dorëzimet e mia”.',
  WHW_MEAL_CHOICE_REQUIRED: 'Trego çfarë ka ndodhur me ushqimin sot.',
  WHW_MEAL_ALREADY_COVERED: 'Ushqimi i sotëm është regjistruar. Rifresko llogaritjen.',
  WHW_MEAL_PAYER_INVALID: 'Zgjidhe paguesin e ushqimit nga lista.',
  WHW_MEAL_POLICY_CHANGED: 'Rregulli i ushqimit ka ndryshuar. Rifresko llogaritjen.',
  WHW_MEAL_EXPENSE_OVERLAP: 'Ky shpenzim përfshin ushqim të regjistruar më parë. Kontrolloje datën dhe përbërjen me dispatch-in.',
  WHW_FOOD_POLICY_REVIEW_REQUIRED: 'Ky shpenzim ushqimi kërkon sqarim me dispatch-in sipas rregullit të punëtorit.',
  WHW_DAILY_FOOD_CLOSED: 'Ushqimi ditor është mbyllur. Shtesa e ushqimit kalon në rrogën mujore; në dorëzim kontrollohen vetëm regjistrimet e vjetra të vlefshme.',
  WHW_EXPENSE_ALREADY_CLAIMED: 'Ky shpenzim është lidhur me një dorëzim. Rifresko listën.',
  WHW_EXPENSE_CHANGED: 'Shpenzimi ka ndryshuar. Rifresko listën dhe kontrolloje përsëri.',
  WHW_EXPENSE_ALREADY_POSTED: 'Ky shpenzim është regjistruar tashmë si dalje nga arka. Burimi i pagesës kërkon sqarim me dispatch-in përpara rimbursimit.',
  WHW_REIMBURSEMENT_NOT_PENDING: 'Ky rimbursim është trajtuar tashmë ose ende nuk është verifikuar. Rifresko deklarimin.',
  WHW_REIMBURSEMENT_AMOUNT_MISMATCH: 'Shuma e rimbursimit duhet të përputhet me shpenzimin e verifikuar. Rifresko deklarimin.',
  WHW_EXPENSE_INVALID: 'Kontrollo shumën, datën, përshkrimin dhe burimin e parave të shpenzimit.',
  WHW_DIFFERENCE_REASON_REQUIRED: 'Shkruaje arsyen pse shuma e numëruar ndryshon nga llogaritja.',
  WHW_SELF_APPROVAL: 'Shpenzimin tënd duhet ta aprovojë një person tjetër i autorizuar.',
  WHW_ACTUAL_RECEIPT_REQUIRED: 'Regjistro fillimisht shumën që e pranove fizikisht te “Prano paratë”, pastaj shqyrto shpenzimin.',
  WHW_INSUFFICIENT_OUTSTANDING: 'Shuma e mbetur është më e vogël se shpenzimi. Rifresko dorëzimin dhe kontrollo pranimet.',
  WHW_CLAIM_NOT_PENDING: 'Ky shpenzim është shqyrtuar tashmë. Rifresko dorëzimin.',
  WHW_OWN_MONEY_REIMBURSEMENT_PENDING: 'Ky shpenzim është paguar me para personale. Rimbursimi trajtohet veçmas me dispatch-in.',
  WHW_USE_ACTUAL_RECEIPT: 'Për këtë dorëzim përdor “Prano paratë” dhe shkruaje shumën që pranove realisht.',
  WHW_USE_WIZARD: 'Hape përsëri Arkën dhe përdor formularin e ri të dorëzimit me hapa.',
  WHW_MEAL_NOT_ELIGIBLE: 'Sipas regjistrimeve të sotme, ushqimi personal nuk mund të zbritet në këtë dorëzim.',
  WHW_EXPENSES_EXCEED_CASH: 'Shpenzimet nga paratë e klientëve tejkalojnë shumën e këtij dorëzimi. Kontrollo shumat dhe burimin e tyre.',
  WHW_TOO_MANY_PAYMENTS: 'Ka shumë pagesa të hapura. Kërko kontrollin e dispatch-it përpara dorëzimit.',
  WHW_FORBIDDEN: 'Nuk ke të drejtë ta kryesh këtë veprim.',
  WHW_IDEMPOTENCY_CONFLICT: 'Ky konfirmim është përdorur me të dhëna të tjera. Rifresko gjendjen.',
  WORKER_HANDOFF_STALE_PREVIEW: 'Pagesat ose zbritjet kanë ndryshuar. Rifresko llogaritjen dhe kontrolloje përsëri.',
  WORKER_HANDOFF_STATE_CHANGED: 'Gjendja ka ndryshuar. Rifresko llogaritjen përpara dorëzimit.',
  WORKER_HANDOFF_IDEMPOTENCY_CONFLICT: 'Ky konfirmim është përdorur me të dhëna të tjera. Rifresko gjendjen.',
  WORKER_HANDOFF_SESSION_CHANGED: 'Llogaria ka ndryshuar. Hape përsëri dorëzimin.',
  WORKER_HANDOFF_EMPTY: 'Nuk ka pagesa të reja për dorëzim. Dorëzimet e mëparshme gjenden te “Dorëzimet e mia”.',
  WORKER_HANDOFF_MEAL_REQUIRED: 'Trego çfarë ka ndodhur me ushqimin sot.',
  WORKER_HANDOFF_MEAL_INVALID: 'Kontrollo zgjedhjen dhe paguesin e ushqimit.',
  WORKER_HANDOFF_MEAL_SCOPE_REQUIRED: 'Trego nëse shpenzimi i ushqimit përfshin edhe ushqimin tënd.',
  WORKER_HANDOFF_MEAL_OVERLAP: 'Ushqimi yt është përfshirë edhe në shpenzim. Zgjidh vetëm një regjistrim.',
  WORKER_HANDOFF_EXPENSE_ALREADY_CLAIMED: 'Ky shpenzim është lidhur me një dorëzim tjetër. Rifresko listën.',
  WORKER_HANDOFF_EXPENSE_INVALID: 'Plotëso shumën, datën, përshkrimin dhe burimin e parave për shpenzimin.',
  WORKER_HANDOFF_DESCRIPTION_REQUIRED: 'Shkruaje përshkrimin e plotë ose shënimin e verifikimit.',
  WORKER_HANDOFF_EXPENSE_DUPLICATE: 'I njëjti shpenzim është shtuar dy herë.',
  WORKER_HANDOFF_PHYSICAL_CASH_REQUIRED: 'Shkruaj shumën që i numërove fizikisht.',
  WORKER_HANDOFF_REASON_REQUIRED: 'Shkruaje arsyen pse cash-i i numëruar ndryshon nga llogaritja.',
  WORKER_HANDOFF_FUNDING_CONFIRM_REQUIRED: 'Konfirmo burimin e parave për këtë shpenzim.',
  WORKER_HANDOFF_PAID_CONFIRM_REQUIRED: 'Konfirmo që ia pagove fizikisht punëtorit këtë rimbursim.',
  WORKER_HANDOFF_FORBIDDEN: 'Nuk ke të drejtë ta kryesh këtë veprim.',
  WORKER_HANDOFF_SELF_APPROVAL: 'Shpenzimin tënd duhet ta aprovojë një person tjetër i autorizuar.',
  HANDOFF_RECEIPT_STATE_CHANGED: 'Shuma e mbetur ka ndryshuar. Rifresko dorëzimin.',
  HANDOFF_RECEIPT_SELF_APPROVAL: 'Dorëzimin tënd duhet ta pranojë një person tjetër i autorizuar.',
};

export async function requestWorkerHandoff(payload) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Dorëzimi kërkon internet që pagesat dhe zbritjet të verifikohen.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('/api/worker-handoff', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, expectedActorId: actorId }),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      const fallback = /STALE|CHANGED/.test(result?.error || '') ? labels.WORKER_HANDOFF_STALE_PREVIEW
        : /MEAL.*OVERLAP|OWN_MEAL/.test(result?.error || '') ? labels.WORKER_HANDOFF_MEAL_OVERLAP
        : /REASON/.test(result?.error || '') ? labels.WORKER_HANDOFF_REASON_REQUIRED
        : 'Veprimi nuk u konfirmua. Kontrollo të dhënat dhe provo përsëri.';
      const error = new Error(labels[result?.error] || (response.status === 401 ? 'Hyr përsëri në aplikacion.' : fallback));
      error.code = result?.error;
      // Authentication/network failures cannot prove whether an earlier attempt committed.
      error.definitive = [400, 409, 413, 415].includes(response.status);
      throw error;
    }
    if (identity(getActor()) !== actorId) {
      const error = new Error(labels.WORKER_HANDOFF_SESSION_CHANGED);
      error.code = 'WORKER_HANDOFF_SESSION_CHANGED';
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Përgjigjja po vonohet. Përdor “Riprovo të njëjtin dorëzim” që të kontrollohet pa u krijuar dy herë.');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function readWorkerHandoffIntent() {
  const actorId = identity(getActor());
  if (!actorId) return null;
  try {
    return await submissionStorage().read(actorId);
  } catch (error) { throw submissionStorageError(error); }
}

export async function submitWorkerHandoff(payload, { retry = false } = {}) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Dorëzimi kërkon internet që pagesat dhe zbritjet të verifikohen.');
  if (activeWorkerSubmissions.has(actorId)) throw new Error('Ky dorëzim është duke u konfirmuar.');
  const snapshot = retry ? null : JSON.parse(JSON.stringify(payload ?? null));
  activeWorkerSubmissions.add(actorId);
  const save = async () => {
    const storage = submissionStorage();
    let intent = await storage.read(actorId);
    if (intent && !retry) throw new Error('Ka një dorëzim që pret përgjigjen. Përdor “Riprovo të njëjtin dorëzim”.');
    if (!intent) {
      if (retry) throw new Error('Nuk ka dorëzim në pritje për t’u riprovuar.');
      if (!snapshot) throw new Error('Rifresko llogaritjen para dorëzimit.');
      intent = await storage.persist({
        actorId, requestKey: 'WH1:' + crypto.randomUUID(), snapshotHash: snapshot.snapshotHash,
        options: snapshot.options, physicalCash: snapshot.physicalCash, differenceReason: snapshot.differenceReason,
      });
    }
    // The durable fallback is asynchronous. Never submit an old user's intent
    // using a new session, and never POST before verified persistence.
    if (identity(getActor()) !== actorId) throw new Error(labels.WORKER_HANDOFF_SESSION_CHANGED);
    try {
      const { actorId: storedActorId, ...request } = intent;
      const result = await requestWorkerHandoff({ ...request, action: 'submit' });
      await storage.remove(intent).catch(() => {});
      return result;
    } catch (error) {
      if (error.definitive && !/IDEMPOTENCY_CONFLICT/.test(error.code || '')) await storage.remove(intent).catch(() => {});
      throw error;
    }
  };
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
      return await navigator.locks.request('tepiha-worker-handoff:' + actorId, { ifAvailable:true }, lock => {
        if (!lock) throw new Error('Ky dorëzim është duke u konfirmuar.');
        return save();
      });
    }
    return await save();
  } catch (error) { throw submissionStorageError(error); }
  finally { activeWorkerSubmissions.delete(actorId); }
}

export function readWorkerHandoffExpenseIntent(claimId) {
  const actorId = identity(getActor());
  try {
    const value = JSON.parse(localStorage.getItem(DECISION_PREFIX + actorId + ':' + claimId) || 'null');
    return value?.actorId === actorId && String(value?.claimId) === String(claimId) && value?.requestKey ? value : null;
  } catch { return null; }
}

export async function decideWorkerHandoffExpense(payload, { retry = false } = {}) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  const storageKey = DECISION_PREFIX + actorId + ':' + payload.claimId;
  let intent = readWorkerHandoffExpenseIntent(payload.claimId);
  if (intent && !retry) throw new Error('Ky vendim pret përgjigjen. Riprovo të njëjtin vendim.');
  if (!intent) {
    if (retry) throw new Error('Nuk ka vendim në pritje për t’u riprovuar.');
    intent = { actorId, claimId: payload.claimId, approve: payload.approve, note: payload.note,
      confirmFunding: payload.confirmFunding === true, requestKey: 'WHE1:' + crypto.randomUUID() };
    try { localStorage.setItem(storageKey, JSON.stringify(intent)); }
    catch { throw new Error('Pajisja nuk mund ta ruajë konfirmimin. Hape përsëri aplikacionin.'); }
  }
  try {
    const { actorId: storedActorId, ...request } = intent;
    const result = await requestWorkerHandoff({ ...request, action: 'decide-expense' });
    try { localStorage.removeItem(storageKey); } catch {}
    return result;
  } catch (error) {
    if (error.definitive) { try { localStorage.removeItem(storageKey); } catch {} }
    throw error;
  }
}

export function readWorkerHandoffReimbursementIntent(claimId) {
  const actorId = identity(getActor());
  try {
    const value = JSON.parse(localStorage.getItem(REIMBURSEMENT_PREFIX + actorId + ':' + claimId) || 'null');
    return value?.actorId === actorId && String(value?.claimId) === String(claimId) && value?.requestKey ? value : null;
  } catch { return null; }
}

export async function reimburseWorkerHandoffExpense(payload, { retry = false } = {}) {
  const actorId = identity(getActor());
  if (!actorId) throw new Error('Hyr përsëri në aplikacion.');
  const storageKey = REIMBURSEMENT_PREFIX + actorId + ':' + payload.claimId;
  let intent = readWorkerHandoffReimbursementIntent(payload.claimId);
  if (intent && !retry) throw new Error('Ky rimbursim pret përgjigjen. Riprovo të njëjtin rimbursim.');
  if (!intent) {
    if (retry) throw new Error('Nuk ka rimbursim në pritje për t’u riprovuar.');
    intent = { actorId, claimId:payload.claimId, amount:payload.amount, note:payload.note,
      confirmPaid:payload.confirmPaid === true, requestKey:'WHR1:' + crypto.randomUUID() };
    try { localStorage.setItem(storageKey, JSON.stringify(intent)); }
    catch { throw new Error('Pajisja nuk mund ta ruajë konfirmimin. Hape përsëri aplikacionin.'); }
  }
  try {
    const { actorId: storedActorId, ...request } = intent;
    const result = await requestWorkerHandoff({ ...request, action:'reimburse-expense' });
    try { localStorage.removeItem(storageKey); } catch {}
    return result;
  } catch (error) {
    if (error.definitive) { try { localStorage.removeItem(storageKey); } catch {} }
    throw error;
  }
}

export const workerHandoffApi = {
  preview: options => requestWorkerHandoff({ action: 'preview', options: options || {} }),
  submit: submitWorkerHandoff,
  pending: readWorkerHandoffIntent,
  read: handoffId => requestWorkerHandoff({ action: 'read', handoffId }),
  decideExpense: decideWorkerHandoffExpense,
  pendingExpense: readWorkerHandoffExpenseIntent,
  reimburseExpense: reimburseWorkerHandoffExpense,
  pendingReimbursement: readWorkerHandoffReimbursementIntent,
};
