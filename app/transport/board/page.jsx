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
  const quickQ = (sp?.get('q') || '').trim();

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

  // RIPLAN panel (clock on truck icon)
  const [showRiplan, setShowRiplan] = useState(false);
  const [riplanPick, setRiplanPick] = useState({ id: '', whenLocal: '', note: '' });

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

  // Home "QUICK SEARCH" -> /transport/board?q=T123
  // Default to READY tab so the driver finds “GATI” items fastest.
  useEffect(() => {
    if (!quickQ) return;
    setActiveTab('ready');
  }, [quickQ]);

  // After items load, auto-open the matching T-code (if present in the active tab data).
  useEffect(() => {
    if (!quickQ) return;
    const wanted = String(quickQ).toUpperCase();
    const hit = (items || []).find((it) => String(it?.client_tcode || '').toUpperCase() === wanted);
    if (hit?.id) router.push(`/transport/item?id=${encodeURIComponent(hit.id)}`);
  }, [quickQ, items, router]);

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
        // Always include riplan so the clock badge can be accurate on every tab.
        if (tab === 'ready') return ['gati', 'riplan'];
        if (tab === 'loaded') return mode === 'out'
          ? ['delivery','dorzim','dorëzim','riplan']
          : ['loaded','ngarkim','ngarkuar','riplan'];
        return ['new','inbox','pickup','pranim','riplan']; // tolerate drift
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

  async function updateRiplanMeta(orderId, whenIsoOrNull, note) {
    if (!orderId) return;
    const patch = {
      updated_at: new Date().toISOString(),
    };
    // columns exist in your DB (reschedule_at, reschedule_note)
    if (whenIsoOrNull === null) patch.reschedule_at = null;
    else if (whenIsoOrNull) patch.reschedule_at = whenIsoOrNull;
    if (typeof note === 'string') patch.reschedule_note = note;

    const { error } = await supabase
      .from('transport_orders')
      .update(patch)
      .eq('id', orderId);

    if (error) {
      alert('Gabim: ' + error.message);
      return;
    }

    setItems((prev) => (Array.isArray(prev)
      ? prev.map((it) => (it.id === orderId ? { ...it, ...patch } : it))
      : prev));
  }

  // -----------------------------
  // Counts (header dots)
  // -----------------------------
  const counts = useMemo(() => {
    let inbox = 0, loaded = 0, ready = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (st === 'dispatched' || st === 'pickup') inbox++;
      else if (st === 'loaded' || st === 'delivery') loaded++;
      else if (st === 'gati') ready++;
    });
    return { inbox, loaded, ready };
  }, [items]);

  const subCounts = useMemo(() => {
    let inCount = 0, outCount = 0;
    (items || []).forEach((x) => {
      const st = String(x?.status || '').toLowerCase();
      if (st === 'loaded') inCount++;
      else if (st === 'delivery') outCount++;
    });
    return { in: inCount, out: outCount };
  }, [items]);

  // -----------------------------
  // Filter per tab/mode
  // -----------------------------
  const viewItems = useMemo(() => {
    return (items || []).filter((r) => {
      const st = String(r?.status || '').toLowerCase();
      if (activeTab === 'inbox') return st === 'dispatched' || st === 'pickup';
      if (activeTab === 'loaded') return loadedMode === 'in' ? st === 'loaded' : st === 'delivery';
      if (activeTab === 'ready') return st === 'gati';
      return false;
    });
  }, [items, activeTab, loadedMode]);

  const isAdmin = useMemo(() => {
    const role = String(session?.role || session?.user_role || '').toUpperCase();
    return role === 'ADMIN' || role === 'DISPATCH';
  }, [session]);

  const riplanItems = useMemo(() => {
    const tid = String(transportId || '').trim();
    return (items || []).filter((r) => {
      const st = String(r?.status || '').toLowerCase();
      if (st !== 'riplan') return false;
      if (isAdmin) return true;
      return String(r?.transport_id || '').trim() === tid;
    });
  }, [items, transportId, isAdmin]);

  const riplanCount = riplanItems.length;

  function toLocalInputValue(dateIsoOrNull) {
    if (!dateIsoOrNull) return '';
    const d = new Date(dateIsoOrNull);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function addMinutesToNow(mins) {
    const d = new Date();
    d.setMinutes(d.getMinutes() + mins);
    return toLocalInputValue(d.toISOString());
  }

  function setTodayAt(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return toLocalInputValue(d.toISOString());
  }

  function setTomorrowAt(h, m) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return toLocalInputValue(d.toISOString());
  }

  async function saveRiplan() {
    const { id, whenLocal, note } = riplanPick;
    if (!id) return;
    const whenIso = whenLocal ? new Date(whenLocal).toISOString() : null;
    await updateRiplanMeta(id, whenIso, note || '');
    try { load(); } catch {}
  }

  return (
    <div style={ui.page}>
      {/* HEADER */}
      <div style={ui.header}>
        <div style={ui.headerTop}>
          <button
            type="button"
            onClick={() => setShowRiplan(true)}
            title="RIPLAN"
            style={{
              ...ui.avatarProfile,
              border: '0',
              cursor: 'pointer',
              position: 'relative',
              background: 'transparent',
            }}
          >
            🚚
            {riplanCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  background: 'rgba(255, 180, 0, 0.95)',
                  color: '#111',
                  borderRadius: 999,
                  padding: '2px 6px',
                  fontSize: 12,
                  fontWeight: 900,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
                }}
              >
                ⏰
              </span>
            )}
          </button>
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
          {activeTab === 'ready' ? 'Dërgesat' : (activeTab === 'loaded' ? 'Pikapi' : 'Inbox')}
        </h1>

        <div style={ui.tabsContainer}>
          <button style={activeTab === 'inbox' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('inbox')}>
            Të Reja {counts.inbox > 0 && <span style={ui.dot} />}
          </button>
          <button style={activeTab === 'loaded' ? ui.tabActive : ui.tab} onClick={() => setActiveTab('loaded')}>
            Pikapi 🚐 {counts.loaded > 0 && <span style={ui.dot} />}
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

      {activeTab === 'loaded' && loadedMode === 'in' && (
        <NgarkimModule
          items={viewItems}
          loading={loading}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          gpsSort={gpsSort}
          setGpsSort={setGpsSort}
          onBulkStatus={updateTransportStatus}
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

      {/* RIPLAN PANEL (from truck icon) */}
      {showRiplan && (
        <div style={ui.modalOverlay}>
          <style jsx>{`
            @keyframes slideUpRiplan { from { transform: translateY(100%); } to { transform: translateY(0); } }
          `}</style>
          <div style={{
            ...ui.modalShell,
            animation: 'slideUpRiplan .22s ease-out',
          }}>
            <div style={ui.modalTop}>
              <button
                style={ui.btnCloseModal}
                onClick={() => {
                  setShowRiplan(false);
                  setRiplanPick({ id: '', whenLocal: '', note: '' });
                }}
              >
                ✕ Mbylle
              </button>
              <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>RIPLANIFIKIM</span>
              <div style={{ width: 60 }} />
            </div>

            <div style={{ padding: 14, overflow: 'auto' }}>
              {riplanItems.length === 0 ? (
                <div style={{
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 12,
                  padding: 14,
                  color: 'rgba(255,255,255,0.85)',
                  fontWeight: 700,
                }}>
                  S’ka asnjë porosi në RIPLAN.
                </div>
              ) : (
                <>
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginBottom: 10,
                  }}>
                    <span style={{
                      padding: '6px 10px',
                      borderRadius: 999,
                      background: 'rgba(255,255,255,0.08)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      fontSize: 12,
                      fontWeight: 800,
                      color: 'rgba(255,255,255,0.9)',
                    }}>TOTAL: {riplanItems.length}</span>
                    {!isAdmin && (
                      <span style={{
                        padding: '6px 10px',
                        borderRadius: 999,
                        background: 'rgba(0,200,255,0.08)',
                        border: '1px solid rgba(0,200,255,0.18)',
                        fontSize: 12,
                        fontWeight: 800,
                        color: 'rgba(220,250,255,0.95)',
                      }}>VETËM TË MIAT</span>
                    )}
                  </div>

                  {riplanItems.map((it) => {
                    const picked = riplanPick.id === it.id;
                    const clientName = String(it?.client_name || it?.data?.client?.name || '').trim() || '—';
                    const code = String(it?.code_str || it?.client_tcode || '').trim();
                    const phone = String(it?.client_phone || it?.data?.client?.phone || '').trim();
                    const addr = String(it?.data?.client?.address || '').trim();
                    const whenLocal = picked ? riplanPick.whenLocal : toLocalInputValue(it?.reschedule_at || it?.data?.reschedule_at);
                    const note = picked ? riplanPick.note : String(it?.reschedule_note || it?.data?.reschedule_note || '').trim();

                    return (
                      <div key={it.id} style={{
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 14,
                        padding: 12,
                        marginBottom: 10,
                        background: 'rgba(0,0,0,0.18)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <div style={{ fontWeight: 1000, letterSpacing: 0.4 }}>{code} • {clientName}</div>
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>{phone}{addr ? ` • ${addr}` : ''}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setRiplanPick({
                              id: it.id,
                              whenLocal: whenLocal || '',
                              note: note || '',
                            })}
                            style={{
                              border: '1px solid rgba(255,255,255,0.16)',
                              background: picked ? 'rgba(255,180,0,0.18)' : 'rgba(255,255,255,0.06)',
                              color: 'rgba(255,255,255,0.95)',
                              borderRadius: 12,
                              padding: '8px 10px',
                              fontWeight: 900,
                              cursor: 'pointer',
                              minWidth: 90,
                            }}
                          >
                            {picked ? 'ZGJEDHUR' : 'ZGJIDH'}
                          </button>
                        </div>

                        {picked && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 8,
                            }}>
                              {[
                                { label: '+30m', val: addMinutesToNow(30) },
                                { label: '+1h', val: addMinutesToNow(60) },
                                { label: 'SOT 18:00', val: setTodayAt(18, 0) },
                                { label: 'NESËR 09:00', val: setTomorrowAt(9, 0) },
                              ].map((c) => (
                                <button
                                  key={c.label}
                                  type="button"
                                  onClick={() => setRiplanPick((p) => ({ ...p, whenLocal: c.val }))}
                                  style={{
                                    border: '1px solid rgba(255,255,255,0.14)',
                                    background: 'rgba(255,255,255,0.06)',
                                    color: 'rgba(255,255,255,0.95)',
                                    borderRadius: 999,
                                    padding: '8px 12px',
                                    fontWeight: 900,
                                    cursor: 'pointer',
                                  }}
                                >
                                  {c.label}
                                </button>
                              ))}
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                              <div style={{ flex: '1 1 220px', minWidth: 220 }}>
                                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>
                                  KOHA / DATA
                                </div>
                                <input
                                  type="datetime-local"
                                  value={riplanPick.whenLocal}
                                  onChange={(e) => setRiplanPick((p) => ({ ...p, whenLocal: e.target.value }))}
                                  style={{
                                    width: '100%',
                                    background: 'rgba(0,0,0,0.25)',
                                    border: '1px solid rgba(255,255,255,0.16)',
                                    borderRadius: 12,
                                    padding: '10px 12px',
                                    color: 'rgba(255,255,255,0.95)',
                                    fontWeight: 800,
                                  }}
                                />
                              </div>

                              <div style={{ flex: '1 1 220px', minWidth: 220 }}>
                                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>
                                  SHËNIM
                                </div>
                                <input
                                  type="text"
                                  value={riplanPick.note}
                                  onChange={(e) => setRiplanPick((p) => ({ ...p, note: e.target.value }))}
                                  placeholder="p.sh. klienti s’ishte n’shpi"
                                  style={{
                                    width: '100%',
                                    background: 'rgba(0,0,0,0.25)',
                                    border: '1px solid rgba(255,255,255,0.16)',
                                    borderRadius: 12,
                                    padding: '10px 12px',
                                    color: 'rgba(255,255,255,0.95)',
                                    fontWeight: 800,
                                  }}
                                />
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                              <button
                                type="button"
                                onClick={saveRiplan}
                                style={{
                                  border: '1px solid rgba(0,200,255,0.25)',
                                  background: 'rgba(0,200,255,0.12)',
                                  color: 'rgba(235,250,255,0.98)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                RUAJ
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await updateRiplanMeta(it.id, null, riplanPick.note || '');
                                  await updateTransportStatus([it.id], 'loaded');
                                  try { load(); } catch {}
                                }}
                                style={{
                                  border: '1px solid rgba(255,255,255,0.16)',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: 'rgba(255,255,255,0.95)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                KTHE NË NGARKUAR
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await updateRiplanMeta(it.id, null, riplanPick.note || '');
                                  await updateTransportStatus([it.id], 'delivery');
                                  try { load(); } catch {}
                                }}
                                style={{
                                  border: '1px solid rgba(255,255,255,0.16)',
                                  background: 'rgba(255,255,255,0.06)',
                                  color: 'rgba(255,255,255,0.95)',
                                  borderRadius: 12,
                                  padding: '10px 12px',
                                  fontWeight: 1000,
                                  cursor: 'pointer',
                                }}
                              >
                                KTHE NË DORËZIM
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
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