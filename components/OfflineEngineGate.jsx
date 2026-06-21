'use client';

import { usePathname } from '@/lib/routerCompat.jsx';

export default function OfflineEngineGate({ children }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/debug/')) return null;
  return <>{children}</>;
}
