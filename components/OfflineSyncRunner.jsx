'use client';

import { useEffect, useRef, useState } from 'react';
import { getAllOrdersLocal, getDeadLetterOps, getPendingOps } from '@/lib/offlineStore';
import { syncNow } from '@/lib/syncManager';
import { bootLog } from '@/lib/bootLog';
import { isBaseScopedOp, isTransportPath } from '@/lib/transportCore/scope';
import { syncDebugLog } from '@/lib/syncDebug';
import { repairPendingBaseCreateOps } from '@/lib/syncRecovery';
import { isDiagEnabled } from '@/lib/diagMode';
import { supabase } from '@/lib/supabaseClient';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';

const DEBOUNCE_MS = 900;
const MIN_GAP_MS = 10000;
const FOLLOWUP_RETRY_MS = 10000;
const MANUAL_MIN_GAP_MS = 3200;
const HEARTBEAT_MS = 45000;
const HOT_ROUTE_BOOT_SUPPRESS_MS = 12000;
const HOT_ROUTE_SLOW_RETRY_MS = 15000;
const NO_PENDING_QUIET_MS = 15000;
const SAME_REASON_DEDUPE_MS = 1200;
const PASSIVE_REASON_DEDUPE_MS = 2600;
const LIFECYCLE_COALESCE_MS = 1900;
const RECENT_RECOVERY_TTL_MS = 90000;
const RECENT_RECOVERY_STORAGE_KEY = 'tepiha_recent_recovered_by_oid_v1';
const RECENT_RECOVERY_GLOBAL_KEY = '__TEPIHA_RECENT_RECOVERED_BY_OID__';

function canRunNow() {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  } catch {
    return false;
  }
}

function isStandaloneLike() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.navigator?.standalone === true) return true;
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    }
  } catch {}
  return false;
}

function isPublicLitePath(pathname = '') {
  const path = String(pathname || '');
  return path === '/porosit' || path.startsWith('/porosit/') || path === '/k' || path.startsWith('/k/');
}

function shouldRunOfflineRuntime(pathname = '') {
  const path = String(pathname || '');
  if (isPublicLitePath(path)) return false;
  if (/^\/debug\//.test(path)) return true;
  if (isStandaloneLike()) return true;
  try {
    if (window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ === true) return true;
    const qs = new URLSearchParams(window.location.search || '');
    if (qs.get('offlineengines') === '1') return true;
    if (window.localStorage?.getItem('tepiha_allow_browser_offline_runtime') === '1') return true;
  } catch {}
  return false;
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeCode(value) {
  return String(value ?? '').replace(/\D+/g, '').replace(/^0+/, '').trim();
}

function isManualishReason(reason = '') {
  const s = String(reason || '');
  return s === 'manual_trigger' || s === 'outbox_changed' || s === 'online';
}


function getCurrentPathname() {
  try {
    if (typeof window === 'undefined') return '';
    return String(window.location?.pathname || '');
  } catch {
    return '';
  }
}

function isHotInteractivePath(pathname = '') {
  const path = String(pathname || '');
  return path === '/' || path === '/gati' || path === '/pastrimi' || path === '/pranimi' || path === '/marrje-sot';
}

function isWithinHotRouteBootWindow(pathname = '') {
  if (!isHotInteractivePath(pathname)) return false;
  try {
    if (typeof window === 'undefined') return false;
    const ageMs = Number(window.performance?.now?.() || 0);
    return Number.isFinite(ageMs) && ageMs > 0 && ageMs < HOT_ROUTE_BOOT_SUPPRESS_MS;
  } catch {
    return false;
  }
}

async function readPendingCount() {
  try {
    const ops = await getPendingOps();
    return Array.isArray(ops)
      ? ops.filter((op) => String(op?.status || 'pending') !== 'failed_permanently' && isBaseScopedOp(op)).length
      : 0;
  } catch {
    return 0;
  }
}

async function readQueueSnapshot() {
  try {
    const [pendingOps, deadOps] = await Promise.all([
      getPendingOps().catch(() => []),
      getDeadLetterOps().catch(() => []),
    ]);
    const safePending = Array.isArray(pendingOps)
      ? pendingOps.filter((op) => String(op?.status || 'pending') !== 'failed_permanently' && isBaseScopedOp(op))
      : [];
    const safeDead = Array.isArray(deadOps) ? deadOps.filter((op) => isBaseScopedOp(op?.op || op)) : [];
    return {
      pendingOps: safePending,
      deadOps: safeDead,
      pendingCount: safePending.length,
      deadCount: safeDead.length,
    };
  } catch {
    return {
      pendingOps: [],
      deadOps: [],
      pendingCount: 0,
      deadCount: 0,
    };
  }
}

function isRetryReason(reason = '') {
  const s = String(reason || '');
  return s.startsWith('retry') || s.startsWith('followup_');
}

function isPassiveReason(reason = '') {
  const s = String(reason || '');
  return (
    s === 'mount' ||
    s === 'startup_nudge' ||
    s === 'heartbeat' ||
    s === 'focus' ||
    s === 'pageshow' ||
    s === 'visibilitychange' ||
    isRetryReason(s)
  );
}

function reasonGroup(reason = '') {
  const s = String(reason || '');
  if (s === 'manual_trigger') return 'manual';
  if (s === 'outbox_changed') return 'outbox';
  if (s === 'online') return 'online';
  if (s === 'mount' || s === 'startup_nudge') return 'boot';
  if (s === 'heartbeat') return 'heartbeat';
  if (s === 'focus' || s === 'pageshow' || s === 'visibilitychange') return 'page_lifecycle';
  if (isRetryReason(s)) return 'retry';
  return s || 'generic';
}

function reasonPriority(reason = '') {
  const s = String(reason || '');
  if (s === 'manual_trigger') return 60;
  if (s === 'outbox_changed') return 55;
  if (s === 'online') return 50;
  if (isRetryReason(s)) return 40;
  if (s === 'heartbeat') return 30;
  if (s === 'startup_nudge') return 20;
  if (s === 'mount') return 15;
  if (s === 'focus' || s === 'pageshow' || s === 'visibilitychange') return 10;
  return 25;
}

function pickPreferredReason(currentReason = '', nextReason = '') {
  if (!currentReason) return String(nextReason || 'generic');
  if (!nextReason) return String(currentReason || 'generic');
  return reasonPriority(nextReason) >= reasonPriority(currentReason) ? nextReason : currentReason;
}

function localOrderIdentity(row = {}) {
  const data = isPlainObject(row?.data) ? row.data : {};
  const id = String(row?.id || row?.local_oid || row?.oid || data?.id || data?.local_oid || '').trim();
  const localOid = String(row?.local_oid || row?.oid || row?.id || data?.local_oid || data?.id || '').trim();
  const code = normalizeCode(row?.code || row?.code_n || data?.code || data?.client?.code || '');
  return {
    id,
    localOid,
    code,
  };
}

function looksLikeBaseUnsyncedLocalRow(row = {}) {
  const table = String(row?._table || row?.table || 'orders').trim();
  if (table !== 'orders') return false;
  if (row?._synced === true) return false;
  const data = isPlainObject(row?.data) ? row.data : {};
  const identity = localOrderIdentity(row);
  if (!identity.localOid) return false;
  if (!identity.code && !String(row?.client_name || data?.client_name || data?.client?.name || '').trim()) return false;
  return true;
}

async function remoteOrderExistsLite(entry = {}) {
  const id = String(entry?.id || '').trim();
  const localOid = String(entry?.local_oid || entry?.localOid || '').trim();
  const selectCols = 'id,local_oid,code,status';

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

function pruneRecentRecoveryMap(mapRef) {
  const now = Date.now();
  const mapped = mapRef?.current;
  if (!(mapped instanceof Map)) return;
  for (const [key, ts] of mapped.entries()) {
    if (!key) continue;
    if (!ts || now - Number(ts || 0) >= RECENT_RECOVERY_TTL_MS) mapped.delete(key);
  }
}

function getRecentRecoveryGlobalMap() {
  try {
    if (typeof globalThis === 'undefined') return null;
    const current = globalThis[RECENT_RECOVERY_GLOBAL_KEY];
    if (current instanceof Map) return current;
    const next = new Map();
    globalThis[RECENT_RECOVERY_GLOBAL_KEY] = next;
    return next;
  } catch {
    return null;
  }
}

function readRecentRecoverySessionObject() {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return {};
    const raw = window.sessionStorage.getItem(RECENT_RECOVERY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecentRecoverySessionObject(obj = {}) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (!isPlainObject(obj) || !Object.keys(obj).length) {
      window.sessionStorage.removeItem(RECENT_RECOVERY_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(RECENT_RECOVERY_STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}

function persistRecentRecoveryState(recentRecoveredByOidRef, restoredRecentRecoveredByOidRef) {
  try {
    pruneRecentRecoveryMap(recentRecoveredByOidRef);
    const current = recentRecoveredByOidRef?.current;
    if (!(current instanceof Map)) return;
    const now = Date.now();
    const out = {};
    for (const [key, ts] of current.entries()) {
      const safeKey = String(key || '').trim();
      const safeTs = Number(ts || 0);
      if (!safeKey || !safeTs) continue;
      if (now - safeTs >= RECENT_RECOVERY_TTL_MS) continue;
      out[safeKey] = safeTs;
    }
    const globalMap = getRecentRecoveryGlobalMap();
    if (globalMap instanceof Map) {
      globalMap.clear();
      for (const [key, ts] of Object.entries(out)) globalMap.set(key, Number(ts || 0));
    }
    writeRecentRecoverySessionObject(out);
    const restoredSet = restoredRecentRecoveredByOidRef?.current;
    if (restoredSet instanceof Set) {
      for (const key of Array.from(restoredSet.values())) {
        if (!out[key]) restoredSet.delete(key);
      }
    }
  } catch {}
}

function restoreRecentRecoveryState({ recentRecoveredByOidRef, restoredRecentRecoveredByOidRef }) {
  try {
    const now = Date.now();
    const merged = new Map();
    const restoredSet = new Set();

    const globalMap = getRecentRecoveryGlobalMap();
    if (globalMap instanceof Map) {
      for (const [key, ts] of globalMap.entries()) {
        const safeKey = String(key || '').trim();
        const safeTs = Number(ts || 0);
        if (!safeKey || !safeTs) continue;
        if (now - safeTs >= RECENT_RECOVERY_TTL_MS) continue;
        merged.set(safeKey, safeTs);
        restoredSet.add(safeKey);
      }
    }

    const sessionObj = readRecentRecoverySessionObject();
    for (const [key, ts] of Object.entries(sessionObj || {})) {
      const safeKey = String(key || '').trim();
      const safeTs = Number(ts || 0);
      if (!safeKey || !safeTs) continue;
      if (now - safeTs >= RECENT_RECOVERY_TTL_MS) continue;
      const prevTs = Number(merged.get(safeKey) || 0);
      if (!prevTs || safeTs > prevTs) merged.set(safeKey, safeTs);
      restoredSet.add(safeKey);
    }

    if (recentRecoveredByOidRef?.current instanceof Map) recentRecoveredByOidRef.current = merged;
    if (restoredRecentRecoveredByOidRef?.current instanceof Set) restoredRecentRecoveredByOidRef.current = restoredSet;

    persistRecentRecoveryState(recentRecoveredByOidRef, restoredRecentRecoveredByOidRef);

    return {
      restoredCount: merged.size,
    };
  } catch {
    return { restoredCount: 0 };
  }
}

function rememberRecentRecovery(localOid = '', recentRecoveredByOidRef, restoredRecentRecoveredByOidRef, ts = Date.now()) {
  const safeOid = String(localOid || '').trim();
  if (!safeOid) return;
  try {
    if (!(recentRecoveredByOidRef?.current instanceof Map)) recentRecoveredByOidRef.current = new Map();
    recentRecoveredByOidRef.current.set(safeOid, Number(ts || Date.now()));
    if (restoredRecentRecoveredByOidRef?.current instanceof Set) {
      restoredRecentRecoveredByOidRef.current.delete(safeOid);
    }
    persistRecentRecoveryState(recentRecoveredByOidRef, restoredRecentRecoveredByOidRef);
  } catch {}
}

async function primeRecentRecoveryState({ recentRecoveredByOidRef, restoredRecentRecoveredByOidRef }) {
  try {
    pruneRecentRecoveryMap(recentRecoveredByOidRef);
    const now = Date.now();
    const rows = await getAllOrdersLocal().catch(() => []);
    const candidates = (Array.isArray(rows) ? rows : []).filter(looksLikeBaseUnsyncedLocalRow);
    if (!candidates.length) return 0;

    let primed = 0;
    for (const row of candidates) {
      const identity = localOrderIdentity(row);
      if (!identity.localOid) continue;
      const cachedAt = Number(recentRecoveredByOidRef?.current?.get(identity.localOid) || 0);
      if (cachedAt && now - cachedAt < RECENT_RECOVERY_TTL_MS) continue;
      const remoteRow = await remoteOrderExistsLite({ id: identity.id, local_oid: identity.localOid });
      if (!remoteRow) continue;
      rememberRecentRecovery(identity.localOid, recentRecoveredByOidRef, restoredRecentRecoveredByOidRef, now);
      primed += 1;
    }
    return primed;
  } catch {
    return 0;
  }
}

async function shouldSkipRecentRecovery({ reason = 'generic', group = 'generic', recentRecoveredByOidRef, restoredRecentRecoveredByOidRef }) {
  try {
    pruneRecentRecoveryMap(recentRecoveredByOidRef);
    const now = Date.now();
    const rows = await getAllOrdersLocal().catch(() => []);
    const candidates = (Array.isArray(rows) ? rows : []).filter(looksLikeBaseUnsyncedLocalRow);
    if (!candidates.length) return { skipped: false };

    let guardedCount = 0;
    let unguardedCount = 0;
    let firstGuarded = null;

    for (const row of candidates) {
      const identity = localOrderIdentity(row);
      if (!identity.localOid) {
        unguardedCount += 1;
        continue;
      }

      const cachedAt = Number(recentRecoveredByOidRef.current.get(identity.localOid) || 0);
      const restoredHit = !!restoredRecentRecoveredByOidRef?.current?.has(identity.localOid);
      if (cachedAt && now - cachedAt < RECENT_RECOVERY_TTL_MS) {
        guardedCount += 1;
        if (!firstGuarded) {
          firstGuarded = {
            id: identity.id || identity.localOid || '',
            code: identity.code || '',
            localOid: identity.localOid,
            reason,
            group,
            ttlLeft: Math.max(0, RECENT_RECOVERY_TTL_MS - (now - cachedAt)),
            persisted: restoredHit,
          };
        }
        continue;
      }

      const remoteRow = await remoteOrderExistsLite({ id: identity.id, local_oid: identity.localOid });
      if (remoteRow) {
        rememberRecentRecovery(identity.localOid, recentRecoveredByOidRef, restoredRecentRecoveredByOidRef, now);
        guardedCount += 1;
        if (!firstGuarded) {
          firstGuarded = {
            id: identity.id || String(remoteRow?.id || '') || identity.localOid || '',
            code: normalizeCode(remoteRow?.code || identity.code || ''),
            localOid: identity.localOid,
            reason,
            group,
            ttlLeft: RECENT_RECOVERY_TTL_MS,
            persisted: false,
          };
        }
        continue;
      }

      unguardedCount += 1;
    }

    if (guardedCount > 0 && unguardedCount === 0) {
      const payload = firstGuarded || {
        id: '',
        code: '',
        localOid: '',
        reason,
        group,
        ttlLeft: 0,
        persisted: false,
      };
      syncDebugLog('runner_skip_recent_recovery', payload);
      if (payload?.persisted) {
        syncDebugLog('runner_skip_recent_recovery_persisted', payload);
      }
      return { skipped: true };
    }

    return { skipped: false };
  } catch {
    return { skipped: false };
  }
}

export default function OfflineSyncRunner() {
  const [bootAttempt, setBootAttempt] = useState(0);
  const timerRef = useRef(null);
  const retryTimerRef = useRef(null);
  const heartbeatRef = useRef(null);
  const runningRef = useRef(false);
  const lastRunAtRef = useRef(0);
  const lastNoPendingAtRef = useRef(0);
  const quietUntilRef = useRef(0);
  const queuedReasonRef = useRef('');
  const queuedAtRef = useRef(0);
  const lastKickByGroupRef = useRef(Object.create(null));
  const queuedLifecycleRef = useRef(false);
  const lastLifecycleKickAtRef = useRef(0);
  const recentRecoveredByOidRef = useRef(new Map());
  const restoredRecentRecoveredByOidRef = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    let isolationTimer = null;

    if (isWithinStartupIsolationWindow()) {
      bootLog('offline_sync_runner_startup_isolation_delay', {
        path: getCurrentPathname(),
        leftMs: getStartupIsolationLeftMs(),
        bootAttempt,
      });
      isolationTimer = window.setTimeout(() => {
        if (cancelled) return;
        setBootAttempt((value) => value + 1);
      }, Math.max(100, getStartupIsolationLeftMs() + 80));
      return () => {
        cancelled = true;
        if (isolationTimer) window.clearTimeout(isolationTimer);
      };
    }

    const clearTimer = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const clearHeartbeat = () => {
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const markNoPendingQuiet = () => {
      const now = Date.now();
      lastNoPendingAtRef.current = now;
      quietUntilRef.current = now + NO_PENDING_QUIET_MS;
    };

    const restoredRecentRecovery = restoreRecentRecoveryState({
      recentRecoveredByOidRef,
      restoredRecentRecoveredByOidRef,
    });
    if (Number(restoredRecentRecovery?.restoredCount || 0) > 0) {
      syncDebugLog('runner_recent_recovery_restore', {
        restoredCount: Number(restoredRecentRecovery?.restoredCount || 0),
      });
    }

    const scheduleRetry = (reason = 'retry', delayMs = FOLLOWUP_RETRY_MS) => {
      if (cancelled) return;
      clearRetryTimer();
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        kick(reason);
      }, Math.max(700, Number(delayMs) || FOLLOWUP_RETRY_MS));
    };

    const kick = (reason = 'generic') => {
      if (cancelled) return;
      const diagEnabled = isDiagEnabled();
      if (!diagEnabled && (reason === 'focus' || reason === 'pageshow' || reason === 'visibilitychange')) return;
      const canRun = canRunNow();
      const now = Date.now();
      const group = reasonGroup(reason);
      const isPassive = isPassiveReason(reason);
      const currentPath = getCurrentPathname();
      syncDebugLog('runner_kick_requested', { reason, group, canRunNow: canRun, diagEnabled, path: currentPath });
      if (!canRun) return;

      if (isPassive && isWithinHotRouteBootWindow(currentPath)) {
        syncDebugLog('runner_skip_hot_route_boot_window', {
          reason,
          group,
          path: currentPath,
          ageMs: Number(window.performance?.now?.() || 0),
        });
        return;
      }

      if (isPassive && quietUntilRef.current && now < Number(quietUntilRef.current || 0)) {
        syncDebugLog('runner_skip_no_pending_quiet', {
          reason,
          group,
          quietLeft: Math.max(0, Number(quietUntilRef.current || 0) - now),
        });
        return;
      }

      if (group === 'page_lifecycle') {
        const sinceLifecycleKick = now - Number(lastLifecycleKickAtRef.current || 0);
        if (
          (queuedLifecycleRef.current || !!timerRef.current || runningRef.current || (lastLifecycleKickAtRef.current && sinceLifecycleKick < LIFECYCLE_COALESCE_MS))
        ) {
          const previousReason = queuedReasonRef.current || 'page_lifecycle';
          const queuedReason = pickPreferredReason(previousReason, reason);
          if (timerRef.current) queuedReasonRef.current = queuedReason;
          syncDebugLog('runner_kick_coalesced', {
            previousReason,
            addedReason: reason,
            queuedReason,
          });
          return;
        }
      }

      const dedupeMs = isPassive ? PASSIVE_REASON_DEDUPE_MS : SAME_REASON_DEDUPE_MS;
      const lastKickAt = Number(lastKickByGroupRef.current?.[group] || 0);
      if (lastKickAt && now - lastKickAt < dedupeMs) {
        syncDebugLog('runner_kick_deduped', { reason, group, dedupeMs, sinceLastKick: now - lastKickAt });
        return;
      }
      lastKickByGroupRef.current[group] = now;

      if (runningRef.current) {
        syncDebugLog('runner_skip_already_running', { reason, group });
        return;
      }

      if (timerRef.current) {
        const previousReason = queuedReasonRef.current || 'generic';
        const nextReason = pickPreferredReason(previousReason, reason);
        queuedReasonRef.current = nextReason;
        syncDebugLog('runner_kick_coalesced', { previousReason, addedReason: reason, queuedReason: nextReason });
        return;
      }

      queuedReasonRef.current = reason;
      queuedAtRef.current = now;
      if (group === 'page_lifecycle') {
        queuedLifecycleRef.current = true;
        lastLifecycleKickAtRef.current = now;
      }

      timerRef.current = window.setTimeout(async () => {
        const fireReason = queuedReasonRef.current || reason;
        const fireGroup = reasonGroup(fireReason);
        const scheduledForMs = queuedAtRef.current ? Date.now() - Number(queuedAtRef.current || 0) : null;
        queuedReasonRef.current = '';
        queuedAtRef.current = 0;
        timerRef.current = null;
        if (fireGroup === 'page_lifecycle') queuedLifecycleRef.current = false;

        if (cancelled || !canRunNow()) return;
        if (runningRef.current) {
          syncDebugLog('runner_skip_already_running', { reason: fireReason, group: fireGroup, scheduledForMs });
          return;
        }

        const initialSnapshot = await readQueueSnapshot();
        if (!initialSnapshot.pendingCount && !initialSnapshot.deadCount) {
          markNoPendingQuiet();
          syncDebugLog('runner_idle_no_pending', { reason: fireReason, group: fireGroup });
          clearRetryTimer();
          return;
        }

        try {
          syncDebugLog('runner_timer_fire', { reason: fireReason, group: fireGroup, scheduledForMs });
          const repairRes = await repairPendingBaseCreateOps({ source: `runner:${fireReason}`, limit: 12 });
          if (Number(repairRes?.repaired || 0) > 0) {
            syncDebugLog('runner_repaired_queue', { reason: fireReason, group: fireGroup, repaired: Number(repairRes?.repaired || 0) });
          }
        } catch {}

        const postRepairSnapshot = await readQueueSnapshot();
        if (!postRepairSnapshot.pendingCount && !postRepairSnapshot.deadCount) {
          markNoPendingQuiet();
          syncDebugLog('runner_idle_no_pending', { reason: fireReason, group: fireGroup });
          clearRetryTimer();
          return;
        }

        const runNow = Date.now();
        const gapMs = isManualishReason(fireReason) ? MANUAL_MIN_GAP_MS : MIN_GAP_MS;
        const sinceLastRun = runNow - Number(lastRunAtRef.current || 0);

        if (lastRunAtRef.current && sinceLastRun < gapMs) {
          const waitLeft = Math.max(900, gapMs - sinceLastRun + 250);
          bootLog('offline_sync_runner_deferred', { reason: fireReason, pendingCount: postRepairSnapshot.pendingCount, gapMs, waitLeft });
          scheduleRetry(`retry_after_gap:${fireReason}`, waitLeft);
          return;
        }

        runningRef.current = true;
        try {
          bootLog('offline_sync_runner_kick', { reason: fireReason, pendingCount: postRepairSnapshot.pendingCount, gapMs });
          syncDebugLog('runner_kick', { reason: fireReason, group: fireGroup, pendingCount: postRepairSnapshot.pendingCount, gapMs });
          const res = await syncNow({ immediate: true, source: `OfflineSyncRunner:${fireReason}` });
          const stillPending = await readPendingCount();

          if (stillPending > 0 && canRunNow()) {
            const slowPath = !!res?.locked || !!res?.networkStop || !!res?.offline;
            const currentPath = getCurrentPathname();
            const slowDelayMs = isHotInteractivePath(currentPath) ? HOT_ROUTE_SLOW_RETRY_MS : 7000;
            scheduleRetry(
              slowPath ? `followup_slow:${fireReason}` : `followup_pending:${fireReason}`,
              slowPath ? slowDelayMs : FOLLOWUP_RETRY_MS
            );
          } else {
            markNoPendingQuiet();
            clearRetryTimer();
          }
        } catch (error) {
          bootLog('offline_sync_runner_fail', { reason: fireReason, error: error?.message || String(error || '') });
          const currentPath = getCurrentPathname();
          scheduleRetry(`followup_error:${fireReason}`, isHotInteractivePath(currentPath) ? HOT_ROUTE_SLOW_RETRY_MS : 7000);
        } finally {
          lastRunAtRef.current = Date.now();
          runningRef.current = false;
        }
      }, DEBOUNCE_MS);
    };

    const onOnline = () => kick('online');
    const onFocus = () => kick('focus');
    const onPageShow = () => kick('pageshow');
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      kick('visibilitychange');
    };
    const onOutboxChanged = () => kick('outbox_changed');
    const onManualTrigger = () => kick('manual_trigger');

    const mountPath = typeof window !== 'undefined' ? window.location.pathname || '' : '';
    if (isTransportPath(mountPath)) {
      syncDebugLog('runner_skip_transport_scope', { path: mountPath });
      return () => {};
    }
    if (!shouldRunOfflineRuntime(mountPath)) {
      syncDebugLog('runner_skip_browser_context', { path: mountPath });
      return () => {};
    }

    syncDebugLog('runner_mount', { path: mountPath });

    window.addEventListener('online', onOnline, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('tepiha:outbox-changed', onOutboxChanged);
    window.addEventListener('TEPIHA_SYNC_TRIGGER', onManualTrigger);
    document.addEventListener('visibilitychange', onVisible, { passive: true });

    kick('mount');
    window.setTimeout(() => {
      if (!cancelled) kick('startup_nudge');
    }, 2200);

    heartbeatRef.current = window.setInterval(() => {
      if (cancelled) return;
      void (async () => {
        const pending = await readPendingCount();
        if (pending > 0) kick('heartbeat');
      })();
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      persistRecentRecoveryState(recentRecoveredByOidRef, restoredRecentRecoveredByOidRef);
      clearTimer();
      clearRetryTimer();
      clearHeartbeat();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('tepiha:outbox-changed', onOutboxChanged);
      window.removeEventListener('TEPIHA_SYNC_TRIGGER', onManualTrigger);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bootAttempt]);

  return null;
}
