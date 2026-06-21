import { useLocation, useNavigate, useParams as useRRParams } from 'react-router-dom';
import { useMemo } from 'react';

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (to) => navigate(to),
    replace: (to) => navigate(to, { replace: true }),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => {
      try {
        window.dispatchEvent(new CustomEvent('tepiha:router-refresh-requested', {
          detail: { source: 'next-navigation-shim', noReload: true, at: new Date().toISOString() }
        }));
      } catch {}
    },
    prefetch: async () => {},
  }), [navigate]);
}

export function usePathname() {
  const location = useLocation();
  return location.pathname;
}

export function useSearchParams() {
  const location = useLocation();
  return useMemo(() => new URLSearchParams(location.search || ''), [location.search]);
}

export function useParams() {
  return useRRParams();
}

export function redirect(to) {
  if (typeof window !== 'undefined') {
    const target = String(to || '/');
    try {
      window.dispatchEvent(new CustomEvent('tepiha:router-redirect-requested', {
        detail: { source: 'next-navigation-shim', target, noBrowserReplace: true, at: new Date().toISOString() }
      }));
      window.history?.replaceState?.(window.history.state || {}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    } catch {}
  }
  return null;
}
