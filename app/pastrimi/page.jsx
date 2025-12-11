'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

// -------------------- HELPERS --------------------

function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function sanitizePhone(phone) {
  return (phone || '').replace(/[^0-9+]+/g, '');
}

async function uploadPhoto(file, oid, key) {
  if (!supabase || !file) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file);
  if (error) return null;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

function computePieces(order) {
  return (
    (Array.isArray(order.tepiha) ? order.tepiha.length : 0) +
    (Array.isArray(order.staza) ? order.staza.length : 0) +
    (order.shkallore && Number(order.shkallore.qty) > 0 ? 1 : 0)
  );
}

function computeM2(order) {
  if (order.pay && typeof order.pay.m2 === 'number') {
    return Number(order.pay.m2) || 0;
  }
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (order.shkallore) {
    const qty = Number(order.shkallore.qty) || 0;
    const per = Number(order.shkallore.per) || 0;
    total += qty * per;
  }
  return Number(total.toFixed(2));
}

function computeTotalEuro(order) {
  if (order.pay && typeof order.pay.euro === 'number') {
    return Number(order.pay.euro) || 0;
  }
  const m2 = computeM2(order);
  const rate = order.pay && typeof order.pay.rate === 'number' ? Number(order.pay.rate) : 0;
  return Number((m2 * rate).toFixed(2));
}

function saveOrderLocal(order) {
  if (typeof window === 'undefined') return;
  const { id } = order;
  localStorage.setItem(`order_${id}`, JSON.stringify(order));

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  const entry = {
    id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    queued: !!order.queued,
    status: order.status || 'pastrim',
    ts: order.ts || Date.now(),
  };

  const idx = list.findIndex((o) => o.id === id);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);

  list = list.slice(0, 200);
  localStorage.setItem('order_list_v1', JSON.stringify(list));
}

async function saveOrderOnline(order) {
  if (!supabase) return;
  const { id, client } = order;
  if (!id) return;

  const path = `orders/${id}.json`;
  const blob =
    typeof Blob !== 'undefined'
      ? new Blob([JSON.stringify(order)], { type: 'application/json' })
      : null;
  if (blob) {
    await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
  }

  const code = client?.code;
  if (code) {
    const n = normalizeCode(code);
    const usedPath = `codes/x${n}.used`;
    const usedBlob =
      typeof Blob !== 'undefined'
        ? new Blob([JSON.stringify({ at: new Date().toISOString() })], {
            type: 'application/json',
          })
        : null;
    if (usedBlob) {
      await supabase.storage.from(BUCKET).upload(usedPath, usedBlob, { upsert: true });
    }
  }
}

function buildIndexFromOrder(order) {
  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  return {
    id: order.id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    queued: !!order.queued,
    status: order.status || 'pastrim',
    ts: order.ts || Date.now(),
  };
}

async function loadOrdersFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const orders = [];
  for (const item of data) {
    if (!item || !item.name) continue;
    try {
      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`orders/${item.name}`);
      if (dErr || !file) continue;
      const text = await file.text();
      const order = JSON.parse(text);
      if (!order || !order.id) continue;
      const idxEntry = buildIndexFromOrder(order);
      orders.push(idxEntry);
      saveOrderLocal(order);
    } catch (e) {
      console.error('Error parsing order from Supabase', item.name, e);
    }
  }

  orders.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return orders;
}

function loadOrdersIndexLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    const list = Array.isArray(raw) ? raw : [];
    // siguro status default
    return list.map((o) => ({ status: 'pastrim', ...o }));
  } catch {
    return [];
  }
}

// -------------------- COMPONENT --------------------

export default function PastrimiPage() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fullDetail, setFullDetail] = useState(false);
  const [queueMode, setQueueMode] = useState(false);
  const [loading, setLoading] = useState(true);

  const longPressTimer = useRef(null);

  async function refreshOrders() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('Error loading from Supabase, falling back to local', e);
      }
      if (online && online.length > 0) {
        setOrders(online);
      } else {
        setOrders(loadOrdersIndexLocal());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refreshOrders();
  }, []);

  useEffect(() => {
    if (!selectedId || !fullDetail) {
      setDetail(null);
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(`order_${selectedId}`);
      if (!raw) {
        setDetail(null);
        return;
      }
      const ord = JSON.parse(raw);
      setDetail(ord);
    } catch {
      setDetail(null);
    }
  }, [selectedId, fullDetail]);

  // vetëm porositë me status 'pastrim' për këtë faqe
  const pastrimOrders = useMemo(
    () => orders.filter((o) => (o.status || 'pastrim') === 'pastrim'),
    [orders],
  );

  const listTotalM2 = useMemo(() => {
    return pastrimOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
  }, [pastrimOrders]);

  // SMART CAPACITY – njëjt stil me PRANIMI
  const capacityInfo = useMemo(() => {
    const m2 = listTotalM2;

    if (m2 <= 0) {
      return {
        text: 'NORMAL • MARRJE PAS 2 DITËVE',
        color: '#22c55e',
        days: 2,
      };
    }

    let label = 'NORMAL';
    let days = 2;
    let color = '#22c55e';

    if (m2 > 400 && m2 <= 600) {
      label = 'NË NGARKIM';
      days = 3;
      color = '#f97316';
    } else if (m2 > 600 && m2 <= 800) {
      label = 'I MBINGARKUAR';
      days = 4;
      color = '#ef4444';
    } else if (m2 > 800) {
      label = 'EKSTREM';
      days = 5;
      color = '#dc2626';
    }

    return {
      text: `${label} • MARRJE PAS ${days} DITËVE`,
      color,
      days,
    };
  }, [listTotalM2]);

  function formatCodeForList(raw) {
    const n = normalizeCode(raw);
    return n || '?';
  }

  function startLongPress(id) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      setSelectedId(id);
      setFullDetail(true);
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function openReadySms(row, fullOrder) {
    const order = fullOrder || detail || {};

    const phone = row?.phone || order?.client?.phone || '';
    const digits = sanitizePhone(phone);
    if (!digits) {
      alert('Nuk ka numër telefoni për SMS.');
      return;
    }

    const name = row?.name || order?.client?.name || 'klient';
    const codeRaw = order?.client?.code || row?.code || '';
    const codeClean = normalizeCode(codeRaw);

    const pieces = computePieces(order);
    const m2 = computeM2(order);
    const euro = computeTotalEuro(order);

    const text =
      `Përshëndetje ${name}, ` +
      `porosia juaj e tepihave${codeClean ? ` (kodi ${codeClean})` : ''} është GATI për t'u marrë.\n` +
      `Keni ${pieces} copë = ${m2.toFixed(2)} m². Totali për pagesë: ${euro.toFixed(2)} €.\n` +
      `Ju lutemi t’i tërhiqni sa më shpejt të jetë e mundur, ` +
      `pasi kemi mungesë hapësire dhe duam të shmangim çdo ngatërresë me porositë e tjera.\n` +
      `Faleminderit!`;

    const encoded = encodeURIComponent(text);

    if (typeof window !== 'undefined') {
      window.location.href = `sms:${digits}?&body=${encoded}`;
    }
  }

  // GATI – veç e çon porosinë në status 'gati', pa navigim
  async function handleMarkReady(row) {
    if (!row || !row.id) return;
    if (typeof window === 'undefined') return;

    let full = null;
    try {
      const raw = localStorage.getItem(`order_${row.id}`);
      if (raw) full = JSON.parse(raw);
    } catch {
      full = null;
    }

    if (!full) {
      alert('Nuk u gjet porosia e plote.');
      return;
    }

    const updated = {
      ...full,
      status: 'gati',
      readyAt: Date.now(),
    };

    saveOrderLocal(updated);
    await saveOrderOnline(updated);

    alert('Porosia u kalua në GATI.');
    await refreshOrders(); // lista rifreskohet, por je prap në PASTRIMI
  }

  async function toggleQueued(row) {
    if (!row || !row.id) return;
    if (typeof window === 'undefined') return;
    let full = null;
    try {
      const raw = localStorage.getItem(`order_${row.id}`);
      if (raw) full = JSON.parse(raw);
    } catch {
      full = null;
    }
    if (!full) return;
    const updated = {
      ...full,
      queued: !full.queued,
    };
    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();
  }

  // ---------- DETAIL UPDATERS ----------

  function updateClient(field, value) {
    setDetail((prev) =>
      !prev
        ? prev
        : {
            ...prev,
            client: {
              ...(prev.client || {}),
              [field]: value,
            },
          },
    );
  }

  function updatePay(field, value) {
    setDetail((prev) =>
      !prev
        ? prev
        : {
            ...prev,
            pay: {
              ...(prev.pay || {}),
              [field]: value,
            },
          },
    );
  }

  function updateNotes(value) {
    setDetail((prev) => (!prev ? prev : { ...prev, notes: value }));
  }

  function handleChip(section, value) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];

      if (!arr.length) {
        arr.push({ m2: value || 0, qty: 1, photoUrl: '' });
      } else {
        const last = arr[arr.length - 1];
        if (!last.m2) {
          arr[arr.length - 1] = { ...last, m2: value || 0 };
        } else {
          arr.push({ m2: value || 0, qty: 1, photoUrl: '' });
        }
      }

      return { ...prev, [section]: arr };
    });
  }

  function updatePiece(section, index, field, value) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      if (!arr[index]) return prev;
      arr[index] = { ...arr[index], [field]: value };
      return { ...prev, [section]: arr };
    });
  }

  function addPiece(section) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      arr.push({ m2: 0, qty: 1, photoUrl: '' });
      return { ...prev, [section]: arr };
    });
  }

  function removePiece(section) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      if (!arr.length) return prev;
      arr.pop();
      return { ...prev, [section]: arr };
    });
  }

  function updateStairs(field, value) {
    setDetail((prev) => {
      if (!prev) return prev;
      const s = { ...(prev.shkallore || {}) };
      s[field] = value;
      return { ...prev, shkallore: s };
    });
  }

  async function clearStairs() {
    if (!detail) return;
    const updated = {
      ...detail,
      shkallore: { qty: 0, per: 0, photoUrl: '' },
    };
    setDetail(updated);
    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();
  }

  // ---------- PHOTO HANDLERS ----------

  async function handlePiecePhotoChange(section, index, file) {
    if (!file || !detail) return;
    const oid = detail.id;
    if (!oid) return;

    const key = `${section}_${index}`;
    const url = await uploadPhoto(file, oid, key);
    if (!url) return;

    const arr = Array.isArray(detail[section]) ? [...detail[section]] : [];
    if (!arr[index]) return;

    arr[index] = { ...arr[index], photoUrl: url };
    const updated = { ...detail, [section]: arr };

    setDetail(updated);
    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();
  }

  async function handleStairsPhotoChange(file) {
    if (!file || !detail) return;
    const oid = detail.id;
    if (!oid) return;

    const key = 'shkallore';
    const url = await uploadPhoto(file, oid, key);
    if (!url) return;

    const updated = {
      ...detail,
      shkallore: {
        ...(detail.shkallore || {}),
        photoUrl: url,
      },
    };

    setDetail(updated);
    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();
  }

  // ---------- TOTALS FOR DETAIL ----------

  const totalTepihaM2 = useMemo(() => {
    if (!detail || !Array.isArray(detail.tepiha)) return 0;
    return detail.tepiha.reduce((sum, r) => {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      return sum + m2 * qty;
    }, 0);
  }, [detail]);

  const totalStazaM2 = useMemo(() => {
    if (!detail || !Array.isArray(detail.staza)) return 0;
    return detail.staza.reduce((sum, r) => {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      return sum + m2 * qty;
    }, 0);
  }, [detail]);

  const totalStairsM2 = useMemo(() => {
    if (!detail || !detail.shkallore) return 0;
    const qty = Number(detail.shkallore.qty) || 0;
    const per = Number(detail.shkallore.per) || 0;
    return qty * per;
  }, [detail]);

  const totalM2Detail = useMemo(
    () => Number((totalTepihaM2 + totalStazaM2 + totalStairsM2).toFixed(2)),
    [totalTepihaM2, totalStazaM2, totalStairsM2],
  );

  const totalEuroDetail = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const rate = Number(detail.pay.rate) || 0;
    return Number((totalM2Detail * rate).toFixed(2));
  }, [detail, totalM2Detail]);

  const debtDetail = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const paid = Number(detail.pay.paid) || 0;
    const diff = totalEuroDetail - paid;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [detail, totalEuroDetail]);

  const changeDetail = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const paid = Number(detail.pay.paid) || 0;
    const diff = paid - totalEuroDetail;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [detail, totalEuroDetail]);

  async function handleSave() {
    if (!detail) return;
    if (!detail.client || !detail.client.name) {
      alert('Shkruaj emrin e klientit.');
      return;
    }

    const rate = Number(detail.pay?.rate) || 0;
    const paid = Number(detail.pay?.paid) || 0;
    const newPay = {
      ...(detail.pay || {}),
      m2: totalM2Detail,
      euro: totalEuroDetail,
      rate,
      paid,
      debt: debtDetail,
      change: changeDetail,
    };

    const updated = {
      ...detail,
      ts: detail.ts || Date.now(),
      pay: newPay,
      status: detail.status || 'pastrim',
    };

    try {
      setSaving(true);
      saveOrderLocal(updated);
      await saveOrderOnline(updated);
      setDetail(updated);
      await refreshOrders();
      alert('Ndryshimet u ruajtën.');
    } catch (err) {
      console.error('Error saving order from PASTRIMI', err);
      alert('Ndodhi një gabim gjatë ruajtjes.');
    } finally {
      setSaving(false);
    }
  }

  // -------------------- RENDER --------------------

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">PASTRIMI</h1>
          <div className="subtitle">LISTA DHE DETAJET</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL M²: <strong>{listTotalM2.toFixed(2)} m²</strong>
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: capacityInfo.color,
              maxWidth: 220,
            }}
          >
            {capacityInfo.text}
          </div>
          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 4, padding: '2px 8px', fontSize: 11 }}
            onClick={() => setQueueMode((v) => !v)}
          >
            QUEUE: {queueMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </header>

      {!fullDetail && (
        <section className="card">
          <h2 className="card-title">Lista e porosive</h2>
          {loading && <p>Duke i lexuar porositë...</p>}
          {!loading && pastrimOrders.length === 0 && <p>Nuk ka porosi. Shto nga PRANIMI.</p>}
          {!loading &&
            pastrimOrders.map((o) => (
              <div
                key={o.id}
                className="home-btn"
                style={{
                  marginBottom: 8,
                  borderColor: selectedId === o.id ? '#196bff' : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 12,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  onMouseDown={() => startLongPress(o.id)}
                  onMouseUp={cancelLongPress}
                  onMouseLeave={cancelLongPress}
                  onTouchStart={() => startLongPress(o.id)}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      padding: '2px 8px',
                      borderRadius: 4,
                      backgroundColor: '#16a34a',
                      color: '#ffffff',
                      minWidth: 32,
                      textAlign: 'center',
                    }}
                  >
                    {formatCodeForList(o.code)}
                  </span>
                  <span>{o.name || 'Pa emër'}</span>
                  {typeof o.pieces === 'number' && o.pieces > 0 && (
                    <span style={{ fontSize: 12, opacity: 0.85 }}>{o.pieces} cop</span>
                  )}
                  {typeof o.total === 'number' && o.total > 0 && (
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      {o.total.toFixed(2)} €
                    </span>
                  )}
                  {queueMode && (
                    <span
                      style={{
                        fontSize: 10,
                        opacity: 0.9,
                        marginLeft: 4,
                      }}
                    >
                      {o.queued ? 'QUEUE' : '—'}
                    </span>
                  )}
                </button>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {queueMode && (
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => toggleQueued(o)}
                    >
                      {o.queued ? 'UNQUEUE' : 'QUEUE'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    onClick={() => openReadySms(o, null)}
                  >
                    SMS
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    onClick={() => handleMarkReady(o)}
                  >
                    GATI
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}

      {detail && fullDetail && (
        <section className="card">
          <div
            className="header-row"
            style={{ justifyContent: 'space-between', alignItems: 'center' }}
          >
            <h2 className="card-title">Detajet e porosisë</h2>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setFullDetail(false);
                setDetail(null);
              }}
            >
              ← KTHEHU TE LISTA
            </button>
          </div>
          <div className="tot-line" style={{ marginBottom: 12 }}>
            <strong>
              {detail?.client?.code
                ? `KODI: ${normalizeCode(detail.client.code)}`
                : 'KODI: ——'}
            </strong>
          </div>

          {/* FOTO KLIENTI NGA PRANIMI */}
          {detail.client?.photoUrl && (
            <div className="thumb-row" style={{ marginBottom: 8 }}>
              <a href={detail.client.photoUrl} target="_blank" rel="noreferrer">
                Shiko foton
              </a>
              <div>
                <img
                  src={detail.client.photoUrl}
                  alt="Foto klienti"
                  className="photo-thumb"
                />
              </div>
            </div>
          )}

          <div className="field-group">
            <label className="label">Klienti</label>
            <input
              className="input"
              type="text"
              value={detail.client?.name || ''}
              onChange={(e) => updateClient('name', e.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="label">Telefoni</label>
            <input
              className="input"
              type="text"
              value={detail.client?.phone || ''}
              onChange={(e) => updateClient('phone', e.target.value)}
            />
          </div>

          {/* TEPIHA */}
          <div className="field-group">
            <label className="label">Tepiha</label>

            <div className="chip-row">
              {TEPIHA_CHIPS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="chip"
                  onClick={() => handleChip('tepiha', v)}
                >
                  {v.toFixed(1)} m²
                </button>
              ))}
              <button
                type="button"
                className="chip chip-outline"
                onClick={() => handleChip('tepiha', 0)}
              >
                Manual
              </button>
            </div>

            {(!detail.tepiha || detail.tepiha.length === 0) && (
              <p style={{ fontSize: 12, opacity: 0.8 }}>Shto tepihë me + Rresht.</p>
            )}

            {Array.isArray(detail.tepiha) &&
              detail.tepiha.map((r, idx) => (
                <div key={idx} className="piece-row">
                  <div className="row">
                    <input
                      className="input small"
                      type="number"
                      min="0"
                      step="0.1"
                      value={r.m2 ?? ''}
                      onChange={(e) => updatePiece('tepiha', idx, 'm2', e.target.value)}
                      placeholder="m²"
                    />
                    <input
                      className="input small"
                      type="number"
                      min="1"
                      step="1"
                      value={r.qty ?? ''}
                      onChange={(e) => updatePiece('tepiha', idx, 'qty', e.target.value)}
                      placeholder="copë"
                    />
                    <label className="camera-btn">
                      📷
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) =>
                          handlePiecePhotoChange('tepiha', idx, e.target.files?.[0] || null)
                        }
                      />
                    </label>
                  </div>
                  {r.photoUrl && (
                    <div className="thumb-row">
                      <a href={r.photoUrl} target="_blank" rel="noreferrer">
                        Shiko foton
                      </a>
                      <div>
                        <img src={r.photoUrl} alt="Foto tepih" className="photo-thumb" />
                      </div>
                    </div>
                  )}
                  <div className="tot-line small">
                    M²:{' '}
                    <strong>
                      {((Number(r.m2) || 0) * (Number(r.qty) || 0)).toFixed(2)} m²
                    </strong>
                  </div>
                </div>
              ))}

            <div className="row btn-row">
              <button
                type="button"
                className="btn secondary"
                onClick={() => addPiece('tepiha')}
              >
                + RRESHT
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => removePiece('tepiha')}
              >
                − RRESHT
              </button>
            </div>
          </div>

          {/* STAZA */}
          <div className="field-group">
            <label className="label">Staza</label>

            <div className="chip-row">
              {STAZA_CHIPS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="chip"
                  onClick={() => handleChip('staza', v)}
                >
                  {v.toFixed(1)} m²
                </button>
              ))}
              <button
                type="button"
                className="chip chip-outline"
                onClick={() => handleChip('staza', 0)}
              >
                Manual
              </button>
            </div>

            {(!detail.staza || detail.staza.length === 0) && (
              <p style={{ fontSize: 12, opacity: 0.8 }}>Shto staza me + Rresht.</p>
            )}

            {Array.isArray(detail.staza) &&
              detail.staza.map((r, idx) => (
                <div key={idx} className="piece-row">
                  <div className="row">
                    <input
                      className="input small"
                      type="number"
                      min="0"
                      step="0.1"
                      value={r.m2 ?? ''}
                      onChange={(e) => updatePiece('staza', idx, 'm2', e.target.value)}
                      placeholder="m²"
                    />
                    <input
                      className="input small"
                      type="number"
                      min="1"
                      step="1"
                      value={r.qty ?? ''}
                      onChange={(e) => updatePiece('staza', idx, 'qty', e.target.value)}
                      placeholder="copë"
                    />
                    <label className="camera-btn">
                      📷
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) =>
                          handlePiecePhotoChange('staza', idx, e.target.files?.[0] || null)
                        }
                      />
                    </label>
                  </div>
                  {r.photoUrl && (
                    <div className="thumb-row">
                      <a href={r.photoUrl} target="_blank" rel="noreferrer">
                        Shiko foton
                      </a>
                      <div>
                        <img src={r.photoUrl} alt="Foto staza" className="photo-thumb" />
                      </div>
                    </div>
                  )}
                  <div className="tot-line small">
                    M²:{' '}
                    <strong>
                      {((Number(r.m2) || 0) * (Number(r.qty) || 0)).toFixed(2)} m²
                    </strong>
                  </div>
                </div>
              ))}

            <div className="row btn-row">
              <button
                type="button"
                className="btn secondary"
                onClick={() => addPiece('staza')}
              >
                + RRESHT
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => removePiece('staza')}
              >
                − RRESHT
              </button>
            </div>
          </div>

          {/* SHKALLORE */}
          <div className="field-group">
            <label className="label">Shkallore</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="1"
                value={detail.shkallore?.qty ?? 0}
                onChange={(e) => updateStairs('qty', e.target.value)}
                placeholder="Sasia"
              />
              <input
                className="input small"
                type="number"
                min="0"
                step="0.01"
                value={detail.shkallore?.per ?? 0}
                onChange={(e) => updateStairs('per', e.target.value)}
                placeholder="m² / hap"
              />
              <label className="camera-btn">
                📷
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) =>
                    handleStairsPhotoChange(e.target.files?.[0] || null)
                  }
                />
              </label>
            </div>
            {detail.shkallore?.photoUrl && (
              <div className="thumb-row">
                <a href={detail.shkallore.photoUrl} target="_blank" rel="noreferrer">
                  Shiko foton
                </a>
                <div>
                  <img
                    src={detail.shkallore.photoUrl}
                    alt="Foto shkallore"
                    className="photo-thumb"
                  />
                </div>
              </div>
            )}
            <div className="tot-line small">
              Totali shkallore: <strong>{totalStairsM2.toFixed(2)} m²</strong>
            </div>
            <div className="row btn-row">
              <button type="button" className="btn secondary" onClick={clearStairs}>
                FSHIJ SHKALLORET
              </button>
            </div>
          </div>

          {/* PAGESA */}
          <div className="field-group">
            <label className="label">Pagesa</label>
            <div className="row">
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={detail.pay?.rate ?? 0}
                onChange={(e) => updatePay('rate', e.target.value)}
                placeholder="€ / m²"
              />
              <input
                className="input small"
                type="number"
                min="0"
                step="0.1"
                value={detail.pay?.paid ?? 0}
                onChange={(e) => updatePay('paid', e.target.value)}
                placeholder="KLIENTI DHA"
              />
            </div>
            <div className="tot-line small">
              Total: <strong>{totalEuroDetail.toFixed(2)} €</strong> · Borxh:{' '}
              <strong>{debtDetail.toFixed(2)} €</strong> · Kthim:{' '}
              <strong>{changeDetail.toFixed(2)} €</strong>
            </div>
          </div>

          {/* NOTES */}
          <div className="field-group">
            <label className="label">NOTS / SHËNIME</label>
            <textarea
              className="input"
              rows={3}
              value={detail.notes || ''}
              onChange={(e) => updateNotes(e.target.value)}
              placeholder="P.sh. njolla, dëmtime, kërkesa speciale, kthime..."
            />
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Duke ruajtur...' : 'RUAJ NDRYSHIMET'}
            </button>
          </div>
        </section>
      )}

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}