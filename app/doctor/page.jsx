"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getPendingOps } from '@/lib/offlineStore';
import { runSync } from '@/lib/syncEngine';

// Doctor PRO
// - Shows SW/controller/cache health
// - Shows last DB error captured by ordersDb (tepiha_last_db_error_v1)
// - Can do a DB write test (insert + delete) to confirm RLS allows inserts

const LS_DOC_EVENTS = 'tepiha_doc_events_v1';
const LS_DEBUG_LOG = 'tepiha_debug_log_v1';
const LS_LAST_DB_ERROR = 'tepiha_last_db_error_v1';
const LS_LAST_SYNC = 'tepiha_last_sync';
const LS_LAST_SYNC_ERROR = 'tepiha_last_sync_error';

function isBrowser() {
  return typeof window !== 'undefined';
}

function lsGet(key, fallback = null) {
  try {
    if (!isBrowser()) return fallback;
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    if (!isBrowser()) return;
    window.localStorage.setItem(key, value);
  } catch {}
}

function lsJsonGet(key, fallback) {
  const raw = lsGet(key, null);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function docPush(event, data) {
  try {
    if (!isBrowser()) return;
    const arr = lsJsonGet(LS_DOC_EVENTS, []);
    const next = Array.isArray(arr) ? arr : [];
    next.unshift({ ts: new Date().toISOString(), event, data });
    lsSet(LS_DOC_EVENTS, JSON.stringify(next.slice(0, 80)));
  } catch {}
}

async function listCacheKeys() {
  try {
    if (!('caches' in window)) return [];
    return await window.caches.keys();
  } catch {
    return [];
  }
}

async function cacheSummary(keys) {
  const out = [];
  for (const k of keys || []) {
    try {
      const c = await caches.open(k);
      const reqs = await c.keys();
      const urls = reqs.map((r) => r.url);
      out.push({
        cache: k,
        count: reqs.length,
        hasRoot: urls.some((u) => u.endsWith('/') || u.endsWith('/home') || u.endsWith('/pranimi')),
        hasOffline: urls.some((u) => u.includes('/offline') || u.endsWith('/offline.html')),
        hasSw: urls.some((u) => u.endsWith('/sw.js')),
      });
    } catch {
      out.push({ cache: k, count: 0, hasRoot: false, hasOffline: false, hasSw: false });
    }
  }
  return out;
}

async function probe(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    return { ok: r.ok, status: r.status, ct };
  } catch (e) {
    return { ok: false, status: 0, ct: 'ERR', err: String(e?.message || e) };
  }
}

function pillClass(ok) {
  return ok ? 'pill ok' : 'pill bad';
}

export default function DoctorPage() {
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [writeTest, setWriteTest] = useState(null);
  const [events, setEvents] = useState([]);

  const lastDbError = useMemo(() => lsJsonGet(LS_LAST_DB_ERROR, null), [report]);

  async function buildReport(extra = {}) {
    const href = isBrowser() ? window.location.href : '';
    const online = isBrowser() ? !!navigator.onLine : true;
    const displayMode = (() => {
      try {
        return isBrowser() && window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
      } catch {
        return 'browser';
      }
    })();

    const swSupported = isBrowser() && 'serviceWorker' in navigator;
    const cachesSupported = isBrowser() && 'caches' in window;

    let registration = null;
    let controller = null;
    let registrationsCount = 0;

    if (swSupported) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        registrationsCount = regs.length;
        const reg = regs[0] || null;
        if (reg) {
          registration = {
            scope: reg.scope,
            active: reg.active ? { state: reg.active.state, scriptURL: reg.active.scriptURL } : null,
            waiting: reg.waiting ? { state: reg.waiting.state, scriptURL: reg.waiting.scriptURL } : null,
            installing: reg.installing ? { state: reg.installing.state, scriptURL: reg.installing.scriptURL } : null,
          };
        }
      } catch {}
      try {
        const c = navigator.serviceWorker.controller;
        controller = c ? { state: c.state, scriptURL: c.scriptURL } : null;
      } catch {}
    }

    const cacheKeys = cachesSupported ? await listCacheKeys() : [];
    const cacheSum = cachesSupported ? await cacheSummary(cacheKeys) : [];

    const origin = isBrowser() ? window.location.origin : '';
    const probes = {
      root: await probe(origin + '/'),
      sw: await probe(origin + '/sw.js'),
      offline: await probe(origin + '/offline.html'),
      manifest: await probe(origin + '/manifest.webmanifest'),
    };

    // Sync diagnostics (IndexedDB ops queue + last sync markers)
    let pendingOpsCount = null;
    try {
      const ops = await getPendingOps();
      pendingOpsCount = Array.isArray(ops) ? ops.length : 0;
    } catch {
      pendingOpsCount = null;
    }
    const lastSync = lsJsonGet(LS_LAST_SYNC, null);
    const lastSyncError = lsJsonGet(LS_LAST_SYNC_ERROR, null);

    // DB read probe: if this fails, nothing will save.
    let dbOk = false;
    let dbError = null;
    try {
      const { error } = await supabase.from('orders').select('id').limit(1);
      dbOk = !error;
      dbError = error ? { message: error.message, code: error.code, details: error.details } : null;
      if (error) docPush('DB_READ_FAIL', dbError);
    } catch (e) {
      dbOk = false;
      dbError = { message: String(e?.message || e) };
      docPush('DB_READ_FAIL', dbError);
    }

    const out = {
      ts: new Date().toISOString(),
      href,
      userAgent: isBrowser() ? navigator.userAgent : '',
      online,
      displayMode,
      swSupported,
      cachesSupported,
      controller,
      registration,
      registrationsCount,
      cacheKeys,
      cacheSummary: cacheSum,
      probes,
      database: { ok: dbOk, error: dbError },
      sync: { pendingOpsCount, lastSync, lastSyncError },
      ...extra,
    };

    setReport(out);
    const evA = lsJsonGet(LS_DOC_EVENTS, []);
    const evB = lsJsonGet(LS_DEBUG_LOG, []);
    const merged = [];
    if (Array.isArray(evA)) merged.push(...evA);
    if (Array.isArray(evB)) merged.push(...evB);
    merged.sort((x, y) => String(y?.ts || '').localeCompare(String(x?.ts || '')));
    setEvents(merged.slice(0, 30));
    return out;
  }

  useEffect(() => {
    buildReport();
    const t = setInterval(() => {
      const evA = lsJsonGet(LS_DOC_EVENTS, []);
      const evB = lsJsonGet(LS_DEBUG_LOG, []);
      const merged = [];
      if (Array.isArray(evA)) merged.push(...evA);
      if (Array.isArray(evB)) merged.push(...evB);
      merged.sort((x, y) => String(y?.ts || '').localeCompare(String(x?.ts || '')));
      setEvents(merged.slice(0, 30));
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function hardReset() {
    if (!isBrowser()) return;
    setBusy(true);
    docPush('HARD_RESET', { at: new Date().toISOString() });
    try {
      // 1) clear caches
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // 2) unregister SW(s)
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {
      docPush('HARD_RESET_ERR', { message: String(e?.message || e) });
    }
    setBusy(false);
    // full reload
    window.location.href = '/doctor?reset=1&ts=' + Date.now();
  }

  async function doWriteTest() {
    setBusy(true);
    setWriteTest(null);
    const code = Math.floor(900000000 + Math.random() * 90000000);
    const row = {
      code,
      code_n: code,
      status: 'doctor_test',
      client_name: 'DOCTOR',
      client_phone: '000',
      data: { doctor: true, ts: new Date().toISOString() },
      total: 0,
      paid: 0,
      updated_at: new Date().toISOString(),
    };
    try {
      const { data: ins, error: e1 } = await supabase
        .from('orders')
        .insert([row])
        .select('id, code')
        .single();
      if (e1) throw e1;

      // try delete to keep DB clean
      let delOk = false;
      let delErr = null;
      try {
        const { error: e2 } = await supabase.from('orders').delete().eq('id', ins.id);
        delOk = !e2;
        delErr = e2 ? { message: e2.message, code: e2.code, details: e2.details } : null;
      } catch (e) {
        delOk = false;
        delErr = { message: String(e?.message || e) };
      }

      const res = { ok: true, inserted: ins, deleted: delOk, delete_error: delErr };
      setWriteTest(res);
      docPush('DB_WRITE_TEST_OK', res);
    } catch (e) {
      const err = {
        message: e?.message || String(e),
        code: e?.code || null,
        details: e?.details || null,
        hint: e?.hint || null,
        status: e?.status || null,
      };
      const res = { ok: false, error: err };
      setWriteTest(res);
      // store as last error so the rest of the app can show it too
      try {
        lsSet(LS_LAST_DB_ERROR, JSON.stringify({ ts: new Date().toISOString(), ...err }));
      } catch {}
      docPush('DB_WRITE_TEST_FAIL', err);
    }
    setBusy(false);
    await buildReport({ writeTest: true });
  }

  const swOk = !!report?.controller;
  const cacheOk = (report?.cacheKeys || []).length > 0;
  const dbOk = !!report?.database?.ok;

  return (
    <div className="doc-wrap">
      <div className="doc-hero">
        <div className="doc-title">TEPIHA DOCTOR PRO</div>
        <div className="doc-sub">Ky ekran tregon pse "SERVERI DESHTOI" edhe kur je ONLINE.</div>
      </div>

      <div className="grid">
        <div className="row">
          <div className="label">INTERNET</div>
          <div className={pillClass(!!report?.online)}>{report?.online ? 'ONLINE' : 'OFFLINE'}</div>
        </div>
        <div className="row">
          <div className="label">SERVICE WORKER</div>
          <div className={pillClass(swOk)}>{swOk ? 'AKTIV' : 'JO'}</div>
        </div>
        <div className="row">
          <div className="label">CONTROLLER</div>
          <div className={pillClass(swOk)}>{swOk ? 'PO' : 'JO'}</div>
        </div>
        <div className="row">
          <div className="label">CACHE</div>
          <div className={pillClass(cacheOk)}>{cacheOk ? 'OK' : 'BOSH'}</div>
        </div>
        <div className="row">
          <div className="label">DATABASE (READ)</div>
          <div className={pillClass(dbOk)}>{dbOk ? 'OK' : 'FAIL'}</div>
        </div>
        <div className="row">
          <div className="label">DATABASE (WRITE)</div>
          <div className={pillClass(writeTest?.ok === true)}>{writeTest?.ok === true ? 'OK' : 'TEST'}</div>
        </div>
      </div>

      <div className="btns">
        <button className="btn blue" onClick={() => buildReport()} disabled={busy}>REFRESH</button>
        <button
          className="btn"
          onClick={async () => {
            setBusy(true);
            try {
              await runSync();
            } finally {
              setBusy(false);
              await buildReport();
            }
          }}
          disabled={busy}
        >
          SYNC NOW
        </button>
        <button className="btn purple" onClick={doWriteTest} disabled={busy}>DB WRITE TEST</button>
        <button className="btn red" onClick={hardReset} disabled={busy}>HARD RESET</button>
        <button className="btn green" onClick={() => router.push('/')} disabled={busy}>HOME</button>
      </div>

      {lastDbError ? (
        <div className="card">
          <div className="card-title">LAST DB ERROR</div>
          <pre className="pre">{JSON.stringify(lastDbError, null, 2)}</pre>
        </div>
      ) : null}

      {writeTest ? (
        <div className="card">
          <div className="card-title">DB WRITE TEST RESULT</div>
          <pre className="pre">{JSON.stringify(writeTest, null, 2)}</pre>
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">LIVE LOG (last 30)</div>
        <pre className="pre">{JSON.stringify(events || [], null, 2)}</pre>
      </div>

      <div className="card">
        <div className="card-title">REPORT</div>
        <pre className="pre">{JSON.stringify(report || {}, null, 2)}</pre>
        <button
          className="btn gray"
          type="button"
          onClick={() => {
            try {
              navigator.clipboard.writeText(JSON.stringify(report || {}, null, 2));
              docPush('COPY_REPORT', { ok: true });
            } catch {
              docPush('COPY_REPORT', { ok: false });
            }
          }}
        >
          COPY REPORT
        </button>
      </div>

      <style jsx>{`
        .doc-wrap{min-height:100vh;background:#070b14;color:#fff;padding:18px 14px 140px;}
        .doc-hero{padding:8px 6px 14px;}
        .doc-title{font-size:44px;font-weight:1000;letter-spacing:1px;line-height:1.05;}
        .doc-sub{opacity:.7;margin-top:10px;font-size:14px;line-height:1.35;}
        .grid{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
        .row{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px 14px;}
        .label{font-weight:900;letter-spacing:.8px;}
        .pill{font-weight:1000;letter-spacing:1px;padding:6px 12px;border-radius:999px;font-size:13px;}
        .ok{background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.35);color:#22c55e;}
        .bad{background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.35);color:#ef4444;}
        .btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
        .btn{border:0;border-radius:14px;padding:14px 16px;font-weight:1000;letter-spacing:1px;color:#fff;min-width:140px;}
        .blue{background:#1d4ed8;}
        .purple{background:#6d28d9;}
        .red{background:#b91c1c;}
        .green{background:#15803d;}
        .gray{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14);}
        .btn:disabled{opacity:.6;}
        .card{margin-top:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px;}
        .card-title{font-weight:1000;letter-spacing:1px;margin-bottom:10px;opacity:.9;}
        .pre{white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:.92;margin:0;}
      `}</style>
    </div>
  );
}
