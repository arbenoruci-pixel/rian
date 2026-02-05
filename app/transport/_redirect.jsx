'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TransportDisabled() {
  const router = useRouter();
  useEffect(() => { router.replace('/transport'); }, [router]);
  return null;
}
