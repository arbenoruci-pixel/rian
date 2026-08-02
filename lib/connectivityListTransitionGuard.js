const STYLE_ID = 'tepiha-connectivity-list-transition-guard-v1';
const OVERLAY_ID = 'tepiha-connectivity-list-transition-overlay-v1';
const SUPPORTED_PATHS = new Set(['/pastrimi', '/gati']);
const HOLD_MS = 1200;

let installed = false;
let hideTimer = null;
let lastState = null;

function currentPath() {
  try {
    return String(window.location?.pathname || '').replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

function supportedPath() {
  return SUPPORTED_PATHS.has(currentPath());
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #05070d;
      color: #f8fafc;
      font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .tepiha-list-transition-card {
      width: min(440px, 100%);
      border: 1px solid rgba(96,165,250,.35);
      border-radius: 22px;
      background: linear-gradient(180deg,#111827,#070b12);
      box-shadow: 0 24px 80px rgba(0,0,0,.62);
      padding: 20px;
      text-align: center;
    }
    #${OVERLAY_ID} .tepiha-list-transition-title {
      font-size: 21px;
      line-height: 1.15;
      font-weight: 1000;
      letter-spacing: .02em;
    }
    #${OVERLAY_ID} .tepiha-list-transition-subtitle {
      margin-top: 9px;
      color: #cbd5e1;
      font-size: 14px;
      line-height: 1.45;
      font-weight: 750;
    }
  `;
  document.head.appendChild(style);
}

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-busy', 'true');
  overlay.innerHTML = `
    <div class="tepiha-list-transition-card">
      <div class="tepiha-list-transition-title">Duke pergatitur listen...</div>
      <div class="tepiha-list-transition-subtitle">Po hapen te dhenat e fundit te sinkronizuara.</div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function closeOverlay(reason = 'timeout') {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.setAttribute('data-open', '0');
  try {
    window.dispatchEvent(new CustomEvent('tepiha:list-transition-guard-closed', {
      detail: { reason, path: currentPath(), at: Date.now() },
    }));
  } catch {}
}

function openOverlay(reason = 'connectivity_change') {
  if (!supportedPath()) return;
  ensureStyle();
  const overlay = ensureOverlay();
  overlay.setAttribute('data-open', '1');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => closeOverlay('stabilization_window_complete'), HOLD_MS);
  try {
    window.dispatchEvent(new CustomEvent('tepiha:list-transition-guard-opened', {
      detail: { reason, path: currentPath(), online: navigator.onLine !== false, at: Date.now() },
    }));
  } catch {}
}

function onConnectivityChange(source) {
  const nextState = navigator.onLine !== false;
  if (lastState === nextState && source !== 'pageshow') return;
  lastState = nextState;
  openOverlay(source);
  try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}
}

function onRouteSignal() {
  if (!supportedPath()) closeOverlay('route_changed');
}

export function installConnectivityListTransitionGuard() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  lastState = navigator.onLine !== false;
  ensureStyle();
  ensureOverlay();
  window.addEventListener('offline', () => onConnectivityChange('offline'), { passive: true });
  window.addEventListener('online', () => onConnectivityChange('online'), { passive: true });
  window.addEventListener('pageshow', () => onConnectivityChange('pageshow'), { passive: true });
  window.addEventListener('popstate', onRouteSignal, { passive: true });
  window.addEventListener('hashchange', onRouteSignal, { passive: true });
}

export const CONNECTIVITY_LIST_TRANSITION_GUARD_V1 = {
  paths: Array.from(SUPPORTED_PATHS),
  holdMs: HOLD_MS,
  overlayId: OVERLAY_ID,
};
