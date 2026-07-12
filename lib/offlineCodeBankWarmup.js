import {
  getOfflineCodeBankSummarySync,
  refreshOfflineCodeBanks,
} from './offlineCodeBank.js';

export const OFFLINE_CODE_BANK_WARMUP_VERSION = 'offline-code-bank-fast-warmup-v1';

const TARGET = 10;
const LEASE_HOURS = 720;
const TIMEOUT_MS = 12000;
const MIN_GAP_MS = 1200;

let installed = false;
let inFlight = null;
let lastStartedAt = 0;
let timers = [];

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isOnlineNow() {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

function withTimeout(promise, timeoutMs = TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        const error = new Error('OFFLINE_CODE_BANK_FAST_WARMUP_TIMEOUT');
        error.code = 'OFFLINE_CODE_BANK_FAST_WARMUP_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

function summaryReady() {
  const summary = getOfflineCodeBankSummarySync() || {};
  return Number(summary?.base?.available || 0) >= TARGET
    && Number(summary?.transport?.available || 0) >= TARGET;
}

function publish(source, payload = {}) {
  if (!isBrowser()) return;
  const detail = {
    version: OFFLINE_CODE_BANK_WARMUP_VERSION,
    source: String(source || 'unknown'),
    at: new Date().toISOString(),
    summary: getOfflineCodeBankSummarySync() || {},
    ...payload,
  };
  try { window.__TEPIHA_OFFLINE_CODE_BANK_WARMUP_LAST__ = detail; } catch {}
  try { window.localStorage.setItem('tepiha_offline_code_bank_warmup_last_v1', JSON.stringify(detail)); } catch {}
  try { window.dispatchEvent(new CustomEvent('tepiha:offline-code-bank-warmup', { detail })); } catch {}
}

export async function refreshOfflineCodeBanksFast(source = 'manual', options = {}) {
  if (!isBrowser()) return { ok: false, reason: 'NOT_BROWSER' };
  if (!isOnlineNow()) return { ok: false, offline: true, reason: 'NO_NETWORK' };

  const force = options?.force === true;
  const now = Date.now();
  if (!force && summaryReady()) {
    const result = { ok: true, skipped: true, reason: 'BANK_ALREADY_FULL' };
    publish(source, result);
    return result;
  }
  if (inFlight) return inFlight;
  if (!force && now - lastStartedAt < MIN_GAP_MS) {
    return { ok: false, skipped: true, reason: 'FAST_WARMUP_THROTTLED' };
  }

  lastStartedAt = now;
  inFlight = withTimeout(
    refreshOfflineCodeBanks({ target: TARGET, leaseHours: LEASE_HOURS }),
    Number(options?.timeoutMs || TIMEOUT_MS),
  )
    .then((result) => {
      const payload = {
        ok: result?.ok === true,
        result,
      };
      publish(source, payload);
      return payload;
    })
    .catch((error) => {
      const payload = {
        ok: false,
        error: String(error?.message || error || 'OFFLINE_CODE_BANK_FAST_WARMUP_FAILED'),
      };
      publish(source, payload);
      return payload;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

function schedule(delayMs, source, options = {}) {
  if (!isBrowser()) return;
  const timer = window.setTimeout(() => {
    refreshOfflineCodeBanksFast(source, options).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
  timers.push(timer);
}

export function installOfflineCodeBankWarmup() {
  if (!isBrowser() || installed) return () => {};
  installed = true;

  schedule(0, 'startup-immediate', { force: true });
  schedule(900, 'startup-retry-1');
  schedule(3500, 'startup-retry-2');
  schedule(9000, 'startup-retry-3');

  const onOnline = () => {
    schedule(0, 'online-immediate', { force: true });
    schedule(1200, 'online-retry');
  };
  const onSessionChanged = () => {
    schedule(80, 'session-changed', { force: true });
    schedule(1500, 'session-changed-retry');
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'visible' || !isOnlineNow()) return;
    if (!summaryReady()) schedule(120, 'visibility-missing-bank', { force: true });
  };
  const onPageShow = () => {
    if (!isOnlineNow()) return;
    if (!summaryReady()) schedule(120, 'pageshow-missing-bank', { force: true });
  };

  window.addEventListener('online', onOnline, { passive: true });
  window.addEventListener('tepiha:session-changed', onSessionChanged, { passive: true });
  window.addEventListener('pageshow', onPageShow, { passive: true });
  document.addEventListener('visibilitychange', onVisibility, { passive: true });

  try {
    window.__TEPIHA_OFFLINE_CODE_BANK_WARMUP__ = {
      version: OFFLINE_CODE_BANK_WARMUP_VERSION,
      refresh: refreshOfflineCodeBanksFast,
      summary: getOfflineCodeBankSummarySync,
    };
  } catch {}

  return () => {
    installed = false;
    for (const timer of timers) {
      try { window.clearTimeout(timer); } catch {}
    }
    timers = [];
    window.removeEventListener('online', onOnline);
    window.removeEventListener('tepiha:session-changed', onSessionChanged);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export default {
  OFFLINE_CODE_BANK_WARMUP_VERSION,
  installOfflineCodeBankWarmup,
  refreshOfflineCodeBanksFast,
};
