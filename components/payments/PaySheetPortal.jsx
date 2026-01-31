'use client';

import React, { useEffect, useMemo, useState } from 'react';

// Chips për shuma të shpejta cash
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
  onConfirm, 
  onPayOnly = null,
  payOnlyLabel = 'RUJ (PA DORËZU)',
  confirmLabel = 'KONFIRMO',
}) {
  const [mounted, setMounted] = useState(false);
  const [givenStr, setGivenStr] = useState('');
  
  // FIX KRYESOR: Deklarimi i variablave që shkaktonin crash në fotot tuaja
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // LLOGARITJA E BORXHIT
  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  const given = useMemo(() => toNum(givenStr), [givenStr]);

  // VARIABLAT QË ARKËS I DUHEN PËR ME HY PARET NË SUPABASE
  const totalEuro = due; 
  const clientPaid = given;

  // LLOGARITJA E KUSURIT
  const change = useMemo(() => {
    return Math.max(0, Number((given - due).toFixed(2)));
  }, [given, due]);

  useEffect(() => {
    if (!open) return;
    setPayErr('');
    setGivenStr(String(due || 0));
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, due]);

  if (!open || !mounted) return null;

  const pickChip = (v) => {
    setPayErr('');
    setGivenStr(String(v));
  };

  // FUNKSIONI I KONFIRMIMIT
  const doConfirm = async () => {
    if (payBusy) return;
    setPayErr('');
    try {
      setPayBusy(true);
      // Kalojmë objektin me të gjithë emrat që sistemi juaj të jetë stabil
      await onConfirm?.({ 
        given, 
        apply: due, 
        change, 
        due, 
        totalEuro, 
        clientPaid 
      });
    } catch (e) {
      setPayErr(String(e?.message || e || 'GABIM GJATË RUAJTJES'));
    } finally {
      setPayBusy(false);
    }
  };

  return (
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
        {/* KARTA E LLOGARITJES */}
        <div className="payfs-card">
          <div className="row">
            <span>TOTALI:</span>
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
          <div className="row">
            <span style={{ color: '#fff' }}>BORXH I MBETUR:</span>
            <strong style={{ color: '#facc15', fontSize: '22px' }}>{due.toFixed(2)} €</strong>
          </div>
          {change > 0 && (
            <div className="row highlight-change">
              <span>KTHIM (KUSURI):</span>
              <strong style={{ color: '#60a5fa' }}>{change.toFixed(2)} €</strong>
            </div>
          )}
        </div>

        {/* INPUTI DHE CHIPS */}
        <div className="payfs-card">
          <div className="label">KLIENTI DHA (€)</div>
          <input
            className="inp"
            inputMode="decimal"
            value={givenStr}
            onChange={(e) => { setPayErr(''); setGivenStr(e.target.value); }}
            autoFocus
          />

          <div className="chips">
            <button type="button" className="chip active-chip" onClick={() => pickChip(due)}>EXACT</button>
            {CASH_CHIPS.map((n) => (
              <button type="button" key={n} className="chip" onClick={() => pickChip(n)}>{n}€</button>
            ))}
            <button type="button" className="chip danger-chip" onClick={() => pickChip(0)}>FSHI</button>
          </div>

          {/* ERROR BOX - QË TANI NUK SHKAKTON CRASH */}
          {!!payErr && <div className="error-box">{payErr}</div>}
        </div>
      </div>

      {/* FOOTER */}
      <div className="payfs-footer">
        <button type="button" className="btn secondary" onClick={onClose} disabled={payBusy}>ANULO</button>
        <button type="button" className="btn primary" onClick={doConfirm} disabled={payBusy}>
          {payBusy ? 'DUKE RUJT...' : confirmLabel}
        </button>
      </div>

      <style jsx>{`
        .payfs { position: fixed; inset: 0; z-index: 999999; background: #000; display: flex; flex-direction: column; font-family: sans-serif; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 18px; border-bottom: 1px solid rgba(255,255,255,.1); }
        .payfs-title { color: #fff; font-weight: 900; letter-spacing: 1px; font-size: 18px; }
        .payfs-sub { color: #666; font-size: 12px; margin-top: 4px; }
        .payfs-x { background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; }
        .payfs-body { padding: 16px; overflow-y: auto; flex: 1; }
        .payfs-card { background: #111; border: 1px solid #222; border-radius: 20px; padding: 20px; margin-bottom: 14px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; color: #fff; font-weight: 700; font-size: 14px; }
        .dim { color: #444 !important; }
        .line { height: 1px; background: #222; margin: 10px 0; }
        .label { color: #888; font-weight: 900; font-size: 12px; margin-bottom: 10px; }
        .inp { width: 100%; padding: 18px; border-radius: 16px; border: 2px solid #333; background: #000; color: #fff; font-size: 24px; font-weight: 900; outline: none; }
        .inp:focus { border-color: #2563eb; }
        .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .chip { flex: 1; min-width: 65px; padding: 12px; border-radius: 14px; border: 1px solid #333; background: #1a1a1a; color: #fff; font-weight: 800; cursor: pointer; }
        .active-chip { border-color: #2563eb; color: #60a5fa; }
        .danger-chip { border-color: #450a0a; color: #ef4444; }
        .error-box { margin-top: 15px; background: #450a0a; color: #fca5a5; padding: 12px; border-radius: 12px; font-weight: 800; font-size: 13px; text-align: center; border: 1px solid #7f1d1d; }
        .payfs-footer { display: flex; gap: 12px; padding: 20px; border-top: 1px solid #222; background: #000; }
        .btn { flex: 1; padding: 18px; border-radius: 18px; border: none; font-weight: 900; font-size: 16px; cursor: pointer; }
        .btn.secondary { background: #1a1a1a; color: #fff; }
        .btn.primary { background: #2563eb; color: #fff; }
        .btn:disabled { opacity: 0.5; }
      `}</style>
    </div>
  );
}
