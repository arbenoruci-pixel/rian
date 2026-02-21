'use client';

import React, { useEffect } from 'react';

// Global error boundary for the App Router.
// Shows the real runtime error instead of the generic Safari/Next "client-side exception" page.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('GLOBAL APP ERROR:', error);
  }, [error]);

  const msg = (error && (error.message || String(error))) || 'UNKNOWN ERROR';
  const stack = error?.stack ? String(error.stack) : '';

  return (
    <html>
      <body style={{ margin: 0, background: '#05070d', color: '#fff', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
          <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 22 }}>
            APPLICATION ERROR
          </div>
          <div style={{ opacity: 0.8, marginTop: 8 }}>
            {msg}
          </div>

          {stack ? (
            <pre style={{ marginTop: 14, padding: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {stack}
            </pre>
          ) : null}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              onClick={() => reset()}
              style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 800, letterSpacing: 1 }}
            >
              TRY AGAIN
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 800, letterSpacing: 1 }}
            >
              RELOAD
            </button>
          </div>

          <div style={{ opacity: 0.6, marginTop: 14, fontSize: 12 }}>
            Hint: open Safari console (or remote debug) to see "GLOBAL APP ERROR" log.
          </div>
        </div>
      </body>
    </html>
  );
}
