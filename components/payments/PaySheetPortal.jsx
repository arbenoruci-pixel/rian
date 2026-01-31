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
  onConfirm, // Ky funksion lidhet me arkën tënde në Supabase
  onPayOnly = null,
  payOnlyLabel = 'RUJ (PA DORËZU)',
  confirmLabel = 'KONFIRMO',
}) {
  const [mounted, setMounted] = useState(false);
  const [givenStr, setGivenStr] = useState('');
  
  // FIX: Deklarimi i state-ve që shkaktonin crash në foto
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // 1. LLOGARITJA E BORXHIT (Due)
  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  // 2. ÇFARË JEP KLIENTI (Given)
  const given = useMemo(() => toNum(givenStr), [givenStr]);

  // 3. EMRA PËR ARKËN (Përshtatje me sistemin tënd që paret me hy në DB)
  const totalEuro = due; 
  const clientPaid = given;

  // 4. KUSURI (Change)
  const change = useMemo(() => {
    return Math.max(0, Number((given - due).toFixed(2)));
  }, [given, due]);

  useEffect(() => {
    if (!open) return;
    setPayErr('');
    // Kur hapet, mbush inputin me borxhin fiks (Exact)
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

  // FUNKSIONI KRYESOR - DËRGIMI I PARAVE
  const doConfirm = async () => {
    if (payBusy) return;
    setPayErr('');
    try {
      setPayBusy(true);
      
      // Dërgojmë objektin me të gjithë emrat e mundshëm që arka mos të dështojë
      await onConfirm?.({ 
        given, 
        apply: due, 
        change, 
        due, 
        totalEuro,    // E kërkon faqja GATI
        clientPaid    // E kërkon faqja GATI
      });
      
    } catch (e) {
      setPayErr(String(e?.message || e || 'GABIM GJATË RUAJTJES'));
    } finally {
      setPayBusy(false);
    }
  };

  return (
    <div className="payfs">
      {/* TOP BAR */}
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

        {/* INPUTI DHE CASH CHIPS */}
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

          {/* ERROR DISPLAY - Tani funksionon pa crash */}
          {!!payErr && <div className="err-msg">{payErr}</div>}
        </div>
      </div>

      {/* FOOTER BUTTONS */}
      <div className="payfs-footer">
        <button type="button" className="btn secondary" onClick={onClose} disabled={payBusy}>ANULO</button>
        <button type="button" className="btn primary" onClick={doConfirm} disabled={payBusy}>
          {payBusy ? 'DUKE RUJT...' : confirmLabel}
        </button>
      </div>

      <style jsx>{`
        .payfs { position: fixed; inset: 0; z-index: 999999; background: #0b0b0b; display: flex; flex-direction: column; font-family: sans-serif; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 18px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .payfs-title { color: #fff; font-weight: 900; letter-spacing: .08em; font-size: 18px; }
        .payfs-sub { color: rgba(255,255,255,.5); font-size: 12px; margin-top: 4px; }
        .payfs-x { background: transparent; border: none; color: #fff; font-size: 32px; padding: 0 10px; cursor: pointer; }
        .payfs-body { padding: 16px; overflow-y: auto; flex: 1; }
        .payfs-card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 20px; padding: 20px; margin-bottom: 14px; }
        .row { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; color: #fff; font-weight: 800; }
        .dim { color: rgba(255,255,255,.3) !important; font-weight: 700; }
        .line { height: 1px; background: rgba(255,255,255,.08); margin: 10px 0; }
        .label { color: rgba(255,255,255,.5); font-weight: 900; font-size: 12px; margin-bottom: 10px; letter-spacing: 1px; }
        .inp { width: 100%; padding: 16px; border-radius: 16px; border: 1px solid rgba(255,255,255,.1); background: #000; color: #fff; font-size: 24px; font-weight: 900; outline: none; }
        .inp:focus { border-color: #2563eb; }
        .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .chip { flex: 1; min-width: 65px; padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.1); background: #111; color: #fff; font-weight: 900; cursor: pointer; }
        .active-chip { border-color: #2563eb; color: #60a5fa; }
        .danger-chip { border-color: #450a0a; color: #ef4444; }
        .err-msg { margin-top: 15px; background: #450a0a; color: #fca5a5; padding: 12px; border-radius: 12px; font-weight: 800; font-size: 13px; text-align: center; border: 1px solid #7f1d1d; }
        .payfs-footer { display: flex; gap: 12px; padding: 20px; border-top: 1px solid rgba(255,255,255,.08); background: #000; }
        .btn { flex: 1; padding: 18px; border-radius: 18px; border: none; font-weight: 900; font-size: 16px; cursor: pointer; transition: all 0.2s; }
        .btn.secondary { background: #111; color: #fff; }
        .btn.primary { background: #2563eb; color: #fff; }
        .btn:active { transform: scale(0.96); }
        .btn:disabled { opacity: .5; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
