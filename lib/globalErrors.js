// lib/globalErrors.js
// Global error sensor storage (client-side).
// Stores critical app errors (UI crashes, Supabase/RLS, Auth, Sync, API failures)
// into localStorage key: tepiha_global_errors

export const LS_GLOBAL_ERRORS = 'tepiha_global_errors';

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function safeGet() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(LS_GLOBAL_ERRORS);
    const parsed = raw ? safeJsonParse(raw, []) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeSet(arr) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(LS_GLOBAL_ERRORS, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

function safeStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    try {
      return String(x);
    } catch {
      return '[unstringifiable]';
    }
  }
}

function normalizeError(err) {
  if (!err) return { message: 'UNKNOWN_ERROR' };
  if (typeof err === 'string') return { message: err };
  const message = err?.message ? String(err.message) : String(err);
  const name = err?.name ? String(err.name) : undefined;
  const stack = err?.stack ? String(err.stack) : undefined;
  // Supabase/Postgrest often includes these
  const code = err?.code ? String(err.code) : undefined;
  const details = err?.details ? String(err.details) : undefined;
  const hint = err?.hint ? String(err.hint) : undefined;
  return { name, message, stack, code, details, hint };
}

export function pushGlobalError(where, err, meta = {}) {
  try {
    if (!isBrowser()) return;
    const arr = safeGet();
    const e = normalizeError(err);

    const entry = {
      ts: new Date().toISOString(),
      where: where || 'unknown',
      message: e.message,
      name: e.name,
      code: e.code,
      details: e.details,
      hint: e.hint,
      stack: e.stack,
      meta,
      href: (() => {
        try {
          return window.location?.href || '';
        } catch {
          return '';
        }
      })(),
      ua: (() => {
        try {
          return navigator?.userAgent || '';
        } catch {
          return '';
        }
      })(),
      online: (() => {
        try {
          return !!navigator?.onLine;
        } catch {
          return null;
        }
      })(),
    };

    arr.unshift(entry);
    safeSet(arr.slice(0, 200));
  } catch {
    // ignore
  }
}

export function readGlobalErrors() {
  return safeGet();
}

export function clearGlobalErrors() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(LS_GLOBAL_ERRORS);
  } catch {
    // ignore
  }
}

export function exportGlobalErrorsText() {
  return safeStringify(readGlobalErrors());
}
