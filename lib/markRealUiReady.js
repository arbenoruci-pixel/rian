export function markRealUiReady(source = 'unknown') {
  try { window.__TEPIHA_UI_READY__ = true; } catch {}
  try { window.__TEPIHA_FIRST_UI_READY__ = true; } catch {}
  try { window.__TEPIHA_LAST_UI_READY_SOURCE__ = source; } catch {}
  try { window.__TEPIHA_LAST_UI_READY_AT__ = Date.now(); } catch {}
  try { document.documentElement.dataset.uiReady = '1'; } catch {}
  try { document.body.dataset.uiReady = '1'; } catch {}
  try { document.documentElement.dataset.uiReadySource = source; } catch {}
  try { document.body.dataset.uiReadySource = source; } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:first-ui-ready', {
      detail: { source, at: Date.now(), patch: 'true_ui_ready_v32' },
    }));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:route-ui-alive', {
      detail: { source, path: String(window.location?.pathname || '/'), at: Date.now(), patch: 'true_ui_ready_v32' },
    }));
  } catch {}
}
