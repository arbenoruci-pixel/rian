'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { markRouteAlive, markRouteUiAlive } from '@/lib/routeAlive';

export const dynamic = 'force-dynamic';

const KEYS = {
  currentBootId: 'tepiha_boot_current_id',
  inProgress: 'tepiha_boot_in_progress',
  lastSuccess: 'tepiha_boot_last_success',
  lastInterrupted: 'tepiha_boot_last_interrupted',
  history: 'tepiha_boot_trace_last',
  simpleState: 'tepiha_simple_incident_state_v1',
  simpleLastIncident: 'tepiha_simple_last_incident_v1',
  fallbackLogs: 'tepiha_diag_fallback_logs_v2',
  pendingQueue: 'tepiha_runtime_incident_queue_v1',
  sent: 'tepiha_simple_incident_sent_v2',
  panicSnapshot: 'tepiha_root_resume_panic_v1',
  panicSnapshotSession: 'tepiha_root_resume_panic_session_v1',
  authTrace: 'tepiha_authgate_trace_v1',
  authTraceSession: 'tepiha_authgate_trace_session_v1',
  routeTransition: 'tepiha_route_transition_v1',
};

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readStoragePair(key) {
  if (typeof window === 'undefined') return { session: null, local: null };
  let session = null;
  let local = null;
  try { session = window.sessionStorage?.getItem(key) ?? null; } catch {}
  try { local = window.localStorage?.getItem(key) ?? null; } catch {}
  return { session, local };
}

function afterPaint(fn) {
  try {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } catch {
    window.setTimeout(fn, 0);
  }
}

function readState() {
  if (typeof window === 'undefined') {
    return {
      now: null,
      href: null,
      userAgent: null,
      online: null,
      visibilityState: null,
      keys: {},
      raw: {},
    };
  }

  const currentBootId = readStoragePair(KEYS.currentBootId);
  const inProgress = readStoragePair(KEYS.inProgress);
  const lastSuccess = readStoragePair(KEYS.lastSuccess);
  const lastInterrupted = readStoragePair(KEYS.lastInterrupted);
  const history = readStoragePair(KEYS.history);
  const simpleState = readStoragePair(KEYS.simpleState);
  const simpleLastIncident = readStoragePair(KEYS.simpleLastIncident);
  const fallbackLogs = readStoragePair(KEYS.fallbackLogs);
  const pendingQueue = readStoragePair(KEYS.pendingQueue);
  const sent = readStoragePair(KEYS.sent);
  const panicSnapshot = {
    session: safeParse(readStoragePair(KEYS.panicSnapshotSession).session, null),
    local: safeParse(readStoragePair(KEYS.panicSnapshot).local, null),
  };
  const authTrace = {
    session: safeParse(readStoragePair(KEYS.authTraceSession).session, null),
    local: safeParse(readStoragePair(KEYS.authTrace).local, null),
  };
  const routeTransition = {
    session: safeParse(readStoragePair(KEYS.routeTransition).session, null),
    local: safeParse(readStoragePair(KEYS.routeTransition).local, null),
  };

  return {
    now: new Date().toISOString(),
    href: String(window.location?.href || ''),
    path: String(window.location?.pathname || ''),
    search: String(window.location?.search || ''),
    referrer: String(document.referrer || ''),
    userAgent: String(navigator.userAgent || ''),
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
    appEpoch: (() => {
      try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; }
    })(),
    summary: {
      currentBootId: currentBootId.session || currentBootId.local || null,
      inProgressBootId: safeParse(inProgress.session || inProgress.local, null)?.bootId || null,
      lastSuccessBootId: safeParse(lastSuccess.local || lastSuccess.session, null)?.bootId || null,
      lastInterruptedBootId: safeParse(lastInterrupted.local || lastInterrupted.session, null)?.bootId || null,
      historyCount: Array.isArray(safeParse(history.local || history.session, [])) ? safeParse(history.local || history.session, []).length : 0,
      fallbackLogCount: Array.isArray(safeParse(fallbackLogs.local || fallbackLogs.session, [])) ? safeParse(fallbackLogs.local || fallbackLogs.session, []).length : 0,
      pendingQueueCount: Array.isArray(safeParse(pendingQueue.local || pendingQueue.session, [])) ? safeParse(pendingQueue.local || pendingQueue.session, []).length : 0,
      sentCount: Array.isArray(safeParse(sent.local || sent.session, [])) ? safeParse(sent.local || sent.session, []).length : 0,
      hasPanicSnapshot: !!(panicSnapshot.local || panicSnapshot.session),
      hasAuthTrace: !!(authTrace.local || authTrace.session),
      hasRouteTransition: !!(routeTransition.local || routeTransition.session),
    },
    keys: {
      currentBootId,
      inProgress: { session: safeParse(inProgress.session, null), local: safeParse(inProgress.local, null) },
      lastSuccess: { session: safeParse(lastSuccess.session, null), local: safeParse(lastSuccess.local, null) },
      lastInterrupted: { session: safeParse(lastInterrupted.session, null), local: safeParse(lastInterrupted.local, null) },
      history: { session: safeParse(history.session, []), local: safeParse(history.local, []) },
      simpleState: { session: safeParse(simpleState.session, null), local: safeParse(simpleState.local, null) },
      simpleLastIncident: { session: safeParse(simpleLastIncident.session, null), local: safeParse(simpleLastIncident.local, null) },
      fallbackLogs: { session: safeParse(fallbackLogs.session, []), local: safeParse(fallbackLogs.local, []) },
      pendingQueue: { session: safeParse(pendingQueue.session, []), local: safeParse(pendingQueue.local, []) },
      sent: { session: safeParse(sent.session, []), local: safeParse(sent.local, []) },
      panicSnapshot,
      authTrace,
      routeTransition,
    },
    raw: {
      currentBootId,
      inProgress,
      lastSuccess,
      lastInterrupted,
      history,
      simpleState,
      simpleLastIncident,
      fallbackLogs,
      pendingQueue,
      sent,
      panicSnapshot,
      authTrace,
      routeTransition,
    },
  };
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.72 }}>{label}</div>
      <div style={{ marginTop: 6, fontWeight: 900, wordBreak: 'break-word' }}>{String(value ?? '-')}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontWeight: 900, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

export default function DebugLitePage() {
  const [state, setState] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const readyMarkedRef = useRef(false);

  useEffect(() => {
    const path = (() => {
      try { return String(window.location?.pathname || '/debug-lite'); } catch { return '/debug-lite'; }
    })();
    const page = path === '/diag-lite' ? 'diag-lite' : 'debug-lite';

    const markAlive = (reason = 'mount') => {
      try { markRouteAlive(`${page}_${reason}`, path); } catch {}
      try { markRouteUiAlive(`${page}_${reason}`, path, { page, reason, at: Date.now(), uiReady: readyMarkedRef.current }); } catch {}
    };

    const markReady = (reason = 'mount_ready') => {
      if (readyMarkedRef.current) return;
      readyMarkedRef.current = true;
      const at = Date.now();
      try { markRouteUiAlive(`${page}_ui_ready`, path, { page, reason, at, uiReady: true }); } catch {}
      try { bootLog('first_ui_ready', { path, page, source: reason, hidden: document.visibilityState !== 'visible' }); } catch {}
      try { bootLog('ui_ready', { path, page, source: reason, hidden: document.visibilityState !== 'visible' }); } catch {}
      try { bootMarkReady({ path, page, source: reason, hidden: document.visibilityState !== 'visible' }); } catch {}
    };

    markAlive('mount');
    afterPaint(() => markReady('debug_lite_after_paint'));

    const onVisible = () => {
      markAlive('visibility');
      if (document.visibilityState === 'visible') markReady('debug_lite_visible');
    };
    const onPageShow = () => {
      markAlive('pageshow');
      markReady('debug_lite_pageshow');
    };
    const onFocus = () => {
      markAlive('focus');
      markReady('debug_lite_focus');
    };

    try { document.addEventListener('visibilitychange', onVisible, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', onPageShow, { passive: true }); } catch {}
    try { window.addEventListener('focus', onFocus, { passive: true }); } catch {}

    return () => {
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { window.removeEventListener('focus', onFocus); } catch {}
    };
  }, []);

  useEffect(() => {
    const refresh = () => setState(readState());
    refresh();
    try { window.addEventListener('focus', refresh, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', refresh, { passive: true }); } catch {}
    try { window.addEventListener('online', refresh, { passive: true }); } catch {}
    try { window.addEventListener('offline', refresh, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', refresh, { passive: true }); } catch {}
    return () => {
      try { window.removeEventListener('focus', refresh); } catch {}
      try { window.removeEventListener('pageshow', refresh); } catch {}
      try { window.removeEventListener('online', refresh); } catch {}
      try { window.removeEventListener('offline', refresh); } catch {}
      try { document.removeEventListener('visibilitychange', refresh); } catch {}
    };
  }, []);

  const pretty = useMemo(() => {
    try {
      return JSON.stringify(state, null, 2);
    } catch {
      return '{}';
    }
  }, [state]);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(pretty || '{}');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div style={{ minHeight: '100dvh', background: '#05070d', color: '#fff', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial', padding: '18px 14px 34px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, letterSpacing: 1.6, fontSize: 22 }}>DEBUG LITE</div>
            <div style={{ marginTop: 6, opacity: 0.78, fontSize: 13 }}>
              Lexim ultra-light nga localStorage / sessionStorage. Pa AuthGate, pa runtime components, pa network calls.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => setState(readState())} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              REFRESH
            </button>
            <button onClick={() => setShowJson((v) => !v)} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              {showJson ? 'HIDE JSON' : 'SHOW JSON'}
            </button>
            <button onClick={copyJson} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              {copied ? 'U KOPJUA' : 'COPY JSON'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: 16, borderRadius: 16, border: '1px solid rgba(59,130,246,0.26)', background: 'rgba(59,130,246,0.10)' }}>
          <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.72 }}>SI TA PËRDORËSH</div>
          <div style={{ marginTop: 8, lineHeight: 1.5, opacity: 0.96 }}>
            Kur të ndodh black screen ose freeze, hape këtë faqe në Safari: <b>/debug-lite</b> ose <b>/diag-lite</b>. Pastaj shtype <b>COPY JSON</b> dhe ma dërgo për analizë.
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Stat label="NOW" value={state?.now || '-'} />
          <Stat label="PATH" value={state?.path || '-'} />
          <Stat label="ONLINE" value={String(state?.online)} />
          <Stat label="VISIBILITY" value={state?.visibilityState || '-'} />
          <Stat label="APP EPOCH" value={state?.appEpoch || '-'} />
          <Stat label="CURRENT BOOT" value={state?.summary?.currentBootId || '-'} />
          <Stat label="IN PROGRESS" value={state?.summary?.inProgressBootId || '-'} />
          <Stat label="LAST SUCCESS" value={state?.summary?.lastSuccessBootId || '-'} />
          <Stat label="LAST INTERRUPTED" value={state?.summary?.lastInterruptedBootId || '-'} />
          <Stat label="HISTORY COUNT" value={state?.summary?.historyCount ?? '-'} />
          <Stat label="FALLBACK LOG COUNT" value={state?.summary?.fallbackLogCount ?? '-'} />
          <Stat label="PENDING QUEUE COUNT" value={state?.summary?.pendingQueueCount ?? '-'} />
          <Stat label="PANIC SNAPSHOT" value={state?.summary?.hasPanicSnapshot ? 'YES' : 'NO'} />
          <Stat label="AUTH TRACE" value={state?.summary?.hasAuthTrace ? 'YES' : 'NO'} />
          <Stat label="ROUTE TRANSITION" value={state?.summary?.hasRouteTransition ? 'YES' : 'NO'} />
        </div>

        <Section title="SEALED PANIC SNAPSHOT">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.panicSnapshot?.local || state?.keys?.panicSnapshot?.session || null, null, 2)}</pre>
        </Section>

        <Section title="AUTH TRACE">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.authTrace?.local || state?.keys?.authTrace?.session || null, null, 2)}</pre>
        </Section>

        <Section title="ROUTE TRANSITION">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.routeTransition?.local || state?.keys?.routeTransition?.session || null, null, 2)}</pre>
        </Section>

        <Section title="LAST INTERRUPTED">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.lastInterrupted?.local || state?.keys?.lastInterrupted?.session || null, null, 2)}</pre>
        </Section>

        <Section title="LAST SIMPLE INCIDENT">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.simpleLastIncident?.local || state?.keys?.simpleLastIncident?.session || null, null, 2)}</pre>
        </Section>

        <Section title="IN PROGRESS STATE">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.inProgress?.session || state?.keys?.inProgress?.local || null, null, 2)}</pre>
        </Section>

        <Section title="HISTORY PREVIEW">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify((state?.keys?.history?.local || state?.keys?.history?.session || []).slice(0, 5), null, 2)}</pre>
        </Section>

        <Section title="FALLBACK LOGS PREVIEW">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify((state?.keys?.fallbackLogs?.local || state?.keys?.fallbackLogs?.session || []).slice(0, 10), null, 2)}</pre>
        </Section>

        <Section title="PENDING INCIDENT QUEUE">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{JSON.stringify(state?.keys?.pendingQueue?.local || state?.keys?.pendingQueue?.session || [], null, 2)}</pre>
        </Section>

        {showJson ? (
          <Section title="FULL JSON">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.96 }}>{pretty || '{}'}</pre>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
