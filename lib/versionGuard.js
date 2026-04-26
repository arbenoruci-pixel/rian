import { APP_DATA_EPOCH, APP_VERSION } from '@/lib/appEpoch';
export { APP_DATA_EPOCH, APP_VERSION };

const VERSION_KEY = 'app_version';
const VERSION_TS_KEY = 'app_version_seen_at';
const DATA_EPOCH_KEY = 'app_data_epoch';
const DATA_EPOCH_TS_KEY = 'app_data_epoch_seen_at';
const EPOCH_RESET_ONCE_KEY = 'app_data_epoch_reset_done';
const EPOCH_MIGRATION_ACTIVE_KEY = 'app_data_epoch_migration_active';

function hasWindow() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

async function purgeOldAppCaches() {
  // PATCH K V23: fail-open policy; no automatic cache deletion on epoch change.
  try {
    if (typeof window === 'undefined') return;
    window.__TEPIHA_VERSION_GUARD_CACHE_PURGE_DISABLED__ = true;
  } catch {}
}

function resetOfflineDerivedStateForEpoch() {
  // PATCH K V23: diagnostic-only. Do not remove orders, outbox, queues, payments, or IndexedDB.
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const diagnosticKeys = [
      'tepiha_chunk_last_capture_v1',
      'tepiha_last_lazy_import_failure_v1',
      'tepiha_app_root_runtime_failure_last_v1',
      'tepiha_app_root_runtime_failure_log_v1',
    ];
    for (const key of diagnosticKeys) {
      try { window.localStorage.removeItem(key); } catch {}
    }
    window.__TEPIHA_VERSION_GUARD_BUSINESS_PURGE_DISABLED__ = true;
    return true;
  } catch {
    return false;
  }
}

async function runEpochMigration() {
  try {
    await Promise.allSettled([
      Promise.resolve(resetOfflineDerivedStateForEpoch()),
      purgeOldAppCaches(),
    ]);

    try { window.__TEPIHA_VERSION_GUARD_BASE_CACHE_REBUILD_DISABLED__ = true; } catch {}
  } catch {}
}

function scheduleEpochMigration() {
  if (!hasWindow()) return false;

  try {
    if (window.sessionStorage.getItem(EPOCH_MIGRATION_ACTIVE_KEY) === '1') return false;
    window.sessionStorage.setItem(EPOCH_MIGRATION_ACTIVE_KEY, '1');
  } catch {}

  const finalize = async () => {
    try {
      await runEpochMigration();
    } finally {
      try {
        window.localStorage.setItem(DATA_EPOCH_KEY, APP_DATA_EPOCH);
        window.localStorage.setItem(DATA_EPOCH_TS_KEY, String(Date.now()));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('tepiha:data-epoch-changed', {
          detail: { epoch: APP_DATA_EPOCH },
        }));
      } catch {}
      try {
        window.sessionStorage.removeItem(EPOCH_MIGRATION_ACTIVE_KEY);
      } catch {}
    }
  };

  window.setTimeout(() => {
    try {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => { void finalize(); }, { timeout: 8000 });
      } else {
        window.setTimeout(() => { void finalize(); }, 1200);
      }
    } catch {
      void finalize();
    }
  }, 2500);

  return true;
}

export async function runVersionGuard() {
  if (!hasWindow()) return false;

  try {
    const savedVersion = window.localStorage.getItem(VERSION_KEY);
    if (savedVersion !== APP_VERSION) {
      window.localStorage.setItem(VERSION_KEY, APP_VERSION);
      window.localStorage.setItem(VERSION_TS_KEY, String(Date.now()));
    }
  } catch {}

  try {
    const savedEpoch = window.localStorage.getItem(DATA_EPOCH_KEY);
    const resetDone = window.sessionStorage.getItem(EPOCH_RESET_ONCE_KEY);

    if (savedEpoch !== APP_DATA_EPOCH && !resetDone) {
      window.sessionStorage.setItem(EPOCH_RESET_ONCE_KEY, '1');
      scheduleEpochMigration();
      try {
        window.localStorage.setItem(DATA_EPOCH_KEY, APP_DATA_EPOCH);
        window.localStorage.setItem(DATA_EPOCH_TS_KEY, String(Date.now()));
      } catch {}
      return false;
    }

    if (savedEpoch !== APP_DATA_EPOCH) {
      try {
        window.localStorage.setItem(DATA_EPOCH_KEY, APP_DATA_EPOCH);
        window.localStorage.setItem(DATA_EPOCH_TS_KEY, String(Date.now()));
      } catch {}
    }
  } catch {}

  return false;
}
