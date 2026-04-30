import { APP_DATA_EPOCH } from '@/lib/versionGuard';

const PAGE_SNAPSHOT_VERSION = 1;
const PAGE_SNAPSHOT_PREFIX = 'tepiha_page_snapshot_v1:';

function hasWindow() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function normalizePage(page) {
  return String(page || '').trim().toLowerCase();
}

function emptySnapshot(page) {
  return {
    version: PAGE_SNAPSHOT_VERSION,
    epoch: APP_DATA_EPOCH,
    page: normalizePage(page),
    built_at: null,
    ts: 0,
    count: 0,
    rows: [],
    meta: {},
  };
}

export function getPageSnapshotKey(page) {
  return `${PAGE_SNAPSHOT_PREFIX}${normalizePage(page)}`;
}

export function readPageSnapshot(page) {
  const normalizedPage = normalizePage(page);
  if (!normalizedPage) return emptySnapshot(page);
  if (!hasWindow()) return emptySnapshot(normalizedPage);
  try {
    const raw = window.localStorage.getItem(getPageSnapshotKey(normalizedPage));
    if (!raw) return emptySnapshot(normalizedPage);
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const epoch = String(parsed?.epoch || '');
    const storedPage = normalizePage(parsed?.page || normalizedPage);
    if (epoch && epoch !== APP_DATA_EPOCH) return emptySnapshot(normalizedPage);
    if (storedPage && storedPage !== normalizedPage) return emptySnapshot(normalizedPage);
    return {
      version: Number(parsed?.version || PAGE_SNAPSHOT_VERSION) || PAGE_SNAPSHOT_VERSION,
      epoch: APP_DATA_EPOCH,
      page: normalizedPage,
      built_at: parsed?.built_at || null,
      ts: Number(parsed?.ts || 0) || 0,
      count: Number(parsed?.count || rows.length || 0) || 0,
      rows,
      meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    };
  } catch {
    return emptySnapshot(normalizedPage);
  }
}

export function writePageSnapshot(page, rows = [], meta = {}) {
  const normalizedPage = normalizePage(page);
  const safeRows = Array.isArray(rows) ? rows : [];
  const next = {
    version: PAGE_SNAPSHOT_VERSION,
    epoch: APP_DATA_EPOCH,
    page: normalizedPage,
    built_at: new Date().toISOString(),
    ts: Date.now(),
    count: safeRows.length,
    rows: safeRows,
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  if (!normalizedPage) return next;
  if (!hasWindow()) return next;
  try {
    window.localStorage.setItem(getPageSnapshotKey(normalizedPage), JSON.stringify(next));
  } catch {}
  return next;
}

export function clearPageSnapshot(page) {
  const normalizedPage = normalizePage(page);
  if (!normalizedPage) return emptySnapshot(page);
  if (!hasWindow()) return emptySnapshot(normalizedPage);
  try {
    window.localStorage.removeItem(getPageSnapshotKey(normalizedPage));
  } catch {}
  return emptySnapshot(normalizedPage);
}
