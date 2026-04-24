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
  try {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    const names = await window.caches.keys();
    await Promise.all(
      names
        .filter((name) => {
          const key = String(name || '');
          return (
            key.startsWith('shell-') ||
            key.startsWith('assets-') ||
            key.startsWith('runtime-') ||
            key.startsWith('next-data-')
          );
        })
        .map((name) => window.caches.delete(name))
    );
  } catch {}
}

async function runEpochMigration() {
  try {
    const [{ resetOfflineDerivedState }, { ensureFreshBaseMasterCache }] = await Promise.all([
      import('@/lib/offlineStore'),
      import('@/lib/baseMasterCache'),
    ]);

    await Promise.allSettled([
      resetOfflineDerivedState({
        clearBaseMasterCache: true,
        clearLegacyQueueMirrors: true,
        clearSyncSnapshot: true,
        clearLegacyOrderMirrors: true,
      }),
      purgeOldAppCaches(),
    ]);

    await ensureFreshBaseMasterCache({ forceRebuild: true, reason: 'epoch-mismatch' });
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
