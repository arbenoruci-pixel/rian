#!/usr/bin/env node
/**
 * TEPIHA Circular TDZ Fix V1
 *
 * Purpose:
 * - Break Vite/Rollup circular-import chains that can trigger TDZ ReferenceError
 *   before React has a chance to render error boundaries.
 *
 * Applies targeted edits only:
 * 1) lib/offlineStore.js
 *    - removes static import from lib/baseMasterCache
 *    - loads baseMasterCache lazily inside async function calls
 *
 * 2) lib/syncManager.js
 *    - removes static imports from lib/offlineStore, lib/syncEngine,
 *      lib/baseMasterCache, lib/syncRecovery
 *    - replaces them with async local wrappers
 *
 * 3) lib/syncRecovery.js
 *    - removes static import from lib/offlineStore
 *    - replaces it with async local wrappers
 *
 * 4) lib/baseMasterCache.js
 *    - imports APP_DATA_EPOCH directly from lib/appEpoch instead of versionGuard
 *
 * Usage:
 *   node tools/apply-circular-fix.mjs .
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const BACKUP_SUFFIX = '.bak-circular-tdz-v1';

const files = {
  offlineStore: path.join(root, 'lib', 'offlineStore.js'),
  syncManager: path.join(root, 'lib', 'syncManager.js'),
  syncRecovery: path.join(root, 'lib', 'syncRecovery.js'),
  baseMasterCache: path.join(root, 'lib', 'baseMasterCache.js'),
};

const report = [];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function read(file) {
  return fs.readFile(file, 'utf8');
}

async function writeWithBackup(file, next) {
  const prev = await read(file);
  const backup = file + BACKUP_SUFFIX;
  if (!(await exists(backup))) {
    await fs.writeFile(backup, prev, 'utf8');
  }
  if (prev !== next) {
    await fs.writeFile(file, next, 'utf8');
    report.push({ file: path.relative(root, file), changed: true });
  } else {
    report.push({ file: path.relative(root, file), changed: false });
  }
}

function removeImportFrom(source, modulePath) {
  const re = new RegExp(
    String.raw`^import\s+(?:[\s\S]*?)\s+from\s+['"]${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"];\s*\n`,
    'gm'
  );
  return source.replace(re, '');
}

function insertBefore(source, needle, block) {
  if (source.includes('CIRCULAR_TDZ_FIX_V1')) return source;
  const idx = source.indexOf(needle);
  if (idx === -1) return block + '\n' + source;
  return source.slice(0, idx) + block + '\n' + source.slice(idx);
}

function replaceAllLiteral(source, before, after) {
  return source.split(before).join(after);
}

function warnIfMissing(fileLabel, source, needle) {
  if (!source.includes(needle)) {
    report.push({
      file: fileLabel,
      changed: false,
      warning: `Expected pattern not found: ${needle.slice(0, 80)}`,
    });
  }
}

async function patchBaseMasterCache() {
  const file = files.baseMasterCache;
  if (!(await exists(file))) {
    report.push({ file: path.relative(root, file), changed: false, warning: 'Missing file' });
    return;
  }

  let source = await read(file);
  source = source.replace(
    "import { APP_DATA_EPOCH } from '@/lib/versionGuard';",
    "import { APP_DATA_EPOCH } from '@/lib/appEpoch';"
  );
  source = source.replace(
    'import { APP_DATA_EPOCH } from "@/lib/versionGuard";',
    'import { APP_DATA_EPOCH } from "@/lib/appEpoch";'
  );

  await writeWithBackup(file, source);
}

async function patchOfflineStore() {
  const file = files.offlineStore;
  if (!(await exists(file))) {
    report.push({ file: path.relative(root, file), changed: false, warning: 'Missing file' });
    return;
  }

  let source = await read(file);

  // Remove the static baseMasterCache edge:
  // offlineStore -> baseMasterCache -> versionGuard -> offlineStore
  source = removeImportFrom(source, '@/lib/baseMasterCache');

  const helper = `
// CIRCULAR_TDZ_FIX_V1:
// baseMasterCache is loaded only when these functions are executed.
// This keeps offlineStore out of the baseMasterCache/versionGuard static cycle.
async function getBaseMasterCacheKey() {
  const mod = await import('@/lib/baseMasterCache');
  return mod.getBaseMasterCacheKey();
}

async function patchBaseMasterRow(row) {
  const mod = await import('@/lib/baseMasterCache');
  return mod.patchBaseMasterRow(row);
}

async function removeBaseMasterRow(identityOrRow) {
  const mod = await import('@/lib/baseMasterCache');
  return mod.removeBaseMasterRow(identityOrRow);
}
`;

  source = insertBefore(source, 'const LEGACY_QUEUE_KEYS', helper);

  // Async call sites that previously used synchronous static imports.
  source = replaceAllLiteral(
    source,
    'if (opts.clearBaseMasterCache !== false) exactKeys.push(getBaseMasterCacheKey());',
    'if (opts.clearBaseMasterCache !== false) exactKeys.push(await getBaseMasterCacheKey());'
  );

  source = replaceAllLiteral(
    source,
    'try { patchBaseMasterRow(next); } catch {}',
    'try { await patchBaseMasterRow(next); } catch {}'
  );

  source = replaceAllLiteral(
    source,
    'try { removeBaseMasterRow(`id:${key}`); } catch {}',
    'try { await removeBaseMasterRow(`id:${key}`); } catch {}'
  );

  source = replaceAllLiteral(
    source,
    'try { removeBaseMasterRow(`local:${key}`); } catch {}',
    'try { await removeBaseMasterRow(`local:${key}`); } catch {}'
  );

  await writeWithBackup(file, source);
}

async function patchSyncManager() {
  const file = files.syncManager;
  if (!(await exists(file))) {
    report.push({ file: path.relative(root, file), changed: false, warning: 'Missing file' });
    return;
  }

  let source = await read(file);

  // Remove static edges involved in:
  // offlineStore -> syncManager -> syncEngine -> syncRecovery -> offlineStore
  source = removeImportFrom(source, '@/lib/offlineStore');
  source = removeImportFrom(source, '@/lib/syncEngine');
  source = removeImportFrom(source, '@/lib/baseMasterCache');
  source = removeImportFrom(source, '@/lib/syncRecovery');

  const helper = `
// CIRCULAR_TDZ_FIX_V1:
// These wrappers intentionally keep syncManager from statically importing
// offlineStore, syncEngine, baseMasterCache, or syncRecovery.
// Vite/Rollup can then build without putting those modules in a TDZ cycle.
async function loadOfflineStore() {
  return import('@/lib/offlineStore');
}

async function loadBaseSyncEngine() {
  return import('@/lib/syncEngine');
}

async function loadBaseMasterCache() {
  return import('@/lib/baseMasterCache');
}

async function loadSyncRecovery() {
  return import('@/lib/syncRecovery');
}

async function getDeadLetterOps(...args) {
  const mod = await loadOfflineStore();
  return mod.getDeadLetterOps(...args);
}

async function getPendingOps(...args) {
  const mod = await loadOfflineStore();
  return mod.getPendingOps(...args);
}

async function pushOp(...args) {
  const mod = await loadOfflineStore();
  return mod.pushOp(...args);
}

async function saveOrderLocal(...args) {
  const mod = await loadOfflineStore();
  return mod.saveOrderLocal(...args);
}

async function runSync(...args) {
  const mod = await loadBaseSyncEngine();
  return mod.runSync(...args);
}

async function scheduleRunSync(...args) {
  const mod = await loadBaseSyncEngine();
  return mod.scheduleRunSync(...args);
}

async function patchBaseMasterRow(...args) {
  const mod = await loadBaseMasterCache();
  return mod.patchBaseMasterRow(...args);
}

async function rememberBaseCreateRecovery(...args) {
  const mod = await loadSyncRecovery();
  return mod.rememberBaseCreateRecovery(...args);
}

async function repairPendingBaseCreateOps(...args) {
  const mod = await loadSyncRecovery();
  return mod.repairPendingBaseCreateOps(...args);
}
`;

  source = insertBefore(source, 'const SNAPSHOT_KEY', helper);

  // Make formerly-sync side-effect calls awaited so rejected dynamic imports are contained.
  source = replaceAllLiteral(
    source,
    'try { patchBaseMasterRow(order); } catch {}',
    'try { await patchBaseMasterRow(order); } catch {}'
  );

  source = replaceAllLiteral(
    source,
    "try { rememberBaseCreateRecovery(order, { status: 'queued', source: 'syncManager.enqueueBaseOrder', note: 'saved_local_before_enqueue' }); } catch {}",
    "try { await rememberBaseCreateRecovery(order, { status: 'queued', source: 'syncManager.enqueueBaseOrder', note: 'saved_local_before_enqueue' }); } catch {}"
  );

  await writeWithBackup(file, source);
}

async function patchSyncRecovery() {
  const file = files.syncRecovery;
  if (!(await exists(file))) {
    report.push({ file: path.relative(root, file), changed: false, warning: 'Missing file' });
    return;
  }

  let source = await read(file);

  // Remove static edge:
  // syncRecovery -> offlineStore
  source = removeImportFrom(source, '@/lib/offlineStore');

  const helper = `
// CIRCULAR_TDZ_FIX_V1:
// syncRecovery can be imported by syncEngine without immediately importing
// offlineStore. All offlineStore access happens lazily at runtime.
async function loadOfflineStore() {
  return import('@/lib/offlineStore');
}

async function deleteOp(...args) {
  const mod = await loadOfflineStore();
  return mod.deleteOp(...args);
}

async function getAllOrdersLocal(...args) {
  const mod = await loadOfflineStore();
  return mod.getAllOrdersLocal(...args);
}

async function getDeadLetterOps(...args) {
  const mod = await loadOfflineStore();
  return mod.getDeadLetterOps(...args);
}

async function getPendingOps(...args) {
  const mod = await loadOfflineStore();
  return mod.getPendingOps(...args);
}

async function pushOp(...args) {
  const mod = await loadOfflineStore();
  return mod.pushOp(...args);
}

async function saveOrderLocal(...args) {
  const mod = await loadOfflineStore();
  return mod.saveOrderLocal(...args);
}
`;

  // Put wrappers after the last import block. If no syncDebug import is found,
  // this still lands before constants through the fallback needle.
  if (!source.includes('CIRCULAR_TDZ_FIX_V1')) {
    const needle = "const RECOVERY_KEY";
    source = insertBefore(source, needle, helper);
  }

  await writeWithBackup(file, source);
}

async function verifyNoTargetStaticEdges() {
  const checks = [
    {
      file: files.offlineStore,
      forbidden: [
        "from '@/lib/baseMasterCache'",
        'from "@/lib/baseMasterCache"',
      ],
    },
    {
      file: files.syncManager,
      forbidden: [
        "from '@/lib/offlineStore'",
        'from "@/lib/offlineStore"',
        "from '@/lib/syncEngine'",
        'from "@/lib/syncEngine"',
        "from '@/lib/baseMasterCache'",
        'from "@/lib/baseMasterCache"',
        "from '@/lib/syncRecovery'",
        'from "@/lib/syncRecovery"',
      ],
    },
    {
      file: files.syncRecovery,
      forbidden: [
        "from '@/lib/offlineStore'",
        'from "@/lib/offlineStore"',
      ],
    },
    {
      file: files.baseMasterCache,
      forbidden: [
        "from '@/lib/versionGuard'",
        'from "@/lib/versionGuard"',
      ],
    },
  ];

  for (const check of checks) {
    if (!(await exists(check.file))) continue;
    const source = await read(check.file);
    for (const forbidden of check.forbidden) {
      if (source.includes(forbidden)) {
        report.push({
          file: path.relative(root, check.file),
          changed: false,
          warning: `Still contains static edge: ${forbidden}`,
        });
      }
    }
  }
}

async function main() {
  await patchBaseMasterCache();
  await patchOfflineStore();
  await patchSyncManager();
  await patchSyncRecovery();
  await verifyNoTargetStaticEdges();

  const out = {
    ok: true,
    root,
    backupSuffix: BACKUP_SUFFIX,
    report,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.stack || error?.message || error || 'UNKNOWN_ERROR'),
    report,
  }, null, 2));
  process.exitCode = 1;
});
