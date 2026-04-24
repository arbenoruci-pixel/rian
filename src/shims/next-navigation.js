import { useLocation, useNavigate, useParams as useRRParams } from 'react-router-dom';
import { useMemo } from 'react';

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (to) => navigate(to),
    replace: (to) => navigate(to, { replace: true }),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => window.location.reload(),
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
    window.location.replace(String(to || '/'));
  }
  return null;
}
