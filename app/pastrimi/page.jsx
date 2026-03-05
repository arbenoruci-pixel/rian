'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import supabase from '@/lib/supabaseClient';
import { getOutboxSnapshot } from '@/lib/syncManager';
import { requirePaymentPin } from '@/lib/pinAuth';

// ---------------- HELPERS ----------------

const SELECT_TIMEOUT_MS = 7000;
function withTimeout(promise, ms = SELECT_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
async function safeSelect(promise) {
  try {
    return await withTimeout(promise);
  } catch (e) {
    return { data: null, error: e };
  }
}

function normalizeCode(x) {
  if (x == null) return '';
  const s = String(x).trim();
  if (!s) return '';
  const n = s.replace(/[^\d]/g, '');
  return n || s;
}

function fmtMoney(x) {
  const n = Number(x || 0);
  return n.toFixed(2) + '€';
}

function fmtM2(x) {
  const n = Number(x || 0);
  if (!isFinite(n)) return '0.0';
  return n.toFixed(1);
}

function unwrapOrderData(fullOrder) {
  // fullOrder can be stored either as object or {data:...}
  if (!fullOrder) return {};
  if (fullOrder.data && typeof fullOrder.data === 'object') return fullOrder.data;
  if (typeof fullOrder === 'object') return fullOrder;
  return {};
}

function computeM2(order) {
  try {
    const tepiha = Array.isArray(order?.tepiha) ? order.tepiha : [];
    const staza = Array.isArray(order?.staza) ? order.staza : [];
    const shkalloreQty = Number(order?.shkallore?.qty || 0);
    const shkallorePer = Number(order?.shkallore?.per_m2 || order?.shkallore?.perM2 || 0.3);
    const sumT = tepiha.reduce((a, b) => a + (Number(b.m2) || 0) * (Number(b.qty) || 1), 0);
    const sumS = staza.reduce((a, b) => a + (Number(b.m2) || 0) * (Number(b.qty) || 1), 0);
    const sumShk = shkalloreQty > 0 ? shkalloreQty * shkallorePer : 0;
    return Number((sumT + sumS + sumShk) || 0);
  } catch (e) {
    return 0;
  }
}

async function readLocalOrdersByStatus(status) {
  try {
    const raw = localStorage.getItem('orders_v1');
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // orders_v1 entries: { id, status, ts, fullOrder? }
    return list.filter((x) => String(x?.status || '') === String(status || ''));
  } catch (e) {
    return [];
  }
}

function saveOrderLocal(orderId, row) {
  try {
    localStorage.setItem(`order_${orderId}`, JSON.stringify(row));
  } catch (e) {}
}

function loadOrderLocal(orderId) {
  try {
    const raw = localStorage.getItem(`order_${orderId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ---------------- PAGE ----------------

export default function PastrimiPage() {
  const [orders, setOrders] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [debugInfo, setDebugInfo] = useState({
    source: 'INIT',
    dbCount: 0,
    localCount: 0,
    online: null,
    lastError: null,
    ts: Date.now(),
  });

  const liveRef = useRef(null);
  const refreshTimerRef = useRef(null);

  const filtered = useMemo(() => {
    const qq = String(q || '').trim().toLowerCase();
    if (!qq) return orders;
    return orders.filter((o) => {
      const name = String(o?.name || '').toLowerCase();
      const code = String(o?.code || '').toLowerCase();
      return name.includes(qq) || code.includes(qq);
    });
  }, [orders, q]);

  const totalM2 = useMemo(() => {
    return filtered.reduce((a, b) => a + Number(b?.m2 || 0), 0);
  }, [filtered]);

  async function refreshOrders() {
    if (loading) return;
    setLoading(true);

    try {
      const localOrders = await readLocalOrdersByStatus('pastrim');

      const outboxSnap = typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [];
      const pendingOutbox = Array.isArray(outboxSnap)
        ? outboxSnap
            .filter((it) => {
              const st = String(it?.status || '').toLowerCase();
              const tbl = String(it?.table || '');
              if (st !== 'pending') return false;
              if (!it?.payload) return false;
              return tbl === 'orders' || tbl === 'transport_orders';
            })
            .map((it) => {
              const p = it.payload || {};
              const isTransport = String(it.table) === 'transport_orders';
              const codeRaw =
                p.code ?? p.code_n ?? p.order_code ?? p.orderCode ?? p.kod ?? null;
              const code_n = p.code_n ?? (typeof p.code === 'number' ? p.code : null);
              const id =
                p.id ||
                p.oid ||
                it.id ||
                it.oid ||
                `outbox_${Math.random().toString(16).slice(2)}`;
              const name = p.name || p.client_name || p.clientName || p.emri || '';
              const phone = (p.phone || p.client_phone || p.clientPhone || '').toString();
              const cope = p.cope ?? p.pieces ?? p.cop ?? p.count ?? 0;
              const m2 = p.m2_total ?? p.m2 ?? p.m2_totali ?? 0;
              const total = p.total ?? p.sum ?? p.shuma ?? 0;
              const paid = p.paid ?? p.paid_amount ?? p.klienti_dha ?? 0;
              const debt = p.debt ?? Number(total || 0) - Number(paid || 0);

              return {
                ...p,
                id,
                oid: p.oid || p.id || it.id || id,
                code: codeRaw,
                code_n,
                name,
                phone,
                cope,
                m2,
                total,
                paid,
                debt,
                status: p.status || (isTransport ? 'pickup' : 'pastrim'),
                _isTransport: isTransport,
                ts: Number(p.ts || p.created_at || it.created_at || Date.now()),
                _outboxPending: true,
                _outboxId: it.id || null,
                _outboxCreatedAt: it.created_at || null,
                src: 'OUTBOX',
              };
            })
        : [];

      const mergeUnique = (baseArr, extraArr) => {
        const seen = new Set((baseArr || []).map((o) => String(o?.oid || o?.id)));
        (extraArr || []).forEach((o) => {
          const k = String(o?.oid || o?.id);
          if (!k) return;
          if (seen.has(k)) return;
          baseArr.push(o);
          seen.add(k);
        });
        return baseArr;
      };

      // If offline, show LOCAL + OUTBOX pending immediately
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const locals = (await readLocalOrdersByStatus('pastrim')).map((x) => {
          const order = unwrapOrderData(x.fullOrder);
          const total = Number(order.pay?.euro || 0);
          const paid = Number(order.pay?.paid || 0);
          const codeKey = normalizeCode(
            order.client?.code || order.code || order.code_n || order.client_code || x.id
          );
          const cope =
            (order.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0) +
            (order.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0) +
            (Number(order.shkallore?.qty) || 0);

          return {
            id: x.id,
            source: 'LOCAL',
            ts: Number(order.ts || x.ts || Date.now()),
            name: order.client?.name || '',
            phone: order.client?.phone || '',
            code: codeKey,
            m2: computeM2(order),
            cope,
            total,
            paid,
            isPaid: paid >= total && total > 0,
            isReturn: !!order?.returnInfo?.active,
            fullOrder: order,
            localOnly: true,
          };
        });

        const cleanLocals = locals.filter(
          (o) => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== '')
        );

        // ALSO show pending Outbox orders (saved on device, waiting for internet)
        mergeUnique(cleanLocals, pendingOutbox);
        cleanLocals.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

        setOrders(cleanLocals);
        setDebugInfo({
          source: 'LOCAL_OFFLINE',
          dbCount: 0,
          localCount: cleanLocals.length,
          online: false,
          lastError: null,
          ts: Date.now(),
        });
        setLoading(false);
        return;
      }

      // ONLINE: load locals + DB + transport + add pending outbox into list
      const locals = localOrders.map((x) => {
        const order = unwrapOrderData(x.fullOrder);
        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const codeKey = normalizeCode(
          order.client?.code || order.code || order.code_n || order.client_code || x.id
        );
        const cope =
          (order.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0) +
          (order.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0) +
          (Number(order.shkallore?.qty) || 0);

        return {
          id: x.id,
          source: 'LOCAL',
          ts: Number(order.ts || x.ts || Date.now()),
          name: order.client?.name || '',
          phone: order.client?.phone || '',
          code: codeKey,
          m2: computeM2(order),
          cope,
          total,
          paid,
          isPaid: paid >= total && total > 0,
          isReturn: !!order?.returnInfo?.active,
          fullOrder: order,
          localOnly: true,
        };
      });

      const cleanLocals = locals.filter(
        (o) => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== '')
      );

      // Normal orders from DB (7s timeout)
      const { data: normalData, error: normalError } = await safeSelect(
        supabase
          .from('orders')
          .select(
            'id, ts, client_name, client_phone, code, code_n, m2_total, cope_total, total, paid, debt, status, return_active'
          )
          .eq('status', 'pastrim')
          .order('ts', { ascending: false })
          .limit(200)
      );

      // Transport orders from DB (7s timeout)
      const { data: transportData, error: transError } = await safeSelect(
        supabase
          .from('transport_orders')
          .select(
            'id, ts, client_name, client_phone, order_code, m2_total, cope_total, total, paid, debt, status, return_active'
          )
          .in('status', ['pickup', 'loaded', 'pastrim'])
          .order('ts', { ascending: false })
          .limit(200)
      );

      const allOrders = [];

      // Keep locals first (but we’ll dedupe later)
      allOrders.push(...cleanLocals);

      // Map normal db rows
      if (Array.isArray(normalData)) {
        for (const r of normalData) {
          const id = r.id;
          const ts = Number(r.ts || Date.now());
          const name = r.client_name || '';
          const phone = r.client_phone || '';
          const code = normalizeCode(r.code_n ?? r.code ?? id);
          const m2 = Number(r.m2_total || 0);
          const cope = Number(r.cope_total || 0);
          const total = Number(r.total || 0);
          const paid = Number(r.paid || 0);
          const debt = r.debt != null ? Number(r.debt || 0) : total - paid;

          allOrders.push({
            id,
            source: 'DB',
            ts,
            name,
            phone,
            code,
            m2,
            cope,
            total,
            paid,
            debt,
            isPaid: paid >= total && total > 0,
            isReturn: !!r.return_active,
            fullOrder: null,
            localOnly: false,
          });

          // Cache db row as local detail fallback
          saveOrderLocal(id, { ...r });
        }
      }

      // Map transport db rows
      if (Array.isArray(transportData)) {
        for (const r of transportData) {
          const id = r.id;
          const ts = Number(r.ts || Date.now());
          const name = r.client_name || '';
          const phone = r.client_phone || '';
          const code = String(r.order_code || '').trim() || String(id);
          const m2 = Number(r.m2_total || 0);
          const cope = Number(r.cope_total || 0);
          const total = Number(r.total || 0);
          const paid = Number(r.paid || 0);
          const debt = r.debt != null ? Number(r.debt || 0) : total - paid;

          allOrders.push({
            id,
            source: 'DB',
            ts,
            name,
            phone,
            code,
            m2,
            cope,
            total,
            paid,
            debt,
            isPaid: paid >= total && total > 0,
            isReturn: !!r.return_active,
            fullOrder: null,
            localOnly: false,
            _isTransport: true,
          });

          // Cache
          saveOrderLocal(id, { ...r, _isTransport: true });
        }
      }

      // ALSO add pending Outbox orders in the main list (ONLINE too)
      mergeUnique(allOrders, pendingOutbox);

      // Dedupe by oid/id and sort
      const seen = new Set();
      const finalOrders = [];
      for (const o of allOrders) {
        const k = String(o?.oid || o?.id);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        finalOrders.push(o);
      }

      finalOrders.sort((a, b) => b.ts - a.ts);

      setOrders(finalOrders);
      setDebugInfo({
        source: 'DB',
        dbCount: (Array.isArray(normalData) ? normalData.length : 0) + (Array.isArray(transportData) ? transportData.length : 0),
        localCount: cleanLocals.length + pendingOutbox.length,
        online: true,
        lastError:
          normalError?.message ||
          transError?.message ||
          (normalError ? String(normalError) : null) ||
          (transError ? String(transError) : null) ||
          null,
        ts: Date.now(),
      });
    } catch (e) {
      setDebugInfo((x) => ({
        ...x,
        lastError: String(e?.message || e),
        ts: Date.now(),
      }));
    } finally {
      setLoading(false);
    }
  }

  // Realtime subscription (only if supabase exists)
  useEffect(() => {
    if (!supabase) return;

    try {
      if (liveRef.current) {
        try {
          supabase.removeChannel(liveRef.current);
        } catch (e) {}
        liveRef.current = null;
      }

      const channel = supabase.channel('pastrim-live-orders');
      liveRef.current = channel;

      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          () => {
            refreshOrders();
          }
        )
        .subscribe();

      const channelT = supabase.channel('pastrim-live-transport');
      channelT
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'transport_orders' },
          () => {
            refreshOrders();
          }
        )
        .subscribe();

      return () => {
        try {
          if (channel) supabase.removeChannel(channel);
        } catch (e) {}
        try {
          if (channelT) supabase.removeChannel(channelT);
        } catch (e) {}
      };
    } catch (e) {
      // ignore realtime errors
      return () => {};
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // initial load + small interval safety
  useEffect(() => {
    refreshOrders();

    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(() => {
      // periodic refresh to avoid “stuck state”
      refreshOrders();
    }, 30000);

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSms(o) {
    // Keep existing behavior (just open SMS composer)
    const name = o?.name || '';
    const code = o?.code || '';
    const m2 = fmtM2(o?.m2 || 0);
    const total = fmtMoney(o?.total || 0);
    const msg = `PËRSHËNDETJE ${name}\nPOROSIA #${code}\nTOTALI: ${total}\nM²: ${m2}\nTEPIHAT JANË NË PROCES (PASTRIMI).`;
    const phone = String(o?.phone || '').replace(/\D/g, '');
    const url = `sms:${phone}?&body=${encodeURIComponent(msg)}`;
    try {
      window.location.href = url;
    } catch (e) {}
  }

  async function onDoctor() {
    try {
      await requirePaymentPin({ reason: 'DOC' });
      window.location.href = '/doctor';
    } catch (e) {}
  }

  return (
    <div style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 1 }}>PASTRIMI</div>
        <button
          onClick={() => {
            try {
              localStorage.removeItem('orders_v1');
            } catch (e) {}
            refreshOrders();
          }}
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,60,60,0.08)',
            color: '#ff7b7b',
            fontWeight: 900,
            letterSpacing: 1,
          }}
        >
          🧹 FSHI CACHE
        </button>
      </div>

      <div style={{ marginTop: 12, padding: 14, borderRadius: 16, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ textAlign: 'center', opacity: 0.8, fontWeight: 800, letterSpacing: 1 }}>TOTAL M² NË PROCES</div>
        <div style={{ textAlign: 'center', fontSize: 40, fontWeight: 900, color: '#22c55e' }}>{fmtM2(totalM2)}</div>
        <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, (totalM2 / 450) * 100)}%`, background: '#22c55e' }} />
        </div>
        <div style={{ marginTop: 8, opacity: 0.6, fontWeight: 800 }}>0 m²MAX: 450 m²</div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.06)', borderRadius: 14, padding: 12, border: '1px solid rgba(255,255,255,0.10)' }}>
          <div style={{ opacity: 0.7, fontWeight: 800 }}>🔎 KËRKO EMRIN OSE KODIN...</div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Kërko..."
            style={{
              marginTop: 8,
              width: '100%',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              padding: '10px 12px',
              outline: 'none',
              fontWeight: 800,
            }}
          />
        </div>

        <button
          onClick={refreshOrders}
          style={{
            width: 54,
            height: 54,
            borderRadius: 999,
            border: '2px solid rgba(34,197,94,0.8)',
            background: 'rgba(0,0,0,0.35)',
            color: '#22c55e',
            fontSize: 18,
            fontWeight: 900,
          }}
          title="REFRESH"
        >
          ⟳
        </button>
      </div>

      <div style={{ marginTop: 10, opacity: 0.75, fontWeight: 800, letterSpacing: 0.6 }}>
        SRC: {debugInfo.source} · ONLINE: {String(debugInfo.online)} · DB: {debugInfo.dbCount} · LOCAL: {debugInfo.localCount}
      </div>

      <div style={{ marginTop: 12, borderRadius: 18, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.10)' }}>
        {filtered.map((o) => {
          const codeLabel = String(o?.code || '').trim() || '—';
          const cope = Number(o?.cope || 0);
          const m2 = Number(o?.m2 || 0);
          const debt = Number(o?.debt ?? (Number(o?.total || 0) - Number(o?.paid || 0)));

          const badgeBg = o._isTransport
            ? 'rgba(245,158,11,0.92)'
            : o.isReturn
            ? 'rgba(239,68,68,0.92)'
            : 'rgba(34,197,94,0.92)';

          return (
            <div
              key={String(o?.oid || o?.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 12,
                background: 'rgba(0,0,0,0.35)',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 16,
                  background: badgeBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  fontWeight: 1000,
                  color: '#fff',
                  flex: '0 0 auto',
                }}
              >
                {codeLabel}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {o.name}{' '}
                  {o._outboxPending && (
                    <span style={{ color: '#f59e0b', fontWeight: 800 }}>• ⏳ NË PRITJE</span>
                  )}{' '}
                  {o.isReturn && <span style={{ color: '#f59e0b' }}>• KTHIM</span>}
                </div>
                <div style={{ opacity: 0.7, fontWeight: 800, fontSize: 13 }}>
                  {cope} copë • {fmtM2(m2)} m²
                </div>
                <div style={{ color: '#ff5a5a', fontWeight: 900 }}>Borxh: {fmtMoney(debt)}</div>
              </div>

              <button
                onClick={() => onSms(o)}
                style={{
                  padding: '12px 16px',
                  borderRadius: 999,
                  border: '1px solid rgba(59,130,246,0.25)',
                  background: 'rgba(59,130,246,0.9)',
                  color: '#fff',
                  fontWeight: 1000,
                  letterSpacing: 1,
                  flex: '0 0 auto',
                }}
              >
                SMS KLIENTIT
              </button>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', opacity: 0.7, fontWeight: 900 }}>
            NUK KA POROSI NË PASTRIM.
          </div>
        )}
      </div>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 14,
          paddingTop: 12,
          paddingBottom: 12,
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.75) 30%, rgba(0,0,0,0.85) 100%)',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontWeight: 1000,
              letterSpacing: 1,
              textDecoration: 'none',
            }}
          >
            🏠 HOME
          </Link>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={onDoctor}
              style={{
                padding: '12px 16px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontWeight: 1000,
                letterSpacing: 1,
              }}
            >
              DOC
            </button>

            <button
              onClick={() => {
                try {
                  localStorage.setItem('tepiha_logout', String(Date.now()));
                } catch (e) {}
                window.location.href = '/login';
              }}
              style={{
                padding: '12px 16px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(239,68,68,0.12)',
                color: '#ff7b7b',
                fontWeight: 1000,
                letterSpacing: 1,
              }}
            >
              DIL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}