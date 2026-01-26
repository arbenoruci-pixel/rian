'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const LS_USER = 'CURRENT_USER_DATA';

function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function isAdminRole(role) {
  const r = String(role || '').toUpperCase();
  return r === 'ADMIN' || r === 'ADMIN_MASTER' || r === 'DISPATCH' || r === 'OWNER';
}

export default function FactoryResetPage() {
  const [user, setUser] = useState(null);
  const [resetPin, setResetPin] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setUser(readJSON(LS_USER, null));
  }, []);

  const canReset = useMemo(() => {
    if (!user || !isAdminRole(user.role)) return false;
    if (String(resetPin).trim() !== '2380') return false;
    if (String(confirmText).trim().toUpperCase() !== 'RESET') return false;
    return true;
  }, [user, resetPin, confirmText]);

  async function doReset() {
    setMsg('');
    if (!canReset) {
      setMsg('NUK I PLOTËSON KUSHTET (DUHET ADMIN + PIN 2380 + SHKRUAJ RESET)');
      return;
    }

    const ok = window.confirm(
      'KUJDES! KJO I FSHIN KREJT: KLIENTAT, POROSITË, PAGESAT, ARKËN, PENDING, SHPENZIMET, FOTOT.\n\nA JE SIGURT?'
    );
    if (!ok) return;

    setBusy(true);
    try {
      // IMPORTANT:
      // Use /api/admin/reset (canonical). The old /api/admin/factory-reset expects a different body.
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requester_pin: String(user?.pin || '').trim(),
          pin: String(resetPin || '').trim(),
          confirm: String(confirmText || '').trim(),
          wipe_db: true,
          wipe_photos: true,
          wipe_backups: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setMsg(String(json?.error || 'GABIM NË RESET'));
        return;
      }

      // After reset: clear local session so app reloads clean.
      try {
        localStorage.removeItem('tepiha_session_v1');
        localStorage.removeItem('CURRENT_USER_DATA');
      } catch {}

      setMsg('OK — FACTORY RESET U KRY. PO RILOGOHESH…');
      setTimeout(() => {
        window.location.href = '/login';
      }, 400);
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = !user || !isAdminRole(user.role);

  return (
    <div>
      <div className="arka-top">
        <div>
          <div className="arka-title">FACTORY RESET</div>
          <div className="arka-sub">FSHIN KREJT TË DHËNAT NGA SUPABASE</div>
        </div>
        <Link href="/arka" className="arka-back">Mbrapa</Link>
      </div>

      {blocked ? (
        <div className="arka-card" style={{ marginTop: 14 }}>
          <div className="arka-tile-name">S’KE LEJE</div>
          <div className="arka-tile-desc">Vetëm ADMIN / DISPATCH mundet me ba reset.</div>
        </div>
      ) : (
        <div className="arka-card" style={{ marginTop: 14 }}>
          <div className="arka-tile-name" style={{ color: '#ff6b6b' }}>KUJDES: KJO ËSHTË DESTRUKTIVE</div>
          <div className="arka-tile-desc">
            Kjo e kthen sistemin në 0: klienta, porosi, pagesa, arka, pending, shpenzime, backups, fotot (bucket tepiha-photos).
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="arka-tile-desc" style={{ display: 'block', marginBottom: 6 }}>RESET PIN (2380)</label>
            <input
              className="arka-input"
              value={resetPin}
              onChange={(e) => setResetPin(e.target.value)}
              placeholder="2380"
              inputMode="numeric"
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="arka-tile-desc" style={{ display: 'block', marginBottom: 6 }}>SHKRUAJ: RESET</label>
            <input
              className="arka-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESET"
              autoCapitalize="characters"
            />
          </div>

          <button
            onClick={doReset}
            disabled={!canReset || busy}
            className="arka-btn"
            style={{
              marginTop: 14,
              opacity: !canReset || busy ? 0.5 : 1,
              borderColor: '#ff6b6b',
              color: '#ff6b6b'
            }}
          >
            {busy ? 'DUKE FSHIRË…' : 'FACTORY RESET (SUPABASE)'}
          </button>

          {msg ? (
            <div className="arka-tile-desc" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{msg}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
