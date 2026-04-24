'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TransportMarrjeSotPage() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      router.replace('/transport/board?tab=loaded&mode=out');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router]);

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 20, background: '#0b0f14', color: '#e5e7eb' }}>
      <div style={{ width: '100%', maxWidth: 420, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 18, background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Transport</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, opacity: 0.9 }}>
          Kjo faqe po ridrejtohet te board-i i transportit, qe kjo route mos me e hap ma faqen e bazes.
        </div>
      </div>
    </main>
  );
}
