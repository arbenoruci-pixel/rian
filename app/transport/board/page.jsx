'use client';

export const dynamic = 'force-dynamic';


import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabaseClient';
import { getTransportSession, setTransportSession } from '@/lib/transportAuth';
import { canAccessTransportAdmin } from '@/lib/roles';
import { findUserByPin, listUsers } from '@/lib/usersDb';

// ✅ SINGLE SOURCE OF TRUTH FOR BOARD UI + HELPERS
// (prevents “options/modules disappear” when one copy gets edited and another copy gets loaded)
import { ui } from '@/lib/transport/board/ui';
// NOTE: Keep Transport Board self-contained.
// We derive transport_id directly from the transport session to avoid
// module-load issues ("TypeError: Load failed") when a shared helper
// gets moved/overridden.

import SmartSmsModal from '@/components/SmartSmsModal';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import RackLocationModal from '@/components/RackLocationModal';
import { buildSmartSmsText } from '@/lib/smartSms';
import { fetchRackMapFromDb, normalizeRackSlots } from '@/lib/rackLocations';
import { trackRender } from '@/lib/sensor';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { listTransportOrders, updateTransportOrderById, updateTransportOrdersByIds } from '@/lib/transportOrdersDb';
import { getErrorMessage } from '@/lib/uiSafety';
import { sanitizeTransportClientPayload } from '@/lib/transport/sanitize';
import useRouteAlive from '@/lib/routeAlive';
import { recordRouteDiagEvent } from '@/lib/lazyImportRuntime';

// IMPORTANT TRANSPORT STABILITY RULE:
// Keep the board modules EAGER here.
// The repeated black-screen incidents on /transport/board point to modulepreload /
// lazy-import chunk failures. Importing the modules statically keeps
// Inbox/Ngarkim/Dorzim/Gati/Depo/Dorezimet inside the main board execution path
// and removes the fragile per-module lazy chunk boundary.
import { InboxModule } from './modules/inbox';
import { NgarkimModule } from './modules/ngarkim';
import { DorzimModule } from './modules/dorzim';
import { GatiModule } from './modules/gati';
import { DepoModule } from './modules/depo';
import { DeliveredModule } from './modules/dorezimet';

const TRANSPORT_BOARD_SEEN_KEY = 'transport_board_seen_v1';
const BOARD_FETCH_LIMIT = 80;
const BOARD_EVENT_REFRESH_DEBOUNCE_MS = 1800;
const BOARD_SUCCESS_REFRESH_COOLDOWN_MS = 45000;
const BOARD_HEARTBEAT_LOG_MS = 45000;
const BOARD_LONGTASK_MIN_MS = 120;
const BOARD_LONGTASK_LOG_COOLDOWN_MS = 8000;
const BOARD_INTERACTION_LOG_COOLDOWN_MS = 4000;

const BOARD_CALLER = 'transport/board';

function boardCurrentPath() {
  try { return String(window.location?.pathname || '/transport/board'); } catch { return '/transport/board'; }
}

function getBoardModuleDiagMeta(moduleLabel = '', moduleId = '', tabName = '', loadedModeOverride = '') {
  const params = (() => {
    try { return new URLSearchParams(window.location?.search || ''); } catch { return null; }
  })();
  const loadedMode = String(loadedModeOverride || params?.get('loaded') || '');
  const activeTab = String(tabName || params?.get('tab') || params?.get('view') || '');
  return {
    path: boardCurrentPath(),
    currentPath: boardCurrentPath(),
    moduleLabel: String(moduleLabel || ''),
    moduleId: String(moduleId || ''),
    importCaller: BOARD_CALLER,
    sourceLayer: 'transport_board',
    activeTab,
    loadedMode,
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    visibilityState: (() => { try { return String(document?.visibilityState || 'unknown'); } catch { return 'unknown'; } })(),
    hidden: (() => { try { return !!document?.hidden; } catch { return false; } })(),
  };
}

function BoardModuleFallback({ moduleLabel = '', moduleId = '', error = null, onRetry = null }) {
  return (
    <div style={{ marginTop: 14, borderRadius: 18, border: '1px solid rgba(255,99,132,0.32)', background: 'rgba(127,29,29,0.24)', padding: 14, color: '#fff' }}>
      <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 0.7, color: '#FCA5A5', textTransform: 'uppercase' }}>MODULI LOKAL NUK U NGARKUA</div>
      <div style={{ marginTop: 8, fontSize: 14, fontWeight: 800 }}>{String(moduleLabel || moduleId || 'Transport Board module')}</div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, wordBreak: 'break-word' }}>{String(error?.message || error || 'RENDER_FAILED')}</div>
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64, wordBreak: 'break-word' }}>{String(moduleId || '')}</div>
      {typeof onRetry === 'function' ? (
        <button
          type="button"
          onClick={onRetry}
          style={{ marginTop: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#fff', padding: '10px 12px', fontWeight: 900 }}
        >
          PROVO PËRSËRI
        </button>
      ) : null}
    </div>
  );
}

class BoardModuleBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error: error || new Error('BOARD_MODULE_ERROR') };
  }

  componentDidCatch(error, info) {
    try {
      recordRouteDiagEvent('transport_board_local_boundary_error', {
        ...getBoardModuleDiagMeta(this.props?.moduleLabel, this.props?.moduleId, this.props?.tabName, this.props?.loadedMode),
        error: {
          name: String(error?.name || ''),
          message: String(error?.message || error || ''),
          stack: String(error?.stack || ''),
          componentStack: String(info?.componentStack || ''),
        },
      });
    } catch {}
  }

  componentDidUpdate(prevProps) {
    if (prevProps?.resetKey !== this.props?.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return this.props.renderFallback ? this.props.renderFallback(this.state.error) : null;
    }
    return this.props.children;
  }
}

function BoardModuleProbe({ moduleLabel = '', moduleId = '', tabName = '', loadedMode = '' }) {
  useEffect(() => {
    try {
      recordRouteDiagEvent('transport_board_module_mount', {
        ...getBoardModuleDiagMeta(moduleLabel, moduleId, tabName, loadedMode),
      });
      const rafId = window.requestAnimationFrame(() => {
        try {
          recordRouteDiagEvent('transport_board_module_first_paint', {
            ...getBoardModuleDiagMeta(moduleLabel, moduleId, tabName, loadedMode),
          });
        } catch {}
      });
      const t = window.setTimeout(() => {
        try {
          recordRouteDiagEvent('transport_board_module_interactive', {
            ...getBoardModuleDiagMeta(moduleLabel, moduleId, tabName, loadedMode),
          });
        } catch {}
      }, 0);
      return () => {
        try {
          window.cancelAnimationFrame(rafId);
          window.clearTimeout(t);
          recordRouteDiagEvent('transport_board_module_unmount', {
            ...getBoardModuleDiagMeta(moduleLabel, moduleId, tabName, loadedMode),
          });
        } catch {}
      };
    } catch {
      return undefined;
    }
  }, [moduleId, moduleLabel]);
  return null;
}

function BoardModuleSlot({ Component, moduleLabel, moduleId, tabName = '', loadedMode = '', props }) {
  const [retryKey, setRetryKey] = useState(0);

  const handleRetry = useCallback(() => {
    try {
      recordRouteDiagEvent('transport_board_local_retry', {
        ...getBoardModuleDiagMeta(moduleLabel, moduleId, tabName, loadedMode),
      });
    } catch {}
    setRetryKey((value) => value + 1);
  }, [moduleId, moduleLabel, tabName, loadedMode]);

  return (
    <LocalErrorBoundary
      key={`boundary:${moduleLabel}:${retryKey}`}
      boundaryKind="module"
      routePath="/transport/board"
      routeName="TRANSPORT BOARD"
      moduleName={moduleLabel}
      moduleId={moduleId}
      componentName={moduleLabel}
      sourceLayer="transport_board_module"
      showHome={false}
      resetKeys={[retryKey, moduleLabel, moduleId, tabName, loadedMode]}
      onRetry={handleRetry}
    >
      <BoardModuleProbe key={`probe:${moduleLabel}:${retryKey}`} moduleLabel={moduleLabel} moduleId={moduleId} tabName={tabName} loadedMode={loadedMode} />
      <Component key={`eager:${moduleLabel}:${retryKey}`} {...(props || {})} />
    </LocalErrorBoundary>
  );
}

function readSeenTransportOrderIds() {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.localStorage.getItem(TRANSPORT_BOARD_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeenTransportOrderIds(nextMap = {}) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(TRANSPORT_BOARD_SEEN_KEY, JSON.stringify(nextMap && typeof nextMap === 'object' ? nextMap : {}));
  } catch {}
}


const BOARD_CACHE_WRITE_TIMERS = new Map();
let BOARD_LAST_VISIBLE_AT = 0;
let BOARD_WAKE_LISTENERS_BOUND = false;

function bindBoardWakeListeners() {
  try {
    if (typeof window === 'undefined' || BOARD_WAKE_LISTENERS_BOUND) return;
    BOARD_WAKE_LISTENERS_BOUND = true;
    const markVisible = () => {
      try {
        if (!document?.hidden) BOARD_LAST_VISIBLE_AT = Date.now();
      } catch {
        BOARD_LAST_VISIBLE_AT = Date.now();
      }
    };
    markVisible();
    window.addEventListener('focus', markVisible, { passive: true });
    document.addEventListener('visibilitychange', markVisible, { passive: true });
  } catch {}
}

function getBoardResumeSafeDelay(baseDelay = 2600) {
  try {
    const safeBase = Math.max(0, Number(baseDelay) || 0);
    if (typeof document === 'undefined') return safeBase;
    if (document.hidden) return Math.max(safeBase, 3200);
    const now = Date.now();
    const sinceVisible = BOARD_LAST_VISIBLE_AT > 0 ? (now - BOARD_LAST_VISIBLE_AT) : Number.POSITIVE_INFINITY;
    if (sinceVisible < 3200) {
      return Math.max(safeBase, 3200 - sinceVisible + 400);
    }
    return safeBase;
  } catch {
    return Math.max(0, Number(baseDelay) || 0);
  }
}

function scheduleCacheWrite(key, data, opts = {}) {
  try {
    if (typeof window === 'undefined' || !key) return;
    bindBoardWakeListeners();
    const safeList = Array.isArray(data) ? data : [];
    const delay = getBoardResumeSafeDelay(opts?.delay ?? 2600);
    const prevTimer = BOARD_CACHE_WRITE_TIMERS.get(key);
    if (prevTimer) clearTimeout(prevTimer);

    const runWrite = () => {
      try {
        const commit = () => {
          try {
            window.localStorage.setItem(key, JSON.stringify(safeList));
          } catch {}
        };
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(commit, { timeout: 2000 });
        } else {
          window.setTimeout(commit, 0);
        }
      } catch {}
    };

    const timerId = window.setTimeout(() => {
      BOARD_CACHE_WRITE_TIMERS.delete(key);
      runWrite();
    }, delay);

    BOARD_CACHE_WRITE_TIMERS.set(key, timerId);
  } catch {}
}

function getMasterCacheKey(sessionObj) {
  const role = String(sessionObj?.role || sessionObj?.user_role || sessionObj?.actor?.role || '').toUpperCase();
  const tid = String(sessionObj?.transport_id || sessionObj?.tid || '').trim();
  return `transport_master_cache_${canAccessTransportAdmin(role) ? 'ALL' : tid}`;
}

function getUnseenRowStyle(item) {
  if (!item?.__unseen) return null;
  return {
    border: '1px solid rgba(251,191,36,0.48)',
    background: 'linear-gradient(180deg, rgba(251,191,36,0.14), rgba(255,255,255,0.045))',
    boxShadow: '0 0 0 1px rgba(251,191,36,0.12), 0 18px 34px rgba(0,0,0,0.28)',
  };
}

function renderUnseenBadge(item) {
  if (!item?.__unseen) return null;
  return (
    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: 'rgba(251,191,36,0.18)', color: '#FBBF24', border: '1px solid rgba(251,191,36,0.28)', fontWeight: 900, letterSpacing: 0.7 }}>
      NEW
    </span>
  );
}

export default function TransportBoardPage() {
  return <TransportBoardInner />;
}

function TransportBoardInner() {
  useRouteAlive('transport_board_page');
  const router = useRouter();
  const sp = useSearchParams();
  const debug = sp?.get('debug') === '1';
  const quickQ = (sp?.get('q') || '').trim();

  const [session, setSession] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [items, setItems] = useState([]);
  const uiReadyMarkedRef = useRef(false);
  const loadGuardRef = useRef({
    seq: 0,
    timeoutId: null,
    deferId: null,
    refreshId: null,
    active: false,
    rerunRequested: false,
    lastStartAt: 0,
    lastSuccessAt: 0,
    abortController: null,
  });
  const boardDiagRef = useRef({
    mountedAt: 0,
    lastLoadStartAt: 0,
    lastLoadReason: '',
    lastLongTaskAt: 0,
    lastInteractionAt: 0,
    lastTabModeAt: 0,
  });

  const itemsRef = useRef([]);

  useEffect(() => {
    itemsRef.current = Array.isArray(items) ? items : [];
  }, [items]);

  // inbox | loaded | ready
  const initialTab = String(sp?.get('tab') || '').toLowerCase();
  const initialMode = String(sp?.get('mode') || '').toLowerCase();
  const [activeTab, setActiveTab] = useState(['inbox','loaded','ready','depo','delivered'].includes(initialTab) ? initialTab : 'inbox');

  // loaded tab: in = NGARKIM / PICKUP | out = DORËZIM (delivery)
  const [loadedMode, setLoadedMode] = useState(initialMode === 'out' ? 'out' : 'in');

  // shared selection + gps sort (used by loaded/dorzim modules)
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [gpsSort, setGpsSort] = useState(null);
  const [geo, setGeo] = useState(null);

  const [modal, setModal] = useState({ open: false, url: '' });
  const [smsModal, setSmsModal] = useState({ open: false, phone: '', text: '' });
  const smsOpenReqRef = useRef(0);
  const [transportUsers, setTransportUsers] = useState([]);
  const [seenIds, setSeenIds] = useState({});
  const [uiSwitchPending, startUiSwitchTransition] = useTransition();
  const tabSwitchGuardRef = useRef({ at: 0, key: '' });

  // RIPLAN panel (clock on truck icon)
  const [showRiplan, setShowRiplan] = useState(false);

  function startOfTodayIso() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  function getDeliveredTs(row) {
    return row?.data?.delivered_at || row?.updated_at || row?.created_at || null;
  }

  function isSameDayIso(ts) {
    if (!ts) return false;
    try {
      const a = new Date(ts);
      const b = new Date();
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    } catch {
      return false;
    }
  }
  const [riplanPick, setRiplanPick] = useState({ id: '', whenLocal: '', note: '', open: false });
  const [rackModal, setRackModal] = useState({ open: false, busy: false, error: '', order: null, selectedSlots: [], placeText: '', slotMap: {} });

  const boardDiagMeta = useCallback((extra = {}) => {
    const livePath = typeof window !== 'undefined' ? String(window.location?.pathname || '/transport/board') : '/transport/board';
    return {
      path: livePath,
      page: 'transport_board',
      tab: activeTab,
      mode: loadedMode,
      loading: !!loading,
      count: Array.isArray(items) ? items.length : 0,
      selectedCount: selectedIds?.size || 0,
      hasSession: !!session,
      role: String(session?.role || session?.user_role || ''),
      transportIdPresent: !!(session && (session.transport_id || session.transportId || session.tid || session.driver_id || session.driverId || session.pin || session.transport_pin)),
      loadError: String(loadError || ''),
      ...extra,
    };
  }, [activeTab, items, loadError, loadedMode, selectedIds, session]);

  const runUiSwitch = useCallback((key, apply) => {
    const cleanKey = String(key || '').trim();
    if (!cleanKey || typeof apply !== 'function') return;
    const now = Date.now();
    const prev = tabSwitchGuardRef.current || { at: 0, key: '' };
    if (prev.key === cleanKey && now - Number(prev.at || 0) < 160) return;
    tabSwitchGuardRef.current = { at: now, key: cleanKey };
    startUiSwitchTransition(() => {
      apply();
    });
  }, [startUiSwitchTransition]);

  const switchMainTab = useCallback((nextTab) => {
    const clean = String(nextTab || '').trim().toLowerCase();
    if (!clean || clean === activeTab) return;
    runUiSwitch(`tab:${clean}`, () => {
      setActiveTab(clean);
    });
  }, [activeTab, runUiSwitch]);

  const switchLoadedMode = useCallback((nextMode) => {
    const clean = String(nextMode || '').trim().toLowerCase() === 'out' ? 'out' : 'in';
    if (activeTab === 'loaded' && clean === loadedMode) return;
    runUiSwitch(`mode:${clean}`, () => {
      if (activeTab !== 'loaded') setActiveTab('loaded');
      setLoadedMode(clean);
    });
  }, [activeTab, loadedMode, runUiSwitch]);

  useEffect(() => {
    trackRender('TransportBoardPage');
  }, []);

  // IMPORTANT STABILITY PATCH:
  // Keep Transport Board diagnostics lightweight.
  // The previous mount effect re-bound multiple listeners, observers,
  // pointer logging, and a heartbeat interval whenever board state changed,
  // which could create runtime churn after ui_ready.
  // We intentionally keep board diagnostics out of the hot path here.

  useEffect(() => {
    if (loading) return;

    const visibleCount = Array.isArray(items) ? items.length : 0;
    const path = typeof window !== 'undefined' ? (window.location.pathname || '/transport/board') : '/transport/board';

    try {
      bootLog('ui_ready', {
        page: 'transport_board',
        path,
        count: visibleCount,
        tab: activeTab,
        mode: loadedMode,
        source: uiReadyMarkedRef.current ? 'state_repeat' : 'state_first',
      });
    } catch {}

    if (uiReadyMarkedRef.current) return;
    uiReadyMarkedRef.current = true;

    try {
      bootMarkReady({
        source: 'transport_board_page',
        page: 'transport_board',
        path,
        count: visibleCount,
        tab: activeTab,
        mode: loadedMode,
      });
    } catch {}
  }, [loading, items.length, activeTab, loadedMode]);

  // -----------------------------
  // Init session + GPS
  // -----------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let alive = true;

    try { if (alive) setSeenIds(readSeenTransportOrderIds()); } catch {}

    (async () => {
      try {
        const raw = getTransportSession();
        let next = raw;

        // CRITICAL FIX:
        // Dispatch assigns transport_orders.transport_id with tepiha_users.id (UUID).
        // Older driver sessions/login used PIN as transport_id, so Inbox could never match.
        // Auto-upgrade the dedicated transport session from PIN -> UUID by resolving the PIN.
        const maybePin = String(raw?.pin || raw?.transport_pin || '').trim();
        const maybeTid = String(raw?.transport_id || '').trim();
        const looksPinBased = !!maybePin && (!!maybeTid && maybeTid === maybePin);
        const looksMainScoped = /^MAIN_/i.test(maybeTid || '');
        const shouldResolveByPin = !!maybePin && (looksPinBased || looksMainScoped || !maybeTid || raw?.from_main_hybrid || raw?.is_hybrid_transport === true || String(raw?.role || '').toUpperCase() === 'TRANSPORT');

        if (shouldResolveByPin) {
          const res = await findUserByPin(maybePin);
          const user = res?.ok ? res.item : null;
          if (user?.id) {
            const isHybrid = user?.is_hybrid_transport === true;
            const nextRole = (String(user?.role || '').toUpperCase() === 'TRANSPORT' || isHybrid)
              ? 'TRANSPORT'
              : String(raw?.role || user?.role || 'TRANSPORT').toUpperCase();
            next = {
              ...raw,
              transport_id: String(user.id),
              transport_pin: maybePin,
              pin: maybePin,
              name: String(user.name || raw?.name || raw?.transport_name || 'TRANSPORT'),
              transport_name: String(user.name || raw?.transport_name || raw?.name || 'TRANSPORT'),
              user_id: String(user.id),
              is_hybrid_transport: isHybrid,
              role: nextRole,
              from: isHybrid ? 'board:hybrid-repair' : (looksMainScoped ? 'board:main-session-repair' : 'board:pin-repair'),
            };
            try {
              setTransportSession(next);
              window.__tepihaBootDebug?.logEvent?.('transport_session_repaired', {
                pin: maybePin,
                role: nextRole,
                isHybrid,
                previousTid: maybeTid || '',
                nextTid: String(user.id),
              });
            } catch {}
          }
        }

        if (alive) setSession(next || null);
      } catch {
        try { if (alive) setSession(getTransportSession()); } catch {}
      }
    })();

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 300000 }
      );
    }

    return () => { alive = false; };
  }, []);

  const markSeen = useCallback((ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const clean = Array.from(new Set(list.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!clean.length) return;
    setSeenIds((prev) => {
      const base = prev && typeof prev === 'object' ? prev : {};
      let changed = false;
      const next = { ...base };
      const now = new Date().toISOString();
      for (const id of clean) {
        if (!next[id]) {
          next[id] = now;
          changed = true;
        }
      }
      if (changed) writeSeenTransportOrderIds(next);
      return changed ? next : base;
    });
  }, []);

  // Home "QUICK SEARCH" -> /transport/board?q=T123
  // Default to READY tab so the driver finds “GATI” items fastest.
  useEffect(() => {
    if (!quickQ) return;
    setActiveTab('ready');
  }, [quickQ]);

  // After items load, auto-open the matching T-code (if present in the active tab data).
  useEffect(() => {
    if (!quickQ) return;
    const wanted = String(quickQ).toUpperCase();
    const hit = (items || []).find((it) => String(it?.client_tcode || '').toUpperCase() === wanted);
    if (hit?.id) {
      markSeen(hit.id);
      router.push(`/transport/item?id=${encodeURIComponent(hit.id)}`);
    }
  }, [quickQ, items, router, markSeen]);

  function deriveTid(sess) {
    const s = sess || {};
    // accept multiple legacy keys
    const raw =
      s.transport_id ??
      s.transportId ??
      s.tid ??
      s.driver_id ??
      s.driverId ??
      '';
    return String(raw || '').trim();
  }

  function rowOwnedBySession(row, sess) {
    const currentTid = deriveTid(sess);
    const currentPin = String(sess?.pin || sess?.transport_pin || '').trim();
    if (!currentTid && !currentPin) return false;
    const topTid = String(row?.transport_id || '').trim();
    const dataTid = String(row?.data?.transport_id || '').trim();
    const topPin = String(row?.transport_pin || row?.driver_pin || '').trim();
    const dataPin = String(row?.data?.transport_pin || row?.data?.driver_pin || '').trim();
    return (
      (!!currentTid && (topTid === currentTid || dataTid === currentTid)) ||
      (!!currentPin && (topPin === currentPin || dataPin === currentPin))
    );
  }

  function translateBoardError(err) {
    const raw = String(err?.message || err || '');
    const msg = raw.toLowerCase();
    if (!msg) return 'Gabim i panjohur.';
    if (msg.includes('transport_board_timeout') || msg.includes('supabase_timeout') || msg.includes('abort')) {
      return 'Serveri po vonon. Provo përsëri pas pak.';
    }
    if (msg.includes('load failed') || msg.includes('failed to fetch') || msg.includes('network')) {
      return 'Gabim rrjeti. Provo përsëri kur të kesh lidhje.';
    }
    if (msg.includes('uuid')) {
      return 'ID e porosisë ose e ciklit nuk është valide.';
    }
    return raw || 'Gabim i panjohur.';
  }

  const RIPLAN_REASON_CHIPS = ['S’ËSHTË NË SHTËPI', 'VJEN POSHTË', 'PRIT 10 MIN', 'THIRRE PËRSËRI', 'ADRESA GABIM'];

  const transportId = useMemo(() => deriveTid(session), [session]);

  function pickOrderLatLng(row) {
    const d = row?.data || {};
    const candidatesLat = [d?.gps_lat, d?.client?.gps_lat, d?.client?.gps?.lat, row?.gps_lat];
    const candidatesLng = [d?.gps_lng, d?.client?.gps_lng, d?.client?.gps?.lng, row?.gps_lng];
    const lat = candidatesLat.map((v) => Number(v)).find((v) => Number.isFinite(v));
    const lng = candidatesLng.map((v) => Number(v)).find((v) => Number.isFinite(v));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let idleId = 0;

    const run = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      (async () => {
        try {
          const res = await listUsers();
          const next = (res?.ok ? (res.items || []) : [])
            .filter((u) => String(u?.role || '').toUpperCase() === 'TRANSPORT' && u?.id)
            .map((u) => ({ id: String(u.id), pin: String(u.pin || ''), name: String(u.name || 'TRANSPORT') }));
          if (alive) setTransportUsers(next);
        } catch {
          if (alive) setTransportUsers([]);
        }
      })();
    };

    timer = window.setTimeout(() => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = 0;
          if (!alive) return;
          run();
        }, { timeout: 2200 });
        return;
      }
      run();
    }, 1400);

    return () => {
      alive = false;
      try { if (timer) clearTimeout(timer); } catch {}
      try {
        if (idleId && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
        else if (idleId) clearTimeout(idleId);
      } catch {}
    };
  }, []);

  // keep selection stable: clear only when switching main tab
  useEffect(() => {
    setSelectedIds(new Set());
    setGpsSort(null);
    if (activeTab !== 'loaded' && loadedMode !== 'in') {
      setLoadedMode('in');
    }
  }, [activeTab]);

  // inside loaded tab, clear selection only when the sub-mode changes
  useEffect(() => {
    if (activeTab !== 'loaded') return;
    setSelectedIds(new Set());
    setGpsSort(null);
  }, [activeTab, loadedMode]);

  // -----------------------------
  // Load rows
  // -----------------------------
  const load = useCallback(async (opts = {}) => {
    const force = opts?.force === true;
    const reason = String(opts?.reason || '');
    const now = Date.now();
    let showBlockingLoad = false;

    if (loadGuardRef.current.active) {
      loadGuardRef.current.rerunRequested = true;
      return;
    }

    const isResumeRefresh =
      reason === 'visibility-resume' ||
      reason === 'event-refresh' ||
      reason === 'queued-rerun';

    if (!force) {
      const sinceLastStart = now - Number(loadGuardRef.current.lastStartAt || 0);
      const sinceLastSuccess = now - Number(loadGuardRef.current.lastSuccessAt || 0);

      if (sinceLastStart >= 0 && sinceLastStart < 900) {
        loadGuardRef.current.rerunRequested = true;
        return;
      }

      if (isResumeRefresh && sinceLastSuccess >= 0 && sinceLastSuccess < BOARD_SUCCESS_REFRESH_COOLDOWN_MS) {
        return;
      }
    }

    try { loadGuardRef.current.abortController?.abort(); } catch {}
    const pageCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    loadGuardRef.current.abortController = pageCtrl;

    loadGuardRef.current.active = true;
    loadGuardRef.current.lastStartAt = now;
    boardDiagRef.current.lastLoadStartAt = now;
    boardDiagRef.current.lastLoadReason = reason || (force ? 'forced' : 'load');

    const seq = (loadGuardRef.current.seq || 0) + 1;
    try {
      bootLog('transport_board_load_start', boardDiagMeta({
        seq,
        reason: boardDiagRef.current.lastLoadReason,
        force: !!force,
      }));
    } catch {}
    loadGuardRef.current.seq = seq;
    if (loadGuardRef.current.timeoutId) {
      clearTimeout(loadGuardRef.current.timeoutId);
      loadGuardRef.current.timeoutId = null;
    }

    const finish = () => {
      if (loadGuardRef.current.seq === seq && loadGuardRef.current.timeoutId) {
        clearTimeout(loadGuardRef.current.timeoutId);
        loadGuardRef.current.timeoutId = null;
      }
      if (loadGuardRef.current.seq === seq && loadGuardRef.current.abortController === pageCtrl) {
        loadGuardRef.current.abortController = null;
      }
      if (loadGuardRef.current.seq === seq && showBlockingLoad) {
        setLoading(false);
      }
      loadGuardRef.current.active = false;
      const shouldRerun = loadGuardRef.current.rerunRequested;
      loadGuardRef.current.rerunRequested = false;
      if (shouldRerun) {
        const rerunDelay = getBoardResumeSafeDelay(1100);
        if (loadGuardRef.current.refreshId) clearTimeout(loadGuardRef.current.refreshId);
        loadGuardRef.current.refreshId = window.setTimeout(() => {
          loadGuardRef.current.refreshId = null;
          try { load({ force: true, reason: 'queued-rerun' }); } catch {}
        }, rerunDelay);
      }
    };

    setLoadError('');
    let cachedRows = [];
    let safeCachedRows = [];
    loadGuardRef.current.timeoutId = setTimeout(() => {
      if (loadGuardRef.current.seq !== seq) return;
      const stale = Array.isArray(itemsRef.current) ? itemsRef.current : [];
      if (!stale.length) {
        setLoadError('Ngarkimi po vonon. Prit pak ose provo REFRESH.');
        setLoading(false);
      }
    }, 12000);

    try {
      const sessionObj = getTransportSession() || session || {};
      const tid = deriveTid(sessionObj);
      const role = String(sessionObj?.role || sessionObj?.user_role || sessionObj?.user?.role || sessionObj?.actor?.role || '').toUpperCase();
      const isAdminLoad = canAccessTransportAdmin(role);
      if (!isAdminLoad && !tid) {
        setItems([]);
        setLoadError('');
        return;
      }

      const masterCacheKey = getMasterCacheKey(sessionObj);

      try {
        const cached = JSON.parse(localStorage.getItem(masterCacheKey) || 'null');
        if (Array.isArray(cached)) {
          safeCachedRows = isAdminLoad ? cached : cached.filter((row) => rowOwnedBySession(row, sessionObj));
          cachedRows = Array.isArray(safeCachedRows) ? safeCachedRows : [];
          if (safeCachedRows.length) {
            startTransition(() => {
              setItems(safeCachedRows);
            });
          }
        }
      } catch {}

      const liveRows = Array.isArray(itemsRef.current) ? itemsRef.current : [];
      showBlockingLoad = !(liveRows.length || safeCachedRows.length);
      if (showBlockingLoad) setLoading(true);
      else setLoading(false);

      const allStatuses = ['new','NEW','inbox','INBOX','pranim','PRANIM','dispatched','DISPATCHED','assigned','ASSIGNED','pickup','PICKUP','loaded','ngarkim','ngarkuar','delivery','dorzim','dorëzim','gati','ne_depo','riplan','RIPLAN'];

      async function fetchRest(includeAllForFallback = false) {
        const base = String(SUPABASE_URL || '').replace(/\/$/, '');
        if (!base) throw new Error('Missing SUPABASE_URL');
        const transportFilter = (!isAdminLoad && !includeAllForFallback) ? `&transport_id=eq.${encodeURIComponent(tid)}` : '';
        const url =
          base +
          '/rest/v1/transport_orders' +
          `?select=id,code_str,client_id,client_name,client_phone,client_tcode,visit_nr,status,created_at,updated_at,ready_at,data,transport_id` +
          transportFilter +
          `&status=in.(${encodeURIComponent(allStatuses.join(','))})` +
          `&order=updated_at.desc,created_at.desc` +
          `&limit=${BOARD_FETCH_LIMIT}`;

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
            },
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`REST ${res.status}: ${txt || res.statusText}`);
          }
          const json = await res.json();
          return Array.isArray(json) ? json : [];
        } finally {
          clearTimeout(t);
        }
      }

      let data = null;

      try {
        data = await listTransportOrders({
          signal: pageCtrl?.signal,
          select: 'id,code_str,client_id,client_name,client_phone,client_tcode,visit_nr,status,created_at,updated_at,ready_at,data,transport_id',
          in: { status: allStatuses },
          eq: !isAdminLoad ? { transport_id: tid } : {},
          orderBy: 'updated_at',
          secondaryOrderBy: 'created_at',
          secondaryAscending: false,
          ascending: false,
          limit: BOARD_FETCH_LIMIT,
          timeoutMs: 9000,
          timeoutLabel: 'TRANSPORT_BOARD_TIMEOUT',
        });
        if (!Array.isArray(data)) data = [];
      } catch (e1) {
        const msg = String(e1?.message || e1 || '');
        try {
          data = await fetchRest();
        } catch (e2) {
          throw new Error(msg || String(e2?.message || e2 || 'Load failed'));
        }
      }

      if (!isAdminLoad) {
        data = (Array.isArray(data) ? data : []).filter((row) => rowOwnedBySession(row, sessionObj));
        if (!data.length) {
          try {
            const fallbackRows = await fetchRest(true);
            data = (Array.isArray(fallbackRows) ? fallbackRows : []).filter((row) => rowOwnedBySession(row, sessionObj));
          } catch {}
        }
      }

      let deliveredToday = [];
      try {
        deliveredToday = await listTransportOrders({
          signal: pageCtrl?.signal,
          select: 'id,code_str,client_id,client_name,client_phone,client_tcode,visit_nr,status,created_at,updated_at,ready_at,data,transport_id',
          in: { status: ['done'] },
          eq: !isAdminLoad ? { transport_id: tid } : {},
          gte: { updated_at: startOfTodayIso() },
          orderBy: 'updated_at',
          ascending: false,
          limit: 80,
          timeoutMs: 7000,
          timeoutLabel: 'TRANSPORT_BOARD_DONE_TIMEOUT',
        });
      } catch {}
      if (!isAdminLoad) {
        deliveredToday = (Array.isArray(deliveredToday) ? deliveredToday : []).filter((row) => rowOwnedBySession(row, sessionObj));
      }
      const deliveredMap = new Map();
      (Array.isArray(deliveredToday) ? deliveredToday : []).forEach((row) => {
        if (row?.id) deliveredMap.set(String(row.id), row);
      });
      const activeList = Array.isArray(data) ? data : [];
      activeList.forEach((row) => {
        const st = String(row?.status || '').toLowerCase();
        if (st === 'done' && isSameDayIso(getDeliveredTs(row)) && row?.id) deliveredMap.set(String(row.id), row);
      });
      const list = [...activeList.filter((row) => String(row?.status || '').toLowerCase() !== 'done'), ...Array.from(deliveredMap.values())];
      startTransition(() => {
        setItems(list);
      });
      setLoadError('');
      loadGuardRef.current.lastSuccessAt = Date.now();
      try {
        bootLog('transport_board_load_ok', boardDiagMeta({
          seq,
          reason: boardDiagRef.current.lastLoadReason || reason || '',
          count: Array.isArray(list) ? list.length : 0,
          deliveredTodayCount: deliveredMap.size,
        }));
      } catch {}
      scheduleCacheWrite(masterCacheKey, list, { delay: 3200 });
    } catch (e) {
      if (pageCtrl?.signal?.aborted) return;
      console.error(e);
      const translatedError = translateBoardError(e);
      const staleRows = (() => {
        const currentRows = Array.isArray(itemsRef.current) ? itemsRef.current : [];
        if (currentRows.length) return currentRows;
        return Array.isArray(cachedRows) ? cachedRows : [];
      })();
      try {
        bootLog('transport_board_load_fail', boardDiagMeta({
          seq,
          reason: boardDiagRef.current.lastLoadReason || reason || '',
          message: String(translatedError || e?.message || e || 'load_failed'),
          staleCount: Array.isArray(staleRows) ? staleRows.length : 0,
        }));
      } catch {}
      if (Array.isArray(staleRows) && staleRows.length) {
        startTransition(() => {
          setItems(staleRows);
        });
        setLoadError('Serveri po vonon. Po shfaqen të dhënat e fundit të ruajtura.');
      } else {
        startTransition(() => {
          setItems([]);
        });
        setLoadError(translatedError);
      }
    } finally {
      finish();
    }
  }, [session]);

  useEffect(() => {
    let rafId = null;
    let warmupTimerId = null;
    if (loadGuardRef.current.deferId) {
      clearTimeout(loadGuardRef.current.deferId);
      loadGuardRef.current.deferId = null;
    }

    const queueLoad = () => {
      loadGuardRef.current.deferId = window.setTimeout(() => {
        try { load({ reason: 'initial-mount' }); } catch {}
      }, getBoardResumeSafeDelay(900));
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(() => {
        warmupTimerId = window.setTimeout(queueLoad, 50);
      });
    } else {
      warmupTimerId = setTimeout(queueLoad, 50);
    }

    return () => {
      if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      if (warmupTimerId) {
        clearTimeout(warmupTimerId);
      }
      if (loadGuardRef.current.timeoutId) {
        clearTimeout(loadGuardRef.current.timeoutId);
        loadGuardRef.current.timeoutId = null;
      }
      if (loadGuardRef.current.deferId) {
        clearTimeout(loadGuardRef.current.deferId);
        loadGuardRef.current.deferId = null;
      }
      try { loadGuardRef.current.abortController?.abort(); } catch {}
      loadGuardRef.current.abortController = null;
    };
  }, [load]);

  // allow modules to trigger refresh
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const h = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        loadGuardRef.current.rerunRequested = true;
        try { bootLog('transport_board_refresh_deferred_hidden', boardDiagMeta({ reason: 'transport:refresh' })); } catch {}
        return;
      }
      try { bootLog('transport_board_refresh_event', boardDiagMeta({ reason: 'transport:refresh' })); } catch {}
      if (loadGuardRef.current.refreshId) clearTimeout(loadGuardRef.current.refreshId);
      loadGuardRef.current.refreshId = window.setTimeout(() => {
        loadGuardRef.current.refreshId = null;
        try { load({ reason: 'event-refresh' }); } catch {}
      }, getBoardResumeSafeDelay(BOARD_EVENT_REFRESH_DEBOUNCE_MS));
    };
    window.addEventListener('transport:refresh', h);
    return () => {
      window.removeEventListener('transport:refresh', h);
      if (loadGuardRef.current.refreshId) {
        clearTimeout(loadGuardRef.current.refreshId);
        loadGuardRef.current.refreshId = null;
      }
    };
  }, [load]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.hidden) return;
      try { bootLog('transport_board_resume_visible', boardDiagMeta({ rerunRequested: !!loadGuardRef.current.rerunRequested })); } catch {}
      if (!loadGuardRef.current.rerunRequested) return;
      if (loadGuardRef.current.refreshId) clearTimeout(loadGuardRef.current.refreshId);
      loadGuardRef.current.refreshId = window.setTimeout(() => {
        loadGuardRef.current.refreshId = null;
        try { load({ force: true, reason: 'visibility-resume' }); } catch {}
      }, getBoardResumeSafeDelay(1200));
    };
    document.addEventListener('visibilitychange', onVisibility, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  // handle ?edit=
  const editId = sp?.get('edit') || '';

  useEffect(() => {
    if (!editId) return;
    router.replace(`/transport/pranimi?id=${encodeURIComponent(editId)}`);
  }, [editId, router]);

  function getSmsCount(order) {
    const count = Number(order?.data?.sms_count);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  async function incrementSmsStrike(order) {
    const orderId = String(order?.id || '').trim();
    if (!orderId) {
      return { ok: false, error: 'Mungon ID e porosisë.' };
    }

    let currentCount = getSmsCount(order);

    // KORRIGJIMI: Nëse porosia kthehet nga Depo (ka 3+ sms ose ka zgjedhur risjellje), fillojmë ciklin e ri nga 0!
    if (currentCount >= 3 || order?.data?.tracking_choice === 'resend') {
      currentCount = 0;
    }

    const newCount = currentCount + 1;
    const nextData = {
      ...(order?.data || {}),
      sms_count: newCount,
    };

    // Fshijmë zgjedhjen e tracking që të mos bëjë reset prapë, dhe nëse dështon, klienti të gjobitet prapë
    delete nextData.tracking_choice;
    delete nextData.depot_choice;

    const nextPatch = {
      data: nextData,
      updated_at: new Date().toISOString(),
    };

    if (newCount >= 3) {
      nextPatch.status = 'ne_depo';
    }

    try {
      await updateTransportOrderById(orderId, nextPatch);
    } catch (error) {
      return { ok: false, error: translateBoardError(error) };
    }

    setItems((prev) => {
      const next = Array.isArray(prev)
        ? prev
            .map((it) => (it.id === orderId ? { ...it, ...nextPatch, data: nextData } : it))
            .filter((it) => !(it.id === orderId && newCount >= 3))
        : prev;
      scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
      return next;
    });

    return { ok: true, newCount, movedToDepot: newCount >= 3, data: nextData };
  }

  async function handleOpenSms(order, actionType) {
    const requestId = Date.now() + Math.random();
    smsOpenReqRef.current = requestId;
    const smsRes = await incrementSmsStrike(order);
    if (smsOpenReqRef.current !== requestId) return;
    if (!smsRes?.ok) {
      alert('Gabim: ' + (smsRes?.error || 'SMS count nuk u ruajt.'));
      return;
    }

    if (smsRes?.movedToDepot) {
      alert('Mesazhi i 3-të! Porosia kaloi automatikisht në DEPO.');
      try { await load(); } catch {}
      return;
    }

    const enrichedOrder = {
      ...order,
      data: smsRes?.data || { ...(order?.data || {}), sms_count: smsRes?.newCount || getSmsCount(order) + 1 },
    };
    const phone = String(
      enrichedOrder?.client_phone ||
      enrichedOrder?.data?.client_phone ||
      enrichedOrder?.client?.phone ||
      enrichedOrder?.data?.client?.phone ||
      enrichedOrder?.phone ||
      ''
    ).trim();
    const text = buildSmartSmsText(enrichedOrder, actionType);
    setSmsModal({ open: true, phone, text });
  }

  function closeModal() {
    setModal({ open: false, url: '' });
    try { router.replace('/transport/board'); } catch {}
    load();
  }

  // DB status update helper for bulk actions
  async function updateTransportStatus(ids, nextStatus) {
    const uniq = Array.from(new Set(Array.isArray(ids) ? ids : [])).filter(Boolean);
    if (!uniq.length) return;

    const nowIso = new Date().toISOString();
    try {
      if (String(nextStatus || '').toLowerCase() === 'done') {
        for (const id of uniq) {
          const current = (items || []).find((x) => x.id === id) || {};
          const nextData = {
            ...((current?.data && typeof current.data === 'object') ? current.data : {}),
            delivered_at: nowIso,
            delivered_by_transport_id: String(transportId || ''),
          };
          await updateTransportOrderById(id, { status: nextStatus, updated_at: nowIso, data: nextData });
        }
      } else {
        await updateTransportOrdersByIds(uniq, { status: nextStatus, updated_at: nowIso });
      }
    } catch (error) {
      alert('Gabim: ' + translateBoardError(error));
      return;
    }

    // update UI locally
    setItems((prev) => {
      const next = Array.isArray(prev)
        ? prev.map((it) => {
            if (!uniq.includes(it.id)) return it;
            if (String(nextStatus || '').toLowerCase() === 'done') {
              return {
                ...it,
                status: nextStatus,
                updated_at: nowIso,
                data: { ...((it?.data && typeof it.data === 'object') ? it.data : {}), delivered_at: nowIso, delivered_by_transport_id: String(transportId || '') },
              };
            }
            return { ...it, status: nextStatus, updated_at: nowIso };
          })
        : prev;
      scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
      return next;
    });
  }

  async function updateRiplanMeta(orderId, whenIsoOrNull, note) {
    if (!orderId) return;
    const patch = {
      updated_at: new Date().toISOString(),
    };
    // columns exist in your DB (reschedule_at, reschedule_note)
    if (whenIsoOrNull === null) patch.reschedule_at = null;
    else if (whenIsoOrNull) patch.reschedule_at = whenIsoOrNull;
    if (typeof note === 'string') patch.reschedule_note = note;

    try {
      await updateTransportOrderById(orderId, patch);
    } catch (error) {
      alert('Gabim: ' + translateBoardError(error));
      return;
    }

    setItems((prev) => {
      const next = Array.isArray(prev)
        ? prev.map((it) => (it.id === orderId ? { ...it, ...patch } : it))
        : prev;
      scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
      return next;
    });
  }

  async function cancelTransportOrder(orderId) {
    if (!orderId) return;
    await updateTransportStatus([orderId], 'cancelled');
    try { load(); } catch {}
  }

  async function reassignTransportOrder(order, pinOrUser, pickedUser) {
    const orderId = String(order?.id || '').trim();
    const fallbackPin = typeof pinOrUser === 'string' ? String(pinOrUser || '').trim() : '';
    const rawUser = (pickedUser && typeof pickedUser === 'object') ? pickedUser : ((pinOrUser && typeof pinOrUser === 'object') ? pinOrUser : null);
    const resolvedUser = rawUser || transportUsers.find((u) => String(u?.pin || u?.user_pin || '').trim() === fallbackPin) || null;
    const nextTid = String(resolvedUser?.id || resolvedUser?.user_id || '').trim();
    const nextPin = String(resolvedUser?.pin || resolvedUser?.user_pin || fallbackPin || '').trim();
    const nextName = String(resolvedUser?.name || resolvedUser?.label || resolvedUser?.full_name || nextPin || 'TRANSPORT').trim();
    if (!orderId || !nextTid) return;

    const nowIso = new Date().toISOString();
    const currentStatus = String(order?.status || '').toLowerCase();
    const nextStatus = ['pickup', 'loaded', 'delivery', 'gati', 'ne_depo', 'riplan'].includes(currentStatus)
      ? currentStatus
      : 'assigned';

    const nextData = {
      ...(order?.data || {}),
      transport_id: nextTid,
      transport_user_id: nextTid,
      assigned_driver_id: nextTid,
      transport_pin: nextPin || null,
      transport_name: nextName,
      actor: nextName || nextPin,
      driver_name: nextName,
      driver_pin: nextPin || null,
      reassigned_at: nowIso,
      reassigned_by: String(session?.name || session?.transport_name || session?.pin || 'TRANSPORT'),
    };

    const patch = {
      status: nextStatus,
      data: nextData,
      updated_at: nowIso,
    };

    try {
      await updateTransportOrderById(orderId, patch);
    } catch (error) {
      alert('Gabim: ' + translateBoardError(error));
      return;
    }

    setItems((prev) => {
      const next = Array.isArray(prev)
        ? prev.map((it) => (it.id === orderId
          ? { ...it, ...patch, actor: nextData.actor, driver_name: nextData.driver_name }
          : it))
        : prev;
      scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
      return next;
    });

    try { load(); } catch {}
  }

  async function saveInboxGps(order) {
    const orderId = String(order?.id || '').trim();
    if (!orderId) return { ok: false, error: 'Mungon ID e porosisë.' };
    if (!navigator?.geolocation) return { ok: false, error: 'GPS nuk mbështetet në këtë pajisje.' };

    const coords = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    }).catch((err) => ({ error: err }));

    if (coords?.error) {
      return { ok: false, error: 'Nuk u mor lokacioni. Lejo GPS dhe provo përsëri.' };
    }

    const lat = Number(coords?.lat);
    const lng = Number(coords?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'Koordinatat nuk janë valide.' };

    const nextData = {
      ...(order?.data || {}),
      gps_lat: lat,
      gps_lng: lng,
      client: {
        ...((order?.data || {}).client || {}),
        gps_lat: lat,
        gps_lng: lng,
        gps: { lat, lng },
      },
    };

    try {
      await updateTransportOrderById(orderId, { data: nextData, updated_at: new Date().toISOString() });
    } catch (orderErr) {
      return { ok: false, error: translateBoardError(orderErr) };
    }

    const clientId = String(order?.client_id || order?.data?.client_id || order?.data?.client?.id || '').trim();
    const phoneDigits = String(order?.client_phone || order?.data?.client?.phone || '').replace(/\D+/g, '');
    let clientErr = null;

    const clientPatch = sanitizeTransportClientPayload({ gps_lat: lat, gps_lng: lng, phone_digits: phoneDigits }, { mode: 'patch' });

    if (clientId) {
      const res = await supabase
        .from('transport_clients')
        .update(clientPatch)
        .eq('id', clientId);
      clientErr = res.error || null;
    } else if (phoneDigits) {
      const res = await supabase
        .from('transport_clients')
        .update(clientPatch)
        .eq('phone_digits', Number(phoneDigits));
      clientErr = res.error || null;
    }

    if (clientErr) {
      console.warn('transport_clients GPS update failed:', clientErr);
    }

    setItems((prev) => {
      const next = Array.isArray(prev)
        ? prev.map((it) => (it.id === orderId ? { ...it, data: nextData, updated_at: new Date().toISOString() } : it))
        : prev;
      scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
      return next;
    });

    return { ok: true, lat, lng };
  }

  // -----------------------------
  // Counts (header dots)
  // -----------------------------
  const counts = useMemo(() => {
    let inbox = 0, loaded = 0, ready = 0, depo = 0, delivered = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (['new','inbox','pranim','dispatched','assigned'].includes(st)) inbox++;
      else if (st === 'pickup' || st === 'loaded' || st === 'delivery') loaded++;
      else if (st === 'gati') ready++;
      else if (st === 'ne_depo') depo++;
      else if (st === 'done' && isSameDayIso(getDeliveredTs(x))) delivered++;
    });
    return { inbox, loaded, ready, depo, delivered };
  }, [items]);

  const subCounts = useMemo(() => {
    let inCount = 0, outCount = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (st === 'pickup' || st === 'loaded') inCount++;
      else if (st === 'delivery') outCount++;
    });
    return { in: inCount, out: outCount };
  }, [items]);

  // -----------------------------
  // Filter per tab/mode
  // -----------------------------
  const deferredItems = useDeferredValue(items);

  const viewItems = useMemo(() => {
    const filtered = (deferredItems || []).filter((r) => {
      const st = String(r?.status || '').toLowerCase();
      if (activeTab === 'inbox') return ['new','inbox','pranim','dispatched','assigned'].includes(st);
      if (activeTab === 'loaded') return loadedMode === 'in' ? (st === 'pickup' || st === 'loaded') : st === 'delivery';
      if (activeTab === 'ready') return st === 'gati';
      if (activeTab === 'depo') return st === 'ne_depo' || st === 'riplan';
      if (activeTab === 'delivered') return st === 'done' && isSameDayIso(getDeliveredTs(r));
      return false;
    });

    return filtered
      .map((row) => {
        const id = String(row?.id || '').trim();
        return {
          ...row,
          __unseen: !!id && !seenIds?.[id],
        };
      })
      .sort((a, b) => {
        const au = a?.__unseen ? 1 : 0;
        const bu = b?.__unseen ? 1 : 0;
        if (au !== bu) return bu - au;
        return 0;
      });
  }, [deferredItems, activeTab, loadedMode, seenIds]);

  const isAdmin = useMemo(() => {
    const role = String(session?.role || session?.user_role || session?.user?.role || session?.actor?.role || '').toUpperCase();
    return canAccessTransportAdmin(role);
  }, [session]);

  const riplanItems = useMemo(() => {
    const tid = String(transportId || '').trim();
    return (items || []).filter((r) => {
      const st = String(r?.status || '').toLowerCase();
      if (st !== 'riplan') return false;
      if (isAdmin) return true;
      return String(r?.transport_id || '').trim() === tid;
    });
  }, [items, transportId, isAdmin]);

  const riplanCount = riplanItems.length;

  function toLocalInputValue(dateIsoOrNull) {
    if (!dateIsoOrNull) return '';
    const d = new Date(dateIsoOrNull);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function addMinutesToNow(mins) {
    const d = new Date();
    d.setMinutes(d.getMinutes() + mins);
    return toLocalInputValue(d.toISOString());
  }

  function setTodayAt(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return toLocalInputValue(d.toISOString());
  }

  function setTomorrowAt(h, m) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return toLocalInputValue(d.toISOString());
  }

  async function saveRiplan() {
    const { id, whenLocal, note } = riplanPick;
    if (!id) return;
    const whenIso = whenLocal ? new Date(whenLocal).toISOString() : null;
    await updateRiplanMeta(id, whenIso, note || '');
    try { load(); } catch {}
  }

  async function openRackPicker(order) {
    if (!order?.id) return;
    try {
      let text = String(order?.data?.ready_note_text || order?.data?.ready_note || order?.data?.ready_location || '');
      // Pastrojmë tekstin nga "📍 [A1]" që të mos futet dysh te inputi
      text = text.replace(/^📍\s*(\[[^\]]+\]\s*)?/, '').trim();

      setRackModal((p) => ({
        ...p,
        open: true,
        busy: true,
        error: '',
        order,
        selectedSlots: normalizeRackSlots(order?.data?.ready_slots || []),
        placeText: text,
        slotMap: {}
      }));
      const map = await fetchRackMapFromDb();
      setRackModal((p) => ({ ...p, busy: false, slotMap: map }));
    } catch (e) {
      setRackModal((p) => ({ ...p, busy: false, error: 'Nuk u ngarkuan raftat. Provo përsëri.' }));
    }
  }

  function closeRackPicker() {
    setRackModal({ open: false, busy: false, error: '', order: null, selectedSlots: [], placeText: '', slotMap: {} });
  }

  function toggleRackSlot(slot) {
    setRackModal((p) => {
      const arr = Array.isArray(p.selectedSlots) ? p.selectedSlots : [];
      return {
        ...p,
        selectedSlots: arr.includes(slot) ? arr.filter((x) => x !== slot) : [...arr, slot],
      };
    });
  }

  async function saveRackPicker() {
    const order = rackModal.order;
    if (!order?.id) return;
    
    // Marrim direkt array-n nga state, pa e filtruar me funksione që e prishin
    const selectedSlots = Array.isArray(rackModal.selectedSlots) ? rackModal.selectedSlots : [];
    const txt = String(rackModal.placeText || '').trim();
    
    const data = {
      ...(order?.data || {}),
      ready_slots: selectedSlots,
      ready_note_text: txt,
      ready_note: selectedSlots.length ? `📍 [${selectedSlots.join(', ')}] ${txt}`.trim() : (txt ? `📍 ${txt}` : ''),
      ready_location: selectedSlots.length ? selectedSlots.join(', ') : txt,
    };
    
    try {
      setRackModal((p) => ({ ...p, busy: true, error: '' }));
      await updateTransportOrderById(order.id, { data, updated_at: new Date().toISOString() });
      
      // UPDATE UI DIREKT (Pa thirrur load() që kthen cache-in e vjetër)
      setItems((prev) => {
        const next = Array.isArray(prev) ? prev.map((it) => (it.id === order.id ? { ...it, data, updated_at: new Date().toISOString() } : it)) : prev;
        scheduleCacheWrite(getMasterCacheKey(session || getTransportSession() || {}), next, { delay: 2600 });
        return next;
      });
      
      closeRackPicker();
    } catch (e) {
      setRackModal((p) => ({ ...p, busy: false, error: translateBoardError(e) }));
    }
  }

  const hasVisibleItems = Array.isArray(items) && items.length > 0;

  return (
    <div style={ui.page}>
      {/* HEADER */}
      <div style={ui.header}>
        <div style={ui.headerTop}>
          <button
            type="button"
            onClick={() => setShowRiplan(true)}
            title="RIPLAN"
            style={{
              ...ui.avatarProfile,
              border: '0',
              cursor: 'pointer',
              position: 'relative',
              background: 'transparent',
            }}
          >
            🚚
            {riplanCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  background: 'rgba(255, 180, 0, 0.95)',
                  color: '#111',
                  borderRadius: 999,
                  padding: '2px 6px',
                  fontSize: 12,
                  fontWeight: 900,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
                }}
              >
                ⏰
              </span>
            )}
          </button>
          {activeTab !== 'ready' && (
            <button
              style={ui.btnCompose}
              onClick={() => router.push('/transport/pranimi?new=1&new_status=pickup&return_tab=loaded&return_mode=in')}
            >
              ✎
            </button>
          )}
        </div>

        <h1 style={ui.title}>
          {activeTab === 'ready' ? 'Dërgesat' : (activeTab === 'loaded' ? 'Pikapi' : (activeTab === 'depo' ? 'Depo' : (activeTab === 'delivered' ? 'Dorëzimet' : 'Inbox')))}
        </h1>

        <div style={ui.tabsContainer}>
          <button style={{ ...(activeTab === 'inbox' ? ui.tabActive : ui.tab), opacity: uiSwitchPending ? 0.82 : 1 }} onClick={() => switchMainTab('inbox')} disabled={uiSwitchPending}>
            Të Reja {counts.inbox > 0 && <span style={ui.dot} />}
          </button>
          <button style={{ ...(activeTab === 'loaded' ? ui.tabActive : ui.tab), opacity: uiSwitchPending ? 0.82 : 1 }} onClick={() => switchMainTab('loaded')} disabled={uiSwitchPending}>
            Pikapi 🚐 {counts.loaded > 0 && <span style={ui.dot} />}
          </button>
          <button style={{ ...(activeTab === 'ready' ? ui.tabActive : ui.tab), opacity: uiSwitchPending ? 0.82 : 1 }} onClick={() => switchMainTab('ready')} disabled={uiSwitchPending}>
            Gati {counts.ready > 0 && <span style={ui.dot} />}
          </button>
          <button style={{ ...(activeTab === 'depo' ? ui.tabActive : ui.tab), opacity: uiSwitchPending ? 0.82 : 1 }} onClick={() => switchMainTab('depo')} disabled={uiSwitchPending}>
            Depo 🏢 {counts.depo > 0 && <span style={ui.dot} />}
          </button>
          <button style={{ ...(activeTab === 'delivered' ? ui.tabActive : ui.tab), opacity: uiSwitchPending ? 0.82 : 1 }} onClick={() => switchMainTab('delivered')} disabled={uiSwitchPending}>
            Dorëzimet 📋 {counts.delivered > 0 && <span style={ui.dot} />}
          </button>
        </div>
      </div>

      {/* DEBUG (hidden by default): show session transport id + load errors */}
      {debug && (
        <div style={{ padding: '0 16px', marginTop: 10 }}>
          <div
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              padding: '10px 12px',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 14,
            }}
          >
            TID: {transportId || '—'}
          </div>

          {!!loadError && (
            <div
              style={{
                marginTop: 10,
                border: '1px solid rgba(255,60,60,0.8)',
                background: 'rgba(255,0,0,0.08)',
                borderRadius: 12,
                padding: '10px 12px',
                color: 'rgba(255,120,120,0.95)',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              ERROR: {loadError}
            </div>
          )}
        </div>
      )}

      {loadError && !loading && hasVisibleItems && (
        <div style={{ padding: '12px 16px 0 16px' }}>
          <div
            style={{
              border: '1px solid rgba(245,158,11,0.45)',
              background: 'rgba(245,158,11,0.10)',
              borderRadius: 14,
              padding: 14,
              color: 'rgba(255,240,200,0.96)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 6 }}>BOARD-I PO PËRDOR TË DHËNAT E FUNDIT</div>
            <div style={{ fontSize: 14, lineHeight: 1.45 }}>{loadError}</div>
            <button
              type="button"
              onClick={() => !loading && load({ force: true, reason: 'manual-refresh' })}
              style={{
                marginTop: 12,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                borderRadius: 12,
                padding: '10px 14px',
                fontWeight: 900,
                cursor: 'pointer',
                opacity: loading ? 0.65 : 1,
              }}
              disabled={loading}
            >
              {loading ? 'DUKE NGARKUAR...' : 'REFRESH'}
            </button>
          </div>
        </div>
      )}

      {loadError && !loading && !hasVisibleItems && (
        <div style={{ padding: '12px 16px 0 16px' }}>
          <div
            style={{
              border: '1px solid rgba(255,90,90,0.55)',
              background: 'rgba(255,0,0,0.10)',
              borderRadius: 14,
              padding: 14,
              color: 'rgba(255,220,220,0.96)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 6 }}>NUK U NGARKUA BOARD-I</div>
            <div style={{ fontSize: 14, lineHeight: 1.45 }}>{loadError}</div>
            <button
              type="button"
              onClick={() => !loading && load({ force: true, reason: 'manual-refresh' })}
              style={{
                marginTop: 12,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                borderRadius: 12,
                padding: '10px 14px',
                fontWeight: 900,
                cursor: 'pointer',
                opacity: loading ? 0.65 : 1,
              }}
              disabled={loading}
            >
              {loading ? 'DUKE NGARKUAR...' : 'REFRESH'}
            </button>
          </div>
        </div>
      )}

      {/* SUB-TABS for loaded */}
      {activeTab === 'loaded' && (
        <div
          style={{
            ...ui.subTabsWrap,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <button
            style={{
              ...(loadedMode === 'in' ? ui.subTabActive : ui.subTab),
              flex: 1,
            }}
            onClick={() => switchLoadedMode('in')}
            disabled={uiSwitchPending}
          >
            🏠 PËR BAZË ({subCounts.in})
          </button>

          <div
            style={{
              minWidth: 'fit-content',
              padding: '8px 12px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.86)',
              fontSize: 12,
              fontWeight: 900,
              letterSpacing: 0.5,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            SELECT ALL
          </div>

          <button
            style={{
              ...(loadedMode === 'out' ? ui.subTabActive : ui.subTab),
              flex: 1,
            }}
            onClick={() => switchLoadedMode('out')}
            disabled={uiSwitchPending}
          >
            🚚 PËR KLIENT ({subCounts.out})
          </button>
        </div>
      )}

      {/* VIEW (MODULES) */}
      {activeTab === 'inbox' && (
        <BoardModuleSlot
          Component={InboxModule}
          moduleLabel="transport-board:InboxModule"
          moduleId="@/app/transport/board/modules/inbox.jsx"
          tabName="inbox"
          props={{
            items: viewItems,
            loading,
            actorRole: String(session?.role || session?.user_role || session?.user?.role || session?.actor?.role || ''),
            transportUsers,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onAssign: reassignTransportOrder,
            onCancel: cancelTransportOrder,
            onSaveGps: saveInboxGps,
            getOrderLatLng: pickOrderLatLng,
            onOpenSms: handleOpenSms,
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      {activeTab === 'loaded' && loadedMode === 'in' && (
        <BoardModuleSlot
          Component={NgarkimModule}
          moduleLabel="transport-board:NgarkimModule"
          moduleId="@/app/transport/board/modules/ngarkim.jsx"
          tabName="loaded"
          loadedMode="in"
          props={{
            items: viewItems,
            loading,
            selectedIds,
            setSelectedIds,
            gpsSort,
            setGpsSort,
            onBulkStatus: updateTransportStatus,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onOpenSms: handleOpenSms,
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      {activeTab === 'loaded' && loadedMode === 'out' && (
        <BoardModuleSlot
          Component={DorzimModule}
          moduleLabel="transport-board:DorzimModule"
          moduleId="@/app/transport/board/modules/dorzim.jsx"
          tabName="loaded"
          loadedMode="out"
          props={{
            items: viewItems,
            loading,
            selectedIds,
            setSelectedIds,
            gpsSort,
            setGpsSort,
            onBulkStatus: updateTransportStatus,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onOpenSms: handleOpenSms,
            onOpenRack: openRackPicker,
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      {activeTab === 'ready' && (
        <BoardModuleSlot
          Component={GatiModule}
          moduleLabel="transport-board:GatiModule"
          moduleId="@/app/transport/board/modules/gati.jsx"
          tabName="ready"
          props={{
            items: viewItems,
            loading,
            geo,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onBulkStatus: updateTransportStatus,
            onOpenSms: handleOpenSms,
            onGoDorzo: () => switchLoadedMode('out'),
            getSmsCount,
            onOpenRack: openRackPicker,
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      {activeTab === 'depo' && (
        <BoardModuleSlot
          Component={DepoModule}
          moduleLabel="transport-board:DepoModule"
          moduleId="@/app/transport/board/modules/depo.jsx"
          tabName="depo"
          props={{
            items: viewItems,
            loading,
            geo,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onBulkStatus: updateTransportStatus,
            onOpenSms: handleOpenSms,
            onOpenRack: openRackPicker,
            onGoGati: () => switchMainTab('ready'),
            onGoDorzo: () => switchLoadedMode('out'),
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      {activeTab === 'delivered' && (
        <BoardModuleSlot
          Component={DeliveredModule}
          moduleLabel="transport-board:DeliveredModule"
          moduleId="@/app/transport/board/modules/dorezimet.jsx"
          tabName="delivered"
          props={{
            items: viewItems,
            loading,
            onOpenModal: (url) => { const match = String(url || '').match(/[?&]id=([^&]+)/); if (match?.[1]) markSeen(decodeURIComponent(match[1])); router.push(url); },
            onOpenSms: handleOpenSms,
            onMarkSeen: markSeen,
            getUnseenRowStyle,
            renderUnseenBadge,
          }}
        />
      )}

      <LocalErrorBoundary boundaryKind="panel" routePath="/transport/board" routeName="TRANSPORT BOARD" moduleName="SmartSmsModal" componentName="SmartSmsModal" sourceLayer="transport_board_panel" showHome={false}>
        <SmartSmsModal
          isOpen={smsModal.open}
        onClose={() => {
          smsOpenReqRef.current = Date.now() + Math.random();
          setSmsModal({ ...smsModal, open: false });
        }}
        phone={smsModal.phone}
          messageText={smsModal.text}
        />
      </LocalErrorBoundary>

      <LocalErrorBoundary boundaryKind="panel" routePath="/transport/board" routeName="TRANSPORT BOARD" moduleName="RackLocationModal" componentName="RackLocationModal" sourceLayer="transport_board_panel" showHome={false}>
        <RackLocationModal
          open={rackModal.open}
        busy={rackModal.busy}
        orderCode={String(rackModal.order?.client_tcode || rackModal.order?.data?.client_tcode || '').trim()}
        currentOrderId={rackModal.order?.id || ''}
        subtitle="Zgjidh raftin/depon për këtë porosi"
        slotMap={rackModal.slotMap}
        selectedSlots={rackModal.selectedSlots}
        placeText={rackModal.placeText}
        onTextChange={(v) => setRackModal((p) => ({ ...p, placeText: v }))}
        onToggleSlot={toggleRackSlot}
        onClose={closeRackPicker}
        onClear={() => setRackModal((p) => ({ ...p, selectedSlots: [], placeText: '' }))}
        onSave={saveRackPicker}
          error={rackModal.error}
        />
      </LocalErrorBoundary>

      {/* MODAL FULL SCREEN */}
      {modal.open && (
        <div style={ui.modalOverlay}>
          <style jsx>{`@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
          <div style={ui.modalShell}>
            <div style={ui.modalTop}>
              <button style={ui.btnCloseModal} onClick={closeModal}>✕ Mbylle</button>
              <span style={{ fontWeight: 600 }}>Detajet</span>
              <div style={{ width: 60 }} />
            </div>
            <iframe src={modal.url} style={ui.iframe} title="Order Details" />
          </div>
        </div>
      )}

      {/* RIPLAN PANEL (from truck icon) */}
      {showRiplan && (
        <div style={ui.modalOverlay}>
          <style jsx>{`
            @keyframes slideUpRiplan { from { transform: translateY(100%); } to { transform: translateY(0); } }
          `}</style>
          <div style={{
            ...ui.modalShell,
            animation: 'slideUpRiplan .22s ease-out',
          }}>
            <div style={ui.modalTop}>
              <button
                style={ui.btnCloseModal}
                onClick={() => {
                  setShowRiplan(false);
                  setRiplanPick({ id: '', whenLocal: '', note: '', open: false });
                }}
              >
                ✕ Mbylle
              </button>
              <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>RIPLANIFIKIM</span>
              <div style={{ width: 60 }} />
            </div>

            <div style={{ padding: 14, overflow: 'auto' }}>
              {riplanItems.length === 0 ? (
                <div style={{
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 12,
                  padding: 14,
                  color: 'rgba(255,255,255,0.85)',
                  fontWeight: 700,
                }}>
                  S’ka asnjë porosi në RIPLAN.
                </div>
              ) : (
                <>
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginBottom: 10,
                  }}>
                    <span style={{
                      padding: '6px 10px',
                      borderRadius: 999,
                      background: 'rgba(255,255,255,0.08)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      fontSize: 12,
                      fontWeight: 800,
                      color: 'rgba(255,255,255,0.9)',
                    }}>TOTAL: {riplanItems.length}</span>
                    {!isAdmin && (
                      <span style={{
                        padding: '6px 10px',
                        borderRadius: 999,
                        background: 'rgba(0,200,255,0.08)',
                        border: '1px solid rgba(0,200,255,0.18)',
                        fontSize: 12,
                        fontWeight: 800,
                        color: 'rgba(220,250,255,0.95)',
                      }}>VETËM TË MIAT</span>
                    )}
                  </div>

                  {riplanItems.map((it) => {
                    const picked = riplanPick.id === it.id;
                    const clientName = String(it?.client_name || it?.data?.client?.name || '').trim() || '—';
                    const code = String(it?.code_str || it?.client_tcode || '').trim();
                    const phone = String(it?.client_phone || it?.data?.client?.phone || '').trim();
                    const addr = String(it?.data?.client?.address || '').trim();
                    const whenLocal = picked ? riplanPick.whenLocal : toLocalInputValue(it?.reschedule_at || it?.data?.reschedule_at);
                    const note = picked ? riplanPick.note : String(it?.reschedule_note || it?.data?.reschedule_note || '').trim();
                    const isDelivery = !!(it.ready_at || it?.data?.ready_at);
                    const intentLabel = isDelivery ? '📦 PËR DORËZIM' : '🚐 PËR NGARKIM';
                    const intentColor = isDelivery ? '#34C759' : '#0A84FF';
                    const intentBg = isDelivery ? 'rgba(52,199,89,0.15)' : 'rgba(10,132,255,0.15)';

                    return (
                      <div key={it.id} style={{
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 14,
                        padding: 12,
                        marginBottom: 10,
                        background: 'rgba(0,0,0,0.18)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <div style={{ fontWeight: 1000, letterSpacing: 0.4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                              <span>{code} • {clientName}</span>
                              <span style={{ fontSize: 10, padding: '4px 8px', background: intentBg, color: intentColor, borderRadius: 8, fontWeight: 900 }}>
                                {intentLabel}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>{phone}{addr ? ` • ${addr}` : ''}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setRiplanPick({
                              id: it.id,
                              whenLocal: whenLocal || '',
                              note: note || '',
                              open: false,
                            })}
                            style={{
                              border: '1px solid rgba(255,255,255,0.16)',
                              background: picked ? 'rgba(255,180,0,0.18)' : 'rgba(255,255,255,0.06)',
                              color: 'rgba(255,255,255,0.95)',
                              borderRadius: 12,
                              padding: '8px 10px',
                              fontWeight: 900,
                              cursor: 'pointer',
                              minWidth: 90,
                            }}
                          >
                            {picked ? (riplanPick.open ? 'RIPLAN AKTIV' : 'ZGJEDHUR') : 'ZGJIDH'}
                          </button>
                        </div>

                        {picked && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                              <button
                                type="button"
                                onClick={() => setRiplanPick((p) => ({ ...p, open: !p.open }))}
                                style={{
                                  border: '1px solid rgba(255,255,255,0.16)',
                                  background: riplanPick.open ? 'rgba(255,180,0,0.18)' : 'rgba(255,255,255,0.06)',
                                  color: 'rgba(255,255,255,0.95)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                {riplanPick.open ? 'MBYLLE OPSIONET E RIPLANIT' : 'HAP OPSIONET E RIPLANIT'}
                              </button>
                            </div>

                            {!riplanPick.open ? (
                              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)', lineHeight: 1.45 }}>
                                Opsionet e riplanifikimit hapen vetëm pasi të klikosh "HAP OPSIONET E RIPLANIT".
                              </div>
                            ) : (
                              <>
                            <div style={{
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 8,
                            }}>
                              {[
                                { label: '+30m', val: addMinutesToNow(30) },
                                { label: '+1h', val: addMinutesToNow(60) },
                                { label: 'SOT 18:00', val: setTodayAt(18, 0) },
                                { label: 'NESËR 09:00', val: setTomorrowAt(9, 0) },
                              ].map((c) => (
                                <button
                                  key={c.label}
                                  type="button"
                                  onClick={() => setRiplanPick((p) => ({ ...p, whenLocal: c.val }))}
                                  style={{
                                    border: '1px solid rgba(255,255,255,0.14)',
                                    background: 'rgba(255,255,255,0.06)',
                                    color: 'rgba(255,255,255,0.95)',
                                    borderRadius: 999,
                                    padding: '8px 12px',
                                    fontWeight: 900,
                                    cursor: 'pointer',
                                  }}
                                >
                                  {c.label}
                                </button>
                              ))}
                            </div>

                            <div style={{ marginTop: 10, marginBottom: 8 }}>
                              <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>
                                ARSYE TË SHPEJTA
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {RIPLAN_REASON_CHIPS.map((reason) => (
                                  <button
                                    key={reason}
                                    type="button"
                                    onClick={() => setRiplanPick((p) => ({
                                      ...p,
                                      note: p.note ? (p.note.toLowerCase().includes(reason.toLowerCase()) ? p.note : `${p.note} • ${reason}`) : reason,
                                    }))}
                                    style={{
                                      border: '1px solid rgba(255,255,255,0.14)',
                                      background: 'rgba(255,255,255,0.06)',
                                      color: 'rgba(255,255,255,0.95)',
                                      borderRadius: 999,
                                      padding: '8px 12px',
                                      fontWeight: 900,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    {reason}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                              <div style={{ flex: '1 1 220px', minWidth: 220 }}>
                                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>
                                  KOHA / DATA
                                </div>
                                <input
                                  type="datetime-local"
                                  value={riplanPick.whenLocal}
                                  onChange={(e) => setRiplanPick((p) => ({ ...p, whenLocal: e.target.value }))}
                                  style={{
                                    width: '100%',
                                    background: 'rgba(0,0,0,0.25)',
                                    border: '1px solid rgba(255,255,255,0.16)',
                                    borderRadius: 12,
                                    padding: '10px 12px',
                                    color: 'rgba(255,255,255,0.95)',
                                    fontWeight: 800,
                                  }}
                                />
                              </div>

                              <div style={{ flex: '1 1 220px', minWidth: 220 }}>
                                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>
                                  SHËNIM
                                </div>
                                <input
                                  type="text"
                                  value={riplanPick.note}
                                  onChange={(e) => setRiplanPick((p) => ({ ...p, note: e.target.value }))}
                                  placeholder="p.sh. klienti s’ishte n’shpi"
                                  style={{
                                    width: '100%',
                                    background: 'rgba(0,0,0,0.25)',
                                    border: '1px solid rgba(255,255,255,0.16)',
                                    borderRadius: 12,
                                    padding: '10px 12px',
                                    color: 'rgba(255,255,255,0.95)',
                                    fontWeight: 800,
                                  }}
                                />
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                              <button
                                type="button"
                                onClick={saveRiplan}
                                style={{
                                  border: '1px solid rgba(0,200,255,0.25)',
                                  background: 'rgba(0,200,255,0.12)',
                                  color: 'rgba(235,250,255,0.98)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                RUAJ
                              </button>
                              <button
                                type="button"
                                onClick={() => openRackPicker(it)}
                                style={{
                                  border: '1px solid rgba(34,197,94,0.28)',
                                  background: 'rgba(34,197,94,0.12)',
                                  color: 'rgba(245,255,248,0.98)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                📍 RAFTI / DEPO
                              </button>
                              {!isDelivery && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await updateRiplanMeta(it.id, null, riplanPick.note || '');
                                    await updateTransportStatus([it.id], 'loaded');
                                    try { load(); } catch {}
                                  }}
                                  style={{ border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.95)', borderRadius: 12, padding: '10px 12px', fontWeight: 1000, cursor: 'pointer' }}
                                >
                                  KTHE NË NGARKIM
                                </button>
                              )}
                              {isDelivery && (
                                <>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await updateRiplanMeta(it.id, null, riplanPick.note || '');
                                      await updateTransportStatus([it.id], 'gati');
                                      try { load(); } catch {}
                                    }}
                                    style={{ border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.95)', borderRadius: 12, padding: '10px 12px', fontWeight: 1000, cursor: 'pointer' }}
                                  >
                                    KTHE NË GATI
                                  </button>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await updateRiplanMeta(it.id, null, riplanPick.note || '');
                                      await updateTransportStatus([it.id], 'delivery');
                                      try { load(); } catch {}
                                    }}
                                    style={{ border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.95)', borderRadius: 12, padding: '10px 12px', fontWeight: 1000, cursor: 'pointer' }}
                                  >
                                    KTHE NË DORËZIM
                                  </button>
                                </>
                              )}
                            </div>
                            <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.72)', lineHeight: 1.45 }}>
                              RIPLAN e mban porosinë në listën e transportit derisa të kryhet dorëzimi.
                            </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BOTTOM BAR (not on READY) */}
      {activeTab !== 'ready' && (
        <div style={ui.bottomBar}>
          <div style={{ color: '#8E44AD', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: 20 }}>📥</span>
            <span style={{ fontSize: 10, fontWeight: 600 }}>Inbox</span>
          </div>
          <Link
            href="/transport/menu"
            style={{ color: '#888', display: 'flex', flexDirection: 'column', alignItems: 'center', textDecoration: 'none' }}
          >
            <span style={{ fontSize: 20 }}>☰</span>
            <span style={{ fontSize: 10 }}>Menu</span>
          </Link>
        </div>
      )}
    </div>
  );
}
