import { getActor } from '@/lib/actorSession';
import { queueOp } from '@/lib/offlineSyncClient';
import { supabase } from '@/lib/supabaseClient';
import { listUsers } from '@/lib/usersDb';

export const BASE_READY_BONUS_RATE_M2 = 0.10;
export const BASE_READY_BONUS_WINDOW_HOURS = 48;
export const BASE_READY_BONUS_TYPE = 'READY_48H_BONUS';
export const BASE_READY_BONUS_VERSION = 'base-ready-48h-bonus-v1';

const WORKER_CACHE_KEY = 'tepiha_base_ready_bonus_workers_v1';
const SUMMARY_CACHE_PREFIX = 'tepiha_base_ready_bonus_summary_v1:';
const WORKER_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE']);
const MANAGER_ROLES = new Set(['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);

function text(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function upper(value) {
  return text(value).toUpperCase();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isBrowser() {
  return typeof window !== 'undefined';
}

function isOnline() {
  try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJson(key, fallback) {
  if (!isBrowser()) return fallback;
  try { return safeParse(window.localStorage.getItem(key), fallback); } catch { return fallback; }
}

function writeJson(key, value) {
  if (!isBrowser()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function todayKey() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Belgrade',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (kind) => parts.find((part) => part.type === kind)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeWorker(user = {}) {
  return {
    id: user?.id || user?.user_id || null,
    pin: text(user?.pin),
    name: text(user?.name || user?.full_name || user?.pin || 'PUNËTOR'),
    role: upper(user?.role || 'PUNTOR'),
    is_active: user?.is_active !== false,
  };
}

export function isBaseReadyBonusWorkerRole(role) {
  return WORKER_ROLES.has(upper(role));
}

export function canManageBaseReadyBonuses(role) {
  return MANAGER_ROLES.has(upper(role));
}

function readWorkerCache() {
  const stored = readJson(WORKER_CACHE_KEY, null);
  const rows = Array.isArray(stored?.workers) ? stored.workers : [];
  return rows.map(normalizeWorker).filter((row) => row.pin && row.is_active && isBaseReadyBonusWorkerRole(row.role));
}

function persistWorkers(rows = []) {
  const workers = (Array.isArray(rows) ? rows : [])
    .map(normalizeWorker)
    .filter((row) => row.pin && row.is_active && isBaseReadyBonusWorkerRole(row.role));
  const byPin = new Map();
  workers.forEach((row) => byPin.set(row.pin, row));
  writeJson(WORKER_CACHE_KEY, {
    version: BASE_READY_BONUS_VERSION,
    saved_at: new Date().toISOString(),
    workers: [...byPin.values()],
  });
  return [...byPin.values()];
}

function rememberWorker(worker = {}) {
  const next = normalizeWorker(worker);
  if (!next.pin || !isBaseReadyBonusWorkerRole(next.role)) return next;
  const rows = readWorkerCache();
  const byPin = new Map(rows.map((row) => [row.pin, row]));
  byPin.set(next.pin, next);
  persistWorkers([...byPin.values()]);
  return next;
}

export async function warmBaseReadyBonusWorkerCache() {
  if (!isOnline()) return readWorkerCache();
  try {
    const result = await listUsers({ includeInactive: false });
    if (!result?.ok) return readWorkerCache();
    return persistWorkers(result?.items || []);
  } catch {
    return readWorkerCache();
  }
}

async function validateWorkerPinOnline(pin) {
  const response = await fetch('/api/auth/validate-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error || `PIN_VERIFY_HTTP_${response.status}`);
  }
  const worker = normalizeWorker(json?.user || { pin });
  if (!worker.pin || !worker.is_active || !isBaseReadyBonusWorkerRole(worker.role)) {
    throw new Error('PIN_NUK_ESHTE_BAZIST_AKTIV');
  }
  return rememberWorker(worker);
}

export async function resolveBaseReadyBonusWorker({
  label = 'JEP PIN-IN E PUNËTORIT QË E PËRFUNDOI KËTË POROSI',
  forcePrompt = false,
} = {}) {
  if (!isBrowser()) return null;
  const actor = normalizeWorker(getActor() || {});
  const isBaseTerminal = window.localStorage.getItem('TEPIHA_BASE_TERMINAL') === '1';
  const canUseActor = actor.pin && actor.is_active && isBaseReadyBonusWorkerRole(actor.role);
  const mustPrompt = forcePrompt || isBaseTerminal || !canUseActor;

  let pin = canUseActor ? actor.pin : '';
  if (mustPrompt) {
    const entered = window.prompt(
      `${label}\n\nBONUSI: 0.10€ PËR m² NËSE POROSIA U KRYE BRENDA 48 ORËVE.`,
      canUseActor && !isBaseTerminal ? actor.pin : ''
    );
    if (entered == null) return null;
    pin = text(entered);
    if (!pin) return null;
  }

  if (isOnline()) {
    try {
      return await validateWorkerPinOnline(pin);
    } catch (error) {
      window.alert(`PIN GABIM OSE PUNËTORI NUK ËSHTË AKTIV. ${text(error?.message || error)}`);
      return null;
    }
  }

  if (canUseActor && actor.pin === pin) return rememberWorker(actor);
  const cached = readWorkerCache().find((row) => row.pin === pin);
  if (cached) return cached;

  window.alert('OFFLINE: KY PIN NUK ËSHTË NË LISTËN E FUNDIT TË PUNËTORËVE. HAPE NJËHERË APP-IN ONLINE.');
  return null;
}

function isNetworkLikeError(error) {
  const value = text(error?.message || error).toLowerCase();
  return (
    value.includes('failed to fetch') ||
    value.includes('network') ||
    value.includes('load failed') ||
    value.includes('timeout') ||
    value.includes('abort') ||
    value.includes('offline')
  );
}

function normalizeSlots(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => upper(value))
    .filter(Boolean))];
}

export function buildBaseReadyBonusIdempotencyKey(orderRef) {
  return `BASE_READY_48H_BONUS:${text(orderRef)}`;
}

export async function markBaseOrderReadyWithBonus({
  orderRef,
  worker,
  readySlots = [],
  readyNote = '',
  readyAt = new Date().toISOString(),
  idempotencyKey = '',
  forceQueue = false,
} = {}) {
  const ref = text(orderRef);
  const stageActor = normalizeWorker(worker || getActor() || {});
  const slots = normalizeSlots(readySlots);
  const idem = text(idempotencyKey) || buildBaseReadyBonusIdempotencyKey(ref);
  if (!ref) throw new Error('MUNGON ORDER ID PËR BONUSIN 48H.');
  if (!stageActor.pin) throw new Error('MUNGON PIN-I I PËRDORUESIT QË PO E BËN GATI.');
  if (!slots.length) throw new Error('MUNGON RAFTI / LOKACIONI FINAL.');

  const rpcArgs = {
    p_order_ref: ref,
    p_worker_pin: stageActor.pin,
    p_ready_slots: slots,
    p_ready_note: text(readyNote) || null,
    p_ready_at: readyAt || new Date().toISOString(),
    p_idempotency_key: idem,
  };

  if (!forceQueue && isOnline()) {
    const { data, error } = await supabase.rpc('mark_base_order_ready_with_bonus_v1', rpcArgs);
    if (!error && data?.ok) {
      return {
        ...data,
        offlineQueued: false,
        idempotencyKey: idem,
        stageActor,
      };
    }
    if (error && !isNetworkLikeError(error)) throw error;
  }

  const queuedOpId = await queueOp('base_ready_bonus_transition', {
    ...rpcArgs,
    table: 'orders',
    id: ref,
    order_id: ref,
    worker: stageActor,
    idempotency_key: idem,
    queued_at: new Date().toISOString(),
    activation_rule: 'FULL_PAYMENT_ACTOR',
  });

  return {
    ok: true,
    waitingForPayment: true,
    offlineQueued: true,
    queuedOpId,
    worker: stageActor,
    stageActor,
    idempotencyKey: idem,
    bonus: null,
    summary: null,
  };
}

function summaryCacheKey(actorPin, workerPin, date) {
  return `${SUMMARY_CACHE_PREFIX}${text(actorPin)}:${text(workerPin || 'SELF')}:${text(date || todayKey())}`;
}

export function readCachedBaseReadyBonusSummary({ actorPin, workerPin = '', date = '' } = {}) {
  const cached = readJson(summaryCacheKey(actorPin, workerPin, date), null);
  return cached?.summary || null;
}

export async function getBaseReadyBonusSummary({
  actorPin,
  workerPin = '',
  date = '',
  allowCache = true,
} = {}) {
  const actor = text(actorPin || getActor()?.pin);
  if (!actor) throw new Error('MUNGON PIN-I PËR BONUSIN 48H.');
  const cleanDate = text(date || todayKey()).slice(0, 10);
  const cleanWorker = text(workerPin || actor);
  const key = summaryCacheKey(actor, cleanWorker, cleanDate);

  if (isOnline()) {
    const { data, error } = await supabase.rpc('get_base_ready_bonus_summary_v1', {
      p_actor_pin: actor,
      p_worker_pin: cleanWorker || null,
      p_date: cleanDate,
    });
    if (!error && data) {
      writeJson(key, { saved_at: new Date().toISOString(), summary: data });
      return { ...data, _offlineSnapshot: false };
    }
    if (error && !allowCache) throw error;
  }

  const cached = allowCache ? readJson(key, null) : null;
  if (cached?.summary) return { ...cached.summary, _offlineSnapshot: true, _cachedAt: cached.saved_at || null };
  throw new Error('NUK KA SNAPSHOT TË BONUSIT. HAPE NJËHERË ONLINE.');
}

export async function listOpenBaseReadyBonusPayments(actorPin) {
  const pin = text(actorPin || getActor()?.pin);
  if (!pin) return [];
  if (!isOnline()) return [];
  const { data, error } = await supabase.rpc('list_worker_open_ready_bonus_payments_v1', {
    p_actor_pin: pin,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : [])
    .map((row) => ({
      payment_id: number(row?.payment_id, 0),
      bonus_id: number(row?.bonus_id, 0),
      remaining_amount: Number(number(row?.remaining_amount, 0).toFixed(2)),
      order_id: number(row?.order_id, 0),
      order_code: number(row?.order_code, 0),
      ready_at: row?.ready_at || null,
    }))
    .filter((row) => row.payment_id > 0 && row.remaining_amount > 0.005);
}

export function computeReadyBonusDeductionForCash(cashAmount, availableBonus) {
  const cash = Math.max(0, number(cashAmount, 0));
  const bonus = Math.max(0, number(availableBonus, 0));
  if (cash <= 0.01 || bonus <= 0) return 0;
  return Number(Math.min(bonus, Math.max(0, cash - 0.01)).toFixed(2));
}

export function describeReadyBonusResult(result = {}) {
  if (result?.offlineQueued) {
    return 'U RUAJT OFFLINE. GATI DHE BONUSI VERIFIKOHEN AUTOMATIKISHT KUR VJEN RRJETI.';
  }
  const bonus = result?.bonus || result?.activation?.bonus || null;
  const summary = result?.summary || result?.activation?.summary || {};
  const totals = summary?.totals || {};
  if (bonus?.eligible) {
    return [
      `BONUS +${number(bonus?.amount, 0).toFixed(2)}€`,
      `PIN-I I PAGESËS: ${text(bonus?.worker_pin || '—')}`,
      `SOT ${number(totals?.today_earned, 0).toFixed(2)}€`,
      `PËR ME MBAJT ${number(totals?.available_to_keep, 0).toFixed(2)}€`,
    ].join(' • ');
  }
  if (result?.waitingForPayment !== false) {
    return 'GATI U RUAJT. BONUSI 48H AKTIVIZOHET KUR REGJISTROHET PAGESA QË E MBYLL POROSINË.';
  }
  return `PA BONUS • ${text(bonus?.reason || result?.activation?.reason || 'NUK U AKTIVIZUA NË PAGESË')}`;
}

// BASE_PAYMENT_48H_BONUS_V2:CLIENT — GATI stages eligibility; the full-payment actor owns activation.
