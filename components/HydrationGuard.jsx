'use client';

import { useEffect } from 'react';

export default function HydrationGuard({ children }) {
  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-client-mounted', '1');
      document.body?.setAttribute('data-client-mounted', '1');
    } catch {}

    return () => {
      try {
        document.documentElement.removeAttribute('data-client-mounted');
        document.body?.removeAttribute('data-client-mounted');
      } catch {}
    };
  }, []);

  return children;
}
