'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TransportPranimRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/transport/pranimi');
  }, [router]);
  return null;
}
