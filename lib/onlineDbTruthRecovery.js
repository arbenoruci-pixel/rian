import { supabase } from '@/lib/supabaseClient';
import { writePageSnapshot } from '@/lib/pageSnapshotCache';
import {
  getAllOrdersLocal,
  getPendingOps,
  saveOrderLocal,
  deleteOrderLocal,
} from '@/lib/offlineStore';
import { rebuildBaseMasterCacheFromOrders } from '@/lib/baseMasterCache';
import { writeDurableGatiSnapshot } from '@/lib/gatiDurableSnapshot';

const VERSION = 'online-db-truth-recovery-v1';
const GATI_DB_TRUTH_VERSION = 'gati-db-truth-2026-08-03-v3';
const GATI_SNAPSHOT_POLICY_VERSION = 'gati-offline-snapshot-v3-2026-08-03';
// GATI_OFFLINE_SNAPSHOT_V3:RECOVERY
// GATI_OFFLINE_RELIABILITY_V4:RECOVERY
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
      .select('id,local_oid,status,created_at,updated_at,ready_at,picked_up_at,delivered_at,data,code,client_id,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront')
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

function recoveryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function recoveryNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recoveryNormalizeCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits || '0';
}

function recoveryRows(data, firstKey, secondKey) {
  if (Array.isArray(data?.[firstKey])) return data[firstKey];
  if (Array.isArray(data?.[secondKey])) return data[secondKey];
  return [];
}

function recoveryComputeM2(data = {}) {
  let total = 0;
  for (const row of recoveryRows(data, 'tepiha', 'tepihaRows')) {
    total += recoveryNumber(row?.m2 ?? row?.m ?? row?.area, 0) * recoveryNumber(row?.qty ?? row?.pieces, 0);
  }
  for (const row of recoveryRows(data, 'staza', 'stazaRows')) {
    total += recoveryNumber(row?.m2 ?? row?.m ?? row?.area, 0) * recoveryNumber(row?.qty ?? row?.pieces, 0);
  }
  const stairsQty = recoveryNumber(data?.shkallore?.qty ?? data?.stairsQty, 0);
  const stairsPer = recoveryNumber(data?.shkallore?.per ?? data?.stairsPer, 0.3);
  total += stairsQty * stairsPer;
  return Number(total.toFixed(2));
}

function recoveryComputePieces(data = {}) {
  let total = 0;
  for (const row of recoveryRows(data, 'tepiha', 'tepihaRows')) total += recoveryNumber(row?.qty ?? row?.pieces, 0);
  for (const row of recoveryRows(data, 'staza', 'stazaRows')) total += recoveryNumber(row?.qty ?? row?.pieces, 0);
  total += recoveryNumber(data?.shkallore?.qty ?? data?.stairsQty, 0);
  return total;
}

function buildRecoveredGatiSnapshotRows(dbRows = []) {
  return (Array.isArray(dbRows) ? dbRows : [])
    .filter((row) => statusOf(row) === 'gati')
    .map((row) => {
      const data = recoveryObject(row?.data);
      const client = recoveryObject(data?.client);
      const id = String(row?.id || '').trim();
      const localOid = String(row?.local_oid || data?.local_oid || data?.oid || id).trim();
      const code = recoveryNormalizeCode(row?.code || data?.code || client?.code || '');
      const name = String(row?.client_name || data?.client_name || client?.name || 'Pa Emër').trim() || 'Pa Emër';
      const phone = String(row?.client_phone || data?.client_phone || client?.phone || '').trim();
      const structuredM2 = recoveryComputeM2(data);
      const m2 = recoveryNumber(row?.m2_total, 0) > 0 ? recoveryNumber(row?.m2_total, 0) : structuredM2;
      const structuredPieces = recoveryComputePieces(data);
      const cope = recoveryNumber(row?.pieces, 0) > 0 ? recoveryNumber(row?.pieces, 0) : structuredPieces;
      const total = Math.max(
        0,
        recoveryNumber(row?.price_total, 0),
        recoveryNumber(data?.price_total, 0),
        recoveryNumber(data?.pay?.euro, 0),
        recoveryNumber(data?.total, 0)
      );
      const paid = Math.max(
        0,
        recoveryNumber(row?.paid_cash, 0),
        recoveryNumber(data?.paid_cash, 0),
        recoveryNumber(data?.pay?.paid, 0),
        recoveryNumber(data?.clientPaid, 0),
        recoveryNumber(data?.paid, 0)
      );
      const readySlots = Array.isArray(data?.ready_slots) ? data.ready_slots : [];
      const readyLocation = String(data?.ready_location || readySlots.join(', ') || '').trim();
      const readyText = String(data?.ready_note_text || '').trim();
      const readyNote = String(data?.ready_note || readyLocation || readyText || '').trim();
      const readyTs = Date.parse(row?.ready_at || data?.ready_at || row?.updated_at || row?.created_at || 0) || recoveryNumber(data?.ready_at || data?.ts, 0) || Date.now();
      const ts = recoveryNumber(data?.ts, 0) || Date.parse(row?.created_at || row?.updated_at || 0) || readyTs;
      const fullOrder = {
        ...data,
        id,
        local_oid: localOid,
        oid: String(data?.oid || localOid),
        status: 'gati',
        state: 'gati',
        code,
        client_name: name,
        client_phone: phone,
        client: {
          ...client,
          name: client?.name || name,
          phone: client?.phone || phone,
          code: client?.code || code,
        },
        pay: {
          ...recoveryObject(data?.pay),
          euro: total,
          paid,
        },
        ready_note: readyNote,
        ready_note_text: readyText,
        ready_location: readyLocation,
        ready_slots: readySlots,
      };

      return {
        id,
        local_oid: localOid,
        source: 'DB',
        status: 'gati',
        ts,
        updated_at: String(row?.updated_at || data?.updated_at || ''),
        readyTs,
        picked_up_at: row?.picked_up_at || data?.picked_up_at || null,
        delivered_at: row?.delivered_at || data?.delivered_at || null,
        name,
        phone,
        code,
        m2: Number(recoveryNumber(m2, 0).toFixed(2)),
        cope: recoveryNumber(cope, 0),
        total: Number(recoveryNumber(total, 0).toFixed(2)),
        paid: Number(recoveryNumber(paid, 0).toFixed(2)),
        paidUpfront: Boolean(row?.is_paid_upfront ?? data?.is_paid_upfront ?? data?.pay?.paidUpfront),
        isReturn: Boolean(data?.returnInfo?.active),
        readyNote,
        ready_location: readyLocation,
        ready_note_text: readyText,
        ready_slots: readySlots,
        fullOrder,
      };
    })
    .sort((a, b) => Number(b?.readyTs || 0) - Number(a?.readyTs || 0));
}

async function writeRecoveredGatiSnapshot(dbRows = [], source = 'recovery') {
  const rows = buildRecoveredGatiSnapshotRows(dbRows);
  const meta = {
    source: 'DB_ONLY',
    sourceMode: 'DB_ONLY',
    gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
    policyVersion: GATI_SNAPSHOT_POLICY_VERSION,
    builtBy: VERSION,
    recoverySource: String(source || 'recovery'),
    dbRowCount: Array.isArray(dbRows) ? dbRows.length : 0,
    gatiRowCount: rows.length,
    allowEmptyDbTruth: true,
  };
  const localSnapshot = writePageSnapshot('gati', rows, meta);
  await writeDurableGatiSnapshot(rows, meta);
  return localSnapshot;
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
    const gatiSnapshot = await writeRecoveredGatiSnapshot(dbRows, source);
    // AUTHORITATIVE_OFFLINE_LISTS_V2:RECOVERY
    // A full base-order scan does not contain transport_orders. Clearing the
    // page snapshots here destroys the only authoritative combined Base +
    // Transport offline list and forces the UI back to historical IndexedDB.
    try {
      window.localStorage?.setItem?.('tepiha_authoritative_snapshots_preserved_v2', JSON.stringify({
        at: new Date().toISOString(),
        source,
        dbRows: dbRows.length,
        preserved: ['pastrimi', 'gati'],
      }));
    } catch {}

    const result = {
      ok: true,
      version: VERSION,
      source,
      at: new Date().toISOString(),
      dbRows: dbRows.length,
      localRowsBefore: Array.isArray(localRows) ? localRows.length : 0,
      pendingOps: Array.isArray(pendingOps) ? pendingOps.length : 0,
      hydrated,
      gatiSnapshotRows: Number(gatiSnapshot?.count || 0),
      gatiSnapshotVersion: GATI_DB_TRUTH_VERSION,
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
