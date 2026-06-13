import { scheduleRunSync } from '@/lib/syncEngine';
import { isDiagEnabled } from '@/lib/diagMode';

let started = false;
let timer = null;
let onlineHandler = null;
let focusHandler = null;
let visibilityHandler = null;
let debounceTimer = null;
let triggerHandler = null;
let lastKickAt = 0;
let lastWakeAt = 0;
let lastTriggerAt = 0;
let activeScopeKey = 'default';

function canKick() {
  try {
    if (typeof window === 'undefined') return false;
    if (document?.hidden) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return true;
  } catch {
    return true;
  }
}

export function startSyncLoop({ intervalMs = 5 * 60 * 1000, debounceMs = 2600, wakeDebounceMs = 5200, triggerDebounceMs = 4500, minGapMs = 60000, scopeKey = 'default', syncOpts = {} } = {}) {
  if (typeof window === 'undefined') return stopSyncLoop;

  if (typeof window !== 'undefined') {
    const currentKey = String(scopeKey || 'default');
    if (started && activeScopeKey === currentKey && window.__tepihaSyncStarted) return stopSyncLoop;
    window.__tepihaSyncStarted = true;
    window.__tepihaSyncScopeKey = currentKey;
    activeScopeKey = currentKey;
  }

  if (started) return stopSyncLoop;
  started = true;

  const kick = (source = 'generic') => {
    try {
      if (!canKick()) return;
      const diagEnabled = isDiagEnabled();
      if (!diagEnabled && (source === 'focus' || source === 'visibility')) return;
      const now = Date.now();
      const recentWake = lastWakeAt > 0 && (now - lastWakeAt) < 5000;
      const recentKick = lastKickAt > 0 && (now - lastKickAt) < minGapMs;
      const recentTrigger = lastTriggerAt > 0 && (now - lastTriggerAt) < triggerDebounceMs;
      if ((source === 'focus' || source === 'visibility' || source === 'online') && recentKick) return;
      if (source === 'trigger' && (recentKick || recentTrigger)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      const effectiveDebounce = Math.max(
        debounceMs,
        source === 'trigger' ? triggerDebounceMs : 0,
        (source === 'focus' || source === 'visibility' || recentWake) ? wakeDebounceMs : 0
      );
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        try {
          if (!canKick()) return;
          const stamp = Date.now();
          if (lastKickAt > 0 && (stamp - lastKickAt) < minGapMs) return;
          if (source === 'trigger') lastTriggerAt = stamp;
          lastKickAt = stamp;
          scheduleRunSync({ auto: true, source: `syncBootstrap:${source}`, delayMs: 250, ...(syncOpts || {}) });
        } catch {}
      }, effectiveDebounce);
    } catch {}
  };

  onlineHandler = () => {
    lastWakeAt = Date.now();
    kick('online');
  };
  focusHandler = () => {
    if (document?.hidden) return;
    lastWakeAt = Date.now();
    kick('focus');
  };
  visibilityHandler = () => {
    if (document?.hidden) return;
    lastWakeAt = Date.now();
    kick('visibility');
  };

  triggerHandler = () => {
    lastWakeAt = Date.now();
    kick('trigger');
  };

  window.addEventListener('online', onlineHandler);
  window.addEventListener('focus', focusHandler);
  document.addEventListener('visibilitychange', visibilityHandler);
  window.addEventListener('TEPIHA_SYNC_TRIGGER', triggerHandler);

  timer = window.setInterval(() => {
    if (canKick()) kick('interval');
  }, intervalMs);

  kick('init');

  return stopSyncLoop;
}

export function stopSyncLoop() {
  if (typeof window === 'undefined') return;
  started = false;
  lastKickAt = 0;
  lastWakeAt = 0;
  lastTriggerAt = 0;

  try { delete window.__tepihaSyncStarted; } catch { try { window.__tepihaSyncStarted = false; } catch {} }
  try { delete window.__tepihaSyncScopeKey; } catch {}
  activeScopeKey = 'default';

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
  if (focusHandler) {
    window.removeEventListener('focus', focusHandler);
    focusHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (triggerHandler) {
    window.removeEventListener('TEPIHA_SYNC_TRIGGER', triggerHandler);
    triggerHandler = null;
  }
}
