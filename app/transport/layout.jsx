'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getTransportSession } from '@/lib/transportAuth';

// Guard for ALL /transport/* pages.
// - If user is not logged-in as TRANSPORT -> redirect to /login (main app login).
// - No half UI.

export default function TransportLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    // Allow main login route via AuthGate; Transport has no separate login.
    const s = getTransportSession();
    const tid = s?.transport_id ? String(s.transport_id) : null;

    if (!tid) {
      // Not TRANSPORT (or no session). Go to main login.
      router.replace('/login');
      return;
    }

    setOk(true);
  }, [router, pathname]);

  if (!ok) return null;
  return children;
}
