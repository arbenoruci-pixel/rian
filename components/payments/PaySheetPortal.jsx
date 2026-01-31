'use client';

import React, { useEffect, useMemo, useState } from 'react';

// Chips janë shuma fikse që klienti mund të japë në dorë
const CASH_CHIPS = [5, 10, 20, 30, 50];

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

  // 1. Borxhi i mbetur (Logjika që kërkove)
  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  // 2. Çfarë shkruan përdoruesi te inputi
  const given = useMemo(() => toNum(givenStr), [givenStr]);

  // 3. Shuma që do të regjistrohet (Gjithmonë fiks sa borxhi)
  const apply = useMemo(() => {
    return due;
  }, [due]);

  // 4. Kthimi (Kusuri)
  const change = useMemo(() => {
    return Math.max(0, Number((given - due).toFixed(2)));
  }, [given, due]);

  useEffect(() => {
    if (!open) return;
    setErr('');
    // Kur hapet, mbush inputin automatikisht me vlerën e saktë të borxhit
    setGivenStr(String(due || 0));
    
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
      // Kalojmë objektin e plotë të llogaritur te GATI page
      await callback({ given, apply, change, due });
    } catch (e) {
      setErr(String(e?.message || e || 'GABIM'));
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
        <button type="button" className="payfs-x" onClick={onClose}>×</button>
      </div>

      <div className="payfs-body">
        {/* TABELA E LLOGARITJES */}
        <div className="payfs-card">
          <div className="row">
            <span>TOTAL:</span>
            <strong>{toNum(total).toFixed(2)} €</strong>
          </div>
          <div className="row">
            <span>PAGUAR DERI TANI:</span>
            <strong style={{ color: '#22c55e' }}>{toNum(paid).toFixed(2)} €</strong>
          </div>
          <div className="row dim">
            <span>ARKË (HISTORIK):</span>
            <strong className="dim">{toNum(arkaRecordedPaid).toFixed(2)} €</strong>
          </div>
          
          <div className="line" />

          <div className="row highlighted">
            <span>BORXH I MBETUR:</span>
            <strong className="due-text">{due.toFixed(2)} €</strong>
          </div>
          
          {change > 0 && (
            <div className="row change-row">
              <span>KTHIM (KUSURI):</span>
              <strong style={{ color: '#60a5fa' }}>{change.toFixed(2)} €</strong>
            </div>
          )}
        </div>

        {/* INPUTI DHE PARATË CASH */}
        <div className="payfs-card">
          <div className="label">KLIENTI DHA (€)</div>
          <input
            className="inp"
            type="text"
            inputMode="decimal"
            value={givenStr}
            onChange={(e) => { setErr(''); setGivenStr(e.target.value); }}
            autoFocus
          />

          <div className="chips">
            <button type="button" className="chip primary-chip" onClick={() => pickChip(due)}>EXACT</button>
            {CASH_CHIPS.map((n) => (
              <button type="button" key={n} className="chip" onClick={() => pickChip(n)}>
                {n}€
              </button>
            ))}
            <button type="button" className="chip danger-chip" onClick={() => pickChip(0)}>FSHI</button>
          </div>

          <div className="note">
            CASH — Në sistem regjistrohet fiks <b>{due.toFixed(2)} €</b>. Diferenca i kthehet klientit.
          </div>

          {!!err && <div className="err-msg">{err}</div>}
        </div>
      </div>

      {/* DREJTUESIT E PAGESËS */}
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
        .payfs { position: fixed; inset: 0; z-index: 999999; background: #000; display: flex; flex-direction: column; font-family: sans-serif; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #222; }
        .payfs-title { color: #fff; font-weight: 900; letter-spacing: 1px; font-size: 18px; }
        .payfs-sub { color: #666; font-size: 12px; margin-top: 2px; }
        .payfs-x { background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; padding: 0 8px; }
        .payfs-body { padding: 16px; overflow-y: auto; flex: 1; }
        .payfs-card { background: #111; border: 1px solid #222; border-radius: 20px; padding: 18px; margin-bottom: 14px; }
        .row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; color: #fff; font-weight: 700; font-size: 14px; }
        .highlighted { font-size: 16px; margin-top: 8px; }
        .due-text { color: #facc15; font-size: 20px; font-weight: 900; }
        .dim { color: #444 !important; }
        .line { height: 1px; background: #222; margin: 10px 0; }
        .label { color: #888; font-weight: 900; font-size: 11px; margin-bottom: 8px; letter-spacing: 1px; }
        .inp { width: 100%; padding: 16px; border-radius: 14px; border: 2px solid #333; background: #000; color: #fff; font-size: 22px; font-weight: 900; outline: none; transition: border-color 0.2s; }
        .inp:focus { border-color: #2563eb; }
        .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .chip { flex: 1; min-width: 65px; padding: 12px; border-radius: 12px; border: 1px solid #333; background: #1a1a1a; color: #fff; font-weight: 800; cursor: pointer; }
        .primary-chip { border-color: #2563eb; color: #60a5fa; }
        .danger-chip { border-color: #450a0a; color: #ef4444; }
        .note { margin-top: 12px; color: #555; font-size: 12px; font-weight: 600; line-height: 1.4; }
        .err-msg { margin-top: 12px; color: #ef4444; font-weight: 800; background: #2a0000; padding: 10px; border-radius: 10px; font-size: 13px; }
        .payfs-footer { display: flex; gap: 10px; padding: 16px; border-top: 1px solid #222; background: #000; }
        .btn { flex: 1; padding: 16px; border-radius: 16px; font-weight: 900; letter-spacing: 0.5px; cursor: pointer; border: none; transition: transform 0.1s, opacity 0.2s; }
        .btn.secondary { background: #1a1a1a; color: #fff; }
        .btn.primary { background: #2563eb; color: #fff; }
        .btn:active { transform: scale(0.97); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );

  return body;
}
