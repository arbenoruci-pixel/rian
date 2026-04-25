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
      try { window.location.reload(); } catch {}
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
    try { window.location.replace(target); } catch {}
  }
  return null;
}

export function notFound() {
  const error = new Error('NOT_FOUND');
  error.code = 'NOT_FOUND';
  throw error;
}
