'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAllOrdersLocal, getDeadLetterOps, getPendingOps } from '@/lib/offlineStore';
import { getOutboxSnapshot, syncNow } from '@/lib/syncManager';
import { readSyncDebug, resetSyncDebug } from '@/lib/syncDebug';
import { isDiagEnabled, setDiagEnabled } from '@/lib/diagMode';
import { listBaseCreateRecovery, repairPendingBaseCreateOps } from '@/lib/syncRecovery';
import { readQueueMirror } from '@/lib/offlineQueueSync';

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.65 }}>{label}</div>
      <div style={{ marginTop: 6, fontWeight: 900, wordBreak: 'break-word' }}>{String(value ?? '-')}</div>
      {sub ? <div style={{ marginTop: 5, fontSize: 11, opacity: 0.68 }}>{sub}</div> : null}
    </div>
  );
}

export default function DebugSyncClient() {
  const [syncState, setSyncState] = useState(null);
  const [pendingOps, setPendingOps] = useState([]);
  const [deadOps, setDeadOps] = useState([]);
  const [snapshot, setSnapshot] = useState([]);
  const [recovery, setRecovery] = useState([]);
  const [localOrders, setLocalOrders] = useState([]);
  const [legacyMirror, setLegacyMirror] = useState([]);
  const [copied, setCopied] = useState(false);
  const [diagEnabled, setDiagEnabledState] = useState(false);

  async function refresh({ withRepair = false } = {}) {
    try {
      if (withRepair) {
        await repairPendingBaseCreateOps({ source: 'debug_sync_refresh', limit: 20 }).catch(() => null);
      }
      const [pending, dead, orders] = await Promise.all([
        getPendingOps().catch(() => []),
        getDeadLetterOps().catch(() => []),
        getAllOrdersLocal().catch(() => []),
      ]);
      const mirror = readQueueMirror();
      setPendingOps(Array.isArray(pending) ? pending : []);
      setDeadOps(Array.isArray(dead) ? dead : []);
      setLocalOrders(Array.isArray(orders) ? orders : []);
      setLegacyMirror(Array.isArray(mirror?.items) ? mirror.items : []);
      setSnapshot(getOutboxSnapshot() || []);
      setRecovery(listBaseCreateRecovery() || []);
      setSyncState(readSyncDebug());
      setDiagEnabledState(isDiagEnabled());
    } catch {}
  }

  useEffect(() => {
    refresh({ withRepair: false });
    const onRefresh = () => { void refresh(); };
    window.addEventListener('focus', onRefresh, { passive: true });
    window.addEventListener('storage', onRefresh);
    window.addEventListener('tepiha:sync-debug', onRefresh);
    window.addEventListener('tepiha:outbox-changed', onRefresh);
    window.addEventListener('tepiha:sync-done', onRefresh);
    window.addEventListener('tepiha:sync-recovery', onRefresh);
    window.addEventListener('tepiha:sync-recovery-repaired', onRefresh);
    window.addEventListener('tepiha:diag-changed', onRefresh);
    document.addEventListener('visibilitychange', onRefresh, { passive: true });
    return () => {
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener('storage', onRefresh);
      window.removeEventListener('tepiha:sync-debug', onRefresh);
      window.removeEventListener('tepiha:outbox-changed', onRefresh);
      window.removeEventListener('tepiha:sync-done', onRefresh);
      window.removeEventListener('tepiha:sync-recovery', onRefresh);
      window.removeEventListener('tepiha:sync-recovery-repaired', onRefresh);
      window.removeEventListener('tepiha:diag-changed', onRefresh);
      document.removeEventListener('visibilitychange', onRefresh);
    };
  }, []);

  const payload = useMemo(() => ({
    syncState,
    pendingOps,
    deadOps,
    snapshot,
    recovery,
    localOrders,
    legacyMirror,
  }), [syncState, pendingOps, deadOps, snapshot, recovery, localOrders, legacyMirror]);

  const json = useMemo(() => safeStringify(payload), [payload]);
  const latest = syncState?.events?.[0] || null;
  const localUnsynced = useMemo(() => (Array.isArray(localOrders) ? localOrders : []).filter((row) => row?._synced !== true), [localOrders]);
  const orphanLocals = useMemo(() => localUnsynced.filter((row) => {
    const rowId = String(row?.id || row?.local_oid || '');
    return !(Array.isArray(pendingOps) ? pendingOps : []).some((op) => {
      const pl = op?.payload && typeof op.payload === 'object' ? op.payload : {};
      const opId = String(pl?.id || pl?.local_oid || op?.id || '');
      return !!rowId && rowId === opId;
    });
  }), [localUnsynced, pendingOps]);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  }

  async function forceSync() {
    try {
      await syncNow({ immediate: true, source: 'debug_sync_page' });
    } catch {}
    await refresh({ withRepair: true });
  }

  async function repairQueue() {
    try {
      await repairPendingBaseCreateOps({ source: 'debug_sync_button', limit: 30 });
    } catch {}
    await refresh({ withRepair: false });
  }

  async function clearDebug() {
    try { resetSyncDebug(); } catch {}
    await refresh();
  }

  async function toggleDiag() {
    try { setDiagEnabledState(setDiagEnabled(!diagEnabled)); } catch {}
    await refresh();
  }

  return (
    <div style={{ minHeight: '100dvh', padding: '18px 14px 34px', background: '#0b0f14', color: '#fff', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, letterSpacing: 1.6, fontSize: 22 }}>SYNC DEBUG</div>
            <div style={{ marginTop: 6, opacity: 0.75, fontSize: 13 }}>Gjurmë për offline → outbox → sync engine → dead letter.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={toggleDiag} style={{ padding: '12px 14px', borderRadius: 14, border: `1px solid ${diagEnabled ? 'rgba(74,222,128,0.28)' : 'rgba(255,255,255,0.14)'}`, background: diagEnabled ? 'rgba(34,197,94,0.14)' : 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900 }}>{diagEnabled ? 'DIAG ON' : 'DIAG OFF'}</button>
            <button onClick={forceSync} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(96,165,250,0.24)', background: 'rgba(59,130,246,0.14)', color: '#fff', fontWeight: 900 }}>FORCE SYNC</button>
            <button onClick={repairQueue} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(250,204,21,0.24)', background: 'rgba(250,204,21,0.12)', color: '#fff', fontWeight: 900 }}>REPAIR QUEUE</button>
            <button onClick={copyJson} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900 }}>{copied ? 'U KOPJUA' : 'COPY JSON'}</button>
            <button onClick={clearDebug} style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(239,68,68,0.24)', background: 'rgba(239,68,68,0.12)', color: '#fff', fontWeight: 900 }}>CLEAR DEBUG</button>
          </div>
        </div>

        {!diagEnabled ? (
          <div style={{ marginTop: 16, padding: 14, borderRadius: 14, border: '1px solid rgba(250,204,21,0.22)', background: 'rgba(250,204,21,0.10)', fontSize: 13, lineHeight: 1.5 }}>
            DIAG ËSHTË OFF. Sync-u real vazhdon normalisht, por gjurmët verbose dhe wake-spam janë të ndalura. Ndize vetëm kur del problem.
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Stat label="DIAG" value={diagEnabled ? 'ON' : 'OFF'} />
          <Stat label="ONLINE" value={String(syncState?.online)} />
          <Stat label="PENDING OPS" value={pendingOps.length} sub={`snapshot: ${snapshot.length}`} />
          <Stat label="DEAD LETTER" value={deadOps.length} />
          <Stat label="RECOVERY ENTRIES" value={recovery.length} />
          <Stat label="LOCAL UNSYNCED" value={localUnsynced.length} sub={`orphans: ${orphanLocals.length}`} />
          <Stat label="LEGACY MIRROR" value={legacyMirror.length} />
          <Stat label="LAST EVENT" value={latest?.type || '-'} sub={latest?.at || ''} />
        </div>

        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Stat label="ENQUEUE" value={syncState?.counters?.enqueue ?? 0} />
          <Stat label="SYNC RUNS" value={syncState?.counters?.syncRuns ?? 0} />
          <Stat label="SUCCESS OPS" value={syncState?.counters?.successOps ?? 0} />
          <Stat label="FAILED OPS" value={syncState?.counters?.failedOps ?? 0} />
          <Stat label="NETWORK STOPS" value={syncState?.counters?.networkStops ?? 0} />
          <Stat label="PERMANENT" value={syncState?.counters?.permanentStops ?? 0} />
          <Stat label="LOCKED" value={syncState?.counters?.lockedRuns ?? 0} />
        </div>

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>PENDING OPS</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{safeStringify(pendingOps)}</pre>
        </div>

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>RECOVERY REGISTRY</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{safeStringify(recovery)}</pre>
        </div>

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>SYNC TRACE</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{safeStringify(syncState)}</pre>
        </div>


        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>LOCAL UNSYNCED / ORPHANS</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{safeStringify({
            totalLocalUnsynced: localUnsynced.length,
            orphanLocals: orphanLocals.map((row) => ({
              id: row?.id || row?.local_oid || '',
              code: row?.code || row?.data?.client?.code || '',
              status: row?.status || row?.data?.status || '',
              client: row?.client_name || row?.data?.client_name || row?.data?.client?.name || '',
            })),
          })}</pre>
        </div>

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>LEGACY MIRROR</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{safeStringify(legacyMirror)}</pre>
        </div>

        <div style={{ marginTop: 18, padding: 16, borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>FULL JSON</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>{json || 'Po lexohet...'}</pre>
        </div>
      </div>
    </div>
  );
}
