'use client';

// app/marrje-sot/page.jsx

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal } from '@/lib/offlineStore';

const BUCKET = 'tepiha-photos';

// -------- helpers --------
function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/[^\d+]+/g, '');
}

function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (order.shkallore) total += (Number(order.shkallore.qty) || 0) * (Number(order.shkallore.per) || 0);
  return Number(total.toFixed(2));
}

function computePieces(order) {
  const t = order?.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const s = order?.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
}

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function dayKeyFromIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dayKeyLocal(d);
}

function dayKeyFromMs(ms) {
  const d = new Date(Number(ms || 0));
  if (Number.isNaN(d.getTime())) return '';
  return dayKeyLocal(d);
}

// ✅ IMPORTANT: download JSON no-cache
async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

export default function MarrjeSotPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      // today range (local day -> ISO)
      const d0 = new Date();
      d0.setHours(0, 0, 0, 0);
      const d1 = new Date(d0);
      d1.setDate(d1.getDate() + 1);

      const startIso = d0.toISOString();
      const endIso = d1.toISOString();

      const { data, error } = await supabase
        .from('orders')
        .select('id,code,code_n,client_name,client_phone,status,total,paid,picked_up_at,created_at,data')
        .eq('status', 'dorzim')
        .gte('picked_up_at', startIso)
        .lt('picked_up_at', endIso)
        .order('picked_up_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(500);

      // Prepare local fallback rows (today only)
      const local = await getAllOrdersLocal().catch(() => []);
      const localList = Array.isArray(local) ? local : [];
      const localRows = localList
        .filter((o) => String(o?.status || '').toLowerCase() === 'dorzim')
        .map((order) => {
          const picked = order?.picked_up_at || order?.delivered_at;
          const key = picked ? dayKeyFromIso(picked) : dayKeyFromMs(order?.pickedUpAt || order?.deliveredAt);
          return {
            id: String(order?.id || ''),
            code: normalizeCode(order?.client?.code || order?.client_code || order?.code || ''),
            name: String(order?.client?.name || order?.client_name || ''),
            phone: sanitizePhone(order?.client?.phone || order?.client_phone || ''),
            cope: computePieces(order),
            m2: computeM2(order),
            total: Number(order?.pay?.euro || order?.total || 0) || 0,
            paid: Number(order?.pay?.paid || order?.paid || 0) || 0,
            picked_at: picked || order?.picked_up_at || order?.delivered_at || null,
            dayKey: key,
            _src: 'LOCAL',
          };
        })
        .filter((r) => r.dayKey === dayKeyLocal(new Date()) && !/^T\d+$/i.test(String(r.code || '').trim()));

      if (error || !data) {
        // OFFLINE: show local-only
        setRows(localRows);
        return;
      }

      const dbRows = (data || [])
        .map((row) => {
          let raw = row.data;
          if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch { raw = {}; }
          }
          const order = { ...(raw || {}) };

          // back-compat keys
          if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) order.tepiha = order.tepihaRows;
          if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) order.staza = order.stazaRows;

          const code = normalizeCode(row.code ?? row.code_n ?? order.code ?? order.code_n ?? order.client?.code ?? row.client_code ?? '');
          const name = String(row.client_name ?? order.client_name ?? order.client?.name ?? '');
          const phone = sanitizePhone(row.client_phone ?? order.client_phone ?? order.client?.phone ?? '');

          const total = Number(row.total ?? order?.pay?.euro ?? order.total ?? 0) || 0;
          const paid = Number(row.paid ?? order?.pay?.paid ?? order.paid ?? 0) || 0;

          return {
            id: String(row.id),
            code,
            name,
            phone,
            cope: computePieces(order),
            m2: computeM2(order),
            total,
            paid,
            picked_at: row.picked_up_at || order.picked_up_at || order.delivered_at || null,
            dayKey: dayKeyFromIso(row.picked_up_at || order.picked_up_at || order.delivered_at),
            _src: 'DB',
          };
        })
        .filter((r) => r.dayKey === dayKeyLocal(new Date()) && !/^T\d+$/i.test(String(r.code || '').trim()));

      // DEDUPE by CODE with DB precedence
      const map = new Map();
      for (const r of localRows) map.set(String(r.code), r);
      for (const r of dbRows) map.set(String(r.code), r); // DB overwrites
      const merged = Array.from(map.values()).sort((a, b) => {
        const ta = new Date(a.picked_at || 0).getTime() || 0;
        const tb = new Date(b.picked_at || 0).getTime() || 0;
        return tb - ta;
      });

      setRows(merged);
    } catch (e) {
      console.error(e);
      // last resort: local-only
      try {
        const local = await getAllOrdersLocal().catch(() => []);
        const list = Array.isArray(local) ? local : [];
        const today = dayKeyLocal(new Date());
        const offlineRows = list
          .filter((o) => String(o?.status || '').toLowerCase() === 'dorzim')
          .map((order) => {
            const picked = order?.picked_up_at || order?.delivered_at;
            const key = picked ? dayKeyFromIso(picked) : dayKeyFromMs(order?.pickedUpAt || order?.deliveredAt);
            return {
              id: String(order?.id || ''),
              code: normalizeCode(order?.client?.code || order?.client_code || order?.code || ''),
              name: String(order?.client?.name || order?.client_name || ''),
              phone: sanitizePhone(order?.client?.phone || order?.client_phone || ''),
              cope: computePieces(order),
              m2: computeM2(order),
              total: Number(order?.pay?.euro || order?.total || 0) || 0,
              paid: Number(order?.pay?.paid || order?.paid || 0) || 0,
              picked_at: picked || null,
              dayKey: key,
              _src: 'LOCAL',
            };
          })
          .filter((r) => r.dayKey === today && !/^T\d+$/i.test(String(r.code || '').trim()));
        setRows(offlineRows);
      } catch {
        setRows([]);
      }
    } finally {
      setLoading(false);
    }
  };
        setRows(offlineRows);
        return;
      }

      const items = (data || []).filter((x) => (x.name || '').endsWith('.json'));

      const promises = items.map(async (item) => {
        try {
          const ord = await downloadJsonNoCache(`orders/${item.name}`);
          if (!ord?.id) return null;

          // Prefer local copy if exists (same as GATI)
          let order = ord;
          if (typeof window !== 'undefined') {
            try {
              const localRaw = localStorage.getItem(`order_${ord.id}`);
              if (localRaw) {
                const localOrd = JSON.parse(localRaw);
                if (localOrd && String(localOrd.id) === String(ord.id)) order = localOrd;
              }
            } catch {}
          }

          // Mirror if missing local
          if (typeof window !== 'undefined') {
            try {
              const existing = localStorage.getItem(`order_${ord.id}`);
              if (!existing) localStorage.setItem(`order_${ord.id}`, JSON.stringify(ord));
            } catch {}
          }

          // ✅ Delivery timestamp: prefer picked_up_at (ISO). fallback to ms fields.
          const pickedIso =
            order.picked_up_at ||
            order.pickedUpAtIso ||
            order.delivered_at ||
            order.deliveredAtIso ||
            '';
          const pickedMs =
            Number(order.pickedUpAt) ||
            Number(order.picked_up_ms) ||
            Number(order.deliveredAt) ||
            Number(order.delivered_at_ms) ||
            0;

          const kIso = pickedIso ? dayKeyFromIso(pickedIso) : '';
          const kMs = pickedMs ? dayKeyFromMs(pickedMs) : '';

          const isToday = (kIso && kIso === todayKey) || (kMs && kMs === todayKey);
          if (!isToday) return null;

          const m2 = computeM2(order);
          const cope = computePieces(order);
          const total = Number(order.pay?.euro || 0);
          const paid = Number(order.pay?.paid || 0);

          return {
            id: String(order.id),
            code: normalizeCode(order.client?.code || order.code || ''),
            name: order.client?.name || '',
            phone: order.client?.phone || '',
            m2,
            cope,
            total,
            paid,
            pickedAt:
              pickedIso ||
              (pickedMs ? new Date(pickedMs).toISOString() : ''),
          };
        } catch {
          return null;
        }
      });

      const res = await Promise.all(promises);
      const list = res.filter(Boolean);

      // sort newest first
      list.sort((a, b) => {
        const ta = new Date(a.pickedAt || 0).getTime() || 0;
        const tb = new Date(b.pickedAt || 0).getTime() || 0;
        return tb - ta;
      });

      setRows(list);
    } catch (e) {
      // OFFLINE fallback
      try {
        const todayKey = dayKeyLocal(new Date());
        const local = await getAllOrdersLocal().catch(() => []);
        const list = Array.isArray(local) ? local : [];
        const offlineRows = list
          .filter((o) => String(o?.status || '').toLowerCase() === 'dorzim')
          .map((order) => {
            const id = String(order?.id || '');
            const picked = order?.picked_up_at || order?.delivered_at;
            const key = picked ? dayKeyFromIso(picked) : dayKeyFromMs(order?.pickedUpAt || order?.deliveredAt);
            return {
              id,
              name: order?.client?.name || '',
              phone: order?.client?.phone || '',
              code: normalizeCode(order?.client?.code || order?.code),
              m2: computeM2(order),
              cope: computePieces(order),
              total: Number(order?.pay?.euro || 0),
              paid: Number(order?.pay?.paid || 0),
              dayKey: key,
              order,
            };
          })
          .filter((r) => r.dayKey === todayKey);
        setRows(offlineRows);
      } catch {
        setRows([]);
      }
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const name = (r.name || '').toLowerCase();
      const phone = (r.phone || '').toLowerCase();
      const code = normalizeCode(r.code).toLowerCase();
      return name.includes(q) || phone.includes(q) || code.includes(q);
    });
  }, [rows, search]);

  const totalM2 = useMemo(() => rows.reduce((s, r) => s + (Number(r.m2) || 0), 0), [rows]);
  const totalEuro = useMemo(() => rows.reduce((s, r) => s + (Number(r.total) || 0), 0), [rows]);

  function sendSms(row) {
    const phone = sanitizePhone(row.phone || '');
    if (!phone) return alert('Nuk ka numër telefoni.');
    const msg =
      `Përshëndetje ${row.name || 'klient'}, ` +
      `faleminderit! Porosia${row.code ? ` (kodi ${row.code})` : ''} u dorëzua sot.\n` +
      `${row.cope || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².\n` +
      `Faleminderit!`;
    window.location.href = `sms:${phone}?&body=${encodeURIComponent(msg)}`;
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">Porositë e dorëzuara sot</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL: <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
          <div>
            XHIRO: <strong>{totalEuro.toFixed(2)} €</strong>
          </div>
        </div>
      </header>

      <input
        className="input"
        placeholder="🔎 Kërko emrin / telefonin / kodin..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <section className="card" style={{ padding: '10px' }}>
        {loading ? (
          <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p>
        ) : filtered.length === 0 ? (
          <p style={{ textAlign: 'center' }}>S’ka marrje sot.</p>
        ) : (
          filtered.map((r) => (
            <div
              key={r.id}
              className="list-item-compact"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 4px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    background: '#16a34a',
                    color: '#fff',
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    fontWeight: 900,
                    fontSize: 14,
                    flexShrink: 0,
                  }}
                >
                  {normalizeCode(r.code)}
                </div>

                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.name || 'Pa emër'}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                    {r.cope} copë • {Number(r.m2 || 0).toFixed(2)} m²
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                    {new Date(r.pickedAt || Date.now()).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn secondary"
                  style={{ padding: '6px 10px', fontSize: 12 }}
                  onClick={() => sendSms(r)}
                >
                  SMS
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <footer className="dock">
        <Link href="/" className="btn secondary" style={{ width: '100%' }}>
          🏠 HOME
        </Link>
      </footer>

      <style jsx>{`
        .dock {
          position: sticky;
          bottom: 0;
          padding: 10px 0 6px 0;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0));
          margin-top: 10px;
        }
      `}</style>
    </div>
  );
}
