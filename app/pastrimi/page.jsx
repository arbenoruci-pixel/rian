'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function loadOrdersIndex() {
  if (typeof window === 'undefined') return [];
  try {
    const list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function loadOrderById(id) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`order_${id}`);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj;
  } catch {
    return null;
  }
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

  const idx = list.findIndex((o) => o.id === id);
  const entry = {
    id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    ts: order.ts || Date.now(),
  };
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
  const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });
  await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });

  const code = client?.code;
  if (code && /^X\d+$/i.test(code)) {
    const n = String(code).replace(/^X/i, '');
    const usedPath = `codes/x${n}.used`;
    const usedBlob = new Blob([JSON.stringify({ at: new Date().toISOString() })], {
      type: 'application/json',
    });
    await supabase.storage.from(BUCKET).upload(usedPath, usedBlob, { upsert: true });
  }
}

export default function PastrimiPage() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOrders(loadOrdersIndex());
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const o = loadOrderById(selectedId);
    if (!o) {
      setDetail(null);
      return;
    }
    setDetail(o);
  }, [selectedId]);

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

  const totalM2 = useMemo(() => {
    return Number((totalTepihaM2 + totalStazaM2 + totalStairsM2).toFixed(2));
  }, [totalTepihaM2, totalStazaM2, totalStairsM2]);

  const totalEuro = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const rate = Number(detail.pay.rate) || 0;
    return Number((totalM2 * rate).toFixed(2));
  }, [detail, totalM2]);

  const debt = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const paid = Number(detail.pay.paid) || 0;
    const diff = totalEuro - paid;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [detail, totalEuro]);

  const change = useMemo(() => {
    if (!detail || !detail.pay) return 0;
    const paid = Number(detail.pay.paid) || 0;
    const diff = paid - totalEuro;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [detail, totalEuro]);

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
    setDetail((prev) =>
      !prev
        ? prev
        : {
            ...prev,
            notes: value,
          },
    );
  }

  function updatePiece(section, index, field, value) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      if (!arr[index]) return prev;
      arr[index] = { ...arr[index], [field]: value };
      return {
        ...prev,
        [section]: arr,
      };
    });
  }

  function addPiece(section) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      arr.push({ m2: 0, qty: 1, photoUrl: '' });
      return {
        ...prev,
        [section]: arr,
      };
    });
  }

  function removePiece(section) {
    setDetail((prev) => {
      if (!prev) return prev;
      const arr = Array.isArray(prev[section]) ? [...prev[section]] : [];
      if (arr.length <= 1) return prev;
      arr.pop();
      return {
        ...prev,
        [section]: arr,
      };
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

  async function handleSave() {
    if (!detail) return;
    if (!detail.client || !detail.client.name) {
      alert('Shkruaj emrin e klientit.');
      return;
    }

    const name = detail.client.name.trim();
    if (!name) {
      alert('Shkruaj emrin e klientit.');
      return;
    }

    // recompute pay fields
    const rate = Number(detail.pay?.rate) || 0;
    const paid = Number(detail.pay?.paid) || 0;
    const newPay = {
      ...(detail.pay || {}),
      m2: totalM2,
      euro: totalEuro,
      rate,
      paid,
      debt,
      change,
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
      setOrders(loadOrdersIndex());
      alert('Ndryshimet u ruajtën.');
    } catch (err) {
      console.error('Error saving order from PASTRIMI', err);
      alert('Ndodhi një gabim gjatë ruajtjes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">PASTRIMI</h1>
          <div className="subtitle">Lista dhe detajet</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e porosive</h2>
        {orders.length === 0 && <p>Nuk ka porosi. Shto nga PRANIMI.</p>}
        {orders.map((o) => (
          <button
            key={o.id}
            type="button"
            className="home-btn"
            style={{
              marginBottom: 8,
              borderColor: selectedId === o.id ? '#196bff' : undefined,
            }}
            onClick={() => setSelectedId(o.id)}
          >
            <div>
              <div>{o.name || 'Pa emër'}</div>
              <small>{o.phone || ''}</small>
            </div>
            <span>DETALJE</span>
          </button>
        ))}
      </section>

      {detail && (
        <section className="card">
          <h2 className="card-title">Detajet e porosisë</h2>

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

          <div className="field-group">
            <label className="label">KËRKESË SPECIALE / SHËNIME</label>
            <textarea
              className="input"
              rows={3}
              value={detail.notes || ''}
              onChange={(e) => updateNotes(e.target.value)}
              placeholder="Shënime nga PRANIMI për pastrim, njolla të veçanta, kërkesa të klientit..."
            />
          </div>

          <div className="field-group">
            <label className="label">Tepiha</label>
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
                  </div>
                </div>
              ))}
            <div className="btn-row">
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

          <div className="field-group">
            <label className="label">Staza</label>
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
                  </div>
                </div>
              ))}
            <div className="btn-row">
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
            </div>
            <div className="tot-line small">
              Totali shkallore: <strong>{totalStairsM2.toFixed(2)} m²</strong>
            </div>
          </div>

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
              Total: <strong>{totalEuro.toFixed(2)} €</strong> · Borxh:{' '}
              <strong>{debt.toFixed(2)} €</strong> · Kthim:{' '}
              <strong>{change.toFixed(2)} €</strong>
            </div>
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
