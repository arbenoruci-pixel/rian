import { deleteOp, getAllOrdersLocal, getDeadLetterOps, getPendingOps, pushOp, saveOrderLocal } from '@/lib/offlineStore';
import { syncDebugLog } from '@/lib/syncDebug';
import { buildInsertRowFromMirrorItem, readQueueMirror, writeQueueMirror } from '@/lib/offlineQueueSync';
import { supabase } from '@/lib/supabaseClient';

const RECOVERY_KEY = 'tepiha_sync_recovery_v1';
const GHOST_BLOCK_KEY = 'tepiha_sync_ghost_blocks_v1';
const MAX_ENTRIES = 80;
const MISSING_LOCAL_GRACE_MS = 10 * 60 * 1000;
const MISSING_LOCAL_MAX_HITS = 3;
const TERMINAL_STATUSES = new Set(['synced', 'abandoned_missing_local', 'failed_permanently']);

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parseMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function ageMsFromIso(value) {
  const ts = parseMs(value);
  if (!ts) return 0;
  return Math.max(0, Date.now() - ts);
}

function isTerminalStatus(status = '') {
  return TERMINAL_STATUSES.has(String(status || '').trim());
}

function identityKeys(payload = {}) {
  const entry = toRecoveryEntry(payload, {});
  const keys = [];
  if (entry?.id) keys.push(`id:${String(entry.id)}`);
  if (entry?.local_oid) keys.push(`local:${String(entry.local_oid)}`);
  if (entry?.code) keys.push(`code:${String(entry.code)}`);
  return Array.from(new Set(keys));
}

function readGhostBlocks() {
  if (!isBrowser()) return [];
  return safeParse(window.localStorage.getItem(GHOST_BLOCK_KEY), []);
}

function writeGhostBlocks(items = []) {
  if (!isBrowser()) return [];
  const clean = Array.isArray(items) ? items.slice(0, 200) : [];
  try { window.localStorage.setItem(GHOST_BLOCK_KEY, JSON.stringify(clean)); } catch {}
  return clean;
}

export function blockGhostResurrection(opIdOrEntry = {}, id = '', code = '') {
  const payload = (opIdOrEntry && typeof opIdOrEntry === 'object')
    ? opIdOrEntry
    : { op_id: opIdOrEntry, id, code };
  const keys = identityKeys(payload);
  if (!keys.length) return readGhostBlocks();

  const now = nowIso();
  const prev = readGhostBlocks();
  const mapped = new Map();
  for (const item of prev) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    mapped.set(key, { ...item });
  }
  for (const key of keys) {
    mapped.set(key, {
      key,
      at: now,
      purged_ghost: true,
      op_id: String(payload?.op_id || ''),
      id: String(payload?.id || payload?.local_oid || id || ''),
      local_oid: String(payload?.local_oid || payload?.id || id || ''),
      code: normalizeCode(payload?.code || code || ''),
    });
  }
  const next = Array.from(mapped.values()).sort((a, b) => parseMs(b?.at) - parseMs(a?.at));
  syncDebugLog('ghost_blocked', {
    count: keys.length,
    id: String(payload?.id || payload?.local_oid || id || ''),
    code: normalizeCode(payload?.code || code || ''),
  });
  return writeGhostBlocks(next);
}

export function isGhostResurrectionBlocked(payload = {}) {
  const keys = identityKeys(payload);
  if (!keys.length) return false;
  const blocked = readGhostBlocks();
  if (!blocked.length) return false;
  const set = new Set(blocked.map((item) => String(item?.key || '').trim()).filter(Boolean));
  return keys.some((key) => set.has(key));
}

export function shouldPurgeGhostOp(op = {}, recovery = {}, localRow = null) {
  if (localRow) return false;
  const type = String(op?.type || op?.op || recovery?.type || '').trim();
  if (type && type !== 'insert_order') return false;
  const status = String(recovery?.status || '').trim();
  const terminal = !!recovery?.terminal || isTerminalStatus(status);
  const ghostishStatus = status === 'missing_local' || status === 'abandoned_missing_local';
  const ghostishKind = /ghost|orphan|mirror|repair/i.test(String(op?.kind || op?.source || recovery?.source || ''));
  return !!(ghostishStatus && terminal) || !!(ghostishStatus && ghostishKind);
}

async function purgeGhostArtifacts(entry = {}, { pendingOps = [], mirror = null } = {}) {
  const pending = Array.isArray(pendingOps) ? pendingOps : [];
  for (const op of pending) {
    if (!matchesPendingInsert(op, entry)) continue;
    try { await deleteOp(op?.op_id); } catch {}
  }

  try {
    const dead = await getDeadLetterOps().catch(() => []);
    for (const item of Array.isArray(dead) ? dead : []) {
      const original = item?.op && typeof item.op === 'object' ? item.op : {};
      if (!matchesPendingInsert(original, entry)) continue;
      try {
        const { deleteByKey } = await import('@/lib/localDb');
        await deleteByKey('offline_ops_dead_letter', item?.dead_id);
      } catch {}
    }
  } catch {}

  try {
    const mirrorState = mirror && typeof mirror === 'object' ? mirror : readQueueMirror();
    const mirrorItems = Array.isArray(mirrorState?.items) ? mirrorState.items : [];
    const mirrorKey = mirrorState?.key || null;
    if (mirrorKey && mirrorItems.length) {
      const filtered = mirrorItems.filter((item) => !sameEntry(toRecoveryEntry(buildInsertRowFromMirrorItem(item), {}), entry));
      if (filtered.length !== mirrorItems.length) writeQueueMirror(mirrorKey, filtered);
    }
  } catch {}

  clearBaseCreateRecovery(entry);
  blockGhostResurrection(entry);
}

function writeEntries(entries = []) {
  if (!isBrowser()) return Array.isArray(entries) ? entries : [];
  const clean = Array.isArray(entries) ? entries.slice(0, MAX_ENTRIES) : [];
  try {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(clean));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:sync-recovery', {
      detail: { at: Date.now(), entries: clean.length },
    }));
  } catch {}
  return clean;
}

function normalizeCode(code) {
  return String(code ?? '').replace(/\D+/g, '').replace(/^0+/, '').trim();
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === 0 || value === false) return value;
    if (value == null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    return value;
  }
  return undefined;
}

function normalizeMaybeNumber(value) {
  const picked = firstPresent(value);
  if (picked == null) return undefined;
  const num = Number(picked);
  return Number.isFinite(num) ? num : undefined;
}

function buildSafeInsertOrderRow(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const localId = String(row?.id || row?.local_oid || row?.oid || data?.local_oid || data?.id || '').trim();
  const safe = {
    ...(row || {}),
    id: localId || String(row?.id || data?.id || '').trim(),
    local_oid: String(row?.local_oid || data?.local_oid || localId || '').trim(),
    table: 'orders',
  };

  const code = normalizeCode(firstPresent(
    row?.code,
    row?.code_n,
    data?.code,
    nestedOrder?.code,
    client?.code,
  ));
  if (code) safe.code = /^\d+$/.test(code) ? Number(code) : code;

  const status = firstPresent(row?.status, data?.status, nestedOrder?.status, 'pranim');
  if (status != null) safe.status = String(status).trim() || 'pranim';

  const clientName = firstPresent(row?.client_name, data?.client_name, nestedOrder?.client_name, client?.name, data?.name, row?.name, '');
  safe.client_name = String(clientName || '');

  const clientPhone = firstPresent(row?.client_phone, data?.client_phone, nestedOrder?.client_phone, client?.phone, data?.phone, row?.phone, '');
  safe.client_phone = String(clientPhone || '');

  const clientId = String(row?.client_id || row?.client_master_id || data?.client_id || data?.client_master_id || client?.id || '').trim();
  if (clientId) {
    safe.client_id = clientId;
    safe.client_master_id = clientId;
  }
  const pieces = normalizeMaybeNumber(row?.pieces, data?.pieces, nestedOrder?.pieces);
  if (pieces !== undefined) safe.pieces = pieces;
  const m2 = normalizeMaybeNumber(row?.m2_total, data?.m2_total, nestedOrder?.m2_total, data?.pay?.m2, nestedOrder?.pay?.m2);
  if (m2 !== undefined) safe.m2_total = m2;
  const price = normalizeMaybeNumber(row?.price_total, data?.price_total, nestedOrder?.price_total, data?.total, nestedOrder?.total, data?.pay?.euro, nestedOrder?.pay?.euro);
  if (price !== undefined) {
    safe.price_total = price;
    if (safe.total == null) safe.total = price;
  }
  const paidCash = normalizeMaybeNumber(row?.paid_cash, data?.paid_cash, nestedOrder?.paid_cash, data?.pay?.paid, nestedOrder?.pay?.paid);
  if (paidCash !== undefined) safe.paid_cash = paidCash;
  const upfront = firstPresent(row?.is_paid_upfront, data?.is_paid_upfront, nestedOrder?.is_paid_upfront);
  if (upfront !== undefined) safe.is_paid_upfront = !!upfront;
  if (!safe.updated_at) safe.updated_at = nowIso();
  if (!safe.data || typeof safe.data !== 'object') safe.data = data;
  if (safe.data && typeof safe.data === 'object') {
    safe.data = {
      ...safe.data,
      ...(clientId ? { client_id: clientId, client_master_id: clientId } : {}),
      client: {
        ...((safe.data?.client && typeof safe.data.client === 'object') ? safe.data.client : {}),
        ...(clientId ? { id: clientId } : {}),
        ...(safe.client_name ? { name: safe.client_name } : {}),
        ...(safe.client_phone ? { phone: safe.client_phone } : {}),
        ...(safe.code != null ? { code: safe.code } : {}),
      },
    };
  }
  return safe;
}

async function remoteOrderExists(entry = {}) {
  const id = String(entry?.id || '').trim();
  const localOid = String(entry?.local_oid || '').trim();
  const selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data';

  const trySingle = async (field, value) => {
    try {
      const { data, error } = await supabase.from('orders').select(selectCols).eq(field, value).maybeSingle();
      if (!error && data) return data;
    } catch {}
    return null;
  };

  if (localOid) {
    const found = await trySingle('local_oid', localOid);
    if (found) return found;
  }
  if (id && /^\d+$/.test(id)) {
    const found = await trySingle('id', Number(id));
    if (found) return found;
  }
  return null;
}

async function clearPendingArtifacts(entry = {}, pendingOps = []) {
  for (const op of Array.isArray(pendingOps) ? pendingOps : []) {
    if (!matchesPendingInsert(op, entry)) continue;
    try { await deleteOp(op?.op_id); } catch {}
  }
  clearBaseCreateRecovery(entry);
}

async function finalizeLocalAsSyncedFromRemote(localRow = {}, remoteRow = {}, pendingOps = []) {
  const localId = String(localRow?.id || localRow?.local_oid || remoteRow?.local_oid || remoteRow?.id || '').trim();
  const merged = {
    ...(localRow || {}),
    ...(remoteRow || {}),
    id: String(remoteRow?.id || localId || ''),
    local_oid: String(remoteRow?.local_oid || localRow?.local_oid || localId || ''),
    table: 'orders',
    _local: false,
    _synced: true,
    _syncPending: false,
    _syncing: false,
    _syncFailed: false,
    _syncError: null,
    server_id: String(remoteRow?.id || ''),
    updated_at: nowIso(),
  };
  await saveOrderLocal(merged);
  await clearPendingArtifacts({
    id: localId,
    local_oid: String(localRow?.local_oid || localId || ''),
    code: normalizeCode(remoteRow?.code || localRow?.code || localRow?.data?.code || localRow?.data?.client?.code || ''),
  }, pendingOps);
}

function toRecoveryEntry(payload = {}, extra = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const id = String(payload?.id || payload?.local_oid || payload?.oid || data?.id || data?.local_oid || extra?.id || '').trim();
  const localOid = String(payload?.local_oid || data?.local_oid || payload?.id || payload?.oid || extra?.local_oid || '').trim();
  const code = normalizeCode(firstPresent(payload?.code, payload?.code_n, data?.code, nestedOrder?.code, client?.code, payload?.client?.code, extra?.code, ''));
  const idem = String(payload?._idem || data?._idem || extra?._idem || '').trim();
  const status = String(extra?.status || payload?.status || 'pending').trim() || 'pending';
  const firstSeenAt = String(extra?.firstSeenAt || nowIso());
  const missCount = Math.max(0, Number(extra?.miss_count ?? payload?.miss_count ?? (status === 'missing_local' ? 1 : 0)) || 0);
  return {
    id,
    local_oid: localOid || id,
    _idem: idem,
    code,
    table: 'orders',
    type: 'insert_order',
    status,
    source: String(extra?.source || 'unknown').trim() || 'unknown',
    firstSeenAt,
    lastSeenAt: nowIso(),
    note: extra?.note ? String(extra.note) : '',
    miss_count: missCount,
    terminal: !!extra?.terminal || isTerminalStatus(status),
  };
}

function sameEntry(a = {}, b = {}) {
  const aid = String(a?.id || '').trim();
  const alocal = String(a?.local_oid || '').trim();
  const bid = String(b?.id || '').trim();
  const blocal = String(b?.local_oid || '').trim();
  return !!(
    (aid && bid && aid === bid) ||
    (alocal && blocal && alocal === blocal)
  );
}

function matchesPendingInsert(op = {}, entry = {}) {
  const type = String(op?.type || op?.op || '').trim();
  if (type !== 'insert_order') return false;
  const payload = op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
  const table = String(payload?.table || op?.table || 'orders').trim();
  if (table !== 'orders') return false;

  const opId = String(payload?.id || payload?.local_oid || op?.id || '').trim();
  const opLocal = String(payload?.local_oid || payload?.id || '').trim();
  const opIdem = String(payload?._idem || payload?.data?._idem || '').trim();
  const entryIdem = String(entry?._idem || entry?.data?._idem || '').trim();

  return !!(
    (entry?.id && opId === String(entry.id)) ||
    (entry?.local_oid && opLocal === String(entry.local_oid)) ||
    (entryIdem && opIdem && entryIdem === opIdem)
  );
}

function hasTerminalRecoveryEntry(payload = {}, entries = null) {
  const registry = Array.isArray(entries) ? entries : listBaseCreateRecovery();
  if (!Array.isArray(registry) || !registry.length) return false;
  const target = toRecoveryEntry(payload, {});
  if (!target?.id && !target?.local_oid && !target?.code) return false;
  return registry.some((item) => sameEntry(item, target) && (!!item?.terminal || isTerminalStatus(item?.status || '')));
}

function matchesLocalOrder(row = {}, entry = {}) {
  const rowId = String(row?.id || '').trim();
  const rowLocal = String(row?.local_oid || row?.oid || row?.id || '').trim();
  return !!(
    (entry?.id && rowId === String(entry.id)) ||
    (entry?.local_oid && rowLocal === String(entry.local_oid))
  );
}

function hasPendingInsertForPayload(pendingOps = [], payload = {}) {
  const entry = toRecoveryEntry(payload, { status: 'pending', source: 'scan' });
  return (Array.isArray(pendingOps) ? pendingOps : []).some((op) => matchesPendingInsert(op, entry));
}

function looksLikeUnsyncedLocalRow(row = {}) {
  const table = String(row?.table || row?._table || 'orders').trim();
  if (table !== 'orders') return false;
  const id = String(row?.id || row?.local_oid || row?.oid || '').trim();
  if (!id) return false;
  if (row?._synced === true) return false;
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const code = normalizeCode(row?.code || row?.code_n || data?.code || data?.client?.code || '');
  const clientName = String(row?.client_name || data?.client_name || data?.client?.name || '').trim();
  return !!(code || clientName || data?.status || row?.status);
}

function toInsertOpFromRow(row = {}, kind = 'base_order_repair') {
  const safeRow = buildSafeInsertOrderRow(row);
  const localId = String(safeRow?.id || safeRow?.local_oid || row?.id || row?.local_oid || row?.oid || '').trim();
  return {
    op_id: rid(),
    type: 'insert_order',
    kind,
    id: localId,
    uniqueValue: localId,
    created_at: nowIso(),
    attempts: 0,
    status: 'pending',
    payload: {
      ...(safeRow || {}),
      id: localId,
      local_oid: String(safeRow?.local_oid || localId),
      table: 'orders',
    },
  };
}

function shouldSilenceSameState(existing = {}, next = {}, extra = {}) {
  if (!extra?.silentSameState) return false;
  return (
    String(existing?.status || '') === String(next?.status || '') &&
    String(existing?.note || '') === String(next?.note || '') &&
    !!existing?.id === !!next?.id
  );
}

export function listBaseCreateRecovery() {
  if (!isBrowser()) return [];
  return safeParse(window.localStorage.getItem(RECOVERY_KEY), []);
}

export function rememberBaseCreateRecovery(payload = {}, extra = {}) {
  if (!isBrowser()) return [];
  const next = toRecoveryEntry(payload, extra);
  if (!next.id && !next.local_oid && !next.code) return listBaseCreateRecovery();

  const prev = listBaseCreateRecovery();
  let found = false;
  let changed = false;
  const merged = prev.map((item) => {
    if (!sameEntry(item, next)) return item;
    found = true;

    const sameState = shouldSilenceSameState(item, next, extra);
    const missCount = next.status === 'missing_local'
      ? Math.max(Number(item?.miss_count || 0) + 1, Number(next?.miss_count || 0) || 0)
      : Math.max(0, Number(next?.miss_count || 0) || 0);

    const updated = {
      ...item,
      ...next,
      firstSeenAt: item?.firstSeenAt || next.firstSeenAt || nowIso(),
      lastSeenAt: sameState ? (item?.lastSeenAt || next.lastSeenAt || nowIso()) : nowIso(),
      miss_count: missCount,
      terminal: !!next?.terminal || isTerminalStatus(next?.status || '') || !!item?.terminal,
    };

    const comparableBefore = JSON.stringify({
      status: item?.status || '',
      note: item?.note || '',
      source: item?.source || '',
      miss_count: Number(item?.miss_count || 0) || 0,
      terminal: !!item?.terminal,
    });
    const comparableAfter = JSON.stringify({
      status: updated?.status || '',
      note: updated?.note || '',
      source: updated?.source || '',
      miss_count: Number(updated?.miss_count || 0) || 0,
      terminal: !!updated?.terminal,
    });
    if (comparableBefore !== comparableAfter) changed = true;
    return updated;
  });

  if (!found) {
    changed = true;
    merged.unshift(next);
  }

  if (!changed && extra?.silentSameState) return prev;

  syncDebugLog('recovery_remember', {
    id: next.id || next.local_oid || '',
    code: next.code || '',
    status: next.status,
    source: next.source,
    note: next.note || '',
    miss_count: Number(next?.miss_count || 0) || 0,
    terminal: !!next?.terminal,
  });
  return writeEntries(merged.slice(0, MAX_ENTRIES));
}

export function clearBaseCreateRecovery(payload = {}) {
  if (!isBrowser()) return [];
  const target = toRecoveryEntry(payload, { status: 'clear' });
  if (!target.id && !target.local_oid && !target.code) return listBaseCreateRecovery();
  const next = listBaseCreateRecovery().filter((item) => !sameEntry(item, target));
  syncDebugLog('recovery_clear', {
    id: target.id || target.local_oid || '',
    code: target.code || '',
  });
  return writeEntries(next);
}


export async function purgeTerminalGhostRecovery(opts = {}) {
  const source = String(opts?.source || 'unknown');
  const entries = listBaseCreateRecovery();
  if (!entries.length) return { ok: true, purged: 0 };

  const [{ items: mirrorItems, key: mirrorKey }, ops, orders] = await Promise.all([
    Promise.resolve(readQueueMirror()).catch(() => ({ items: [], key: null })),
    getPendingOps().catch(() => []),
    getAllOrdersLocal().catch(() => []),
  ]);

  let purged = 0;
  for (const entry of entries) {
    const row = (Array.isArray(orders) ? orders : []).find((item) => matchesLocalOrder(item, entry));
    if (!shouldPurgeGhostOp({}, entry, row)) continue;
    await purgeGhostArtifacts(entry, {
      pendingOps: Array.isArray(ops) ? ops : [],
      mirror: { items: mirrorItems || [], key: mirrorKey || null },
    });
    purged += 1;
    syncDebugLog('recovery_terminal_ghost_purged', {
      source,
      id: entry?.id || entry?.local_oid || '',
      code: entry?.code || '',
      purged_ghost: true,
    });
  }
  return { ok: true, purged };
}


export async function purgeInactiveTerminalRecovery(opts = {}) {
  const source = String(opts?.source || 'unknown');
  const registry = listBaseCreateRecovery();
  if (!registry.length) return { ok: true, purged: 0 };

  const pendingOps = Array.isArray(opts?.pendingOps) ? opts.pendingOps : await getPendingOps().catch(() => []);
  const orders = Array.isArray(opts?.orders) ? opts.orders : await getAllOrdersLocal().catch(() => []);

  let purged = 0;
  for (const entry of registry) {
    const status = String(entry?.status || '').trim();
    const terminal = !!entry?.terminal || isTerminalStatus(status);
    if (!terminal) continue;

    const hasPending = (Array.isArray(pendingOps) ? pendingOps : []).some((op) => matchesPendingInsert(op, entry));
    if (hasPending) continue;

    const localRow = (Array.isArray(orders) ? orders : []).find((item) => matchesLocalOrder(item, entry));
    if (looksLikeUnsyncedLocalRow(localRow || {})) continue;

    clearBaseCreateRecovery(entry);
    blockGhostResurrection(entry);
    purged += 1;
    syncDebugLog('recovery_terminal_inactive_pruned', {
      source,
      id: entry?.id || entry?.local_oid || '',
      code: entry?.code || '',
      status,
    });
  }

  return { ok: true, purged };
}

function broadcastRecoveryQueueChange(detail = {}) {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event('tepiha:outbox-changed'));
    window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));
    window.dispatchEvent(new CustomEvent('tepiha:sync-recovery-repaired', {
      detail: { at: Date.now(), ...detail },
    }));
  } catch {}
}

function shouldAbandonMissingLocal(entry = {}) {
  const missCount = Number(entry?.miss_count || 0) || 0;
  const ageMs = ageMsFromIso(entry?.firstSeenAt);
  return missCount >= MISSING_LOCAL_MAX_HITS || ageMs >= MISSING_LOCAL_GRACE_MS;
}

export async function repairPendingBaseCreateOps(opts = {}) {
  const source = String(opts?.source || 'unknown');
  const limit = Math.max(1, Number(opts?.limit || 8));

  const [{ items: mirrorItems, key: mirrorKey }, ops, orders] = await Promise.all([
    Promise.resolve(readQueueMirror()).catch(() => ({ items: [], key: null })),
    getPendingOps().catch(() => []),
    getAllOrdersLocal().catch(() => []),
  ]);

  await purgeTerminalGhostRecovery({ source });
  await purgeInactiveTerminalRecovery({ source, pendingOps: Array.isArray(ops) ? ops : [], orders: Array.isArray(orders) ? orders : [] });

  const recoveryRegistry = listBaseCreateRecovery();
  const entries = recoveryRegistry
    .filter((entry) => !isTerminalStatus(entry?.status || '') && !entry?.terminal && !isGhostResurrectionBlocked(entry))
    .slice(0, limit);
  if (!entries.length) {
    syncDebugLog('repair_skip_no_registry', { source });
  }
  const pendingOps = Array.isArray(ops) ? [...ops] : [];
  const mirrorState = { items: mirrorItems || [], key: mirrorKey || null };

  let repaired = 0;
  let existing = 0;
  let missingLocal = 0;
  let orphanLocals = 0;
  let mirrorRepaired = 0;
  let abandonedMissingLocal = 0;

  for (const entry of entries) {
    if (String(entry?.status || '') === 'synced') continue;

    const row = (Array.isArray(orders) ? orders : []).find((item) => matchesLocalOrder(item, entry));
    const remoteRow = await remoteOrderExists({
      id: entry?.id || row?.id || '',
      local_oid: entry?.local_oid || row?.local_oid || '',
      code: entry?.code || row?.code || row?.data?.code || row?.data?.client?.code || '',
    });
    if (remoteRow) {
      if (row) {
        await finalizeLocalAsSyncedFromRemote(row, remoteRow, pendingOps);
      } else {
        await clearPendingArtifacts({ ...entry, code: remoteRow?.code || entry?.code || '' }, pendingOps);
      }
      syncDebugLog('repair_finalize_remote_exists', {
        source,
        id: String(entry?.id || row?.id || remoteRow?.id || ''),
        code: normalizeCode(remoteRow?.code || entry?.code || ''),
        status: String(remoteRow?.status || ''),
      });
      continue;
    }

    const hasPending = pendingOps.some((op) => matchesPendingInsert(op, entry));
    if (hasPending) {
      existing += 1;
      rememberBaseCreateRecovery(entry, { status: 'queued', source, note: 'pending_exists', miss_count: 0, silentSameState: true });
      continue;
    }

    if (!row) {
      missingLocal += 1;
      const nextMissCount = Math.max(1, Number(entry?.miss_count || 0) + 1);
      if (shouldAbandonMissingLocal({ ...entry, miss_count: nextMissCount })) {
        abandonedMissingLocal += 1;
        await purgeGhostArtifacts({ ...entry, miss_count: nextMissCount, status: 'abandoned_missing_local', terminal: true }, { pendingOps, mirror: mirrorState });
        syncDebugLog('repair_abandon_missing_local', {
          source,
          id: entry?.id || entry?.local_oid || '',
          code: entry?.code || '',
          miss_count: nextMissCount,
          firstSeenAt: entry?.firstSeenAt || '',
          purged_ghost: true,
        });
      } else {
        rememberBaseCreateRecovery(entry, {
          status: 'missing_local',
          source,
          note: 'local_row_not_found',
          miss_count: nextMissCount,
          silentSameState: true,
        });
      }
      continue;
    }

    if (row?._synced === true) {
      clearBaseCreateRecovery(entry);
      syncDebugLog('repair_skip_synced_local', {
        source,
        id: row?.id || row?.local_oid || '',
        code: row?.code || entry?.code || '',
      });
      continue;
    }

    const safeRow = buildSafeInsertOrderRow(row);
    const localId = String(safeRow?.id || safeRow?.local_oid || row?.id || row?.local_oid || entry?.id || entry?.local_oid || '').trim();
    if (!localId) continue;
    const safeCode = normalizeCode(safeRow?.code || safeRow?.data?.code || safeRow?.data?.client?.code || entry?.code || '');
    if (!safeCode) {
      rememberBaseCreateRecovery({ ...entry, id: localId, local_oid: String(safeRow?.local_oid || localId) }, {
        status: 'failed_permanently',
        source,
        note: 'invalid_insert_payload_missing_code',
        miss_count: Number(entry?.miss_count || 0) || 0,
        terminal: true,
      });
      syncDebugLog('repair_invalid_missing_code', { source, id: localId, code: '' });
      continue;
    }

    const op = {
      op_id: rid(),
      type: 'insert_order',
      kind: 'base_order_repair',
      id: localId,
      uniqueValue: localId,
      created_at: nowIso(),
      attempts: 0,
      status: 'pending',
      payload: {
        ...(safeRow || {}),
        id: localId,
        local_oid: String(safeRow?.local_oid || localId),
        table: 'orders',
      },
    };

    await pushOp(op);
    pendingOps.push(op);
    repaired += 1;
    rememberBaseCreateRecovery(row, { status: 'queued', source, note: 'repaired_enqueue', miss_count: 0 });
    syncDebugLog('repair_enqueue', {
      source,
      op_id: op.op_id,
      id: localId,
      code: row?.code || entry?.code || '',
      kind: op.kind,
    });
  }

  const orphanCandidates = (Array.isArray(orders) ? orders : []).filter((row) => {
    if (!looksLikeUnsyncedLocalRow(row)) return false;
    if (isGhostResurrectionBlocked(row)) return false;
    if (hasTerminalRecoveryEntry(row, recoveryRegistry)) return false;
    return !hasPendingInsertForPayload(pendingOps, row);
  }).slice(0, limit);

  for (const row of orphanCandidates) {
    const safeRow = buildSafeInsertOrderRow(row);
    const localId = String(safeRow?.id || safeRow?.local_oid || row?.id || row?.local_oid || row?.oid || '').trim();
    if (!localId) continue;
    const remoteRow = await remoteOrderExists({
      id: localId,
      local_oid: String(safeRow?.local_oid || localId),
      code: safeRow?.code || safeRow?.data?.code || safeRow?.data?.client?.code || '',
    });
    if (remoteRow) {
      await finalizeLocalAsSyncedFromRemote(row, remoteRow, pendingOps);
      syncDebugLog('repair_orphan_remote_exists', { source, id: localId, code: normalizeCode(remoteRow?.code || safeRow?.code || '') });
      continue;
    }
    const safeCode = normalizeCode(safeRow?.code || safeRow?.data?.code || safeRow?.data?.client?.code || '');
    if (!safeCode) continue;
    const op = toInsertOpFromRow(safeRow, 'base_order_orphan_repair');
    await pushOp(op);
    pendingOps.push(op);
    orphanLocals += 1;
    repaired += 1;
    rememberBaseCreateRecovery(row, { status: 'queued', source, note: 'orphan_local_repaired', miss_count: 0 });
    syncDebugLog('repair_orphan_local', {
      source,
      op_id: op.op_id,
      id: localId,
      code: row?.code || row?.data?.client?.code || '',
    });
  }

  const mirrorCandidates = (Array.isArray(mirrorItems) ? mirrorItems : [])
    .filter((item) => item?.synced !== true)
    .filter((item) => !isGhostResurrectionBlocked(buildInsertRowFromMirrorItem(item)))
    .filter((item) => !hasTerminalRecoveryEntry(buildInsertRowFromMirrorItem(item), recoveryRegistry))
    .slice(0, limit);
  for (const item of mirrorCandidates) {
    const row = buildSafeInsertOrderRow(buildInsertRowFromMirrorItem(item));
    const localId = String(row?.local_oid || row?.id || item?.local_id || '').trim();
    if (!localId) continue;
    if (hasPendingInsertForPayload(pendingOps, row)) continue;
    const remoteRow = await remoteOrderExists({
      id: localId,
      local_oid: localId,
      code: row?.code || row?.data?.code || row?.data?.client?.code || '',
    });
    if (remoteRow) {
      await finalizeLocalAsSyncedFromRemote({ ...(row || {}), id: localId, local_oid: localId }, remoteRow, pendingOps);
      syncDebugLog('repair_legacy_remote_exists', { source, id: localId, code: normalizeCode(remoteRow?.code || row?.code || '') });
      continue;
    }
    const safeCode = normalizeCode(row?.code || row?.data?.code || row?.data?.client?.code || '');
    if (!safeCode) continue;
    await saveOrderLocal({
      ...(row || {}),
      id: localId,
      local_oid: localId,
      table: 'orders',
      _local: true,
      _synced: false,
    });
    const op = toInsertOpFromRow({ ...(row || {}), id: localId, local_oid: localId, table: 'orders' }, 'base_order_mirror_repair');
    await pushOp(op);
    pendingOps.push(op);
    mirrorRepaired += 1;
    repaired += 1;
    rememberBaseCreateRecovery({ ...(row || {}), id: localId, local_oid: localId }, { status: 'queued', source, note: 'legacy_queue_repaired', miss_count: 0 });
    syncDebugLog('repair_legacy_queue', {
      source,
      op_id: op.op_id,
      id: localId,
      code: row?.code || '',
    });
  }

  if (repaired > 0) {
    broadcastRecoveryQueueChange({ source, repaired, orphanLocals, mirrorRepaired });
  }

  return {
    ok: true,
    scanned: entries.length,
    repaired,
    existing,
    missingLocal,
    orphanLocals,
    mirrorRepaired,
    abandonedMissingLocal,
  };
}
