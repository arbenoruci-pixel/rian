import { supabase } from '@/lib/supabaseClient';
import { clearPageSnapshot } from '@/lib/pageSnapshotCache';
import {
  getAllOrdersLocal,
  getPendingOps,
  saveOrderLocal,
  deleteOrderLocal,
} from '@/lib/offlineStore';
import { rebuildBaseMasterCacheFromOrders } from '@/lib/baseMasterCache';

const VERSION = 'online-db-truth-recovery-v1';
const MIN_GAP_MS = 30_000;
const DB_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

let installed = false;
let running = null;
let lastRunAt = 0;
let timer = null;

function online() {
  try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch { return true; }
}

function isBaseOrder(row = {}) {
  return String(row?.table || row?._table || 'orders').trim() === 'orders';
}

function localOidOf(row = {}) {
  return String(row?.local_oid || row?.oid || row?.data?.local_oid || row?.data?.oid || '').trim();
}

function idOf(row = {}) {
  return String(row?.id || row?.data?.id || '').trim();
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function statusOf(row = {}) {
  return String(row?.status || row?.data?.status || row?.data?.state || '').trim().toLowerCase();
}

function pendingLike(row = {}) {
  return Boolean(
    row?._local === true ||
    row?._synced === false ||
    row?._syncPending === true ||
    row?._outboxPending === true ||
    row?._syncFailed === true ||
    Number(row?.pending_ops || 0) > 0
  );
}

function opTokens(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const set = new Set();
  const id = String(payload?.id || data?.id || op?.id || '').trim();
  const localOid = String(payload?.local_oid || data?.local_oid || data?.oid || '').trim();
  if (id) set.add(`id:${id}`);
  if (localOid) set.add(`local:${localOid}`);
  return set;
}

function rowTokens(row = {}) {
  const set = new Set();
  const id = idOf(row);
  const localOid = localOidOf(row);
  if (id) set.add(`id:${id}`);
  if (localOid) set.add(`local:${localOid}`);
  return set;
}

function hasPendingMatch(row, pendingTokens) {
  if (pendingLike(row)) return true;
  for (const token of rowTokens(row)) {
    if (pendingTokens.has(token)) return true;
  }
  return false;
}

function withTimeout(promise, ms, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(label || 'DB_TRUTH_TIMEOUT');
      error.name = 'AbortError';
      reject(error);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function fetchAllBaseOrders() {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const query = supabase
      .from('orders')
      .select('id,local_oid,status,created_at,updated_at,data,code,client_id,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront')
      .order('id', { ascending: true })
      .range(from, to);
    const { data, error } = await withTimeout(query, DB_TIMEOUT_MS, 'DB_TRUTH_ORDERS_TIMEOUT');
    if (error) throw error;
    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }
  return rows;
}

function dispatchRecovery(detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent('tepiha:db-truth-recovered', { detail }));
    window.dispatchEvent(new Event('tepiha:outbox-changed'));
    window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));
    window.dispatchEvent(new Event('arka:refresh'));
  } catch {}
}

function writeMarker(payload) {
  try {
    window.localStorage?.setItem?.('tepiha_online_db_truth_recovery_last_v1', JSON.stringify(payload));
  } catch {}
  try { window.__TEPIHA_ONLINE_DB_TRUTH_RECOVERY__ = payload; } catch {}
}

export async function reconcileOnlineDbTruth({ force = false, source = 'manual' } = {}) {
  if (!online()) return { ok: false, skipped: true, reason: 'OFFLINE', version: VERSION };
  const now = Date.now();
  if (!force && now - lastRunAt < MIN_GAP_MS) return { ok: true, skipped: true, reason: 'THROTTLED', version: VERSION };
  if (running) return running;

  running = (async () => {
    const startedAt = Date.now();
    const [dbRows, localRows, pendingOps] = await Promise.all([
      fetchAllBaseOrders(),
      getAllOrdersLocal().catch(() => []),
      getPendingOps().catch(() => []),
    ]);

    const pendingTokens = new Set();
    (Array.isArray(pendingOps) ? pendingOps : []).forEach((op) => {
      opTokens(op).forEach((token) => pendingTokens.add(token));
    });

    const dbById = new Map();
    const dbByLocal = new Map();
    dbRows.forEach((row) => {
      const id = idOf(row);
      const localOid = localOidOf(row);
      if (id) dbById.set(id, row);
      if (localOid) dbByLocal.set(localOid, row);
    });

    let hydrated = 0;
    for (const row of dbRows) {
      try {
        await saveOrderLocal({
          ...row,
          table: 'orders',
          _local: false,
          _synced: true,
          _syncPending: false,
          _syncFailed: false,
          server_id: String(row?.id || ''),
        }, true);
        hydrated += 1;
      } catch {}
    }

    let removedAliases = 0;
    let removedMissing = 0;
    const preservedPending = [];

    for (const local of Array.isArray(localRows) ? localRows : []) {
      if (!isBaseOrder(local)) continue;
      const localId = idOf(local);
      const localOid = localOidOf(local);
      const dbMatch = (localId && dbById.get(localId)) || (localOid && dbByLocal.get(localOid)) || null;
      const pending = hasPendingMatch(local, pendingTokens);

      if (pending) {
        preservedPending.push(local);
        continue;
      }

      if (dbMatch) {
        const dbId = idOf(dbMatch);
        if (localId && dbId && localId !== dbId) {
          try { if (await deleteOrderLocal(localId)) removedAliases += 1; } catch {}
        }
        continue;
      }

      // Delete only confirmed persisted/local mirrors that are absent from the complete DB scan.
      // Fresh unsynced drafts are preserved by the pending guard above.
      if (localId && (isNumericId(localId) || localOid)) {
        try { if (await deleteOrderLocal(localId)) removedMissing += 1; } catch {}
      }
    }

    const rebuiltRows = [...dbRows, ...preservedPending];
    rebuildBaseMasterCacheFromOrders(rebuiltRows);
    try { clearPageSnapshot('pastrimi'); } catch {}
    try { clearPageSnapshot('gati'); } catch {}

    const result = {
      ok: true,
      version: VERSION,
      source,
      at: new Date().toISOString(),
      dbRows: dbRows.length,
      localRowsBefore: Array.isArray(localRows) ? localRows.length : 0,
      pendingOps: Array.isArray(pendingOps) ? pendingOps.length : 0,
      hydrated,
      preservedPending: preservedPending.length,
      removedAliases,
      removedMissing,
      elapsedMs: Date.now() - startedAt,
    };
    lastRunAt = Date.now();
    writeMarker(result);
    dispatchRecovery(result);
    return result;
  })().catch((error) => {
    const result = {
      ok: false,
      version: VERSION,
      source,
      at: new Date().toISOString(),
      reason: String(error?.message || error || 'DB_TRUTH_RECOVERY_FAILED'),
    };
    writeMarker(result);
    return result;
  }).finally(() => {
    running = null;
  });

  return running;
}

function schedule(source, delayMs = 500, force = false) {
  if (!online()) return;
  try { if (timer) window.clearTimeout(timer); } catch {}
  timer = window.setTimeout(() => {
    timer = null;
    void reconcileOnlineDbTruth({ force, source });
  }, Math.max(0, Number(delayMs || 0)));
}

export function installOnlineDbTruthRecovery() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  try { window.addEventListener('online', () => schedule('online', 700, true), { passive: true }); } catch {}
  try { window.addEventListener('focus', () => schedule('focus', 900, false), { passive: true }); } catch {}
  try {
    window.addEventListener('pageshow', (event) => schedule(event?.persisted ? 'pageshow_bfcache' : 'pageshow', 1200, false), { passive: true });
  } catch {}
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule('visibility_visible', 900, false);
    }, { passive: true });
  } catch {}

  try {
    window.__TEPIHA_ONLINE_DB_TRUTH_RECOVERY_API__ = {
      version: VERSION,
      run: (opts = {}) => reconcileOnlineDbTruth({ ...opts, force: true, source: opts?.source || 'manual_api' }),
    };
  } catch {}

  schedule('startup', 2500, false);
}
