"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "@/lib/routerCompat.jsx";
import { getDeviceId } from "@/lib/deviceId";
import { canLoginOffline, cacheApprovedLogin } from "@/lib/deviceApprovalsCache";
import { bootLog } from '@/lib/bootLog';
import { readRuntimeTransition, writeAuthGateTrace, writeRuntimeTransition } from '@/lib/rootResumePanic';
import { recordPersistentTimelineEvent } from '@/lib/lazyImportRuntime';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow, scheduleAfterStartupIsolation } from '@/lib/startupIsolation';
import { hasTransportSession, readBestActor } from '@/lib/sessionStore';
const AUTHGATE_VERIFY_TIMEOUT_MS = 3000;
const AUTH_RESUME_EVENT_LOG_KEY = 'tepiha_auth_resume_event_log_v1';

function readStoredUser() {
  return readBestActor({ allowTransportFallback: true });
}

function hasTransportSessionLocal() {
  return hasTransportSession();
}

function isPublicPath(pathname) {
  if (!pathname) return false;
  if (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/transport/login" ||
    pathname.startsWith("/transport/login") ||
    pathname === "/porosit" ||
    pathname.startsWith("/porosit/") ||
    pathname === "/k" ||
    pathname.startsWith("/k/") ||
    pathname === "/debug-lite" ||
    pathname.startsWith("/debug-lite/") ||
    pathname === "/diag-lite" ||
    pathname.startsWith("/diag-lite/") ||
    pathname === "/diag-raw" ||
    pathname.startsWith("/diag-raw/")
  ) {
    return true;
  }
  try {
    const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search || "") : null;
    return !!(sp && sp.get("public") === "1");
  } catch {
    return false;
  }
}



function hasForceLoginFlag() {
  try {
    if (typeof window === 'undefined') return false;
    const sp = new URLSearchParams(window.location.search || '');
    return sp.get('forceLogin') === '1' || sp.get('force') === '1' || sp.get('clear') === '1' || sp.get('logout') === '1';
  } catch {
    return false;
  }
}

function readHomeRouteFlags() {
  try {
    if (typeof window === 'undefined') return { safeMode: true, disableAuthResume: false };
    const globalFlags = window.__TEPIHA_HOME_SAFE_FLAGS__;
    const sp = new URLSearchParams(window.location.search || '');
    const localFlagsRaw = window.localStorage?.getItem('tepiha_home_flags_v1');
    let localFlags = null;
    if (localFlagsRaw) {
      try { localFlags = JSON.parse(localFlagsRaw); } catch {}
    }
    const readBool = (name, fallback = false) => {
      const qv = sp.get(name);
      if (qv === '1' || qv === 'true') return true;
      if (qv === '0' || qv === 'false') return false;
      const gv = globalFlags?.[name];
      if (typeof gv === 'boolean') return gv;
      const lv = localFlags?.[name];
      if (typeof lv === 'boolean') return lv;
      return fallback;
    };
    return {
      safeMode: readBool('homeSafeMode', true),
      disableAuthResume: readBool('homeNoAuthResume', false),
    };
  } catch {
    return { safeMode: true, disableAuthResume: false };
  }
}

function isHomeInteractiveReady() {
  try {
    if (typeof window === 'undefined') return false;
    return window.__TEPIHA_HOME_INTERACTIVE__ === true;
  } catch {
    return false;
  }
}



function forceAppVisible(reason = 'authgate_force_visible') {
  if (typeof document === 'undefined') return false;
  let changed = false;
  const touch = (node, isRoot = false) => {
    if (!node || !node.style) return;
    try {
      const cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
      const display = String(cs?.display || '').toLowerCase();
      const visibility = String(cs?.visibility || '').toLowerCase();
      const opacity = Number.parseFloat(String(cs?.opacity ?? '1'));
      const pointer = String(cs?.pointerEvents || '').toLowerCase();
      if (isRoot && display === 'none') {
        node.style.display = 'block';
        changed = true;
      }
      if (visibility === 'hidden') {
        node.style.visibility = 'visible';
        changed = true;
      }
      if (Number.isFinite(opacity) && opacity < 0.05) {
        node.style.opacity = '1';
        changed = true;
      }
      if (pointer === 'none') {
        node.style.pointerEvents = 'auto';
        changed = true;
      }
      if (node.hasAttribute && node.hasAttribute('hidden')) {
        node.removeAttribute('hidden');
        changed = true;
      }
      if ('inert' in node && node.inert) {
        node.inert = false;
        changed = true;
      }
      try { node.removeAttribute?.('aria-hidden'); } catch {}
    } catch {}
  };

  try { touch(document.documentElement, true); } catch {}
  try { touch(document.body, true); } catch {}
  try {
    const first = document.body?.firstElementChild || null;
    if (first && first !== document.body) touch(first, false);
  } catch {}
  try {
    const main = document.querySelector?.('body > main, body > div, #__next, [data-nextjs-scroll-focus-boundary]');
    if (main) touch(main, false);
  } catch {}
  try {
    if (changed) {
      document.documentElement?.setAttribute?.('data-authgate-force-visible', String(reason || '1'));
      document.body?.setAttribute?.('data-authgate-force-visible', String(reason || '1'));
    }
  } catch {}
  return changed;
}

function getLocalGateSnapshot(pathname) {
  if (typeof window === "undefined") {
    return {
      actor: null,
      localHasAuth: false,
      localApproval: { ok: false },
      currentDeviceId: null,
      role: "",
      pin: "",
      shouldOpenImmediately: false,
      isOffline: false,
      isPublic: isPublicPath(pathname),
      forceLogin: hasForceLoginFlag(),
    };
  }

  const isPublic = isPublicPath(pathname);
  const forceLogin = hasForceLoginFlag();
  const actor = forceLogin ? null : readStoredUser();
  const localHasAuth = !!actor || (!forceLogin && hasTransportSessionLocal());
  const currentDeviceId = getDeviceId();
  const role = String(actor?.role || (pathname?.startsWith("/transport") ? "TRANSPORT" : "") || "").toUpperCase();
  const pin = String(actor?.pin || actor?.transport_pin || "").trim();
  const localApproval = pin && currentDeviceId
    ? canLoginOffline({ pin, role: role || "TRANSPORT", deviceId: currentDeviceId })
    : { ok: false };
  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  const shouldOpenImmediately = !!(isPublic || localHasAuth || (!forceLogin && localApproval.ok));

  return {
    actor,
    localHasAuth,
    localApproval,
    currentDeviceId,
    role,
    pin,
    shouldOpenImmediately,
    isOffline,
    isPublic,
  };
}


function isHotRouteTransition(reason, pathname) {
  if (reason !== 'storage' && reason !== 'online') return false;
  const transition = readRuntimeTransition();
  if (!transition) return false;
  const now = Date.now();
  const toPath = String(transition?.toPath || '');
  const at = Number(transition?.at || 0) || 0;
  if (!toPath || toPath !== String(pathname || '')) return false;
  if (!at || Math.max(0, now - at) > 1200) return false;
  try {
    const routeAlive = JSON.parse(window.sessionStorage?.getItem('tepiha_route_alive_v1') || 'null');
    const routeUiAlive = JSON.parse(window.sessionStorage?.getItem('tepiha_route_ui_alive_v1') || 'null');
    const routeAliveAt = Number(routeAlive?.at || 0) || 0;
    const routeUiAliveAt = Number(routeUiAlive?.at || 0) || 0;
    if (String(routeAlive?.path || '') === toPath && routeAliveAt >= at) return false;
    if (String(routeUiAlive?.path || '') === toPath && routeUiAliveAt >= at) return false;
  } catch {}
  return true;
}

function logAuthResumeEvent(type, pathname, payload = {}) {
  const transition = readRuntimeTransition();
  return recordPersistentTimelineEvent(AUTH_RESUME_EVENT_LOG_KEY, type, {
    currentPath: String(pathname || payload?.path || '/'),
    path: String(pathname || payload?.path || '/'),
    previousPath: String(payload?.previousPath || transition?.fromPath || ''),
    bootId: (() => {
      try {
        return String(window.BOOT_ID || window.sessionStorage?.getItem('tepiha_boot_current_id') || window.localStorage?.getItem('tepiha_boot_current_id') || '');
      } catch {
        return '';
      }
    })(),
    visibilityState: (() => {
      try { return String(document.visibilityState || ''); } catch { return ''; }
    })(),
    hidden: (() => {
      try { return document.visibilityState !== 'visible'; } catch { return false; }
    })(),
    sourceLayer: 'auth_gate',
    routeTransitionToken: String(payload?.routeTransitionToken || (transition?.at ? `${transition.at}:${transition?.toPath || ''}` : '') || ''),
    transitionInFlight: typeof payload?.transitionInFlight === 'boolean'
      ? payload.transitionInFlight
      : !!(transition?.toPath && transition.toPath !== String(pathname || payload?.path || '/')),
    ...payload,
  }, 100);
}

function readGateCulpritSnapshot(payload = {}) {
  const checkingDevice = !!payload?.checkingDevice;
  const redirecting = !!payload?.redirecting;
  const resumeGate = !!payload?.resumeGate;
  const swSnapshot = (() => {
    try {
      const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
      const controller = supported ? navigator.serviceWorker.controller : null;
      return {
        supported,
        hasController: !!controller,
        controllerScriptURL: String(controller?.scriptURL || ''),
        rootRuntimeSettled: typeof window !== 'undefined' ? window.__TEPIHA_ROOT_RUNTIME_SETTLED__ === true : false,
        runtimeOwnerReady: typeof window !== 'undefined' ? window.__TEPIHA_RUNTIME_OWNER_READY__ === true : false,
        startupEpochCheck: typeof window !== 'undefined' ? (window.__TEPIHA_SW_EPOCH_STARTUP_CHECK__ || null) : null,
      };
    } catch (error) {
      return { error: String(error?.message || error || 'sw_snapshot_failed') };
    }
  })();

  let culprit = String(payload?.culprit || '').trim();
  if (!culprit) {
    if (resumeGate) culprit = 'resumeGate';
    else if (checkingDevice) culprit = 'AuthGate/Supabase device verification';
    else if (redirecting) culprit = 'AuthGate router redirect';
    else if (swSnapshot && swSnapshot.supported && !swSnapshot.rootRuntimeSettled && !swSnapshot.runtimeOwnerReady) culprit = 'Service Worker/runtime owner';
    else culprit = 'unknown AuthGate/resume gate wait';
  }

  return {
    culprit,
    checkingDevice,
    redirecting,
    resumeGate,
    path: (() => {
      try { return String(window.location?.pathname || payload?.path || '/'); } catch { return String(payload?.path || '/'); }
    })(),
    href: (() => {
      try { return String(window.location?.href || ''); } catch { return ''; }
    })(),
    online: (() => {
      try { return typeof navigator !== 'undefined' ? navigator.onLine : null; } catch { return null; }
    })(),
    visibilityState: (() => {
      try { return String(document.visibilityState || ''); } catch { return ''; }
    })(),
    sw: swSnapshot,
    ...payload,
  };
}

function NetworkVerifyScreen({ reason = '' }) {
  const wrap = {
    minHeight: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    background: '#05070d',
    color: '#e8eef6',
    boxSizing: 'border-box',
  };
  const card = {
    width: '100%',
    maxWidth: 420,
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 18,
    background: 'rgba(255,255,255,0.035)',
    padding: 22,
    textAlign: 'center',
    boxShadow: '0 22px 80px rgba(0,0,0,0.38)',
  };
  const spinner = {
    width: 34,
    height: 34,
    margin: '0 auto 14px',
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.18)',
    borderTopColor: 'rgba(255,255,255,0.92)',
    animation: 'tepihaAuthSpin 0.85s linear infinite',
  };
  const title = {
    fontWeight: 900,
    letterSpacing: '0.02em',
    fontSize: 15,
  };
  const sub = {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 1.35,
    opacity: 0.72,
  };
  return (
    <div style={wrap} data-authgate-network-wait="1">
      <style>{`@keyframes tepihaAuthSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={card}>
        <div style={spinner} aria-hidden="true" />
        <div style={title}>Duke verifikuar rrjetin...</div>
        <div style={sub}>Maksimumi 3 sekonda. Pastaj aplikacioni hapet pa bllokim.</div>
        {reason ? <div style={{ ...sub, opacity: 0.46 }}>{String(reason)}</div> : null}
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/";

  const [ready] = useState(true);
  const [checkingDevice, setCheckingDevice] = useState(false);
  const [deviceApproved, setDeviceApproved] = useState(true);
  const [offlineNoUser, setOfflineNoUser] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [redirecting, setRedirecting] = useState(false);

  const mountedRef = useRef(false);
  const bootedRef = useRef(false);
  const evalTimerRef = useRef(null);
  const redirectTimerRef = useRef(null);
  const lastEvalSignatureRef = useRef('');
  const lastEvalAtRef = useRef(0);
  const lastScheduleSignatureRef = useRef('');
  const lastScheduleAtRef = useRef(0);
  const pendingVisibleEvalRef = useRef(false);
  const gateTimeoutRef = useRef(null);
  const previousPathRef = useRef(pathname);
  const [gateTimeoutBypassed, setGateTimeoutBypassed] = useState(null);

  const currentPathIsPublic = useMemo(() => isPublicPath(pathname), [pathname]);

  useEffect(() => {
    mountedRef.current = true;
    bootLog('authgate_mount', { path: pathname });
    return () => {
      mountedRef.current = false;
      bootLog('authgate_unmount', { path: pathname });
    };
  }, [pathname]);

  const clearPendingTimers = useCallback(() => {
    try { if (evalTimerRef.current) clearTimeout(evalTimerRef.current); } catch {}
    try { if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current); } catch {}
    try { if (gateTimeoutRef.current) clearTimeout(gateTimeoutRef.current); } catch {}
    evalTimerRef.current = null;
    redirectTimerRef.current = null;
    gateTimeoutRef.current = null;
  }, []);

  const evaluateGate = useCallback((reason = "effect") => {
    const routeTransitionBeforeEval = readRuntimeTransition();
    const previousPath = String(previousPathRef.current || pathname || '/');
    const pathMismatchOldRoute = !!(
      routeTransitionBeforeEval?.toPath
      && String(routeTransitionBeforeEval?.toPath || '') !== String(pathname || '/')
      && String(routeTransitionBeforeEval?.fromPath || '') === String(pathname || '/')
    );
    if (pathMismatchOldRoute) {
      logAuthResumeEvent('auth_eval_path_mismatch_old_route', pathname, {
        reason,
        previousPath,
        routeTransition: routeTransitionBeforeEval,
        source: 'evaluateGate_pre_snapshot',
      });
    }

    const snapshot = getLocalGateSnapshot(pathname);
    const {
      actor,
      localHasAuth,
      currentDeviceId,
      role,
      pin,
      localApproval,
      shouldOpenImmediately,
      isOffline,
      isPublic,
    } = snapshot;
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    const evalSignature = JSON.stringify({
      path: pathname,
      isPublic: !!isPublic,
      isOffline: !!isOffline,
      role: String(role || ''),
      hasActor: !!actor,
      localHasAuth: !!localHasAuth,
      localApprovalOk: !!localApproval?.ok,
      shouldOpenImmediately: !!shouldOpenImmediately,
      hidden,
    });
    const now = Date.now();
    const skipDuplicateEval = (
      reason !== 'path_change'
      && reason !== 'pageshow'
      && reason !== 'focus'
      && reason !== 'visibility_visible'
      && evalSignature === lastEvalSignatureRef.current
      && (now - Number(lastEvalAtRef.current || 0)) < 700
    );
    if (skipDuplicateEval) {
      logAuthResumeEvent('auth_eval_suppressed', pathname, {
        reason,
        previousPath,
        suppressionReason: 'duplicate_eval_window',
        evalSignature,
        source: 'evaluateGate_duplicate_window',
      });
      return;
    }
    lastEvalSignatureRef.current = evalSignature;
    lastEvalAtRef.current = now;

    logAuthResumeEvent('auth_eval_started', pathname, {
      reason,
      previousPath,
      evalSignature,
      isPublic,
      isOffline,
      localHasAuth,
      localApprovalOk: !!localApproval?.ok,
      shouldOpenImmediately,
      hidden,
      routeTransition: routeTransitionBeforeEval,
      source: 'evaluateGate',
    });

    writeAuthGateTrace({
      path: pathname,
      at: now,
      reason,
      evalReason: reason,
      phase: 'evaluate',
      hidden,
      isPublic,
      isOffline,
      localHasAuth,
      localApprovalOk: !!localApproval?.ok,
      shouldOpenImmediately,
      redirecting: false,
      source: 'evaluateGate',
    });

    bootLog('authgate_snapshot', {
      path: pathname,
      reason,
      isPublic,
      isOffline,
      role,
      hasActor: !!actor,
      localHasAuth,
      localApprovalOk: !!localApproval?.ok,
      shouldOpenImmediately,
      hidden,
    });

    bootedRef.current = true;
    setDeviceId(currentDeviceId || null);
    setCheckingDevice(false);

    if (isPublic) {
      clearPendingTimers();
      setDeviceApproved(true);
      setOfflineNoUser(false);
      setRedirecting(false);
      const forcedVisible = forceAppVisible(`public_${reason}`);
      writeAuthGateTrace({ path: pathname, at: Date.now(), reason, evalReason: reason, phase: 'resolved', source: 'public_path', redirecting: false, suppressed: false });
      logAuthResumeEvent('auth_eval_committed', pathname, { reason, previousPath, outcome: 'public_path', forcedVisible, source: 'public_path', transitionInFlight: false });
      bootLog('auth_resolved', { path: pathname, outcome: 'public_path', reason, forcedVisible });
      return;
    }

    if (shouldOpenImmediately) {
      clearPendingTimers();
      setDeviceApproved(true);
      setOfflineNoUser(false);
      setRedirecting(false);
      const forcedVisible = forceAppVisible(`open_${reason}`);
      writeAuthGateTrace({ path: pathname, at: Date.now(), reason, evalReason: reason, phase: 'resolved', source: 'open_immediately', redirecting: false, suppressed: false, localHasAuth, localApprovalOk: !!localApproval?.ok, shouldOpenImmediately: true });
      logAuthResumeEvent('auth_eval_committed', pathname, { reason, previousPath, outcome: 'open_immediately', localHasAuth, localApprovalOk: !!localApproval?.ok, shouldOpenImmediately: true, forcedVisible, source: 'open_immediately', transitionInFlight: false });
      bootLog('auth_resolved', {
        path: pathname,
        outcome: 'open_immediately',
        reason,
        localHasAuth,
        localApprovalOk: !!localApproval?.ok,
        forcedVisible,
      });
      return;
    }

    if (isOffline) {
      clearPendingTimers();
      setOfflineNoUser(true);
      setDeviceApproved(true);
      setRedirecting(false);
      writeAuthGateTrace({ path: pathname, at: Date.now(), reason, evalReason: reason, phase: 'resolved', source: 'offline_no_user', redirecting: false, suppressed: false, isOffline: true });
      logAuthResumeEvent('auth_eval_committed', pathname, { reason, previousPath, outcome: 'offline_no_user', isOffline: true, source: 'offline_no_user', transitionInFlight: false });
      bootLog('auth_resolved', { path: pathname, outcome: 'offline_no_user', reason });
      return;
    }

    if (hidden) {
      clearPendingTimers();
      setOfflineNoUser(false);
      setDeviceApproved(true);
      setRedirecting(false);
      writeAuthGateTrace({ path: pathname, at: Date.now(), reason, evalReason: reason, phase: 'resolved', source: 'wait_visible_before_redirect', redirecting: false, suppressed: false, hidden: true });
      logAuthResumeEvent('auth_eval_committed', pathname, { reason, previousPath, outcome: 'wait_visible_before_redirect', hidden: true, source: 'wait_visible_before_redirect' });
      bootLog('auth_resolved', { path: pathname, outcome: 'wait_visible_before_redirect', reason });
      return;
    }

    setOfflineNoUser(false);
    setDeviceApproved(true);
    setRedirecting(true);
    writeAuthGateTrace({ path: pathname, at: Date.now(), reason, evalReason: reason, phase: 'resolved', source: 'redirect_pending', redirecting: true, suppressed: false });
    logAuthResumeEvent('auth_eval_committed', pathname, { reason, previousPath, outcome: 'redirect_pending', redirecting: true, source: 'redirect_pending' });
    try { if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current); } catch {}
    redirectTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      const latest = getLocalGateSnapshot(pathname);
      if (latest.isPublic || latest.shouldOpenImmediately || latest.isOffline) {
        setRedirecting(false);
        return;
      }
      try {
        const next = pathname ? `?returnTo=${encodeURIComponent(pathname)}` : "";
        bootLog('auth_redirect_fire', { path: pathname, reason, next });
        router.replace(`/login${next}`);
      } catch {}
    }, 180);

    // Background device-status verification remains intentionally disabled here.
    // This preserves local gate/session logic and login redirect behavior above.
    return;
  }, [clearPendingTimers, pathname, router]);


  const bypassBlockingGate = useCallback((reason = 'timeout_guard', payload = {}) => {
    if (!mountedRef.current) return;
    clearPendingTimers();

    const detail = readGateCulpritSnapshot({
      reason,
      path: pathname,
      elapsedMs: AUTHGATE_VERIFY_TIMEOUT_MS,
      maxWaitMs: AUTHGATE_VERIFY_TIMEOUT_MS,
      source: 'authgate_timeout_guard',
      ...payload,
    });

    setCheckingDevice(false);
    setRedirecting(false);
    setDeviceApproved(true);
    setOfflineNoUser(false);
    setGateTimeoutBypassed({ at: Date.now(), reason, detail });
    const forcedVisible = forceAppVisible(`authgate_timeout_${reason}`);

    const logPayload = { ...detail, forcedVisible };
    try { console.error('[TEPIHA][AuthGate] 3s timeout guard bypassed a blocking gate', logPayload); } catch {}
    try { bootLog('authgate_timeout_bypass', logPayload); } catch {}
    try { logAuthResumeEvent('authgate_timeout_bypass', pathname, logPayload); } catch {}
    try {
      writeAuthGateTrace({
        path: pathname,
        at: Date.now(),
        reason,
        phase: 'timeout_bypass',
        source: 'authgate_timeout_guard',
        redirecting: false,
        suppressed: false,
        culprit: detail.culprit,
        checkingDevice: detail.checkingDevice,
        resumeGate: detail.resumeGate,
        maxWaitMs: AUTHGATE_VERIFY_TIMEOUT_MS,
      });
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('tepiha:authgate-timeout-bypass', { detail: logPayload }));
    } catch {}
  }, [clearPendingTimers, pathname]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const blocking = !!(checkingDevice || redirecting);
    if (!blocking) {
      try { if (gateTimeoutRef.current) window.clearTimeout(gateTimeoutRef.current); } catch {}
      gateTimeoutRef.current = null;
      return undefined;
    }

    const startedAt = Date.now();
    const reason = checkingDevice ? 'checking_device' : 'redirecting';
    try {
      bootLog('authgate_blocking_wait_started', {
        path: pathname,
        reason,
        checkingDevice,
        redirecting,
        maxWaitMs: AUTHGATE_VERIFY_TIMEOUT_MS,
      });
    } catch {}

    try { if (gateTimeoutRef.current) window.clearTimeout(gateTimeoutRef.current); } catch {}
    gateTimeoutRef.current = window.setTimeout(() => {
      gateTimeoutRef.current = null;
      bypassBlockingGate(reason, {
        startedAt,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        checkingDevice,
        redirecting,
      });
    }, AUTHGATE_VERIFY_TIMEOUT_MS);

    return () => {
      try { if (gateTimeoutRef.current) window.clearTimeout(gateTimeoutRef.current); } catch {}
      gateTimeoutRef.current = null;
    };
  }, [checkingDevice, redirecting, pathname, bypassBlockingGate]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResumeGateTimeout = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      bypassBlockingGate('resume_gate_timeout', {
        ...detail,
        resumeGate: true,
        culprit: detail?.culprit || 'resumeGate',
      });
      try { evaluateGate('resume_gate_timeout_bypass'); } catch {}
    };
    window.addEventListener('tepiha:resume-gate-timeout-bypass', onResumeGateTimeout, { passive: true });
    return () => {
      try { window.removeEventListener('tepiha:resume-gate-timeout-bypass', onResumeGateTimeout); } catch {}
    };
  }, [bypassBlockingGate, evaluateGate]);

  useEffect(() => {
    const previousPath = String(previousPathRef.current || pathname || '/');
    if (previousPath !== pathname) {
      writeRuntimeTransition({
        fromPath: previousPath,
        toPath: pathname,
        at: Date.now(),
        reason: 'path_change',
      });
      writeAuthGateTrace({
        path: pathname,
        at: Date.now(),
        reason: 'path_change',
        phase: 'path_change',
        source: 'pathname_effect',
        routeTransition: readRuntimeTransition(),
      });
    }
    previousPathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    evaluateGate('path_change');
    return () => {
      clearPendingTimers();
    };
  }, [evaluateGate, clearPendingTimers]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    bootLog('authgate_postboot_listeners_enabled', {
      path: pathname,
      reason: 'authgate_only_reenable_test',
    });

    let isolationCancel = null;
    let cleanup = null;

    const startListeners = () => {
      if (isWithinStartupIsolationWindow()) {
        bootLog('authgate_resume_isolation_skip', {
          path: pathname,
          leftMs: getStartupIsolationLeftMs(),
        });
        isolationCancel = scheduleAfterStartupIsolation(() => {
          evaluateGate('startup_isolation_retry');
          cleanup = startListeners();
        }, { bufferMs: 80 });
        return undefined;
      }

      const scheduleEvaluate = (reason, delay = 0) => {
        const latest = getLocalGateSnapshot(pathname);
        const routeTransition = readRuntimeTransition();
        const hotTransition = isHotRouteTransition(reason, pathname);
        const pathMismatchOldRoute = !!(
          routeTransition?.toPath
          && String(routeTransition?.toPath || '') !== String(pathname || '/')
          && String(routeTransition?.fromPath || '') === String(pathname || '/')
        );
        if (pathMismatchOldRoute) {
          logAuthResumeEvent('auth_eval_path_mismatch_old_route', pathname, {
            reason,
            scheduleReason: reason,
            listenerReason: reason,
            previousPath: String(previousPathRef.current || pathname || '/'),
            routeTransition,
            source: 'scheduleEvaluate',
          });
        }
        writeAuthGateTrace({
          path: pathname,
          at: Date.now(),
          reason,
          scheduleReason: reason,
          listenerReason: reason,
          phase: 'schedule',
          source: 'listener',
          localHasAuth: latest.localHasAuth,
          localApprovalOk: !!latest.localApproval?.ok,
          shouldOpenImmediately: latest.shouldOpenImmediately,
          isPublic: latest.isPublic,
          isOffline: latest.isOffline,
          suppressed: hotTransition,
          suppressionReason: hotTransition ? 'route_transition_hot' : '',
          routeTransition,
        });
        logAuthResumeEvent('auth_eval_scheduled', pathname, {
          reason,
          scheduleReason: reason,
          listenerReason: reason,
          delay,
          previousPath: String(previousPathRef.current || pathname || '/'),
          localHasAuth: latest.localHasAuth,
          localApprovalOk: !!latest.localApproval?.ok,
          shouldOpenImmediately: latest.shouldOpenImmediately,
          isPublic: latest.isPublic,
          isOffline: latest.isOffline,
          suppressed: hotTransition,
          suppressionReason: hotTransition ? 'route_transition_hot' : '',
          routeTransition,
          transitionInFlight: !!(routeTransition?.toPath && routeTransition.toPath !== String(pathname || '/')),
          source: 'listener',
        });
        if (hotTransition) {
          logAuthResumeEvent('auth_eval_suppressed', pathname, {
            reason,
            scheduleReason: reason,
            listenerReason: reason,
            suppressionReason: 'route_transition_hot',
            previousPath: String(previousPathRef.current || pathname || '/'),
            routeTransition,
            source: 'listener_hot_transition',
          });
          logAuthResumeEvent('auth_eval_skipped_transition', pathname, {
            reason,
            scheduleReason: reason,
            listenerReason: reason,
            previousPath: String(previousPathRef.current || pathname || '/'),
            routeTransition,
            source: 'listener_hot_transition',
          });
          pendingVisibleEvalRef.current = true;
          return;
        }
        if (latest.isPublic || latest.shouldOpenImmediately) {
          pendingVisibleEvalRef.current = false;
          forceAppVisible(`listener_${reason}`);
          if (
            reason === 'path_change'
            || reason === 'storage'
            || reason === 'visibility_visible'
            || reason === 'pageshow'
            || reason === 'focus'
            || reason === 'root_resume'
          ) {
            evaluateGate(reason);
          }
          return;
        }
        const isVisibleNow = (() => {
          try { return document.visibilityState === 'visible'; } catch { return true; }
        })();
        if (!isVisibleNow && (reason === 'storage' || reason === 'online')) {
          pendingVisibleEvalRef.current = true;
          return;
        }
        const now = Date.now();
        const scheduleSignature = `${pathname}|${reason}`;
        if (scheduleSignature === lastScheduleSignatureRef.current && (now - Number(lastScheduleAtRef.current || 0)) < 180) {
          return;
        }
        lastScheduleSignatureRef.current = scheduleSignature;
        lastScheduleAtRef.current = now;
        try { if (evalTimerRef.current) clearTimeout(evalTimerRef.current); } catch {}
        evalTimerRef.current = setTimeout(() => {
          evalTimerRef.current = null;
          evaluateGate(reason);
        }, Math.max(0, Number(delay) || 0));
      };

      const logPassiveResume = (reason, extra = {}) => {
        bootLog('authgate_resume_listener_passive', {
          path: pathname,
          reason,
          ...(extra || {}),
        });
      };

      const requestVisibleEvaluate = (reason, extra = {}) => {
        logPassiveResume(reason, extra);
        pendingVisibleEvalRef.current = false;
        scheduleEvaluate(reason, 40);
      };

      const onStorage = () => scheduleEvaluate('storage', 30);
      const onOnline = () => scheduleEvaluate('online', 30);
      const onFocus = () => requestVisibleEvaluate('focus');
      const onPageShow = (event) => requestVisibleEvaluate('pageshow', { persisted: !!event?.persisted });
      const onRootResume = (event) => requestVisibleEvaluate(String(event?.detail?.reason || 'root_resume'), event?.detail && typeof event.detail === 'object' ? event.detail : {});
      const onRootResumeStall = (event) => requestVisibleEvaluate('root_resume_stall', event?.detail && typeof event.detail === 'object' ? event.detail : {});
      const onVisible = () => {
        try {
          if (document.visibilityState !== 'visible') return;
        } catch {}
        requestVisibleEvaluate('visibility_visible');
      };

      window.addEventListener('storage', onStorage);
      window.addEventListener('focus', onFocus, { passive: true });
      window.addEventListener('pageshow', onPageShow, { passive: true });
      window.addEventListener('online', onOnline, { passive: true });
      window.addEventListener('tepiha:root-resume', onRootResume, { passive: true });
      window.addEventListener('tepiha:root-resume-stall', onRootResumeStall, { passive: true });
      document.addEventListener('visibilitychange', onVisible, { passive: true });

      return () => {
        try { window.removeEventListener('storage', onStorage); } catch {}
        try { window.removeEventListener('focus', onFocus); } catch {}
        try { window.removeEventListener('pageshow', onPageShow); } catch {}
        try { window.removeEventListener('online', onOnline); } catch {}
        try { window.removeEventListener('tepiha:root-resume', onRootResume); } catch {}
        try { window.removeEventListener('tepiha:root-resume-stall', onRootResumeStall); } catch {}
        try { document.removeEventListener('visibilitychange', onVisible); } catch {}
      };
    };

    cleanup = startListeners();
    return () => {
      try { if (typeof cleanup === 'function') cleanup(); } catch {}
      try { if (typeof isolationCancel === 'function') isolationCancel(); } catch {}
    };
  }, [evaluateGate, pathname]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const snapshot = getLocalGateSnapshot(pathname);
    if (!(snapshot.isPublic || snapshot.shouldOpenImmediately)) return undefined;

    let cancelled = false;
    const run = (reason) => {
      if (cancelled) return;
      const latest = getLocalGateSnapshot(pathname);
      if (!(latest.isPublic || latest.shouldOpenImmediately)) return;
      const forcedVisible = forceAppVisible(`failsafe_${reason}`);
      setRedirecting(false);
      setOfflineNoUser(false);
      setDeviceApproved(true);
      if (forcedVisible) {
        bootLog('authgate_force_open_failsafe', {
          path: pathname,
          reason,
          isPublic: latest.isPublic,
          localHasAuth: latest.localHasAuth,
          localApprovalOk: !!latest.localApproval?.ok,
        });
      }
    };

    const t1 = window.setTimeout(() => run('t450'), 450);
    const t2 = window.setTimeout(() => run('t1200'), 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [pathname]);

  const wrapStyle = {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "#0b0f14",
    color: "#e8eef6",
  };
  const cardStyle = {
    width: "100%",
    maxWidth: 560,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 14,
    padding: 18,
  };
  const titleStyle = {
    fontWeight: 900,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontSize: 14,
  };
  const subStyle = { marginTop: 10, opacity: 0.88, lineHeight: 1.35, fontSize: 13 };
  const metaStyle = {
    marginTop: 14,
    border: "1px dashed rgba(255,255,255,0.18)",
    borderRadius: 12,
    padding: 12,
    background: "rgba(0,0,0,0.18)",
  };
  const kStyle = { fontSize: 11, opacity: 0.7, letterSpacing: "0.08em", textTransform: "uppercase" };
  const vStyle = {
    marginTop: 6,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    wordBreak: "break-all",
  };
  const hintStyle = { marginTop: 12, fontSize: 12, opacity: 0.8, lineHeight: 1.35 };
  const btnRowStyle = { display: "flex", gap: 10, marginTop: 16 };
  const btnStyle = {
    flex: 1,
    padding: "12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontSize: 12,
  };

  if (!ready) {
    return <NetworkVerifyScreen reason="authgate_ready_wait" />;
  }

  const lastGateTimeoutBypass = gateTimeoutBypassed;

  if (redirecting) {
    return (
      <div style={wrapStyle}>
        <div style={{ ...cardStyle, maxWidth: 520 }}>
          <div style={titleStyle}>DUKE TË DËRGUAR TE LOGIN...</div>
          <div style={subStyle}>Nuk u gjet session aktiv në këtë pajisje.</div>
        </div>
      </div>
    );
  }

  if (checkingDevice) {
    return <NetworkVerifyScreen reason="authgate_device_check" />;
  }

  if (deviceApproved === false) {
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <div style={titleStyle}>PAJISJA NUK ËSHTË APROVUAR</div>
          <div style={subStyle}>
            Kjo pajisje nuk u aprovua nga sistemi. Aprovoheni te /ARKA/PUNTORET dhe pastaj bëni hyrje prapë.
          </div>

          <div style={metaStyle}>
            <div style={kStyle}>DEVICE ID</div>
            <div style={vStyle}>{deviceId || "—"}</div>
          </div>

          <div style={hintStyle}>Nëse jeni offline por keni session valid, aplikacioni duhet të hapet pa bllokim.</div>

          <div style={btnRowStyle}>
            <button
              style={btnStyle}
              onClick={() => {
                try {
                  navigator.clipboard.writeText(deviceId || "");
                  alert("U kopjua!");
                } catch {}
              }}
            >
              KOPJO ID
            </button>
            <button
              style={btnStyle}
              onClick={() => {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
                try {
                  setRedirecting(true);
                  router.replace('/login');
                } catch {}
              }}
            >
              KTHEHU TE LOGIN
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {lastGateTimeoutBypass ? null : null}
      {offlineNoUser ? (
        <div
          style={{
            padding: 10,
            margin: 10,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,180,0,0.10)",
            color: "#ffd28a",
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: "uppercase",
            fontSize: 12,
          }}
        >
          OFFLINE • S'KA SESSION — KTHEHU ONLINE ME HY
        </div>
      ) : null}
      {children}
    </>
  );
}
