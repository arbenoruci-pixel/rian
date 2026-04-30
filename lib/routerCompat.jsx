import React from 'react';
import {
  Link as ReactRouterLink,
  useLocation,
  useNavigate,
  useParams as useReactRouterParams,
} from 'react-router-dom';

function normalizeTo(value, fallback = '#') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') return value;
  try {
    if (value instanceof URL) return `${value.pathname || '/'}${value.search || ''}${value.hash || ''}`;
  } catch {}
  if (typeof value === 'object') {
    const pathname = value.pathname || value.path || fallback;
    const query = value.query && typeof value.query === 'object'
      ? `?${new URLSearchParams(value.query).toString()}`
      : (value.search || '');
    const hash = value.hash || '';
    return `${pathname || fallback}${query || ''}${hash || ''}`;
  }
  return String(value || fallback);
}

export function Link({ href, to, replace, scroll, prefetch, shallow, locale, legacyBehavior, passHref, ...props }) {
  const target = normalizeTo(to ?? href, '#');
  return <ReactRouterLink to={target} replace={!!replace} {...props} />;
}

export default Link;

export function useRouter() {
  const navigate = useNavigate();
  return React.useMemo(() => ({
    push: (to, options = {}) => navigate(normalizeTo(to, '/'), { replace: false, state: options?.state }),
    replace: (to, options = {}) => navigate(normalizeTo(to, '/'), { replace: true, state: options?.state }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => {
      // PATCH V27.1: Next.js router.refresh() shim must never hard reload
      // the Vite PWA. Emit a diagnostic event and let page-level refresh logic
      // decide what to do.
      try {
        window.dispatchEvent(new CustomEvent('tepiha:router-refresh-requested', {
          detail: { source: 'routerCompat', noReload: true, at: new Date().toISOString() }
        }));
      } catch {}
    },
    prefetch: async () => {},
  }), [navigate]);
}

export function usePathname() {
  const location = useLocation();
  return location?.pathname || '/';
}

export function useSearchParams() {
  const location = useLocation();
  return React.useMemo(() => new URLSearchParams(location?.search || ''), [location?.search]);
}

export function useParams() {
  return useReactRouterParams();
}

export function redirect(to) {
  const target = normalizeTo(to, '/');
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('tepiha:router-redirect-requested', {
        detail: { source: 'routerCompat', target, noBrowserReplace: true, at: new Date().toISOString() }
      }));
      window.history?.replaceState?.(window.history.state || {}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    } catch {}
  }
  return null;
}

export function notFound() {
  const error = new Error('NOT_FOUND');
  error.code = 'NOT_FOUND';
  throw error;
}
