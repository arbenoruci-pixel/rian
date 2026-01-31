'use client';

import React, { useEffect, useMemo, useState } from 'react';

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
  const [payBusy, setPayBusy] = useState(false); // Emri i saktë për sistemin tënd
  const [payErr, setPayErr] = useState('');   // Emri i saktë që pamë në foto

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // KALKULIMI (Logjika që dëshiron)
  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  const given = useMemo(() => toNum(givenStr), [givenStr]);
  
  // Këto janë variablat që "GATI" page i pret për të futur paret në arkë:
  const totalEuro = due; 
  const clientPaid = given;

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

  // Funksioni që dërgon paret në Arkë
  const doConfirm = async () => {
    if (payBusy) return;
    setPayErr('');
    try {
      setPayBusy(true);
      // I kalojmë të dyja: edhe emrat e rinj (due/apply), edhe të vjetërit (totalEuro/clientPaid)
      // Kjo garanton që cilindo version që përdor faqja GATI, paret do të hyjnë.
      await onConfirm?.({ 
        given, 
        apply: due, 
        change, 
        due, 
        totalEuro, 
        clientPaid 
      });
    } catch (e) {
      setPayErr(String(e?.message || e || 'GABIM NË ARKË'));
    } finally {
      setPayBusy(false);
    }
  };

  return (
    <div className="payfs">
      <div className="payfs-top">
        <div>
          <div className="payfs-title">{title}</div>
          {!!subtitle && <div className="payfs-sub">{subtitle}</div>}
        </div>
        <button type="button" className="payfs-x" onClick={onClose}>×</button>
      </div>

      <div className="payfs-body">
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
          <div className="row">
            <span style={{color: '#fff'}}>BORXH I MBETUR:</span>
            <strong style={{color: '#facc15', fontSize: '20px'}}>{due.toFixed(2)} €</strong>
          </div>
          {change > 0 && (
            <div className="row">
              <span>KTHIMI (KUSURI):</span>
              <strong style={{ color: '#60a5fa' }}>{change.toFixed(2)} €</strong>
            </div>
          )}
        </div>

        <div className="payfs-card">
          <div className="label">KLIENTI DHA (€)</div>
          <input
            className="inp"
            inputMode="decimal"
            value={givenStr}
            onChange={(e) => { setPayErr(''); setGivenStr(e.target.value); }}
          />
          <div className="chips">
            <button type="button" className="chip active-chip" onClick={() => pickChip(due)}>EXACT</button>
            {CASH_CHIPS.map((n) => (
              <button type="button" key={n} className="chip" onClick={() => pickChip(n)}>{n}€</button>
            ))}
            <button type="button" className="chip danger-chip" onClick={() => pickChip(0)}>FSHI</button>
          </div>
          {!!payErr && <div className="err-banner">{payErr}</div>}
        </div>

        <div className="payfs-footer">
          <button type="button" className="btn secondary" onClick={onClose} disabled={payBusy}>ANULO</button>
          <button type="button" className="btn primary" onClick={doConfirm} disabled={payBusy}>
            {payBusy ? 'DUKE RUJT...' : confirmLabel}
          </button>
        </div>
      </div>

      <style jsx>{`
        .payfs { position: fixed; inset: 0; z-index: 999999; background: #0b0b0b; display: flex; flex-direction: column; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .payfs-title { color: #fff; font-weight: 900; letter-spacing: .08em; }
        .payfs-sub { color: rgba(255,255,255,.7); font-size: 12px; margin-top: 4px; }
        .payfs-x { background: transparent; border: none; color: #fff; font-size: 28px; padding: 0 6px; }
        .payfs-body { padding: 14px; overflow: auto; flex: 1; }
        .payfs-card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 14px; margin-bottom: 12px; }
        .row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; color: #fff; font-weight: 800; }
        .dim { color: rgba(255,255,255,.45) !important; font-weight: 700; }
        .line { height: 1px; background: rgba(255,255,255,.08); margin: 8px 0; }
        .label { color: rgba(255,255,255,.65); font-weight: 900; font-size: 12px; margin-bottom: 8px; }
        .inp { width: 100%; padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.12); background: #0b1220; color: #fff; font-size: 22px; font-weight: 900; }
        .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
        .chip { padding: 10px 14px; border-radius: 999px; border: 1px solid rgba(96,165,250,.4); background: transparent; color: #60a5fa; font-weight: 900; }
        .active-chip { border-color: #2563eb; background: rgba(37,99,235,0.1); }
        .danger-chip { border-color: #ef4444; color: #ef4444; }
        .err-banner { margin-top: 10px; color: #fff; background: #991b1b; padding: 10px; border-radius: 10px; font-weight: 800; font-size: 13px; text-align: center; }
        .payfs-footer { display: flex; gap: 10px; padding: 14px; border-top: 1px solid rgba(255,255,255,.08); }
        .btn { flex: 1; padding: 14px; border-radius: 18px; border: 1px solid rgba(255,255,255,.12); font-weight: 900; }
        .btn.secondary { background: transparent; color: #fff; }
        .btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        .btn:disabled { opacity: .6; }
      `}</style>
    </div>
  );
}
