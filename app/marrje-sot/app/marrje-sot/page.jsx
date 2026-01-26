'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

function normalizeCode(raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
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

// Local day → ISO UTC range (fixes timezone issues)
function dayRangeLocalToUTC(dateStr) {
  const startLocal = new Date(`${dateStr}T00:00:00`);
  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000);
  return { start: startLocal.toISOString(), end: endLocal.toISOString() };
}

function computePieces(payload) {
  const tCope = Array.isArray(payload?.tepiha) ? payload.tepiha.reduce((a, b) => a + (Number(b.qty) || 0), 0) : 0;
  const sCope = Array.isArray(payload?.staza) ? payload.staza.reduce((a, b) => a + (Number(b.qty) || 0), 0) : 0;
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
  const stairs = payload?.shkallore ? (Number(payload.shkallore.qty) || 0) * (Number(payload.shkallore.per) || 0) : 0;
  return Number((t + s + stairs).toFixed(2));
}

function buildIndexFromRow(row) {
  const payload = row?.data && typeof row.data === 'object' ? row.data : {};
  const name = payload?.client?.name || payload?.client_name || '';
  const phone = row?.client_phone || payload?.client?.phone || payload?.phone || '';
  const pieces = computePieces(payload);
  const m2 = computeM2(payload);
  const total =
    row?.total !== null && row?.total !== undefined
      ? Number(row.total || 0)
      : Number(payload?.pay?.euro || 0);

  return {
    id: String(row.id),
    code: row.code,
    name,
    phone,
    pieces,
    m2,
    total,
    picked_up_at: row.picked_up_at,
  };
}

async function loadFromDbByDate(dateStr) {
  const { start, end } = dayRangeLocalToUTC(dateStr);

  const { data, error } = await supabase
    .from('orders')
    .select('id, code, status, client_phone, total, paid, picked_up_at, data, created_at, updated_at')
    .not('picked_up_at', 'is', null)
    .gte('picked_up_at', start)
    .lt('picked_up_at', end)
    .order('picked_up_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.log('MARRJE_SOT DB ERROR:', error);
    return [];
  }
  return (data || []).map(buildIndexFromRow);
}

function isSameLocalDay(ts, dateStr) {
  if (!ts) return false;
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}` === dateStr;
}

function loadLocalByDate(dateStr) {
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

      const pickedTs =
        (order.picked_up_at ? new Date(order.picked_up_at).getTime() : 0) ||
        (order.pickedUpAt ? Number(order.pickedUpAt) : 0) ||
        (order.delivered_at ? new Date(order.delivered_at).getTime() : 0) ||
        (order.deliveredAt ? Number(order.deliveredAt) : 0) ||
        0;

      if (!pickedTs) continue;
      if (!isSameLocalDay(pickedTs, dateStr)) continue;

      const payload = order?.data && typeof order.data === 'object' ? order.data : order;
      const pieces = computePieces(payload);
      const m2 = computeM2(payload);
      const total = Number(order.total ?? payload?.pay?.euro ?? 0) || 0;

      out.push({
        id: String(order.id),
        code: order.code ?? order.client?.code ?? '',
        name: order.client?.name || payload?.client?.name || '',
        phone: order.client_phone || order.client?.phone || payload?.client?.phone || '',
        pieces,
        m2,
        total,
        picked_up_at: order.picked_up_at || null,
      });
    } catch {}
  }

  return out;
}

export default function Page() {
  const [dateStr, setDateStr] = useState(() => yyyyMmDdLocal(new Date()));
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refresh(d = dateStr) {
    setLoading(true);
    try {
      const online = await loadFromDbByDate(d);
      if (online && online.length > 0) setOrders(online);
      else setOrders(loadLocalByDate(d));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
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
          <div className="subtitle">Porositë e dorëzuara (zgjedh datën)</div>
        </div>

        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            <span style={{ opacity: 0.8 }}>DATA:</span>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value || yyyyMmDdLocal(new Date()))}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.14)',
                color: '#fff',
                padding: '6px 8px',
                borderRadius: 10,
                fontWeight: 800,
                fontSize: 12,
              }}
            />
          </div>

          <div style={{ marginTop: 6 }}>
            M²: <strong>{listTotalM2.toFixed(2)} m²</strong>
          </div>
          <div>
            €: <strong>{listTotalEuro.toFixed(2)} €</strong>
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

      <footer className="footer-bar" style={{ display: 'flex', gap: 8 }}>
        <Link className="btn secondary" href="/" style={{ flex: 1 }}>
          🏠 HOME
        </Link>
        <button className="btn secondary" onClick={() => refresh(dateStr)} style={{ flexShrink: 0 }}>
          ↻ REFRESH
        </button>
      </footer>

      <style jsx>{`
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
