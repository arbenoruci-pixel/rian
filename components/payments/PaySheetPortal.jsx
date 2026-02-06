import React, { useEffect, useMemo, useState } from "react";

/**
 * PaySheetPortal (FULL)
 * - Stable: round2, payBusy/payErr states
 * - Works with CASH ONLY: system registers EXACT due (remaining)
 * - If client gives more: kthim = cashGiven - payDue
 *
 * Props:
 *  - open: boolean
 *  - order: object (expects: code, client_name/name, total_eur/total/totalEuro, paid/paid_eur/paidToDate)
 *  - onClose: fn
 *  - onSubmit: async fn(payload)  // you implement db write; return {ok:true} or throw
 */
export default function PaySheetPortal({ open, order, onClose, onSubmit }) {
  // --- REQUIRED STATES (fix missing vars errors)
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState("");

  // input states
  const [cashGivenStr, setCashGivenStr] = useState(""); // keep as string for iOS keyboards
  const [activeChip, setActiveChip] = useState(""); // "EXACT", "5", "10", ...

  // --- Helpers
  const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

  const parseEuro = (v) => {
    if (v === null || v === undefined) return 0;
    const s = String(v).trim().replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : 0;
  };

  // --- Normalize order fields (avoid undefined vars like totalEuro/clientPaid)
  const code = order?.code ?? order?.code_n ?? order?.nr ?? "";
  const clientName = order?.client_name ?? order?.name ?? order?.client ?? "";

  const totalEuro = useMemo(() => {
    // accept various field names
    const t =
      order?.total_eur ??
      order?.totalEuro ??
      order?.total ??
      order?.sum ??
      order?.amount ??
      0;
    return round2(parseEuro(t));
  }, [order]);

  const paidToDate = useMemo(() => {
    // IMPORTANT: this replaces "clientPaid" (which was wrong)
    const p = order?.paid_eur ?? order?.paidToDate ?? order?.paid ?? order?.paguar ?? 0;
    return round2(parseEuro(p));
  }, [order]);

  // remaining due (exact)
  const payDue = useMemo(() => {
    const due = round2(totalEuro - paidToDate);
    return due < 0 ? 0 : due;
  }, [totalEuro, paidToDate]);

  // Cash given (number)
  const cashGiven = useMemo(() => round2(parseEuro(cashGivenStr)), [cashGivenStr]);

  // Change to give back
  const kthim = useMemo(() => {
    const change = round2(cashGiven - payDue);
    return change > 0 ? change : 0;
  }, [cashGiven, payDue]);

  // What system will register (CASH ONLY = exact due, not cashGiven)
  const registerExact = useMemo(() => round2(payDue), [payDue]);

  // --- Reset on open/order change
  useEffect(() => {
    if (!open) return;
    setPayErr("");
    setPayBusy(false);
    setActiveChip("");
    setCashGivenStr(payDue > 0 ? String(payDue) : ""); // default show EXACT due
  }, [open, payDue]);

  if (!open) return null;

  const setExact = () => {
    setActiveChip("EXACT");
    setCashGivenStr(payDue ? String(payDue) : "0");
  };

  // Chip buttons should SET the bill amount (5/10/20/50...), not add on top of the default.
  // Otherwise: payDue 19.50 + chip 20€ => 39.50 (confusing). User expects 20€.
  const addChip = (bill) => {
    const next = round2(bill);
    setActiveChip(String(bill));
    setCashGivenStr(next % 1 === 0 ? String(next.toFixed(0)) : String(next.toFixed(2)));
  };

  const clearCash = () => {
    setActiveChip("FSHI");
    setCashGivenStr("");
    setPayErr("");
  };

  const canSubmit = !payBusy && payDue > 0 && cashGiven >= payDue;

  const handleConfirm = async () => {
    setPayErr("");
    if (payBusy) return;

    // validations (same behavior you had)
    if (payDue <= 0) {
      setPayErr("KJO POROSI S’KA BORXH.");
      return;
    }
    if (cashGivenStr === "" || !Number.isFinite(cashGiven)) {
      setPayErr("JU LUTEM SHKRUANI SA DHA KLIENTI.");
      return;
    }
    if (cashGiven < payDue) {
      setPayErr("KLIENTI DHA MË PAK SE SHUMA. JU LUTEM FUTNI SHUMËN E PLOTË.");
      return;
    }

    setPayBusy(true);
    try {
      // payload for your db write
      const payload = {
        order_id: order?.id ?? order?.order_id ?? null,
        code: code,
        total_eur: totalEuro,
        paid_to_date_eur: paidToDate,
        due_exact_eur: payDue, // exact remaining
        cash_given_eur: cashGiven, // what client handed
        change_eur: kthim,
        register_eur: registerExact, // what system should record (exact)
        ts: Date.now(),
      };

      // YOU CONNECT THIS to your real insert/update logic
      if (onSubmit) await onSubmit(payload);

      // close on success
      onClose?.();
    } catch (e) {
      setPayErr(
        (e && (e.message || e.toString())) || "DIÇKA SHKOI GABIM GJATË PAGESËS."
      );
    } finally {
      setPayBusy(false);
    }
  };

  return (
    <div className="pay-overlay">
      <div className="pay-modal">
        <div className="pay-head">
          <div className="pay-title">PAGESA</div>
          <div className="pay-sub">
            KODI: {code} {clientName ? `• ${clientName}` : ""}
          </div>
          <button className="pay-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="pay-box">
          <div className="pay-row">
            <div className="k">TOTAL:</div>
            <div className="v">{totalEuro.toFixed(2)} €</div>
          </div>
          <div className="pay-row">
            <div className="k">PAGUAR DERI TANI:</div>
            <div className="v green">{paidToDate.toFixed(2)} €</div>
          </div>
          <div className="pay-row muted">
            <div className="k">REGJISTRU N'ARKË DERI TANI:</div>
            <div className="v">{paidToDate.toFixed(2)} €</div>
          </div>

          <div className="pay-sep" />

          <div className="pay-row">
            <div className="k">BORXH (EXACT):</div>
            <div className="v">{payDue.toFixed(2)} €</div>
          </div>
          <div className="pay-row muted">
            <div className="k">NË SISTEM REGJISTROHET:</div>
            <div className="v">{registerExact.toFixed(2)} €</div>
          </div>
          <div className="pay-row">
            <div className="k">KTHIM:</div>
            <div className="v blue">{kthim.toFixed(2)} €</div>
          </div>
        </div>

        <div className="pay-input-block">
          <div className="label">KLIENTI DHA (€)</div>
          <input
            className="pay-input"
            value={cashGivenStr}
            onChange={(e) => {
              setPayErr("");
              setActiveChip("");
              setCashGivenStr(e.target.value);
            }}
            inputMode="decimal"
            placeholder="0"
          />

          <div className="chips">
            <button className={"chip " + (activeChip === "EXACT" ? "on" : "")} onClick={setExact}>
              EXACT
            </button>
            <button className={"chip " + (activeChip === "5" ? "on" : "")} onClick={() => addChip(5)}>
              5€
            </button>
            <button className={"chip " + (activeChip === "10" ? "on" : "")} onClick={() => addChip(10)}>
              10€
            </button>
            <button className={"chip " + (activeChip === "20" ? "on" : "")} onClick={() => addChip(20)}>
              20€
            </button>
            <button className={"chip " + (activeChip === "30" ? "on" : "")} onClick={() => addChip(30)}>
              30€
            </button>
            <button className={"chip " + (activeChip === "50" ? "on" : "")} onClick={() => addChip(50)}>
              50€
            </button>
            <button className={"chip danger " + (activeChip === "FSHI" ? "on" : "")} onClick={clearCash}>
              FSHI
            </button>
          </div>

          <div className="hint">
            CASH (VETËM) — në sistem regjistrohet vetëm shuma exacte e mbetur. Nëse klienti jep
            më shumë, kthehet.
          </div>

          {payErr ? <div className="err">{payErr}</div> : null}
        </div>

        <div className="pay-foot">
          <button className="btn ghost" onClick={onClose} disabled={payBusy}>
            ANULO
          </button>
          <button className="btn primary" onClick={handleConfirm} disabled={!canSubmit}>
            {payBusy ? "DUKE RUJT..." : "KONFIRMO"}
          </button>
        </div>
      </div>

      {/* Minimal CSS (nëse s’ke stile, këto e bëjnë të ngjajshëm me dark UI) */}
      <style jsx>{`
        .pay-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .pay-modal {
          width: 100%;
          max-width: 520px;
          background: #0b0f17;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
          color: #fff;
          overflow: hidden;
        }
        .pay-head {
          position: relative;
          padding: 16px 16px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .pay-title {
          font-weight: 900;
          letter-spacing: 0.14em;
        }
        .pay-sub {
          margin-top: 6px;
          opacity: 0.75;
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .pay-x {
          position: absolute;
          right: 12px;
          top: 12px;
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: transparent;
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .pay-box {
          padding: 14px 16px;
        }
        .pay-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 0;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .pay-row .k {
          opacity: 0.9;
        }
        .pay-row .v {
          opacity: 0.95;
        }
        .muted {
          opacity: 0.55;
          font-weight: 700;
        }
        .pay-sep {
          height: 1px;
          background: rgba(255, 255, 255, 0.06);
          margin: 10px 0;
        }
        .green {
          color: #1bd96a;
        }
        .blue {
          color: #4aa3ff;
        }
        .pay-input-block {
          padding: 12px 16px 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .label {
          opacity: 0.7;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          font-size: 12px;
          margin-bottom: 10px;
        }
        .pay-input {
          width: 100%;
          background: #0f1a2c;
          border: 1px solid rgba(66, 133, 244, 0.25);
          color: #fff;
          padding: 13px;
          border-radius: 14px;
          font-size: 18px;
          font-weight: 900;
          outline: none;
        }
        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 12px;
        }
        .chip {
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(74, 163, 255, 0.35);
          background: rgba(74, 163, 255, 0.08);
          color: #a9d2ff;
          font-weight: 900;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .chip.on {
          border-color: rgba(74, 163, 255, 0.9);
          background: rgba(74, 163, 255, 0.22);
          color: #fff;
        }
        .chip.danger {
          border-color: rgba(255, 77, 77, 0.5);
          background: rgba(255, 77, 77, 0.1);
          color: #ff7d7d;
        }
        .hint {
          margin-top: 10px;
          opacity: 0.65;
          font-size: 12px;
          line-height: 1.35;
        }
        .err {
          margin-top: 10px;
          color: #ff6b6b;
          font-weight: 900;
          letter-spacing: 0.02em;
        }
        .pay-foot {
          display: flex;
          gap: 12px;
          padding: 14px 16px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .btn {
          flex: 1;
          height: 44px;
          border-radius: 14px;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .btn.ghost {
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #fff;
        }
        .btn.primary {
          background: #2f6cff;
          border: 1px solid rgba(47, 108, 255, 0.35);
          color: #fff;
        }
        .btn:disabled {
          opacity: 0.45;
        }
      `}</style>
    </div>
  );
}