'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { recordCashMove } from '@/lib/arkaCashSync';
import PaySheetPortal from '@/components/payments/PaySheetPortal';
import { getTransportSession } from '@/lib/transportAuth';
import TransportEditModal from '@/components/transport/TransportEditModal';
import TransportEditModal from '@/components/transport/TransportEditModal';

function readActor() {
  // Prefer dedicated transport session (or reused TRANSPORT actor session)
  try {
    const s = getTransportSession();
    if (!s?.transport_id) return null;
    return {
      role: s?.role || 'TRANSPORT',
      name: s?.transport_name || 'TRANSPORT',
      pin: String(s.transport_id),
      transport_id: String(s.transport_id),
      from: s?.from || 'transport',
    };
  } catch {
    return null;
  }
}

function normalizeTCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  // sometimes stored as numeric offset (>= 1,000,000)
  const n0 = Number(s);
  if (Number.isFinite(n0) && n0 >= 1000000) return `T${n0 - 1000000}`;
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n ? `T${n}` : '';
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/[^\d+]+/g, '');
}

function haversineKm(a, b) {
  // a,b: {lat,lng}
  const R = 6371;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const lat1 = toRad(a.lat), lon1 = toRad(a.lng);
  const lat2 = toRad(b.lat), lon2 = toRad(b.lng);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function computePieces(order) {
  const t = order?.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const s = order?.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
}

function openSMS(phone, body) {
  const p = sanitizePhone(phone);
  const b = encodeURIComponent(body || '');
  // iOS works with sms:<num>&body= OR sms:<num>?&body=
  window.location.href = `sms:${p}?&body=${b}`;
}

function openAppleMaps(lat, lng) {
  window.location.href = `maps://?daddr=${lat},${lng}`;
}

function openGoogleMaps(lat, lng) {
  window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

export default function TransportGatiPage() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');

  // --- EDIT (same system as /pastrimi) ---
  const longPressTimer = useRef(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  function startLongPress(r) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      setEditRow({ id: r.id });
      setEditOpen(true);
    }, 550);
  }
  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // selection + bulk flow
  const [sel, setSel] = useState(() => ({})); // {id:true}
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkIdx, setBulkIdx] = useState(0);
  const [bulkIds, setBulkIds] = useState([]);

  // route suggestion
  const [start, setStart] = useState(null); // {lat,lng}
  const [routeIds, setRouteIds] = useState(null); // ordered ids (stops)
  const [routeOpen, setRouteOpen] = useState(false);

  // payment
  const [payOpen, setPayOpen] = useState(false);
  const [payOrder, setPayOrder] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { setMe(readActor()); }, []);

  const role = String(me?.role || '').toUpperCase();
  const canSee = role === 'TRANSPORT' || role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH';

  const myTransportId = String(me?.transport_id || me?.pin || '').trim();

  const prettyItems = useMemo(() => {
    return (items || []).map((it) => {
      const o = it.order || {};
      const name = o?.client?.name || o?.client_name || it.code;
      const phone = o?.client?.phone || o?.client_phone || '';
      const pieces = computePieces(o);
      const total = Number(o?.pay?.euro || o?.pay?.total || 0);
      const lat = Number(o?.transport?.lat || o?.transport_lat || 0);
      const lng = Number(o?.transport?.lng || o?.transport_lng || 0);
      const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && (Math.abs(lat) > 0.0001) && (Math.abs(lng) > 0.0001);
      return { ...it, name, phone, pieces, total, lat, lng, hasGeo };
    });
  }, [items]);

  const orderedForView = useMemo(() => {
    if (!routeIds || routeIds.length === 0) return prettyItems;
    const byId = new Map(prettyItems.map((x) => [x.id, x]));
    const inRoute = routeIds.map((id) => byId.get(id)).filter(Boolean);
    const rest = prettyItems.filter((x) => !routeIds.includes(x.id));
    return [...inRoute, ...rest];
  }, [prettyItems, routeIds]);

  async function load() {
    setBusy(true);
    setErr('');
    try {
      // ✅ transport GATI reads transport_orders
      const { data, error } = await supabase
        .from('transport_orders')
        .select('id, code_n, code_str, status, created_at, data')
        .eq('status', 'gati')
        .order('created_at', { ascending: false })
        .limit(400);

      if (error) throw error;

      const list = (data || [])
        .map((r) => ({
          id: r.id,
          code: normalizeTCode(r.code_str || r.code_n || r.data?.client?.code || ''),
          status: r.status,
          created_at: r.created_at,
          order: r.data || {},
          transport_id: String(r.data?.transport_id || r.data?.scope?.transport_id || r.data?.transport?.transport_id || r.data?.transportId || r.data?.transport_id || ''),
          transport_name: String(r.data?.transport_name || ''),
        }))
        .filter((x) => /^T\d+$/i.test(x.code))
        .filter((x) => {
          if (String(me?.role || '').toUpperCase() === 'TRANSPORT') {
            if (!myTransportId) return false;
            // accept either exact match on transport_id or pin fallback
            return String(x.transport_id || '').trim() === myTransportId;
          }
          return true;
        });

      setItems(list);

      // keep selection only for existing ids
      setSel((prev) => {
        const next = {};
        for (const it of list) if (prev[it.id]) next[it.id] = true;
        return next;
      });

      // keep routeIds only for existing
      setRouteIds((prev) => {
        if (!prev) return prev;
        const setIds = new Set(list.map((x) => x.id));
        const keep = prev.filter((id) => setIds.has(id));
        return keep.length ? keep : null;
      });

    } catch (e) {
      setErr(String(e?.message || e || 'Gabim'));
      setItems([]);
      setSel({});
      setRouteIds(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!canSee) return;
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSee]);

  const selectedIds = useMemo(() => Object.keys(sel).filter((k) => sel[k]), [sel]);
  const allSelected = useMemo(() => prettyItems.length > 0 && selectedIds.length === prettyItems.length, [prettyItems.length, selectedIds.length]);

  function toggleAll() {
    if (allSelected) { setSel({}); return; }
    const next = {};
    for (const it of prettyItems) next[it.id] = true;
    setSel(next);
  }

  function toggleOne(id) {
    setSel((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function startBulkConfirm() {
    const ids = selectedIds.length ? selectedIds : [];
    if (!ids.length) { alert('ZGJIDH TË PAKTËN 1 POROSI'); return; }
    setBulkIds(ids);
    setBulkIdx(0);
    setBulkOpen(true);
  }

  function bulkCurrentItem() {
    const id = bulkIds[bulkIdx];
    return prettyItems.find((x) => x.id === id) || null;
  }

  function getConfirmMsg(name, code) {
    return `Pershendetje ${name || ''}, tepihat i keni gati (${code}). A jeni ne shtepi sot me i pranu? Ju lutem pergjigju: PO ose JO. Nese s’konfirmoni, nuk i sjellim sot.`;
  }

  async function getStartGPS() {
    try {
      if (!navigator.geolocation) { alert('GPS nuk eshte i disponueshem'); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          alert('START GPS U MOR ✅');
        },
        () => alert('S’pata leje GPS ose gabim'),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } catch {
      alert('GPS gabim');
    }
  }

  function recommendRoute() {
    const base = start;
    const pool = prettyItems.filter((x) => x.hasGeo && (selectedIds.length ? sel[x.id] : true));
    if (!base) {
      alert('Shtyp “MERR START GPS” (ose ndiz GPS) pastaj provo prap.');
      return;
    }
    if (pool.length < 2) {
      alert('Duhet te pakten 2 porosi me kordinata.');
      return;
    }
    const remaining = pool.map((x) => ({ id: x.id, lat: x.lat, lng: x.lng }));
    let cur = { ...base };
    const order = [];
    while (remaining.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversineKm(cur, remaining[i]);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      const nxt = remaining.splice(bestIdx, 1)[0];
      order.push(nxt.id);
      cur = { lat: nxt.lat, lng: nxt.lng };
    }
    setRouteIds(order);
    setRouteOpen(true);
  }

  function moveRoute(id, dir) {
    setRouteIds((prev) => {
      if (!prev) return prev;
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[idx];
      next[idx] = next[j];
      next[j] = tmp;
      return next;
    });
  }

  async function submitTransportPayment({ orderId, code, name, amount }) {
    const amt = Number(amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'AMOUNT_INVALID' };
    return await recordCashMove({
      amount: amt,
      method: 'CASH',
      type: 'TRANSPORT',
      status: 'COLLECTED',
      order_id: orderId,
      order_code: code,
      client_name: name,
      stage: 'GATI',
      note: `TRANSPORT ${code} • PAGESA ${amt}€`,
      created_by_pin: String(me?.transport_id || me?.pin || ''),
      created_by_name: me?.transport_name || me?.name || String(me?.transport_id || me?.pin || ''),
      approved_by_pin: null,
    });
  }

  return (
    <main className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">GATI (TRANSPORT)</h1>
          <div className="subtitle">VETËM POROSITË E TUA • KODI T</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="pill" href="/transport">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      {!me ? (
        <section className="card">
          <div className="muted">NUK JE I KYÇUR • SHKO TE LOGIN</div>
          <Link className="btn" href="/login">LOGIN</Link>
        </section>
      ) : !canSee ? (
        <section className="card">
          <div className="muted">S’KE LEJE</div>
          <Link className="btn" href="/">KTHEHU HOME</Link>
        </section>
      ) : (
        <>
          {err ? <section className="card"><div className="muted">{err}</div></section> : null}

          <section className="card">
            <div className="toolbar">
              <button className={"btn ghost"} onClick={toggleAll}>
                {allSelected ? 'HIQ KREJT' : 'SELECT ALL'}
              </button>
              <button className={"btn"} onClick={startBulkConfirm}>DËRGO KONFIRMIM</button>
              <button className={"btn ghost"} onClick={getStartGPS}>MERR START GPS</button>
              <button className={"btn"} onClick={recommendRoute}>REKOMANDO NGARKESËN</button>
              <Link className="btn ghost" href="/transport/pranimi">+ PRANIMI</Link>
            </div>

            {busy ? <div className="muted" style={{ paddingTop: 10 }}>Loading…</div> : null}
            {!busy && orderedForView.length === 0 ? (
              <div className="muted" style={{ paddingTop: 10 }}>S’KA POROSI GATI PËR TY.</div>
            ) : null}

            <div className="list">
              {orderedForView.map((it, idx) => {
                const checked = !!sel[it.id];
                const isInRoute = routeIds ? routeIds.includes(it.id) : false;
                return (
                  <div
                    key={it.id}
                    className={"rowline" + (checked ? " selected" : "")}
                    onMouseDown={() => startLongPress(it)}
                    onMouseUp={cancelLongPress}
                    onMouseLeave={cancelLongPress}
                    onTouchStart={() => startLongPress(it)}
                    onTouchEnd={cancelLongPress}
                    onTouchCancel={cancelLongPress}
                  >
                    <div className="left">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(it.id)}
                        style={{ width: 18, height: 18 }}
                      />
                      <span className="code">{it.code}</span>
                      <div className="meta">
                        <div className="name">{it.name}</div>
                        <div className="sub">{it.pieces} COPË • €{Number(it.total || 0).toFixed(2)}</div>
                      </div>
                    </div>

                    <div className="actions">
                      {it.hasGeo ? (
                        <button
                          className="btn ghost"
                          onClick={() => openAppleMaps(it.lat, it.lng)}
                          onContextMenu={(e) => { e.preventDefault(); openGoogleMaps(it.lat, it.lng); }}
                          title="GO (tap=Apple, long=Google)"
                        >
                          GO
                        </button>
                      ) : (
                        <button className="btn ghost" disabled title="S’ka GPS">GO</button>
                      )}

                      <button
                        className="btn ghost"
                        onClick={() => { setEditRow({ id: it.id }); setEditOpen(true); }}
                        title="EDIT (tap)"
                      >EDIT</button>

                      <button
                        className="btn ghost"
                        onClick={() => {
                          const msg = getConfirmMsg(it.name, it.code);
                          openSMS(it.phone, msg);
                        }}
                        title="SMS (tap)"
                      >
                        SMS
                      </button>

                      <button
                        className="btn"
                        onClick={() => {
                          setPayOrder({ id: it.id, code: it.code, client_name: it.name, total_eur: it.total, paidToDate: 0 });
                          setPayOpen(true);
                        }}
                      >
                        PAGUAR
                      </button>

                      <button className="btn ghost" onClick={() => setOpenId((v) => (v === it.id ? null : it.id))}>HAP</button>
                    </div>

                    {routeOpen && routeIds && isInRoute ? (
                      <div className="routeTools">
                        <div className="routeBadge">STOP {routeIds.indexOf(it.id)+1}</div>
                        <button className="mini" onClick={() => moveRoute(it.id, -1)}>↑</button>
                        <button className="mini" onClick={() => moveRoute(it.id, 1)}>↓</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {routeOpen && routeIds && routeIds.length ? (
              <div className="routeBox">
                <div className="t">NGARKESA (REKOMANDIM)</div>
                <div className="muted">STOP 1 dorëzohet i pari → NGARKOHET I FUNDIT. (LOAD ORDER = reverse)</div>
                <div className="muted" style={{ marginTop: 8 }}>
                  LOAD ORDER: {routeIds.slice().reverse().map((id) => (prettyItems.find((x)=>x.id===id)?.code || id)).join(' → ')}
                </div>
                <div style={{ display:'flex', gap:8, marginTop:10 }}>
                  <button className="btn ghost" onClick={() => setRouteOpen(false)}>FSHIH TOOLS</button>
                  <button className="btn ghost" onClick={() => { setRouteIds(null); setRouteOpen(false); }}>RESET</button>
                </div>
              </div>
            ) : null}

          </section>

          {/* Bulk confirm modal */}
          {bulkOpen ? (
            <div className="modalBack" onClick={() => setBulkOpen(false)}>
              <div className="modal" onClick={(e)=>e.stopPropagation()}>
                <div className="t">BULK SMS ({bulkIdx+1}/{bulkIds.length})</div>
                {bulkCurrentItem() ? (
                  <>
                    <div className="muted" style={{ marginTop: 8 }}>
                      {bulkCurrentItem().code} • {bulkCurrentItem().name}
                    </div>
                    <div className="box" style={{ marginTop: 10 }}>
                      {getConfirmMsg(bulkCurrentItem().name, bulkCurrentItem().code)}
                    </div>
                    <div style={{ display:'flex', gap:8, marginTop:12, justifyContent:'space-between' }}>
                      <button className="btn ghost" onClick={() => setBulkOpen(false)}>MBYLL</button>
                      <button
                        className="btn"
                        onClick={() => openSMS(bulkCurrentItem().phone, getConfirmMsg(bulkCurrentItem().name, bulkCurrentItem().code))}
                      >
                        HAP SMS
                      </button>
                      <button
                        className="btn ghost"
                        onClick={() => {
                          if (bulkIdx >= bulkIds.length-1) { setBulkOpen(false); return; }
                          setBulkIdx((x)=>x+1);
                        }}
                      >
                        NEXT →
                      </button>
                    </div>
                    <div className="muted" style={{ marginTop: 10 }}>
                      Tip: Pasi ta dërgosh SMS-in, kthehu në app dhe shtyp NEXT.
                    </div>
                  </>
                ) : (
                  <div className="muted" style={{ marginTop: 10 }}>S’ka item.</div>
                )}
              </div>
            </div>
          ) : null}

          <TransportEditModal
            open={editOpen}
            row={editRow}
            onClose={() => setEditOpen(false)}
            onSaved={load}
          />

          <PaySheetPortal
            open={payOpen}
            order={payOrder}
            onClose={() => { setPayOpen(false); setPayOrder(null); }}
            onSubmit={async (payload) => {
              const amt = Number(payload?.register_eur ?? payload?.registerEur ?? payload?.amount_registered ?? payload?.amount ?? payload?.payDue ?? 0);
              const r = await submitTransportPayment({
                orderId: payOrder?.id,
                code: payOrder?.code,
                name: payOrder?.client_name,
                amount: amt,
              });
              if (!r?.ok) throw new Error(r?.error || 'PAY_FAILED');
              // ✅ pas pageses, mbyll porosine (hiqet nga lista GATI)
              try {
                if (payOrder?.id) {
                  await supabase.from('transport_orders').update({ status: 'dorzim' }).eq('id', payOrder.id);
                }
              } catch {}
              setPayOpen(false);
              setPayOrder(null);
              await load();
              return r;
            }}
          />

          <style jsx>{`
            .wrap { padding: 18px; max-width: 980px; margin: 0 auto; }
            .header-row { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; margin-bottom: 14px; }
            .title { margin:0; font-size: 22px; letter-spacing: .5px; }
            .subtitle { opacity:.8; font-size: 12px; margin-top: 2px; }
            .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 14px; }
            .pill { padding: 8px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); text-decoration:none; font-weight:700; font-size: 12px; }
            .btn { padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; font-weight: 800; font-size: 12px; text-decoration:none; }
            .btn.ghost { background: transparent; }
            .btn:disabled { opacity:.4; }
            .muted { opacity:.75; font-size: 12px; }
            .t { font-weight: 900; letter-spacing:.6px; }
            .toolbar { display:flex; flex-wrap:wrap; gap: 8px; align-items:center; justify-content:space-between; margin-bottom: 10px; }
            .list { margin-top: 8px; display:flex; flex-direction:column; gap: 8px; }
            .rowline { display:flex; justify-content:space-between; align-items:center; gap: 10px; padding: 10px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.03); }
            .rowline.selected { border-color: rgba(34,197,94,.45); background: rgba(34,197,94,.10); }
            .left { display:flex; align-items:center; gap: 10px; min-width: 0; flex: 1; }
            .code { background: rgba(34,197,94,.18); border: 1px solid rgba(34,197,94,.35); padding: 6px 10px; border-radius: 999px; font-weight: 900; }
            .meta { min-width: 0; }
            .name { font-weight: 900; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
            .sub { opacity:.8; font-size: 12px; margin-top: 1px; }
            .actions { display:flex; gap: 8px; align-items:center; }
            .routeTools { display:flex; align-items:center; gap: 6px; margin-left: 8px; }
            .routeBadge { font-size: 11px; font-weight: 900; padding: 4px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.16); opacity:.9; }
            .mini { width: 28px; height: 28px; border-radius: 10px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); color: inherit; font-weight: 900; }
            .expanded { width: 100%; margin-top: 10px; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); }
            .expRow { display:flex; flex-direction:column; gap: 4px; }
            .expTitle { font-weight: 900; font-size: 11px; letter-spacing:.6px; opacity:.9; }
            .expGrid { display:grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
            .expBtns { display:flex; flex-wrap:wrap; gap: 8px; margin-top: 10px; }
            .routeBox { margin-top: 12px; padding: 12px; border-radius: 12px; border: 1px dashed rgba(255,255,255,.18); background: rgba(255,255,255,.03); }
            .modalBack { position: fixed; inset: 0; background: rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index: 9999; padding: 18px; }
            .modal { width: min(560px, 100%); background: #0b0f14; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 14px; }
            .box { padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); font-size: 13px; line-height: 1.35; }

            @media (max-width: 520px) {
              .wrap { padding: 14px; }
              .header-row { margin-bottom: 10px; }
              .toolbar { gap: 10px; }
              .rowline { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
              .left { width: 100%; }
              .actions { width: 100%; display: flex; flex-wrap: nowrap; gap: 8px; justify-content: space-between; }
              .actions .btn { flex: 1; min-height: 44px; padding: 10px 10px; font-size: 12px; border-radius: 14px; }
              .actions .btn.ghost { background: rgba(255,255,255,.04); }
              .code { padding: 6px 10px; }
              .name { font-size: 14px; }
              .sub { font-size: 12px; }
              .routeTools { width: 100%; justify-content: flex-end; margin-left: 0; }
            }
.btn { padding: 8px 10px; }
              .code { padding: 6px 9px; }
            }
          `}</style>
        </>
      )}
    </main>
  );
}
