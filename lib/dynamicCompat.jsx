import React, { Suspense } from 'react';
import { loadLazyModule, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';

function normalizeModule(mod) {
  if (mod && typeof mod === 'object' && 'default' in mod) return mod;
  return { default: mod };
}

function currentPath() {
  try { return String(window.location?.pathname || '/'); } catch { return '/'; }
}

function DynamicFallback({ label, children }) {
  const pathRef = React.useRef(currentPath());

  React.useEffect(() => {
    const path = currentPath();
    pathRef.current = path;
    recordRouteDiagEvent('route_fallback_mount', {
      path,
      label,
      kind: 'component',
      sourceLayer: 'dynamic_compat',
    });
    return () => {
      recordRouteDiagEvent('route_fallback_unmount', {
        path: pathRef.current || currentPath(),
        label,
        kind: 'component',
        sourceLayer: 'dynamic_compat',
      });
    };
  }, [label]);

  return <>{children}</>;
}

function DynamicLifecycleProbe({ label, children }) {
  React.useEffect(() => {
    const path = currentPath();
    const base = {
      path,
      label,
      kind: 'component',
      sourceLayer: 'dynamic_compat',
    };

    recordRouteDiagEvent('route_component_mount', base);
    let paintRaf = 0;
    let interactiveRaf = 0;
    let interactiveTimer = 0;

    paintRaf = window.requestAnimationFrame(() => {
      recordRouteDiagEvent('route_first_paint', base);
      interactiveRaf = window.requestAnimationFrame(() => {
        interactiveTimer = window.setTimeout(() => {
          recordRouteDiagEvent('route_first_interactive', base);
        }, 0);
      });
    });

    return () => {
      try { window.cancelAnimationFrame(paintRaf); } catch {}
      try { window.cancelAnimationFrame(interactiveRaf); } catch {}
      try { window.clearTimeout(interactiveTimer); } catch {}
    };
  }, [label]);

  return children;
}

export default function dynamic(loader, options = {}) {
  const label = String(options?.chunkName || options?.label || 'dynamic-component');
  const Lazy = React.lazy(async () => normalizeModule(await loadLazyModule(loader, { kind: 'component', label })));

  if (options?.suspense) {
    return function DynamicSuspenseComponent(props) {
      return (
        <DynamicLifecycleProbe label={label}>
          <Lazy {...props} />
        </DynamicLifecycleProbe>
      );
    };
  }

  function DynamicComponent(props) {
    const fallback = options?.loading ? React.createElement(options.loading) : null;
    return (
      <Suspense fallback={<DynamicFallback label={label}>{fallback}</DynamicFallback>}>
        <DynamicLifecycleProbe label={label}>
          <Lazy {...props} />
        </DynamicLifecycleProbe>
      </Suspense>
    );
  }

  return DynamicComponent;
}
