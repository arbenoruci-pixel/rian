// lib/syncManager.js
// Robust Outbox / Sync Manager (localStorage) for BASE + TRANSPORT.
//
// Goals:
// - Local-first: every SAVE is persisted locally as PENDING before any network call.
// - Auto retry: on app open + when internet returns + periodic.
// - Idempotent: UNIQUE conflicts are treated as success if the row already exists.
// - Safe: never crashes UI.

import supabaseDefault, { supabase as supabaseNamed } from '@/lib/supabaseClient';
const supabase = supabaseNamed || supabaseDefault;

const OUTBOX_KEY = 'tepiha_outbox_v1';
const LOCK_KEY = 'tepiha_outbox_lock_v1';

const DEFAULTS = {
  maxAttempts: 30,
  backoffMs: (attempts) => {
    if (attempts <= 0) return 500;
    if (attempts === 1) return 1500;
    if (attempts === 2) return 4000;
    if (attempts === 3) return 10000;
    return 30000;
  },
};

function safeJsonParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function isBrowser() {
  return typeof window !== 'undefined';
}

function isOnline() {
  try {
    return typeof navigator === 'undefined' ? true : !!navigator.onLine;
  } catch {
    return true;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function rid() {
  return `obx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function loadOutbox() {
  if (!isBrowser()) return [];
  return safeJsonParse(localStorage.getItem(OUTBOX_KEY), []);
}

function saveOutbox(items) {
  if (!isBrowser()) return;
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
}

function normalizeErr(err) {
  if (!err) return null;
  return {
    code: err.code ?? null,
    message: err.message ?? String(err),
    details: err.details ?? null,
    hint: err.hint ?? null,
  };
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || err.details || '').toLowerCase();
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}

// --- Lock (avoid parallel sync in multiple tabs/effects) ---

function acquireLock() {
  if (!isBrowser()) return false;
  const now = Date.now();
  const lock = safeJsonParse(localStorage.getItem(LOCK_KEY), null);
  if (lock?.until && now < lock.until) return false;
  localStorage.setItem(LOCK_KEY, JSON.stringify({ until: now + 30000 }));
  return true;
}

function releaseLock() {
  if (!isBrowser()) return;
  localStorage.removeItem(LOCK_KEY);
}

// --- Outbox primitives ---

export function enqueueOutboxItem({
  kind,
  table,
  payload,
  op = 'upsert',
  onConflict = null,
  uniqueField = null,
  uniqueValue = null,
}) {
  const item = {
    id: rid(),
    kind, // 'base' | 'transport'
    table, // 'orders' | 'transport_orders'
    op, // 'insert' | 'upsert' | 'update'
    onConflict, // for upsert
    payload,
    uniqueField,
    uniqueValue: uniqueValue == null ? null : String(uniqueValue),
    status: 'pending',
    attempts: 0,
    createdAt: nowIso(),
    lastAttemptAt: null,
    lastError: null,
  };

  const list = loadOutbox();
  list.push(item);
  saveOutbox(list);
  return item;
}

function patchItem(id, patch) {
  const list = loadOutbox();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return;
  list[i] = { ...list[i], ...patch };
  saveOutbox(list);
}

function removeItem(id) {
  const list = loadOutbox().filter((x) => x.id !== id);
  saveOutbox(list);
}

async function existsInDb(table, uniqueField, uniqueValue) {
  if (!uniqueField || uniqueValue == null) return false;
  const { data, error } = await supabase.from(table).select(uniqueField).eq(uniqueField, uniqueValue).limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

async function sendItem(item) {
  if (!isOnline()) {
    return { ok: false, retry: true, error: { message: 'OFFLINE' } };
  }

  // Idempotency fingerprint (survives retries / app restarts)
  // Stored inside data._idem (both orders & transport_orders have a JSONB 'data' column).
  const _idem = `${item.table}:${item.uniqueField}:${item.uniqueValue}`;
  item.payload = { ...item.payload, data: { ...(item.payload?.data || {}), _idem } };

  try {
    if (item.op === 'insert') {
      const { error } = await supabase.from(item.table).insert(item.payload);
      if (!error) return { ok: true };
      if (isUniqueViolation(error)) {
        const ok = await existsInDb(item.table, item.uniqueField, item.uniqueValue);
        return ok ? { ok: true } : { ok: false, retry: true, error: normalizeErr(error) };
      }
      return { ok: false, retry: true, error: normalizeErr(error) };
    }

    if (item.op === 'update') {
      // payload should include: { values, match: { field, value } }
      const values = item?.payload?.values;
      const match = item?.payload?.match;
      if (!values || !match?.field) return { ok: false, retry: false, error: { message: 'BAD_UPDATE_PAYLOAD' } };
      const { error } = await supabase.from(item.table).update(values).eq(match.field, match.value);
      if (!error) return { ok: true };
      return { ok: false, retry: true, error: normalizeErr(error) };
    }

    // default: upsert
    const opts = item.onConflict ? { onConflict: item.onConflict } : undefined;
    const { error } = await supabase.from(item.table).upsert(item.payload, opts);
    if (!error) return { ok: true };

    if (isUniqueViolation(error)) {
      const ok = await existsInDb(item.table, item.uniqueField, item.uniqueValue);
      return ok ? { ok: true } : { ok: false, retry: true, error: normalizeErr(error) };
    }

    return { ok: false, retry: true, error: normalizeErr(error) };
  } catch (e) {
    return { ok: false, retry: true, error: { message: String(e?.message || e) } };
  }
}

export async function syncNow(options = {}) {
  if (!isBrowser()) return { ok: false, sent: 0, pending: 0 };

  const cfg = { ...DEFAULTS, ...options };

  if (!acquireLock()) {
    const pending = loadOutbox().filter((x) => x.status === 'pending').length;
    return { ok: true, sent: 0, pending };
  }

  try {
    const list = loadOutbox();
    const pending = list.filter((x) => x.status === 'pending');
    let sent = 0;

    for (const item of pending) {
      const attempts = Number(item.attempts || 0);
      if (attempts >= cfg.maxAttempts) {
        patchItem(item.id, { status: 'failed', lastError: { message: 'MAX_ATTEMPTS' }, lastAttemptAt: nowIso() });
        continue;
      }

      const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : 0;
      const waitMs = cfg.backoffMs(attempts);
      if (lastAt && Date.now() - lastAt < waitMs) continue;

      patchItem(item.id, { attempts: attempts + 1, lastAttemptAt: nowIso() });
      const res = await sendItem(item);
      if (res.ok) {
        removeItem(item.id);
        sent += 1;
      } else {
        patchItem(item.id, { lastError: res.error || { message: 'SEND_FAILED' } });
      }
    }

    const left = loadOutbox().filter((x) => x.status === 'pending').length;
    return { ok: true, sent, pending: left };
  } finally {
    releaseLock();
  }
}

// --- Convenience wrappers for TEPIHA tables ---

export function enqueueBaseOrder(row) {
  // orders: UNIQUE(local_oid)
  return enqueueOutboxItem({
    kind: 'base',
    table: 'orders',
    op: 'upsert',
    onConflict: 'local_oid',
    payload: row,
    uniqueField: 'local_oid',
    uniqueValue: row?.local_oid,
  });
}

export function enqueueTransportOrder(row) {
  // transport_orders: UNIQUE(id)
  return enqueueOutboxItem({
    kind: 'transport',
    table: 'transport_orders',
    op: 'upsert',
    onConflict: 'id',
    payload: row,
    uniqueField: 'id',
    uniqueValue: row?.id,
  });
}

export function startAutoSync() {
  if (!isBrowser()) return () => {};
  let stopped = false;

  const kick = async () => {
    if (stopped) return;
    try {
      await syncNow();
    } catch {
      // never crash UI
    }
  };

  kick();

  const onOnline = () => kick();
  window.addEventListener('online', onOnline);

  const t = setInterval(kick, 15000);

  return () => {
    stopped = true;
    window.removeEventListener('online', onOnline);
    clearInterval(t);
  };
}

// Debug helpers
export function getOutboxSnapshot() {
  return loadOutbox();
}

export function clearOutbox() {
  saveOutbox([]);
}