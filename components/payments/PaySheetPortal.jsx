'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

// Chips are common cash amounts the client may hand over (NOT increments).
const CASH_CHIPS = [5, 10, 20, 30, 50];

function toNum(x){
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

  useEffect(() => setMounted(true), []);

  const due = useMemo(() => {
    const t = toNum(total);
    const p = toNum(paid);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [total, paid]);

  const given = useMemo(() => toNum(givenStr), [givenStr]);

  const apply = useMemo(() => {
    // system registers ONLY the exact remaining amount
    return due;
  }, [due]);

  const change = useMemo(() => {
    // change is calculated only from what the client gave vs due
    return Math.max(0, Number((given - due).toFixed(2)));
  }, [given, due]);

  useEffect(() => {
    if (!open) return;
    setErr('');
    // Default input shows EXACT due
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

  const doConfirm = async () => {
    if (busy) return;
    setErr('');
    try {
      setBusy(true);
      // IMPORTANT: we pass full context so pages can submit correctly
      await onConfirm?.({ given, apply, change, due });
    } catch (e) {
      setErr(String(e?.message || e || 'ERROR'));
    } finally {
      setBusy(false);
    }
  };

  const doPayOnly = async () => {
    if (!onPayOnly) return;
    if (busy) return;
    setErr('');
    try {
      setBusy(true);
      await onPayOnly({ given, apply, change, due });
    } catch (e) {
      setErr(e?.message || 'GABIM');
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="payfs">
      <div className="payfs-top">
        <div>
          <div className="payfs-title">{title}</div>
          {!!subtitle && <div className="payfs-sub">{subtitle}</div>}
        </div>
        <button type="button" className="payfs-x" onClick={onClose} aria-label="Close">×</button>
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
            <span>REGJISTRU N'ARKË DERI TANI:</span>
            <strong className="dim">{toNum(arkaRecordedPaid).toFixed(2)} €</strong>
          </div>
          <div className="line" />

          <div className="row">
            <span>BORXH (EXACT):</span>
            <strong>{due.toFixed(2)} €</strong>
          </div>
          <div className="row dim">
            <span>NË SISTEM REGJISTROHET:</span>
            <strong className="dim">{apply.toFixed(2)} €</strong>
          </div>
          {change > 0 && (
            <div className="row">
              <span>KTHIM:</span>
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
            onChange={(e) => { setErr(''); setGivenStr(e.target.value); }}
          />

          <div className="chips">
            <button type="button" className="chip" onClick={() => pickChip(due)}>EXACT</button>
            {CASH_CHIPS.map((n) => (
              <button type="button" key={n} className="chip" onClick={() => pickChip(n)}>
                {n}€
              </button>
            ))}
            <button type="button" className="chip danger" onClick={() => pickChip(0)}>FSHI</button>
          </div>

          <div className="note">
            CASH (VETËM) — në sistem regjistrohet <b>vetëm shuma exacte e mbetur</b>. Nëse klienti jep më shumë, kthehet.
          </div>

          {!!err && <div className="err">{err}</div>}
        </div>

        <div className="payfs-footer">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>ANULO</button>
          {onPayOnly && (
            <button type="button" className="btn secondary" onClick={doPayOnly} disabled={busy}>
              {busy ? 'DUKE RUJT…' : payOnlyLabel}
            </button>
          )}
          <button type="button" className="btn primary" onClick={doConfirm} disabled={busy}>
            {busy ? 'DUKE RUJT…' : confirmLabel}
          </button>
        </div>
      </div>

      <style jsx>{`
        .payfs{position:fixed; inset:0; z-index:999999; background:#0b0b0b; display:flex; flex-direction:column;}
        .payfs-top{display:flex; justify-content:space-between; align-items:center; padding:14px; border-bottom:1px solid rgba(255,255,255,.08);}
        .payfs-title{color:#fff; font-weight:900; letter-spacing:.08em;}
        .payfs-sub{color:rgba(255,255,255,.7); font-size:12px; margin-top:4px;}
        .payfs-x{background:transparent; border:none; color:#fff; font-size:28px; line-height:1; padding:0 6px;}
        .payfs-body{padding:14px; overflow:auto; flex:1;}
        .payfs-card{background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:14px; margin-bottom:12px;}
        .row{display:flex; justify-content:space-between; gap:10px; padding:6px 0; color:#fff; font-weight:800;}
        .dim{color:rgba(255,255,255,.45) !important; font-weight:700;}
        .line{height:1px; background:rgba(255,255,255,.08); margin:8px 0;}
        .label{color:rgba(255,255,255,.65); font-weight:900; letter-spacing:.12em; font-size:12px; margin-bottom:8px;}
        .inp{width:100%; padding:12px; border-radius:14px; border:1px solid rgba(255,255,255,.12); background:#0b1220; color:#fff; font-size:18px; font-weight:900;}
        .chips{display:flex; flex-wrap:wrap; gap:10px; margin-top:10px;}
        .chip{padding:10px 14px; border-radius:999px; border:1px solid rgba(96,165,250,.4); background:transparent; color:#60a5fa; font-weight:900;}
        .chip.danger{border-color:rgba(239,68,68,.5); color:#ef4444;}
        .note{margin-top:10px; color:rgba(255,255,255,.5); font-size:12px; font-weight:700;}
        .err{margin-top:10px; color:#ef4444; font-weight:900;}
        .payfs-footer{display:flex; gap:10px; padding:14px; border-top:1px solid rgba(255,255,255,.08);}
        .btn{flex:1; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.12); font-weight:900; letter-spacing:.08em;}
        .btn.secondary{background:transparent; color:#fff;}
        .btn.primary{background:#2563eb; color:#fff; border-color:#2563eb;}
        .btn:disabled{opacity:.6}
      `}</style>
    </div>
  );

  return createPortal(body, document.body);
}
