'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Legacy page kept only for backwards links.
// Main ARKA flow is now in /arka/cash.
export default function ArkaBuxhetiPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/arka/cash');
  }, [router]);

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      <div style={{ opacity: 0.8, marginBottom: 10 }}>ARKA / BUXHETI</div>
      <div>DUKE U RIDREJTUAR NE /ARKA/CASH...</div>
    </div>
  );
}
