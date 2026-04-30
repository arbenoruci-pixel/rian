// lib/onlineListener.js
// Thin online listener that only nudges the shared sync scheduler.

function installOnce() {
  if (typeof window === 'undefined') return;
  if (window.__tepihaOnlineListenerInstalled) return;
  window.__tepihaOnlineListenerInstalled = true;

  let timer = null;
  window.addEventListener('online', () => {
    try { if (timer) window.clearTimeout(timer); } catch {}
    timer = window.setTimeout(() => {
      timer = null;
      try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}
    }, 900);
  });
}

export function setupOnlineListeners() {
  installOnce();
}

if (typeof window !== 'undefined') {
  installOnce();
}
