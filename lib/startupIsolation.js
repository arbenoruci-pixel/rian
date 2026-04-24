export const STARTUP_ISOLATION_WINDOW_MS = 4500;
const STORAGE_KEY = '__TEPIHA_STARTUP_ISOLATION_UNTIL__';

function isBrowser() {
  return typeof window !== 'undefined';
}

function safeReadNumber(value) {
  const next = Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}

export function isStartupIsolationEnabled() {
  if (!isBrowser()) return false;
  try {
    return window.__TEPIHA_STARTUP_ISOLATION__ === true;
  } catch {
    return false;
  }
}

export function getStartupIsolationUntil() {
  if (!isBrowser()) return 0;
  let until = 0;
  try {
    until = Math.max(until, safeReadNumber(window.__TEPIHA_STARTUP_ISOLATION_UNTIL__));
  } catch {}
  try {
    until = Math.max(until, safeReadNumber(window.sessionStorage?.getItem?.(STORAGE_KEY)));
  } catch {}
  return until;
}

export function getStartupIsolationLeftMs() {
  const until = getStartupIsolationUntil();
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

export function isWithinStartupIsolationWindow() {
  if (!isStartupIsolationEnabled()) return false;
  return getStartupIsolationLeftMs() > 0;
}

export function scheduleAfterStartupIsolation(callback, { bufferMs = 80 } = {}) {
  if (!isBrowser()) return () => {};
  const leftMs = getStartupIsolationLeftMs();
  const delayMs = Math.max(0, leftMs + Math.max(0, Number(bufferMs) || 0));
  const timer = window.setTimeout(() => {
    try { callback?.(); } catch {}
  }, delayMs);
  return () => {
    try { window.clearTimeout(timer); } catch {}
  };
}
