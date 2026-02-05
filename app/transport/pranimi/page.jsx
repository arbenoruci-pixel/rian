'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Kept for backwards URL. Main transport PRANIMI is /transport/pranim
export default function TransportPranimiRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/transport/pranim'); }, [router]);
  return null;
}
