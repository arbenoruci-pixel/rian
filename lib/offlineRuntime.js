import { supabase } from './supabaseClient.js';
import { getByKey, getAllFromStore, openAppDb, putValue } from './localDb.js';
import {
  getOfflineCodeBankSummarySync,
  getOfflineDeviceId,
  refreshOfflineCodeBanks,
} from './offlineCodeBank.js';

export const OFFLINE_RUNTIME_VERSION = 'offline-first-runtime-v1';

const SNAPSHOT_KEY = 'offline_business_snapshot_v1';
const SNAPSHOT_CACHE_KEY = 'tepiha_offline_business_snapshot_v1';
const RUNTIME_STATE_KEY = 'tepiha_offline_runtime_state_v1';
const ACTIVE_REFRESH_MS = 5 * 60 * 1000;
const CLIENT_REFRESH_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 750;
const MAX_ACTIVE_ROWS = 12000;
const MAX_CLIENT_ROWS = 16000;
const QUERY_TIMEOUT_MS = 14000;

const BASE_ACTIVE_STATUSES = [
  'new', 'inbox', 'pranim', 'marrje', 'pastrim', 'loaded', 'gati',
  'dorzim', 'dorezim', 'delivery', 'ne_depo', 'riplan',
];

const TRANSPORT_ACTIVE_STATUSES = [
  'new', 'inbox', 'pickup', 'pranim', 'dispatched', 'assigned', 'riplan',
  'loaded', 'pastrim', 'gati', 'delivery', 'ne_depo', 'dorzim', 'dorezim',
];

let installed = false;
let activeRefreshPromise = null;
let intervalId = null;
let bannerNode = null;
let hideOnlineTimer = null;
let state = {
  version: OFFLINE_RUNTIME_VERSION,
  mode: 'booting',
  online: true,
  reachable: null,
  snapshot_at: '',
  client_snapshot_at: '',
  counts: {},
  pending: 0,
  banks: {},
  error: '',
  updated_at: new Date().toISOString(),
};

const listeners = new Set();

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(raw, fallback = null) {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
}

function isNetworkLikeError(error) {
  const text = String(error?.message || error?.details || error || '').toLowerCase();
  return (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('offline') ||
    text.includes('load failed') ||
    text.includes('fetch') ||
    text.includes('connection') ||
    text.includes('err_internet')
  );
}

function withTimeout(promise, timeoutMs = QUERY_TIMEOUT_MS, label = 'OFFLINE_RUNTIME_QUERY_TIMEOUT') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(label);
        error.code = label;
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function readCachedSnapshotSync() {
  if (!isBrowser()) return null;
  try { return parseJson(window.localStorage.getItem(SNAPSHOT_CACHE_KEY), null); }
  catch { return null; }
}

async function readSnapshot() {
  let snapshot = null;
  try { snapshot = await getByKey('meta', SNAPSHOT_KEY); } catch {}
  return snapshot || readCachedSnapshotSync() || null;
}

async function writeSnapshot(snapshot = {}) {
  const next = {
    ...(snapshot || {}),
    key: SNAPSHOT_KEY,
    version: OFFLINE_RUNTIME_VERSION,
    updated_at: nowIso(),
    device_id: snapshot?.device_id || getOfflineDeviceId(),
  };
  try { await putValue('meta', next); } catch {}
  if (isBrowser()) {
    try { window.localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(next)); } catch {}
  }
  return next;
}

function isDirtyLocalRow(row = {}) {
  const syncState = String(row?.sync_state || row?._syncState || '').trim().toLowerCase();
  return (
    row?._dirty === true ||
    row?._local === true ||
    row?._syncPending === true ||
    row?._syncing === true ||
    ['pending', 'queued', 'local', 'dirty', 'syncing', 'failed'].includes(syncState)
  );
}

async function batchMergeRows(storeName, rows = []) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id != null);
  if (!safeRows.length) return { written: 0, preserved: 0 };

  const db = await openAppDb();
  let written = 0;
  let preserved = 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error(`OFFLINE_SNAPSHOT_${storeName}_TX_FAILED`));
    tx.onabort = () => reject(tx.error || new Error(`OFFLINE_SNAPSHOT_${storeName}_TX_ABORTED`));

    for (const remote of safeRows) {
      const getReq = store.get(remote.id);
      getReq.onsuccess = () => {
        const existing = getReq.result || null;
        if (existing && isDirtyLocalRow(existing)) {
          preserved += 1;
          return;
        }
        store.put({
          ...(remote || {}),
          _snapshotCached: true,
          _snapshotVersion: OFFLINE_RUNTIME_VERSION,
          _snapshotCachedAt: nowIso(),
          _local: false,
          _dirty: false,
          _syncPending: false,
          _synced: true,
        });
        written += 1;
      };
      getReq.onerror = () => {
        store.put({
          ...(remote || {}),
          _snapshotCached: true,
          _snapshotVersion: OFFLINE_RUNTIME_VERSION,
          _snapshotCachedAt: nowIso(),
          _local: false,
          _dirty: false,
          _syncPending: false,
          _synced: true,
        });
        written += 1;
      };
    }
  });

  return { written, preserved };
}

async function fetchPaged(makeQuery, { maxRows = MAX_ACTIVE_ROWS } = {}) {
  const rows = [];
  for (let start = 0; start < maxRows; start += PAGE_SIZE) {
    const end = Math.min(start + PAGE_SIZE - 1, maxRows - 1);
    const { data, error } = await withTimeout(makeQuery(start, end), QUERY_TIMEOUT_MS);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchBaseActiveOrders() {
  return fetchPaged(
    (start, end) => supabase
      .from('orders')
      .select('*')
      .in('status', BASE_ACTIVE_STATUSES)
      .order('updated_at', { ascending: false })
      .range(start, end),
    { maxRows: MAX_ACTIVE_ROWS },
  );
}

async function fetchTransportActiveOrders() {
  return fetchPaged(
    (start, end) => supabase
      .from('transport_orders')
      .select('*')
      .in('status', TRANSPORT_ACTIVE_STATUSES)
      .order('updated_at', { ascending: false })
      .range(start, end),
    { maxRows: MAX_ACTIVE_ROWS },
  );
}

async function fetchBaseClients() {
  return fetchPaged(
    (start, end) => supabase
      .from('clients')
      .select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .range(start, end),
    { maxRows: MAX_CLIENT_ROWS },
  );
}

async function fetchTransportClients() {
  return fetchPaged(
    (start, end) => supabase
      .from('transport_clients')
      .select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .range(start, end),
    { maxRows: MAX_CLIENT_ROWS },
  );
}

function prepareBaseOrders(rows = []) {
  return rows.map((row) => ({
    ...(row || {}),
    id: String(row?.id),
    server_id: row?.id,
    local_oid: row?.local_oid || row?.data?.local_oid || null,
    table: 'orders',
    _table: 'orders',
  }));
}

function prepareTransportOrders(rows = []) {
  return rows.map((row) => ({
    ...(row || {}),
    id: String(row?.id),
    table: 'transport_orders',
    _table: 'transport_orders',
    sync_state: 'synced',
  }));
}

function prepareBaseClients(rows = []) {
  return rows.map((row) => ({
    ...(row || {}),
    id: String(row?.id),
    source_id: String(row?.id),
    table: 'clients',
    _table: 'clients',
    _clientScope: 'base',
  }));
}

function prepareTransportClients(rows = []) {
  return rows.map((row) => ({
    ...(row || {}),
    id: `transport-client:${String(row?.id)}`,
    source_id: String(row?.id),
    table: 'transport_clients',
    _table: 'transport_clients',
    _clientScope: 'transport',
  }));
}

function countByStatus(rows = []) {
  const out = {};
  for (const row of rows) {
    const status = normalizeStatus(row?.status || row?.data?.status || 'unknown') || 'unknown';
    out[status] = Number(out[status] || 0) + 1;
  }
  return out;
}

async function countPendingOps() {
  try {
    const rows = await getAllFromStore('ops');
    return rows.filter((op) => !['done', 'synced', 'failed_permanently'].includes(String(op?.status || '').trim().toLowerCase())).length;
  } catch {
    return 0;
  }
}

function bankSummary() {
  const raw = getOfflineCodeBankSummarySync() || {};
  return {
    base: {
      available: Number(raw?.base?.available || 0),
      assigned: Number(raw?.base?.assigned || 0),
      total: Number(raw?.base?.total || 0),
      target: Number(raw?.base?.target || 10),
    },
    transport: {
      available: Number(raw?.transport?.available || 0),
      assigned: Number(raw?.transport?.assigned || 0),
      total: Number(raw?.transport?.total || 0),
      target: Number(raw?.transport?.target || 10),
    },
  };
}

function humanTime(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return 'pa pasqyrë';
  try {
    return new Intl.DateTimeFormat('sq-XK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function renderBanner() {
  if (!isBrowser()) return;
  const root = document.body || document.documentElement;
  if (!root) return;

  if (!bannerNode) {
    bannerNode = document.createElement('div');
    bannerNode.id = 'tepiha-offline-runtime-banner-v1';
    bannerNode.setAttribute('data-offline-runtime-banner', '1');
    bannerNode.style.cssText = [
      'position:fixed',
      'left:8px',
      'right:8px',
      'bottom:calc(72px + env(safe-area-inset-bottom, 0px))',
      'z-index:2147481200',
      'border-radius:14px',
      'padding:9px 11px',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'font-size:11px',
      'line-height:1.35',
      'font-weight:850',
      'letter-spacing:.01em',
      'box-shadow:0 12px 36px rgba(0,0,0,.34)',
      'pointer-events:none',
      'transition:opacity .18s ease,transform .18s ease',
    ].join(';');
    root.appendChild(bannerNode);
  }

  const mode = String(state.mode || 'booting');
  const show = ['offline-ready', 'offline-limited', 'reconnecting', 'syncing'].includes(mode);
  bannerNode.style.opacity = show ? '1' : '0';
  bannerNode.style.transform = show ? 'translateY(0)' : 'translateY(8px)';
  bannerNode.style.visibility = show ? 'visible' : 'hidden';

  if (mode === 'offline-ready') {
    bannerNode.style.background = 'rgba(7,24,18,.96)';
    bannerNode.style.border = '1px solid rgba(52,211,153,.45)';
    bannerNode.style.color = '#d1fae5';
  } else if (mode === 'offline-limited') {
    bannerNode.style.background = 'rgba(44,16,8,.97)';
    bannerNode.style.border = '1px solid rgba(251,146,60,.55)';
    bannerNode.style.color = '#ffedd5';
  } else {
    bannerNode.style.background = 'rgba(7,18,38,.96)';
    bannerNode.style.border = '1px solid rgba(96,165,250,.45)';
    bannerNode.style.color = '#dbeafe';
  }

  const baseBank = state?.banks?.base || {};
  const transportBank = state?.banks?.transport || {};
  const prefix = mode === 'offline-ready'
    ? 'OFFLINE • PASQYRA E FUNDIT'
    : (mode === 'offline-limited' ? 'OFFLINE • PASQYRA MUNGON' : 'RRJETI U KTHYE • DUKE SINKRONIZUAR');

  bannerNode.textContent = [
    prefix,
    `Pasqyra: ${humanTime(state.snapshot_at)}`,
    `Në pritje: ${Number(state.pending || 0)}`,
    `Kode B: ${Number(baseBank.available || 0)}/${Number(baseBank.target || 10)}`,
    `T: ${Number(transportBank.available || 0)}/${Number(transportBank.target || 10)}`,
  ].join('  •  ');
}

function persistRuntimeState() {
  if (!isBrowser()) return;
  try { window.localStorage.setItem(RUNTIME_STATE_KEY, JSON.stringify(state)); } catch {}
  try {
    document.documentElement.setAttribute('data-offline-runtime-mode', String(state.mode || ''));
    document.documentElement.setAttribute('data-offline-runtime-ready', state.snapshot_at ? '1' : '0');
  } catch {}
}

function setState(patch = {}) {
  state = {
    ...state,
    ...(patch || {}),
    banks: patch?.banks || state.banks || bankSummary(),
    updated_at: nowIso(),
  };
  persistRuntimeState();
  renderBanner();
  for (const listener of listeners) {
    try { listener({ ...state }); } catch {}
  }
  if (isBrowser()) {
    try {
      window.dispatchEvent(new CustomEvent('tepiha:offline-runtime-state', { detail: { ...state } }));
    } catch {}
  }
  return state;
}

export function getOfflineRuntimeState() {
  return { ...state };
}

export function subscribeOfflineRuntime(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  try { listener({ ...state }); } catch {}
  return () => listeners.delete(listener);
}

async function hydrateStateFromSnapshot() {
  const snapshot = await readSnapshot();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const pending = await countPendingOps();
  setState({
    online,
    reachable: online ? null : false,
    snapshot_at: snapshot?.snapshot_at || '',
    client_snapshot_at: snapshot?.client_snapshot_at || '',
    counts: snapshot?.counts || {},
    pending,
    banks: bankSummary(),
    mode: online ? 'booting' : (snapshot?.snapshot_at ? 'offline-ready' : 'offline-limited'),
  });
  return snapshot;
}

async function performSnapshotRefresh({ forceClients = false, source = 'runtime' } = {}) {
  const previous = await readSnapshot();
  const previousClientMs = Date.parse(String(previous?.client_snapshot_at || ''));
  const refreshClients = forceClients || !Number.isFinite(previousClientMs) || Date.now() - previousClientMs >= CLIENT_REFRESH_MS;

  const [baseOrders, transportOrders] = await Promise.all([
    fetchBaseActiveOrders(),
    fetchTransportActiveOrders(),
  ]);

  const [baseWrite, transportWrite] = await Promise.all([
    batchMergeRows('orders', prepareBaseOrders(baseOrders)),
    batchMergeRows('transport_orders', prepareTransportOrders(transportOrders)),
  ]);

  let baseClients = [];
  let transportClients = [];
  let clientSnapshotAt = previous?.client_snapshot_at || '';
  let clientWrites = { base: { written: 0, preserved: 0 }, transport: { written: 0, preserved: 0 } };

  if (refreshClients) {
    [baseClients, transportClients] = await Promise.all([
      fetchBaseClients(),
      fetchTransportClients(),
    ]);
    const [baseClientWrite, transportClientWrite] = await Promise.all([
      batchMergeRows('clients', prepareBaseClients(baseClients)),
      batchMergeRows('clients', prepareTransportClients(transportClients)),
    ]);
    clientWrites = { base: baseClientWrite, transport: transportClientWrite };
    clientSnapshotAt = nowIso();
  }

  const pending = await countPendingOps();
  let bankResult = null;
  try { bankResult = await refreshOfflineCodeBanks({ target: 10, leaseHours: 720 }); } catch {}

  const snapshot = await writeSnapshot({
    ...(previous || {}),
    key: SNAPSHOT_KEY,
    version: OFFLINE_RUNTIME_VERSION,
    source,
    snapshot_at: nowIso(),
    client_snapshot_at: clientSnapshotAt,
    counts: {
      base_active: baseOrders.length,
      transport_active: transportOrders.length,
      base_clients: refreshClients ? baseClients.length : Number(previous?.counts?.base_clients || 0),
      transport_clients: refreshClients ? transportClients.length : Number(previous?.counts?.transport_clients || 0),
      base_status: countByStatus(baseOrders),
      transport_status: countByStatus(transportOrders),
      pending,
    },
    writes: {
      base_orders: baseWrite,
      transport_orders: transportWrite,
      clients: clientWrites,
    },
    banks: bankResult?.results || null,
    device_id: getOfflineDeviceId(),
  });

  setState({
    mode: 'online',
    online: true,
    reachable: true,
    snapshot_at: snapshot.snapshot_at,
    client_snapshot_at: snapshot.client_snapshot_at,
    counts: snapshot.counts,
    pending,
    banks: bankSummary(),
    error: '',
  });

  return { ok: true, snapshot, bankResult };
}

export async function refreshOfflineBusinessSnapshot(options = {}) {
  if (activeRefreshPromise) return activeRefreshPromise;
  activeRefreshPromise = (async () => {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (!online) {
      const snapshot = await readSnapshot();
      const pending = await countPendingOps();
      setState({
        mode: snapshot?.snapshot_at ? 'offline-ready' : 'offline-limited',
        online: false,
        reachable: false,
        snapshot_at: snapshot?.snapshot_at || '',
        client_snapshot_at: snapshot?.client_snapshot_at || '',
        counts: snapshot?.counts || {},
        pending,
        banks: bankSummary(),
      });
      return { ok: false, offline: true, snapshot };
    }

    setState({ mode: options?.source === 'online-event' ? 'reconnecting' : 'syncing', online: true, error: '' });
    try {
      return await performSnapshotRefresh(options);
    } catch (error) {
      const snapshot = await readSnapshot();
      const pending = await countPendingOps();
      const networkLike = isNetworkLikeError(error);
      setState({
        mode: snapshot?.snapshot_at ? 'offline-ready' : 'offline-limited',
        online: networkLike ? false : true,
        reachable: false,
        snapshot_at: snapshot?.snapshot_at || '',
        client_snapshot_at: snapshot?.client_snapshot_at || '',
        counts: snapshot?.counts || {},
        pending,
        banks: bankSummary(),
        error: String(error?.message || error || 'OFFLINE_RUNTIME_REFRESH_FAILED'),
      });
      return { ok: false, error, networkLike, snapshot };
    }
  })().finally(() => {
    activeRefreshPromise = null;
  });
  return activeRefreshPromise;
}

function scheduleRefresh(delayMs = 0, options = {}) {
  if (!isBrowser()) return;
  window.setTimeout(() => {
    refreshOfflineBusinessSnapshot(options).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

function handleOffline() {
  if (hideOnlineTimer) clearTimeout(hideOnlineTimer);
  void (async () => {
    const snapshot = await readSnapshot();
    const pending = await countPendingOps();
    setState({
      mode: snapshot?.snapshot_at ? 'offline-ready' : 'offline-limited',
      online: false,
      reachable: false,
      snapshot_at: snapshot?.snapshot_at || '',
      client_snapshot_at: snapshot?.client_snapshot_at || '',
      counts: snapshot?.counts || {},
      pending,
      banks: bankSummary(),
    });
  })();
}

function handleOnline() {
  setState({ mode: 'reconnecting', online: true, reachable: null });
  scheduleRefresh(700, { source: 'online-event', forceClients: false });
}

function handleSyncDone() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  scheduleRefresh(900, { source: 'sync-done', forceClients: false });
}

function handleVisibility() {
  if (document.visibilityState !== 'visible') return;
  const snapshotMs = Date.parse(String(state.snapshot_at || ''));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    handleOffline();
    return;
  }
  if (!Number.isFinite(snapshotMs) || Date.now() - snapshotMs >= ACTIVE_REFRESH_MS) {
    scheduleRefresh(350, { source: 'visibility', forceClients: false });
  }
}

export function installOfflineRuntime() {
  if (!isBrowser() || installed) return () => {};
  installed = true;

  hydrateStateFromSnapshot().catch(() => {});
  scheduleRefresh(1800, { source: 'startup', forceClients: false });
  scheduleRefresh(18000, { source: 'startup-second-pass', forceClients: false });

  window.addEventListener('offline', handleOffline, { passive: true });
  window.addEventListener('online', handleOnline, { passive: true });
  window.addEventListener('tepiha:sync-done', handleSyncDone, { passive: true });
  window.addEventListener('tepiha:offline-code-bank-changed', () => setState({ banks: bankSummary() }), { passive: true });
  window.addEventListener('tepiha:offline-code-lease-finished', handleSyncDone, { passive: true });
  window.addEventListener('storage', (event) => {
    if ([SNAPSHOT_CACHE_KEY, 'tepiha_offline_code_bank_summary_v1'].includes(String(event?.key || ''))) {
      hydrateStateFromSnapshot().catch(() => {});
    }
  });
  document.addEventListener('visibilitychange', handleVisibility, { passive: true });

  intervalId = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      handleOffline();
      return;
    }
    refreshOfflineBusinessSnapshot({ source: 'interval', forceClients: false }).catch(() => {});
  }, ACTIVE_REFRESH_MS);

  const api = {
    version: OFFLINE_RUNTIME_VERSION,
    getState: getOfflineRuntimeState,
    refresh: refreshOfflineBusinessSnapshot,
    subscribe: subscribeOfflineRuntime,
    readSnapshot,
  };
  try { window.__TEPIHA_OFFLINE_RUNTIME__ = api; } catch {}

  return () => {
    installed = false;
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('tepiha:sync-done', handleSyncDone);
    window.removeEventListener('tepiha:offline-code-lease-finished', handleSyncDone);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}

export default {
  OFFLINE_RUNTIME_VERSION,
  installOfflineRuntime,
  refreshOfflineBusinessSnapshot,
  getOfflineRuntimeState,
  subscribeOfflineRuntime,
};
