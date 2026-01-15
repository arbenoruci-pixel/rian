'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RedirectToArka() {
  const router = useRouter();
  useEffect(() => { router.replace('/arka'); }, [router]);
  return null;
}
