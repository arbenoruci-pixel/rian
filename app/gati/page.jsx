'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// -------------------- HELPERS TË PËRBASHKËTA --------------------

function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function sanitizePhone(phone) {
  return (phone || '').replace(/[^0-9+]+/g, '');
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
    status: order.status || 'pranim',
    returned: !!(order.returnInfo && order.returnInfo.active),
    ts: order.ts || Date.now(),
  };
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

  const entry = buildIndexFromOrder(order);
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

async function uploadPhoto(file, oid, key) {
  if (!supabase || !file) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file);
  if (error) return null;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
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
      if (order.status !== 'gati') continue; // vetëm GATI
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
    return list.filter((o) => !o.status || o.status === 'gati');
  } catch {
    return [];
  }
}

async function loadFullOrder(id) {
  if (!id) return null;

  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(`order_${id}`);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {
      // ignore
    }
  }

  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(`orders/${id}.json`);
    if (error || !data) return null;
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// -------------------- ARKA HELPERS --------------------

async function saveArkaRecord(order, paidAmount) {
  if (!order || !order.id) return;

  const ts = Date.now();
  const rec = {
    id: `arka_${order.id}_${ts}`,
    orderId: order.id,
    code: normalizeCode(order.client?.code || ''),
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    paid: Number(paidAmount) || 0,
    ts,
  };

  if (typeof window !== 'undefined') {
    try {
      let list = [];
      try {
        list = JSON.parse(localStorage.getItem('arka_list_v1') || '[]');
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      list.unshift(rec);
      list = list.slice(0, 500);
      localStorage.setItem('arka_list_v1', JSON.stringify(list));
    } catch (e) {
      console.error('Error saving ARKA locally', e);
    }
  }

  if (supabase) {
    try {
      const path = `arka/${rec.id}.json`;
      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(rec)], { type: 'application/json' })
          : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
      }
    } catch (e) {
      console.error('Error saving ARKA to Supabase', e);
    }
  }
}

// -------------------- KOMPONENTA GATI --------------------

export default function GatiPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [panelOrder, setPanelOrder] = useState(null); // full order
  const [panelMode, setPanelMode] = useState('pay'); // 'pay' | 'return'
  const [panelPaid, setPanelPaid] = useState('');
  const [panelSaving, setPanelSaving] = useState(false);

  const [returnReason, setReturnReason] = useState('');
  const [returnNotes, setReturnNotes] = useState('');
  const [returnPhotoUrl, setReturnPhotoUrl] = useState('');

  async function refresh() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('Error loading GATI from Supabase, fallback local', e);
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
    refresh();
  }, []);

  const totalM2 = useMemo(
    () => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0),
    [orders],
  );

  // >>> RENDITJA: sipas KODIT (zbritës), pastaj sipas TS
  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();

    const base = [...orders].sort((a, b) => {
      const ca = Number(normalizeCode(a.code) || 0);
      const cb = Number(normalizeCode(b.code) || 0);
      if (cb !== ca) return cb - ca;
      return (b.ts || 0) - (a.ts || 0);
    });

    if (!q) return base;

    return base.filter((o) => {
      const name = (o.name || '').toLowerCase();
      const phone = (o.phone || '').toLowerCase();
      const code = String(o.code || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || code.includes(q);
    });
  }, [orders, search]);

  function formatCode(raw) {
    const n = normalizeCode(raw);
    return n || '?';
  }

  function openReadySms(row, fullOrder) {
    const order = fullOrder || panelOrder || {};

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
      `Faleminderit!`;

    const encoded = encodeURIComponent(text);

    if (typeof window !== 'undefined') {
      window.location.href = `sms:${digits}?&body=${encoded}`;
    }
  }

  async function handleOpenPanel(row) {
    const full = await loadFullOrder(row.id);
    if (!full) {
      alert('Nuk u gjet porosia e plotë.');
      return;
    }
    setPanelOrder(full);
    setPanelMode('pay');
    const euro = computeTotalEuro(full);
    setPanelPaid(euro ? String(euro) : '');
    setReturnReason('');
    setReturnNotes('');
    setReturnPhotoUrl(full.returnInfo?.photoUrl || '');
  }

  function closePanel() {
    setPanelOrder(null);
    setPanelSaving(false);
  }

  const panelTotalEuro = useMemo(
    () => (panelOrder ? computeTotalEuro(panelOrder) : 0),
    [panelOrder],
  );

  const panelChange = useMemo(() => {
    const paid = Number(panelPaid) || 0;
    const total = panelTotalEuro;
    const diff = paid - total;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [panelPaid, panelTotalEuro]);

  const panelDebt = useMemo(() => {
    const paid = Number(panelPaid) || 0;
    const total = panelTotalEuro;
    const diff = total - paid;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [panelPaid, panelTotalEuro]);

  async function handleUploadReturnPhoto(file) {
    if (!file || !panelOrder) return;
    const url = await uploadPhoto(file, panelOrder.id, 'return');
    if (url) setReturnPhotoUrl(url);
  }

  async function handleSavePayment() {
    if (!panelOrder) return;
    const paid = Number(panelPaid) || 0;
    const total = panelTotalEuro;

    try {
      setPanelSaving(true);

      const newPay = {
        ...(panelOrder.pay || {}),
        m2: computeM2(panelOrder),
        euro: total,
        rate: Number(panelOrder.pay?.rate) || 0,
        paid,
        debt: panelDebt,
        change: panelChange,
      };

      const updated = {
        ...panelOrder,
        pay: newPay,
        status: 'dorzim',
        deliveredAt: Date.now(),
      };

      saveOrderLocal(updated);
      await saveOrderOnline(updated);
      await saveArkaRecord(updated, paid || total);

      setOrders((prev) => prev.filter((o) => o.id !== updated.id));
      closePanel();
      alert('Pagesa u regjistrua dhe porosia u kalua në DORZIM.');
    } catch (e) {
      console.error('Error saving payment', e);
      alert('Ndodhi një gabim gjatë ruajtjes së pagesës.');
    } finally {
      setPanelSaving(false);
    }
  }

  async function handleSaveReturn() {
    if (!panelOrder) return;
    if (!returnReason.trim()) {
      alert('Shkruaj arsyen e kthimit.');
      return;
    }

    try {
      setPanelSaving(true);

      const updated = {
        ...panelOrder,
        status: 'pastrim',
        returnInfo: {
          active: true,
          reason: returnReason.trim(),
          notes: returnNotes.trim(),
          photoUrl: returnPhotoUrl || panelOrder.returnInfo?.photoUrl || '',
          ts: Date.now(),
        },
      };

      saveOrderLocal(updated);
      await saveOrderOnline(updated);

      setOrders((prev) => prev.filter((o) => o.id !== updated.id));
      closePanel();
      alert('Porosia u shënua si KTHIM dhe u kthye në PASTRIMI.');
    } catch (e) {
      console.error('Error saving return', e);
      alert('Ndodhi një gabim gjatë ruajtjes së kthimit.');
    } finally {
      setPanelSaving(false);
    }
  }

  // -------------------- RENDER --------------------

  return (
    <div className="wrap" style={{ paddingBottom: '90px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">GATI</h1>
          <div className="subtitle">POROSITË E GATSHME PËR MARRJE</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL M²: <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e porosive GATI</h2>

        <div className="field-group" style={{ marginBottom: 8 }}>
          <input
            className="input"
            type="search"
            placeholder="Kërko me emër / telefon / kod..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && filteredOrders.length === 0 && (
          <p>Nuk ka porosi GATI. Kalo nga PASTRIMI.</p>
        )}

        {!loading &&
          filteredOrders.map((o) => (
            <div key={o.id} className="home-btn" style={{ marginBottom: 8 }}>
              <div className="home-btn-main" style={{ alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
                    {formatCode(o.code)}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>{o.name || 'Pa emër'}</span>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>
                      {o.pieces || 0} cop •{' '}
                      {o.m2?.toFixed?.(2) || Number(o.m2 || 0).toFixed(2)} m²
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    alignItems: 'flex-end',
                  }}
                >
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => openReadySms(o, null)}
                  >
                    SMS
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => handleOpenPanel(o)}
                  >
                    💶 PAGUAJE
                  </button>
                </div>
              </div>
            </div>
          ))}
      </section>

      {panelOrder && (
        <div
          className="dialog-backdrop"
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            top: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
            zIndex: 40,
          }}
          onClick={closePanel}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: 520,
              margin: 0,
              borderRadius: '16px 16px 0 0',
              paddingBottom: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="header-row"
              style={{ justifyContent: 'space-between', marginBottom: 8 }}
            >
              <div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>KODI</div>
                <div style={{ fontWeight: 700 }}>
                  {panelOrder.client?.code
                    ? normalizeCode(panelOrder.client.code)
                    : '—'}
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {panelOrder.client?.name || 'Pa emër'} •{' '}
                  {(panelOrder.client?.phone || '').trim()}
                </div>
              </div>
              <button
                type="button"
                className="btn secondary"
                onClick={closePanel}
                style={{ padding: '4px 10px', fontSize: 12 }}
              >
                MBYLL
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                marginBottom: 12,
                borderRadius: 999,
                padding: 2,
                background: '#020617',
              }}
            >
              <button
                type="button"
                className="btn"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: '6px 0',
                  borderRadius: 999,
                  background:
                    panelMode === 'pay' ? '#2563eb' : 'transparent',
                  border: 'none',
                }}
                onClick={() => setPanelMode('pay')}
              >
                💵 PAGESA
              </button>
              <button
                type="button"
                className="btn"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: '6px 0',
                  borderRadius: 999,
                  background:
                    panelMode === 'return' ? '#dc2626' : 'transparent',
                  border: 'none',
                }}
                onClick={() => setPanelMode('return')}
              >
                ↩️ KTHIM
              </button>
            </div>

            {panelMode === 'pay' && (
              <>
                <div className="field-group">
                  <label className="label">PAGESA</label>
                  <div className="tot-line small">
                    Totali: <strong>{panelTotalEuro.toFixed(2)} €</strong> · Borxh:{' '}
                    <strong>{panelDebt.toFixed(2)} €</strong> · Kthim:{' '}
                    <strong>{panelChange.toFixed(2)} €</strong>
                  </div>

                  <div className="row" style={{ marginTop: 8, marginBottom: 8 }}>
                    <input
                      className="input small"
                      type="number"
                      min="0"
                      step="0.1"
                      value={panelPaid}
                      onChange={(e) => setPanelPaid(e.target.value)}
                      placeholder="KLIENTI DHA"
                    />
                  </div>

                  <div className="chip-row">
                    {[10, 20, 30, 50].map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="chip"
                        onClick={() =>
                          setPanelPaid(String((Number(panelPaid) || 0) + v))
                        }
                      >
                        +{v} €
                      </button>
                    ))}
                    <button
                      type="button"
                      className="chip chip-outline"
                      onClick={() =>
                        setPanelPaid(String(panelTotalEuro.toFixed(2)))
                      }
                    >
                      = TOTALI
                    </button>
                  </div>
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={handleSavePayment}
                    disabled={panelSaving}
                  >
                    {panelSaving ? 'Duke ruajtur...' : 'RUAJ PAGESËN'}
                  </button>
                </div>
              </>
            )}

            {panelMode === 'return' && (
              <>
                <div className="field-group">
                  <label className="label">ARSYE KTHIMI</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    placeholder="P.sh. njolla nuk janë hequr, tepihu ka problem, kërkesë e klientit..."
                  />
                </div>

                <div className="field-group">
                  <label className="label">SHËNIME</label>
                  <textarea
                    className="input"
                    rows={2}
                    value={returnNotes}
                    onChange={(e) => setReturnNotes(e.target.value)}
                    placeholder="Opsionale: komente të tjera."
                  />
                </div>

                <div className="field-group">
                  <label className="label">FOTO KTHIMI</label>
                  <div className="row" style={{ alignItems: 'center', gap: 12 }}>
                    <label className="camera-btn">
                      📷
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) =>
                          handleUploadReturnPhoto(e.target.files?.[0] || null)
                        }
                      />
                    </label>
                    {returnPhotoUrl && (
                      <a
                        href={returnPhotoUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 13 }}
                      >
                        Shiko foton
                      </a>
                    )}
                  </div>
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn primary"
                    style={{ backgroundColor: '#dc2626' }}
                    onClick={handleSaveReturn}
                    disabled={panelSaving}
                  >
                    {panelSaving ? 'Duke ruajtur...' : 'RUAJ KTHIMIN'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}