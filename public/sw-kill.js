(function () {
  var EPOCH = 'RESET-2026-04-26-VITE-FINAL-HARDENING-V26';
  var FLAG = '__TEPIHA_SW_KILL_SWITCH__';
  var DONE_KEY = '__tepiha_sw_kill_done__' + EPOCH;
  var RELOAD_KEY = '__tepiha_sw_kill_reload_once__' + EPOCH;
  var started = false;

  var explicitKillRequested = false;
  try {
    var qs = new URLSearchParams((window.location && window.location.search) || '');
    explicitKillRequested = qs.get('__sw_kill') === EPOCH && qs.get('__sw_kill_confirm') === 'YES';
  } catch (_) {}

  var globalKillRequested = false;
  try { globalKillRequested = (window[FLAG] === true || window.__TEPIHA_FORCE_NETWORK_MODE__ === true) && window.__TEPIHA_SW_KILL_SWITCH_EPOCH__ === EPOCH && window.__TEPIHA_SW_KILL_CONFIRM__ === 'YES'; } catch (_) {}
  var shouldKill = explicitKillRequested || globalKillRequested;

  if (!shouldKill) {
    try { delete window[FLAG]; } catch (_) {}
    try { delete window.__TEPIHA_FORCE_NETWORK_MODE__; } catch (_) {}
    try { delete window.__TEPIHA_SW_KILL_SWITCH_EPOCH__; } catch (_) {}
  } else {
    try { window[FLAG] = true; } catch (_) {}
    try { window.__TEPIHA_FORCE_NETWORK_MODE__ = true; } catch (_) {}
    try { window.__TEPIHA_SW_KILL_SWITCH_EPOCH__ = EPOCH; } catch (_) {}
  }

  async function clearRegistrations() {
    if (!('serviceWorker' in navigator)) return { count: 0 };
    var regs = [];
    try { regs = await navigator.serviceWorker.getRegistrations(); } catch (_) { regs = []; }
    await Promise.allSettled((regs || []).map(function (reg) {
      return (async function () {
        try {
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING', manual: true });
        } catch (_) {}
        try {
          if (reg.active) reg.active.postMessage({ type: 'SKIP_WAITING', manual: true });
        } catch (_) {}
        try {
          await reg.unregister();
        } catch (_) {}
      })();
    }));
    return { count: (regs || []).length };
  }

  function isAllowedKillCache(key) {
    try {
      var value = String(key || '');
      return /^(pages-|next-data-|nextjs-|next-|tepiha-next-|tepiha-legacy-|tepiha-sw-legacy-|legacy-sw-|sw-route-containment|sw-pwa-staleness|pwa-staleness)/i.test(value)
        || /^tepiha-vite-(business-routes|static-assets|media)-v(1[0-9]|2[0-5])$/i.test(value)
        || /^workbox-precache-.*tepiha/i.test(value);
    } catch (_) { return false; }
  }

  async function clearCaches() {
    if (!('caches' in window)) return { count: 0, keys: [] };
    var keys = [];
    var deleted = [];
    try { keys = await window.caches.keys(); } catch (_) { keys = []; }
    await Promise.allSettled((keys || []).filter(isAllowedKillCache).map(function (key) {
      try { deleted.push(key); return window.caches.delete(key); }
      catch (_) { return Promise.resolve(false); }
    }));
    return { count: deleted.length, keys: deleted };
  }

  function clearStorageMarkers() {
    var targets = [window.localStorage, window.sessionStorage];
    targets.forEach(function (store) {
      try {
        if (!store) return;
        var toDelete = [];
        for (var i = 0; i < store.length; i += 1) {
          var key = store.key(i);
          if (!key) continue;
          if (
            key.indexOf('__tepiha_sw_') === 0 ||
            key.indexOf('sw_epoch_repair_done_') === 0 ||
            key.indexOf('sw_epoch_repair_reload_') === 0 ||
            key.indexOf('tepiha_allow_browser_offline_runtime') === 0 ||
            key.indexOf('tepiha_sw_kill_') === 0
          ) {
            toDelete.push(key);
          }
        }
        toDelete.forEach(function (key) {
          try { store.removeItem(key); } catch (_) {}
        });
      } catch (_) {}
    });
  }

  async function runKillSwitch() {
    if (started) return;
    started = true;

    var alreadyDone = false;
    try { alreadyDone = sessionStorage.getItem(DONE_KEY) === '1'; } catch (_) {}

    clearStorageMarkers();

    var regInfo = { count: 0 };
    var cacheInfo = { count: 0, keys: [] };
    try { regInfo = await clearRegistrations(); } catch (_) {}
    try { cacheInfo = await clearCaches(); } catch (_) {}

    try {
      sessionStorage.setItem(DONE_KEY, '1');
      try { delete window[FLAG]; } catch (_) {}
      try { delete window.__TEPIHA_FORCE_NETWORK_MODE__; } catch (_) {}
      try { delete window.__TEPIHA_SW_KILL_SWITCH_EPOCH__; } catch (_) {}
      window.__TEPIHA_SW_KILL_RESULT__ = {
        epoch: EPOCH,
        registrationsCleared: regInfo.count || 0,
        cachesCleared: cacheInfo.count || 0,
        cacheKeys: cacheInfo.keys || [],
        at: Date.now()
      };
    } catch (_) {}

    var shouldReload = !alreadyDone;
    if (!shouldReload) return;

    var reloadUsed = false;
    try { reloadUsed = sessionStorage.getItem(RELOAD_KEY) === '1'; } catch (_) {}
    if (reloadUsed) return;

    try { sessionStorage.setItem(RELOAD_KEY, '1'); } catch (_) {}

    setTimeout(function () {
      try {
        window.dispatchEvent(new CustomEvent('tepiha:sw-kill-completed-no-reload', {
          detail: { epoch: EPOCH, noAutoReload: true, at: new Date().toISOString() }
        }));
      } catch (_) {}
    }, 80);
  }

  if (!shouldKill) {
    try { clearStorageMarkers(); } catch (_) {}
    return;
  }

  try {
    window.__TEPIHA_SW_KILL_PROMISE__ = runKillSwitch();
  } catch (_) {
    runKillSwitch();
  }
})();
