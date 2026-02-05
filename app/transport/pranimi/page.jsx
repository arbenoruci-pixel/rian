'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TransportPranimiRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/transport/pranim');
  }, [router]);

  return null;
}
