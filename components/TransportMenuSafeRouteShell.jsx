'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import { loadLazyModule, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';
import useRouteAlive from '@/lib/routeAlive';

const ROUTE_PATH = '/transport/menu';
const MODULE_ID = '@/app/transport/menu/page.jsx';

function readRuntimeContext() {
  if (typeof window === 'undefined') {
    return { userAgent: '', appEpoch: '', buildId: '' };
  }
  return {
    userAgent: (() => { try { return String(navigator.userAgent || ''); } catch { return ''; } })(),
    appEpoch: (() => { try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; } })(),
    buildId: (() => { try { return String(window.__TEPIHA_BUILD_ID || ''); } catch { return ''; } })(),
  };
}

function makeTransportMenuLazy(retryCount) {
  return React.lazy(() => loadLazyModule(
    () => import('@/app/transport/menu/page.jsx'),
    {
      kind: 'route',
      label: MODULE_ID,
      moduleId: MODULE_ID,
      requestedModule: MODULE_ID,
      importerHint: MODULE_ID,
      importCaller: 'TransportMenuSafeRouteShell',
      componentName: 'TransportMenuInner',
      path: ROUTE_PATH,
      importRetryCount: retryCount,
      retryCount,
    },
  ));
}

function TransportMenuLoading({ retryCount }) {
  React.useEffect(() => {
    recordRouteDiagEvent('transport_menu_inner_loading', {
      path: ROUTE_PATH,
      route: ROUTE_PATH,
      moduleId: MODULE_ID,
      requestedModule: MODULE_ID,
      importRetryCount: retryCount,
      retryCount,
      sourceLayer: 'TransportMenuSafeRouteShell',
      ...readRuntimeContext(),
    });
  }, [retryCount]);

  return (
    <div style={ui.page} data-transport-menu-safe-shell="1" data-transport-menu-loading="1">
      <div style={ui.card}>
        <div style={ui.eyebrow}>TRANSPORT</div>
        <div style={ui.title}>MENU PO NGARKOHET…</div>
        <div style={ui.text}>Shell-i është aktiv. Përmbajtja reale e menu-së po provohet lokalisht.</div>
        <div style={ui.meta}>RETRY: {retryCount}</div>
      </div>
    </div>
  );
}

function TransportMenuLocalFallback({ error, message, retry, retryCount, copyLog }) {
  const [copied, setCopied] = React.useState(false);
  const safeMessage = String(message || error?.message || error || 'Importing a module script failed');

  React.useEffect(() => {
    recordRouteDiagEvent('transport_menu_local_error_panel_shown', {
      path: ROUTE_PATH,
      route: ROUTE_PATH,
      moduleId: MODULE_ID,
      requestedModule: MODULE_ID,
      importRetryCount: retryCount,
      retryCount,
      error: {
        name: String(error?.name || ''),
        message: safeMessage,
        stack: String(error?.stack || ''),
      },
      errorMessage: safeMessage,
      sourceLayer: 'TransportMenuSafeRouteShell',
      ...readRuntimeContext(),
    });
  }, [error, retryCount, safeMessage]);

  const onCopy = async () => {
    let ok = false;
    try { ok = !!(await copyLog?.()); } catch { ok = false; }
    setCopied(!!ok);
    try { window.setTimeout(() => setCopied(false), 1400); } catch {}
  };

  const onRetry = () => {
    const nextRetry = Number(retryCount || 0) + 1;
    recordRouteDiagEvent('transport_menu_import_retry', {
      path: ROUTE_PATH,
      route: ROUTE_PATH,
      moduleId: MODULE_ID,
      requestedModule: MODULE_ID,
      importRetryCount: nextRetry,
      retryCount: nextRetry,
      previousRetryCount: retryCount,
      sourceLayer: 'TransportMenuSafeRouteShell',
      ...readRuntimeContext(),
    });
    retry?.();
  };

  return (
    <div style={ui.page} data-transport-menu-safe-shell="1" data-transport-menu-local-error="1">
      <div style={ui.card}>
        <div style={ui.eyebrow}>LOCAL ERROR</div>
        <div style={ui.title}>TRANSPORT MENU NUK U NGARKUA</div>
        <div style={ui.text}>Gabimi u izolua vetëm te kjo faqe. App-i, Home, Transport Board dhe diag route-t mbesin funksionale.</div>

        <div style={ui.errorBox}>{safeMessage}</div>

        <div style={ui.infoGrid}>
          <div style={ui.infoBox}>
            <div style={ui.infoLabel}>ROUTE</div>
            <div style={ui.infoValue}>{ROUTE_PATH}</div>
          </div>
          <div style={ui.infoBox}>
            <div style={ui.infoLabel}>MODULE</div>
            <div style={ui.infoValue}>{MODULE_ID}</div>
          </div>
          <div style={ui.infoBox}>
            <div style={ui.infoLabel}>IMPORT RETRY COUNT</div>
            <div style={ui.infoValue}>{retryCount}</div>
          </div>
        </div>

        <div style={ui.actions}>
          <button type="button" style={ui.primaryButton} onClick={onRetry}>PROVO PËRSËRI</button>
          <button type="button" style={ui.button} onClick={onCopy}>{copied ? 'U KOPJUA' : 'COPY ERROR / COPY LOG'}</button>
          <Link href="/transport/board" style={ui.button}>KTHEHU TE TRANSPORT BOARD</Link>
          <Link href="/" style={ui.button}>KTHEHU HOME</Link>
        </div>
      </div>
    </div>
  );
}

export default function TransportMenuSafeRouteShell() {
  useRouteAlive('transport_menu_safe_shell');
  const [retryCount, setRetryCount] = React.useState(0);
  const LazyTransportMenuInner = React.useMemo(() => makeTransportMenuLazy(retryCount), [retryCount]);

  React.useEffect(() => {
    recordRouteDiagEvent('transport_menu_safe_shell_mount', {
      path: ROUTE_PATH,
      route: ROUTE_PATH,
      moduleId: MODULE_ID,
      requestedModule: MODULE_ID,
      importRetryCount: retryCount,
      retryCount,
      sourceLayer: 'TransportMenuSafeRouteShell',
      ...readRuntimeContext(),
    });
  }, [retryCount]);

  const handleRetry = React.useCallback(() => {
    setRetryCount((value) => Number(value || 0) + 1);
  }, []);

  return (
    <LocalErrorBoundary
      boundaryKind="route"
      routePath={ROUTE_PATH}
      routeName={ROUTE_PATH}
      componentName="TRANSPORT MENU"
      moduleName={MODULE_ID}
      moduleId={MODULE_ID}
      sourceLayer="TransportMenuSafeRouteShell"
      resetKeys={[ROUTE_PATH, retryCount]}
      onRetry={handleRetry}
      extraMeta={{
        route: ROUTE_PATH,
        module: MODULE_ID,
        moduleName: MODULE_ID,
        moduleId: MODULE_ID,
        requestedModule: MODULE_ID,
        importRetryCount: retryCount,
        retryCount,
        importCaller: 'TransportMenuSafeRouteShell',
      }}
      renderFallback={({ error, message, retry, copyLog }) => (
        <TransportMenuLocalFallback
          error={error}
          message={message}
          retry={retry}
          retryCount={retryCount}
          copyLog={copyLog}
        />
      )}
    >
      <Suspense fallback={<TransportMenuLoading retryCount={retryCount} />}>
        <LazyTransportMenuInner />
      </Suspense>
    </LocalErrorBoundary>
  );
}

const ui = {
  page: {
    minHeight: '100vh',
    background: '#05070d',
    color: '#fff',
    padding: 16,
    display: 'grid',
    alignItems: 'start',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 720,
    margin: '0 auto',
    borderRadius: 20,
    border: '1px solid rgba(248,113,113,0.28)',
    background: 'rgba(15,23,42,0.94)',
    boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
    padding: 16,
  },
  eyebrow: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 6,
    fontSize: 22,
    lineHeight: 1.12,
    fontWeight: 1000,
    letterSpacing: 0.2,
  },
  text: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 750,
  },
  meta: {
    marginTop: 12,
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: 0.8,
  },
  errorBox: {
    marginTop: 12,
    borderRadius: 14,
    border: '1px solid rgba(248,113,113,0.28)',
    background: 'rgba(127,29,29,0.34)',
    color: '#fecaca',
    padding: 12,
    fontSize: 12,
    lineHeight: 1.45,
    fontWeight: 850,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  infoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 8,
    marginTop: 12,
  },
  infoBox: {
    minWidth: 0,
    borderRadius: 13,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.05)',
    padding: 10,
  },
  infoLabel: {
    color: 'rgba(255,255,255,0.52)',
    fontSize: 10,
    fontWeight: 950,
    letterSpacing: 0.8,
  },
  infoValue: {
    marginTop: 4,
    color: '#fff',
    fontSize: 12,
    fontWeight: 850,
    wordBreak: 'break-word',
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 14,
  },
  primaryButton: {
    appearance: 'none',
    border: '1px solid rgba(34,197,94,0.46)',
    background: 'rgba(34,197,94,0.20)',
    color: '#fff',
    borderRadius: 13,
    padding: '11px 13px',
    fontWeight: 1000,
    letterSpacing: 0.3,
    fontSize: 12,
    cursor: 'pointer',
  },
  button: {
    appearance: 'none',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: 13,
    padding: '11px 13px',
    fontWeight: 1000,
    letterSpacing: 0.3,
    fontSize: 12,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};
