'use client';

import React from 'react';

export default function CloudSyncIcon({ pending = 0, busy = false, title = 'SYNC' }) {
  return (
    <div
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.04)',
        color: '#e5e7eb',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      <span>{busy ? '⟳' : '☁️'}</span>
      <span>{Number(pending || 0) > 0 ? pending : 'OK'}</span>
    </div>
  );
}
