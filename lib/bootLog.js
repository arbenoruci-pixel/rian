const STATE_KEY = 'tepiha_simple_incident_state_v1';
const LAST_INCIDENT_KEY = 'tepiha_simple_last_incident_v1';
const CURRENT_BOOT_ID_KEY = 'tepiha_boot_current_id';
const IN_PROGRESS_KEY = 'tepiha_boot_in_progress';
const LAST_SUCCESS_KEY = 'tepiha_boot_last_success';
const LAST_INTERRUPTED_KEY = 'tepiha_boot_last_interrupted';
const HISTORY_KEY = 'tepiha_boot_trace_last';
const READY_EVENT_TYPES = new Set(['boot_mark_ready', 'first_ui_ready', 'ui_ready']);
const CRITICAL_EVENT_RE = /app_error|react_error|global_error|main_thread_stall|ui_input_stall|fetch_hung|fetch_throw|chunk|sw_.*error|route_render_rescue_fire|boot_timeout|auth_blocked/i;
const MAX_EVENTS = 24;
const MAX_HISTORY = 12;

let state = null;
let hooksBound = false;

function isBrowser() {
  return typeof window !== 'undefined';
}

function incidentsEnabled() {
  if (!isBrowser()) return false;
  try {
    if (window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ === false) return false;
  } catch {}
  try {
    if (window.sessionStorage?.getItem('__TEPIHA_SIMPLE_INCIDENTS_DISABLED__') === '1') return false;
  } catch {}
  try {
    if (window.localStorage?.getItem('__TEPIHA_SIMPLE_INCIDENTS_DISABLED__') === '1') return false;
  } catch {}
  return true;
}

function nowTs() {
  try { return Date.now(); } catch { return 0; }
}

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function currentPath() {
  if (!isBrowser()) return '';
  try { return String(window.location?.pathname || ''); } catch { return ''; }
}

function currentSearch() {
  if (!isBrowser()) return '';
  try { return String(window.location?.search || ''); } catch { return ''; }
}

function currentOnline() {
  if (!isBrowser()) return null;
  try { return navigator.onLine; } catch { return null; }
}

function currentVisibilityState() {
  if (!isBrowser()) return '';
  try { return String(document.visibilityState || ''); } catch { return ''; }
}

function currentUrl() {
  if (!isBrowser()) return '';
  try { return String(window.location?.href || ''); } catch { return ''; }
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function makeBootId() {
  const ts = nowTs();
  const rand = Math.random().toString(36).slice(2, 8);
  return `boot_${ts}_${rand}`;
}

function makeUuid() {
  try {
    const value = globalThis?.crypto?.randomUUID?.();
    if (value) return String(value);
  } catch {}
  const bytes = [];
  for (let i = 0; i < 16; i += 1) bytes.push(Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function createState() {
  const startedAt = nowIso();
  const path = currentPath();
  const search = currentSearch();
  return {
    bootId: makeBootId(),
    sessionId: makeUuid(),
    startedAt,
    path,
    bootRootPath: path,
    currentPath: path,
    search,
    currentSearch: search,
    url: currentUrl(),
    uiReady: false,
    readyAt: null,
    endedCleanly: false,
    actorRole: '',
    actorHasActor: null,
    lastEventType: 'boot_start',
    lastEventAt: startedAt,
    lastError: null,
    lastCriticalEvent: null,
    overlayShown: false,
    online: currentOnline(),
    visibilityState: currentVisibilityState(),
    swEpoch: (() => { try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; } })(),
    events: [{ type: 'boot_start', at: startedAt, data: { path, search, source: 'boot_log_v4' } }],
    phase: 'booting',
    incidentType: '',
    meta: {},
  };
}

function readState() {
  if (!isBrowser()) return null;
  try {
    return safeParse(window.sessionStorage?.getItem(STATE_KEY), null);
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    if (!storage) return;
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readJson(storage, key, fallback) {
  try {
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeState(next) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage?.setItem(STATE_KEY, JSON.stringify(next || null));
  } catch {}
  try {
    const bootId = String(next?.bootId || '');
    if (bootId) {
      window.sessionStorage?.setItem(CURRENT_BOOT_ID_KEY, bootId);
      window.localStorage?.setItem(CURRENT_BOOT_ID_KEY, bootId);
      window.BOOT_ID = bootId;
    }
  } catch {}
  writeJson(window.localStorage, IN_PROGRESS_KEY, next || null);
}

function readLastIncident() {
  if (!isBrowser()) return null;
  try {
    return safeParse(window.localStorage?.getItem(LAST_INCIDENT_KEY), null);
  } catch {
    return null;
  }
}

function writeLastIncident(next) {
  if (!isBrowser()) return;
  writeJson(window.localStorage, LAST_INCIDENT_KEY, next || null);
  writeJson(window.localStorage, LAST_INTERRUPTED_KEY, next || null);
}

function appendHistory(entry) {
  if (!isBrowser() || !entry) return;
  const list = readJson(window.localStorage, HISTORY_KEY, []);
  const next = [safeJson(entry, null), ...((Array.isArray(list) ? list : []).filter(Boolean))].slice(0, MAX_HISTORY);
  writeJson(window.localStorage, HISTORY_KEY, next);
}

function persistSuccess(entry) {
  if (!isBrowser() || !entry) return;
  writeJson(window.localStorage, LAST_SUCCESS_KEY, entry);
  appendHistory(entry);
}

function maybeRollBootForPath() {
  if (!state) return;
  const path = currentPath();
  if (!path) return;
  if (String(state.bootRootPath || '') === path) return;
  const previous = safeJson(state, null);
  if (previous) {
    previous.currentPath = String(state.currentPath || previous.currentPath || previous.bootRootPath || '');
    previous.currentSearch = String(state.currentSearch || previous.currentSearch || previous.search || '');
    previous.lastEventAt = previous.lastEventAt || nowIso();
    appendHistory(previous);
  }
  state = createState();
  writeState(state);
}

function ensureState() {
  if (!incidentsEnabled()) return null;
  if (state) {
    maybeRollBootForPath();
    return state;
  }
  const existing = readState();
  const path = currentPath();
  if (existing && typeof existing === 'object' && String(existing.bootRootPath || existing.path || '') === String(path || '')) {
    state = existing;
  } else {
    if (existing && typeof existing === 'object') appendHistory(existing);
    state = createState();
  }
  writeState(state);
  bindHooksOnce();
  return state;
}

function saveState() {
  if (!state || !incidentsEnabled()) return;
  state.currentPath = currentPath() || state.currentPath || state.bootRootPath;
  state.currentSearch = currentSearch() || state.currentSearch || state.search || '';
  state.url = currentUrl() || state.url;
  state.online = currentOnline();
  state.visibilityState = currentVisibilityState();
  state.lastEventAt = state.lastEventAt || nowIso();
  writeState(state);
}

function pushEvent(type, data = {}) {
  if (!state) return;
  const entry = { type: String(type || 'event'), at: nowIso(), data: safeJson(data, {}) };
  const list = Array.isArray(state.events) ? state.events : [];
  list.push(entry);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  state.events = list;
}

function isReadyEventType(type) {
  return READY_EVENT_TYPES.has(String(type || ''));
}

function isCriticalType(type) {
  return CRITICAL_EVENT_RE.test(String(type || ''));
}

function dispatchIncident(reason, extra = {}) {
  if (!incidentsEnabled()) return false;
  const current = ensureState();
  if (!current) return false;
  current.incidentType = String(extra?.incidentType || reason || 'runtime_incident');
  current.phase = 'booting';
  const entry = {
    bootId: current.bootId,
    sessionId: current.sessionId,
    startedAt: current.startedAt,
    bootRootPath: current.bootRootPath,
    currentPath: current.currentPath,
    currentSearch: current.currentSearch,
    readyAt: current.readyAt,
    uiReady: !!current.uiReady,
    actorRole: current.actorRole || '',
    actorHasActor: current.actorHasActor,
    lastEventType: String(extra?.lastEventType || current.lastEventType || reason || ''),
    lastEventAt: nowIso(),
    online: currentOnline(),
    visibilityState: currentVisibilityState(),
    swEpoch: current.swEpoch || '',
    overlayShown: !!current.overlayShown,
    incidentType: String(extra?.incidentType || reason || 'runtime_incident'),
    phase: current.phase,
    endedCleanly: false,
    meta: safeJson(extra, {}),
    events: Array.isArray(current.events) ? current.events.slice(-MAX_EVENTS) : [],
  };
  writeLastIncident(entry);
  appendHistory(entry);
  try {
    window.dispatchEvent(new CustomEvent('tepiha:simple-incident', { detail: entry }));
  } catch {}
  return true;
}

function bindHooksOnce() {
  if (!isBrowser() || hooksBound) return;
  hooksBound = true;
  const onPageHide = () => {
    try {
      if (!state) return;
      state.endedCleanly = true;
      state.lastEventType = 'pagehide';
      state.lastEventAt = nowIso();
      pushEvent('pagehide', { path: currentPath(), visibilityState: currentVisibilityState() });
      saveState();
      if (state.uiReady) persistSuccess(safeJson(state, null));
    } catch {}
  };
  const onVisibility = () => {
    try {
      if (!state) return;
      state.lastEventType = 'visibilitychange';
      state.lastEventAt = nowIso();
      pushEvent('visibilitychange', { visibilityState: currentVisibilityState(), path: currentPath() });
      saveState();
    } catch {}
  };
  try {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
  } catch {}
}

export function bootLog(type, data = {}) {
  if (!incidentsEnabled()) return false;
  const current = ensureState();
  if (!current) return false;
  const cleanType = String(type || 'event');
  current.currentPath = String(data?.path || currentPath() || current.currentPath || current.bootRootPath || '');
  current.currentSearch = String(data?.search || currentSearch() || current.currentSearch || current.search || '');
  current.lastEventType = cleanType;
  current.lastEventAt = nowIso();
  current.online = currentOnline();
  current.visibilityState = currentVisibilityState();
  if (typeof data?.role === 'string' && data.role.trim()) current.actorRole = String(data.role).trim();
  if (typeof data?.hasActor === 'boolean') current.actorHasActor = !!data.hasActor;
  if (/overlay/i.test(cleanType)) current.overlayShown = true;
  pushEvent(cleanType, data || {});
  if (isReadyEventType(cleanType)) {
    current.uiReady = true;
    current.phase = 'ready';
    if (!current.readyAt) current.readyAt = current.lastEventAt;
    persistSuccess(safeJson(current, null));
  }
  if (isCriticalType(cleanType)) {
    current.lastError = {
      type: cleanType,
      at: current.lastEventAt,
      data: safeJson(data, {}),
    };
    current.lastCriticalEvent = current.lastError;
    saveState();
    dispatchIncident('critical_event', {
      incidentType: cleanType,
      lastEventType: cleanType,
      error: current.lastError,
      path: current.currentPath,
    });
    return true;
  }
  saveState();
  return true;
}

export function bootMarkReady(meta = {}) {
  if (!incidentsEnabled()) return false;
  const current = ensureState();
  if (!current) return false;
  current.uiReady = true;
  current.phase = 'ready';
  current.readyAt = current.readyAt || nowIso();
  current.lastEventType = 'boot_mark_ready';
  current.lastEventAt = nowIso();
  current.currentPath = String(meta?.path || currentPath() || current.currentPath || current.bootRootPath || '');
  current.currentSearch = String(meta?.search || currentSearch() || current.currentSearch || current.search || '');
  pushEvent('boot_mark_ready', safeJson(meta || {}, {}));
  saveState();
  persistSuccess(safeJson(current, null));
  try { window.__TEPIHA_UI_READY = true; } catch {}
  try { document.documentElement?.setAttribute('data-ui-ready', '1'); } catch {}
  try { document.body?.setAttribute('data-ui-ready', '1'); } catch {}
  return true;
}

export function bootSnapshot(reason = '', data = {}) {
  const current = ensureState();
  if (!current) return null;
  if (reason && isCriticalType(reason)) {
    bootLog(reason, data || {});
  }
  saveState();
  return {
    ...current,
    events: Array.isArray(current.events) ? current.events.slice(-MAX_EVENTS) : [],
  };
}

export function bootReadHistory() {
  if (!isBrowser()) return [];
  return readJson(window.localStorage, HISTORY_KEY, []);
}

export function bootReadInProgress() {
  return ensureState();
}

export function bootReadLastSuccess() {
  if (!isBrowser()) return null;
  return readJson(window.localStorage, LAST_SUCCESS_KEY, null);
}

export function bootReadLastInterrupted() {
  return readLastIncident();
}

export function bootClearLastInterrupted(bootId = '') {
  const current = readLastIncident();
  const wanted = String(bootId || '');
  if (!current) return true;
  if (!wanted || String(current?.bootId || '') === wanted) writeLastIncident(null);
  return true;
}
