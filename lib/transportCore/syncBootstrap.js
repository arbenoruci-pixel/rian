import { scheduleRunTransportSync } from '@/lib/transportCore/syncEngine';

let started = false;
let timer = null;
let onlineHandler = null;
let focusHandler = null;
let visibilityHandler = null;
let triggerHandler = null;
let debounceTimer = null;
let lastKickAt = 0;
let lastWakeAt = 0;
let lastTriggerAt = 0;

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

export function startTransportSyncLoop({ intervalMs = 25000, debounceMs = 1200, wakeDebounceMs = 1800, triggerDebounceMs = 1200, minGapMs = 3000 } = {}) {
  if (typeof window === 'undefined') return stopTransportSyncLoop;
  if (window.__tepihaTransportSyncStarted) return stopTransportSyncLoop;
  if (started) return stopTransportSyncLoop;

  window.__tepihaTransportSyncStarted = true;
  started = true;

  const kick = (source = 'generic') => {
    try {
      if (!canKick()) return;
      const now = Date.now();
      const recentWake = lastWakeAt > 0 && (now - lastWakeAt) < 3500;
      const recentKick = lastKickAt > 0 && (now - lastKickAt) < minGapMs;
      const recentTrigger = lastTriggerAt > 0 && (now - lastTriggerAt) < triggerDebounceMs;
      if ((source === 'focus' || source === 'visibility' || source === 'online') && recentKick) return;
      if (source === 'trigger' && (recentKick || recentTrigger)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      const effectiveDebounce = Math.max(
        debounceMs,
        source === 'trigger' ? triggerDebounceMs : 0,
        (source === 'focus' || source === 'visibility' || recentWake) ? wakeDebounceMs : 0,
      );
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        try {
          if (!canKick()) return;
          const stamp = Date.now();
          if (lastKickAt > 0 && (stamp - lastKickAt) < minGapMs) return;
          if (source === 'trigger') lastTriggerAt = stamp;
          lastKickAt = stamp;
          scheduleRunTransportSync({ auto: true, source: `transportSync:${source}`, delayMs: 120 });
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
  return stopTransportSyncLoop;
}

export function stopTransportSyncLoop() {
  if (typeof window === 'undefined') return;
  started = false;
  lastKickAt = 0;
  lastWakeAt = 0;
  lastTriggerAt = 0;
  try { delete window.__tepihaTransportSyncStarted; } catch { try { window.__tepihaTransportSyncStarted = false; } catch {} }
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
