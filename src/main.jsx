import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot.jsx';

const VITE_PWA_SW_BASENAME = '/vite-sw.js';
const LEGACY_SW_DETECTED_KEY = 'tepiha_legacy_sw_detected_v1';

function writeRuntimeMarker(key, payload) {
  try {
    window.localStorage?.setItem?.(key, JSON.stringify(payload));
  } catch {}

  try {
    window.sessionStorage?.setItem?.(key, JSON.stringify(payload));
  } catch {}
}

function safeString(value) {
  try {
    return String(value == null ? '' : value);
  } catch {
    return '';
  }
}

function markReactRenderCalled(source = 'src_main_render_called_v32') {
  try { window.__TEPIHA_REACT_RENDER_CALLED__ = true; } catch {}
  try { window.__TEPIHA_REACT_RENDER_CALLED_AT__ = Date.now(); } catch {}
  try { window.__TEPIHA_REACT_RENDER_CALLED_SOURCE__ = source; } catch {}
  try { document.documentElement?.setAttribute?.('data-react-render-called', '1'); } catch {}
  try { document.body?.setAttribute?.('data-react-render-called', '1'); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:react-render-called', {
      detail: { source, at: Date.now(), patch: 'true_ui_ready_v32' },
    }));
  } catch {}
}

function controllerScriptURL() {
  try {
    return safeString(navigator.serviceWorker?.controller?.scriptURL || '');
  } catch {
    return '';
  }
}

function isLegacySwController(scriptURL) {
  try {
    const raw = safeString(scriptURL);
    if (!raw) return false;
    if (raw.includes(VITE_PWA_SW_BASENAME)) return false;
    const url = new URL(raw, window.location.origin);
    return url.pathname === '/sw.js';
  } catch {
    return false;
  }
}

function legacyDetectionPayload(source = 'startup') {
  const scriptURL = controllerScriptURL();
  const isLegacy = isLegacySwController(scriptURL);

  return {
    at: new Date().toISOString(),
    ts: Date.now(),
    sourceLayer: 'src_main_legacy_sw_bridge_v12',
    source: String(source || 'startup'),
    href: safeString(window.location?.href || ''),
    path: safeString(window.location?.pathname || ''),
    controllerScriptURL: scriptURL,
    legacyController: isLegacy,
    viteController: scriptURL.includes(VITE_PWA_SW_BASENAME),
    autoReloadDisabled: true,
    autoRepairDisabled: true,
    autoUnregisterDisabled: true,
    autoCachePurgeDisabled: true,
    manualRepairOnly: true,
  };
}

function emitLegacySwDetected(payload) {
  try {
    window.__TEPIHA_LEGACY_SW_DETECTED__ = payload;
  } catch {}

  writeRuntimeMarker(LEGACY_SW_DETECTED_KEY, payload);

  try {
    window.dispatchEvent(new CustomEvent('tepiha:legacy-sw-detected', { detail: payload }));
  } catch {}
}

function detectLegacyServiceWorkerPassively() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const check = (source = 'startup') => {
    try {
      const payload = legacyDetectionPayload(source);
      if (!payload.legacyController) return;
      emitLegacySwDetected(payload);
    } catch {}
  };

  check('startup');

  try {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      check('controllerchange');
    });
  } catch {}

  try {
    if (document.readyState === 'complete') {
      window.setTimeout(() => check('load_check'), 0);
    } else {
      window.addEventListener('load', () => { window.setTimeout(() => check('load_check'), 0); }, { once: true });
    }
  } catch {}
}

function markManualRepairSuggested(reason, extra = {}) {
  if (typeof window === 'undefined') return;

  const payload = {
    at: new Date().toISOString(),
    ts: Date.now(),
    sourceLayer: 'src_main_manual_repair_v12',
    reason: String(reason || 'runtime_issue'),
    autoReloadDisabled: true,
    autoRepairDisabled: true,
    manualRepairOnly: true,
    href: safeString(window.location?.href || ''),
    path: safeString(window.location?.pathname || ''),
    ...extra,
  };

  writeRuntimeMarker('tepiha_manual_repair_suggested_v12', payload);

  try {
    window.__TEPIHA_UPDATE_AVAILABLE__ = payload;
    window.dispatchEvent(new CustomEvent('tepiha:update-available', { detail: payload }));
  } catch {}
}

function installVitePreloadPassiveGuard() {
  if (typeof window === 'undefined') return;

  try {
    window.addEventListener('vite:preloadError', (event) => {
      try { event?.preventDefault?.(); } catch {}
      markManualRepairSuggested('vite_preload_error_passive_no_reload', {
        eventType: 'vite:preloadError',
        error: (() => {
          try {
            const raw = event?.payload || event?.reason || null;
            if (!raw) return null;
            return {
              name: safeString(raw?.name || ''),
              message: safeString(raw?.message || raw || ''),
              stack: safeString(raw?.stack || ''),
            };
          } catch {
            return null;
          }
        })(),
      });
    });
  } catch {}
}

installVitePreloadPassiveGuard();
detectLegacyServiceWorkerPassively();

try {
  window.__TEPIHA_REACT_READY__ = true;
  window.__TEPIHA_REACT_MOUNT_STARTED_AT__ = Date.now();
  document.documentElement?.setAttribute?.('data-react-ready', '1');
} catch {}

try {
  const mountNode = document.getElementById('root');
  if (!mountNode) throw new Error('ROOT_NODE_MISSING');
  ReactDOM.createRoot(mountNode).render(
    <AppRoot />,
  );
  markReactRenderCalled('src_main_render_called_v32');
} catch (error) {
  try {
    window.__TEPIHA_REACT_MOUNT_ERROR__ = {
      at: new Date().toISOString(),
      message: safeString(error?.message || error),
      stack: safeString(error?.stack || ''),
      sourceLayer: 'src_main_react_mount',
      failOpen: true,
    };
  } catch {}
  try {
    if (typeof window.__TEPIHA_SHOW_FAIL_OPEN_SHELL__ === 'function') {
      window.__TEPIHA_SHOW_FAIL_OPEN_SHELL__('react_mount_error', window.__TEPIHA_REACT_MOUNT_ERROR__ || {});
    }
  } catch {}
}
