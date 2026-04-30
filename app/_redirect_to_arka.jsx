'use client';

import { useEffect } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';

export default function RedirectToArka() {
  const router = useRouter();
  useEffect(() => { router.replace('/arka'); }, [router]);
  return null;
}
