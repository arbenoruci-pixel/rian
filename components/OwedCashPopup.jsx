'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { listOwedCashPaymentsByPin } from '@/lib/arkaCashSync';

const euro = (n) =>
  `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;

function readUser() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }

function ackKey(pin) {
  return `OWED_POPUP_ACK_${String(pin || '').trim()}`;
}

function makeHash(items) {
  const ids = (items || []).map((p) => p.id || p.external_id || '').join(',');
  const total = (items || []).reduce((s, x) => s + Number(x.amount || 0), 0);
  return `${ids}|${Number(total || 0).toFixed(2)}`;
}

}

// Worker responsibility popup:
// If a worker marked some CLOSED-ARKA cash payments as BORXH (status=OWED),
// we remind them that THEY must hand the money to ARKA.
export default function OwedCashPopup() {
  const [user, setUser] = useState(null);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);

  const pin = useMemo(() => String(user?.pin || '').trim(), [user?.pin]);

  const total = useMemo(() => {
    return (items || []).reduce((s, x) => s + Number(x.amount || 0), 0);
  }, [items]);

  async function loadOnce(u = user) {
    const p = String(u?.pin || '').trim();
    if (!p) return;
    try {
      const res = await listOwedCashPaymentsByPin(p, 200);
      const next = res?.items || [];
      // ignore zero/invalid amounts so popup doesn't loop on €0.00
      const cleaned = next.filter((x) => Number(x?.amount || 0) > 0);
      setItems(cleaned);
      if (cleaned.length > 0) {
        const h = makeHash(cleaned);
        const last = localStorage.getItem(ackKey(p)) || '';
        if (h !== last) setOpen(true);
      } else {
        setOpen(false);
      }
    } catch {
      // ignore (non-blocking)
    }
  }

  useEffect(() => {
    const u = readUser();
    setUser(u);
  }, []);

  useEffect(() => {
    if (!pin) return;
    loadOnce(user);
    // light polling (optional)
    const t = setInterval(() => loadOnce(user), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  if (!pin) return null;
  if (!open || !items?.length) return null;

  return (
    <div
      onClick={() => {
        try {
          const h = makeHash(items);
          if (h) localStorage.setItem(ackKey(pin), h);
        } catch {}
        setOpen(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9997,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 14,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 100%)',
          borderRadius: 18,
          border: '1px solid rgba(255,255,255,.14)',
          background: 'rgba(10,10,10,.96)',
          padding: 14,
          textTransform: 'uppercase',
        }}
      >
        <div style={{ fontWeight: 950, letterSpacing: 3 }}>BORXH N'ARKË ({user?.name || ''})</div>
        <div style={{ marginTop: 8, opacity: 0.85, fontWeight: 900, letterSpacing: 1.5 }}>
          TI JE PËRGJEGJËS ME I DORZU KËTO PARA N&apos;ARKË.
        </div>

        <div
          style={{
            marginTop: 10,
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,.10)',
            padding: 12,
            background: 'rgba(0,0,0,.35)',
          }}
        >
          <div style={{ fontWeight: 950, letterSpacing: 2 }}>TOTAL: {euro(total)}</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {items.slice(0, 8).map((p) => (
              <div key={p.id || p.external_id || JSON.stringify(p)} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: 900 }}>
                <div style={{ opacity: 0.85 }}>#{p.order_code || ''}</div>
                <div>{euro(p.amount)}</div>
              </div>
            ))}
            {items.length > 8 ? (
              <div style={{ opacity: 0.7, fontSize: 10, fontWeight: 900, letterSpacing: 2 }}>
                +{items.length - 8} TJERA
              </div>
            ) : null}
          </div>
        </div>

        <button
          onClick={() => setOpen(false)}
          style={{
            marginTop: 12,
            width: '100%',
            borderRadius: 14,
            padding: 12,
            border: '1px solid rgba(255,255,255,.14)',
            background: 'rgba(255,255,255,.06)',
            fontWeight: 950,
            letterSpacing: 2,
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}
