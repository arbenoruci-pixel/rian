'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// Helpers shared with other pages
function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function computeM2(order) {
  if (order?.pay && typeof order.pay.m2 === 'number') {
    return Number(order.pay.m2) || 0;
  }
  let total = 0;
  if (Array.isArray(order?.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (Array.isArray(order?.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (order?.shkallore) {
    const qty = Number(order.shkallore.qty) || 0;
    const per = Number(order.shkallore.per) || 0;
    total += qty * per;
  }
  return Number(total.toFixed(2));
}

function getStageLabel(status, order) {
  if (status === 'pastrim') return 'PASTRIMI';
  if (status === 'gati') return 'GATI';
  if (status === 'dorzim') return 'MARRJE SOT';
  if (status === 'pranim') {
    const m2 = computeM2(order);
    return m2 > 0 ? 'PRANIMI' : 'PA PLOTSUARA';
  }
  return status || 'TJETER';
}

function isIncomplete(order) {
  if (!order) return false;
  if (order.status !== 'pranim') return false;
  const m2 = computeM2(order);
  const hasClient =
    !!order.client &&
    !!(order.client.name && order.client.name.trim()) &&
    !!(order.client.phone && String(order.client.phone).trim());
  return hasClient && m2 <= 0;
}

function getCapacityState(totalM2) {
  if (totalM2 < 400) return { label: 'KAPACITET NORMAL', color: '#16a34a' };
  if (totalM2 < 600) return { label: 'AFËR KAPACITETIT', color: '#f97316' };
  return { label: 'MBI KAPACITET (2–3 ditë)', color: '#dc2626' };
}

// Supabase loader (similar spirit to PASRTRIMI / GATI)
async function loadOrdersFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const orders = [];
  for (const item of data) {
    if (!item.name.endsWith('.json')) continue;
    const path = `orders/${item.name}`;
    const { data: file } = await supabase.storage.from(BUCKET).download(path);
    if (!file) continue;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (obj && obj.id) orders.push(obj);
    } catch {
      // ignore bad json
    }
  }
  return orders;
}

function loadOrdersLocal() {
  if (typeof window === 'undefined') return [];
  let list = [];
  try {
    list = JSON.parse(window.localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const orders = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    try {
      const raw = window.localStorage.getItem(`order_${entry.id}`);
      if (!raw) continue;
      const full = JSON.parse(raw);
      if (full && full.id) orders.push(full);
    } catch {
      // ignore
    }
  }
  return orders;
}

export default function HomePage() {
  const [orders, setOrders] = useState([]);
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
          online = await loadOrdersFromSupabase();
        } catch (e) {
          console.error('Error loading from Supabase on HOME, using local only', e);
        }
        let merged = online && online.length > 0 ? online : loadOrdersLocal();

        // Also ensure local cache has at least these records for other faqe
        if (Array.isArray(merged) && merged.length > 0) {
          try {
            const existingIndex = JSON.parse(
              window.localStorage.getItem('order_list_v1') || '[]',
            );
            const indexById = new Map();
            if (Array.isArray(existingIndex)) {
              for (const it of existingIndex) {
                if (it && it.id) indexById.set(it.id, it);
              }
            }
            const nowIndex = [];
            for (const full of merged) {
              const m2 = computeM2(full);
              const entry = {
                id: full.id,
                name: full.client?.name || '',
                phone: full.client?.phone || '',
                code: full.client?.code || '',
                status: full.status || '',
                m2,
                ts: full.ts || Date.now(),
                readyAt: full.readyAt || null,
                queued: !!full.queued,
              };
              indexById.set(full.id, entry);
              try {
                window.localStorage.setItem(`order_${full.id}`, JSON.stringify(full));
              } catch {
                // ignore
              }
            }
            for (const v of indexById.values()) nowIndex.push(v);
            window.localStorage.setItem('order_list_v1', JSON.stringify(nowIndex));
          } catch {
            // ignore
          }
        }

        if (!cancelled) {
          setOrders(merged);
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

  const stats = useMemo(() => {
    const s = {
      pranim: 0,
      pastrim: 0,
      gati: 0,
      dorzim: 0,
      incomplete: 0,
      queue: 0,
      totalActiveM2: 0,
    };

    for (const o of orders) {
      const st = o.status || 'pranim';
      if (st === 'pranim') s.pranim += 1;
      else if (st === 'pastrim') s.pastrim += 1;
      else if (st === 'gati') s.gati += 1;
      else if (st === 'dorzim') s.dorzim += 1;

      if (isIncomplete(o)) s.incomplete += 1;
      if (o.queued) s.queue += 1;

      if (st === 'pastrim' || st === 'gati') {
        s.totalActiveM2 += computeM2(o);
      }
    }
    s.totalActiveM2 = Number(s.totalActiveM2.toFixed(2));
    return s;
  }, [orders]);

  const capacity = useMemo(
    () => getCapacityState(stats.totalActiveM2),
    [stats.totalActiveM2],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return orders
      .filter((o) => {
        const code = normalizeCode(o.client?.code || '');
        const name = (o.client?.name || '').toLowerCase();
        const phone = String(o.client?.phone || '').toLowerCase();
        return (
          code.includes(q) ||
          name.includes(q) ||
          phone.includes(q) ||
          String(o.id).toLowerCase().includes(q)
        );
      })
      .slice(0, 20);
  }, [orders, search]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TEPIHA • HOME</h1>
          <div className="subtitle">RRJEDHA KRYESORE</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">KAPACITETI DHE STATUSI</h2>
        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && (
          <>
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 12,
                border: '1px solid #1d2844',
                background: '#050b23',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12,
                marginBottom: 10,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    opacity: 0.8,
                  }}
                >
                  KAPACITETI I SOTËM
                </div>
                <div style={{ fontSize: 13 }}>
                  Aktiv: <strong>{stats.totalActiveM2.toFixed(2)} m²</strong>
                </div>
              </div>
              <div
                style={{
                  padding: '4px 8px',
                  borderRadius: 999,
                  background: capacity.color,
                  color: '#ffffff',
                  fontSize: 11,
                  fontWeight: 600,
                  textAlign: 'center',
                  minWidth: 120,
                }}
              >
                {capacity.label}
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 8,
                fontSize: 11,
              }}
            >
              <div className="stat-pill">
                <div className="stat-label">PASTRIMI</div>
                <div className="stat-value">{stats.pastrim}</div>
              </div>
              <div className="stat-pill">
                <div className="stat-label">PRITJE</div>
                <div className="stat-value">{stats.queue}</div>
              </div>
              <div className="stat-pill">
                <div className="stat-label">GATI</div>
                <div className="stat-value">{stats.gati}</div>
              </div>
              <div className="stat-pill">
                <div className="stat-label">MARRJE SOT</div>
                <div className="stat-value">{stats.dorzim}</div>
              </div>
              <div className="stat-pill">
                <div className="stat-label">PRANIMI</div>
                <div className="stat-value">{stats.pranim}</div>
              </div>
              <div className="stat-pill">
                <div className="stat-label">PA PLOTSUARA</div>
                <div className="stat-value">{stats.incomplete}</div>
              </div>
            </div>

            <div className="field-group" style={{ marginTop: 14 }}>
              <label className="label">KËRKO (kod, emër, telefon)</label>
              <input
                className="input"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="P.sh. 12, ARBEN, +383..."
              />
            </div>

            {search.trim() && filtered.length === 0 && (
              <p style={{ fontSize: 12, marginTop: 8 }}>Asnjë porosi nuk u gjet.</p>
            )}

            {filtered.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    opacity: 0.7,
                    marginBottom: 4,
                  }}
                >
                  REZULTATET
                </div>
                <div className="home-nav">
                  {filtered.map((o) => {
                    const code = normalizeCode(o.client?.code || '');
                    const stage = getStageLabel(o.status || 'pranim', o);
                    const m2 = computeM2(o);
                    return (
                      <div
                        key={o.id}
                        className="home-btn"
                        style={{
                          padding: '10px 12px',
                          alignItems: 'center',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: 14,
                              padding: '2px 8px',
                              borderRadius: 4,
                              background: '#1d283a',
                              color: '#ffffff',
                              minWidth: 32,
                              textAlign: 'center',
                            }}
                          >
                            {code || o.id}
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
                              {o.client?.name || 'klient pa emër'}
                            </div>
                            <div style={{ fontSize: 11, opacity: 0.8 }}>
                              {stage} · {m2.toFixed(2)} m²
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Link
                            className="btn secondary"
                            href={
                              o.status === 'gati' || o.status === 'dorzim'
                                ? '/gati'
                                : '/pastrimi'
                            }
                            style={{ fontSize: 11, padding: '4px 8px' }}
                          >
                            HAP
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">ZGJEDH MODULIN</h2>
        <div className="home-nav">
          <Link className="home-btn" href="/pranimi">
            <span>🟥</span>
            <div>
              <div>PRANIMI</div>
              <small>Shto klient të ri dhe porosi</small>
            </div>
          </Link>
          <Link className="home-btn" href="/pastrimi">
            <span>🟡</span>
            <div>
              <div>PASTRIMI</div>
              <small>Lista për pastrim dhe detaje</small>
            </div>
          </Link>
          <Link className="home-btn" href="/gati">
            <span>🟢</span>
            <div>
              <div>GATI</div>
              <small>Porositë gati për marrje</small>
            </div>
          </Link>
          <Link className="home-btn" href="/marrje-sot">
            <span>📦</span>
            <div>
              <div>MARRJE SOT</div>
              <small>Porositë e dorëzuara</small>
            </div>
          </Link>
          <Link className="home-btn" href="/arka">
            <span>💰</span>
            <div>
              <div>ARKA</div>
              <small>Shiko pagesat</small>
            </div>
          </Link>
        </div>
      </section>
    </div>
  );
}
