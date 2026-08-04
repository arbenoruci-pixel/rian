'use client';

import { useEffect, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { canManageBaseReadyBonuses, getBaseReadyBonusSummary } from '@/lib/baseReadyBonusClient';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const M2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function euro(value) {
  const n = Number(value || 0);
  return `${MONEY.format(Number.isFinite(n) ? n : 0)}€`;
}

function m2(value) {
  const n = Number(value || 0);
  return `${M2.format(Number.isFinite(n) ? n : 0)} m²`;
}

export default function ReadyBonusLiveCard({ actor = null, style = null }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const pin = String(actor?.pin || '').trim();
  const manager = canManageBaseReadyBonuses(actor?.role);

  useEffect(() => {
    if (!pin) return undefined;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await getBaseReadyBonusSummary({
          actorPin: pin,
          workerPin: manager ? 'ALL' : pin,
          allowCache: true,
        });
        if (!cancelled) {
          setSummary(data);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e || ''));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 45000);
    const onRefresh = () => void load();
    window.addEventListener('focus', onRefresh);
    window.addEventListener('online', onRefresh);
    window.addEventListener('arka:refresh', onRefresh);
    window.addEventListener('base-ready-bonus:refresh', onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener('online', onRefresh);
      window.removeEventListener('arka:refresh', onRefresh);
      window.removeEventListener('base-ready-bonus:refresh', onRefresh);
    };
  }, [pin, manager]);

  if (!pin || (!summary && !error)) return null;
  const totals = summary?.totals || {};

  return (
    <div
      data-ready-bonus-live-card="1"
      style={{
        marginBottom: 14,
        padding: 12,
        borderRadius: 16,
        border: '1px solid rgba(250,204,21,.34)',
        background: 'linear-gradient(135deg,rgba(113,63,18,.24),rgba(15,23,42,.88))',
        display: 'grid',
        gap: 9,
        ...(style || {}),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 1000, letterSpacing: '.12em', color: '#fde68a' }}>BONUSI 48H • VETËM BAZA</div>
          <div style={{ marginTop: 3, fontSize: 19, lineHeight: 1, fontWeight: 1000 }}>{manager ? 'KREJT PUNËTORËT' : 'BONUSI IM LIVE'}</div>
          <div style={{ marginTop: 5, fontSize: 10, color: '#cbd5e1', fontWeight: 800 }}>0.10€ / m² • aktivizohet në pagesën që e mbyll porosinë • rifreskohet automatikisht</div>
        </div>
        <Link
          href="/arka/bonuset"
          style={{
            textDecoration: 'none',
            padding: '9px 11px',
            borderRadius: 11,
            background: '#ca8a04',
            color: '#fff',
            fontSize: 10,
            fontWeight: 1000,
            whiteSpace: 'nowrap',
          }}
        >
          HAPE
        </Link>
      </div>

      {summary ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
          <div style={{ padding: 8, borderRadius: 11, background: 'rgba(2,6,23,.55)' }}>
            <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 1000 }}>SOT</div>
            <div style={{ marginTop: 3, fontSize: 17, fontWeight: 1000 }}>{euro(totals?.today_earned)}</div>
            <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 800 }}>{m2(totals?.today_m2)}</div>
          </div>
          <div style={{ padding: 8, borderRadius: 11, background: 'rgba(2,6,23,.55)' }}>
            <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 1000 }}>MUAJI</div>
            <div style={{ marginTop: 3, fontSize: 17, fontWeight: 1000 }}>{euro(totals?.month_earned)}</div>
            <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 800 }}>{totals?.month_orders || 0} porosi</div>
          </div>
          <div style={{ padding: 8, borderRadius: 11, background: 'rgba(133,77,14,.28)', border: '1px solid rgba(250,204,21,.22)' }}>
            <div style={{ fontSize: 8, color: '#fde68a', fontWeight: 1000 }}>PËR ME MBAJT</div>
            <div style={{ marginTop: 3, fontSize: 17, fontWeight: 1000 }}>{euro(totals?.available_to_keep)}</div>
            <div style={{ fontSize: 8, color: '#fde68a', fontWeight: 800 }}>hiqet nga dorëzimi</div>
          </div>
        </div>
      ) : <div style={{ color: '#fca5a5', fontSize: 10, fontWeight: 850 }}>{error || 'NUK U NGARKUA BONUSI.'}</div>}

      {summary?._offlineSnapshot ? <div style={{ fontSize: 8, color: '#fde68a', fontWeight: 900 }}>OFFLINE • SNAPSHOT I FUNDIT</div> : null}
    </div>
  );
}

// BASE_PAYMENT_48H_BONUS_V2:LIVE_CARD
