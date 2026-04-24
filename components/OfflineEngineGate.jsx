'use client';

import { usePathname } from 'next/navigation';

export default function OfflineEngineGate({ children }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/debug/')) return null;
  return <>{children}</>;
}
