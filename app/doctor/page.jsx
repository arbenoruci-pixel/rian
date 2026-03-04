"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getPendingOps } from '@/lib/offlineStore';
import { runSync } from '@/lib/syncEngine';
import { readOfflineSyncLast, readQueueMirror, syncOfflineNow } from '@/lib/offlineQueueSync';
import { getActor } from '@/lib/actorSession';
import { getDeviceId } from '@/lib/deviceId';

const LS_DOC_EVENTS = 'tepiha_doc_events_v1';
const LS_DEBUG_LOG = 'tepiha_debug_log_v1';
const LS_LAST_DB_ERROR = 'tepiha_last_db_error_v1';
const LS_LAST_SYNC = 'tepiha_last_sync';
const LS_LAST_SYNC_ERROR = 'tepiha_last_sync_error';
const LS_BASE_TERMINAL = 'TEPIHA_BASE_TERMINAL';

function isBrowser() { return typeof window !== 'undefined'; }
function lsGet(key, fallback = null) { try { if (!isBrowser()) return fallback; const v = window.localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; } }
function lsSet(key, value) { try { if (!isBrowser()) return; window.localStorage.setItem(key, value); } catch {} }
function lsJsonGet(key, fallback) { const raw = lsGet(key, null); if (!raw) return fallback; try { return JSON.parse(raw); } catch { return fallback; } }

function docPush(event, data) {
  try {
    if (!isBrowser()) return;
    const arr = lsJsonGet(LS_DOC_EVENTS, []);
    const next = Array.isArray(arr) ? arr : [];
    next.unshift({ ts: new Date().toISOString(), event, data });
    lsSet(LS_DOC_EVENTS, JSON.stringify(next.slice(0, 80)));
  } catch {}
}

async function listCacheKeys() { try { if (!('caches' in window)) return []; return await window.caches.keys(); } catch { return []; } }
async function cacheSummary(keys) {
  const out = [];
  for (const k of keys || []) {
    try {
      const c = await caches.open(k);
      const reqs = await c.keys();
      out.push({ cache: k, count: reqs.length });
    } catch { out.push({ cache: k, count: 0 }); }
  }
  return out;
}

function pillClass(ok, warn = false) {
  if (warn) return 'pill warn';
  return ok ? 'pill ok' : 'pill bad';
}

export default function DoctorPage() {
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [writeTest, setWriteTest] = useState(null);
  const [events, setEvents] = useState([]);
  
  const [actor, setActor] = useState(null);
  const [deviceId, setDeviceId] = useState('...');
  const [isBase, setIsBase] = useState(false);
  const [smartWarnings, setSmartWarnings] = useState([]);

  const lastDbError = useMemo(() => lsJsonGet(LS_LAST_DB_ERROR, null), [report]);

  useEffect(() => {
    try {
      setActor(getActor());
      setDeviceId(getDeviceId());
      setIsBase(lsGet(LS_BASE_TERMINAL) === '1');
    } catch {}
  }, []);

  async function buildReport(extra = {}) {
    const online = isBrowser() ? !!navigator.onLine : true;
    const swSupported = isBrowser() && 'serviceWorker' in navigator;
    let controller = null;

    if (swSupported) {
      try { const c = navigator.serviceWorker.controller; controller = c ? { state: c.state } : null; } catch {}
    }

    const cacheKeys = await listCacheKeys();
    const cacheSum = await cacheSummary(cacheKeys);

    let pendingOpsCount = 0;
    try { const ops = await getPendingOps(); pendingOpsCount = Array.isArray(ops) ? ops.length : 0; } catch {}

    let queueMirror = { items: [] };
    try { queueMirror = readQueueMirror(); } catch {}
    const mirrorUnsynced = (Array.isArray(queueMirror?.items) ? queueMirror.items : []).filter((x) => x && x.synced !== true);

    let dbOk = false;
    let dbError = null;
    try {
      const { error } = await supabase.from('orders').select('id').limit(1);
      dbOk = !error;
      dbError = error ? error.message : null;
    } catch (e) { dbOk = false; dbError = String(e); }

    const out = {
      ts: new Date().toISOString(),
      online, swSupported, controller, cacheKeys, cacheSummary: cacheSum,
      database: { ok: dbOk, error: dbError },
      sync: { pendingOpsCount },
      queueMirror: { unsyncedCount: mirrorUnsynced.length },
      ...extra,
    };

    setReport(out);
    analyzeSmartWarnings(out);
    return out;
  }

  function analyzeSmartWarnings(r) {
    const warns = [];
    if (!r.online) warns.push({ type: 'warning', text: 'Jeni OFFLINE. Të dhënat po ruhen në telefon dhe do dërgohen kur të vijë interneti.' });
    if (r.online && !r.database.ok) warns.push({ type: 'danger', text: 'Keni internet, por Databaza ra! Kontrollo Supabase (Mund të jetë RLS Error).' });
    if (!r.controller) warns.push({ type: 'danger', text: 'Aplikacioni nuk është instaluar saktë për Offline. Shtyp butonin e kuq HARD RESET.' });
    if (r.sync.pendingOpsCount > 0) warns.push({ type: 'info', text: `Keni ${r.sync.pendingOpsCount} veprime të pa-sinkronizuara. Shtyp SYNC NOW.` });
    if (r.queueMirror.unsyncedCount > 0) warns.push({ type: 'info', text: `Keni ${r.queueMirror.unsyncedCount} porosi offline në pritje. Shtyp SYNC OFFLINE QUEUE.` });
    
    if (warns.length === 0) warns.push({ type: 'success', text: 'Sistemi është PERFEKT! Çdo gjë po punon vaj.' });
    setSmartWarnings(warns);
  }

  useEffect(() => {
    buildReport();
    const t = setInterval(() => {
      const evA = lsJsonGet(LS_DOC_EVENTS, []);
      const evB = lsJsonGet(LS_DEBUG_LOG, []);
      const merged = [...evA, ...evB].sort((x, y) => String(y?.ts || '').localeCompare(String(x?.ts || '')));
      setEvents(merged.slice(0, 30));
    }, 2000);
    return () => clearInterval(t);
  }, []);

  async function hardReset() {
    if (!confirm('Kujdes: Kjo do fshijë memorien offline. A jeni të sigurt?')) return;
    setBusy(true);
    try {
      if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); }
      if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); }
      window.localStorage.clear();
    } catch {}
    window.location.href = '/';
  }

  async function doWriteTest() {
    setBusy(true); setWriteTest(null);
    try {
      const { data: ins, error: e1 } = await supabase.from('orders').insert([{ code: 9999999, status: 'test' }]).select('id').single();
      if (e1) throw e1;
      await supabase.from('orders').delete().eq('id', ins.id);
      setWriteTest({ ok: true, message: 'Shkrimi në Databazë është i hapur dhe i shpejtë!' });
    } catch (e) {
      setWriteTest({ ok: false, message: e?.message || 'BLLOKADË! Shkrimi dështoi.' });
    }
    setBusy(false);
    await buildReport();
  }

  function toggleBaseTerminal() {
    if (isBase) {
      lsSet(LS_BASE_TERMINAL, '0');
      alert('Kjo pajisje u kthye në TELEFON TERRENI. Nuk kërkon më PIN për pagesa.');
    } else {
      lsSet(LS_BASE_TERMINAL, '1');
      alert('✅ KY IPAD TANI ËSHTË BAZA! Çdo pagesë do të kërkojë PIN-in e punëtorit.');
    }
    window.location.reload();
  }

  const swOk = !!report?.controller;
  const dbOk = !!report?.database?.ok;
  const pendingSync = (report?.sync?.pendingOpsCount || 0) + (report?.queueMirror?.unsyncedCount || 0) > 0;

  return (
    <div className="doc-wrap">
      <div className="header-row" style={{ padding: '0 5px 15px 5px' }}>
        <div>
          <h1 className="title">DOCTOR PRO</h1>
          <p className="subtitle">DIAGNOSTIKIMI I SISTEMIT</p>
        </div>
        <button className="badge" onClick={() => router.push('/')}>HOME</button>
      </div>

      {/* 🧠 SMART DIAGNOSTICS PANEL */}
      <div className="card" style={{ border: '2px solid rgba(255,255,255,0.2)', background: 'rgba(0,0,0,0.3)' }}>
        <h2 className="card-title" style={{ color: '#60a5fa' }}>🧠 ANALIZA INTELIGJENTE</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {smartWarnings.map((w, i) => (
            <div key={i} style={{ 
              padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: w.type === 'danger' ? 'rgba(239,68,68,0.2)' : w.type === 'warning' ? 'rgba(245,158,11,0.2)' : w.type === 'info' ? 'rgba(59,130,246,0.2)' : 'rgba(34,197,94,0.2)',
              color: w.type === 'danger' ? '#fca5a5' : w.type === 'warning' ? '#fcd34d' : w.type === 'info' ? '#93c5fd' : '#86efac',
              borderLeft: `4px solid ${w.type === 'danger' ? '#ef4444' : w.type === 'warning' ? '#f59e0b' : w.type === 'info' ? '#3b82f6' : '#22c55e'}`
            }}>
              {w.text}
            </div>
          ))}
        </div>
      </div>

      {/* 📱 DEVICE IDENTITY */}
      <div className="card">
        <h2 className="card-title">📱 IDENTITETI I PAJISJES</h2>
        <div className="row">
          <div className="label">PUNËTORI AKTIV</div>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{actor?.name || 'S\'KA'} ({actor?.role || '?'})</div>
        </div>
        <div className="row">
          <div className="label">ID E PAJISJES</div>
          <div style={{ fontSize: 11, opacity: 0.7, fontFamily: 'monospace' }}>{deviceId.split('-')[0]}...</div>
        </div>
        
        <button 
          className="btn" 
          style={{ width: '100%', marginTop: 15, background: isBase ? '#ef4444' : '#8b5cf6', fontSize: 15 }}
          onClick={toggleBaseTerminal}
        >
          {isBase ? '🔓 HIQENI NGA "BAZA"' : '🔒 BËJE KËTË PAJISJE "BAZË"'}
        </button>
        {isBase && <div style={{ textAlign: 'center', fontSize: 11, marginTop: 8, color: '#fca5a5' }}>Kjo pajisje kërkon PIN për çdo pagesë!</div>}
      </div>

      {/* ⚙️ SYSTEM VITALS */}
      <div className="card">
        <h2 className="card-title">⚙️ SHËNDETI I SISTEMIT</h2>
        <div className="grid">
          <div className="row">
            <div className="label">INTERNET</div>
            <div className={pillClass(!!report?.online)}>{report?.online ? 'ONLINE' : 'OFFLINE'}</div>
          </div>
          <div className="row">
            <div className="label">OFFLINE CACHE (SW)</div>
            <div className={pillClass(swOk)}>{swOk ? 'AKTIV' : 'MUNGON'}</div>
          </div>
          <div className="row">
            <div className="label">LIDHJA ME DB (READ)</div>
            <div className={pillClass(dbOk)}>{dbOk ? 'OK' : 'FAIL'}</div>
          </div>
          <div className="row">
            <div className="label">TË DHËNA NË PRITJE (SYNC)</div>
            <div className={pillClass(!pendingSync, pendingSync)}>{pendingSync ? 'PO PRESIN...' : 'PASTËR'}</div>
          </div>
        </div>
      </div>

      <div className="btns">
        <button className="btn blue" onClick={() => buildReport()} disabled={busy}>🔄 RIFRESKO</button>
        <button className="btn blue" onClick={async () => { setBusy(true); await runSync(); setBusy(false); await buildReport(); }} disabled={busy}>☁️ SYNC NOW</button>
        <button className="btn blue" onClick={async () => { setBusy(true); await syncOfflineNow(); setBusy(false); await buildReport(); }} disabled={busy}>☁️ SYNC QUEUE</button>
        <button className="btn purple" onClick={doWriteTest} disabled={busy}>📝 TESTO SHKRIMIN</button>
        <button className="btn red" onClick={hardReset} disabled={busy}>🚨 HARD RESET</button>
      </div>

      {writeTest && (
        <div className="card" style={{ borderColor: writeTest.ok ? '#22c55e' : '#ef4444' }}>
          <div className="card-title">REZULTATI I TESTIT TË DB</div>
          <div style={{ color: writeTest.ok ? '#4ade80' : '#f87171', fontWeight: 800, fontSize: 14 }}>{writeTest.message}</div>
        </div>
      )}

      {lastDbError && (
        <div className="card" style={{ borderColor: '#ef4444' }}>
          <div className="card-title" style={{ color: '#ef4444' }}>GABIMI I FUNDIT I DATABAZËS</div>
          <pre className="pre" style={{ color: '#fca5a5' }}>{JSON.stringify(lastDbError, null, 2)}</pre>
        </div>
      )}

      <style jsx>{`
        .doc-wrap { min-height: 100vh; background: #070b14; color: #fff; padding: 18px 14px 140px; }
        .grid { display: flex; flex-direction: column; gap: 8px; }
        .row { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,.03); border-radius: 12px; padding: 12px 14px; margin-bottom: 4px; }
        .label { font-weight: 800; font-size: 12px; letter-spacing: 0.5px; opacity: 0.9; }
        .pill { font-weight: 900; letter-spacing: 0.5px; padding: 4px 10px; border-radius: 999px; font-size: 11px; }
        .ok { background: rgba(34,197,94,.15); color: #4ade80; border: 1px solid rgba(34,197,94,.3); }
        .bad { background: rgba(239,68,68,.15); color: #f87171; border: 1px solid rgba(239,68,68,.3); }
        .warn { background: rgba(245,158,11,.15); color: #fbbf24; border: 1px solid rgba(245,158,11,.3); }
        .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
        .btn { border: 0; border-radius: 12px; padding: 14px 10px; font-weight: 900; font-size: 12px; color: #fff; text-align: center; }
        .blue { background: #2563eb; }
        .purple { background: #7c3aed; }
        .red { background: #dc2626; grid-column: span 2; }
        .btn:disabled { opacity: 0.5; }
        .card { margin-top: 15px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 16px; }
        .card-title { font-weight: 900; font-size: 13px; letter-spacing: 1px; margin-bottom: 12px; opacity: 0.8; }
        .pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; opacity: 0.8; margin: 0; font-family: monospace; }
      `}</style>
    </div>
  );
}
