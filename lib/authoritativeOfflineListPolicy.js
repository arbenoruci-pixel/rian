export const AUTHORITATIVE_OFFLINE_LIST_POLICY_VERSION = 'authoritative-offline-lists-v2-2026-08-03';

function stringValue(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

export function isPersistedOfflineListId(value) {
  const id = stringValue(value);
  if (!id) return false;
  if (/^\d+$/.test(id)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return true;
  return /^[0-9a-f-]{32,}$/i.test(id) && id.includes('-');
}

export function isStrongPendingOfflineRow(row = {}, persistedIdFn = isPersistedOfflineListId) {
  const source = stringValue(row?.source).toUpperCase();
  const id = stringValue(row?.id || row?.server_id || row?.db_id || row?.local_oid || row?.oid);
  const localOid = stringValue(
    row?.local_oid ||
    row?.oid ||
    row?.data?.local_oid ||
    row?.data?.oid ||
    row?.fullOrder?.local_oid ||
    row?.fullOrder?.oid
  );

  if (source === 'OUTBOX' || source.includes('JO I SYNC') || source.includes('PENDING')) return true;
  if (row?._pendingMutation === true) return true;
  if (row?._local === true) return true;
  if (row?._synced === false) return true;
  if (row?._syncPending === true || row?._outboxPending === true) return true;
  if (row?._syncFailed === true) return true;
  if (Number(row?.pending_ops || 0) > 0) return true;

  // A temporary identity may represent a real unsynced row even when an older
  // caller did not persist every sync flag. Persisted numeric/UUID mirrors are
  // never treated as pending only because they came from IndexedDB.
  if (id && !persistedIdFn(id) && localOid) return true;
  return false;
}

export function selectAuthoritativeOfflineRows({ snapshotRows = [], pendingRows = [] } = {}) {
  const snapshot = Array.isArray(snapshotRows) ? snapshotRows.filter(Boolean) : [];
  const pending = Array.isArray(pendingRows)
    ? pendingRows.filter((row) => row && isStrongPendingOfflineRow(row))
    : [];
  return [...snapshot, ...pending];
}

export function isDbTruthSnapshotMeta(meta = {}, {
  sourceMode = 'DB_ONLY',
  versionKey = '',
  version = '',
} = {}) {
  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  if (stringValue(safeMeta?.sourceMode).toUpperCase() !== stringValue(sourceMode).toUpperCase()) return false;
  if (!versionKey) return true;
  return stringValue(safeMeta?.[versionKey]) === stringValue(version);
}
