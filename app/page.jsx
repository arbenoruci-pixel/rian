'use client';

import { Component, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { useRouter } from '@/lib/routerCompat.jsx';
import useRouteAlive, { markRouteUiAlive } from '@/lib/routeAlive';
import { bootLog } from '@/lib/bootLog';
import { getActor } from '@/lib/actorSession';
import { readPageSnapshot } from '@/lib/pageSnapshotCache';

function onlyDigits(v){ return String(v ?? '').replace(/\D+/g,''); }
function isOpaqueUserRef(value){
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^ADMIN_/i.test(raw)) return true;
  if (looksUuid(raw)) return true;
  return /^\d{3,}$/.test(raw);
}
function cleanVisibleName(value){
  const raw = String(value || '').trim();
  if (!raw) return '';
  return isOpaqueUserRef(raw) ? '' : raw;
}
function normCode(v){
  const s = String(v ?? '').trim();
  if (!s) return { kind:'', raw:'' };
  if (/^t\d+/i.test(s)) return { kind:'T', raw:'T'+onlyDigits(s) };
  return { kind:'B', raw: onlyDigits(s) };
}

function routeForStatus(status){
  const s = String(status||'').toLowerCase();
  if (s === 'pastrim') return '/pastrimi';
  if (s === 'gati') return '/gati';
  if (s === 'dorzim' || s === 'dorzuar') return '/marrje-sot';
  return '/pastrimi';
}

function unwrapSearchOrderData(raw){
  let data = raw;
  if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;
  if (data && typeof data === 'object' && data.order && typeof data.order === 'object') {
    const nested = data.order;
    const nestedHasStructured = !!(nested?.client || nested?.tepiha || nested?.tepihaRows || nested?.staza || nested?.stazaRows || nested?.pay);
    if (nestedHasStructured) {
      data = { ...nested, ...data, client: data.client || nested.client, pay: data.pay || nested.pay };
    }
  }
  return (data && typeof data === 'object') ? data : {};
}


function pickClientMeta(order){
  const data = unwrapSearchOrderData(order);
  const name = String(order?.client_name || data?.client?.name || order?.client?.name || data?.client_name || data?.name || order?.name || 'Pa Emër').trim() || 'Pa Emër';
  const phone = String(order?.client_phone || data?.client?.phone || order?.client?.phone || data?.client_phone || data?.phone || order?.phone || '').trim();
  return { name, phone };
}

function matchesUniversal(order, q){
  const qq = String(q || '').toLowerCase().trim();
  if (!qq) return true;
  const meta = pickClientMeta(order);
  const code = String(order?.client_tcode || order?.code || '').toLowerCase();
  return code.includes(qq) || meta.name.toLowerCase().includes(qq) || meta.phone.toLowerCase().includes(qq);
}

function getStatusStyle(status) {
  const s = String(status||'').toLowerCase();
  if (s === 'gati') return { background: 'rgba(16, 185, 129, 0.15)', color: '#4ade80', border: '1px solid rgba(16, 185, 129, 0.3)' };
  if (s === 'pastrim') return { background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' };
  if (s === 'dorzim' || s === 'dorzuar') return { background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)' };
  return { background: 'rgba(255,255,255,0.05)', color: '#aaa', border: '1px solid rgba(255,255,255,0.1)' };
}

const GATI_HIDDEN_ROUTE = '';
const GATI_HOLD_MS = 1000;
const HOME_RESUME_GUARD_MS = 2600;
const HOME_RESUME_WIDGET_DELAY_MS = 50;
const HOME_RESUME_STALL_MS = 3000;
const HOME_LITE_DELAY_MS = 180;
const DEBUG_HOLD_MS = 1200;
const HOME_SEARCH_TIMEOUT_MS = 3500;
const HOME_SEARCH_CACHE_PREFIX = 'tepiha_home_search_cache_v2:';
const HOME_SEARCH_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const HOME_SEARCH_MAX_RESULTS = 24;
const HOME_SEARCH_TRANSPORTER_LOOKUP_LIMIT = 8;

function normalizeSearchCacheKey(value) {
  return String(value || '').trim().toLowerCase().slice(0, 120);
}

function readHomeSearchCache(value) {
  const key = normalizeSearchCacheKey(value);
  if (!key) return [];
  try {
    const raw = window.localStorage?.getItem(`${HOME_SEARCH_CACHE_PREFIX}${key}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts || 0) || 0;
    if (ts && Date.now() - ts > HOME_SEARCH_CACHE_TTL_MS) return [];
    const rows = Array.isArray(parsed?.results) ? parsed.results : [];
    return rows.slice(0, HOME_SEARCH_MAX_RESULTS);
  } catch {
    return [];
  }
}

function writeHomeSearchCache(value, results) {
  const key = normalizeSearchCacheKey(value);
  if (!key) return;
  try {
    const safe = Array.isArray(results) ? results.slice(0, HOME_SEARCH_MAX_RESULTS) : [];
    window.localStorage?.setItem(`${HOME_SEARCH_CACHE_PREFIX}${key}`, JSON.stringify({
      ts: Date.now(),
      results: safe,
    }));
  } catch {}
}

function normalizeSearchResult(entry = {}) {
  return {
    kind: String(entry?.kind || '').toUpperCase() === 'T' ? 'T' : 'B',
    code: String(entry?.code || '').trim(),
    status: String(entry?.status || '').trim(),
    name: String(entry?.name || 'Pa Emër').trim() || 'Pa Emër',
    phone: String(entry?.phone || '').trim(),
    transporter: String(entry?.transporter || '').trim(),
    createdBy: String(entry?.createdBy || '').trim(),
    pieces: Number(entry?.pieces || 0) || 0,
    id: entry?.id ?? null,
  };
}

function dedupeSearchResults(rows = []) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const next = normalizeSearchResult(item);
    const key = [next.kind, String(next.id || ''), next.code, next.status, next.phone].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
    if (out.length >= HOME_SEARCH_MAX_RESULTS) break;
  }
  return out;
}

function rowsFromSnapshots() {
  try {
    const buckets = [readPageSnapshot('pastrimi'), readPageSnapshot('gati')];
    return buckets
      .flatMap((bucket) => (Array.isArray(bucket?.rows) ? bucket.rows : []))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mapRowToSearchResult(row, transporterMap = null) {
  const meta = pickClientMeta(row);
  return normalizeSearchResult({
    kind: String(row?._table || '') === 'transport_orders' || String(row?.client_tcode || row?.code_str || '').toUpperCase().startsWith('T') ? 'T' : 'B',
    code: String(row?.client_tcode || row?.code_str || (row?.code ?? '')).trim(),
    status: row?.status || '',
    name: meta.name,
    phone: meta.phone,
    transporter: cleanVisibleName(resolveTransporterName(row, transporterMap || new Map())),
    createdBy: cleanVisibleName(row?.data?._audit?.created_by_name || row?.data?.created_by_name || row?.data?.created_by || null),
    pieces: computePieces(row?.data),
    id: row?.id || null,
  });
}

async function runLocalSearchFallback(query, parsed = { kind: '', raw: '' }) {
  const qRaw = String(query || '').trim();
  const searchLower = qRaw.toLowerCase();
  const kind = String(parsed?.kind || '');
  const raw = String(parsed?.raw || '');
  if (!qRaw) return [];

  const snapshotRows = rowsFromSnapshots();
  let localRows = [...snapshotRows];

  try {
    const { getAllFromStore } = await import('@/lib/localDb');
    const baseRows = await getAllFromStore('orders').catch(() => []);
    const wrappedBase = (Array.isArray(baseRows) ? baseRows : []).map((row) => ({ ...row, _table: 'orders' }));
    localRows = [...snapshotRows, ...wrappedBase];

    if (kind === 'T' && raw) {
      const [{ getTransportBaseSummary }, transportRows] = await Promise.all([
        import('@/lib/transport/bridgeMeta'),
        getAllFromStore('transport_orders').catch(() => []),
      ]);
      const wrappedTransport = (Array.isArray(transportRows) ? transportRows : []).map((row) => ({ ...row, _table: 'transport_orders' }));
      const codeNeedle = String(raw || '').toUpperCase();
      const hits = wrappedTransport.filter((row) => {
        const meta = getTransportBaseSummary(row);
        const code = String(meta?.code || row?.client_tcode || row?.code_str || '').toUpperCase();
        return code === codeNeedle;
      });
      return dedupeSearchResults(hits.map((row) => mapRowToSearchResult(row)));
    }
  } catch {}

  if (kind === 'T' && raw) {
    try {
      const { getAllFromStore } = await import('@/lib/localDb');
      const transportRows = await getAllFromStore('transport_orders').catch(() => []);
      const wrappedTransport = (Array.isArray(transportRows) ? transportRows : []).map((row) => ({ ...row, _table: 'transport_orders' }));
      const codeNeedle = String(raw || '').toUpperCase();
      const hits = wrappedTransport.filter((row) => String(row?.client_tcode || row?.code_str || '').toUpperCase() === codeNeedle);
      return dedupeSearchResults(hits.map((row) => mapRowToSearchResult(row)));
    } catch {
      return [];
    }
  }

  const isNumericOnly = /^\d+$/.test(qRaw);
  if (isNumericOnly && raw && Number(raw) > 0) {
    const n = String(Number(raw));
    const hits = localRows.filter((row) => String(row?._table || 'orders') === 'orders' && String(row?.code ?? '') === n);
    return dedupeSearchResults(hits.map((row) => mapRowToSearchResult(row)));
  }

  const hits = localRows.filter((row) => String(row?._table || 'orders') !== 'transport_orders' && matchesUniversal(row, searchLower));
  return dedupeSearchResults(hits.map((row) => mapRowToSearchResult(row)));
}

// Llogarit sa tepihë ka brenda porosisë
function computePieces(orderData) {
  const data = unwrapSearchOrderData(orderData);
  if (!data) return 0;
  const t = Array.isArray(data.tepiha) ? data.tepiha : (Array.isArray(data.tepihaRows) ? data.tepihaRows : []);
  const s = Array.isArray(data.staza) ? data.staza : (Array.isArray(data.stazaRows) ? data.stazaRows : []);
  const tCope = t.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const sCope = s.reduce((a, b) => a + (Number(b.qty ?? b.pieces) || 0), 0);
  const shk = Number(data.shkallore?.qty || data.stairsQty || 0) > 0 ? Number(data.shkallore?.qty || data.stairsQty || 0) || 0 : 0;
  return tCope + sCope + shk;
}

function looksUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function cleanSearchToken(value) {
  return String(value || '').replace(/[,%()]/g, ' ').trim();
}

function collectTransportRefs(rows = []) {
  const refs = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const data = unwrapSearchOrderData(row);
    const values = [
      row?.transport_id,
      data?.transport_id,
      data?.transportId,
      data?.transport_pin,
      data?.driver_pin,
      data?.created_by_pin,
      row?.created_by_pin,
    ];
    for (const value of values) {
      const ref = String(value || '').trim();
      if (ref) refs.push(ref);
    }
  }
  return Array.from(new Set(refs));
}

function resolveTransporterName(row, transportNameMap) {
  const data = unwrapSearchOrderData(row);
  const direct = [
    data?.transport_name,
    row?.transport_name,
    data?.driver_name,
    row?.driver_name,
    data?.created_by_name,
    row?.created_by_name,
  ].map(cleanVisibleName).find(Boolean);
  if (direct) return direct;

  const refs = [
    row?.transport_id,
    data?.transport_id,
    data?.transportId,
    data?.transport_pin,
    data?.driver_pin,
    data?.created_by_pin,
    row?.created_by_pin,
  ].map((v) => String(v || '').trim()).filter(Boolean);

  for (const ref of refs) {
    if (transportNameMap?.has(ref)) return String(transportNameMap.get(ref) || '').trim();
    const pin = onlyDigits(ref);
    if (pin && transportNameMap?.has(pin)) return String(transportNameMap.get(pin) || '').trim();
  }
  return '';
}

async function fetchTransporterNamesByRefs(refs, options = {}) {
  try {
    const uniq = Array.from(new Set((Array.isArray(refs) ? refs : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))).slice(0, HOME_SEARCH_TRANSPORTER_LOOKUP_LIMIT);
    if (!uniq.length) return new Map();

    const ids = uniq.filter(looksUuid);
    const pins = uniq.map((value) => onlyDigits(value)).filter(Boolean);
    const transportIds = uniq.filter((value) => !looksUuid(value) && !/^\d+$/.test(value));

    const { supabase } = await import('@/lib/supabaseClient');
    const map = new Map();

    const applyRows = (rows) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(row?.name || '').trim();
        if (!name) continue;
        const id = String(row?.id || '').trim();
        const pin = onlyDigits(row?.pin);
        const tid = String(row?.transport_id || '').trim();
        if (id) map.set(id, name);
        if (pin) map.set(pin, name);
        if (tid) map.set(tid, name);
      }
    };

    const runQuery = async (column, values) => {
      const uniqVals = Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
      if (!uniqVals.length) return;
      let query = supabase.from('tepiha_users').select('id,name,pin,transport_id').in(column, uniqVals).limit(Math.max(uniqVals.length, 1));
      if (options?.signal && typeof query?.abortSignal === 'function') query = query.abortSignal(options.signal);
      if (Number(options?.timeoutMs) > 0 && typeof query?.timeout === 'function') {
        query = query.timeout(Number(options.timeoutMs), String(options?.timeoutLabel || 'SUPABASE_TIMEOUT'));
      }
      const { data, error } = await query;
      if (error) throw error;
      applyRows(data);
    };

    await runQuery('id', ids);
    await runQuery('pin', pins);
    await runQuery('transport_id', [...ids, ...transportIds]);
    return map;
  } catch {
    return new Map();
  }
}


function scheduleIdleWork(cb, timeout = 1200) {
  try {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => {
        try { cb?.(); } catch {}
      }, { timeout: Math.max(0, Number(timeout) || 0) });
      return () => {
        try { window.cancelIdleCallback?.(id); } catch {}
      };
    }
  } catch {}
  const id = window.setTimeout(() => {
    try { cb?.(); } catch {}
  }, 0);
  return () => {
    try { window.clearTimeout(id); } catch {}
  };
}

function readHomeFlags() {
  const defaults = {
    safeMode: true,
    disableAuthResume: true,
    disableSessionDock: true,
    disableHomeCacheRead: true,
    disableHomeStats: true,
    disableHomePopups: true,
  };

  try {
    if (typeof window === 'undefined') return defaults;
    const out = { ...defaults };
    const sp = new URLSearchParams(window.location.search || '');
    const lsRaw = window.localStorage?.getItem('tepiha_home_flags_v1');
    let stored = null;
    if (lsRaw) {
      try { stored = JSON.parse(lsRaw); } catch {}
    }
    const readBool = (name, fallback = false) => {
      const qv = sp.get(name);
      if (qv === '1' || qv === 'true') return true;
      if (qv === '0' || qv === 'false') return false;
      const sv = stored?.[name];
      if (typeof sv === 'boolean') return sv;
      return fallback;
    };
    out.safeMode = readBool('homeSafeMode', defaults.safeMode);
    out.disableAuthResume = readBool('homeNoAuthResume', defaults.disableAuthResume);
    out.disableSessionDock = readBool('homeNoSessionDock', defaults.disableSessionDock);
    out.disableHomeCacheRead = readBool('homeNoCacheRead', defaults.disableHomeCacheRead);
    out.disableHomeStats = readBool('homeNoStats', defaults.disableHomeStats);
    out.disableHomePopups = readBool('homeNoPopups', defaults.disableHomePopups);
    return out;
  } catch {
    return defaults;
  }
}

function clearHomeShellPaint(reason = 'reset', token = 0) {
  try {
    if (typeof window === 'undefined') return;
    window.__TEPIHA_HOME_SHELL_READY__ = false;
    window.__TEPIHA_HOME_SHELL_READY_AT__ = 0;
    window.__TEPIHA_HOME_SHELL_READY_TOKEN__ = Number(token || 0) || 0;
    window.__TEPIHA_HOME_SHELL_READY_PATH__ = '/';
    document?.documentElement?.removeAttribute?.('data-home-shell-ready');
    document?.body?.removeAttribute?.('data-home-shell-ready');
    window.dispatchEvent(new CustomEvent('tepiha:home-shell-reset', {
      detail: { page: 'home', path: '/', reason, token: Number(token || 0) || 0, at: Date.now() },
    }));
  } catch {}
}

function markHomeShellPaint(token = 0, meta = {}) {
  try {
    if (typeof window === 'undefined') return;
    const at = Date.now();
    const safeToken = Number(token || 0) || 0;
    window.__TEPIHA_HOME_SHELL_READY__ = true;
    window.__TEPIHA_HOME_SHELL_READY_AT__ = at;
    window.__TEPIHA_HOME_SHELL_READY_TOKEN__ = safeToken;
    window.__TEPIHA_HOME_SHELL_READY_PATH__ = '/';
    document?.documentElement?.setAttribute?.('data-home-shell-ready', '1');
    document?.body?.setAttribute?.('data-home-shell-ready', '1');
    window.dispatchEvent(new CustomEvent('tepiha:home-shell-paint', {
      detail: { page: 'home', path: '/', token: safeToken, at, ...(meta && typeof meta === 'object' ? meta : {}) },
    }));
  } catch {}
}

function clearHomeUiAlive(reason = 'reset', token = 0) {
  try {
    if (typeof window === 'undefined') return;
    window.__TEPIHA_HOME_UI_ALIVE__ = false;
    window.__TEPIHA_HOME_UI_ALIVE_AT__ = 0;
    window.__TEPIHA_HOME_UI_ALIVE_TOKEN__ = Number(token || 0) || 0;
    document?.documentElement?.removeAttribute?.('data-home-ui-alive');
    document?.body?.removeAttribute?.('data-home-ui-alive');
    document?.documentElement?.removeAttribute?.('data-ui-alive');
    document?.body?.removeAttribute?.('data-ui-alive');
    window.dispatchEvent(new CustomEvent('tepiha:home-ui-reset', {
      detail: { page: 'home', path: '/', reason, token: Number(token || 0) || 0, at: Date.now() },
    }));
  } catch {}
}

function markHomeUiReady(meta = {}) {
  try {
    if (typeof window === 'undefined') return;
    const at = Date.now();
    window.__TEPIHA_UI_READY = true;
    window.__TEPIHA_HOME_UI_READY = true;
    window.__TEPIHA_ROUTE_UI_READY = 'home';
    document?.documentElement?.setAttribute?.('data-ui-ready', '1');
    document?.body?.setAttribute?.('data-ui-ready', '1');
    try {
      markRouteUiAlive('home_ui_ready', '/', {
        page: 'home',
        at,
        uiReady: true,
        ...(meta && typeof meta === 'object' ? meta : {}),
      });
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('tepiha:first-ui-ready', {
        detail: { page: 'home', path: '/', ts: at, at, ...(meta && typeof meta === 'object' ? meta : {}) },
      }));
    } catch {}
  } catch {}
}

class HomeSectionBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    try {
      bootLog('home_section_error', {
        path: '/',
        section: String(this.props?.section || 'unknown'),
        error: String(error?.message || error || ''),
        componentStack: String(info?.componentStack || '').slice(0, 2000),
      });
    } catch {}
  }

  render() {
    if (this.state.hasError) return this.props?.fallback ?? null;
    return this.props?.children ?? null;
  }
}

export default function HomePage() {
  useRouteAlive('home_page');
  const router = useRouter();
  const flagsRef = useRef(null);
  if (!flagsRef.current) flagsRef.current = readHomeFlags();
  const homeFlags = flagsRef.current;
  const renderStartRef = useRef(0);
  const renderLoggedRef = useRef(false);
  const shellReadyLoggedRef = useRef(false);
  const firstPaintRef = useRef(false);
  const firstInteractiveRef = useRef(false);
  const finalUiReadyRef = useRef(false);
  const resumeSeqRef = useRef(0);
  const resumeStateRef = useRef({ token: 0, acceptedAt: 0, reason: '', widgetsStarted: false, widgetsFinished: false, stallTimer: 0 });
  const widgetStageRef = useRef({ stats: false, popups: false, cache: false });
  if (!renderLoggedRef.current) {
    renderLoggedRef.current = true;
    renderStartRef.current = Date.now();
    bootLog('home_render_start', { path: '/', flags: homeFlags });
    bootLog('home_shell_render_start', { path: '/', flags: homeFlags });
  }
  const [mountedLite, setMountedLite] = useState(true);
  const [user, setUser] = useState(null);
  const [homeResumeToken, setHomeResumeToken] = useState(0);
  const [homeResumeShellPainted, setHomeResumeShellPainted] = useState(false);
  const [homeWidgetsGateToken, setHomeWidgetsGateToken] = useState(0);
  const [homeWidgetsStarted, setHomeWidgetsStarted] = useState(false);
  const [homeWidgetsFinished, setHomeWidgetsFinished] = useState(false);
  const [homeWidgetRecoverySeq, setHomeWidgetRecoverySeq] = useState(0);
  const [rootRuntimeSettledTick, setRootRuntimeSettledTick] = useState(0);
  const showHomeShellPlaceholder = false;
  const homeWidgetsGateOpen = !!homeResumeShellPainted && !!homeWidgetsStarted;
  const homeWidgetsKey = homeWidgetsGateToken
    ? `resume:${homeWidgetsGateToken}:${homeWidgetRecoverySeq}`
    : `base:${homeWidgetRecoverySeq || 0}`;
  const showHomeWidgetsPlaceholder = !homeWidgetsGateOpen;
  const role = String(user?.role || '').trim().toUpperCase();
  const canSeeDispatchBoard = ['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(role);

  useEffect(() => {
    bootLog('home_render_end', {
      path: '/',
      msFromFirstRender: Math.max(0, Date.now() - (renderStartRef.current || Date.now())),
      flags: homeFlags,
    });
  }, [homeFlags]);

  function clearHomeResumeStallTimer() {
    try {
      const timer = resumeStateRef.current?.stallTimer;
      if (timer) window.clearTimeout(timer);
    } catch {}
    if (resumeStateRef.current) resumeStateRef.current.stallTimer = 0;
  }

  function markHomeUiAlive(stage, payload = {}) {
    try {
      const activeToken = Number(payload?.resumeToken || resumeStateRef.current?.token || homeResumeToken || 0) || 0;
      const at = Date.now();
      window.__TEPIHA_HOME_UI_ALIVE__ = true;
      window.__TEPIHA_HOME_UI_ALIVE_AT__ = at;
      window.__TEPIHA_HOME_UI_ALIVE_TOKEN__ = activeToken;
      document?.documentElement?.setAttribute?.('data-home-ui-alive', '1');
      document?.body?.setAttribute?.('data-home-ui-alive', '1');
      document?.documentElement?.setAttribute?.('data-ui-alive', '1');
      document?.body?.setAttribute?.('data-ui-alive', '1');
      markRouteUiAlive(stage || 'home_ui_alive', '/', {
        page: 'home',
        at,
        resumeToken: activeToken,
        widgetsStarted: !!resumeStateRef.current?.widgetsStarted,
        widgetsFinished: !!resumeStateRef.current?.widgetsFinished,
        interactive: (() => {
          try { return window.__TEPIHA_HOME_INTERACTIVE__ === true; } catch { return false; }
        })(),
        ...(payload && typeof payload === 'object' ? payload : {}),
      });
    } catch {}
  }

  function rerunHomeWidgetRecovery(reason = 'retry', extra = {}) {
    if (typeof window === 'undefined') return;
    let visible = true;
    try { visible = document.visibilityState === 'visible'; } catch {}
    if (!visible) return;
    const token = Number(resumeStateRef.current?.token || 0) || 0;
    if (!token) return;
    resumeSeqRef.current = Number(resumeSeqRef.current || 0) + 1;
    const nextSeq = Number(resumeSeqRef.current || 0) || 1;
    setHomeWidgetRecoverySeq(nextSeq);
    setHomeWidgetsStarted(false);
    setHomeWidgetsFinished(false);
    setHomeWidgetsGateToken(0);
    bootLog('home_resume_widgets_recover_retry', {
      path: '/',
      reason,
      token,
      recoverySeq: nextSeq,
      ...(extra || {}),
    });
    window.setTimeout(() => {
      if (resumeStateRef.current?.token !== token) return;
      resumeStateRef.current.widgetsStarted = true;
      setHomeWidgetsStarted(true);
      setHomeWidgetsGateToken(token);
      markHomeUiAlive('home_resume_widgets_recover_restart', { resumeToken: token, recoverySeq: nextSeq, stage: 'widgets_restart' });
      bootLog('home_resume_widgets_recover_restart', {
        path: '/',
        reason,
        token,
        recoverySeq: nextSeq,
      });
    }, 80);
  }

  function maybeCompleteHomeWidgets(token, trigger, extra = {}) {
    try {
      if (!token || token !== resumeStateRef.current?.token) return;
      const stages = widgetStageRef.current || {};
      if (!stages.stats || !stages.popups || !stages.cache) return;
      if (resumeStateRef.current.widgetsFinished) return;
      resumeStateRef.current.widgetsFinished = true;
      clearHomeResumeStallTimer();
      setHomeWidgetsFinished(true);
      markHomeUiAlive('home_resume_widgets_done', { token, trigger, ...extra });
      bootLog('home_resume_widgets_done', {
        path: '/',
        token,
        reason: resumeStateRef.current?.reason || '',
        trigger,
        ...extra,
      });
    } catch {}
  }

  function markHomeWidgetStage(stage, payload = {}) {
    try {
      const token = resumeStateRef.current?.token || 0;
      if (!token || !stage) return;
      widgetStageRef.current = { ...(widgetStageRef.current || {}), [stage]: true };
      maybeCompleteHomeWidgets(token, stage, payload);
    } catch {}
  }

  function startHomeResumeCycle(reason) {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    const activeToken = Number(resumeStateRef.current?.token || 0);
    const activeAcceptedAt = Number(resumeStateRef.current?.acceptedAt || 0);
    const activeRecent = activeToken && (now - activeAcceptedAt) < HOME_RESUME_GUARD_MS;
    if (activeRecent) {
      bootLog('home_resume_skip_duplicate', {
        path: '/',
        reason,
        token: activeToken,
        acceptedAt: activeAcceptedAt,
        ageMs: Math.max(0, now - activeAcceptedAt),
      });
      return;
    }

    clearHomeResumeStallTimer();

    const token = now;
    resumeSeqRef.current = Number(resumeSeqRef.current || 0) + 1;
    const recoverySeq = Number(resumeSeqRef.current || 0) || 1;
    resumeStateRef.current = {
      token,
      acceptedAt: now,
      reason,
      widgetsStarted: false,
      widgetsFinished: false,
      stallTimer: 0,
    };
    widgetStageRef.current = { stats: false, popups: false, cache: false };
    clearHomeShellPaint(reason, token);
    clearHomeUiAlive(reason, token);
    setHomeResumeToken(token);
    setHomeResumeShellPainted(false);
    setHomeWidgetsGateToken(0);
    setHomeWidgetsStarted(false);
    setHomeWidgetsFinished(false);
    setHomeWidgetRecoverySeq(recoverySeq);

    bootLog('home_resume_shell_start', {
      path: '/',
      reason,
      token,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
      online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (resumeStateRef.current?.token !== token) return;
        setHomeResumeShellPainted(true);
        markHomeShellPaint(token, { reason, stage: 'resume_shell_paint' });
        markHomeUiAlive('home_resume_shell_paint', { resumeToken: token, stage: 'shell', recoverySeq });
        bootLog('home_resume_shell_paint', {
          path: '/',
          reason,
          token,
          visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
          online: typeof navigator !== 'undefined' ? navigator.onLine : true,
        });
        window.setTimeout(() => {
          if (resumeStateRef.current?.token !== token) return;
          resumeStateRef.current.widgetsStarted = true;
          setHomeWidgetsStarted(true);
          setHomeWidgetsGateToken(token);
          markHomeUiAlive('home_resume_widgets_start', { resumeToken: token, stage: 'widgets_start', recoverySeq });
          bootLog('home_resume_widgets_start', {
            path: '/',
            reason,
            token,
          });
        }, HOME_RESUME_WIDGET_DELAY_MS);
      });
    });

    resumeStateRef.current.stallTimer = window.setTimeout(() => {
      if (resumeStateRef.current?.token !== token) return;
      bootLog('home_resume_stall_3000ms', {
        path: window.location?.pathname || '/',
        visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
        online: typeof navigator !== 'undefined' ? navigator.onLine : true,
        token,
        lastResumeToken: token,
        widgetsStarted: !!resumeStateRef.current?.widgetsStarted,
        widgetsFinished: !!resumeStateRef.current?.widgetsFinished,
      });
    }, HOME_RESUME_STALL_MS);
  }

  useEffect(() => {
    try {
      window.__TEPIHA_HOME_SAFE_MODE__ = !!homeFlags.safeMode;
      window.__TEPIHA_HOME_SAFE_FLAGS__ = { ...homeFlags };
      window.dispatchEvent(new CustomEvent('tepiha:home-flags', { detail: { ...homeFlags } }));
    } catch {}
  }, [homeFlags]);

  useEffect(() => {
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (cancelled || firstPaintRef.current) return;
        firstPaintRef.current = true;
        markHomeShellPaint(Number(resumeStateRef.current?.token || 0) || 0, { stage: 'initial_shell_paint' });
        markHomeUiAlive('home_first_paint', { resumeToken: Number(resumeStateRef.current?.token || 0) || 0, stage: 'first_paint' });
        const msFromFirstRender = Math.max(0, Date.now() - (renderStartRef.current || Date.now()));
        if (!shellReadyLoggedRef.current) {
          shellReadyLoggedRef.current = true;
          bootLog('home_shell_render_done', { path: '/', msFromFirstRender });
        }
        bootLog('home_first_paint', { path: '/', msFromFirstRender });
        bootLog('home_shell_ready', { path: '/', page: 'home', source: 'home_page', msFromFirstRender });
      });
    });

    return () => {
      cancelled = true;
      try { window.cancelAnimationFrame(raf1); } catch {}
      try { window.cancelAnimationFrame(raf2); } catch {}
    };
  }, []);

  useEffect(() => {
    setMountedLite(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanupIdle = null;

    const runInteractive = () => {
      if (cancelled || firstInteractiveRef.current) return;
      firstInteractiveRef.current = true;
      try {
        window.__TEPIHA_HOME_INTERACTIVE__ = true;
        window.__TEPIHA_HOME_INTERACTIVE_AT__ = Date.now();
        window.dispatchEvent(new CustomEvent('tepiha:home-interactive', { detail: { ts: Date.now() } }));
      } catch {}
      markHomeUiAlive('home_first_interactive', { resumeToken: Number(resumeStateRef.current?.token || 0) || 0, interactive: true, stage: 'interactive' });
      bootLog('home_first_interactive', {
        path: '/',
        msFromFirstRender: Math.max(0, Date.now() - (renderStartRef.current || Date.now())),
      });
    };

    cleanupIdle = scheduleIdleWork(runInteractive, 1500);

    return () => {
      cancelled = true;
      try { cleanupIdle?.(); } catch {}
    };
  }, []);

  useEffect(() => {
    clearHomeResumeStallTimer();
    setHomeResumeToken(0);
    setHomeResumeShellPainted(true);
    setHomeWidgetsGateToken(0);
    setHomeWidgetsStarted(true);
    setHomeWidgetsFinished(true);
    setHomeWidgetRecoverySeq(0);
    markHomeShellPaint(0, { stage: 'initial_ready' });
    markHomeUiAlive('home_initial_ready', { resumeToken: 0, stage: 'initial_ready' });
    return () => {
      clearHomeResumeStallTimer();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return undefined;
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = Number(entry?.duration || 0);
          if (duration >= 60) {
            bootLog('home_longtask_detected', {
              path: '/',
              duration,
              name: String(entry?.name || 'longtask'),
              startTime: Number(entry?.startTime || 0),
            });
          }
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {}
    return () => {
      try { observer?.disconnect?.(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let lastResumeToken = '';
    let lastResumeAt = 0;

    const readHiddenAt = () => {
      let hiddenAt = 0;
      try { hiddenAt = Number(window.__tepihaLastHiddenAt || 0) || 0; } catch {}
      if (!hiddenAt) {
        try { hiddenAt = Number(window.localStorage?.getItem('tepiha_last_hidden_at_v3') || 0) || 0; } catch {}
      }
      return hiddenAt;
    };

    const logPassiveResume = (reason, extra = {}) => {
      const hiddenAt = readHiddenAt();
      const hiddenElapsedMs = hiddenAt ? Math.max(0, Date.now() - hiddenAt) : 0;
      bootLog('home_resume_listener_passive', {
        path: '/',
        reason,
        hiddenElapsedMs,
        ...(extra || {}),
      });
      return { hiddenAt, hiddenElapsedMs };
    };

    const requestResume = (reason, extra = {}) => {
      let visible = true;
      try { visible = document.visibilityState === 'visible'; } catch {}
      if (!visible) return;
      const { hiddenAt, hiddenElapsedMs } = logPassiveResume(reason, extra);
      const token = hiddenAt ? `hidden:${hiddenAt}` : `burst:${Math.floor(Date.now() / 900)}`;
      const now = Date.now();
      if (token === lastResumeToken && Math.max(0, now - lastResumeAt) < 1200) return;
      lastResumeToken = token;
      lastResumeAt = now;
      bootLog('home_resume_request', {
        path: '/',
        reason,
        token,
        hiddenElapsedMs,
        ...(extra || {}),
      });
      startHomeResumeCycle(reason);
    };

    const onPageShow = (event) => requestResume('pageshow', { persisted: !!event?.persisted });
    const onFocus = () => requestResume('focus');
    const onVisible = () => {
      try {
        if (document.visibilityState !== 'visible') return;
      } catch {}
      requestResume('visibility_visible');
    };
    const onRootResume = (event) => requestResume(String(event?.detail?.reason || 'root_resume'), event?.detail && typeof event.detail === 'object' ? event.detail : {});
    const onRootResumeStall = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      if (String(detail?.path || '/') !== '/') return;
      const activeToken = Number(resumeStateRef.current?.token || 0) || 0;
      const detailUiToken = Number(detail?.uiToken || 0) || 0;
      const detailToken = Number(detail?.token || 0) || 0;
      if (detailUiToken && activeToken && detailUiToken !== activeToken && detailToken !== activeToken) return;
      rerunHomeWidgetRecovery(String(detail?.reason || 'root_resume_stall'), detail);
    };

    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });
    window.addEventListener('tepiha:root-resume', onRootResume, { passive: true });
    window.addEventListener('tepiha:root-resume-stall', onRootResumeStall, { passive: true });
    document.addEventListener('visibilitychange', onVisible, { passive: true });

    return () => {
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { window.removeEventListener('focus', onFocus); } catch {}
      try { window.removeEventListener('tepiha:root-resume', onRootResume); } catch {}
      try { window.removeEventListener('tepiha:root-resume-stall', onRootResumeStall); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
    };
  }, []);


  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!homeWidgetsGateOpen) return undefined;
    if (!homeWidgetsGateToken) return undefined;
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (cancelled) return;
        markHomeUiAlive('home_widgets_paint', { resumeToken: Number(homeWidgetsGateToken || 0) || 0, recoverySeq: homeWidgetRecoverySeq, stage: 'widgets_paint' });
        markHomeWidgetStage('stats', { source: 'widgets_paint', recoverySeq: homeWidgetRecoverySeq });
      });
    });
    return () => {
      cancelled = true;
      try { window.cancelAnimationFrame(raf1); } catch {}
      try { window.cancelAnimationFrame(raf2); } catch {}
    };
  }, [homeWidgetsGateOpen, homeWidgetsGateToken, homeWidgetRecoverySeq]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!homeWidgetsGateOpen) return undefined;
    if (!homeWidgetsGateToken) return undefined;
    let cancelled = false;
    const cleanupIdle = scheduleIdleWork(() => {
      if (cancelled) return;
      markHomeUiAlive('home_widgets_idle', { resumeToken: Number(homeWidgetsGateToken || 0) || 0, recoverySeq: homeWidgetRecoverySeq, stage: 'widgets_idle' });
      markHomeWidgetStage('cache', { source: 'widgets_idle', recoverySeq: homeWidgetRecoverySeq });
    }, 240);
    return () => {
      cancelled = true;
      try { cleanupIdle?.(); } catch {}
    };
  }, [homeWidgetsGateOpen, homeWidgetsGateToken, homeWidgetRecoverySeq]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!homeWidgetsGateOpen) return undefined;
    if (!homeWidgetsGateToken) return undefined;
    const timer = window.setTimeout(() => {
      markHomeUiAlive('home_widgets_stable', { resumeToken: Number(homeWidgetsGateToken || 0) || 0, recoverySeq: homeWidgetRecoverySeq, stage: 'widgets_stable' });
      markHomeWidgetStage('popups', { source: 'widgets_stable', recoverySeq: homeWidgetRecoverySeq });
    }, 140);
    return () => {
      try { window.clearTimeout(timer); } catch {}
    };
  }, [homeWidgetsGateOpen, homeWidgetsGateToken, homeWidgetRecoverySeq]);

  useEffect(() => {
    if (!mountedLite) return undefined;
    try {
      const actor = getActor() || null;
      setUser(actor);
      setHomeWidgetsStarted(true);
      setHomeWidgetsFinished(true);
      setHomeResumeShellPainted(true);
      setHomeResumeToken(0);
      setHomeWidgetsGateToken(0);
      bootLog('home_static_actor_loaded', { path: '/', hasActor: !!actor });
    } catch (error) {
      bootLog('home_static_actor_error', { path: '/', error: String(error?.message || error || 'unknown_error') });
    }
    return undefined;
  }, [mountedLite]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const bumpSettled = (reason = 'event') => {
      try {
        setRootRuntimeSettledTick((v) => v + 1);
        bootLog('home_runtime_settled_seen', {
          path: '/',
          reason,
          settled: window.__TEPIHA_ROOT_RUNTIME_SETTLED__ === true,
        });
      } catch {}
    };

    const onSettled = () => bumpSettled('event');

    try {
      if (window.__TEPIHA_ROOT_RUNTIME_SETTLED__ === true) {
        bumpSettled('already_true');
      }
    } catch {}

    window.addEventListener('tepiha:root-runtime-settled', onSettled, { passive: true });

    return () => {
      try { window.removeEventListener('tepiha:root-runtime-settled', onSettled); } catch {}
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (finalUiReadyRef.current) return undefined;
    if (!firstPaintRef.current) return undefined;
    if (!mountedLite) return undefined;

    let timer = 0;

    const tryMarkReady = (source = 'check') => {
      if (finalUiReadyRef.current) return true;
      try {
        if (document.visibilityState !== 'visible') return false;
      } catch {
        return false;
      }
      const runtimeSettled = (() => {
        try { return window.__TEPIHA_ROOT_RUNTIME_SETTLED__ === true; } catch { return false; }
      })();
      if (!runtimeSettled && source !== 'fallback') return false;
      if (!runtimeSettled && source === 'fallback') {
        try {
          window.__TEPIHA_ROOT_RUNTIME_SETTLED__ = true;
          window.dispatchEvent(new CustomEvent('tepiha:root-runtime-settled', {
            detail: { reason: 'home_fallback_ready', at: Date.now() },
          }));
        } catch {}
        bootLog('home_runtime_settled_fallback', { path: '/', source });
      }

      finalUiReadyRef.current = true;
      markHomeUiReady({ resumeToken: Number(resumeStateRef.current?.token || 0) || 0, stage: 'final_ui_ready', source });
      markHomeUiAlive('home_final_ui_ready', { resumeToken: Number(resumeStateRef.current?.token || 0) || 0, stage: 'final_ui_ready', source });
      const msFromFirstRender = Math.max(0, Date.now() - (renderStartRef.current || Date.now()));
      bootLog('first_ui_ready', { path: '/', page: 'home', source: runtimeSettled ? 'home_runtime_settled_ready' : 'home_runtime_settled_fallback', msFromFirstRender });
      bootLog('ui_ready', { path: '/', page: 'home', source: runtimeSettled ? 'home_runtime_settled_ready' : 'home_runtime_settled_fallback', msFromFirstRender });
      return true;
    };

    if (tryMarkReady('check')) return undefined;

    timer = window.setTimeout(() => {
      tryMarkReady('fallback');
    }, 2200);

    return () => {
      try { if (timer) window.clearTimeout(timer); } catch {}
    };
  }, [mountedLite, homeResumeToken, rootRuntimeSettledTick]);

  useEffect(() => {
    if (!mountedLite) return undefined;
    let cancelled = false;
    let idleId = null;
    let timerId = null;

    async function runWarmup() {
      if (cancelled) return;
      try {
        const { getActorPin, ensureBasePool } = await import('@/lib/baseCodes');
        const pin = getActorPin();
        if (!pin || cancelled) return;
        void ensureBasePool(pin);
      } catch {}
    }

    timerId = window.setTimeout(() => {
      if (cancelled) return;
      try {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      } catch {}
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => { void runWarmup(); }, { timeout: 4000 });
      } else {
        idleId = window.setTimeout(() => { void runWarmup(); }, 600);
      }
    }, 18000);

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
      if (idleId && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      } else if (idleId) {
        window.clearTimeout(idleId);
      }
    };
  }, []);


  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState([]);
  const [didSearch, setDidSearch] = useState(false);
  const gatiHoldTimerRef = useRef(null);
  const gatiHiddenTriggeredRef = useRef(false);
  const debugHoldTimerRef = useRef(null);
  const searchAbortRef = useRef(null);

  const parsed = useMemo(() => normCode(q), [q]);


function clearGatiGestureState() {
  if (gatiHoldTimerRef.current) {
    window.clearTimeout(gatiHoldTimerRef.current);
    gatiHoldTimerRef.current = null;
  }
}

function clearDebugGestureState() {
  if (debugHoldTimerRef.current) {
    window.clearTimeout(debugHoldTimerRef.current);
    debugHoldTimerRef.current = null;
  }
}

function openGatiHidden(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  clearGatiGestureState();
}

function openDebugHidden(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  clearDebugGestureState();
  navigateDocument('/debug');
}

function startGatiHiddenPress() {
  if (gatiHoldTimerRef.current) window.clearTimeout(gatiHoldTimerRef.current);
  gatiHoldTimerRef.current = window.setTimeout(() => {
    openGatiHidden();
  }, GATI_HOLD_MS);
}

function startDebugHiddenPress(event) {
  if (debugHoldTimerRef.current) window.clearTimeout(debugHoldTimerRef.current);
  debugHoldTimerRef.current = window.setTimeout(() => {
    openDebugHidden(event);
  }, DEBUG_HOLD_MS);
}

function cancelGatiHiddenPress() {
  if (gatiHoldTimerRef.current) {
    window.clearTimeout(gatiHoldTimerRef.current);
    gatiHoldTimerRef.current = null;
  }
}

function cancelDebugHiddenPress() {
  if (debugHoldTimerRef.current) {
    window.clearTimeout(debugHoldTimerRef.current);
    debugHoldTimerRef.current = null;
  }
}

function navigateDocument(href) {
  const target = String(href || '').trim();
  if (!target) return;
  try {
    const parsed = new URL(target, window.location.origin);
    if (parsed.origin === window.location.origin) {
      const nextPath = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}` || '/';
      router.push(nextPath);
      return;
    }
  } catch {}
  try {
    window.location.assign(target);
    return;
  } catch {}
  router.push(target);
}

function openGatiSafe() {
  clearGatiGestureState();
  navigateDocument('/gati');
}

function handleGatiCardClick(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();

  if (gatiHiddenTriggeredRef.current) {
    gatiHiddenTriggeredRef.current = false;
    return;
  }

  openGatiSafe();
}

  function handleCreateNewForClient(order, e){
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const name = String(order?.name || '').trim();
    const phone = String(order?.phone || '').trim();
    const code = String(order?.code || '').trim();
    router.push('/pranimi?name=' + encodeURIComponent(name) + '&phone=' + encodeURIComponent(phone) + '&code=' + encodeURIComponent(code));
  }

  async function runSearch(e){
    e?.preventDefault?.();
    setErr('');
    setResults([]);
    setDidSearch(false);

    const qRaw = String(q || '').trim();
    const qLower = qRaw.toLowerCase();

    if (qLower === 'offline' || qLower === '/offline' || qLower === 'offline.html' || qLower === '/offline.html') {
      router.push('/offline.html');
      return;
    }

    const kind = parsed.kind;
    const raw = parsed.raw;

    if(!qRaw){
      setErr('SHKRUAJ KODIN, EMRIN OSE TELEFONIN.');
      return;
    }

    if (kind === 'T' && raw) {
      router.push(`/transport/item?code=${encodeURIComponent(String(raw).toUpperCase())}&from=home_search`);
      return;
    }

    try { searchAbortRef.current?.abort?.(); } catch {}
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    searchAbortRef.current = controller;

    const isAbortError = (error) => {
      const code = String(error?.code || '').toUpperCase();
      return error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'SEARCH_ABORTED' || /abort/i.test(String(error?.message || ''));
    };

    const transporterNameFor = async (rows) => {
      const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => String(row?._table || '') === 'transport_orders');
      if (!safeRows.length) return new Map();
      const refs = collectTransportRefs(safeRows);
      if (!refs.length) return new Map();
      return fetchTransporterNamesByRefs(refs, {
        signal: controller?.signal,
        timeoutMs: HOME_SEARCH_TIMEOUT_MS,
        timeoutLabel: 'SUPABASE_TIMEOUT',
      });
    };

    const exactCachedResults = readHomeSearchCache(qRaw);
    let hadLocalResults = false;
    if (exactCachedResults.length) {
      setResults(exactCachedResults);
      setDidSearch(true);
      hadLocalResults = true;
    }

    setLoading(true);
    try{
      const localResults = await runLocalSearchFallback(qRaw, parsed);
      if (searchAbortRef.current === controller && localResults.length) {
        hadLocalResults = true;
        setResults(localResults);
        setDidSearch(true);
        writeHomeSearchCache(qRaw, localResults);
      }
      const isNumericOnly = /^\d+$/.test(qRaw);
      const searchLower = qRaw.toLowerCase();

      if (isNumericOnly && qRaw.length <= 4 && Number(raw) > 0) {
        const n = Number(raw) || 0;
        const { listOrderRecords } = await import('@/lib/ordersService');
        const data = await listOrderRecords('orders', {
          select: 'id,code,status,client_name,client_phone,data,updated_at',
          eq: { code: n },
          orderBy: 'updated_at',
          ascending: false,
          limit: 20,
          signal: controller?.signal,
          timeoutMs: HOME_SEARCH_TIMEOUT_MS,
          timeoutLabel: 'SUPABASE_TIMEOUT',
        });
        const rows = (Array.isArray(data) ? data : []).map((row) => ({ ...row, _table: 'orders' }));
        const out = dedupeSearchResults(rows.map((r) => mapRowToSearchResult(r)));
        setResults(out);
        setDidSearch(true);
        writeHomeSearchCache(qRaw, out);

        if (rows.length) {
          void transporterNameFor(rows).then((transporterNames) => {
            if (searchAbortRef.current !== controller) return;
            const enriched = dedupeSearchResults(rows.map((r) => mapRowToSearchResult(r, transporterNames)));
            setResults(enriched);
            writeHomeSearchCache(qRaw, enriched);
          }).catch(() => {});
        }
        return;
      }

      const { supabase } = await import('@/lib/supabaseClient');
      const token = cleanSearchToken(qRaw);
      const digits = onlyDigits(qRaw);

      const applyAbortAndTimeout = (query) => {
        let next = query;
        if (controller?.signal && typeof next?.abortSignal === 'function') next = next.abortSignal(controller.signal);
        if (Number(HOME_SEARCH_TIMEOUT_MS) > 0 && typeof next?.timeout === 'function') {
          next = next.timeout(Number(HOME_SEARCH_TIMEOUT_MS), 'SUPABASE_TIMEOUT');
        }
        return next;
      };

      const baseOrParts = [];
      if (token) {
        baseOrParts.push(`client_name.ilike.%${token}%`);
      }
      if (digits.length >= 3) {
        baseOrParts.push(`client_phone.ilike.%${digits}%`);
      }

      const baseQuery = applyAbortAndTimeout(
        supabase
          .from('orders')
          .select('id,code,status,client_name,client_phone,data,updated_at')
          .order('updated_at', { ascending: false })
          .limit(24)
      );

      const { data: baseRowsRaw, error: baseError } = await (baseOrParts.length ? baseQuery.or(baseOrParts.join(',')) : baseQuery);
      if (baseError) throw baseError;

      const mergedRows = ((Array.isArray(baseRowsRaw) ? baseRowsRaw : []).map((row) => ({ ...row, _table: 'orders' })));
      const filteredRows = mergedRows.filter((r) => matchesUniversal(r, searchLower)).slice(0, HOME_SEARCH_MAX_RESULTS);
      const out = dedupeSearchResults(filteredRows.map((r) => mapRowToSearchResult(r)));
      setResults(out);
      setDidSearch(true);
      writeHomeSearchCache(qRaw, out);

    }catch(ex){
      if (!isAbortError(ex) && !hadLocalResults) {
        setErr(String(ex?.message || ex || 'GABIM NE SEARCH'));
      }
    }finally{
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
      }
      setLoading(false);
    }
  }


useEffect(() => {
  return () => {
    try {
      if (gatiHoldTimerRef.current) window.clearTimeout(gatiHoldTimerRef.current);
      if (debugHoldTimerRef.current) window.clearTimeout(debugHoldTimerRef.current);
      searchAbortRef.current?.abort?.();
      searchAbortRef.current = null;
    } catch {}
  };
}, []);

  const showNoResults = didSearch && !loading && !err && (!Array.isArray(results) || results.length === 0) && String(q || '').trim();

  return (
    <div className="home-wrap">
      {/* HEADER */}
      <header className="header-pro">
        <div className="header-text">
          <h1
            className="title"
            onTouchStart={startDebugHiddenPress}
            onTouchEnd={cancelDebugHiddenPress}
            onTouchCancel={cancelDebugHiddenPress}
            onPointerDown={startDebugHiddenPress}
            onPointerUp={cancelDebugHiddenPress}
            onPointerLeave={cancelDebugHiddenPress}
            onContextMenu={(e) => e.preventDefault()}
            style={{ cursor: 'default' }}
          >TEPIHA <span style={{color: '#3b82f6'}}>PRO</span></h1>
        </div>
      </header>

      {showHomeShellPlaceholder ? (
        <section className="home-shell-placeholder" aria-hidden="true">
          <div className="shell-card shell-card-wide">
            <div className="shell-line shell-line-lg" />
            <div className="shell-line shell-line-sm" />
          </div>
          <div className="shell-card">
            <div className="shell-line shell-line-md" />
            <div className="shell-line shell-line-xs" />
          </div>
          <div className="shell-card">
            <div className="shell-line shell-line-md" />
            <div className="shell-line shell-line-xs" />
          </div>
        </section>
      ) : null}

      {showHomeWidgetsPlaceholder ? (
        <section className="home-shell-placeholder" aria-hidden="true">
          <div className="shell-card shell-card-wide">
            <div className="shell-line shell-line-lg" />
            <div className="shell-line shell-line-sm" />
          </div>
          <div className="shell-card">
            <div className="shell-line shell-line-md" />
            <div className="shell-line shell-line-xs" />
          </div>
        </section>
      ) : null}

      {homeWidgetsGateOpen ? (
        <div key={homeWidgetsKey} data-home-widgets-root="1">
      {/* SEARCH SECTION */}
      <section className="search-section">
        <h2 className="section-title">🔍 KËRKO POROSINË</h2>
        <form className="search-box" onSubmit={runSearch}>
          <input
            className="search-input"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            placeholder="Shkruaj kodin, emrin ose telefonin"
            inputMode="text"
            autoComplete="off"
          />
          <button className="search-btn" type="submit" disabled={loading}>
            {loading ? 'DUKE KËRKUAR...' : 'KËRKO'}
          </button>
        </form>

        {err && <div className="error-msg">{err}</div>}
        {showNoResults && (
          <div className="empty-msg">
            NUK U GJET ASNJË POROSI PËR KËTË KËRKIM.
          </div>
        )}

        {/* REZULTATET E KËRKIMIT */}
        {results?.length ? (
          <HomeSectionBoundary
            section="search_results"
            fallback={<div className="empty-msg">REZULTATET NUK U SHFAQËN. PROVO PËRSËRI.</div>}
          >
            <div className="results-container">
            {results.map((r, idx) => {
              const href = (r.kind === 'T')
                ? (`${r.id ? `/transport/item?id=${encodeURIComponent(String(r.id||''))}&src=transport` : `/transport/menu`}`)
                : (`${routeForStatus(r.status)}?q=${encodeURIComponent(String(r.code||''))}&openId=${encodeURIComponent(String(r.id || ''))}&exact=1`);
              const finalHref = href + (href.includes('?') ? '&' : '?') + 'from=search';

              return (
                <div
                  key={r.id || idx}
                  className="result-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigateDocument(finalHref)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigateDocument(finalHref);
                    }
                  }}
                >
                  <div className="result-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* KODI JESHIL PA # */}
                      <span className="code-badge">{String(r.code||'')}</span>
                      <span className="status-badge" style={getStatusStyle(r.status)}>
                        {String(r.status||'PA STATUS').toUpperCase()}
                      </span>
                    </div>
                    {/* SA TEPIHA */}
                    <div className="pieces-badge">📦 {r.pieces} Copë</div>
                  </div>

                  <div className="result-body">
                    <div className="client-name">{String(r.name||'Klient i panjohur')}</div>
                    {r.phone && <div className="client-phone">📞 {String(r.phone||'')}</div>}
                  </div>

                  <div className="result-footer">
                    <div className="workers-info">
                      {r.createdBy && <div>👤 <span>SJELLË NGA:</span> {String(r.createdBy)}</div>}
                      {r.transporter && <div style={{color: '#f59e0b'}}>🚚 <span>PRU NGA:</span> {String(r.transporter).toUpperCase()}</div>}
                    </div>
                    <div className="result-actions">
                      {(String(r.status || '').toLowerCase() === 'dorzim' || String(r.status || '').toLowerCase() === 'dorzuar') && (
                        <button className="new-order-btn" onClick={(e) => handleCreateNewForClient(r, e)}>
                          ➕ KRIJO POROSI TË RE PËR KËTË KLIENT
                        </button>
                      )}
                      <div className="go-btn">HAP ➔</div>
                    </div>
                  </div>
                </div>
              );
            })}
            </div>
          </HomeSectionBoundary>
        ) : null}
      </section>

      {/* NAVIGATION GRID */}
      <section className="modules-section">
        <h2 className="section-title">⚙️ ZGJEDH MODULIN</h2>

        <div className="modules-grid">
          <Link href="/pranimi?fresh=1" prefetch={false} className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa'}}>🧾</div>
            <div className="mod-info">
              <div className="mod-title">PRANIMI</div>
              <div className="mod-sub">Regjistro klientin</div>
            </div>
          </Link>

          <Link href="/pastrimi" prefetch={false} className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(16, 185, 129, 0.15)', color: '#34d399'}}>🧼</div>
            <div className="mod-info">
              <div className="mod-title">PASTRIMI</div>
              <div className="mod-sub">Lista e larjes</div>
            </div>
          </Link>

          <div
            className="mod-card"
            role="link"
            tabIndex={0}
            aria-label="GATI"
            onClick={handleGatiCardClick}
            onTouchStart={startGatiHiddenPress}
            onTouchEnd={cancelGatiHiddenPress}
            onTouchCancel={cancelGatiHiddenPress}
            onPointerDown={startGatiHiddenPress}
            onPointerUp={cancelGatiHiddenPress}
            onPointerLeave={cancelGatiHiddenPress}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openGatiSafe();
              }
            }}
          >
            <div className="mod-icon" style={{background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24'}}>✅</div>
            <div className="mod-info">
              <div className="mod-title">GATI</div>
              <div className="mod-sub">Gati për dorëzim</div>
            </div>
          </div>

          <Link href="/marrje-sot" prefetch={false} className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(239, 68, 68, 0.15)', color: '#f87171'}}>📦</div>
            <div className="mod-info">
              <div className="mod-title">MARRJE SOT</div>
              <div className="mod-sub">Porositë e sotme</div>
            </div>
          </Link>

          <Link href="/transport" prefetch={false} className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(139, 92, 246, 0.15)', color: '#a78bfa'}}>🚚</div>
            <div className="mod-info">
              <div className="mod-title">TRANSPORT</div>
              <div className="mod-sub">Porositë (T-kode)</div>
            </div>
          </Link>

          <Link href="/arka" prefetch={false} className="mod-card">
            <div className="mod-icon" style={{background: 'rgba(236, 72, 153, 0.15)', color: '#f472b6'}}>💰</div>
            <div className="mod-info">
              <div className="mod-title">ARKA</div>
              <div className="mod-sub">Mbyllja e ditës</div>
            </div>
          </Link>

          {mountedLite ? (
            <HomeSectionBoundary section="secondary_modules" fallback={null}>
              <>
                {canSeeDispatchBoard ? (
                  <Link href="/dispatch" prefetch={false} className="mod-card dispatch-card">
                    <div className="mod-icon dispatch-icon">🛰️</div>
                    <div className="mod-info">
                      <div className="mod-title">DISPATCH BOARD</div>
                      <div className="mod-sub">Kulla e kontrollit për flotën, porositë dhe cash-in</div>
                    </div>
                  </Link>
                ) : null}

                <Link href="/llogaria-ime" prefetch={false} className="mod-card account-card">
                  <div className="mod-icon account-icon">👤</div>
                  <div className="mod-info">
                    <div className="mod-title">LLOGARIA IME</div>
                    <div className="mod-sub">Rroga, avanset, borxhet dhe cash-i yt</div>
                  </div>
                </Link>

                <Link href="/fletore" prefetch={false} className="mod-card" style={{ gridColumn: '1 / -1' }}>
                  <div className="mod-icon" style={{background: 'rgba(255, 255, 255, 0.1)', color: '#e2e8f0'}}>📒</div>
                  <div className="mod-info">
                    <div className="mod-title">FLETORJA</div>
                    <div className="mod-sub">Arkiva e plotë e porosive dhe detajet</div>
                  </div>
                </Link>
              </>
            </HomeSectionBoundary>
          ) : (
            <>
              <div className="mod-card shell-module-card" aria-hidden="true">
                <div className="mod-icon shell-module-icon">•</div>
                <div className="mod-info">
                  <div className="mod-title">DUKE U HAPUR...</div>
                  <div className="mod-sub">Modulet shtesë po vijnë pas hapjes së shell-it.</div>
                </div>
              </div>
              <div className="mod-card shell-module-card" aria-hidden="true">
                <div className="mod-icon shell-module-icon">•</div>
                <div className="mod-info">
                  <div className="mod-title">JU LUTEM PRITNI</div>
                  <div className="mod-sub">Shell-i bazë i HOME është gati.</div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
        </div>
      ) : null}

      {/* STYLES */}
      <style jsx>{`
        .home-wrap { padding: 16px 14px 40px; background: #070b14; min-height: 100vh; color: #fff; font-family: system-ui, -apple-system, sans-serif; }

        .header-pro { display: flex; justify-content: flex-start; align-items: center; margin-bottom: 24px; }
        .header-text .title { font-size: 26px; font-weight: 1000; letter-spacing: -0.5px; margin: 0; line-height: 1.1; }
        .home-shell-placeholder { display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 10px; margin-bottom: 16px; }
        .shell-card { min-height: 68px; border-radius: 16px; background: linear-gradient(145deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.06); padding: 12px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
        .shell-card-wide { min-height: 72px; }
        .shell-line { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.08); }
        .shell-line-lg { width: 78%; height: 12px; }
        .shell-line-md { width: 66%; }
        .shell-line-sm { width: 48%; }
        .shell-line-xs { width: 34%; height: 8px; }

        .section-title { font-size: 13px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,0.5); margin-bottom: 12px; margin-left: 4px; }

        .search-section { margin-bottom: 28px; }
        .search-box { display: flex; gap: 8px; }
        .search-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 14px 16px; color: #fff; font-size: 16px; font-weight: 700; outline: none; transition: 0.2s; }
        .search-input:focus { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
        .search-btn { background: #3b82f6; color: #fff; border: none; border-radius: 14px; padding: 0 20px; font-weight: 900; font-size: 14px; letter-spacing: 0.5px; cursor: pointer; }
        .error-msg { margin-top: 10px; color: #fca5a5; background: rgba(239,68,68,0.15); padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 800; border: 1px solid rgba(239,68,68,0.3); }
        .empty-msg { margin-top: 10px; color: #cbd5e1; background: rgba(255,255,255,0.06); padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 800; border: 1px solid rgba(255,255,255,0.12); }

        .results-container { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
        .result-card { background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 16px; text-decoration: none; color: #fff; display: flex; flex-direction: column; gap: 12px; transition: transform 0.1s; cursor: pointer; outline: none; }
        .result-card:active { transform: scale(0.98); background: rgba(255,255,255,0.08); }
        .result-header { display: flex; justify-content: space-between; align-items: center; }
        .code-badge { background: #10b981; color: #000; font-size: 18px; font-weight: 900; padding: 4px 12px; border-radius: 8px; letter-spacing: 0.5px; }
        .status-badge { font-size: 11px; font-weight: 900; padding: 4px 10px; border-radius: 6px; letter-spacing: 0.5px; }
        .pieces-badge { font-size: 13px; font-weight: 800; color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 8px; }

        .result-body { display: flex; flex-direction: column; gap: 4px; }
        .client-name { font-size: 17px; font-weight: 800; }
        .client-phone { font-size: 14px; color: rgba(255,255,255,0.6); font-weight: 600; }

        .result-footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px; }
        .workers-info { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: #60a5fa; }
        .workers-info span { opacity: 0.6; color: #fff; margin-right: 2px; }
        .result-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
        .new-order-btn { background: linear-gradient(180deg, rgba(16,185,129,0.22), rgba(16,185,129,0.12)); color: #d1fae5; border: 1px solid rgba(16,185,129,0.45); border-radius: 12px; padding: 10px 12px; font-size: 11px; font-weight: 900; letter-spacing: 0.2px; text-align: center; cursor: pointer; max-width: 240px; }
        .go-btn { background: #3b82f6; color: #fff; font-weight: 900; padding: 8px 16px; border-radius: 10px; font-size: 13px; }

        .modules-section { margin-top: 10px; }
        .modules-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .mod-card { background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 16px; text-decoration: none; color: #fff; display: flex; flex-direction: column; gap: 14px; transition: transform 0.1s, border-color 0.2s; }
        .mod-card:active { transform: scale(0.96); border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); }
        .dispatch-card { background: linear-gradient(145deg, rgba(22,24,33,0.98) 0%, rgba(35,39,58,0.98) 45%, rgba(71,85,105,0.92) 100%); border: 1px solid rgba(148,163,184,0.24); box-shadow: 0 10px 28px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.05); }
        .dispatch-card:active { background: linear-gradient(145deg, rgba(28,31,43,1) 0%, rgba(44,49,70,1) 50%, rgba(71,85,105,0.98) 100%); border-color: rgba(148,163,184,0.42); }
        .dispatch-icon { background: linear-gradient(180deg, rgba(129,140,248,0.24), rgba(59,130,246,0.18)); color: #dbeafe; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); }
        .account-card { background: linear-gradient(145deg, rgba(24,24,38,0.98) 0%, rgba(34,33,58,0.98) 48%, rgba(59,130,246,0.18) 100%); border: 1px solid rgba(99,102,241,0.26); box-shadow: 0 10px 28px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04); }
        .account-card:active { background: linear-gradient(145deg, rgba(30,30,46,1) 0%, rgba(40,39,70,1) 52%, rgba(59,130,246,0.24) 100%); border-color: rgba(129,140,248,0.42); }
        .account-icon { background: linear-gradient(180deg, rgba(99,102,241,0.24), rgba(59,130,246,0.18)); color: #dbeafe; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); }
        .mod-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
        .shell-module-card { opacity: 0.82; border-style: dashed; }
        .shell-module-icon { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55); }
        .mod-info { display: flex; flex-direction: column; gap: 4px; }
        .mod-title { font-weight: 900; font-size: 14px; letter-spacing: 0.5px; }
        .mod-sub { font-size: 11px; font-weight: 600; opacity: 0.5; line-height: 1.3; }
      `}</style>
    </div>
  );
}
