import { normalizeStatus } from '@/lib/reconcile/statusRules';
import { inferTable, normalizeCode, stableKeyFromCandidate } from '@/lib/reconcile/stableKey';

const KEY = 'tepiha_pending_mutations';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6;

function hasWindow() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function now() {
  return Date.now();
}

function readRaw() {
  if (!hasWindow()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(items) {
  if (!hasWindow()) return items;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Array.isArray(items) ? items : []));
  } catch {}
  return items;
}

export function normalizePendingMutation(input = {}) {
  const payload = input?.payload && typeof input.payload === 'object' ? input.payload : {};
  const patch = input?.patch && typeof input.patch === 'object' ? input.patch : (payload?.data && typeof payload.data === 'object' ? payload.data : payload);
  const seed = {
    ...patch,
    id: input?.id || payload?.id || payload?.order_id || patch?.id || '',
    local_oid: input?.local_oid || payload?.local_oid || patch?.local_oid || '',
    code: input?.code || payload?.code || patch?.code || patch?.code_str || '',
    phone: input?.phone || patch?.client_phone || patch?.client?.phone || '',
    name: input?.name || patch?.client_name || patch?.client?.name || '',
    table: input?.table || payload?.table || patch?.table || '',
  };
  const stableKey = String(input?.stableKey || stableKeyFromCandidate(seed) || '').trim();
  if (!stableKey) return null;
  return {
    mutationId: String(input?.mutationId || input?.op_id || `${stableKey}:${now()}`),
    stableKey,
    table: inferTable(seed),
    id: String(seed.id || '').trim(),
    local_oid: String(seed.local_oid || '').trim(),
    code: normalizeCode(seed.code),
    kind: String(input?.kind || input?.type || payload?.type || 'patch_order_data').trim() || 'patch_order_data',
    source: String(input?.source || 'manual').trim() || 'manual',
    status: normalizeStatus(input?.status || patch?.status || payload?.status || ''),
    patch: patch && typeof patch === 'object' ? { ...patch } : {},
    created_at: String(input?.created_at || new Date().toISOString()),
    expires_at: Number(input?.expires_at || (now() + Math.max(60000, Number(input?.ttlMs || DEFAULT_TTL_MS) || DEFAULT_TTL_MS))),
  };
}

export function readPendingMutations() {
  const currentTs = now();
  const alive = readRaw().map(normalizePendingMutation).filter(Boolean).filter((item) => Number(item?.expires_at || 0) > currentTs);
  writeRaw(alive);
  return alive;
}

export function upsertPendingMutation(input = {}) {
  const next = normalizePendingMutation(input);
  if (!next) return null;
  const current = readPendingMutations().filter((item) => String(item?.mutationId || '') !== next.mutationId);
  current.push(next);
  writeRaw(current);
  return next;
}

export function clearPendingMutationsForStableKey(stableKey = '') {
  const cleanKey = String(stableKey || '').trim();
  if (!cleanKey) return false;
  const next = readPendingMutations().filter((item) => String(item?.stableKey || '') !== cleanKey);
  writeRaw(next);
  return true;
}

export function clearPendingMutationsFromOp(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
  const patch = payload?.insertRow && typeof payload.insertRow === 'object'
    ? payload.insertRow
    : (payload?.data && typeof payload.data === 'object' ? payload.data : payload);
  const stableKey = stableKeyFromCandidate({
    ...patch,
    id: op?.id || payload?.id || payload?.order_id || patch?.id || '',
    local_oid: payload?.local_oid || patch?.local_oid || '',
    code: payload?.code || patch?.code || patch?.code_str || '',
    phone: patch?.client_phone || patch?.client?.phone || '',
    name: patch?.client_name || patch?.client?.name || '',
    table: payload?.table || patch?.table || '',
  });
  if (!stableKey) return false;
  return clearPendingMutationsForStableKey(stableKey);
}

function mutationFromOutboxItem(item = {}) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const kind = String(item?.kind || item?.type || item?.op || '').trim() || 'patch_order_data';
  const insertRow = payload?.insertRow && typeof payload.insertRow === 'object' ? payload.insertRow : null;
  const rawPatch = kind === 'insert_order'
    ? (insertRow || payload)
    : (payload?.data && typeof payload.data === 'object' ? payload.data : payload);
  const patch = rawPatch && typeof rawPatch === 'object' ? { ...rawPatch } : {};
  const next = normalizePendingMutation({
    mutationId: String(item?.op_id || item?.id || `${kind}:${now()}`),
    kind,
    source: 'outbox_snapshot',
    table: payload?.table || patch?.table || insertRow?.table || '',
    id: item?.id || payload?.id || payload?.order_id || patch?.id || '',
    local_oid: payload?.local_oid || patch?.local_oid || insertRow?.local_oid || '',
    status: kind === 'set_status' ? (payload?.status || patch?.status || '') : (patch?.status || ''),
    patch,
    created_at: item?.createdAt || item?.created_at || new Date().toISOString(),
    ttlMs: DEFAULT_TTL_MS,
  });
  return next;
}

export function derivePendingMutationsFromSnapshot(snapshot = []) {
  return (Array.isArray(snapshot) ? snapshot : [])
    .map(mutationFromOutboxItem)
    .filter(Boolean);
}

export function listActivePendingMutations(snapshot = []) {
  const merged = [...readPendingMutations(), ...derivePendingMutationsFromSnapshot(snapshot)];
  const byStableKey = new Map();
  for (const item of merged) {
    const stableKey = String(item?.stableKey || '').trim();
    if (!stableKey) continue;
    const prev = byStableKey.get(stableKey);
    if (!prev) {
      byStableKey.set(stableKey, item);
      continue;
    }
    const prevTs = Date.parse(prev?.created_at || 0) || 0;
    const nextTs = Date.parse(item?.created_at || 0) || 0;
    byStableKey.set(stableKey, nextTs >= prevTs ? item : prev);
  }
  return Array.from(byStableKey.values());
}
