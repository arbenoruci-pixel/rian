'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Kept only for backwards-compat imports. Do NOT send users to ARKA.
export default function TransportRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/transport'); }, [router]);
  return null;
}
