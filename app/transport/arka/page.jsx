"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTransportSession } from "@/lib/transportAuth";
import {
  readTransportArka,
  addTransportExpense,
  addTransportTransferToBase,
  computeTransportBalance,
} from "@/lib/transportArkaStore";

function parseAmount(v) {
  const s = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const EXP_TYPES = [
  { v: "FUEL", label: "NAFTË" },
  { v: "PARKING", label: "PARKING" },
  { v: "TOLL", label: "TOLL / RRUGË" },
  { v: "OTHER", label: "TË TJERA" },
];

function euro(n) {
  return `€${Number(n || 0).toFixed(2)}`;
}

function formatTs(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

export default function TransportArkaPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [state, setState] = useState({ items: [], expenses: [], transfers: [] });

  const [expType, setExpType] = useState("FUEL");
  const [expNote, setExpNote] = useState("");
  const [expAmt, setExpAmt] = useState("");

  const [trAmt, setTrAmt] = useState("");
  const [trNote, setTrNote] = useState("");
  const [busyTransfer, setBusyTransfer] = useState(false);
  const [showExpense, setShowExpense] = useState(false);

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      router.push("/transport");
      return;
    }
    setMe(s);
    setState(readTransportArka(s.transport_id));
  }, [router]);

  function refresh() {
    if (!me?.transport_id) return;
    setState(readTransportArka(me.transport_id));
  }

  const sums = useMemo(() => computeTransportBalance(state), [state]);
  const balance = sums.balance;
  const recentItems = useMemo(() => (state.items || []).slice(0, 20), [state]);
  const recentTransfers = useMemo(() => (state.transfers || []).slice(0, 10), [state]);

  function doExpense() {
    const n = parseAmount(expAmt);
    if (!Number.isFinite(n) || n <= 0) return alert("Shkruaje një shumë valide.");
    addTransportExpense(me.transport_id, {
      type: expType,
      amount: n,
      note: (expNote || "").trim(),
    });
    setExpAmt("");
    setExpNote("");
    setExpType("FUEL");
    refresh();
  }

  async function doTransferAmount(amount) {
    if (busyTransfer) return;
    const n = Number(amount || 0);
    if (!Number.isFinite(n) || n <= 0) return alert("Shuma nuk është valide.");
    if (n > balance) return alert("Nuk mund të dorëzosh më shumë se totali në xhep.");

    const ok = confirm(`A je i sigurt që do të dorëzosh ${euro(n)} në bazë?`);
    if (!ok) return;

    try {
      setBusyTransfer(true);
      const res = await addTransportTransferToBase({
        transportId: me.transport_id,
        transporterName: me.transport_name || me.name || "TRANSPORT",
        amount: n,
        note: (trNote || "").trim(),
      });

      if (!res?.ok) {
        throw new Error(res?.error || "Transferi dështoi.");
      }

      setTrAmt("");
      setTrNote("");
      refresh();
      alert("Dorëzimi në bazë u regjistrua me sukses.");
    } catch (e) {
      alert(String(e?.message || e || "Transferi dështoi."));
    } finally {
      setBusyTransfer(false);
    }
  }

  async function doTransferAll() {
    if (balance <= 0) return alert("S’ke para për të dorëzuar në bazë.");
    await doTransferAmount(balance);
  }

  async function doTransferCustom() {
    const n = parseAmount(trAmt);
    if (!Number.isFinite(n) || n <= 0) return alert("Shkruaje një shumë valide.");
    await doTransferAmount(n);
  }

  return (
    <div className="wrap">
      <header className="topbar">
        <div>
          <div className="eyebrow">TRANSPORT • ARKA E SHOFERIT</div>
          <h1 className="title">ARKA E SHOFERIT</h1>
          <div className="sub">
            {me?.transport_name || me?.name || "TRANSPORT"}
            {me?.pin ? ` • PIN ${me.pin}` : me?.transport_id ? ` • ID ${me.transport_id}` : ""}
          </div>
        </div>
        <div className="actions">
          <Link className="ghostBtn" href="/transport/menu">MENU</Link>
          <button className="ghostBtn" onClick={refresh}>RIFRESKO</button>
        </div>
      </header>

      {!me ? (
        <section className="bankCard centerCard">
          <div className="muted">NUK JE I KYÇUR</div>
          <Link className="heroBtn" href="/transport/login">HYR NË SISTEM</Link>
        </section>
      ) : (
        <>
          <section className="heroCard">
            <div className="heroLabel">TOTALI NË XHEP</div>
            <div className="heroAmount">{euro(balance)}</div>
            <div className="heroMeta">
              <span>Mbledhur {euro(sums.collected)}</span>
              <span>Shpenzime {euro(sums.expenses)}</span>
              <span>Dorëzuar {euro(sums.transfers)}</span>
            </div>
            <div className="heroActions">
              <button className="heroBtn" disabled={busyTransfer || balance <= 0} onClick={doTransferAll}>
                💸 TRANSFERO/DORËZO NË BAZË
              </button>
            </div>
          </section>

          <section className="bankCard">
            <div className="sectionTop">
              <div>
                <div className="sectionTitle">DORËZIM I PJESSHËM</div>
                <div className="sectionSub">Nëse do të dorëzosh vetëm një pjesë të totalit.</div>
              </div>
            </div>
            <div className="transferGrid">
              <input
                className="input"
                value={trAmt}
                onChange={(e) => setTrAmt(e.target.value)}
                placeholder={`SHUMA (max ${balance.toFixed(2)}€)`}
                inputMode="decimal"
              />
              <input
                className="input"
                value={trNote}
                onChange={(e) => setTrNote(e.target.value)}
                placeholder="PËRSHKRIM (opsional)"
              />
              <button className="softBtn" disabled={busyTransfer} onClick={doTransferCustom}>
                DORËZO KËTË SHUMË
              </button>
            </div>
          </section>

          <section className="bankCard">
            <div className="sectionTop">
              <div>
                <div className="sectionTitle">TRANSAKSIONET E FUNDIT</div>
                <div className="sectionSub">Pagesat e mbledhura që formojnë totalin në xhep.</div>
              </div>
            </div>
            <div className="txList">
              {recentItems.length === 0 ? (
                <div className="emptyState">Ende nuk ka pagesa të mbledhura.</div>
              ) : (
                recentItems.map((item) => (
                  <div key={item.id || item.external_id || item.ts} className="txRow">
                    <div className="txMain">
                      <div className="txTitle">{item.client_name || item.order_name || item.order_code || 'Pagesë transporti'}</div>
                      <div className="txMeta">
                        <span>{formatTs(item.ts || item.created_at)}</span>
                        {item.order_code ? <span>#{item.order_code}</span> : null}
                      </div>
                    </div>
                    <div className="txAmount">{euro(item.amount)}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="bankCard">
            <div className="sectionTop">
              <div>
                <div className="sectionTitle">DORËZIMET E FUNDIT</div>
                <div className="sectionSub">Historiku i dorëzimeve të cash-it në bazë.</div>
              </div>
            </div>
            <div className="txList">
              {recentTransfers.length === 0 ? (
                <div className="emptyState">Ende nuk ka dorëzime në bazë.</div>
              ) : (
                recentTransfers.map((t) => (
                  <div key={t.id || t.ts} className="txRow">
                    <div className="txMain">
                      <div className="txTitle">Dorëzim në bazë</div>
                      <div className="txMeta">
                        <span>{formatTs(t.ts)}</span>
                        {t.note ? <span>{t.note}</span> : null}
                      </div>
                    </div>
                    <div className="txAmount">{euro(t.amount)}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="bankCard">
            <div className="sectionTop">
              <div>
                <div className="sectionTitle">SHPENZIM I SHPEJTË</div>
                <div className="sectionSub">Përdore vetëm kur duhet. Përndryshe lëre të mbyllur.</div>
              </div>
              <button className="ghostBtn" onClick={() => setShowExpense((v) => !v)}>
                {showExpense ? 'MBYLLE' : 'HAPE'}
              </button>
            </div>

            {showExpense ? (
              <div className="expenseBox">
                <select className="input" value={expType} onChange={(e) => setExpType(e.target.value)}>
                  {EXP_TYPES.map((x) => (
                    <option key={x.v} value={x.v}>{x.label}</option>
                  ))}
                </select>
                <input
                  className="input"
                  value={expAmt}
                  onChange={(e) => setExpAmt(e.target.value)}
                  placeholder="SHUMA (€)"
                  inputMode="decimal"
                />
                <input
                  className="input"
                  value={expNote}
                  onChange={(e) => setExpNote(e.target.value)}
                  placeholder="PËRSHKRIM (opsional)"
                />
                <button className="softBtn" onClick={doExpense}>SHTO SHPENZIM</button>
              </div>
            ) : null}
          </section>
        </>
      )}

      <style jsx>{`
        .wrap { padding: 18px 16px 40px; max-width: 760px; margin: 0 auto; }
        .topbar { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:16px; }
        .eyebrow { font-size: 11px; letter-spacing: 1px; font-weight: 900; opacity: .62; }
        .title { margin: 6px 0 0; font-size: 28px; font-weight: 1000; letter-spacing: .4px; }
        .sub { margin-top: 6px; font-size: 13px; opacity: .74; }
        .actions { display:flex; gap:8px; flex-wrap:wrap; }

        .heroCard {
          background: linear-gradient(180deg, #0f172a 0%, #111827 100%);
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 26px;
          padding: 22px 18px;
          box-shadow: 0 20px 50px rgba(0,0,0,.32);
          margin-bottom: 16px;
        }
        .heroLabel { font-size: 12px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,.68); }
        .heroAmount { font-size: 42px; line-height: 1; font-weight: 1000; margin-top: 12px; }
        .heroMeta { display:flex; gap:10px; flex-wrap:wrap; margin-top: 14px; color: rgba(255,255,255,.76); font-size: 12px; }
        .heroMeta span { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-radius: 999px; padding: 8px 10px; }
        .heroActions { margin-top: 18px; }

        .bankCard {
          background: rgba(255,255,255,.03);
          border: 1px solid rgba(255,255,255,.07);
          border-radius: 24px;
          padding: 16px;
          margin-bottom: 16px;
          backdrop-filter: blur(10px);
        }
        .centerCard { text-align:center; padding:24px; }
        .sectionTop { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom: 12px; }
        .sectionTitle { font-size: 15px; font-weight: 900; letter-spacing: .4px; }
        .sectionSub { font-size: 12px; opacity: .66; margin-top: 4px; }

        .heroBtn {
          width: 100%;
          min-height: 58px;
          border: none;
          border-radius: 18px;
          font-size: 15px;
          font-weight: 1000;
          letter-spacing: .3px;
          color: #08111d;
          background: linear-gradient(180deg, #86efac, #22c55e);
          box-shadow: 0 14px 30px rgba(34,197,94,.28);
        }
        .heroBtn:disabled { opacity: .45; box-shadow: none; }
        .softBtn, .ghostBtn {
          min-height: 46px;
          padding: 12px 14px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,.10);
          background: rgba(255,255,255,.05);
          color: inherit;
          font-weight: 900;
          font-size: 13px;
        }
        .ghostBtn { text-decoration: none; display:flex; align-items:center; justify-content:center; }
        .input {
          width: 100%;
          min-height: 48px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,.10);
          background: rgba(255,255,255,.04);
          color: inherit;
          padding: 12px 14px;
          outline: none;
        }
        .transferGrid, .expenseBox { display:grid; gap:10px; }
        .txList { display:grid; gap:10px; }
        .txRow {
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          padding: 14px 12px;
          border-radius: 18px;
          background: rgba(255,255,255,.035);
          border: 1px solid rgba(255,255,255,.06);
        }
        .txMain { min-width: 0; }
        .txTitle { font-size: 14px; font-weight: 800; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .txMeta { display:flex; gap:8px; flex-wrap:wrap; margin-top: 4px; font-size: 11px; color: #94a3b8; }
        .txAmount { font-size: 16px; font-weight: 1000; color: #86efac; white-space: nowrap; }
        .emptyState { text-align:center; padding: 18px 12px; color: #94a3b8; background: rgba(255,255,255,.03); border-radius: 18px; }
        .muted { opacity: .74; margin-bottom: 14px; }

        @media (max-width: 640px) {
          .wrap { padding: 14px 12px 32px; }
          .topbar { flex-direction: column; }
          .actions { width: 100%; }
          .actions > :global(a), .actions > button { flex: 1; }
          .title { font-size: 24px; }
          .heroAmount { font-size: 36px; }
          .txRow { align-items:flex-start; }
          .txAmount { font-size: 15px; }
        }
      `}</style>
    </div>
  );
}
