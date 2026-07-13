import { supabase } from './supabaseClient';
import { ARKA_ACTION, ARKA_SOURCE_MODULE } from './arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from './arka/arkaClient';

const INSTALL_KEY = '__TEPIHA_DISPATCH_ADVANCE_BRIDGE_V1__';
const BUSY_KEY = 'dispatchAdvanceBusy';
const IDEMPOTENCY_KEY = 'dispatchAdvanceIdempotency';

function safeJson(raw, fallback = null) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function currentActor() {
  try {
    return safeJson(window.localStorage?.getItem?.('CURRENT_USER_DATA'), null);
  } catch {
    return null;
  }
}

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseAmount(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function euro(value) {
  return `€${Number(value || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function errorMessage(error) {
  return String(error?.message || error?.details || error?.hint || error || 'ADVANCE_SAVE_FAILED');
}

function isPayrollAdvanceButton(button) {
  if (!button) return false;
  if (String(window.location?.pathname || '') !== '/arka/payroll') return false;
  const text = normalizeText(button.textContent).toUpperCase();
  if (!text.includes('RUAJ AVANSIN') && !text.includes('PO REGJISTROHET')) return false;
  const modal = button.closest?.('.fullModal');
  if (!modal) return false;
  const title = normalizeText(modal.querySelector?.('.modalTitle')?.textContent).toUpperCase();
  return title.includes('SHTO AVANS');
}

async function resolveWorkerByName(workerName) {
  const name = normalizeText(workerName);
  if (!name) throw new Error('MUNGON_PUNTORI');

  const { data, error } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active')
    .eq('is_active', true)
    .ilike('name', name)
    .limit(3);

  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const exact = rows.filter((row) => normalizeText(row?.name).toUpperCase() === name.toUpperCase());
  if (exact.length !== 1 || !String(exact[0]?.pin || '').trim()) {
    throw new Error(exact.length > 1 ? 'PUNTORI_NUK_ESHTE_UNIK' : 'PUNTORI_NUK_U_GJET');
  }
  return exact[0];
}

async function saveDispatchAdvance(button) {
  if (button?.dataset?.[BUSY_KEY] === '1') return;

  const actor = currentActor();
  if (normalizeRole(actor?.role) !== 'DISPATCH') return;
  if (!String(actor?.pin || '').trim()) throw new Error('MUNGON_PIN_I_DISPATCH');

  const modal = button.closest('.fullModal');
  const amountInput = modal?.querySelector('input[type="number"]');
  const textInputs = Array.from(modal?.querySelectorAll('input[type="text"]') || []);
  const noteInput = textInputs[0] || null;
  const workerName = normalizeText(modal?.querySelector('.modalWorker')?.textContent);
  const amount = parseAmount(amountInput?.value);
  const note = normalizeText(noteInput?.value) || 'AVANS';

  if (!(amount > 0)) {
    window.alert('Shkruaj shumen e avansit.');
    amountInput?.focus?.();
    return;
  }

  const worker = await resolveWorkerByName(workerName);
  const confirmed = window.confirm(`A deshironi te regjistroni avans ${euro(amount)} per ${worker?.name || workerName}?`);
  if (!confirmed) return;

  const originalText = button.textContent;
  button.dataset[BUSY_KEY] = '1';
  button.disabled = true;
  button.textContent = 'PO REGJISTROHET...';

  try {
    let requestKey = button.dataset[IDEMPOTENCY_KEY];
    if (!requestKey) {
      requestKey = buildArkaIdempotencyKey(
        ARKA_ACTION.EXPENSE_REQUEST,
        [worker.pin, 'ADVANCE', amount],
        { randomSuffix: true },
      );
      button.dataset[IDEMPOTENCY_KEY] = requestKey;
    }

    const result = await arkaTransaction({
      action: ARKA_ACTION.EXPENSE_REQUEST,
      actorPin: String(actor.pin).trim(),
      actorName: actor?.name || 'DISPATCH',
      actorRole: actor?.role || 'DISPATCH',
      workerPin: String(worker.pin).trim(),
      workerName: worker?.name || workerName,
      paymentType: 'ADVANCE',
      sourceModule: ARKA_SOURCE_MODULE.ARKA,
      status: 'ADVANCE',
      amount,
      note,
      idempotencyKey: requestKey,
    });

    if (!result?.ok) throw new Error(result?.error || 'ADVANCE_SAVE_FAILED');
    window.alert(`Avansi ${euro(amount)} u regjistrua per ${worker?.name || workerName}.`);
    window.location.reload();
  } finally {
    button.dataset[BUSY_KEY] = '0';
    button.disabled = false;
    button.textContent = originalText;
  }
}

export function installDispatchAdvanceBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  document.addEventListener('click', (event) => {
    const button = event?.target?.closest?.('button');
    if (!isPayrollAdvanceButton(button)) return;
    const actor = currentActor();
    if (normalizeRole(actor?.role) !== 'DISPATCH') return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    void saveDispatchAdvance(button).catch((error) => {
      try {
        button.dataset[BUSY_KEY] = '0';
        button.disabled = false;
        button.textContent = 'RUAJ AVANSIN';
      } catch {}
      window.alert(`GABIM: ${errorMessage(error)}`);
    });
  }, true);
}

export default installDispatchAdvanceBridge;
