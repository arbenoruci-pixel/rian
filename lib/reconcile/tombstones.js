import { getStatusRank, normalizeStatus } from '@/lib/reconcile/statusRules';
import { inferTable, normalizeCode, stableKeyFromCandidate } from '@/lib/reconcile/stableKey';

const KEY = 'tepiha_reconcile_tombstones';
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

export function readReconcileTombstones() {
  const currentTs = now();
  const alive = readRaw().filter((item) => Number(item?.expires_at || 0) > currentTs);
  if (alive.length !== readRaw().length) writeRaw(alive);
  return alive;
}

export function recordReconcileTombstone(candidate = {}, meta = {}) {
  const stableKey = stableKeyFromCandidate(candidate);
  if (!stableKey) return null;
  const status = normalizeStatus(meta?.status || candidate?.status);
  const row = {
    stableKey,
    table: inferTable(candidate),
    id: String(candidate?.id || candidate?.db_id || '').trim(),
    local_oid: String(candidate?.local_oid || candidate?.oid || '').trim(),
    code: normalizeCode(candidate?.code || candidate?.code_str || candidate?.client?.code),
    status,
    rank: getStatusRank(status),
    reason: String(meta?.reason || 'status_advance').trim() || 'status_advance',
    created_at: new Date().toISOString(),
    expires_at: now() + Math.max(60000, Number(meta?.ttlMs || DEFAULT_TTL_MS) || DEFAULT_TTL_MS),
  };
  const items = readReconcileTombstones().filter((item) => String(item?.stableKey || '') !== stableKey);
  items.push(row);
  writeRaw(items);
  return row;
}

export function clearReconcileTombstone(candidate = {}) {
  const stableKey = stableKeyFromCandidate(candidate);
  if (!stableKey) return false;
  const next = readReconcileTombstones().filter((item) => String(item?.stableKey || '') !== stableKey);
  writeRaw(next);
  return true;
}

export function isCandidateBlockedByTombstone(candidate = {}, tombstones = []) {
  const stableKey = stableKeyFromCandidate(candidate);
  if (!stableKey) return false;
  const statusRank = getStatusRank(candidate?.status);
  return (Array.isArray(tombstones) ? tombstones : []).some((item) => {
    if (String(item?.stableKey || '') !== stableKey) return false;
    return Number(item?.rank || 0) >= statusRank;
  });
}
