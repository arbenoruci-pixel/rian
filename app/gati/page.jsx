'use client';

import React, { useEffect, useState } from 'react';
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

function summarizeOrder(order) {
  const client = order.client || {};
  const pay = order.pay || {};
  const tepiha = Array.isArray(order.tepiha) ? order.tepiha : [];
  const staza = Array.isArray(order.staza) ? order.staza : [];
  const shkallore = order.shkallore || {};

  const piecesTepiha = tepiha.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
  const piecesStaza = staza.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
  const piecesStairs = Number(shkallore.qty) || 0;
  const pieces = piecesTepiha + piecesStaza + piecesStairs;

  const totalEuro = Number(pay.euro) || 0;

  return {
    code: client.code || '',
    name: client.name || 'Pa emër',
    pieces,
    totalEuro,
  };
}

export default function GatiPage() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const index = loadOrdersIndex();
    const collected = [];
    for (const row of index) {
      const full = loadOrderById(row.id);
      if (!full) continue;
      if (full.status !== 'pastrim' && full.status !== 'gati') continue;
      const summary = summarizeOrder(full);
      collected.push({
        id: row.id,
        ...summary,
      });
    }
    setOrders(collected);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const full = loadOrderById(selectedId);
    setDetail(full);
  }, [selectedId]);

  async function handleMarkReady() {
    if (!detail) return;
    try {
      setSaving(true);
      const updated = {
        ...detail,
        status: 'gati',
        readyAt: detail.readyAt || new Date().toISOString(),
      };
      saveOrderLocal(updated);
      await saveOrderOnline(updated);
      setDetail(updated);

      const index = loadOrdersIndex();
      const collected = [];
      for (const row of index) {
        const full = loadOrderById(row.id);
        if (!full) continue;
        if (full.status !== 'pastrim' && full.status !== 'gati') continue;
        const summary = summarizeOrder(full);
        collected.push({
          id: row.id,
          ...summary,
        });
      }
      setOrders(collected);
      alert('Porosia u kalua në GATI.');
    } catch (err) {
      console.error('Error marking as ready', err);
      alert('Ndodhi një gabim gjatë kalimit në GATI.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">GATI</h1>
          <div className="subtitle">Lista e porosive gati për marrje</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e GATI</h2>
        {orders.length === 0 && <p>Nuk ka porosi në GATI. Përdor PASTRIMI për t&apos;i përgatitur.</p>}
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
              <div>
                <strong>{o.code || '–'}</strong> · {o.name}
              </div>
              <small>
                Copë: {o.pieces} · Total: {o.totalEuro.toFixed(2)} €
              </small>
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
            <div className="tot-line">
              <strong>{detail.client?.name || 'Pa emër'}</strong>
            </div>
            <div className="tot-line small">{detail.client?.phone || ''}</div>
          </div>

          <div className="field-group">
            <label className="label">Shënime</label>
            <p className="small-text">
              {detail.notes && detail.notes.trim().length > 0
                ? detail.notes
                : 'Nuk ka shënime speciale.'}
            </p>
          </div>

          <div className="field-group">
            <label className="label">Përmbledhje</label>
            <div className="tot-line">
              M² totale: <strong>{(Number(detail.pay?.m2) || 0).toFixed(2)} m²</strong>
            </div>
            <div className="tot-line">
              Totali: <strong>{(Number(detail.pay?.euro) || 0).toFixed(2)} €</strong>
            </div>
          </div>

          <button
            type="button"
            className="btn"
            disabled={saving || detail.status === 'gati'}
            onClick={handleMarkReady}
          >
            ✅ {detail.status === 'gati' ? 'ËSHTË NË GATI' : 'KALO NË GATI'}
          </button>
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
