'use client';

import { useEffect } from 'react';
import { bootMarkReady, bootSnapshot, bootReadLastInterrupted, bootClearLastInterrupted } from '@/lib/bootLog';

const SENT_KEY = 'tepiha_simple_incident_sent_v2';
const EARLY_QUEUE_KEY = 'tepiha_early_incident_queue_v1';
const MAX_SENT = 40;

function isBrowser() {
  return typeof window !== 'undefined';
}

function incidentsEnabled() {
  if (!isBrowser()) return false;
  try {
    if (window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ === false) return false;
  } catch {}
  return true;
}
function isOnline() {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

function isSafeMode() {
  try {
    if (!isBrowser()) return false;
    if (window.__TEPIHA_HOME_SAFE_MODE__ === true) return true;
    const sp = new URLSearchParams(window.location?.search || '');
    return sp.get('safeMode') === '1' || sp.get('homeSafeMode') === '1';
  } catch {
    return false;
  }
}


function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function isIgnoredBrowserBridgeError(errorLike) {
  try {
    const message = String(errorLike?.message || errorLike?.reason?.message || errorLike || '');
    const stack = String(errorLike?.stack || errorLike?.reason?.stack || '');
    return /window\.webkit\.messageHandlers/i.test(message) || /window\.webkit\.messageHandlers/i.test(stack);
  } catch {
    return false;
  }
}

function readSent() {
  if (!isBrowser()) return [];
  try {
    const parsed = safeParse(window.localStorage?.getItem(SENT_KEY), []);
    return Array.isArray(parsed) ? parsed.map((v) => String(v || '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeSent(list) {
  if (!isBrowser()) return;
  try {
    const next = Array.from(new Set((Array.isArray(list) ? list : []).map((v) => String(v || '')).filter(Boolean))).slice(0, MAX_SENT);
    window.localStorage?.setItem(SENT_KEY, JSON.stringify(next));
  } catch {}
}

function readEarlyQueue() {
  if (!isBrowser()) return [];
  try {
    const parsed = safeParse(window.localStorage?.getItem(EARLY_QUEUE_KEY), []);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function clearEarlyQueue() {
  if (!isBrowser()) return;
  try { window.localStorage?.removeItem(EARLY_QUEUE_KEY); } catch {}
}

function readCurrentEpoch() {
  try {
    return String(window.__TEPIHA_APP_EPOCH || '');
  } catch {
    return '';
  }
}

function hasEpochMismatch(detail = {}) {
  try {
    const currentEpoch = readCurrentEpoch();
    const detailEpoch = String(detail?.appEpoch || detail?.swEpoch || detail?.epoch || detail?.capture?.appEpoch || '');
    return !!(currentEpoch && detailEpoch && currentEpoch !== detailEpoch);
  } catch {
    return false;
  }
}

function buildChunkCapturePayload(detail = {}) {
  const snap = bootSnapshot() || {};
  return {
    ...snap,
    incidentType: String(detail.reason || 'chunk_capture'),
    lastEventType: String(detail.reason || 'chunk_capture'),
    lastEventAt: String(detail.at || new Date().toISOString()),
    currentPath: String(detail.path || snap.currentPath || window.location?.pathname || '/'),
    currentSearch: String(detail.search || snap.currentSearch || window.location?.search || ''),
    meta: {
      source: 'runtime_incident_uploader_chunk_capture_v2',
      capture: detail,
    },
  };
}

function fingerprint(payload) {
  return [
    String(payload?.bootId || ''),
    String(payload?.incidentType || ''),
    String(payload?.currentPath || payload?.bootRootPath || ''),
    String(payload?.lastEventAt || payload?.startedAt || ''),
  ].join('|');
}

async function postIncident(payload) {
  if (!incidentsEnabled() || !payload) return { ok: false, skipped: true };
  const key = fingerprint(payload);
  if (!key) return { ok: false, skipped: true };
  if (readSent().includes(key)) return { ok: true, duplicate: true };

  const body = {
    bootId: String(payload.bootId || ''),
    sessionId: String(payload.sessionId || ''),
    incidentType: String(payload.incidentType || payload.reason || 'runtime_incident'),
    bootRootPath: String(payload.bootRootPath || payload.currentPath || window.location?.pathname || '/'),
    currentPath: String(payload.currentPath || window.location?.pathname || '/'),
    currentSearch: String(payload.currentSearch || window.location?.search || ''),
    startedAt: String(payload.startedAt || ''),
    readyAt: String(payload.readyAt || ''),
    lastEventAt: String(payload.lastEventAt || new Date().toISOString()),
    lastEventType: String(payload.lastEventType || payload.incidentType || payload.reason || ''),
    uiReady: !!payload.uiReady,
    overlayShown: !!payload.overlayShown,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
    actorRole: String(payload.actorRole || ''),
    actorHasActor: typeof payload.actorHasActor === 'boolean' ? payload.actorHasActor : null,
    swEpoch: (() => { try { return String(window.__TEPIHA_APP_EPOCH || payload.swEpoch || ''); } catch { return String(payload.swEpoch || ''); } })(),
    userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '',
    meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
  };

  try {
    const text = JSON.stringify(body);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const ok = navigator.sendBeacon('/api/runtime-incident', new Blob([text], { type: 'application/json' }));
      if (ok) {
        writeSent([key, ...readSent()]);
        bootClearLastInterrupted(body.bootId);
        return { ok: true, beacon: true };
      }
    }
  } catch {}

  try {
    const res = await fetch('/api/runtime-incident', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) return { ok: false, status: res.status, json };
    writeSent([key, ...readSent()]);
    bootClearLastInterrupted(body.bootId);
    return { ok: true, json };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'incident_post_failed') };
  }
}

function buildErrorPayload(kind, errorLike) {
  const snap = bootSnapshot() || {};
  return {
    ...snap,
    incidentType: kind,
    lastEventType: kind,
    lastEventAt: new Date().toISOString(),
    meta: {
      source: 'simple_runtime_incident_uploader_v2',
      message: String(errorLike?.message || errorLike?.reason?.message || errorLike?.reason || errorLike || kind || ''),
      stack: String(errorLike?.stack || errorLike?.reason?.stack || ''),
      name: String(errorLike?.name || errorLike?.reason?.name || ''),
    },
  };
}

export default function RuntimeIncidentUploader() {
  useEffect(() => {
    if (!incidentsEnabled()) return undefined;
    if (isSafeMode()) return undefined;
    if (!isOnline()) return undefined;

    let disposed = false;
    let readyTimer = 0;
    let startupDelayTimer = 0;

    const markReadySoon = () => {
      try {
        window.cancelAnimationFrame?.(readyTimer);
      } catch {}
      readyTimer = window.setTimeout(() => {
        if (disposed) return;
        bootMarkReady({ path: window.location?.pathname || '/' });
      }, 1200);
    };

    const onSimpleIncident = async (event) => {
      if (disposed) return;
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      if (!detail) return;
      if (hasEpochMismatch(detail)) return;
      await postIncident(detail);
    };

    const onError = async (event) => {
      if (disposed) return;
      const payloadError = event?.error || event?.message || event;
      if (isIgnoredBrowserBridgeError(payloadError)) return;
      await postIncident(buildErrorPayload('window_error', payloadError));
    };

    const onUnhandledRejection = async (event) => {
      if (disposed) return;
      await postIncident(buildErrorPayload('unhandled_rejection', event?.reason || event));
    };

    const flushPending = async () => {
      const pending = bootReadLastInterrupted();
      if (!pending || disposed) return;
      if (hasEpochMismatch(pending)) return;
      await postIncident(pending);
    };

    const flushEarlyQueue = async () => {
      const queued = readEarlyQueue();
      if (!queued.length || disposed) return;
      for (const item of queued) {
        if (disposed) break;
        if (hasEpochMismatch(item)) continue;
        await postIncident(buildChunkCapturePayload(item));
      }
      clearEarlyQueue();
    };

    const onChunkCapture = async (event) => {
      if (disposed) return;
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      if (!detail) return;
      if (hasEpochMismatch(detail)) return;
      await postIncident(buildChunkCapturePayload(detail));
    };

    startupDelayTimer = window.setTimeout(() => {
      if (disposed || !isOnline() || isSafeMode()) return;
      markReadySoon();
      void flushPending();
      void flushEarlyQueue();
    }, 700);

    try { window.addEventListener('tepiha:simple-incident', onSimpleIncident); } catch {}
    try { window.addEventListener('tepiha:chunk-capture', onChunkCapture); } catch {}
    try { window.addEventListener('error', onError); } catch {}
    try { window.addEventListener('unhandledrejection', onUnhandledRejection); } catch {}

    return () => {
      disposed = true;
      try { window.clearTimeout(startupDelayTimer); } catch {}
      try { window.clearTimeout(readyTimer); } catch {}
      try { window.removeEventListener('tepiha:simple-incident', onSimpleIncident); } catch {}
      try { window.removeEventListener('tepiha:chunk-capture', onChunkCapture); } catch {}
      try { window.removeEventListener('error', onError); } catch {}
      try { window.removeEventListener('unhandledrejection', onUnhandledRejection); } catch {}
    };
  }, []);

  return null;
}
