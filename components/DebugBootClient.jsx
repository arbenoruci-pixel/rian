'use client';

import { useEffect, useMemo, useState } from 'react';

const HISTORY_KEY = 'tepiha_boot_trace_last';
const IN_PROGRESS_KEY = 'tepiha_boot_in_progress';
const LAST_SUCCESS_KEY = 'tepiha_boot_last_success';
const LAST_INTERRUPTED_KEY = 'tepiha_boot_last_interrupted';
const CURRENT_BOOT_ID_KEY = 'tepiha_boot_current_id';
const INLINE_INCIDENT_KEY = 'tepiha_inline_last_incident_v1';
const QUEUE_KEY = 'tepiha_simple_incident_queue_v1';

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readCurrentBootId() {
  if (typeof window === 'undefined') return null;
  try {
    return (
      window.sessionStorage?.getItem(CURRENT_BOOT_ID_KEY)
      || window.localStorage?.getItem(CURRENT_BOOT_ID_KEY)
      || window.BOOT_ID
      || null
    );
  } catch {
    return null;
  }
}

function readState() {
  if (typeof window === 'undefined') {
    return { now: null, currentBootId: null, inProgress: null, lastSuccess: null, lastInterrupted: null, history: [] };
  }
  return {
    now: new Date().toISOString(),
    currentBootId: readCurrentBootId(),
    inProgress: safeParse(localStorage.getItem(IN_PROGRESS_KEY), null),
    lastSuccess: safeParse(localStorage.getItem(LAST_SUCCESS_KEY), null),
    lastInterrupted: safeParse(localStorage.getItem(LAST_INTERRUPTED_KEY), null),
    history: safeParse(localStorage.getItem(HISTORY_KEY), []),
    inlineIncident: safeParse(localStorage.getItem(INLINE_INCIDENT_KEY), null),
    pendingQueue: safeParse(localStorage.getItem(QUEUE_KEY), []),
  };
}

function summarizeBoot(entry) {
  const events = Array.isArray(entry?.events) ? entry.events : [];
  const hasReady = !!entry?.uiReady || events.some((e) => e?.type === 'first_ui_ready' || e?.type === 'boot_mark_ready');
  const timeout = events.find((e) => e?.type === 'boot_timeout_warning');
  const reactError = events.find((e) => /react_error|error/i.test(String(e?.type || '')) && /react/i.test(String(e?.data?.message || e?.data?.error?.message || '')));
  const scriptError = events.find((e) => /chunk|script/i.test(String(e?.type || '')));
  const stalled = !hasReady && !!entry?.incidentType;

  if (stalled) return `INCIDENT: ${String(entry.incidentType || '').replaceAll('_', ' ').toUpperCase()}`;
  if (timeout && !hasReady) return 'BOOT STALL / TIMEOUT';
  if (reactError) return 'REACT / HYDRATION ISSUE';
  if (scriptError) return 'CHUNK / SCRIPT ISSUE';
  if (hasReady) return 'BOOT I SUKSESSHËM';
  return 'NUK KA ENDE SINJAL TË MJAFTUESHËM';
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.65 }}>{label}</div>
      <div style={{ marginTop: 6, fontWeight: 900, wordBreak: 'break-word' }}>{String(value ?? '-')}</div>
    </div>
  );
}

export default function DebugBootClient() {
  const [state, setState] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [payload, setPayload] = useState('');

  useEffect(() => {
    const refresh = () => setState(readState());
    refresh();
    window.addEventListener('focus', refresh, { passive: true });
    window.addEventListener('pageshow', refresh, { passive: true });
    document.addEventListener('visibilitychange', refresh, { passive: true });
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const latest = state?.history?.[0] || state?.lastSuccess || null;
  const summary = latest ? summarizeBoot(latest) : 'PO LEXOHET TRACE-I…';
  const previewHistory = useMemo(() => {
    const list = Array.isArray(state?.history) ? state.history : [];
    return list.slice(0, 4).map((entry) => ({
      bootId: entry?.bootId || '',
      bootRootPath: entry?.bootRootPath || entry?.path || '',
      currentPath: entry?.currentPath || entry?.path || '',
      phase: entry?.phase || '',
      startedAt: entry?.startedAt || '',
      uiReady: !!entry?.uiReady,
      endedCleanly: !!entry?.endedCleanly,
      eventCount: Array.isArray(entry?.events) ? entry.events.length : 0,
    }));
  }, [state]);

  async function copyJson() {
    try {
      const nextPayload = JSON.stringify(readState(), null, 2);
      await navigator.clipboard.writeText(nextPayload);
      setPayload(nextPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  function toggleJson() {
    if (showJson) {
      setShowJson(false);
      return;
    }
    try {
      setPayload(JSON.stringify(readState(), null, 2));
    } catch {
      setPayload('{}');
    }
    setShowJson(true);
  }

  return (
    <div style={{ minHeight: '100dvh', padding: '18px 14px 34px', background: '#0b0f14', color: '#fff', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, letterSpacing: 1.6, fontSize: 22 }}>BOOT DEBUG</div>
            <div style={{ marginTop: 6, opacity: 0.75, fontSize: 13 }}>Boot / resume / route trace me faza të ndara dhe incidentin e fundit të ndërprerë.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={toggleJson} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              {showJson ? 'HIDE JSON' : 'SHOW JSON'}
            </button>
            <button onClick={copyJson} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              {copied ? 'U KOPJUA' : 'COPY JSON'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: 16, borderRadius: 16, border: '1px solid rgba(96,165,250,0.24)', background: 'rgba(59,130,246,0.10)' }}>
          <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.72 }}>LEXIM I SHPEJTË</div>
          <div style={{ marginTop: 8, fontWeight: 900, fontSize: 18 }}>{summary}</div>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Stat label="CURRENT BOOT" value={state?.currentBootId || '-'} />
          <Stat label="IN PROGRESS" value={state?.inProgress?.bootId || '-'} />
          <Stat label="LAST SUCCESS" value={state?.lastSuccess?.bootId || '-'} />
          <Stat label="LAST INTERRUPTED" value={state?.lastInterrupted?.bootId || '-'} />
        </div>

        {state?.lastInterrupted ? (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(244,114,182,0.26)', background: 'rgba(244,114,182,0.09)' }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>SESIONI I FUNDIT I NDËRPRERË</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
              <Stat label="INCIDENT" value={state.lastInterrupted.incidentType || '-'} />
              <Stat label="BOOT ROOT PATH" value={state.lastInterrupted.bootRootPath || state.lastInterrupted.path || '-'} />
              <Stat label="CURRENT PATH" value={state.lastInterrupted.currentPath || state.lastInterrupted.path || '-'} />
              <Stat label="PHASE" value={state.lastInterrupted.phase || '-'} />
            </div>
          </div>
        ) : null}

        {state?.inlineIncident ? (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(251,191,36,0.26)', background: 'rgba(251,191,36,0.09)' }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>INLINE INCIDENT I FUNDIT</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
              <Stat label="INCIDENT" value={state.inlineIncident.incidentType || '-'} />
              <Stat label="CURRENT PATH" value={state.inlineIncident.currentPath || '-'} />
              <Stat label="LAST EVENT" value={state.inlineIncident.lastEventAt || '-'} />
              <Stat label="PENDING QUEUE" value={Array.isArray(state?.pendingQueue) ? state.pendingQueue.length : 0} />
            </div>
            <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(state.inlineIncident, null, 2)}</pre>
          </div>
        ) : null}

        {latest ? (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>BOOT-I I FUNDIT</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
              <Stat label="BOOT ROOT PATH" value={latest.bootRootPath || latest.path} />
              <Stat label="CURRENT PATH" value={latest.currentPath || latest.path} />
              <Stat label="PHASE" value={latest.phase || '-'} />
              <Stat label="UI READY" value={String(!!latest.uiReady)} />
              <Stat label="ENDED CLEANLY" value={String(!!latest.endedCleanly)} />
              <Stat label="EVENTE" value={Array.isArray(latest.events) ? latest.events.length : 0} />
            </div>
            <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify({ ...latest, events: Array.isArray(latest.events) ? latest.events.slice(0, 20) : [] }, null, 2)}</pre>
          </div>
        ) : null}

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>HISTORY PREVIEW</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(previewHistory, null, 2)}</pre>
        </div>

        {showJson ? (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>FULL JSON</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{payload || 'Po lexohet...'}</pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
