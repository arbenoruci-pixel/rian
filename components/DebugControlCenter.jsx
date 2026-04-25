'use client';

import Link from '@/lib/routerCompat.jsx';
import { usePathname, useRouter } from '@/lib/routerCompat.jsx';
import { useEffect, useMemo, useState } from 'react';
import { clearDiagConfig, getDiagConfig, setDiagConfig } from '@/lib/diagMode';
import { clearRadar, getRadarSnapshot, exportDebugText } from '@/lib/sensor';
import { clearNetworkTrace, readNetworkTrace } from '@/lib/networkTrace';
import { clearGlobalErrors, readGlobalErrors } from '@/lib/globalErrors';
import { readSyncDebug, resetSyncDebug } from '@/lib/syncDebug';

function prettyDate(value) {
  if (!value) return '-';
  try {
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  } catch {
    return String(value);
  }
}

function buildExportPayload() {
  return {
    diag: getDiagConfig(),
    radar: getRadarSnapshot(),
    network: readNetworkTrace(),
    syncState: readSyncDebug(),
    globalErrors: readGlobalErrors(),
  };
}

function Stat({ label, value, sub = '' }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.65 }}>{label}</div>
      <div style={{ marginTop: 6, fontWeight: 900, wordBreak: 'break-word' }}>{String(value ?? '-')}</div>
      {sub ? <div style={{ marginTop: 5, fontSize: 11, opacity: 0.7 }}>{sub}</div> : null}
    </div>
  );
}

function ActionButton({ children, onClick, tone = 'default' }) {
  const styles = {
    default: { border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)' },
    blue: { border: '1px solid rgba(96,165,250,0.28)', background: 'rgba(59,130,246,0.14)' },
    green: { border: '1px solid rgba(74,222,128,0.28)', background: 'rgba(34,197,94,0.14)' },
    amber: { border: '1px solid rgba(250,204,21,0.28)', background: 'rgba(250,204,21,0.12)' },
    red: { border: '1px solid rgba(248,113,113,0.28)', background: 'rgba(239,68,68,0.12)' },
  };
  return (
    <button onClick={onClick} style={{ padding: '12px 14px', borderRadius: 14, color: '#fff', fontWeight: 900, letterSpacing: 0.4, ...styles[tone] }}>
      {children}
    </button>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontWeight: 900, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

export default function DebugControlCenter() {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const [diag, setDiag] = useState(() => getDiagConfig());
  const [radar, setRadar] = useState(() => getRadarSnapshot());
  const [network, setNetwork] = useState(() => readNetworkTrace());
  const [syncState, setSyncState] = useState(() => readSyncDebug());
  const [globalErrors, setGlobalErrors] = useState(() => readGlobalErrors());
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonPreview, setJsonPreview] = useState('');

  function refresh() {
    setDiag(getDiagConfig());
    setRadar(getRadarSnapshot());
    setNetwork(readNetworkTrace());
    setSyncState(readSyncDebug());
    setGlobalErrors(readGlobalErrors());
  }

  useEffect(() => {
    refresh();
    const onRefresh = () => refresh();
    try { window.addEventListener('focus', onRefresh, { passive: true }); } catch {}
    try { window.addEventListener('storage', onRefresh); } catch {}
    try { window.addEventListener('tepiha:diag-changed', onRefresh); } catch {}
    try { window.addEventListener('tepiha:sync-debug', onRefresh); } catch {}
    try { window.addEventListener('tepiha:network-trace', onRefresh); } catch {}
    return () => {
      try { window.removeEventListener('focus', onRefresh); } catch {}
      try { window.removeEventListener('storage', onRefresh); } catch {}
      try { window.removeEventListener('tepiha:diag-changed', onRefresh); } catch {}
      try { window.removeEventListener('tepiha:sync-debug', onRefresh); } catch {}
      try { window.removeEventListener('tepiha:network-trace', onRefresh); } catch {}
    };
  }, []);

  function enableLight(scope = 'all') {
    const next = setDiagConfig({
      enabled: true,
      level: 'light',
      scope,
      path: pathname,
      ttlMs: 10 * 60 * 1000,
      reason: scope === 'current' ? 'manual_light_current' : 'manual_light_all',
    });
    setDiag(next);
    refresh();
  }

  function enableDeep(scope = 'current') {
    const next = setDiagConfig({
      enabled: true,
      level: 'deep',
      scope,
      path: pathname,
      ttlMs: 3 * 60 * 1000,
      reason: scope === 'current' ? 'manual_deep_current' : 'manual_deep_all',
      captureBoot: true,
      captureSync: true,
      captureNetwork: true,
      captureInteractions: true,
      captureLongTasks: true,
    });
    setDiag(next);
    refresh();
  }

  function disableDiag() {
    clearDiagConfig();
    refresh();
  }

  function clearAll() {
    try { clearRadar(); } catch {}
    try { clearNetworkTrace(); } catch {}
    try { resetSyncDebug(); } catch {}
    try { clearGlobalErrors(); } catch {}
    try {
      window.localStorage?.removeItem('tepiha_boot_trace_last');
      window.localStorage?.removeItem('tepiha_boot_in_progress');
      window.localStorage?.removeItem('tepiha_boot_last_success');
      window.localStorage?.removeItem('tepiha_diag_fallback_logs_v2');
      window.localStorage?.removeItem('tepiha_diag_radar_v2');
    } catch {}
    setJsonPreview('');
    setShowJson(false);
    refresh();
  }

  const boot = radar?.boot || null;
  const fallbackLogs = Array.isArray(radar?.fallbackLogs) ? radar.fallbackLogs : [];
  const liveEvents = Array.isArray(radar?.liveBootEvents) ? radar.liveBootEvents : [];
  const syncEvents = Array.isArray(syncState?.events) ? syncState.events : [];
  const previewNetwork = useMemo(() => network.slice(0, 20), [network]);
  const previewSync = useMemo(() => syncEvents.slice(0, 20), [syncEvents]);
  const previewErrors = useMemo(() => globalErrors.slice(0, 20), [globalErrors]);
  const previewRuntime = useMemo(() => fallbackLogs.slice(0, 20), [fallbackLogs]);

  function buildJsonString() {
    try {
      return JSON.stringify(buildExportPayload(), null, 2);
    } catch {
      return exportDebugText() || '{}';
    }
  }

  async function copyAll() {
    try {
      const json = buildJsonString();
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setJsonPreview(showJson ? json : '');
      window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  }

  function toggleJson() {
    if (showJson) {
      setShowJson(false);
      return;
    }
    setJsonPreview(buildJsonString());
    setShowJson(true);
  }

  return (
    <div style={{ minHeight: '100dvh', padding: '18px 14px 34px', background: '#0b0f14', color: '#fff', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, letterSpacing: 1.6, fontSize: 22 }}>DEBUG CENTER</div>
            <div style={{ marginTop: 6, opacity: 0.75, fontSize: 13 }}>Diag është i lehtësuar. Ndize shkurt, merre JSON-in, fike prapë.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <ActionButton tone="default" onClick={() => router.push('/')}>HOME</ActionButton>
            <ActionButton tone="default" onClick={refresh}>REFRESH</ActionButton>
            <ActionButton tone="default" onClick={toggleJson}>{showJson ? 'HIDE JSON' : 'SHOW JSON'}</ActionButton>
            <ActionButton tone="default" onClick={copyAll}>{copied ? 'U KOPJUA' : 'COPY JSON'}</ActionButton>
          </div>
        </div>

        <Section title="CONTROL">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <ActionButton tone="blue" onClick={() => enableLight('all')}>LIGHT 10 MIN ALL</ActionButton>
            <ActionButton tone="amber" onClick={() => enableDeep('current')}>DEEP 3 MIN THIS PAGE</ActionButton>
            <ActionButton tone="green" onClick={() => enableDeep('all')}>DEEP 3 MIN ALL</ActionButton>
            <ActionButton tone="red" onClick={disableDiag}>DIAG OFF</ActionButton>
            <ActionButton tone="red" onClick={clearAll}>CLEAR LOGS</ActionButton>
          </div>
        </Section>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Stat label="STATUS" value={diag?.enabled ? `${String(diag.level || '').toUpperCase()} ON` : 'OFF'} sub={diag?.enabled ? `scope: ${diag.scope || 'all'}` : 'prod safe'} />
          <Stat label="EXPIRES" value={diag?.enabled ? prettyDate(diag.expiresAt) : '-'} sub={diag?.reason || ''} />
          <Stat label="CURRENT PATH" value={pathname} />
          <Stat label="BOOT EVENTS" value={Array.isArray(boot?.events) ? boot.events.length : 0} />
          <Stat label="RUNTIME LOGS" value={fallbackLogs.length} sub={`live: ${liveEvents.length}`} />
          <Stat label="SYNC EVENTS" value={syncEvents.length} />
          <Stat label="NETWORK TRACE" value={network.length} />
          <Stat label="GLOBAL ERRORS" value={globalErrors.length} />
        </div>

        <Section title="QUICK LINKS">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/debug/boot" prefetch={false} style={{ color: '#93c5fd', textDecoration: 'none', fontWeight: 800 }}>BOOT PAGE</Link>
            <Link href="/debug/sync" prefetch={false} style={{ color: '#93c5fd', textDecoration: 'none', fontWeight: 800 }}>SYNC PAGE</Link>
          </div>
        </Section>

        <Section title="BOOT SNAPSHOT">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
            <Stat label="BOOT ID" value={boot?.bootId || '-'} />
            <Stat label="STARTED" value={prettyDate(boot?.startedAt)} />
            <Stat label="UI READY" value={String(!!boot?.uiReady)} />
            <Stat label="OVERLAY" value={String(!!boot?.overlayShown)} />
          </div>
          <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(boot ? { ...boot, events: Array.isArray(boot.events) ? boot.events.slice(0, 20) : [] } : null, null, 2)}</pre>
        </Section>

        <Section title="LAST RUNTIME EVENTS">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(previewRuntime, null, 2)}</pre>
        </Section>

        <Section title="SYNC EVENTS">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(previewSync, null, 2)}</pre>
        </Section>

        <Section title="NETWORK TRACE">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(previewNetwork, null, 2)}</pre>
        </Section>

        <Section title="GLOBAL ERRORS">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{JSON.stringify(previewErrors, null, 2)}</pre>
        </Section>

        {showJson ? (
          <Section title="FULL JSON">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{jsonPreview || 'Preparing…'}</pre>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
