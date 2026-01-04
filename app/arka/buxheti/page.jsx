'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const euro = (n) =>
  `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;

export default function CompanyBudgetPage() {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [rows, setRows] = showState([]);
  const [type, setType] = useState('OUT'); // OUT / IN
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  // Totals (IN manual, OUT manual)
  const totals = useMemo(() => {
    let inManual = 0;
    let outTotal = 0;

    for (const r of rows) {
      const a = Number(r.amount || 0);
      if (r.type === 'IN') inManual += a;
      else outTotal += a;
    }
    return { inManual, outTotal };
  }, [rows]);

  // IN (DISPATCH) = llogaritet nga arka_days të pranuara (RECEIVED)
  const [inDispatch, setInDispatch] = useState(0);

  const balance = useMemo(() => {
    return Number(inDispatch || 0) + Number(totals.inManual || 0) - Number(totals.outTotal || 0);
  }, [inDispatch, totals.inManual, totals.outTotal]);

  async function loadAll() {
    setBusy(true);
    setErr('');
    try {
      // 1) Manual moves nga arka_company_moves
      const q1 = await supabase
        .from('arka_company_moves')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

      if (q1.error) throw q1.error;
      setRows(q1.data || []);

      // 2) IN (DISPATCH) = shuma e cikleve RECEIVED (arka_days)
      // (nëse ke kolonë total_in, përdore; përndryshe përdor expected_cash/cash_counted sipas logjikës tënde)
      const q2 = await supabase
        .from('arka_days')
        .select('cash_counted, expected_cash, handoff_status, received_at')
        .eq('handoff_status', 'RECEIVED')
        .not('received_at', 'is', null)
        .limit(1000);

      if (q2.error) throw q2.error;

      // këtu marrim cash_counted (sa u dorëzua realisht)
      let sum = 0;
      for (const d of q2.data || []) {
        sum += Number(d.cash_counted || 0);
      }
      setInDispatch(sum);
    } catch (e) {
      console.error(e);
      setErr(e?.message || 'Load failed');
    } finally {
      setBusy(false);
    }
  }

  async function addMove() {
    setErr('');

    const a = Number(amount);
    if (!a || Number.isNaN(a) || a <= 0) {
      setErr('SHUMA DUHET ME QENË > 0');
      return;
    }

    setBusy(true);
    try {
      const ins = await supabase
        .from('arka_company_moves')
        .insert({
          type,
          amount: a,
          note: note || null,
        })
        .select('*')
        .single();

      if (ins.error) throw ins.error;

      setAmount('');
      setNote('');
      await loadAll();
    } catch (e) {
      console.error(e);
      setErr(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wrap">
      <div className="top">
        <h1>BUXHETI I KOMPANISË</h1>
        <button className="btn" onClick={() => router.back()}>
          KTHEHU
        </button>
      </div>

      {err ? <div className="err">{err}</div> : null}

      <div className="card">
        <div className="cardTitle">GJENDJA</div>

        <div className="grid4">
          <div className="mini">
            <div className="lbl">IN (DISPATCH)</div>
            <div className="val">{euro(inDispatch)}</div>
          </div>

          <div className="mini">
            <div className="lbl">OUT (TOTAL)</div>
            <div className="val">{euro(totals.outTotal)}</div>
          </div>

          <div className="mini">
            <div className="lbl">IN (MANUAL)</div>
            <div className="val">{euro(totals.inManual)}</div>
          </div>

          <div className="mini">
            <div className="lbl">BALANCI</div>
            <div className="val">{euro(balance)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">SHTO LËVIZJE</div>

        {/* FIX: kjo është pjesa që s’lejon me dalë jashtë ekranit */}
        <div className="row">
          <select value={type} onChange={(e) => setType(e.target.value)} className="select">
            <option value="OUT">OUT</option>
            <option value="IN">IN</option>
          </select>

          <input
            className="money"
            type="number"
            inputMode="decimal"
            placeholder="€"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <input
          className="note"
          type="text"
          placeholder="SHËNIM (opsional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <button className="btnWide" disabled={busy} onClick={addMove}>
          {busy ? 'DUKE RUJT...' : 'SHTO'}
        </button>
      </div>

      <div className="card">
        <div className="cardTitle">HISTORIA (300)</div>

        {rows?.length ? (
          <div className="list">
            {rows.map((r) => (
              <div className="item" key={r.id}>
                <div className="left">
                  <span className={`pill ${r.type === 'IN' ? 'in' : 'out'}`}>{r.type}</span>
                  <span className="noteTxt">{r.note || '-'}</span>
                </div>
                <div className="amt">{euro(r.amount)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">S’KA LËVIZJE.</div>
        )}

        <div className="hint">
          IN (DISPATCH) llogaritet nga dorëzimet e pranuara (RECEIVED) në CASH.
          OUT/IN manual ruhen te <b>arka_company_moves</b>.
        </div>
      </div>

      <style jsx>{`
        .wrap {
          padding: 18px;
          max-width: 860px;
          margin: 0 auto;
        }

        .top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 14px;
        }

        h1 {
          margin: 0;
          font-size: 34px;
          letter-spacing: 1px;
        }

        .err {
          border: 2px solid rgba(255, 0, 0, 0.45);
          background: rgba(255, 0, 0, 0.08);
          padding: 12px 14px;
          border-radius: 14px;
          margin: 10px 0 16px;
          font-weight: 800;
        }

        .card {
          border-radius: 22px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          padding: 18px;
          margin: 14px 0;
        }

        .cardTitle {
          font-weight: 900;
          letter-spacing: 3px;
          opacity: 0.7;
          margin-bottom: 14px;
        }

        .grid4 {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .mini {
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.35);
          padding: 14px;
          min-width: 0;
        }
        .lbl {
          font-weight: 900;
          letter-spacing: 3px;
          opacity: 0.75;
          font-size: 12px;
        }
        .val {
          margin-top: 6px;
          font-size: 30px;
          font-weight: 900;
        }

        /* ===== THE FIX ===== */
        .row {
          display: flex;
          gap: 12px;
          align-items: stretch;
          width: 100%;
          min-width: 0;
          flex-wrap: nowrap;
        }

        .select {
          flex: 0 0 140px;
          min-width: 0;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(0, 0, 0, 0.6);
          color: white;
          font-weight: 900;
          letter-spacing: 2px;
          padding: 12px 14px;
          box-sizing: border-box;
        }

        .money {
          flex: 1 1 auto;
          width: 100%;
          min-width: 0; /* super important for iOS overflow */
          max-width: 100%;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: white;
          color: black;
          font-weight: 900;
          font-size: 18px;
          padding: 12px 14px;
          box-sizing: border-box;
        }

        .note {
          margin-top: 12px;
          width: 100%;
          min-width: 0;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: white;
          color: black;
          font-weight: 900;
          font-size: 18px;
          padding: 12px 14px;
          box-sizing: border-box;
        }

        .btn {
          border-radius: 16px;
          padding: 12px 18px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.06);
          color: white;
          font-weight: 900;
          letter-spacing: 2px;
        }

        .btnWide {
          width: 100%;
          margin-top: 12px;
          border-radius: 16px;
          padding: 14px 18px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.85);
          color: black;
          font-weight: 900;
          letter-spacing: 3px;
        }

        .list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 12px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.35);
          min-width: 0;
        }

        .left {
          display: flex;
          gap: 10px;
          align-items: center;
          min-width: 0;
          flex: 1;
        }

        .pill {
          border-radius: 999px;
          padding: 6px 10px;
          font-weight: 900;
          letter-spacing: 2px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: rgba(255, 255, 255, 0.06);
          flex: 0 0 auto;
        }

        .pill.in {
          border-color: rgba(0, 255, 0, 0.35);
        }
        .pill.out {
          border-color: rgba(255, 0, 0, 0.35);
        }

        .noteTxt {
          opacity: 0.9;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .amt {
          font-weight: 900;
          font-size: 18px;
          flex: 0 0 auto;
        }

        .muted {
          opacity: 0.7;
          font-weight: 900;
        }

        .hint {
          margin-top: 12px;
          opacity: 0.7;
          font-weight: 800;
          line-height: 1.3;
        }

        /* MOBILE */
        @media (max-width: 480px) {
          h1 {
            font-size: 28px;
          }
          .select {
            flex: 0 0 110px;
          }
          .val {
            font-size: 26px;
          }
        }
      `}</style>
    </div>
  );
}

// tiny helper to avoid linter warning in some setups
function showState() {
  return useState([]);
}