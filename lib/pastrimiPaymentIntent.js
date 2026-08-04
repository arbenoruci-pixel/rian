import { queueOp } from '@/lib/offlineSyncClient';

const KEY = 'tepiha_pastrimi_payment_intents_v1';
const LIMIT = 100;
let flushing = null;
let installed = false;

function text(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function readAll() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeAll(rows = []) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify((Array.isArray(rows) ? rows : []).slice(-LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function savePastrimiPaymentIntent(intent = {}) {
  const idempotencyKey = text(intent?.idempotencyKey || intent?.idempotency_key);
  if (!idempotencyKey) throw new Error('PASTRIMI_PAYMENT_INTENT_IDEMPOTENCY_REQUIRED');
  const rows = readAll();
  const next = {
    ...intent,
    idempotencyKey,
    idempotency_key: idempotencyKey,
    saved_at: intent?.saved_at || new Date().toISOString(),
    saved_ts: Number(intent?.saved_ts || Date.now()),
    attempts: Number(intent?.attempts || 0),
  };
  const index = rows.findIndex((row) => text(row?.idempotencyKey || row?.idempotency_key) === idempotencyKey);
  if (index >= 0) rows[index] = { ...rows[index], ...next };
  else rows.push(next);
  if (!writeAll(rows)) throw new Error('PASTRIMI_PAYMENT_INTENT_STORAGE_FAILED');
  return next;
}

export function removePastrimiPaymentIntent(idempotencyKey) {
  const key = text(idempotencyKey);
  if (!key) return false;
  const rows = readAll();
  const filtered = rows.filter((row) => text(row?.idempotencyKey || row?.idempotency_key) !== key);
  return filtered.length === rows.length ? false : writeAll(filtered);
}

export function listPastrimiPaymentIntents() {
  return readAll();
}

export async function enqueuePastrimiPaymentIntent(intent = {}) {
  const stored = savePastrimiPaymentIntent(intent);
  const transaction = stored?.transaction && typeof stored.transaction === 'object'
    ? stored.transaction
    : null;
  if (!transaction) throw new Error('PASTRIMI_PAYMENT_INTENT_TRANSACTION_REQUIRED');

  const opId = await queueOp('arka_transaction', { transaction });
  if (!opId) throw new Error('PASTRIMI_PAYMENT_INTENT_QUEUE_FAILED');
  removePastrimiPaymentIntent(stored.idempotencyKey);
  try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
  return opId;
}

export async function flushPastrimiPaymentIntents() {
  if (typeof window === 'undefined') return { queued: 0, pending: 0 };
  if (flushing) return flushing;
  flushing = (async () => {
    let queued = 0;
    const rows = readAll();
    for (const item of rows) {
      try {
        await enqueuePastrimiPaymentIntent({
          ...item,
          attempts: Number(item?.attempts || 0) + 1,
          last_attempt_at: new Date().toISOString(),
        });
        queued += 1;
      } catch {
        try {
          savePastrimiPaymentIntent({
            ...item,
            attempts: Number(item?.attempts || 0) + 1,
            last_attempt_at: new Date().toISOString(),
          });
        } catch {}
      }
    }
    return { queued, pending: readAll().length };
  })().finally(() => { flushing = null; });
  return flushing;
}

export function installPastrimiPaymentIntentAutoFlush() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  const run = () => { void flushPastrimiPaymentIntents(); };
  window.setTimeout(run, 500);
  window.addEventListener('online', run);
  window.addEventListener('pageshow', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
}

if (typeof window !== 'undefined') installPastrimiPaymentIntentAutoFlush();
