'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { getErrorMessage } from '@/lib/uiSafety';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import { getTransportSession, setTransportSession } from '@/lib/transportAuth';
import { findUserByPin } from '@/lib/usersDb';
import { LS_USER, LS_SESSION, clearAllSessionState } from '@/lib/sessionStore';
import useRouteAlive from '@/lib/routeAlive';

function V33PageOpenFallback() {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#fff', display: 'grid', placeItems: 'center', padding: 24, fontFamily: '-apple-system,BlinkMacSystemFont,Roboto,sans-serif' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 20, background: 'rgba(255,255,255,0.06)', padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>DUKE HAPUR…</div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>HOME</a>
          <a href="/diag-raw" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>DIAG RAW</a>
        </div>
      </div>
    </div>
  );
}

function onlyDigits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function TransportLoginPageInner() {
  useRouteAlive('transport_login_page');
  const router = useRouter();
  const sp = useSearchParams();
  const force = sp?.get('force') === '1';

  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const cleanedPin = useMemo(() => onlyDigits(pin), [pin]);

  useEffect(() => {
    if (force) return; // allow staying on page for verification
    const s = getTransportSession();
    if (s?.transport_id) {
      router.replace('/transport/board');
    }
  }, [router, force]);

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setErr('');

    const rawPin = onlyDigits(cleanedPin);
    if (!rawPin) {
      setErr('SHKRUAJ PIN / TRANSPORT ID');
      return;
    }

    setSubmitting(true);

    try {
      // CRITICAL FIX:
      // Dispatch assigns with tepiha_users.id (UUID), not numeric PIN.
      // Resolve PIN -> user.id here so Inbox/Board matches transport_orders.transport_id.
      const res = await findUserByPin(rawPin);
      const user = res?.ok ? res.item : null;
      const resolvedTid = String(user?.id || rawPin).trim();
      const resolvedName = String(user?.name || (name || '').trim() || 'TRANSPORT').trim();

      let mainPin = '';
      try {
        const rawMain = localStorage.getItem(LS_USER);
        const mainActor = rawMain ? JSON.parse(rawMain) : null;
        mainPin = String(mainActor?.pin || '').trim();
      } catch {}

      setTransportSession({
        transport_id: resolvedTid,
        transport_pin: String(rawPin),
        pin: String(rawPin),
        user_id: resolvedTid,
        transport_name: resolvedName,
        name: resolvedName,
        role: 'TRANSPORT',
        from: user?.id ? 'login:user-id' : 'login:pin-fallback',
        ts: Date.now(),
      });
      try { window.dispatchEvent(new CustomEvent('tepiha:session-changed', { detail: { reason: 'transport_login', at: Date.now() } })); } catch {}

      try {
        if (mainPin && mainPin !== String(rawPin)) {
          clearAllSessionState({ preserveTransport: true });
        }
      } catch {}

      router.replace('/transport/board');
    } catch (e2) {
      setErr(getErrorMessage(e2, 'GABIM NË LOGIN'));
      setSubmitting(false);
    }
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <h1 className="title">TRANSPORT LOGIN</h1>
      </header>

      <div className="banner">
        HAPI 2 AKTIV — LOGIN I HARMONIZUAR
      </div>

      <section className="card">
        <form onSubmit={submit} className="form">
          <label className="lbl">TRANSPORT ID / PIN</label>
          <input
            className="inp"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="p.sh. 8888"
          />

          <div style={{ height: 10 }} />

          <label className="lbl">EMRI (OPSIONAL)</label>
          <input
            className="inp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="p.sh. SABRI"
          />

          {err ? <div className="err">{err}</div> : null}

          <button className="btn" type="submit" disabled={submitting}>{submitting ? 'DUKE HYRË...' : 'HYJ'}</button>
        </form>

        <div className="muted" style={{ marginTop: 10 }}>
          PËR TA VERIFIKUAR DEPLOY-IN, HAPE: /transport/login?force=1
        </div>
      </section>

      <style jsx>{`
        .wrap{min-height:100vh;background:#0b0f1a;color:#fff;padding:18px}
        .header-row{display:flex;align-items:center;justify-content:center;margin:10px 0 10px}
        .title{font-size:18px;letter-spacing:1px;text-transform:uppercase}
        .banner{margin:0 auto 12px;max-width:520px;text-align:center;padding:10px 12px;border-radius:12px;
          background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.35);font-weight:900;letter-spacing:1px;text-transform:uppercase}
        .card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;max-width:520px;margin:0 auto}
        .form{display:flex;flex-direction:column}
        .lbl{font-size:12px;opacity:.8;margin-bottom:6px;letter-spacing:.8px;text-transform:uppercase}
        .inp{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 12px;color:#fff;font-size:16px;outline:none}
        .inp:focus{border-color:rgba(255,255,255,.35)}
        .btn{margin-top:14px;background:#22c55e;border:none;border-radius:12px;padding:12px 14px;font-weight:900;letter-spacing:1px;text-transform:uppercase}
        .btn:disabled{opacity:.65;cursor:not-allowed}
        .err{margin-top:10px;color:#ffb4b4;font-weight:800}
        .muted{opacity:.7;font-size:12px;letter-spacing:.4px;text-transform:uppercase}
      `}</style>
    </div>
  );
}
export default function TransportLoginPage() {
  return (
    <Suspense fallback={null}>
      <TransportLoginPageInner />
    </Suspense>
  );
}
