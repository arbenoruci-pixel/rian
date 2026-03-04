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

function wrapAwaitable(builder, meta) {
  if (!builder || typeof builder !== 'object') return builder;

  // Many supabase-js builders are "thenable"; awaiting them calls .then
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        return (onFulfilled, onRejected) =>
          target.then(
            (res) => {
              try {
                if (res?.error) {
                  pushGlobalError('db/supabase', res.error, {
                    ...meta,
                    kind: 'result.error',
                  });
                }
              } catch {}
              return onFulfilled ? onFulfilled(res) : res;
            },
            (err) => {
              try {
                pushGlobalError('db/supabase', err, {
                  ...meta,
                  kind: 'promise.reject',
                });
              } catch {}
              return onRejected ? onRejected(err) : Promise.reject(err);
            }
          );
      }

      if (prop === 'catch') {
        return (onRejected) =>
          target.catch((err) => {
            try {
              pushGlobalError('db/supabase', err, { ...meta, kind: 'catch' });
            } catch {}
            return onRejected ? onRejected(err) : Promise.reject(err);
          });
      }

      if (prop === 'finally') {
        return (onFinally) => target.finally(onFinally);
      }

      const value = Reflect.get(target, prop, receiver);

      if (typeof value === 'function') {
        return (...args) => {
          try {
            const out = value.apply(target, args);
            // keep chaining safe
            if (out && typeof out === 'object') {
              // if the method returns the same builder, return proxy to keep instrumentation
              if (out === target) return proxy;
              // if it returns another builder/thenable, wrap it too
              if (typeof out.then === 'function') {
                return wrapAwaitable(out, { ...meta, op: meta?.op || String(prop) });
              }
            }
            return out;
          } catch (err) {
            try {
              pushGlobalError('db/supabase', err, { ...meta, kind: 'method.throw', method: String(prop) });
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
                return p
                  .then((res) => {
                    try {
                      if (res?.error) pushGlobalError('auth/supabase', res.error, { method: String(prop) });
                    } catch {}
                    return res;
                  })
                  .catch((err) => {
                    try {
                      pushGlobalError('auth/supabase', err, { method: String(prop) });
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
