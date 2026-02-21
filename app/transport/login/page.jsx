'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getTransportSession, setTransportSession } from '@/lib/transportAuth';

function onlyDigits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

export default function TransportLoginPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const force = sp?.get('force') === '1';

  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  const cleanedPin = useMemo(() => onlyDigits(pin), [pin]);

  useEffect(() => {
    if (force) return; // allow staying on page for verification
    const s = getTransportSession();
    if (s?.transport_id) {
      router.replace('/transport/board');
    }
  }, [router, force]);

  function submit(e) {
    e.preventDefault();
    setErr('');

    const tid = onlyDigits(cleanedPin);
    if (!tid) {
      setErr('SHKRUAJ TRANSPORT ID / PIN');
      return;
    }

    setTransportSession({
      transport_id: String(tid),
      transport_name: (name || '').trim() || 'TRANSPORT',
      role: 'TRANSPORT',
      from: 'login',
      ts: Date.now(),
    });

    router.replace('/transport/board');
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <h1 className="title">TRANSPORT LOGIN</h1>
      </header>

      <div className="banner">
        HAPI 2 AKTIV — GUARD + LOGIN
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

          <button className="btn" type="submit">HYJ</button>
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
        .err{margin-top:10px;color:#ffb4b4;font-weight:800}
        .muted{opacity:.7;font-size:12px;letter-spacing:.4px;text-transform:uppercase}
      `}</style>
    </div>
  );
}
