import { deleteByKey, getByKey, putValue } from '@/lib/localDb';
import { APP_DATA_EPOCH } from '@/lib/versionGuard';

export const GATI_DURABLE_SNAPSHOT_KEY = 'gati_offline_snapshot_v4';
export const GATI_DURABLE_SNAPSHOT_VERSION = 'gati-durable-snapshot-v4-2026-08-03';

function text(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStatus(value) {
  const raw = text(value).toLowerCase();
  if (raw === 'dorezim' || raw === 'dorëzim') return 'dorzim';
  if (raw === 'pastrimi') return 'pastrim';
  return raw;
}

function isBaseDbId(value) {
  return /^\d+$/.test(text(value));
}

function normalizeCode(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/^t\d+/i.test(raw)) return '';
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  return digits || '0';
}

function rowSignaturePart(row = {}) {
  return [
    text(row?.id),
    text(row?.local_oid),
    text(row?.updated_at),
    number(row?.readyTs || row?.ts, 0),
    number(row?.m2, 0).toFixed(2),
    number(row?.paid, 0).toFixed(2),
  ].join(':');
}

function signature(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(rowSignaturePart).join('|');
}

function normalizeRow(input = {}) {
  const row = object(input);
  const full = object(row?.fullOrder);
  const nested = object(full?.data);
  const status = normalizeStatus(
    row?.status ||
    full?.status ||
    full?.state ||
    nested?.status ||
    nested?.state ||
    'gati'
  );
  const id = text(row?.id || row?.db_id || row?.server_id || full?.id);
  const code = normalizeCode(row?.code || full?.code || full?.client?.code || nested?.code);

  if (status !== 'gati' || !isBaseDbId(id) || !code) return null;

  const localOid = text(
    row?.local_oid ||
    full?.local_oid ||
    full?.oid ||
    nested?.local_oid ||
    id
  );

  const nextFull = {
    ...full,
    id,
    local_oid: localOid,
    oid: text(full?.oid || localOid),
    status: 'gati',
    state: 'gati',
    code,
  };

  return {
    ...row,
    id,
    local_oid: localOid,
    status: 'gati',
    source: 'DB',
    code,
    m2: number(row?.m2, 0),
    cope: number(row?.cope, 0),
    total: number(row?.total, 0),
    paid: number(row?.paid, 0),
    readyTs: number(row?.readyTs || row?.ts, Date.parse(row?.updated_at || row?.created_at || 0) || 0),
    fullOrder: nextFull,
  };
}

function normalizeRows(rows = []) {
  const byId = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeRow(raw);
    if (!row) continue;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    const prevTs = Math.max(number(prev?.readyTs, 0), Date.parse(prev?.updated_at || 0) || 0);
    const nextTs = Math.max(number(row?.readyTs, 0), Date.parse(row?.updated_at || 0) || 0);
    if (nextTs >= prevTs) byId.set(row.id, row);
  }
  return Array.from(byId.values()).sort((a, b) => number(b?.readyTs, 0) - number(a?.readyTs, 0));
}

function empty(reason = 'EMPTY') {
  return {
    key: GATI_DURABLE_SNAPSHOT_KEY,
    version: GATI_DURABLE_SNAPSHOT_VERSION,
    epoch: APP_DATA_EPOCH,
    built_at: null,
    ts: 0,
    count: 0,
    rows: [],
    meta: {},
    reason,
  };
}

export async function readDurableGatiSnapshot() {
  try {
    const stored = await getByKey('meta', GATI_DURABLE_SNAPSHOT_KEY);
    if (!stored || text(stored?.version) !== GATI_DURABLE_SNAPSHOT_VERSION) return empty('VERSION_MISSING');
    if (text(stored?.epoch) !== text(APP_DATA_EPOCH)) return empty('EPOCH_MISMATCH');

    const rows = normalizeRows(stored?.rows);
    const expectedCount = number(stored?.count, rows.length);
    const expectedSignature = text(stored?.signature);
    const actualSignature = signature(rows);

    if (expectedCount > 0 && rows.length === 0) return empty('ROWS_INVALID');
    if (expectedSignature && expectedSignature !== actualSignature) return empty('SIGNATURE_MISMATCH');

    return {
      ...stored,
      key: GATI_DURABLE_SNAPSHOT_KEY,
      version: GATI_DURABLE_SNAPSHOT_VERSION,
      epoch: APP_DATA_EPOCH,
      count: rows.length,
      rows,
      signature: actualSignature,
      meta: object(stored?.meta),
      reason: 'OK',
    };
  } catch (error) {
    return { ...empty('READ_FAILED'), error: text(error?.message || error) };
  }
}

export async function writeDurableGatiSnapshot(rows = [], meta = {}) {
  const cleanRows = normalizeRows(rows);
  const safeMeta = object(meta);
  const allowEmpty = safeMeta?.allowEmptyDbTruth === true;

  if (!cleanRows.length && !allowEmpty) {
    const previous = await readDurableGatiSnapshot();
    return { ...previous, preserved: true, reason: previous?.rows?.length ? 'PRESERVED_NON_EMPTY' : 'EMPTY_REJECTED' };
  }

  const record = {
    key: GATI_DURABLE_SNAPSHOT_KEY,
    version: GATI_DURABLE_SNAPSHOT_VERSION,
    epoch: APP_DATA_EPOCH,
    built_at: new Date().toISOString(),
    ts: Date.now(),
    count: cleanRows.length,
    rows: cleanRows,
    signature: signature(cleanRows),
    meta: {
      ...safeMeta,
      source: 'DB_ONLY',
      sourceMode: 'DB_ONLY',
      durableStore: 'INDEXEDDB_META',
      durableVersion: GATI_DURABLE_SNAPSHOT_VERSION,
    },
  };

  await putValue('meta', record);
  const verified = await getByKey('meta', GATI_DURABLE_SNAPSHOT_KEY);
  if (!verified || text(verified?.signature) !== record.signature || number(verified?.count, -1) !== record.count) {
    throw new Error('GATI_DURABLE_SNAPSHOT_VERIFY_FAILED');
  }
  return record;
}

export async function clearDurableGatiSnapshot() {
  try {
    await deleteByKey('meta', GATI_DURABLE_SNAPSHOT_KEY);
    return true;
  } catch {
    return false;
  }
}
