'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

async function loadPaymentsFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('cash', {
    limit: 1000,
  });
  if (error || !data) return [];

  const result = [];
  for (const item of data) {
    if (!item.name.endsWith('.json')) continue;
    const path = `cash/${item.name}`;
    const { data: file } = await supabase.storage.from(BUCKET).download(path);
    if (!file) continue;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (obj && obj.id && typeof obj.amount === 'number') {
        result.push(obj);
      }
    } catch {
      // ignore
    }
  }
  return result;
}

function loadPaymentsLocal() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('payments_v1') || '[]';
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function ArkaPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (typeof window === 'undefined') return;
      setLoading(true);
      try {
        let online = [];
        try {
          online = await loadPaymentsFromSupabase();
        } catch (e) {
          console.error('Error loading ARKA from Supabase', e);
        }
        const local = loadPaymentsLocal();

        const byId = new Map();
        for (const p of local) {
          if (p && p.id) byId.set(p.id, p);
        }
        for (const p of online) {
          if (p && p.id) byId.set(p.id, p);
        }
        const merged = Array.from(byId.values()).sort((a, b) => {
          const ta = a.ts || 0;
          const tb = b.ts || 0;
          return tb - ta;
        });

        if (!cancelled) {
          setPayments(merged);
        }

        // Also keep localStorage updated
        try {
          window.localStorage.setItem('payments_v1', JSON.stringify(merged));
        } catch {
          // ignore
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return payments;
    return payments.filter((p) => {
      const code = String(p.code || '').toLowerCase();
      const name = String(p.name || '').toLowerCase();
      const phone = String(p.phone || '').toLowerCase();
      return (
        code.includes(q) ||
        name.includes(q) ||
        phone.includes(q) ||
        String(p.orderId || '').toLowerCase().includes(q)
      );
    });
  }, [payments, search]);

  const totals = useMemo(() => {
    const today = new Date();
    let all = 0;
    let todaySum = 0;
    for (const p of filtered) {
      const val = Number(p.amount) || 0;
      all += val;
      if (p.ts) {
        const d = new Date(p.ts);
        if (sameDay(d, today)) todaySum += val;
      }
    }
    return {
      all: Number(all.toFixed(2)),
      today: Number(todaySum.toFixed(2)),
    };
  }, [filtered]);

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Pagesat e ruajtura nga GATI</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            SOT: <strong>{totals.today.toFixed(2)} €</strong>
          </div>
          <div>
            TOTAL: <strong>{totals.all.toFixed(2)} €</strong>
          </div>
        </div>
      </header>

      <section className="card">
        <div className="field-group">
          <label className="label">KËRKO (kod, emër, telefon)</label>
          <input
            className="input"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="P.sh. 12, ARBEN, +383..."
          />
        </div>

        {loading && <p>Duke i lexuar pagesat...</p>}
        {!loading && filtered.length === 0 && (
          <p style={{ marginTop: 12 }}>Nuk ka pagesa të ruajtura.</p>
        )}

        {!loading &&
          filtered.map((p) => {
            const d = p.ts ? new Date(p.ts) : null;
            const dateLabel = d
              ? d.toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: '2-digit',
                  year: '2-digit',
                })
              : '';
            const timeLabel = d
              ? d.toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';

            return (
              <div
                key={p.id}
                className="home-btn"
                style={{
                  marginTop: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      padding: '2px 8px',
                      borderRadius: 4,
                      backgroundColor: '#1d283a',
                      color: '#ffffff',
                      minWidth: 32,
                      textAlign: 'center',
                    }}
                  >
                    {p.code || p.orderId || ''}
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {p.name || 'klient pa emër'}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>
                      {dateLabel} {timeLabel}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    Shuma:{' '}
                    <strong>{Number(p.amount || 0).toFixed(2)} €</strong>
                  </div>
                  {p.phone && (
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{p.phone}</div>
                  )}
                </div>
              </div>
            );
          })}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
