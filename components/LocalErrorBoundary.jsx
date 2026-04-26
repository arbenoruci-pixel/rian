'use client';

import React from 'react';

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function safePath(fallback = '/') {
  try { return String(window.location?.pathname || fallback || '/'); } catch { return String(fallback || '/'); }
}

function safeString(value, fallback = '') {
  try {
    if (value === null || value === undefined) return fallback;
    return String(value);
  } catch {
    return fallback;
  }
}

function shallowKey(value) {
  try { return JSON.stringify(value || []); } catch { return safeString(value, ''); }
}

function errorName(error) {
  return safeString(error?.name || 'Error', 'Error');
}

function errorMessage(error) {
  return safeString(error?.message || error || 'UNKNOWN_LOCAL_ERROR', 'UNKNOWN_LOCAL_ERROR');
}

function errorStack(error) {
  return safeString(error?.stack || '', '');
}

function componentStack(info) {
  return safeString(info?.componentStack || '', '');
}

function isTemporalDeadZoneError(error) {
  const msg = errorMessage(error);
  return /Cannot access ['"].+['"] before initialization/i.test(msg)
    || /before initialization/i.test(msg)
    || /temporal dead zone/i.test(msg);
}

function markFallbackVisible(detail) {
  try { window.__TEPIHA_UI_READY = true; } catch {}
  try { document?.documentElement?.setAttribute?.('data-ui-ready', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-ui-ready', '1'); } catch {}
  try { document?.documentElement?.setAttribute?.('data-local-error-boundary-visible', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-local-error-boundary-visible', '1'); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:local-error-boundary-visible', { detail }));
  } catch {}
}

function pushInlineErrorLog(payload) {
  try {
    const key = 'tepiha_local_error_boundary_visible_v1';
    const current = JSON.parse(localStorage.getItem(key) || '[]');
    const next = Array.isArray(current) ? current : [];
    next.unshift(payload);
    localStorage.setItem(key, JSON.stringify(next.slice(0, 25)));
  } catch {}
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

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

function PreBlock({ label, children }) {
  const text = safeString(children, '');
  if (!text) return null;
  return (
    <div style={styles.block}>
      <div style={styles.blockLabel}>{label}</div>
      <pre style={styles.pre}>{text}</pre>
    </div>
  );
}

function MetaBox({ label, value }) {
  return (
    <div style={styles.metaBox}>
      <div style={styles.metaLabel}>{label}</div>
      <div style={styles.metaValue}>{safeString(value, '—') || '—'}</div>
    </div>
  );
}

const styles = {
  routeShell: {
    minHeight: '100vh',
    background: '#05070d',
    color: '#fff',
    padding: 14,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif',
    display: 'block',
  },
  moduleShell: {
    width: '100%',
    minHeight: 180,
    borderRadius: 16,
    border: '1px solid rgba(248,113,113,0.45)',
    background: 'rgba(127,29,29,0.24)',
    color: '#fff',
    padding: 12,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif',
    display: 'block',
  },
  card: {
    width: '100%',
    maxWidth: 980,
    margin: '0 auto',
    borderRadius: 18,
    border: '1px solid rgba(248,113,113,0.58)',
    background: 'rgba(15,23,42,0.96)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.42)',
    padding: 16,
  },
  eyebrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: '#fecaca',
    background: 'rgba(185,28,28,0.26)',
    border: '1px solid rgba(248,113,113,0.35)',
    borderRadius: 999,
    padding: '7px 10px',
    fontSize: 11,
    fontWeight: 950,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 12,
    fontSize: 22,
    lineHeight: 1.1,
    fontWeight: 950,
    letterSpacing: 0.2,
  },
  subtitle: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    lineHeight: 1.45,
    fontWeight: 750,
  },
  tdzHint: {
    marginTop: 12,
    borderRadius: 14,
    border: '1px solid rgba(251,191,36,0.45)',
    background: 'rgba(120,53,15,0.32)',
    color: '#fde68a',
    padding: 12,
    fontSize: 13,
    fontWeight: 850,
    lineHeight: 1.45,
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 8,
    marginTop: 14,
  },
  metaBox: {
    minWidth: 0,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.05)',
    padding: 10,
  },
  metaLabel: {
    opacity: 0.62,
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  metaValue: {
    marginTop: 5,
    fontSize: 12,
    fontWeight: 820,
    wordBreak: 'break-word',
  },
  message: {
    marginTop: 14,
    borderRadius: 14,
    border: '1px solid rgba(248,113,113,0.38)',
    background: 'rgba(248,113,113,0.10)',
    padding: 12,
    color: '#fecaca',
    fontSize: 13,
    fontWeight: 900,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  block: {
    marginTop: 12,
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(2,6,23,0.72)',
    overflow: 'hidden',
  },
  blockLabel: {
    padding: '9px 10px',
    color: 'rgba(255,255,255,0.70)',
    background: 'rgba(255,255,255,0.04)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    fontSize: 10,
    fontWeight: 950,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  pre: {
    margin: 0,
    padding: 10,
    maxHeight: 260,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#e5e7eb',
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 14,
  },
  button: {
    appearance: 'none',
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.09)',
    color: '#fff',
    borderRadius: 12,
    padding: '10px 12px',
    fontWeight: 950,
    letterSpacing: 0.45,
    fontSize: 12,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    background: 'rgba(220,38,38,0.72)',
    border: '1px solid rgba(248,113,113,0.60)',
  },
};

function LocalErrorFallbackVisibleMarker({ detail }) {
  React.useEffect(() => {
    markFallbackVisible(detail);
    pushInlineErrorLog(detail);
  }, [detail?.id]);
  return null;
}

export default class LocalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      componentStack: '',
      copied: false,
      retryCount: 0,
      resetKey: shallowKey(props?.resetKeys),
      id: '',
      at: '',
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error: error || new Error('LOCAL_BOUNDARY_ERROR'),
      at: nowIso(),
      id: `local_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  componentDidCatch(error, info) {
    const stack = componentStack(info);
    const detail = this.buildErrorDetail(error, stack);
    try { this.props.onError?.(detail, error, info); } catch {}
    this.setState({ componentStack: stack, id: detail.id, at: detail.at });
  }

  componentDidUpdate(prevProps) {
    const prevKey = shallowKey(prevProps?.resetKeys);
    const nextKey = shallowKey(this.props?.resetKeys);
    if (prevKey !== nextKey && this.state.hasError) {
      this.setState({
        hasError: false,
        error: null,
        componentStack: '',
        copied: false,
        resetKey: nextKey,
        id: '',
        at: '',
      });
    }
  }

  buildErrorDetail(error = this.state.error, stack = this.state.componentStack) {
    const kind = safeString(this.props.boundaryKind || this.props.kind || 'local', 'local');
    const routePath = safeString(this.props.routePath || this.props.path || safePath('/'), '/');
    const routeName = safeString(this.props.routeName || routePath || 'ROUTE', 'ROUTE');
    const moduleName = safeString(this.props.moduleName || this.props.moduleId || '', '');
    const componentName = safeString(this.props.componentName || this.props.name || routeName || moduleName || 'COMPONENT', 'COMPONENT');
    const at = this.state.at || nowIso();
    const id = this.state.id || `local_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
      id,
      at,
      boundaryKind: kind,
      routePath,
      routeName,
      moduleName,
      componentName,
      sourceLayer: safeString(this.props.sourceLayer || 'local_error_boundary', 'local_error_boundary'),
      errorName: errorName(error),
      errorMessage: errorMessage(error),
      errorStack: errorStack(error),
      componentStack: safeString(stack, ''),
      resetKey: shallowKey(this.props?.resetKeys),
      isTemporalDeadZoneError: isTemporalDeadZoneError(error),
      userAgent: safeString(typeof navigator !== 'undefined' ? navigator.userAgent : '', ''),
      href: safeString(typeof window !== 'undefined' ? window.location?.href : '', ''),
    };
  }

  resetLocal = () => {
    try { this.props.onRetry?.(); } catch {}
    this.setState((state) => ({
      hasError: false,
      error: null,
      componentStack: '',
      copied: false,
      retryCount: state.retryCount + 1,
      resetKey: shallowKey(this.props?.resetKeys),
      id: '',
      at: '',
    }));
  };

  copyLog = async () => {
    const detail = this.buildErrorDetail();
    const ok = await copyText(JSON.stringify(detail, null, 2));
    this.setState({ copied: !!ok });
    try { window.setTimeout(() => this.setState({ copied: false }), 1500); } catch {}
    return !!ok;
  };

  goHome = () => {
    try {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    } catch {}
    try { window.dispatchEvent(new CustomEvent('tepiha:soft-home-request', { detail: { source: 'LocalErrorBoundary' } })); } catch {}
  };

  renderFallback() {
    const detail = this.buildErrorDetail();
    const isRoute = detail.boundaryKind === 'route';
    const shellStyle = isRoute ? styles.routeShell : styles.moduleShell;
    const cardStyle = isRoute ? styles.card : { ...styles.card, maxWidth: 'none', margin: 0, padding: 12, boxShadow: 'none' };
    const title = safeString(this.props.title || (isRoute ? 'ROUTE ERROR — FAQJA U IZOLUA' : 'LOCAL ERROR — MODULI U IZOLUA'), 'LOCAL ERROR');
    const showHome = this.props.showHome !== false;
    const repairHref = safeString(this.props.repairHref || '', '');
    const repairLabel = safeString(this.props.repairLabel || 'RIPARO APP', 'RIPARO APP');
    const helpText = safeString(this.props.helpText || this.props.errorHint || '', '');

    const fallback = (
      <div
        style={shellStyle}
        data-local-error-boundary="1"
        data-local-error-kind={detail.boundaryKind}
        data-local-error-path={detail.routePath}
      >
        <LocalErrorFallbackVisibleMarker detail={detail} />
        <div style={cardStyle}>
          <div style={styles.eyebrow}>⚠ {title}</div>
          <div style={styles.title}>{detail.componentName || detail.routeName}</div>
          <div style={styles.subtitle}>
            Gabimi u kap lokalisht. App-i nuk duhet të mbetet ekran i zi; ky panel tregon komponentin, mesazhin dhe stack-un që duhet me u ndreq.
          </div>

          {detail.isTemporalDeadZoneError ? (
            <div style={styles.tdzHint}>
              Ky mesazh zakonisht vjen nga circular dependency në Vite/Rollup. Shiko “COMPONENT STACK” dhe pastaj terminalin nga circular-deps scanner për zinxhirin e import-eve.
            </div>
          ) : null}

          {helpText ? <div style={styles.tdzHint}>{helpText}</div> : null}

          <div style={styles.metaGrid}>
            <MetaBox label="PATH" value={detail.routePath} />
            <MetaBox label="ROUTE" value={detail.routeName} />
            <MetaBox label="MODULE" value={detail.moduleName} />
            <MetaBox label="COMPONENT" value={detail.componentName} />
            <MetaBox label="SOURCE" value={detail.sourceLayer} />
            <MetaBox label="TIME" value={detail.at} />
          </div>

          <div style={styles.message}>
            {detail.errorName}: {detail.errorMessage}
          </div>

          <PreBlock label="COMPONENT STACK">
            {detail.componentStack || 'Nuk erdhi componentStack nga React për këtë gabim.'}
          </PreBlock>
          <PreBlock label="ERROR STACK">
            {detail.errorStack || 'Nuk erdhi error.stack nga browser-i.'}
          </PreBlock>
          <PreBlock label="COPY JSON">
            {JSON.stringify(detail, null, 2)}
          </PreBlock>

          <div style={styles.actions}>
            <button type="button" style={{ ...styles.button, ...styles.primaryButton }} onClick={this.copyLog}>
              {this.state.copied ? 'U KOPJUA' : 'COPY ERROR JSON'}
            </button>
            <button type="button" style={styles.button} onClick={this.resetLocal}>PROVO PËRSËRI</button>
            {showHome ? <button type="button" style={styles.button} onClick={this.goHome}>KTHEHU NË HOME</button> : null}
            {repairHref ? <a style={styles.button} href={repairHref}>{repairLabel}</a> : null}
          </div>
        </div>
      </div>
    );

    if (typeof this.props.renderFallback === 'function') {
      try {
        return this.props.renderFallback({
          error: this.state.error,
          entry: detail,
          message: detail.errorMessage,
          componentStack: detail.componentStack,
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
