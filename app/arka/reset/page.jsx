'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const LS_USER = 'CURRENT_USER_DATA';

function wipeLocalTepihaData() {
  try {
    const prefixes = [
      'TEPIHA',
      'order_',
      'orders_',
      'client_',
      'clients_',
      'transport_',
      'arka_',
      'company_budget',
      'code_',
      'photo_',
      'X_CODE',
      'T_CODE',
    ];

    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }

    keys.forEach((k) => {
      const hit = prefixes.some((p) => k.startsWith(p));
      if (hit || k === 'tepiha_session_v1' || k === 'CURRENT_USER_DATA' || k === 'client_code_counter' || k === 'code_counter') {
        try { localStorage.removeItem(k); } catch {}
      }
    });
  } catch {
    // ignore
  }
}

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
    // Mos u mbështet në "disabled" sepse në iOS/Safari shpesh duket si buton aktiv,
    // por klikimi s’ndodh. E lejojmë gjithmonë klikimin dhe japim mesazh të qartë.
    if (busy) return;
    if (!user || !isAdminRole(user.role)) {
      setMsg('S’KE LEJE (DUHET ADMIN / DISPATCH).');
      return;
    }
    if (String(resetPin).trim() !== '2380') {
      setMsg('PIN GABIM (DUHET 2380).');
      return;
    }
    if (String(confirmText).trim().toUpperCase() !== 'RESET') {
      setMsg('DUHET ME SHKRU: RESET');
      return;
    }

    const ok = window.confirm(
      'KUJDES! KJO I FSHIN KREJT: KLIENTAT, POROSITË, PAGESAT, ARKËN, PENDING, SHPENZIMET, FOTOT.\n\nA JE SIGURT?'
    );
    if (!ok) return;

    setBusy(true);
    try {
      // IMPORTANT:
      // Use /api/admin/reset (canonical). This calls a Supabase RPC that TRUNCATES data but keeps schema.
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requester_pin: String(user?.pin || '').trim(),
          pin: String(resetPin || '').trim(),
          confirm: String(confirmText || '').trim(),
          mode: 'brand_new',
          wipe_photos: true
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setMsg(String(json?.error || 'GABIM NË RESET'));
        return;
      }

      // After reset: clear LOCAL app data (pools, queues, caches) so everything starts from scratch.
      wipeLocalTepihaData();

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

  async function doClientsOnlyReset() {
    setMsg('');
    if (busy) return;

    if (!user || !isAdminRole(user.role)) {
      setMsg('S’KE LEJE (DUHET ADMIN / DISPATCH).');
      return;
    }
    if (String(resetPin).trim() !== '2380') {
      setMsg('PIN GABIM (DUHET 2380).');
      return;
    }
    if (String(confirmText).trim().toUpperCase() !== 'RESET') {
      setMsg('DUHET ME SHKRU: RESET');
      return;
    }

    const ok = window.confirm(
      'KUJDES! RESET (KLIENTAT VETEM): fshin KLIENTAT + POROSITE + PAGESAT + ARKA (operacionale), por nuk prek USERS/ROLES/SETTINGS.\n\nA JE SIGURT?'
    );
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requester_pin: String(user?.pin || '').trim(),
          pin: String(resetPin || '').trim(),
          confirm: String(confirmText || '').trim(),
          mode: 'clients_only',
          wipe_photos: false,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setMsg(String(json?.error || 'GABIM NË RESET'));
        return;
      }

      // Clear only client-related local counters/caches.
      try {
        localStorage.removeItem('client_code_counter');
        localStorage.removeItem('code_counter');
        localStorage.removeItem('TEPIHA_CLIENTS');
        localStorage.removeItem('TEPIHA_CLIENTS_CACHE');
      } catch {}

      setMsg('OK — RESET KLIENTAT U KRY. MUNDESH ME VAZHDU MENJEHERE.');
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
              placeholder="••••"
              type="password"
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
            // iOS Safari nganjëherë s’e regjistron "click" nëse ka overlay/scroll; kjo e ndihmon.
            onTouchEnd={(e) => { e.preventDefault(); doReset(); }}
            type="button"
            className="arka-btn"
            style={{
              marginTop: 14,
              opacity: busy ? 0.5 : 1,
              borderColor: '#ff6b6b',
              color: '#ff6b6b'
            }}
          >
            {busy ? 'DUKE FSHIRË…' : 'FACTORY RESET (SUPABASE)'}
          </button>

          <button
            onClick={doClientsOnlyReset}
            onTouchEnd={(e) => { e.preventDefault(); doClientsOnlyReset(); }}
            type="button"
            className="arka-btn"
            style={{
              marginTop: 10,
              opacity: busy ? 0.5 : 1,
              borderColor: '#f59e0b',
              color: '#f59e0b'
            }}
          >
            {busy ? 'DUKE FSHIRË…' : 'RESET KLIENTAT (PA PREK USERS/SETTINGS)'}
          </button>

          {msg ? (
            <div className="arka-tile-desc" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{msg}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
