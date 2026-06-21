const HIDDEN_TS_KEY = 'tepiha_last_hidden_at_v3';
const GLOBAL_KEY = '__TEPIHA_RESUME_GATE_V3__';
const DEFAULT_GLOBAL_OWNER_SCOPE = 'sw_recovery_owner';

function isBrowser() {
  return typeof window !== 'undefined';
}

function nowTs() {
  return Date.now();
}

function getConfiguredGlobalOwnerScope() {
  if (!isBrowser()) return DEFAULT_GLOBAL_OWNER_SCOPE;
  try {
    const raw = String(window.__TEPIHA_RESUME_OWNER_SCOPE__ || '').trim();
    if (raw) return raw;
  } catch {}
  return DEFAULT_GLOBAL_OWNER_SCOPE;
}

export function setGlobalResumeOwner(scope = DEFAULT_GLOBAL_OWNER_SCOPE) {
  if (!isBrowser()) return DEFAULT_GLOBAL_OWNER_SCOPE;
  const next = String(scope || DEFAULT_GLOBAL_OWNER_SCOPE).trim() || DEFAULT_GLOBAL_OWNER_SCOPE;
  try { window.__TEPIHA_RESUME_OWNER_SCOPE__ = next; } catch {}
  const store = getStore();
  if (store) store.globalOwnerScope = next;
  return next;
}

function getStore() {
  if (!isBrowser()) return null;
  const seed = {
    claims: {},
    globalClaim: { token: '', at: 0, source: '', scope: '' },
    globalOwnerScope: getConfiguredGlobalOwnerScope(),
    lastHiddenAt: 0,
    lastAcceptedAt: 0,
    lastAcceptedSource: '',
  };
  if (!window[GLOBAL_KEY] || typeof window[GLOBAL_KEY] !== 'object') {
    window[GLOBAL_KEY] = seed;
  }
  if (!window[GLOBAL_KEY].claims || typeof window[GLOBAL_KEY].claims !== 'object') {
    window[GLOBAL_KEY].claims = {};
  }
  if (!window[GLOBAL_KEY].globalClaim || typeof window[GLOBAL_KEY].globalClaim !== 'object') {
    window[GLOBAL_KEY].globalClaim = { token: '', at: 0, source: '', scope: '' };
  }
  if (!window[GLOBAL_KEY].globalOwnerScope) {
    window[GLOBAL_KEY].globalOwnerScope = getConfiguredGlobalOwnerScope();
  }
  return window[GLOBAL_KEY];
}

export function getLastHiddenAt() {
  if (!isBrowser()) return 0;
  let ts = 0;
  try {
    ts = Number(window.__tepihaLastHiddenAt || 0) || 0;
  } catch {}
  if (!ts) {
    try {
      ts = Number(localStorage.getItem(HIDDEN_TS_KEY) || 0) || 0;
    } catch {}
  }
  const store = getStore();
  if (store && ts) store.lastHiddenAt = ts;
  return ts;
}

export function noteHiddenAt(ts = nowTs()) {
  if (!isBrowser()) return 0;
  const hiddenAt = Number(ts || nowTs()) || nowTs();
  const store = getStore();
  if (store) store.lastHiddenAt = hiddenAt;
  try { window.__tepihaLastHiddenAt = hiddenAt; } catch {}
  try { localStorage.setItem(HIDDEN_TS_KEY, String(hiddenAt)); } catch {}
  return hiddenAt;
}

function isGlobalResumeSource(source = '') {
  const normalized = String(source || '').toLowerCase();
  return normalized.includes('visibility') || normalized.includes('pageshow') || normalized.includes('focus');
}

export function claimResume(scope, source, options = {}) {
  if (!isBrowser()) {
    return { accepted: false, reason: 'no_window', token: '', hiddenElapsedMs: 0 };
  }

  const {
    minGapMs = 1800,
    minHiddenMs = 900,
    allowWithoutHidden = false,
    visibleRequired = true,
    globalResume = isGlobalResumeSource(source),
  } = options || {};

  if (visibleRequired) {
    try {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return { accepted: false, reason: 'hidden', token: '', hiddenElapsedMs: 0 };
      }
    } catch {}
  }

  const store = getStore();
  if (!store) return { accepted: false, reason: 'no_store', token: '', hiddenElapsedMs: 0 };

  const now = nowTs();
  const hiddenAt = getLastHiddenAt();
  const hiddenElapsedMs = hiddenAt ? Math.max(0, now - hiddenAt) : 0;

  if (hiddenAt && !allowWithoutHidden && hiddenElapsedMs < Math.max(0, Number(minHiddenMs) || 0)) {
    return { accepted: false, reason: 'short_hidden', token: String(hiddenAt), hiddenElapsedMs };
  }

  const token = hiddenAt ? `hidden:${hiddenAt}` : `burst:${Math.floor(now / Math.max(800, Number(minGapMs) || 1800))}`;
  const scopeKey = String(scope || 'default');

  if (globalResume) {
    const ownerScope = String(store.globalOwnerScope || getConfiguredGlobalOwnerScope() || DEFAULT_GLOBAL_OWNER_SCOPE);
    if (ownerScope && scopeKey !== ownerScope) {
      return { accepted: false, reason: 'already_claimed_global_resume', token, hiddenElapsedMs };
    }
    const prevGlobal = store.globalClaim || { token: '', at: 0, source: '', scope: '' };
    if (prevGlobal.token === token && (now - Number(prevGlobal.at || 0)) < Math.max(0, Number(minGapMs) || 0)) {
      return { accepted: false, reason: 'already_claimed_global_resume', token, hiddenElapsedMs };
    }
    store.globalClaim = { token, at: now, source: String(source || ''), scope: scopeKey };
  }

  const prev = store.claims?.[scopeKey] || { token: '', at: 0, source: '' };
  if (prev.token === token && (now - Number(prev.at || 0)) < Math.max(0, Number(minGapMs) || 0)) {
    return { accepted: false, reason: 'already_claimed', token, hiddenElapsedMs };
  }

  store.claims[scopeKey] = { token, at: now, source: String(source || '') };
  store.lastAcceptedAt = now;
  store.lastAcceptedSource = String(source || '');

  return { accepted: true, reason: 'accepted', token, hiddenElapsedMs };
}
