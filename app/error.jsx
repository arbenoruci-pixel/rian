'use client';

import React, { useEffect, useState } from 'react';
import { isChunkLoadLikeError, pushGlobalError } from '@/lib/globalErrors';
import { exportDebugText, logDebugEvent } from '@/lib/sensor';
import { exportLocalErrorLogText, pushLocalErrorLog } from '@/lib/localErrorLog';

export default function GlobalError({ error, reset }) {
  const [copied, setCopied] = useState(false);
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    console.error('GABIM GLOBAL I APP-IT:', error);
    try { pushGlobalError('ui/app_error_jsx', error); } catch {}
    try {
      const next = pushLocalErrorLog(error, {}, {
        boundaryKind: 'app_error_jsx',
        route: typeof window !== 'undefined' ? String(window.location?.pathname || '/') : '/',
        routeName: 'APP ERROR',
        componentName: 'app/error.jsx',
        sourceLayer: 'app_error_jsx',
      });
      setEntry(next);
    } catch {}
    try { logDebugEvent('app_error_boundary', { message: error?.message || String(error || ''), name: error?.name || '' }); } catch {}
    try {
      if (isChunkLoadLikeError(error)) {
        logDebugEvent('app_error_chunk_fallback_ui_no_reload', { message: error?.message || String(error || ''), name: error?.name || '' });
      }
    } catch {}
  }, [error]);

  const msg = (error && (error.message || String(error))) || 'UNKNOWN ERROR';
  const stack = error?.stack ? String(error.stack) : '';

  async function copyDebug() {
    try {
      const text = `${exportLocalErrorLogText(entry)}\n\n--- DEBUG SNAPSHOT ---\n${exportDebugText() || '{}'}`;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  }

  return (
    <html>
      <body style={{ margin: 0, background: '#05070d', color: '#fff', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
          <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 22 }}>
            GABIM NË APLIKACION
          </div>
          <div style={{ opacity: 0.8, marginTop: 8 }}>
            {msg}
          </div>

          {stack ? (
            <pre style={{ marginTop: 14, padding: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {stack}
            </pre>
          ) : null}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              onClick={() => reset()}
              style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 800, letterSpacing: 1 }}
            >
              PROVO PRAPË
            </button>
            <button
              onClick={copyDebug}
              style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 800, letterSpacing: 1 }}
            >
              {copied ? 'COPIED' : 'COPY DEBUG LOG'}
            </button>
            <a
            href="/"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 800, letterSpacing: 1, textDecoration: 'none' }}
            >
              KRYEFAQJA
            </a>
          </div>

          <div style={{ opacity: 0.6, marginTop: 14, fontSize: 12 }}>
            Global fallback u aktivizua pasi gabimi doli jashtë boundary-ve lokale.
          </div>
        </div>
      </body>
    </html>
  );
}
