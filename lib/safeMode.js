export const SAFE_MODE_KEY = 'tepiha_safe_mode_v1';

function nowMs() {
  try { return Date.now(); } catch { return 0; }
}

function safeParse(raw, fallback = null) {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function readTepihaSafeMode() {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.sessionStorage?.getItem?.(SAFE_MODE_KEY) || window.localStorage?.getItem?.(SAFE_MODE_KEY) || '';
    const parsed = safeParse(raw, null);
    if (!parsed) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isTepihaSafeModeActive() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__TEPIHA_HOME_SAFE_MODE__ === true) return true;
    const sp = new URLSearchParams(window.location?.search || '');
    if (sp.get('safe') === '1' || sp.get('offline') === '1' || sp.get('safeMode') === '1' || sp.get('homeSafeMode') === '1') return true;
    const mode = readTepihaSafeMode();
    if (!mode) return false;
    const until = Math.max(
      Number(mode.disableSyncUntil || 0) || 0,
      Number(mode.disableUpdateChecksUntil || 0) || 0,
      Number(mode.disableWarmupUntil || 0) || 0,
      Number(mode.disableRuntimeUploadsUntil || 0) || 0,
      Number(mode.expiresAt || 0) || 0,
    );
    return !until || until > nowMs();
  } catch {
    return false;
  }
}

export function isSafeModeDisabledUntil(field) {
  try {
    const mode = readTepihaSafeMode();
    const until = Number(mode?.[field] || 0) || 0;
    return until > nowMs();
  } catch {
    return false;
  }
}

export function safeModeLeftMs(field) {
  try {
    const mode = readTepihaSafeMode();
    const until = Number(mode?.[field] || 0) || 0;
    return Math.max(0, until - nowMs());
  } catch {
    return 0;
  }
}

export function writeTepihaSafeMode(payload = {}) {
  try {
    if (typeof window === 'undefined') return null;
    const now = nowMs();
    const entry = {
      at: new Date(now).toISOString(),
      ts: now,
      source: 'runtime',
      reason: 'safe_mode',
      ...payload,
    };
    const text = JSON.stringify(entry);
    try { window.sessionStorage?.setItem?.(SAFE_MODE_KEY, text); } catch {}
    try { window.localStorage?.setItem?.(SAFE_MODE_KEY, text); } catch {}
    try { window.__TEPIHA_HOME_SAFE_MODE__ = true; } catch {}
    try { window.dispatchEvent(new CustomEvent('tepiha:safe-mode', { detail: entry })); } catch {}
    return entry;
  } catch {
    return null;
  }
}
