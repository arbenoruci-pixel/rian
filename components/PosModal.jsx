'use client';

import React, { useMemo } from 'react';

/**
 * POS Modal (Cash Register) — iPhone-safe full-screen sheet
 *
 * Keeps UI consistent across phases; business logic (PIN, DB updates, arka moves)
 * stays in the page and is triggered via onConfirm().
 */
export default function PosModal({
  open,
  onClose,
  title = 'PAGESA (ARKË)',
  subtitle = '',
  total = 0,
  alreadyPaid = 0,
  amount,
  setAmount,
  payChips = [5, 10, 20, 30, 50],
  confirmText = 'KRYEJ PAGESËN',
  cancelText = 'ANULO',
  disabled = false,
  onConfirm,
  showMethod = false,
  method,
  setMethod,
  extraTopRows = null,
  footerNote = null,
}) {
  if (!open) return null;

  const totalN = Number(total || 0);
  const paidN = Number(alreadyPaid || 0);
  const dueNow = useMemo(() => Math.max(0, Number((totalN - paidN).toFixed(2))), [totalN, paidN]);
  const givenN = Number(amount || 0);
  const resto = useMemo(() => Math.max(0, Number((givenN - dueNow).toFixed(2))), [givenN, dueNow]);

  const canConfirm = dueNow > 0 && givenN >= dueNow && !disabled;

  return (
    <div className="posfs" role="dialog" aria-modal="true">
      <div className="posfs__top">
        <div className="posfs__topLeft">
          <div className="posfs__title">{title}</div>
          {subtitle ? <div className="posfs__sub">{subtitle}</div> : null}
        </div>
        <button
          type="button"
          className="posfs__x"
          onClick={onClose}
          aria-label="Mbyll"
          disabled={disabled}
        >
          ✕
        </button>
      </div>

      <div className="posfs__body">
        <div className="poscard">
          <div className="posrow">
            <span>TOTALI I POROSISË:</span>
            <strong>{totalN.toFixed(2)} €</strong>
          </div>
          {paidN > 0 ? (
            <div className="posrow posrow--paid">
              <span>PAGUAR MË HERËT:</span>
              <strong>{paidN.toFixed(2)} €</strong>
            </div>
          ) : null}

          {extraTopRows}

          <div className="posdue" style={{ color: dueNow > 0 ? '#ef4444' : '#10b981' }}>
            <span>{dueNow > 0 ? 'BORXHI PËR SOT:' : 'E PAGUAR PLOTËSISHT'}</span>
            <strong>{dueNow.toFixed(2)} €</strong>
          </div>
        </div>

        {dueNow > 0 ? (
          <div className="poscard" style={{ marginTop: 12 }}>
            <div className="poslabel">SA PARA PO JEP KLIENTI?</div>

            <input
              type="number"
              inputMode="decimal"
              className="posinput"
              value={amount === 0 ? '' : String(amount ?? '')}
              onChange={(e) => setAmount?.(Number(e.target.value))}
              placeholder="0.00"
              disabled={disabled}
            />

            {showMethod ? (
              <div className="posmethod">
                <button
                  type="button"
                  className={`poschip ${method === 'CASH' ? 'poschip--active' : ''}`}
                  onClick={() => setMethod?.('CASH')}
                  disabled={disabled}
                >
                  CASH
                </button>
                <button
                  type="button"
                  className={`poschip ${method === 'BANK' ? 'poschip--active' : ''}`}
                  onClick={() => setMethod?.('BANK')}
                  disabled={disabled}
                >
                  BANKË
                </button>
              </div>
            ) : null}

            <div className="poschips">
              <button
                type="button"
                className="poschip poschip--primary"
                onClick={() => setAmount?.(dueNow)}
                disabled={disabled}
              >
                E SAKTË
              </button>
              {payChips.map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  className="poschip"
                  onClick={() => setAmount?.(Number(v))}
                  disabled={disabled}
                >
                  {v}€
                </button>
              ))}
              <button
                type="button"
                className="poschip poschip--wide"
                onClick={() => setAmount?.(0)}
                disabled={disabled}
              >
                FSHI SHUMËN
              </button>
            </div>

            {givenN >= dueNow ? (
              <div className="posresto">
                <span>KUSURI (RESTO):</span>
                <strong>{resto.toFixed(2)} €</strong>
              </div>
            ) : null}
          </div>
        ) : null}

        {footerNote ? <div className="posnote">{footerNote}</div> : null}
      </div>

      <div className="posfs__footer">
        <button type="button" className="posbtn posbtn--ghost" onClick={onClose} disabled={disabled}>
          {cancelText}
        </button>
        <button
          type="button"
          className="posbtn posbtn--ok"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
        >
          {confirmText}
        </button>
      </div>

      <style jsx>{`
        .posfs {
          position: fixed;
          inset: 0;
          z-index: 10000;
          background: #0b0b0b;
          display: flex;
          flex-direction: column;
          width: 100%;
          max-width: 100vw;
          box-sizing: border-box;
          overflow-x: hidden;
        }
        .posfs * { box-sizing: border-box; }

        .posfs__top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 14px;
          padding-top: calc(12px + env(safe-area-inset-top));
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .posfs__topLeft { min-width: 0; }
        .posfs__title { color: #fff; font-weight: 900; font-size: 18px; letter-spacing: 0.5px; }
        .posfs__sub { color: rgba(255,255,255,0.7); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .posfs__x {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: #fff;
          font-size: 20px;
          font-weight: 900;
          flex: 0 0 auto;
        }

        .posfs__body {
          flex: 1;
          overflow: auto;
          -webkit-overflow-scrolling: touch;
          padding: 12px 14px;
          padding-bottom: calc(14px + env(safe-area-inset-bottom));
        }

        .poscard {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 14px;
          padding: 14px;
          width: 100%;
          max-width: 100%;
          overflow-x: hidden;
        }

        .posrow {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 15px;
          color: rgba(255,255,255,0.9);
        }
        .posrow--paid { margin-top: 10px; color: #10b981; }

        .posdue {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid rgba(255,255,255,0.10);
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 20px;
          font-weight: 900;
        }

        .poslabel {
          text-align: center;
          font-weight: 900;
          letter-spacing: 0.8px;
          font-size: 12px;
          color: #60a5fa;
          margin-bottom: 10px;
        }

        .posinput {
          width: 100%;
          max-width: 100%;
          height: 60px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(0,0,0,0.35);
          color: #fff;
          text-align: center;
          font-size: 32px;
          font-weight: 900;
          outline: none;
        }

        .poschips {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          width: 100%;
          max-width: 100%;
        }

        .poschip {
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: #fff;
          padding: 12px 0;
          font-weight: 900;
          font-size: 15px;
          width: 100%;
          max-width: 100%;
        }
        .poschip--primary { background: #3b82f6; border-color: rgba(59,130,246,0.8); }
        .poschip--wide { grid-column: span 3; opacity: 0.8; }

        .posmethod {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }
        .poschip--active { outline: 2px solid rgba(34,197,94,0.9); }

        .posresto {
          margin-top: 14px;
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 18px;
          font-weight: 900;
          color: #10b981;
          padding: 12px;
          border-radius: 12px;
          background: rgba(16,185,129,0.15);
          border: 1px solid rgba(16,185,129,0.30);
          width: 100%;
          max-width: 100%;
          overflow-x: hidden;
        }

        .posnote {
          margin-top: 12px;
          font-size: 12px;
          color: rgba(255,255,255,0.65);
          text-align: center;
        }

        .posfs__footer {
          display: flex;
          gap: 10px;
          padding: 12px 14px;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
          border-top: 1px solid rgba(255,255,255,0.08);
          background: #0b0b0b;
          width: 100%;
          max-width: 100vw;
          overflow-x: hidden;
        }

        .posbtn {
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: #fff;
          padding: 12px 14px;
          font-weight: 900;
          letter-spacing: 0.6px;
          width: 100%;
        }
        .posbtn--ghost { flex: 1; }
        .posbtn--ok {
          flex: 2;
          background: #10b981;
          color: #000;
          border-color: rgba(16,185,129,0.9);
        }
      `}</style>
    </div>
  );
}
