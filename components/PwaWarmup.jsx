'use client';
import { useEffect } from 'react';

export default function PwaWarmup() {
  useEffect(() => {
    try {
      const key = 'tepiha_pwa_warmup_v1';
      if (localStorage.getItem(key)) return;
      if (!navigator.onLine) return;

      const urls = ['/', '/pranimi', '/pastrimi', '/gati', '/marrje-sot', '/transport', '/transport/board'];
      urls.forEach((u) => fetch(u, { cache: 'reload' }).catch(() => null));

      localStorage.setItem(key, '1');
    } catch {}
  }, []);

  return null;
}
