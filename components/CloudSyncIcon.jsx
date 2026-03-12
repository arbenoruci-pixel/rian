"use client";

import React, { useEffect, useMemo, useState } from 'react';

// Small global indicator for Outbox/Sync state.
// - pending > 0  => yellow spinning cloud
// - failed  > 0  => red warning cloud
// - empty         => green check cloud

const OUTBOX_KEY = 'tepiha_outbox_v1';

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function getOutboxSummary() {
  if (typeof window === 'undefined') return { pending: 0, failed: 0, total: 0 };
  const list = safeParse(localStorage.getItem(OUTBOX_KEY), []);
  const arr = Array.isArray(list) ? list : [];
  let pending = 0;
  let failed = 0;
  for (const it of arr) {
    const st = String(it?.status || '');
    if (st === 'pending') pending += 1;
    else if (st === 'failed') failed += 1;
  }
  return { pending, failed, total: arr.length };
}

function ensureSpinKeyframes() {
  try {
    if (typeof document === 'undefined') return;
    const id = 'tepiha_cloudsync_spin_css_v1';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
@keyframes tepihaCloudSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
    document.head.appendChild(style);
  } catch {}
}

export default function CloudSyncIcon({ titlePrefix = 'SYNC', pollMs = 5000, size = 22 }) {
  const [summary, setSummary] = useState({ pending: 0, failed: 0, total: 0 });

  useEffect(() => {
    ensureSpinKeyframes();
    const tick = () => setSummary(getOutboxSummary());
    tick();

    const t = setInterval(tick, Math.max(1000, Number(pollMs || 5000)));

    const onStorage = (e) => {
      if (!e) return;
      if (e.key === OUTBOX_KEY) tick();
    };
    const onNet = () => tick();

    try { window.addEventListener('storage', onStorage); } catch {}
    try { window.addEventListener('online', onNet); } catch {}
    try { window.addEventListener('offline', onNet); } catch {}

    return () => {
      clearInterval(t);
      try { window.removeEventListener('storage', onStorage); } catch {}
      try { window.removeEventListener('online', onNet); } catch {}
      try { window.removeEventListener('offline', onNet); } catch {}
    };
  }, [pollMs]);

  const state = useMemo(() => {
    if (summary.failed > 0) return 'failed';
    if (summary.pending > 0) return 'pending';
    return 'ok';
  }, [summary.failed, summary.pending]);

  const title = useMemo(() => {
    if (state === 'failed') return `${titlePrefix}: FAILED (${summary.failed})`;
    if (state === 'pending') return `${titlePrefix}: PENDING (${summary.pending})`;
    return `${titlePrefix}: OK`;
  }, [state, summary.failed, summary.pending, titlePrefix]);

  const color = state === 'failed' ? '#ef4444' : state === 'pending' ? '#f59e0b' : '#22c55e';

  return (
    <div
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size + 8,
        height: size + 8,
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(15,23,42,0.60)',
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          position: 'relative',
          color,
        }}
      >
        {/* cloud */}
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M7.2 18.2h9.1a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.7 9.9 3.7 3.7 0 0 0 7.2 18.2Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {/* overlay icon */}
        {state === 'ok' ? (
          <div
            style={{
              position: 'absolute',
              right: -2,
              bottom: -3,
              fontSize: 12,
              lineHeight: 1,
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
            }}
          >
            ✅
          </div>
        ) : state === 'failed' ? (
          <div
            style={{
              position: 'absolute',
              right: 1,
              bottom: -1,
              fontSize: 14,
              fontWeight: 900,
              lineHeight: 1,
              color: '#ef4444',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
            }}
          >
            !
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                border: '2px solid rgba(245,158,11,0.35)',
                borderTopColor: '#f59e0b',
                animation: 'tepihaCloudSpin 0.9s linear infinite',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
