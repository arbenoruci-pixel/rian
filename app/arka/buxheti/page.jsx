'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { dbListClosedDays, dbReceiveFromDispatch } from '@/lib/arkaDb';
import { findUserByPin as findUserByPinDb } from '@/lib/usersDb';

const fmtEur = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function readMe() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA') || localStorage.getItem('arka_user');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function BuxhetiPage() {
  const [me, setMe] = useState(null);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState('');
  const [pinAction, setPinAction] = useState(null);

  useEffect(() => {
    setMe(readMe());
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setErr('');
    try {
      const list = await dbListClosedDays(80);
      setRows(Array.isArray(list) ? list : []);
    } catch (e) {
      setErr(e?.message || 'S’u lexua buxheti.');
    }
  }

  const totalReceived = useMemo(() => {
    return (rows || []).reduce((s, r) => s + Number(r?.received_amount || 0), 0);
  }, [rows]);

  function requirePin(action) {
    setPin('');
    setPinErr('');
    setPinAction(() => action);
    setShowPin(true);
  }

  async function submitPin() {
    const clean = String(pin || '').trim();
    if (!clean) {
      setPinErr('SHKRUAJ PIN');
      return;
    }
    setPinErr('');
    try {
      const res = await findUserByPinDb(clean);
      if (!res?.ok || !res?.item) {
        setPinErr('PIN I GABUAR');
        return;
      }
      const u = { id: res.item.id, name: res.item.name, role: res.item.role };
      setShowPin(false);
      if (typeof pinAction === 'function') await pinAction(u);
    } catch (e) {
      setPinErr(e?.message || 'GABIM PIN');
    }
  }

  async function onReceive(day) {
    requirePin(async (u) => {
      setBusy(true);
      setErr('');
      try {
        if (String(u?.role || '').toUpperCase() !== 'DISPATCH' && String(u?.role || '').toUpperCase() !== 'ADMIN') {
          setErr('VETËM DISPATCH/ADMIN MUND TA PRANOJË DORËZIMIN.');
          return;
        }
        const amt = day?.cash_counted ?? day?.expected_cash ?? 0;
        await dbReceiveFromDispatch({ day_id: day.id, received_by: u.name, received_amount: amt });
        await refresh();
      } catch (e) {
        setErr(e?.message || 'S’u pranua dorëzimi.');
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">COMPANY BUDGET</div>
          <div className="sub">{(me?.name || "LOCAL").toLowerCase()} • {(me?.role || "DISPATCH")} • LOCAL</div>
          <div className="sub">TOTALI I PRANUAR: €{fmtEur(totalReceived)}</div>
        </div>
        <div className="topActions">
          <Link href="/arka/cash" className="ghostBtn">CASH</Link>
          <Link href="/arka" className="ghostBtn">KTHEHU</Link>
        </div>
      </div>

      {!!err && <div className="errBox">{err}</div>}

      <div className="card">
        <div className="cardHead">
          <div className="cardTitle">DITËT E MBYLLURA</div>
        </div>

        <div className="list">
          {(rows || []).map((d) => {
            const status = String(d?.handoff_status || '').toUpperCase() || 'CLOSED';
            const cash = Number(d?.cash_counted ?? d?.expected_cash ?? 0);
            const disc = Number(d?.discrepancy ?? 0);
            const received = d?.received_at ? true : false;
            const canReceive = !received && (status === 'HANDED' || status === 'PENDING');

            return (
              <div className="moveRow" key={d.id}>
                <div className="moveLeft">
                  <div className="moveType">
                    <span className={received ? "tag tagIn" : (status === "HANDED" ? "tag tagOut" : "tag")}>
                      {received ? "RECEIVED" : status}
                    </span>
                    <span className="src">{String(d.day_key || "—")}</span>
                  </div>

                  <div className="note">
                    CASH: €{fmtEur(cash)} • DISK: €{fmtEur(disc)}
                  </div>

                  <div className="meta">
                    CLOSED BY: {(d.closed_by || "—").toLowerCase()}
                    {d.closed_at ? " • " + String(d.closed_at).replace("T"," ").slice(0,16) : ""}
                    {d.received_at ? " • PRANUAR NGA: " + String(d.received_by || "—").toLowerCase() + " • " + String(d.received_at).replace("T"," ").slice(0,16) : ""}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                  <div className="moveAmt">€{fmtEur(d.received_amount ?? (received ? cash : 0))}</div>
                  {canReceive ? (
                    <button className="primaryBtn" disabled={busy} onClick={() => onReceive(d)}>
                      PRANO
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {(!rows || rows.length === 0) ? <div className="hint">S’ka ditë të mbyllura ende.</div> : null}
        </div>

      </div>

      {showPin ? (
 ? (
        <div className="modalBack">
          <div className="modalCard">
            <div className="modalTitle">PRANO DORËZIMIN (PIN)</div>
            <div className="field">
              <div className="label">PIN</div>
              <input className="input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="****" />
              {pinErr ? <div className="error">{pinErr}</div> : null}
            </div>
            <div className="rowBtns">
              <button className="ghostBtn" type="button" onClick={() => setShowPin(false)} disabled={busy}>ANULO</button>
              <button className="primaryBtn" type="button" onClick={submitPin} disabled={busy}>VAZHDO</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
