'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from '@/lib/routerCompat.jsx';
import { bootLog, bootMarkReady, bootSnapshot } from '@/lib/bootLog';

function scheduleAfterPaint(fn) {
  try {
    requestAnimationFrame(() => {
      requestAnimationFrame(fn);
    });
  } catch {
    setTimeout(fn, 0);
  }
}

export default function BootMilestones() {
  const pathname = usePathname() || '/';
  const markedRef = useRef(false);

  useEffect(() => {
    const search = typeof window !== 'undefined' ? String(window.location.search || '') : '';
    bootLog('boot_milestones_mount', { path: pathname, search });
    if (pathname === '/') bootLog('home_mount', { path: pathname, search });
    bootSnapshot('milestones_mount', { path: pathname });

    if (!markedRef.current) {
      markedRef.current = true;
      scheduleAfterPaint(() => {
        bootMarkReady({ path: pathname, readyState: typeof document !== 'undefined' ? document.readyState : '' });
      });
    }
  }, [pathname]);

  return null;
}
