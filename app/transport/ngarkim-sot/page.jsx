'use client';

import React from 'react';
import { useRouter } from 'next/navigation';

// NGARKIM SOT – CHECKLIST (safe client-only page)
// Fixes Vercel prerender error by avoiding unsupported Server Component payloads.

export const dynamic = 'force-dynamic';

export default function NgarkimSotPage() {
  const router = useRouter();

  return (
    <div style={{ padding: 16, maxWidth: 640, margin: '0 auto', color: '#fff' }}>
      <h1 style={{ margin: 0, fontWeight: 900, letterSpacing: 1 }}>NGARKIM SOT</h1>
      <div style={{ opacity: 0.7, fontWeight: 700, marginTop: 6 }}>
        CHECKLIST • GATI → KAMION (DËRGESË)
      </div>

      <div style={{
        marginTop: 16,
        background: '#111',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 18,
        padding: 14
      }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>KJO FAQE ËSHTË GATI</div>
        <div style={{ opacity: 0.75, lineHeight: 1.4 }}>
          Tani nuk ka logjikë akoma (vetëm fix i build-it).
          Hapi tjetër: lidhja me GATI, renditja me GPS, konfirmimi (PO/WAIT/NO), dhe NGARKO në delivery.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          onClick={() => router.push('/transport/gati')}
          style={{
            flex: 1,
            background: '#222',
            border: '1px solid rgba(255,255,255,0.14)',
            color: '#fff',
            padding: '12px 14px',
            borderRadius: 14,
            fontWeight: 900
          }}
        >
          ← KTHEHU TE GATI
        </button>
        <button
          onClick={() => router.push('/transport/board')}
          style={{
            flex: 1,
            background: '#fff',
            border: 'none',
            color: '#000',
            padding: '12px 14px',
            borderRadius: 14,
            fontWeight: 900
          }}
        >
          BOARD
        </button>
      </div>
    </div>
  );
}
