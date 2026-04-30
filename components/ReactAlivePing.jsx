'use client';

import { useEffect } from 'react';

const RESCUE_KEY = '__tepiha_hydration_rescue__';

export default function ReactAlivePing() {
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      window.__REACT_IS_ALIVE__ = true;
      window.__TEPIHA_REACT_ALIVE_AT__ = Date.now();
      document?.documentElement?.setAttribute?.('data-react-alive', '1');
      document?.body?.setAttribute?.('data-react-alive', '1');
      try { sessionStorage.removeItem(RESCUE_KEY); } catch {}
      try {
        window.dispatchEvent(new CustomEvent('tepiha:react-alive', {
          detail: { ts: Date.now() },
        }));
      } catch {}
    } catch {}
  }, []);

  return null;
}
