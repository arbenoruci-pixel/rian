'use client';

import React from 'react';
import { bootLog } from '@/lib/bootLog';
import { recordRouteDiagEvent } from '@/lib/lazyImportRuntime';
import { exportLocalErrorLogText, pushLocalErrorLog } from '@/lib/localErrorLog';
import { markRouteAlive, markRouteUiAlive } from '@/lib/routeAlive';

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function safePath(fallback = '/') {
  try { return String(window.location?.pathname || fallback || '/'); } catch { return String(fallback || '/'); }
}

function shallowKey(value) {
  try { return JSON.stringify(value || []); } catch { return String(value || ''); }
}

function compactMessage(error) {
  return String(error?.message || error || 'UNKNOWN_LOCAL_ERROR');
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}


function hasUiReadyAlready() {
  try {
    if (window.__TEPIHA_UI_READY === true) return true;
  } catch {}
  try {
    if (document?.documentElement?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {}
  try {
    if (document?.body?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {}
  return false;
}

function setUiReadyFallbackFlags() {
  try { window.__TEPIHA_UI_READY = true; } catch {}
  try { document?.documentElement?.setAttribute?.('data-ui-ready', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-ui-ready', '1'); } catch {}
}

function afterFallbackPaint(fn) {
  try {
    window.requestAnimationFrame(() => window.requestAnimationFrame(fn));
    return;
  } catch {}
  try { window.setTimeout(fn, 0); } catch {}
}

function LocalErrorFallbackVisibleMarker({
  boundaryKind = 'local',
  routePath = '/',
  routeName = '',
  moduleName = '',
  moduleId = '',
  componentName = '',
  entry = null,
}) {
  React.useEffect(() => {
    const path = String(routePath || safePath('/'));
    const reason = 'local_error_fallback_visible';
    const detail = {
      path,
      route: path,
      routePath: path,
      routeName: String(routeName || ''),
      moduleName: String(moduleName || moduleId || ''),
      moduleId: String(moduleId || moduleName || ''),
      componentName: String(componentName || ''),
      boundaryKind: String(boundaryKind || 'local'),
      reason,
      uiReadySource: reason,
      sourceLayer: 'local_error_boundary_fallback_visible',
      localErrorFallbackVisible: true,
      localErrorId: String(entry?.id || ''),
      ts: Date.now(),
      at: nowIso(),
    };

    afterFallbackPaint(() => {
      const firstReady = !hasUiReadyAlready();
      try { markRouteAlive(reason, path); } catch {}
      try { markRouteUiAlive(reason, path, detail); } catch {}
      try { recordRouteDiagEvent('route_ui_alive', detail); } catch {}
      try { recordRouteDiagEvent('route_ui_ready', { ...detail, firstReady }); } catch {}
      if (firstReady) {
        setUiReadyFallbackFlags();
        try { bootLog('first_ui_ready', { ...detail, source: reason, page: path, hidden: document?.visibilityState !== 'visible' }); } catch {}
        try {
          window.dispatchEvent(new CustomEvent('tepiha:first-ui-ready', {
            detail: { ...detail, page: path, source: reason, firstReady: true },
          }));
        } catch {}
      } else {
        setUiReadyFallbackFlags();
      }
      try { bootLog('ui_ready', { ...detail, source: reason, page: path, hidden: document?.visibilityState !== 'visible' }); } catch {}
      try { bootLog('route_ui_ready', { ...detail, source: reason, page: path, hidden: document?.visibilityState !== 'visible' }); } catch {}
    });
  }, [boundaryKind, componentName, entry?.id, moduleId, moduleName, routeName, routePath]);

  return null;
}

const styles = {
  routeShell: {
    minHeight: '100vh',
    background: '#05070d',
    color: '#fff',
    padding: 16,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    display: 'grid',
    alignItems: 'start',
  },
  moduleShell: {
    width: '100%',
    borderRadius: 16,
    border: '1px solid rgba(248,113,113,0.34)',
    background: 'rgba(127,29,29,0.20)',
    color: '#fff',
    padding: 12,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 860,
    margin: '0 auto',
    borderRadius: 18,
    border: '1px solid rgba(248,113,113,0.32)',
    background: 'rgba(15,23,42,0.92)',
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
    fontSize: 20,
    fontWeight: 950,
    letterSpacing: 0.4,
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 8,
    marginTop: 12,
  },
  metaBox: {
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.05)',
    padding: 10,
    minWidth: 0,
  },
  metaLabel: {
    opacity: 0.58,
    fontSize: 10,
    fontWeight: 850,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  metaValue: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 800,
    wordBreak: 'break-word',
  },
  message: {
    marginTop: 12,
    borderRadius: 12,
    border: '1px solid rgba(248,113,113,0.22)',
    background: 'rgba(248,113,113,0.08)',
    padding: 10,
    color: '#fecaca',
    fontSize: 12,
    fontWeight: 800,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  help: {
    marginTop: 12,
    borderRadius: 12,
    border: '1px solid rgba(96,165,250,0.24)',
    background: 'rgba(30,64,175,0.14)',
    padding: 10,
    color: '#dbeafe',
    fontSize: 12,
    fontWeight: 850,
    lineHeight: 1.45,
  },
  assetList: {
    marginTop: 10,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.05)',
    padding: 10,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11,
    fontWeight: 800,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 12,
  },
  button: {
    appearance: 'none',
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderRadius: 12,
    padding: '10px 12px',
    fontWeight: 950,
    letterSpacing: 0.5,
    fontSize: 12,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

export default class LocalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      entry: null,
      copied: false,
      retryCount: 0,
      resetKey: shallowKey(props?.resetKeys),
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error: error || new Error('LOCAL_BOUNDARY_ERROR'),
    };
  }

  componentDidCatch(error, info) {
    const extraMeta = this.props.extraMeta && typeof this.props.extraMeta === 'object' ? this.props.extraMeta : {};
    const errorMeta = error && typeof error === 'object' && error.__tepihaLocalMeta && typeof error.__tepihaLocalMeta === 'object'
      ? error.__tepihaLocalMeta
      : {};
    const mergedMeta = { ...extraMeta, ...errorMeta };
    const entry = pushLocalErrorLog(error, info, {
      boundaryKind: this.props.boundaryKind || this.props.kind || mergedMeta.boundaryKind || 'local',
      route: this.props.routePath || this.props.path || mergedMeta.route || safePath('/'),
      routePath: this.props.routePath || this.props.path || mergedMeta.routePath || mergedMeta.path || safePath('/'),
      routeName: this.props.routeName || mergedMeta.routeName || '',
      moduleName: this.props.moduleName || this.props.moduleId || mergedMeta.moduleName || mergedMeta.moduleId || '',
      moduleId: this.props.moduleId || mergedMeta.moduleId || '',
      componentName: this.props.componentName || this.props.name || mergedMeta.componentName || '',
      sourceLayer: this.props.sourceLayer || mergedMeta.sourceLayer || 'local_error_boundary',
      componentStack: info?.componentStack || '',
      extraMeta: mergedMeta,
      ...mergedMeta,
      importRetryCount: mergedMeta.importRetryCount,
      retryCount: mergedMeta.retryCount,
      requestedModule: mergedMeta.requestedModule,
      importCaller: mergedMeta.importCaller,
    });
    try { this.props.onError?.(entry, error, info); } catch {}
    this.setState({ entry });
  }

  componentDidUpdate(prevProps) {
    const prevKey = shallowKey(prevProps?.resetKeys);
    const nextKey = shallowKey(this.props?.resetKeys);
    if (prevKey !== nextKey && this.state.hasError) {
      this.setState({ hasError: false, error: null, entry: null, copied: false, resetKey: nextKey });
    }
  }

  resetLocal = () => {
    try { this.props.onRetry?.(); } catch {}
    this.setState((state) => ({
      hasError: false,
      error: null,
      entry: null,
      copied: false,
      retryCount: state.retryCount + 1,
      resetKey: shallowKey(this.props?.resetKeys),
    }));
  };

  copyLog = async () => {
    const text = exportLocalErrorLogText(this.state.entry);
    const ok = await copyText(text);
    this.setState({ copied: !!ok });
    try { window.setTimeout(() => this.setState({ copied: false }), 1500); } catch {}
    return !!ok;
  };

  goHome = () => {
    try { window.location.assign('/'); } catch {}
  };

  renderFallback() {
    const kind = String(this.props.boundaryKind || this.props.kind || 'local');
    const isRoute = kind === 'route';
    const routePath = String(this.props.routePath || this.props.path || safePath('/'));
    const routeName = String(this.props.routeName || routePath || 'ROUTE');
    const moduleName = String(this.props.moduleName || this.props.moduleId || '');
    const componentName = String(this.props.componentName || this.props.name || routeName || moduleName || 'COMPONENT');
    const title = this.props.title || (isRoute ? 'ROUTE ERROR — FAQJA U IZOLUA' : 'LOCAL ERROR — MODULI U IZOLUA');
    const at = this.state.entry?.timestamp || this.state.entry?.at || nowIso();
    const message = compactMessage(this.state.error);
    const showHome = this.props.showHome !== false;
    const shellStyle = isRoute ? styles.routeShell : styles.moduleShell;
    const cardStyle = isRoute ? styles.card : { ...styles.card, maxWidth: 'none', margin: 0, padding: 12, boxShadow: 'none' };
    const helpText = String(this.props.helpText || this.props.errorHint || this.state.entry?.meta?.helpText || '');
    const failedAssets = Array.isArray(this.state.entry?.failedAssets)
      ? this.state.entry.failedAssets
      : (Array.isArray(this.state.entry?.meta?.failedAssets) ? this.state.entry.meta.failedAssets : []);
    const autoRetryCount = Number(this.state.entry?.autoRetryCount ?? this.state.entry?.meta?.autoRetryCount ?? 0) || 0;
    const routeRecovered = this.state.entry?.routeRecovered ?? this.state.entry?.meta?.routeRecovered;
    const repairHref = String(this.props.repairHref || this.state.entry?.repairHref || this.state.entry?.meta?.repairHref || '');
    const repairLabel = String(this.props.repairLabel || this.state.entry?.repairLabel || this.state.entry?.meta?.repairLabel || 'RIPARO APP');

    const fallback = (
      <div style={shellStyle} data-local-error-boundary="1" data-local-error-kind={kind} data-local-error-path={routePath}>
        <LocalErrorFallbackVisibleMarker
          boundaryKind={kind}
          routePath={routePath}
          routeName={routeName}
          moduleName={moduleName}
          moduleId={this.props.moduleId || moduleName}
          componentName={componentName}
          entry={this.state.entry}
        />
        <div style={cardStyle}>
          <div style={styles.eyebrow}>{title}</div>
          <div style={styles.title}>{componentName || routeName}</div>
          <div style={styles.metaGrid}>
            <div style={styles.metaBox}>
              <div style={styles.metaLabel}>PATH</div>
              <div style={styles.metaValue}>{routePath}</div>
            </div>
            <div style={styles.metaBox}>
              <div style={styles.metaLabel}>ROUTE / COMPONENT</div>
              <div style={styles.metaValue}>{routeName || componentName}</div>
            </div>
            <div style={styles.metaBox}>
              <div style={styles.metaLabel}>MODULE</div>
              <div style={styles.metaValue}>{moduleName || '—'}</div>
            </div>
            <div style={styles.metaBox}>
              <div style={styles.metaLabel}>TIMESTAMP</div>
              <div style={styles.metaValue}>{at}</div>
            </div>
            <div style={styles.metaBox}>
              <div style={styles.metaLabel}>LOCAL RETRY</div>
              <div style={styles.metaValue}>AUTO: {autoRetryCount} · RECOVERED: {String(routeRecovered ?? false)}</div>
            </div>
          </div>
          {helpText ? <div style={styles.help}>{helpText}</div> : null}
          <div style={styles.message}>{message}</div>
          {failedAssets.length ? (
            <div style={styles.assetList}>
              <div style={styles.metaLabel}>FAILED ASSETS</div>
              {failedAssets.slice(0, 8).map((asset) => <div key={asset}>{asset}</div>)}
            </div>
          ) : null}
          <div style={styles.actions}>
            <button type="button" style={styles.button} onClick={this.resetLocal}>PROVO PËRSËRI</button>
            {showHome ? <button type="button" style={styles.button} onClick={this.goHome}>KTHEHU NË HOME</button> : null}
            {repairHref ? <a style={styles.button} href={repairHref}>{repairLabel}</a> : null}
            <button type="button" style={styles.button} onClick={this.copyLog}>{this.state.copied ? 'U KOPJUA' : 'COPY ERROR / COPY LOG'}</button>
          </div>
        </div>
      </div>
    );

    if (typeof this.props.renderFallback === 'function') {
      try {
        return this.props.renderFallback({
          error: this.state.error,
          entry: this.state.entry,
          message,
          retry: this.resetLocal,
          copyLog: this.copyLog,
          goHome: this.goHome,
          defaultFallback: fallback,
        });
      } catch {
        return fallback;
      }
    }

    return fallback;
  }

  render() {
    if (this.state.hasError) return this.renderFallback();
    return <React.Fragment key={`local-ok:${this.state.retryCount}`}>{this.props.children}</React.Fragment>;
  }
}
