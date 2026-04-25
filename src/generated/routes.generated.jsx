import React, { Suspense, lazy } from 'react';
import {
  loadLazyModule,
  readPersistentJson,
  recordRouteDiagEvent,
  ROUTE_DIAG_LOG_KEY,
  DOM_PREHEAL_LOG_KEY,
  DOM_PREHEAL_LAST_KEY,
} from '@/lib/lazyImportRuntime';
import { Navigate } from 'react-router-dom';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import SafeLazyRouteShell from '@/components/SafeLazyRouteShell';
import TransportMenuSafeRouteShell from '@/components/TransportMenuSafeRouteShell';
import { exportLocalErrorLogText, LOCAL_ERROR_LAST_KEY, LOCAL_ERROR_LOG_KEY } from '@/lib/localErrorLog';
import TransportLayout from '@/app/transport/layout.jsx';
import ArkaLayout from '@/app/arka/layout.jsx';
import NotFoundPage from '@/app/not-found.jsx';
import LoginPageEager from '@/app/login/page.jsx';
import OfflinePageEager from '@/app/offline/page.jsx';
import HomePageEager from '@/app/page.jsx';
import TransportLoginPageEager from '@/app/transport/login/page.jsx';

// Fastboot alignment: keep only shell/login/offline pages eager. Heavy business routes load via SafeLazyRouteShell after Home paints.

const Page0 = lazyRoute(() => import('@/app/arka/buxheti/page.jsx'), '@/app/arka/buxheti/page.jsx');
const Page1 = lazyRoute(() => import('@/app/arka/obligimet/page.jsx'), '@/app/arka/obligimet/page.jsx');
const Page3 = lazyRoute(() => import('@/app/arka/payroll/page.jsx'), '@/app/arka/payroll/page.jsx');
const Page4 = lazyRoute(() => import('@/app/arka/puntor/[pin]/page.jsx'), '@/app/arka/puntor/[pin]/page.jsx');
const Page5 = lazyRoute(() => import('@/app/arka/stafi/page.jsx'), '@/app/arka/stafi/page.jsx');
const Page6 = lazyRoute(() => import('@/app/baza/page.jsx'), '@/app/baza/page.jsx');
const Page7 = lazyRoute(() => import('@/app/debug-lite/page.jsx'), '@/app/debug-lite/page.jsx');
const Page8 = lazyRoute(() => import('@/app/debug/boot/page.jsx'), '@/app/debug/boot/page.jsx');
const Page9 = lazyRoute(() => import('@/app/debug/page.jsx'), '@/app/debug/page.jsx');
const Page10 = lazyRoute(() => import('@/app/debug/sync/page.jsx'), '@/app/debug/sync/page.jsx');
const Page11 = lazyRoute(() => import('@/app/diag-lite/page.jsx'), '@/app/diag-lite/page.jsx');
const Page12 = lazyRoute(() => import('@/app/dispatch/page.jsx'), '@/app/dispatch/page.jsx');
const Page13 = lazyRoute(() => import('@/app/fletore/page.jsx'), '@/app/fletore/page.jsx');
const Page15 = lazyRoute(() => import('@/app/k/[id]/page.jsx'), '@/app/k/[id]/page.jsx');
const Page16 = lazyRoute(() => import('@/app/llogaria-ime/page.jsx'), '@/app/llogaria-ime/page.jsx');
const Page22 = lazyRoute(() => import('@/app/porosit/page.jsx'), '@/app/porosit/page.jsx');
const Page24 = lazyRoute(() => import('@/app/restore/page.jsx'), '@/app/restore/page.jsx');
const Page25 = lazyRoute(() => import('@/app/search/page.jsx'), '@/app/search/page.jsx');
const Page27 = lazyRoute(() => import('@/app/transport/fletore/page.jsx'), '@/app/transport/fletore/page.jsx');
const Page28 = lazyRoute(() => import('@/app/transport/gati/page.jsx'), '@/app/transport/gati/page.jsx');
const Page29 = lazyRoute(() => import('@/app/transport/inbox/page.jsx'), '@/app/transport/inbox/page.jsx');
const Page30 = lazyRoute(() => import('@/app/transport/item/page.jsx'), '@/app/transport/item/page.jsx');
const Page31 = lazyRoute(() => import('@/app/transport/loaded/page.jsx'), '@/app/transport/loaded/page.jsx');
const Page33 = lazyRoute(() => import('@/app/transport/marrje-sot/page.jsx'), '@/app/transport/marrje-sot/page.jsx');
const Page35 = lazyRoute(() => import('@/app/transport/ne-ardhje/page.jsx'), '@/app/transport/ne-ardhje/page.jsx');
const Page36 = lazyRoute(() => import('@/app/transport/ngarkim-sot/page.jsx'), '@/app/transport/ngarkim-sot/page.jsx');
const Page37 = lazyRoute(() => import('@/app/transport/offload/page.jsx'), '@/app/transport/offload/page.jsx');
const Page39 = lazyRoute(() => import('@/app/transport/pay/page.jsx'), '@/app/transport/pay/page.jsx');
const Page40 = lazyRoute(() => import('@/app/transport/pickup/page.jsx'), '@/app/transport/pickup/page.jsx');
const Page42 = lazyRoute(() => import('@/app/transport/te-pa-plotsuara/page.jsx'), '@/app/transport/te-pa-plotsuara/page.jsx');
const Page43 = lazyRoute(() => import('@/app/worker/page.jsx'), '@/app/worker/page.jsx');

function normalizeMountedPath(fallback = '/') {
  try {
    const value = String(window.location?.pathname || fallback || '/');
    return value || fallback || '/';
  } catch {
    return String(fallback || '/');
  }
}

function normalizeDetailPath(detail = {}, fallback = '/') {
  const raw = detail?.path || detail?.page || detail?.currentPath || detail?.routePath || detail?.pathname || fallback;
  return normalizeMountedPath(raw || fallback);
}

function lazyRoute(importer, label) {
  return lazy(() => loadLazyModule(importer, { kind: 'route', label }));
}

function RouteFallback({ path, label = '' }) {
  const actualPathRef = React.useRef(normalizeMountedPath(path));

  React.useEffect(() => {
    const actualPath = normalizeMountedPath(path);
    actualPathRef.current = actualPath;
    recordRouteDiagEvent('route_fallback_mount', {
      path: actualPath,
      routePattern: String(path || ''),
      label: String(label || path || ''),
      sourceLayer: 'routes_generated',
    });
    return () => {
      recordRouteDiagEvent('route_fallback_unmount', {
        path: actualPathRef.current || normalizeMountedPath(path),
        routePattern: String(path || ''),
        label: String(label || path || ''),
        sourceLayer: 'routes_generated',
      });
    };
  }, [label, path]);

  return (
    <div
      data-route-fallback="1"
      data-route-fallback-path={String(path || '')}
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05070d', color: '#fff', fontWeight: 800 }}
    >
      DUKE HAPUR…
    </div>
  );
}

function RouteLifecycleProbe({ path, label, kind = 'route', sourceLayer = 'routes_generated', children }) {
  const readyLoggedRef = React.useRef(false);
  const actualPathRef = React.useRef(normalizeMountedPath(path));

  React.useEffect(() => {
    const actualPath = normalizeMountedPath(path);
    actualPathRef.current = actualPath;

    const base = {
      path: actualPath,
      routePattern: String(path || ''),
      label: String(label || path || ''),
      kind: String(kind || 'route'),
      sourceLayer: String(sourceLayer || 'routes_generated'),
    };

    recordRouteDiagEvent('route_component_mount', base);

    let paintRaf = 0;
    let interactiveRaf = 0;
    let interactiveTimer = 0;
    let observer = null;

    const markReady = (uiReadySource, detail = {}) => {
      if (readyLoggedRef.current) return;
      const detailPath = normalizeDetailPath(detail, actualPathRef.current || actualPath);
      if (detailPath !== (actualPathRef.current || actualPath)) return;
      readyLoggedRef.current = true;
      try { window.__TEPIHA_UI_READY = true; } catch {}
      try { window.__TEPIHA_FIRST_UI_READY = true; } catch {}
      try { document.documentElement?.setAttribute?.('data-ui-ready', '1'); } catch {}
      try { document.body?.setAttribute?.('data-ui-ready', '1'); } catch {}
      try { window.dispatchEvent(new CustomEvent('tepiha:first-ui-ready', { detail: { ...detail, path: detailPath, uiReadySource: String(uiReadySource || 'unknown') } })); } catch {}
      recordRouteDiagEvent('route_ui_ready', {
        ...base,
        uiReadySource: String(uiReadySource || 'unknown'),
        detail,
      });
    };

    const onFirstUiReady = (event) => markReady('tepiha:first-ui-ready', event?.detail && typeof event.detail === 'object' ? event.detail : {});
    const onRouteUiAlive = (event) => markReady('tepiha:route-ui-alive', event?.detail && typeof event.detail === 'object' ? event.detail : {});

    paintRaf = window.requestAnimationFrame(() => {
      recordRouteDiagEvent('route_first_paint', base);
      interactiveRaf = window.requestAnimationFrame(() => {
        interactiveTimer = window.setTimeout(() => {
          recordRouteDiagEvent('route_first_interactive', base);
          markReady('route_first_interactive_timer', { path: actualPathRef.current || actualPath });
        }, 0);
      });
    });

    try { window.addEventListener('tepiha:first-ui-ready', onFirstUiReady, { passive: true }); } catch {}
    try { window.addEventListener('tepiha:route-ui-alive', onRouteUiAlive, { passive: true }); } catch {}

    try {
      observer = new MutationObserver(() => {
        try {
          const domReady = document.documentElement?.getAttribute?.('data-ui-ready') === '1' || document.body?.getAttribute?.('data-ui-ready') === '1';
          if (!domReady) return;
          markReady('dom_data_ui_ready', { path: actualPathRef.current || actualPath });
        } catch {
          // ignore
        }
      });
      observer.observe(document.documentElement || document.body, { attributes: true, subtree: false, childList: false });
    } catch {
      observer = null;
    }

    return () => {
      try { window.cancelAnimationFrame(paintRaf); } catch {}
      try { window.cancelAnimationFrame(interactiveRaf); } catch {}
      try { window.clearTimeout(interactiveTimer); } catch {}
      try { observer?.disconnect?.(); } catch {}
      try { window.removeEventListener('tepiha:first-ui-ready', onFirstUiReady); } catch {}
      try { window.removeEventListener('tepiha:route-ui-alive', onRouteUiAlive); } catch {}
    };
  }, [kind, label, path, sourceLayer]);

  return children;
}

function DiagRawPage() {
  const [tick, setTick] = React.useState(0);
  const [copiedLocalErrors, setCopiedLocalErrors] = React.useState(false);
  const [browserSnapshot, setBrowserSnapshot] = React.useState(null);

  React.useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 900);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const safeString = (value) => {
      try { return String(value == null ? '' : value); } catch { return ''; }
    };
    const isStandalone = () => {
      try {
        return !!(
          window.navigator?.standalone === true ||
          window.matchMedia?.('(display-mode: standalone)')?.matches ||
          window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
          window.matchMedia?.('(display-mode: minimal-ui)')?.matches
        );
      } catch {
        return false;
      }
    };
    const readCurrentIndexAsset = () => {
      try {
        const scripts = Array.from(document.scripts || []).map((script) => safeString(script?.src)).filter(Boolean);
        const current = [...scripts].reverse().find((src) => /\/assets\/index-[^/?]+\.(?:js|mjs)(?:\?|$)/i.test(src) || /\/src\/main\.jsx(?:\?|$)/i.test(src));
        return { currentIndexAsset: current || '', moduleScripts: scripts };
      } catch {
        return { currentIndexAsset: '', moduleScripts: [] };
      }
    };
    const readSnapshot = async () => {
      const assetInfo = readCurrentIndexAsset();
      let cacheKeys = [];
      let registrations = [];
      try {
        if ('caches' in window && window.caches?.keys) cacheKeys = await window.caches.keys();
      } catch (error) {
        cacheKeys = [`CACHE_KEYS_ERROR: ${safeString(error?.message || error)}`];
      }
      try {
        if (navigator.serviceWorker?.getRegistrations) {
          const regs = await navigator.serviceWorker.getRegistrations();
          registrations = (Array.isArray(regs) ? regs : []).map((reg) => ({
            scope: safeString(reg?.scope),
            active: safeString(reg?.active?.scriptURL),
            waiting: safeString(reg?.waiting?.scriptURL),
            installing: safeString(reg?.installing?.scriptURL),
          }));
        }
      } catch (error) {
        registrations = [{ error: safeString(error?.message || error) }];
      }
      const controllerScriptURL = safeString(navigator.serviceWorker?.controller?.scriptURL);
      const snapshot = {
        at: new Date().toISOString(),
        standalone: isStandalone(),
        href: safeString(window.location?.href),
        userAgent: safeString(navigator.userAgent),
        appEpoch: safeString(window.__TEPIHA_APP_EPOCH || document.querySelector('meta[name="tepiha-app-epoch"]')?.content),
        buildId: safeString(window.__TEPIHA_BUILD_ID || document.querySelector('meta[name="tepiha-build-id"]')?.content),
        indexScriptVersion: safeString(window.__TEPIHA_INDEX_SCRIPT_VERSION__),
        pwaBootRescueVersion: safeString(window.__TEPIHA_PWA_BOOT_RESCUE_VERSION__),
        pwaStalenessRepairVersion: safeString(window.__TEPIHA_PWA_STALENESS_REPAIR_VERSION__),
        currentIndexAsset: assetInfo.currentIndexAsset,
        moduleScripts: assetInfo.moduleScripts,
        serviceWorkerControllerScriptURL: controllerScriptURL,
        serviceWorkerRegistrations: registrations,
        cacheKeys,
        buildMarker: (() => {
          try {
            const el = document.getElementById('tepiha-build-marker');
            if (!el) return null;
            return {
              present: true,
              text: safeString(el.textContent).replace(/\s+/g, ' ').trim(),
              dataAppEpoch: safeString(el.getAttribute('data-app-epoch')),
              dataBuildId: safeString(el.getAttribute('data-build-id')),
              dataIndexScriptVersion: safeString(el.getAttribute('data-index-script-version')),
              dataPwaBootRescueVersion: safeString(el.getAttribute('data-pwa-boot-rescue-version')),
              dataCurrentIndexAsset: safeString(el.getAttribute('data-current-index-asset')),
            };
          } catch {
            return null;
          }
        })(),
      };
      if (!cancelled) setBrowserSnapshot(snapshot);
    };
    readSnapshot();
    const id = window.setInterval(readSnapshot, 1600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const payload = React.useMemo(() => {
    const safeRead = (key, fallback = null) => readPersistentJson(key, fallback);
    return {
      now: new Date().toISOString(),
      path: (() => {
        try { return String(window.location?.pathname || '/diag-raw'); } catch { return '/diag-raw'; }
      })(),
      bootId: (() => {
        try {
          return String(
            window.BOOT_ID
            || window.sessionStorage?.getItem('tepiha_boot_current_id')
            || window.localStorage?.getItem('tepiha_boot_current_id')
            || ''
          );
        } catch {
          return '';
        }
      })(),
      currentIndexAsset: browserSnapshot?.currentIndexAsset || '',
      serviceWorkerControllerScriptURL: browserSnapshot?.serviceWorkerControllerScriptURL || '',
      cacheKeys: browserSnapshot?.cacheKeys || [],
      standalone: browserSnapshot?.standalone ?? null,
      browserSnapshot,
      pwaStalenessRepairLast: safeRead('tepiha_pwa_staleness_repair_last_v2', null),
      pwaStalenessRepairLog: (() => {
        const list = safeRead('tepiha_pwa_staleness_repair_log_v2', []);
        return Array.isArray(list) ? list.slice(0, 30) : [];
      })(),
      pwaStalenessStartupCheck: (() => { try { return window.__TEPIHA_PWA_STALENESS_CHECK__ || null; } catch { return null; } })(),
      swEpochStartupCheck: (() => { try { return window.__TEPIHA_SW_EPOCH_STARTUP_CHECK__ || null; } catch { return null; } })(),
      activeRouteRequest: safeRead('tepiha_active_route_request_v1', null),
      routeTransition: safeRead('tepiha_route_transition_v1', null),
      pwaBootRescueLast: safeRead('tepiha_pwa_boot_rescue_last_v1', null),
      pwaBootRescueLog: (() => {
        const list = safeRead('tepiha_pwa_boot_rescue_log_v1', []);
        return Array.isArray(list) ? list.slice(0, 30) : [];
      })(),
      pwaSwEpochCheck: (() => { try { return window.__TEPIHA_PWA_SW_EPOCH_CHECK__ || null; } catch { return null; } })(),
      lastChunkCapture: safeRead('tepiha_chunk_last_capture_v1', null),
      lastLazyImportAttempt: safeRead('tepiha_last_lazy_import_attempt_v1', null),
      lastLazyImportFailure: safeRead('tepiha_last_lazy_import_failure_v1', null),
      appRootRuntimeStatus: (() => { try { return window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ || null; } catch { return null; } })(),
      appRootRuntimeFailureLast: safeRead('tepiha_app_root_runtime_failure_last_v1', null),
      appRootRuntimeFailureLog: (() => {
        const list = safeRead('tepiha_app_root_runtime_failure_log_v1', []);
        return Array.isArray(list) ? list.slice(0, 40) : [];
      })(),
      appRootRuntimeLazyFailures: (() => {
        const list = safeRead('tepiha_lazy_import_log_v1', []);
        if (!Array.isArray(list)) return [];
        return list
          .filter((item) => {
            const sourceLayer = String(item?.sourceLayer || item?.extraMeta?.sourceLayer || '');
            const importCaller = String(item?.importCaller || item?.extraMeta?.importCaller || '');
            const kind = String(item?.kind || '');
            const phase = String(item?.phase || item?.reason || '');
            return (
              importCaller === 'AppRootRuntime'
              || sourceLayer === 'app_root_runtime_lazy'
              || (kind === 'component' && /lazy_import_failure|failure/i.test(phase))
            );
          })
          .slice(0, 40);
      })(),
      appRootRuntimeFailedModuleNames: (() => {
        const direct = safeRead('tepiha_app_root_runtime_failure_log_v1', []);
        const lazy = safeRead('tepiha_lazy_import_log_v1', []);
        const names = [];
        for (const item of Array.isArray(direct) ? direct : []) names.push(String(item?.moduleName || item?.name || '').trim());
        for (const item of Array.isArray(lazy) ? lazy : []) {
          const caller = String(item?.importCaller || '');
          const reason = String(item?.reason || item?.phase || '');
          if (caller === 'AppRootRuntime' || /lazy_import_failure|failure/i.test(reason)) names.push(String(item?.moduleId || item?.label || item?.moduleName || '').trim());
        }
        return Array.from(new Set(names.filter(Boolean))).slice(0, 20);
      })(),
      appRootRuntimeLastFailedAssetUrl: (() => {
        const direct = safeRead('tepiha_app_root_runtime_failure_last_v1', null);
        const lazy = safeRead('tepiha_last_lazy_import_failure_v1', null);
        try { return String(direct?.assetUrl || direct?.resolvedAssetUrl || lazy?.assetUrl || lazy?.resolvedAssetUrl || lazy?.targetSrc || ''); } catch { return ''; }
      })(),
      criticalRuntimeBundleMode: (() => {
        try {
          const status = window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ || null;
          return status?.criticalMode || 'unknown';
        } catch { return 'unknown'; }
      })(),
      localErrorLast: safeRead(LOCAL_ERROR_LAST_KEY, null),
      localErrorLog: (() => {
        const list = safeRead(LOCAL_ERROR_LOG_KEY, []);
        return Array.isArray(list) ? list.slice(0, 80) : [];
      })(),
      lastDomPreheal: safeRead(DOM_PREHEAL_LAST_KEY, null),
      domPrehealLog: safeRead(DOM_PREHEAL_LOG_KEY, []).slice(0, 12),
      routeDiagLog: safeRead(ROUTE_DIAG_LOG_KEY, []).slice(0, 24),
      authResumeTimeline: safeRead('tepiha_auth_resume_event_log_v1', []).slice(0, 40),
      lastRootWatchdog: safeRead('tepiha_root_watchdog_last_v1', null),
      lastRootResumePanic: safeRead('tepiha_root_resume_panic_v1', null),
      authGateTrace: safeRead('tepiha_authgate_trace_v1', null),
      lastClearedRouteTransition: (() => { try { return window.__TEPIHA_LAST_CLEARED_ROUTE_TRANSITION__ || null; } catch { return null; } })(),
      routeAlive: (() => {
        try { return JSON.parse(window.sessionStorage?.getItem('tepiha_route_alive_v1') || 'null'); } catch { return null; }
      })(),
      routeUiAlive: (() => {
        try { return JSON.parse(window.sessionStorage?.getItem('tepiha_route_ui_alive_v1') || 'null'); } catch { return null; }
      })(),
      tick,
    };
  }, [tick, browserSnapshot]);

  const copyLocalErrors = React.useCallback(async () => {
    let ok = false;
    try {
      const text = exportLocalErrorLogText();
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const el = document.createElement('textarea');
        el.value = exportLocalErrorLogText();
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.focus();
        el.select();
        ok = !!document.execCommand('copy');
        document.body.removeChild(el);
      } catch {
        ok = false;
      }
    }
    setCopiedLocalErrors(!!ok);
    try { window.setTimeout(() => setCopiedLocalErrors(false), 1400); } catch {}
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#e8eef6', padding: 16, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>/diag-raw</div>
      <div style={{ opacity: 0.82, marginBottom: 12 }}>Eager diagnostic route. Lexon vetëm snapshots dhe ring buffers lokalë.</div>
      <button
        type="button"
        onClick={copyLocalErrors}
        style={{ marginBottom: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', padding: '10px 12px', fontWeight: 900, letterSpacing: 0.5 }}
      >
        {copiedLocalErrors ? 'LOCAL ERROR LOG U KOPJUA' : 'COPY LOCAL ERROR LOG'}
      </button>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.45, fontSize: 12 }}>
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}

function wrapWithLayouts(path, node) {
  if (path.startsWith('/arka')) {
    return <ArkaLayout>{node}</ArkaLayout>;
  }
  if (path.startsWith('/transport') && path !== '/transport/login') {
    return <TransportLayout>{node}</TransportLayout>;
  }
  return node;
}

function routeBoundary(path, node) {
  const routedNode = wrapWithLayouts(path, node);
  return (
    <LocalErrorBoundary
      boundaryKind="route"
      routePath={path}
      routeName={path}
      componentName={path}
      sourceLayer="routes_generated"
      resetKeys={[path]}
    >
      {routedNode}
    </LocalErrorBoundary>
  );
}

function lazyElement(Component, path) {
  const node = (
    <Suspense fallback={<RouteFallback path={path} label={path} />}>
      <RouteLifecycleProbe path={path} label={path} kind="route" sourceLayer="routes_generated">
        <Component />
      </RouteLifecycleProbe>
    </Suspense>
  );
  return routeBoundary(path, node);
}

function safeLazyElement(path, importer, moduleId, componentName) {
  const node = (
    <RouteLifecycleProbe path={path} label={path} kind="route" sourceLayer="safe_route_shell_generated">
      <SafeLazyRouteShell
        routePath={path}
        routeName={path}
        moduleId={moduleId}
        componentName={componentName || path}
        importer={importer}
      />
    </RouteLifecycleProbe>
  );
  return routeBoundary(path, node);
}

function eagerElement(Component, path) {
  const node = (
    <RouteLifecycleProbe path={path} label={path} kind="route" sourceLayer="routes_generated">
      <Component />
    </RouteLifecycleProbe>
  );
  return routeBoundary(path, node);
}

export const appRoutes = [
  { path: '/arka/shpenzime', element: <Navigate to='/arka' replace /> },
  { path: '/arka/cash', element: <Navigate to='/arka' replace /> },
  { path: '/arka/corporate', element: <Navigate to='/arka/obligimet' replace /> },
  { path: '/transport/arka', element: <Navigate to='/llogaria-ime' replace /> },
  { path: '/admin/devices', element: <Navigate to='/arka/stafi' replace /> },
  { path: '/arka/puntoret', element: <Navigate to='/arka/stafi' replace /> },
  { path: '/diag-raw', element: eagerElement(DiagRawPage, '/diag-raw') },
  { path: '/arka/buxheti', element: safeLazyElement('/arka/buxheti', () => import('@/app/arka/buxheti/page.jsx'), '@/app/arka/buxheti/page.jsx', 'ARKA BUXHETI') },
  { path: '/arka/obligimet', element: safeLazyElement('/arka/obligimet', () => import('@/app/arka/obligimet/page.jsx'), '@/app/arka/obligimet/page.jsx', 'ARKA OBLIGIMET') },
  { path: '/arka', element: safeLazyElement('/arka', () => import('@/app/arka/page.jsx'), '@/app/arka/page.jsx', 'ARKA') },
  { path: '/arka/payroll', element: safeLazyElement('/arka/payroll', () => import('@/app/arka/payroll/page.jsx'), '@/app/arka/payroll/page.jsx', 'ARKA PAYROLL') },
  { path: '/arka/puntor/:pin', element: safeLazyElement('/arka/puntor/:pin', () => import('@/app/arka/puntor/[pin]/page.jsx'), '@/app/arka/puntor/[pin]/page.jsx', 'ARKA PUNTOR') },
  { path: '/arka/stafi', element: safeLazyElement('/arka/stafi', () => import('@/app/arka/stafi/page.jsx'), '@/app/arka/stafi/page.jsx', 'ARKA STAFI') },
  { path: '/baza', element: lazyElement(Page6, '/baza') },
  { path: '/debug-lite', element: lazyElement(Page7, '/debug-lite') },
  { path: '/debug/boot', element: lazyElement(Page8, '/debug/boot') },
  { path: '/debug', element: lazyElement(Page9, '/debug') },
  { path: '/debug/sync', element: lazyElement(Page10, '/debug/sync') },
  { path: '/diag-lite', element: lazyElement(Page11, '/diag-lite') },
  { path: '/dispatch', element: lazyElement(Page12, '/dispatch') },
  { path: '/fletore', element: lazyElement(Page13, '/fletore') },
  { path: '/gati', element: safeLazyElement('/gati', () => import('@/app/gati/page.jsx'), '@/app/gati/page.jsx', 'GATI') },
  { path: '/k/:id', element: lazyElement(Page15, '/k/:id') },
  { path: '/llogaria-ime', element: lazyElement(Page16, '/llogaria-ime') },
  { path: '/login', element: eagerElement(LoginPageEager, '/login') },
  { path: '/marrje-sot', element: safeLazyElement('/marrje-sot', () => import('@/app/marrje-sot/page.jsx'), '@/app/marrje-sot/page.jsx', 'MARRJE SOT') },
  { path: '/offline', element: eagerElement(OfflinePageEager, '/offline') },
  { path: '/', element: eagerElement(HomePageEager, '/') },
  { path: '/pastrimi', element: safeLazyElement('/pastrimi', () => import('@/app/pastrimi/page.jsx'), '@/app/pastrimi/page.jsx', 'PASTRIMI') },
  { path: '/porosit', element: lazyElement(Page22, '/porosit') },
  { path: '/pranimi', element: safeLazyElement('/pranimi', () => import('@/app/pranimi/page.jsx'), '@/app/pranimi/page.jsx', 'PRANIMI') },
  { path: '/restore', element: lazyElement(Page24, '/restore') },
  { path: '/search', element: lazyElement(Page25, '/search') },
  { path: '/transport/board', element: safeLazyElement('/transport/board', () => import('@/app/transport/board/page.jsx'), '@/app/transport/board/page.jsx', 'TRANSPORT BOARD') },
  { path: '/transport/fletore', element: safeLazyElement('/transport/fletore', () => import('@/app/transport/fletore/page.jsx'), '@/app/transport/fletore/page.jsx', 'TRANSPORT FLETORE') },
  { path: '/transport/gati', element: safeLazyElement('/transport/gati', () => import('@/app/transport/gati/page.jsx'), '@/app/transport/gati/page.jsx', 'TRANSPORT GATI') },
  { path: '/transport/inbox', element: safeLazyElement('/transport/inbox', () => import('@/app/transport/inbox/page.jsx'), '@/app/transport/inbox/page.jsx', 'TRANSPORT INBOX') },
  { path: '/transport/item', element: safeLazyElement('/transport/item', () => import('@/app/transport/item/page.jsx'), '@/app/transport/item/page.jsx', 'TRANSPORT ITEM') },
  { path: '/transport/loaded', element: safeLazyElement('/transport/loaded', () => import('@/app/transport/loaded/page.jsx'), '@/app/transport/loaded/page.jsx', 'TRANSPORT LOADED') },
  { path: '/transport/login', element: eagerElement(TransportLoginPageEager, '/transport/login') },
  { path: '/transport/marrje-sot', element: safeLazyElement('/transport/marrje-sot', () => import('@/app/transport/marrje-sot/page.jsx'), '@/app/transport/marrje-sot/page.jsx', 'TRANSPORT MARRJE SOT') },
  { path: '/transport/menu', element: eagerElement(TransportMenuSafeRouteShell, '/transport/menu') },
  { path: '/transport/ne-ardhje', element: safeLazyElement('/transport/ne-ardhje', () => import('@/app/transport/ne-ardhje/page.jsx'), '@/app/transport/ne-ardhje/page.jsx', 'TRANSPORT NE ARDHJE') },
  { path: '/transport/ngarkim-sot', element: safeLazyElement('/transport/ngarkim-sot', () => import('@/app/transport/ngarkim-sot/page.jsx'), '@/app/transport/ngarkim-sot/page.jsx', 'TRANSPORT NGARKIM SOT') },
  { path: '/transport/offload', element: safeLazyElement('/transport/offload', () => import('@/app/transport/offload/page.jsx'), '@/app/transport/offload/page.jsx', 'TRANSPORT OFFLOAD') },
  { path: '/transport', element: safeLazyElement('/transport', () => import('@/app/transport/page.jsx'), '@/app/transport/page.jsx', 'TRANSPORT') },
  { path: '/transport/pay', element: safeLazyElement('/transport/pay', () => import('@/app/transport/pay/page.jsx'), '@/app/transport/pay/page.jsx', 'TRANSPORT PAY') },
  { path: '/transport/pickup', element: safeLazyElement('/transport/pickup', () => import('@/app/transport/pickup/page.jsx'), '@/app/transport/pickup/page.jsx', 'TRANSPORT PICKUP') },
  { path: '/transport/pranimi', element: safeLazyElement('/transport/pranimi', () => import('@/app/transport/pranimi/page.jsx'), '@/app/transport/pranimi/page.jsx', 'TRANSPORT PRANIMI') },
  { path: '/transport/te-pa-plotsuara', element: safeLazyElement('/transport/te-pa-plotsuara', () => import('@/app/transport/te-pa-plotsuara/page.jsx'), '@/app/transport/te-pa-plotsuara/page.jsx', 'TRANSPORT TE PA PLOTSUARA') },
  { path: '/worker', element: lazyElement(Page43, '/worker') },
  { path: '*', element: <NotFoundPage /> },
];
