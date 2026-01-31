'use client';

import React, { useEffect, useMemo, useState } from 'react';

// Chips për shumat e shpejta cash
const CASH_CHIPS = [5, 10, 20, 30, 50];

// Helper për pastrimin e numrave (zëvendëson round2)
function toNum(x) {
  const n = Number(String(x ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function PaySheetPortal({
  open,
  title = 'PAGESA',
  subtitle = '',
  total = 0,
  paid = 0,
  arkaRecordedPaid = 0,
  onClose,
  onConfirm, // async ({ given, apply, change, due }) => {}
  onPayOnly = null,
  payOnlyLabel = 'RUJ (PA DORËZU)',
  confirmLabel = 'KONFIRMO',
}) {
  const [mounted, setMounted] = useState(false);
  const [givenStr, setGivenStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // KALKULIMI I BORXHIT (due)
  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  // SHUMA QË JEP KLIENTI (given)
  const given = useMemo(() => toNum(givenStr), [givenStr]);

  // SHUMA QË REGJISTROHET NË SISTEM (apply)
  // Nuk e kalon kurrë borxhin (due)
  const apply = useMemo(() => {
    return due;
  }, [due]);

  // KTHIMI (change)
  const change = useMemo(() => {
    return Math.max(0, Number((given - due).toFixed(2)));
  }, [given, due]);

  // Resetohet gjendja kur hapet modal-i
  useEffect(() => {
    if (!open) return;
    setErr('');
    setGivenStr(String(due || 0));
    
    // Bllokon scrolling e faqes mbrapa
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, due]);

  if (!open || !mounted) return null;

  const pickChip = (v) => {
    setErr('');
    setGivenStr(String(v));
  };

  const handleAction = async (callback) => {
    if (busy || !callback) return;
    setErr('');
    try {
      setBusy(true);
      // Kalojmë të gjitha variablat që kërkon faqja GATI
      await callback({ given, apply, change, due });
    } catch (e) {
      setErr(String(e?.message || e || 'GABIM GJATË PROCESIMIT'));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="payfs">
      {/* HEADER */}
      <div className="payfs-top">
        <div>
          <div className="payfs-title">{title}</div>
          {!!subtitle && <div className="payfs-sub">{subtitle}</div>}
        </div>
        <button type="button" className="payfs-x" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="payfs-body">
        {/* KARTA E TOTALIT */}
        <div className="payfs-card">
          <div className="row">
            <span>TOTALI PËR RENDITJE:</span>
            <strong>{toNum(total).toFixed(2)} €</strong>
          </div>
          <div className="row">
            <span>PAGUAR DERI TANI:</span>
            <strong style={{ color: '#22c55e' }}>{toNum(paid).toFixed(2)} €</strong>
          </div>
          <div className="row dim">
            <span>NË ARKË (HISTORIKU):</span>
            <strong className="dim">{toNum(arkaRecordedPaid).toFixed(2)} €</strong>
          </div>
          <div className="line" />

          <div className="row big-due">
            <span>BORXHI I MBETUR:</span>
            <strong className="due-amount">{due.toFixed(2)} €</strong>
          </div>
          {change > 0 && (
            <div className="row highlight-change">
              <span>KTHIMI PËR KLIENTIN:</span>
              <strong style={{ color: '#60a5fa' }}>{change.toFixed(2)} €</strong>
            </div>
          )}
        </div>

        {/* INPUTI DHE CHIPS */}
        <div className="payfs-card">
          <div className="label">KLIENTI DHA NË DORË (€)</div>
          <input
            className="inp"
            type="text"
            inputMode="decimal"
            value={givenStr}
            onChange={(e) => { setErr(''); setGivenStr(e.target.value); }}
            autoFocus
          />

          <div className="chips">
            <button type="button" className="chip bold-chip" onClick={() => pickChip(due)}>EXACT</button>
            {CASH_CHIPS.map((n) => (
              <button type="button" key={n} className="chip" onClick={() => pickChip(n)}>
                {n}€
              </button>
            ))}
            <button type="button" className="chip danger" onClick={() => pickChip(0)}>FSHI</button>
          </div>

          <div className="note">
             Sistemi regjistron vetëm <b>{due.toFixed(2)} €</b>. Diferenca llogaritet si kthim fizik.
          </div>

          {!!err && <div className="err-box">{err}</div>}
        </div>
      </div>

      {/* FOOTER ME VEPRIMET */}
      <div className="payfs-footer">
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>ANULO</button>
        
        {onPayOnly && (
          <button type="button" className="btn secondary" onClick={() => handleAction(onPayOnly)} disabled={busy}>
            {busy ? '...' : payOnlyLabel}
          </button>
        )}
        
        <button type="button" className="btn primary" onClick={() => handleAction(onConfirm)} disabled={busy}>
          {busy ? 'DUKE RUJT...' : confirmLabel}
        </button>
      </div>

      <style jsx>{`
        .payfs { position: fixed; inset: 0; z-index: 9999999; background: #000; display: flex; flex-direction: column; font-family: sans-serif; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 20px; border-bottom: 1px solid #222; }
        .payfs-title { color: #fff; font-size: 20px; font-weight: 900; letter-spacing: 1px; }
        .payfs-sub { color: #888; font-size: 13px; margin-top: 4px; }
        .payfs-x { background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; }
        .payfs-body { padding: 16px; overflow-y: auto; flex: 1; }
        .payfs-card { background: #111; border: 1px solid #222; border-radius: 24px; padding: 20px; margin-bottom: 16px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; color: #eee; font-size: 14px; font-weight: 600; }
        .big-due { font-size: 18px; color: #fff; margin-top: 10px; }
        .due-amount { color: #facc15; font-size: 22px; font-weight: 900; }
        .dim { color: #555 !important; }
        .line { height: 1px; background: #222; margin: 12px 0; }
        .label { color: #888; font-weight: 800; font-size: 12px; margin-bottom: 12px; letter-spacing: 0.5px; }
        .inp { width: 100%; padding: 18px; border-radius: 16px; border: 2px solid #333; background: #000; color: #fff; font-size: 24px; font-weight: 900; outline: none; }
        .inp:focus { border-color: #2563eb; }
        .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
        .chip { flex: 1; min-width: 60px; padding: 12px; border-radius: 12px; border: 1px solid #333; background: #1a1a1a; color: #fff; font-weight: 700; cursor: pointer; }
        .bold-chip { border-color: #2563eb; color: #60a5fa; }
        .chip.danger { border-color: #450a0a; color: #ef4444; }
        .note { margin-top: 15px; color: #666; font-size: 12px; line-height: 1.4; }
        .err-box { margin-top: 15px; background: #450a0a; color: #ff8888; padding: 12px; border-radius: 12px; font-weight: 700; font-size: 13px; }
        .payfs-footer { display: flex; gap: 12px; padding: 20px; background: #000; border-top: 1px solid #222; }
        .btn { flex: 1; padding: 18px; border-radius: 18px; font-weight: 900; cursor: pointer; transition: all 0.2s; border: none; }
        .btn.secondary { background: #1a1a1a; color: #fff; }
        .btn.primary { background: #2563eb; color: #fff; }
        .btn:active { transform: scale(0.96); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );

  // NOTE: We intentionally avoid React portals here.
  // A fixed-position overlay already behaves like a full-screen modal and
  // this prevents occasional iOS/Safari runtime issues with portals.
  return body;
}
