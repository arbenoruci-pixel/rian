// lib/supabaseClient.js
// Hard-wired Supabase client for Arben's Tepiha Next.js app.

import { createClient } from '@supabase/supabase-js';
import { pushGlobalError } from '@/lib/globalErrors';

// NOTE: Export these constants so client pages can fall back to REST
// if the supabase-js request hangs/fails on mobile Safari.
export const SUPABASE_URL = 'https://vnidjrxidvusulinozbn.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA';

function isBrowser() {
  return typeof window !== 'undefined';
}

const DEFAULT_SUPABASE_TIMEOUT_MS = 5000;

function createSupabaseTimeoutError(ms, label = 'SUPABASE_TIMEOUT') {
  const error = new Error(String(label || 'SUPABASE_TIMEOUT'));
  error.name = 'AbortError';
  error.code = String(label || 'SUPABASE_TIMEOUT');
  error.timeoutMs = Number(ms) || DEFAULT_SUPABASE_TIMEOUT_MS;
  error.isSupabaseTimeout = true;
  return error;
}

function bindAbortSignal(target, signal) {
  if (!target || typeof target !== 'object' || !signal) return target;
  try {
    if (typeof target.abortSignal === 'function') {
      return target.abortSignal(signal) || target;
    }
  } catch {}
  return target;
}

function awaitWithSupabaseTimeout(target, meta = {}) {
  const ms = Number(meta?.timeoutMs) > 0 ? Number(meta.timeoutMs) : DEFAULT_SUPABASE_TIMEOUT_MS;
  if (!(ms > 0)) return Promise.resolve(target);

  let timeoutId = null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const queryTarget = controller ? bindAbortSignal(target, controller.signal) : target;
  const pending = Promise.resolve(queryTarget);
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try { controller?.abort(); } catch {}
      const err = createSupabaseTimeoutError(ms, meta?.timeoutLabel || 'SUPABASE_TIMEOUT');
      try {
        pushGlobalError('db/supabase', err, {
          ...meta,
          kind: 'timeout',
          timeoutMs: ms,
        });
      } catch {}
      reject(err);
    }, ms);
  });

  return Promise.race([pending, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function wrapAwaitable(builder, meta) {
  if (!builder || typeof builder !== 'object') return builder;

  const getMeta = () => ({
    ...(meta || {}),
    timeoutMs: Number(meta?.timeoutMs) > 0 ? Number(meta.timeoutMs) : DEFAULT_SUPABASE_TIMEOUT_MS,
    timeoutLabel: String(meta?.timeoutLabel || 'SUPABASE_TIMEOUT'),
  });

  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'timeout') {
        return (ms = DEFAULT_SUPABASE_TIMEOUT_MS, label = 'SUPABASE_TIMEOUT') =>
          wrapAwaitable(target, {
            ...getMeta(),
            timeoutMs: Number(ms) > 0 ? Number(ms) : DEFAULT_SUPABASE_TIMEOUT_MS,
            timeoutLabel: String(label || 'SUPABASE_TIMEOUT'),
          });
      }

      if (prop === 'then') {
        return (onFulfilled, onRejected) =>
          awaitWithSupabaseTimeout(target, getMeta()).then(
            (res) => {
              try {
                if (res?.error) {
                  pushGlobalError('db/supabase', res.error, {
                    ...getMeta(),
                    kind: 'result.error',
                  });
                }
              } catch {}
              return onFulfilled ? onFulfilled(res) : res;
            },
            (err) => {
              try {
                pushGlobalError('db/supabase', err, {
                  ...getMeta(),
                  kind: err?.isSupabaseTimeout ? 'timeout.reject' : 'promise.reject',
                });
              } catch {}
              return onRejected ? onRejected(err) : Promise.reject(err);
            }
          );
      }

      if (prop === 'catch') {
        return (onRejected) =>
          awaitWithSupabaseTimeout(target, getMeta()).catch((err) => {
            try {
              pushGlobalError('db/supabase', err, {
                ...getMeta(),
                kind: err?.isSupabaseTimeout ? 'timeout.catch' : 'catch',
              });
            } catch {}
            return onRejected ? onRejected(err) : Promise.reject(err);
          });
      }

      if (prop === 'finally') {
        return (onFinally) => awaitWithSupabaseTimeout(target, getMeta()).finally(onFinally);
      }

      const value = Reflect.get(target, prop, receiver);

      if (typeof value === 'function') {
        return (...args) => {
          try {
            const out = value.apply(target, args);
            if (out && typeof out === 'object') {
              if (out === target) return wrapAwaitable(target, getMeta());
              if (typeof out.then === 'function') {
                return wrapAwaitable(out, {
                  ...getMeta(),
                  op: meta?.op || String(prop),
                });
              }
            }
            return out;
          } catch (err) {
            try {
              pushGlobalError('db/supabase', err, {
                ...getMeta(),
                kind: 'method.throw',
                method: String(prop),
              });
            } catch {}
            throw err;
          }
        };
      }

      return value;
    },
  });

  return proxy;
}

function createSensorSupabase(client) {
  // Wrap from('table') queries
  const baseFrom = client.from.bind(client);
  const baseRpc = client.rpc.bind(client);

  const out = {
    ...client,
    from(table) {
      const b = baseFrom(table);
      return wrapAwaitable(b, { table: String(table || '') });
    },
    rpc(fn, params, opts) {
      const b = baseRpc(fn, params, opts);
      return wrapAwaitable(b, { rpc: String(fn || '') });
    },
  };

  // Wrap auth calls too (they return promises)
  try {
    if (out.auth && typeof out.auth === 'object') {
      const authObj = out.auth;
      out.auth = new Proxy(authObj, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v !== 'function') return v;
          return (...args) => {
            try {
              const p = v.apply(target, args);
              if (p && typeof p.then === 'function') {
                return awaitWithSupabaseTimeout(p, { scope: 'auth', method: String(prop) })
                  .then((res) => {
                    try {
                      if (res?.error) pushGlobalError('auth/supabase', res.error, { method: String(prop) });
                    } catch {}
                    return res;
                  })
                  .catch((err) => {
                    try {
                      pushGlobalError('auth/supabase', err, { method: String(prop), kind: err?.isSupabaseTimeout ? 'timeout' : 'reject' });
                    } catch {}
                    throw err;
                  });
              }
              return p;
            } catch (err) {
              try {
                pushGlobalError('auth/supabase', err, { method: String(prop), kind: 'throw' });
              } catch {}
              throw err;
            }
          };
        },
      });
    }
  } catch {}

  // Window-level sensor for unhandled rejections from supabase/fetch etc.
  if (isBrowser()) {
    try {
      if (!window.__tepihaUnhandledRejectionSensor) {
        window.__tepihaUnhandledRejectionSensor = true;
        window.addEventListener('unhandledrejection', (ev) => {
          try {
            pushGlobalError('ui/unhandledrejection', ev?.reason || 'UNHANDLED_REJECTION');
          } catch {}
        });
      }
    } catch {}
  }

  return out;
}

export const supabase = createSensorSupabase(createClient(SUPABASE_URL, SUPABASE_ANON_KEY));

// Compatibility: allow both named and default import
export default supabase;
