'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

function normalizeCode(raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  // Preserve TRANSPORT codes (T123)
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function yyyyMmDdLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + (days || 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function dayRangeUTC(dateStr) {
  // dateStr = 'YYYY-MM-DD' (treated as UTC calendar day)
  const start = `${dateStr}T00:00:00.000Z`;
  const end = `${addDaysYmd(dateStr, 1)}T00:00:00.000Z`; // next day 00:00Z
  return { start, end };
}

function computePieces(payload) {
  const tCope = Array.isArray(payload?.tepiha)
    ? payload.tepiha.reduce((a, b) => a + (Number(b.qty) || 0), 0)
    : 0;
  const sCope = Array.isArray(payload?.staza)
    ? payload.staza.reduce((a, b) => a + (Number(b.qty) || 0), 0)
    : 0;

  // shkallore: in v1 we count as 1 “item” row, but qty impacts m2
  const shk = payload?.shkallore && Number(payload.shkallore.qty) > 0 ? 1 : 0;

  return tCope + sCope + shk;
}

function computeM2(payload) {
  const t = Array.isArray(payload?.tepiha)
    ? payload.tepiha.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0)
    : 0;
  const s = Array.isArray(payload?.staza)
    ? payload.staza.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0)
    : 0;

  // shkallore: qty * per
  const stairs = payload?.shkallore
    ? (Number(payload.shkallore.qty) || 0) * (Number(payload.shkallore.per) || 0)
    : 0;

  return Number((t + s + stairs).toFixed(2));
}

function buildIndexFromRow(row) {
  const payload = row?.data && typeof row.data === 'object' ? row.data : {};

  const pieces = computePieces(payload);
  const m2 = computeM2(payload);

  const total =
    row?.total !== null && row?.total !== undefined
      ? Number(row.total || 0)
      : Number(payload?.pay?.euro || 0);

  const name = payload?.client?.name || payload?.client_name || '';
  const phone = row?.client_phone || payload?.client?.phone || payload?.phone || '';

  const pickedUp = row?.picked_up_at ? new Date(row.picked_up_at).getTime() : 0;

  return {
    id: row.id,
    code: row.code,
    name,
    phone,
    pieces,
    m2,
    total,
    pickedUpAt: pickedUp,
  };
}

function isSameUTCDate(ts, ymd) {
  if (!ts) return false;
  const d = new Date(ts);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}` === ymd;
}

/* =========================
   SUPABASE (REAL COLUMNS)
   - table: "orders"
   - delivered timestamp: picked_up_at
========================= */
async function loadOrdersFromSupabaseByDate(dateStr) {
  if (!supabase) return [];

  const { start, end } = dayRangeUTC(dateStr);

  const { data, error } = await supabase
    .from('orders')
    .select('id, code, status, client_phone, total, paid, picked_up_at, data, created_at, updated_at')
    .not('picked_up_at', 'is', null)
    .gte('picked_up_at', start)
    .lt('picked_up_at', end)
    .order('picked_up_at', { ascending: false })
    .limit(1000);

  if (error) return [];

  const out = (data || []).map(buildIndexFromRow);
  return out;
}

/* =========================
   LOCAL FALLBACK (legacy)
   - keeps your existing flow, but uses picked_up_at / pickedUpAt for date
========================= */
function loadOrdersLocalByDate(dateStr) {
  if (typeof window === 'undefined') return [];

  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    list = Array.isArray(raw) ? raw : [];
  } catch {
    list = [];
  }

  const out = [];

  for (const entry of list) {
    try {
      const rawOrder = localStorage.getItem(`order_${entry.id}`);
      if (!rawOrder) continue;
      const order = JSON.parse(rawOrder);

      const st = String(order.status || '').toLowerCase();
      const deliveredFlag =
        st === 'dorzim' ||
        st === 'delivered' ||
        st === 'done' ||
        st === 'completed' ||
        String(order.stage || '').toLowerCase() === 'marrje' ||
        order.delivered === true ||
        order.is_delivered === true ||
        !!order.pickedUpAt ||
        !!order.picked_up_at ||
        !!order.deliveredAt ||
        !!order.delivered_at;

      if (!deliveredFlag) continue;

      const pickedTs =
        (order.picked_up_at ? new Date(order.picked_up_at).getTime() : 0) ||
        (order.pickedUpAt ? Number(order.pickedUpAt) : 0) ||
        (order.delivered_at ? new Date(order.delivered_at).getTime() : 0) ||
        (order.deliveredAt ? Number(order.deliveredAt) : 0) ||
        0;

      if (!isSameUTCDate(pickedTs, dateStr)) continue;

      const payload = order?.data && typeof order.data === 'object' ? order.data : order;

      const pieces = computePieces(payload);
      const m2 = computeM2(payload);
      const total = Number(order.total ?? payload?.pay?.euro ?? 0) || 0;

      out.push({
        id: order.id,
        code: order.code ?? order.client?.code ?? '',
        name: order.client?.name || payload?.client?.name || '',
        phone: order.client_phone || order.client?.phone || payload?.client?.phone || '',
        pieces,
        m2,
        total,
        pickedUpAt: pickedTs,
      });
    } catch {
      // ignore
    }
  }

  out.sort((a, b) => (b.pickedUpAt || 0) - (a.pickedUpAt || 0));
  return out;
}

export default function Page() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  // DATE PICK
  const [dateStr, setDateStr] = useState(() => yyyyMmDdLocal(new Date()));

  async function refresh(forDate = dateStr) {
    setLoading(true);
    try {
      let online = [];
      try {
        online = await loadOrdersFromSupabaseByDate(forDate);
      } catch {}

      if (online && online.length > 0) setOrders(online);
      else setOrders(loadOrdersLocalByDate(forDate));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh(dateStr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr]);

  const listTotalM2 = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0), [orders]);
  const listTotalEuro = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0), [orders]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">
            Marrje për datën: <strong>{dateStr}</strong>
          </div>
        </div>

        <div className="top-right">
          <div className="picker">
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value || yyyyMmDdLocal(new Date()))}
              aria-label="Zgjidh datën"
            />
          </div>

          <div className="totals">
            <div>
              M²: <strong>{listTotalM2.toFixed(2)} m²</strong>
            </div>
            <div>
              €: <strong>{listTotalEuro.toFixed(2)} €</strong>
            </div>
          </div>
        </div>
      </header>

      <section className="card" style={{ padding: 10 }}>
        {loading && <p style={{ textAlign: 'center' }}>Duke i lexuar porositë...</p>}
        {!loading && orders.length === 0 && (
          <p style={{ textAlign: 'center' }}>Nuk ka marrje të regjistruara për këtë datë.</p>
        )}

        {!loading &&
          orders.map((o) => {
            const code = normalizeCode(o.code);
            return (
              <div key={o.id} className="fast-row">
                <div className="code-badge" title="KODI">
                  {code || '—'}
                </div>

                <div className="mid">
                  <div className="name" title={o.name || ''}>
                    {o.name || 'PA EMËR'}
                  </div>
                  <div className="sub" title={o.phone || ''}>
                    {(o.phone || '').trim()}
                  </div>
                </div>

                <div className="right">
                  <div className="mline">
                    {Number(o.pieces || 0)} copë • {Number(o.m2 || 0).toFixed(2)} m²
                  </div>
                  <div className="euro">{Number(o.total || 0).toFixed(2)} €</div>
                </div>
              </div>
            );
          })}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
        <button className="btn" onClick={() => refresh(dateStr)} style={{ marginLeft: 8 }}>
          ↻ REFRESH
        </button>
      </footer>

      <style jsx>{`
        .top-right {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
          font-size: 12px;
        }

        .picker input[type='date'] {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: #fff;
          padding: 6px 8px;
          border-radius: 10px;
          font-weight: 800;
          text-transform: uppercase;
          font-size: 12px;
          outline: none;
        }

        .totals {
          text-align: right;
          opacity: 0.95;
        }

        /* FAST LIST ROW */
        .fast-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 6px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .fast-row:last-child {
          border-bottom: none;
        }

        .code-badge {
          width: 46px;
          height: 46px;
          border-radius: 10px;
          background: rgba(22, 163, 74, 0.95);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 900;
          font-size: 15px;
          color: #fff;
          flex-shrink: 0;
          box-shadow: 0 10px 18px rgba(0, 0, 0, 0.35);
        }

        .mid {
          flex: 1;
          min-width: 0;
        }
        .name {
          font-weight: 900;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sub {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.65);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 2px;
        }

        .right {
          text-align: right;
          flex-shrink: 0;
          min-width: 110px;
        }
        .mline {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.7);
          font-weight: 700;
        }
        .euro {
          margin-top: 2px;
          font-size: 13px;
          font-weight: 900;
          color: #fff;
        }
      `}</style>
    </div>
  );
}