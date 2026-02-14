'use client';

export const dynamic = 'force-dynamic';


import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';

// ✅ SINGLE SOURCE OF TRUTH FOR BOARD UI + HELPERS
// (prevents “options/modules disappear” when one copy gets edited and another copy gets loaded)
import { ui } from '@/lib/transport/board/ui';
// NOTE: Keep Transport Board self-contained.
// We derive transport_id directly from the transport session to avoid
// module-load issues ("TypeError: Load failed") when a shared helper
// gets moved/overridden.

// ✅ BOARD MODULES (Inbox / Pikapi / Dorëzim / Gati)
import { InboxModule } from './modules/inbox';
import { NgarkimModule } from './modules/ngarkim';
import { DorzimModule } from './modules/dorzim';
import { GatiModule } from './modules/gati';

export default function TransportBoardPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const debug = sp?.get('debug') === '1';

  const [session, setSession] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [items, setItems] = useState([]);

  // inbox | loaded | ready
  const [activeTab, setActiveTab] = useState('inbox');

  // loaded tab: in = NGARKIM (loaded) | out = DORËZIM (delivery)
  const [loadedMode, setLoadedMode] = useState('in');

  // shared selection + gps sort (used by loaded/dorzim modules)
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [gpsSort, setGpsSort] = useState(null);
  const [geo, setGeo] = useState(null);

  const [modal, setModal] = useState({ open: false, url: '' });

  // -----------------------------
  // Init session + GPS
  // -----------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { setSession(getTransportSession()); } catch {}
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: true }
      );
    }
  }, []);

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

  const transportId = useMemo(() => deriveTid(session), [session]);

  // keep selection stable: clear only when switching tab/mode
  useEffect(() => {
    setSelectedIds(new Set());
    setGpsSort(null);
    // when leaving loaded tab, reset to “in” so it’s predictable
    if (activeTab !== 'loaded') setLoadedMode('in');
  }, [activeTab, loadedMode]);

  // -----------------------------
  // Load rows
  // -----------------------------
  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const tid = deriveTid(getTransportSession());
      if (!tid) {
        setItems([]);
        return;
      }


      const tab = String(activeTab || 'inbox');
      const mode = String(loadedMode || 'in');
      const cacheKey = `transport_cache_${tid}_${tab}_${mode}`;

      // show cached instantly (if any) to avoid blank/lag
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (Array.isArray(cached) && cached.length) setItems(cached);
      } catch {}

      function tabStatuses() {
        // inbox: newly accepted/created for driver (NEW/INBOX)
        // loaded: NGARKIM/DORËZIM depending on mode
        // ready: GATI
        if (tab === 'ready') return ['gati'];
        if (tab === 'riplan') return ['riplan','riplanifikim','replan','riplanifiko'];
        if (tab === 'loaded') return mode === 'out' ? ['delivery','dorzim','dorëzim'] : ['loaded','ngarkim','ngarkuar'];
        return ['new','inbox','pickup','pranim']; // tolerate drift
      }
      const statuses = tabStatuses();


      // --- REST fallback (Safari/thenable hang guard) ---
      async function fetchRest() {
        // PostgREST endpoint: /rest/v1/<table>
        // Keep URL building simple (no new URL()) to avoid Safari “pattern” errors.
        const base = String(SUPABASE_URL || '').replace(/\/$/, '');
        if (!base) throw new Error('Missing SUPABASE_URL');
        const qTid = encodeURIComponent(tid);
        const url =
          base +
          '/rest/v1/transport_orders' +
          `?select=select=id,client_tcode,visit_nr,status,created_at,updated_at,ready_at,data,transport_id` + `&transport_id=eq.${qTid}` + `&status=in.(${encodeURIComponent(statuses.join(','))})` + `&order=created_at.desc` + `&limit=180`;

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
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

      // ONLY transport_orders (no mixing with base orders)
      // Avoid overly-strict server filters (they can hide data when statuses drift).
      // We fetch by transport_id only, then filter per-tab client-side.
      let data = null;
      let error = null;

      // 1) Try supabase-js, but cap it hard so it can't hang forever.
      try {
        const req = supabase
          .from('transport_orders')
          .select('id,client_tcode,visit_nr,status,created_at,updated_at,ready_at,data,transport_id')
          .eq('transport_id', tid)
          .in('status', statuses)
          .order('updated_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(180);

        const timeoutMs = 6000;
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Load timeout')), timeoutMs)
        );

        const resp = await Promise.race([req, timeout]);
        data = resp?.data ?? null;
        error = resp?.error ?? null;
        if (error) throw error;
        if (!Array.isArray(data)) data = [];
      } catch (e1) {
        // 2) If it hangs/fails in Safari/Chrome, fall back to REST.
        const msg = String(e1?.message || e1 || '');
        // Common browser messages: “Load failed”, “The string did not match the expected pattern.”
        try {
          data = await fetchRest();
          error = null;
        } catch (e2) {
          // keep the original (more meaningful) error if REST also fails
          throw new Error(msg || String(e2?.message || e2 || 'Load failed'));
        }
      }

      const list = Array.isArray(data) ? data : [];
      setItems(list);
      try { localStorage.setItem(cacheKey, JSON.stringify(list)); } catch {}

    } catch (e) {
      console.error(e);
      setItems([]);
      setLoadError(String(e?.message || e || 'Load failed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [transportId, activeTab, loadedMode]);

  // allow modules to trigger refresh
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const h = () => { try { load(); } catch {} };
    window.addEventListener('transport:refresh', h);
    return () => window.removeEventListener('transport:refresh', h);
  }, [transportId]);

  // handle ?edit=
  useEffect(() => {
    const edit = sp?.get('edit');
    if (edit) setModal({ open: true, url: `/transport/pranimi?id=${encodeURIComponent(edit)}` });
  }, [sp]);

  function closeModal() {
    setModal({ open: false, url: '' });
    try { router.replace('/transport/board'); } catch {}
    load();
  }

  // DB status update helper for bulk actions
  async function updateTransportStatus(ids, nextStatus) {
    const uniq = Array.from(new Set(Array.isArray(ids) ? ids : [])).filter(Boolean);
    if (!uniq.length) return;

    const { error } = await supabase
      .from('transport_orders')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .in('id', uniq);

    if (error) {
      alert('Gabim: ' + error.message);
      return;
    }

    // update UI locally
    setItems((prev) => (Array.isArray(prev)
      ? prev.map((it) => (uniq.includes(it.id) ? { ...it, status: nextStatus } : it))
      : prev));
  }

  // -----------------------------
  // Counts (header dots)
  // -----------------------------
  const counts = useMemo(() => {
    let inbox = 0, loaded = 0, ready = 0, riplan = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (['new','inbox','dispatched','pickup','pranim'].includes(st)) inbox++;
      else if (['loaded','ngarkim','ngarkuar','delivery','dorzim','dorëzim'].includes(st)) loaded++;
      else if (['riplan','riplanifikim','replan','riplanifiko'].includes(st)) riplan++;
      else if (st === 'gati') ready++;
    });
    return { inbox, loaded, ready, riplan };
  }, [items]);

  const subCounts = useMemo(() => {
    let inCount = 0, outCount = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (['loaded','ngarkim','ngarkuar'].includes(st)) inCount++;
      else if (['delivery','dorzim','dorëzim'].includes(st)) outCount++;
    });
    return { in: inCount, out: outCount };
  }, [items]);

  // -----------------------------
  // Filter per tab/mode
  // -----------------------------
  const viewItems = useMemo(() => {
    return (items || []).filter((r) => {
      const st = String(r?.status || '').toLowerCase();
      if (activeTab === 'riplan') return ['riplan','riplanifikim','replan','riplanifiko'].includes(st);
      if (activeTab === 'inbox') return ['new','inbox','dispatched','pickup','pranim'].includes(st);
      if (activeTab === 'loaded') return loadedMode === 'in'
        ? ['loaded','ngarkim','ngarkuar'].includes(st)
        : ['delivery','dorzim','dorëzim'].includes(st);
      if (activeTab === 'ready') return st === 'gati';
      return false;
    });
  }, [items, activeTab, loadedMode]);

  return (
    <div style={ui.page}>
      {/* HEADER */}
      <div style={ui.header}>
        <div style={ui.headerTop}>
          <div style={{ position:'relative' }}>
            <div style={ui.avatarProfile} title="Transport" aria-hidden="true">🚚</div>
            {counts.riplan > 0 && (
              <button
                style={{ position:'absolute', right:-4, top:-4, width:22, height:22, borderRadius:99, border:'0', background:'#FF9F0A', color:'#000', fontWeight:'900', display:'flex', alignItems:'center', justifyContent:'center' }}
                onClick={() => setActiveTab('riplan')}
                title="RIPLANIFIKIM"
              >
                ⏰
              </button>
            )}
          </div>
          {activeTab !== 'ready' && (
            <button
              style={ui.btnCompose}
              onClick={() => setModal({ open: true, url: `/transport/pranimi?new=1&new_status=pickup` })}
            >
              ✎
            </button>
          )}
        </div>

        <h1 style={ui.title}>
          {activeTab === 'ready' ? 'Dërgesat' : (activeTab === 'loaded' ? 'Pikapi' : (activeTab === 'riplan' ? 'Riplanifikim' : 'Inbox'))}
        </h1>

        <div style={ui.tabsContainer}>
          <button style={activeTab === 'inbox' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('inbox')}>
            Të Reja {counts.inbox > 0 && <span style={ui.dot} />}
          </button>
          <button style={activeTab === 'loaded' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('loaded')}>
            Pikapi 🚐 {counts.loaded > 0 && <span style={ui.dot} />}
          </button>
          <button style={activeTab === 'riplan' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('riplan')}>
            ⏰ Riplan {counts.riplan > 0 && <span style={ui.dot} />}
          </button>
          <button style={activeTab === 'ready' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('ready')}>
            Gati {counts.ready > 0 && <span style={ui.dot} />}
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

      {/* SUB-TABS for loaded */}
      {activeTab === 'loaded' && (
        <div style={ui.subTabsWrap}>
          <button
            style={loadedMode === 'in' ? ui.subTabActive : ui.subTab}
            onClick={() => setLoadedMode('in')}
          >
            NGARKUAR ({subCounts.in})
          </button>
          <button
            style={loadedMode === 'out' ? ui.subTabActive : ui.subTab}
            onClick={() => setLoadedMode('out')}
          >
            DORËZIM ({subCounts.out})
          </button>
        </div>
      )}

      {/* VIEW (MODULES) */}
      {activeTab === 'inbox' && (
        <InboxModule
          items={viewItems}
          loading={loading}
          onOpenModal={(url) => setModal({ open: true, url })}
        />
      )}

      {activeTab === 'riplan' && (
        <InboxModule
          items={viewItems}
          loading={loading}
          onOpenModal={(url) => setModal({ open: true, url })}
        />
      )}

      {activeTab === 'loaded' && loadedMode === 'in' && (
        <NgarkimModule
          items={viewItems}
          loading={loading}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          gpsSort={gpsSort}
          setGpsSort={setGpsSort}
          onBulkStatus={updateTransportStatus}
          onGoRiplan={() => setActiveTab('riplan')}
        />
      )}

      {activeTab === 'riplan' && (
        <InboxModule
          items={viewItems}
          loading={loading}
          onOpenModal={(url) => setModal({ open: true, url })}
        />
      )}

      {activeTab === 'loaded' && loadedMode === 'out' && (
        <DorzimModule
          items={viewItems}
          loading={loading}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          gpsSort={gpsSort}
          setGpsSort={setGpsSort}
          onBulkStatus={updateTransportStatus}
          onOpenModal={(url) => setModal({ open: true, url })}
        />
      )}

      {activeTab === 'ready' && (
        <GatiModule
          items={viewItems}
          loading={loading}
          geo={geo}
          onOpenModal={(url) => setModal({ open: true, url })}
          onBulkStatus={updateTransportStatus}
          // when you tap “GO DORZO” in GATI, jump to DORËZIM tab
          onGoDorzo={() => {
            setActiveTab('loaded');
            setLoadedMode('out');
          }}
        />
      )}

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